import type { Client } from 'discord.js';
import {
  DiscordApiError,
  parseGuildId,
  ReminderDeliveryError,
  safeLogFields,
  toOutgoingMessage,
  type AccessDecision,
  type DiscordPort,
  type Logger,
  type OutgoingMessage,
  type Reminder,
  type ReminderDelivery,
  type ReminderStore,
} from '@bananasaurs/core';
import { assistantRepo, type GuildScope } from '@bananasaurs/storage';
import { filterSendPings, resolveSendTarget } from '../mcp/targets.js';
import { channelAccessFor } from '../channels/access.js';
import { renderAssistantReminderCard } from './cards.js';
import { neutraliseMassMentions } from './reminder-summary.js';

/**
 * A reminder as the claim path hands it over: Task 1's `origin` rides along
 * on the row (`packages/storage`'s `StoredReminder`), while `core`'s pass
 * only knows the base shape — so the adapter reads it as an optional field.
 */
export type DeliverableReminder = Reminder & { readonly origin?: string };

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
 * Renders one `style='message'` reminder for its destination channel (ADR
 * 0145 "scheduled style"): the owner's own words as plain text with only
 * the ping line. The pings line lists exactly the stored,
 * permission-checked targets, in `@everyone`, `@here`, role, member order —
 * omitted when there are no pings. `allowedMentions` lists exactly those
 * stored ids, and the rendered text neutralises `@everyone`/`@here`, so
 * text typed into the reminder can never ping.
 *
 * `origin='mcp'` rows never carry `@everyone`/`@here` (Task 1's insert
 * guard); the render path asserts it too, so a row that somehow carries
 * them is refused here rather than posted.
 */
const renderMessageReminder = (
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
  // `@everyone`/`@here` (any case) in the member-written text.
  const safeText = neutraliseMassMentions(reminder.text);
  const fixed = pingsLine === '' ? 0 : pingsLine.length + 1;
  const body = safeText.slice(0, Math.max(0, 2_000 - fixed));
  return {
    content: pingsLine === '' ? body : `${pingsLine}\n${body}`,
    allowedMentions: reminderAllowedMentions(reminder),
  };
};

const reminderAllowedMentions = (
  reminder: DeliverableReminder,
): NonNullable<OutgoingMessage['allowedMentions']> => ({
  parse: reminder.mentions.everyone || reminder.mentions.here ? ['everyone'] : [],
  ...(reminder.mentions.roleIds.length > 0 ? { roles: [...reminder.mentions.roleIds] } : {}),
  ...(reminder.mentions.userIds.length > 0 ? { users: [...reminder.mentions.userIds] } : {}),
});

/**
 * The production Write gate for assistant reminders (composed in
 * `runtime/guild.ts`): the `canWrite` closure the delivery calls. A guild
 * not yet cached or available is transient, never a denial (N1) — the throw
 * keeps its `permanent = false` flag so the pass's retry/backoff covers it.
 */
export const assistantWriteGateFor =
  (client: Client, scope: GuildScope): ((channelId: string) => Promise<AccessDecision>) =>
  async (channelId) => {
    if (client.guilds.cache.get(scope.guildId)?.available !== true)
      throw new ReminderDeliveryError('guild not ready', false);
    return channelAccessFor(client, scope).check('write', channelId);
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
  canWriteOrMcp?: ((channelId: string) => Promise<boolean | AccessDecision>) | McpDeliveryRecheck,
  mcpOverride?: McpDeliveryRecheck,
): ReminderDelivery => ({
  async send(reminder) {
    // Either caller shape: the branch's `canWrite` function, main's
    // `McpDeliveryRecheck` object, or both (the daemon's composition root
    // passes both). A third-argument object is the recheck; a function is
    // the Write gate. The gate may answer the full access decision so the
    // denial line below can name the reason; a bare boolean denies as
    // `write-denied`.
    const canWrite = typeof canWriteOrMcp === 'function' ? canWriteOrMcp : undefined;
    const mcp = mcpOverride ?? (typeof canWriteOrMcp === 'object' ? canWriteOrMcp : undefined);
    const row = reminder as DeliverableReminder;
    // Assistant rows go exactly through today's code: no live client, no
    // policy, no log lines. The branch is on `'assistant'`, not on "not
    // mcp": a row whose origin went missing on the way here (an adapter
    // that stopped passing it through) must never post unchecked.
    if (row.origin !== 'assistant' && row.origin !== 'mcp')
      throw new ReminderDeliveryError('reminder origin unknown', true, true);
    // N2: the general `canWrite` gate runs for assistant rows only. MCP rows
    // re-check Write in their own arm below, which settles terminally as
    // `write-denied` and ends the series (ADR 0119 §2) — running this gate
    // first moved the series to its next occurrence instead.
    if (row.origin === 'assistant' && canWrite !== undefined) {
      // Channel permissions: a reminder posts only where the bot holds the
      // write row. Checked outside the try so the refusal keeps its
      // `permanent` flag — inside it, `classifyReminderSendError` would
      // reclassify a bare `ReminderDeliveryError` as transient and schedule
      // pointless retries.
      // ADR 0126 M5: the denial logs one ids-only line per reminder carrying
      // guild, channel, purpose and reason, like the task-nudge pause line.
      const verdict = await canWrite(reminder.destinationId);
      const denied = typeof verdict === 'boolean' ? !verdict : !verdict.allowed;
      if (denied) {
        const reason =
          typeof verdict === 'boolean' || verdict.allowed ? 'write-denied' : verdict.reason;
        mcp?.logger.warn(
          safeLogFields({
            component: 'reminders',
            guildId: reminder.guildId,
            channelId: reminder.destinationId,
            purpose: 'write',
            reason,
          }),
          'assistant reminder write denied',
        );
        throw new ReminderDeliveryError(
          'Bananasaurs is not allowed to post in that channel.',
          true,
        );
      }
    }
    // The row's guild governs every check — never the closure guild, which
    // only equals it when the wiring is right. A row for another guild can
    // therefore never borrow this guild's scope.
    const rowGuildId = parseGuildId(row.guildId);
    if (row.origin === 'mcp') {
      if (mcp === undefined)
        throw new ReminderDeliveryError('mcp delivery requires live checks', true, true);
      // N1: a guild not yet cached or available is transient, never a
      // denial — the pass's retry/backoff covers it. Without this, a pass
      // draining before READY fails every due reminder permanently.
      if (mcp.client.guilds.cache.get(rowGuildId)?.available !== true)
        throw new ReminderDeliveryError('guild not ready', false);
      // ADR 0126 Task 15: a scheduled send posts only where the bot holds
      // Write at delivery, not just at scheduling — the same `ChannelAccess`
      // precedence the schedule-time target check uses. Denied settles the
      // row terminally (`write-denied` fails it and ends the series) with one
      // ids-only line carrying the purpose and the access reason.
      const write = await channelAccessFor(mcp.client, mcp.scope).check('write', row.destinationId);
      if (!write.allowed) {
        mcp.logger.warn(
          safeLogFields({
            component: 'reminders',
            guildId: row.guildId,
            channelId: row.destinationId,
            purpose: 'write',
            reason: write.reason,
          }),
          'mcp scheduled send write denied',
        );
        throw new ReminderDeliveryError('write-denied', true, true);
      }
    }
    if (row.origin === 'assistant') {
      try {
        if (row.style === 'message') {
          const rendered = renderMessageReminder(row);
          await discord.sendMessage(guildId, reminder.destinationId, {
            content: rendered.content,
            allowedMentions: rendered.allowedMentions,
          });
        } else {
          await discord.sendMessage(
            guildId,
            reminder.destinationId,
            toOutgoingMessage(renderAssistantReminderCard(row)),
          );
        }
      } catch (error) {
        throw classifyReminderSendError(error);
      }
      return;
    }
    // No AI anywhere below: two policy reads and one post, nothing else.
    if (mcp === undefined)
      throw new ReminderDeliveryError('mcp delivery requires live checks', true, true);
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
    // The stored explicit pings plus the mentions in the text as it stands
    // now, each best effort under the live policy and the caps (ADR 0128 §5).
    const filtered = await filterSendPings(mcp.client, mcp.scope, rowGuildId, {
      roles: row.mentions.roleIds,
      users: row.mentions.userIds,
      text: row.text,
    });
    for (const drop of filtered.notPinged) {
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
