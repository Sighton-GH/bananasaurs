import type { Client } from 'discord.js';
import {
  DiscordApiError,
  parseGuildId,
  ReminderDeliveryError,
  safeLogFields,
  type DiscordPort,
  type Logger,
  type OutgoingMessage,
  type Reminder,
  type ReminderDelivery,
  type ReminderStore,
} from '@bananasaurs/core';
import { assistantRepo, type GuildScope } from '@bananasaurs/storage';
import { filterPings, resolveSendTarget } from '../mcp/targets.js';
import { neutraliseMassMentions } from './reminder-summary.js';

/**
 * A reminder as the claim path hands it over: Task 1's `origin` rides along
 * on the row (`packages/storage`'s `StoredReminder`), while `core`'s pass
 * only knows the base shape — so the adapter reads it as an optional field.
 */
type DeliverableReminder = Reminder & { readonly origin?: string };

/**
 * The composition half of reminder delivery (Release 3,
 * docs/RELEASE3_ASSISTANT_SCOPE.md): the only place allowed to know both the
 * database and Discord (`docs/19` §1). `core`'s `deliverDueReminders` owns the
 * pass; this module adapts the guild's storage scope into its `ReminderStore`
 * and the guild's `DiscordPort` into its `ReminderDelivery`.
 */

/**
 * The guild's reminder table behind `core`'s store interface.
 *
 * Every repo function here is state-guarded (`packages/storage/src/repos/
 * assistant.ts`), so a transition raced by another pass throws instead of
 * silently double-completing.
 */
export const reminderStoreFor = (scope: GuildScope): ReminderStore => ({
  create: (reminder) => {
    assistantRepo.insertReminder(scope, reminder);
    return Promise.resolve();
  },
  cancel: (_guildId, id, _actorId) => Promise.resolve(assistantRepo.cancelReminder(scope, id)),
  claimDue: (now, limit, staleMs) =>
    Promise.resolve(assistantRepo.claimDueReminders(scope, now, limit, staleMs)),
  complete: (id) => {
    assistantRepo.completeReminder(scope, id);
    return Promise.resolve();
  },
  fail: (id, reason) => {
    assistantRepo.failReminder(scope, id, reason);
    return Promise.resolve();
  },
  retry: (id, reason, retryAt) => {
    assistantRepo.retryReminder(scope, id, reason, retryAt);
    return Promise.resolve();
  },
  reschedule: (id, nextDueAt, reason, options) => {
    assistantRepo.rescheduleReminder(scope, id, nextDueAt, reason, options);
    return Promise.resolve();
  },
});

/**
 * Classifies a Discord send failure for the pass.
 *
 * Permanent — trying again cannot change the answer:
 * - permission failures (`isPermissionDenied`: the bot lost access to the
 *   destination channel, or never had it — including a `destinationId` that
 *   names a user rather than a channel, which Discord reports as an unknown
 *   or inaccessible channel, since this port has no DM path);
 * - any other 4xx: Discord understood and refused the request itself.
 *
 * Transient — the next pass may succeed:
 * - a 429 (`isRateLimit`), a 5xx, or a transport failure with no status.
 */
export const classifyReminderSendError = (error: unknown): ReminderDeliveryError => {
  const message = error instanceof Error ? error.message : 'delivery failed';
  if (error instanceof DiscordApiError) {
    const permanent =
      error.isPermissionDenied || (error.status >= 400 && error.status < 500 && !error.isRateLimit);
    return new ReminderDeliveryError(message, permanent);
  }
  // Unclassified errors are transient by default: the terminal window in
  // `core` bounds how long anything can retry, so an unknown failure mode
  // cannot loop forever.
  return new ReminderDeliveryError(message, false);
};

/**
 * Renders one reminder for its destination channel.
 *
 * The pings line lists exactly the stored, permission-checked targets (ADR
 * 0086 decision 6): `@everyone`, `@here`, `<@&role>` per stored role and
 * `<@user>` per stored member, in that order — omitted when there are no
 * pings. `allowedMentions` lists exactly those stored ids, and the rendered
 * text and context neutralise `@everyone`/`@here`, so text typed into the
 * reminder can never ping. The "Set by" line names
 * the creator without pinging them — their id reaches `users` only when it
 * is already in `mentions.userIds`.
 *
 * `origin='mcp'` rows never carry `@everyone`/`@here` (Task 1's insert
 * guard); the render path asserts it too, so a row that somehow carries
 * them is refused here rather than posted.
 */
export const renderReminder = (
  reminder: DeliverableReminder,
): { content: string; allowedMentions: NonNullable<OutgoingMessage['allowedMentions']> } => {
  if (reminder.origin === 'mcp' && (reminder.mentions.everyone || reminder.mentions.here))
    throw new Error('mcp reminders cannot ping everyone or here');
  const pings: string[] = [];
  if (reminder.mentions.everyone) pings.push('@everyone');
  if (reminder.mentions.here) pings.push('@here');
  for (const roleId of reminder.mentions.roleIds) pings.push(`<@&${roleId}>`);
  for (const userId of reminder.mentions.userIds) pings.push(`<@${userId}>`);
  const pingsLine = pings.join(' ');
  // Only the code-built pings line may carry live ping tokens: neutralise
  // `@everyone`/`@here` (any case) in the member-written text and context,
  // and collapse the context to one subtext line so it cannot break out of
  // `-# `.
  const safeText = neutraliseMassMentions(reminder.text);
  const collapsedContext =
    reminder.context === undefined ? undefined : reminder.context.replace(/\s+/g, ' ').trim();
  const safeContext =
    collapsedContext === undefined || collapsedContext === ''
      ? undefined
      : neutraliseMassMentions(collapsedContext);
  const contextLine = safeContext === undefined ? undefined : `-# ${safeContext}`;
  const setByLine = `-# Set by <@${reminder.creatorId}>`;
  // Everything except the reminder text itself. The 2,000-character cap
  // truncates the text, never the pings.
  const fixedLength =
    (pingsLine === '' ? 0 : pingsLine.length + 1) +
    '⏰ '.length +
    1 +
    (contextLine === undefined ? 0 : contextLine.length + 1) +
    setByLine.length;
  const text = safeText.slice(0, Math.max(0, 2_000 - fixedLength));
  const lines = [
    ...(pingsLine === '' ? [] : [pingsLine]),
    `⏰ ${text}`,
    ...(contextLine === undefined ? [] : [contextLine]),
    setByLine,
  ];
  return {
    content: lines.join('\n'),
    allowedMentions: {
      parse: reminder.mentions.everyone || reminder.mentions.here ? ['everyone'] : [],
      ...(reminder.mentions.roleIds.length > 0 ? { roles: [...reminder.mentions.roleIds] } : {}),
      ...(reminder.mentions.userIds.length > 0 ? { users: [...reminder.mentions.userIds] } : {}),
    },
  };
};

/**
 * The live facts the `origin='mcp'` re-check needs: the discord.js client
 * for cache math and membership reads, this guild's storage scope for the
 * send-scope and role-policy rows, and the logger for the ids-only lines.
 * Threaded through from the composition root (`runtime/guild.ts`).
 */
export interface McpDeliveryRecheck {
  readonly client: Client;
  readonly scope: GuildScope;
  readonly logger: Logger;
}

/**
 * Sends one reminder to its destination channel.
 *
 * Pings are allowed now, but only the stored, permission-checked targets
 * (ADR 0086 decision 6): `renderReminder` puts exactly the stored ids in
 * `allowedMentions`, so text typed into the reminder can never ping. The
 * text is capped at creation (1,500 characters) and the render is capped
 * at Discord's 2,000 regardless.
 *
 * `origin='mcp'` rows additionally re-check the destination and the pings
 * live before sending (ADR 0119 §2); assistant rows never take that path.
 */
export const createReminderDelivery = (
  guildId: string,
  discord: DiscordPort,
  mcp?: McpDeliveryRecheck,
): ReminderDelivery => ({
  async send(reminder) {
    const row = reminder as DeliverableReminder;
    // Assistant rows go exactly through today's code: no live client, no
    // policy, no log lines. The branch is on `'assistant'`, not on "not
    // mcp": a row whose origin went missing on the way here (an adapter
    // that stopped passing it through) must never post unchecked.
    if (row.origin !== 'assistant' && row.origin !== 'mcp')
      throw new ReminderDeliveryError('reminder origin unknown', true, true);
    if (row.origin === 'assistant') {
      try {
        const rendered = renderReminder(row);
        await discord.sendMessage(guildId, reminder.destinationId, {
          content: rendered.content,
          allowedMentions: rendered.allowedMentions,
        });
      } catch (error) {
        throw classifyReminderSendError(error);
      }
      return;
    }
    // No AI anywhere below: two policy reads and one post, nothing else.
    if (mcp === undefined)
      throw new ReminderDeliveryError('mcp delivery requires live checks', true, true);
    // The row's guild governs every check — never the closure guild, which
    // only equals it when the wiring is right. A row for another guild can
    // therefore never borrow this guild's scope.
    const rowGuildId = parseGuildId(row.guildId);
    const target = await resolveSendTarget(
      mcp.client,
      mcp.scope,
      rowGuildId,
      row.destinationId,
      'post',
    );
    if (!target.ok) {
      mcp.logger.warn(
        safeLogFields({
          component: 'reminders',
          guildId: row.guildId,
          dedupeKey: row.dedupeKey,
          channelId: row.destinationId,
          reason: target.reason,
        }),
        'mcp reminder target out of scope',
      );
      // Terminal for the whole series (ADR 0119 §2): the scope row is gone,
      // so neither a retry nor the next occurrence can change the answer —
      // the pass fails the reminder with nothing posted.
      throw new ReminderDeliveryError('target-out-of-scope', true, true);
    }
    const filtered = await filterPings(mcp.client, mcp.scope, rowGuildId, {
      roles: row.mentions.roleIds,
      users: row.mentions.userIds,
    });
    for (const drop of filtered.dropped) {
      mcp.logger.info(
        safeLogFields({
          component: 'reminders',
          guildId: row.guildId,
          dedupeKey: row.dedupeKey,
          ...(drop.kind === 'role' ? { roleId: drop.id } : { userId: drop.id }),
          reason: drop.reason,
        }),
        'mcp reminder ping dropped',
      );
    }
    // A row that broke the no-`@everyone`/`@here` guard is poisoned for
    // good: fail it at once as permanent, rather than retrying it as a
    // transient fault until the terminal window closes.
    if (row.mentions.everyone || row.mentions.here)
      throw new ReminderDeliveryError('mcp reminders cannot ping everyone or here', true, true);
    try {
      // A scheduled send is the fixed text `send_message` would have posted:
      // verbatim (capped at 2,000 when scheduled, so never cut here), with
      // no reminder framing. As there, a mention typed into the text renders
      // but notifies only when its id survived the filter above.
      await discord.sendMessage(rowGuildId, row.destinationId, {
        content: row.text,
        allowedMentions: {
          parse: [],
          ...(filtered.roleIds.length > 0 ? { roles: [...filtered.roleIds] } : {}),
          ...(filtered.userIds.length > 0 ? { users: [...filtered.userIds] } : {}),
        },
      });
    } catch (error) {
      throw classifyReminderSendError(error);
    }
  },
});
