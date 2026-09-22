import {
  DiscordApiError,
  ReminderDeliveryError,
  type DiscordPort,
  type Reminder,
  type ReminderDelivery,
  type ReminderStore,
} from '@bananasaurs/core';
import { assistantRepo, type GuildScope } from '@bananasaurs/storage';

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

const renderReminder = (reminder: Reminder): string => `Reminder: ${reminder.text}`.slice(0, 2_000);

/**
 * Sends one reminder to its destination channel.
 *
 * Mentions stay disabled exactly as on every other assistant output: the
 * reminder text is member-authored content, and a reminder that pings
 * `@everyone` because someone typed it into `/remind` would be an abuse
 * vector the bot built for them. The text is capped at creation (1,500
 * characters) and the render is capped at Discord's 2,000 regardless.
 */
export const createReminderDelivery = (
  guildId: string,
  discord: DiscordPort,
): ReminderDelivery => ({
  async send(reminder) {
    try {
      await discord.sendMessage(guildId, reminder.destinationId, {
        content: renderReminder(reminder),
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      throw classifyReminderSendError(error);
    }
  },
});
