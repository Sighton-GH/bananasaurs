import {
  DiscordApiError,
  ReminderDeliveryError,
  type DiscordPort,
  type OutgoingMessage,
  type Reminder,
  type ReminderDelivery,
  type ReminderStore,
} from '@bananasaurs/core';
import { assistantRepo, type GuildScope } from '@bananasaurs/storage';
import { neutraliseMassMentions } from './reminder-summary.js';

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
  reschedule: (id, nextDueAt) => {
    assistantRepo.rescheduleReminder(scope, id, nextDueAt);
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
 */
export const renderReminder = (
  reminder: Reminder,
): { content: string; allowedMentions: NonNullable<OutgoingMessage['allowedMentions']> } => {
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
 * Sends one reminder to its destination channel.
 *
 * Pings are allowed now, but only the stored, permission-checked targets
 * (ADR 0086 decision 6): `renderReminder` puts exactly the stored ids in
 * `allowedMentions`, so text typed into the reminder can never ping. The
 * text is capped at creation (1,500 characters) and the render is capped
 * at Discord's 2,000 regardless.
 */
export const createReminderDelivery = (
  guildId: string,
  discord: DiscordPort,
): ReminderDelivery => ({
  async send(reminder) {
    try {
      const rendered = renderReminder(reminder);
      await discord.sendMessage(guildId, reminder.destinationId, {
        content: rendered.content,
        allowedMentions: rendered.allowedMentions,
      });
    } catch (error) {
      throw classifyReminderSendError(error);
    }
  },
});
