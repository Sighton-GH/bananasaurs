export type ReminderStatus = 'scheduled' | 'delivering' | 'delivered' | 'cancelled' | 'failed';
export interface Reminder {
  readonly id: string;
  readonly guildId: string;
  readonly creatorId: string;
  readonly destinationId: string;
  readonly text: string;
  readonly dueAt: number;
  readonly createdAt: number;
  readonly status: ReminderStatus;
  readonly dedupeKey: string;
}
export interface ReminderStore {
  create(reminder: Reminder): Promise<void>;
  cancel(guildId: string, id: string, actorId: string): Promise<boolean>;
  /**
   * Atomically claims up to `limit` due reminders, moving them to
   * `delivering`. Also re-claims rows a previous pass left in `delivering`
   * at least `staleMs` ago — the restart path after a crash mid-pass, which
   * must never fire immediately, only past an explicit stale threshold.
   */
  claimDue(now: number, limit: number, staleMs: number): Promise<readonly Reminder[]>;
  complete(id: string): Promise<void>;
  fail(id: string, reason: string): Promise<void>;
  /**
   * Returns a claimed reminder to `scheduled` for a later pass, keeping the
   * last error visible and persisting the next attempt time in `dueAt`. The
   * transient counterpart of `fail`: a reminder that could not be sent right
   * now but might send on the next pass.
   */
  retry(id: string, reason: string, retryAt: number): Promise<void>;
}
export interface ReminderDelivery {
  send(reminder: Reminder): Promise<void>;
}

/**
 * A delivery failure that knows whether trying again can help.
 *
 * `permanent: true` covers failures a second attempt cannot change — the
 * destination channel is gone, the bot lost access, or Discord refused the
 * message itself. Anything else (a 429, a 5xx, a transport error, or an
 * error the delivery port did not classify) is treated as transient and
 * retried until the reminder passes the terminal window below.
 */
export class ReminderDeliveryError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'ReminderDeliveryError';
  }
}

/**
 * How long a reminder may fail transiently before it is marked `failed`,
 * measured from its original creation time.
 *
 * Measured from `createdAt` rather than `dueAt` because retry persists the
 * next attempt time in `dueAt` — the original due time is spent once the
 * first pass claims the row, while `createdAt` never moves. Unbounded retry
 * would keep a reminder that can never send circulating forever; six hours
 * covers a real Discord outage without making a poisoned reminder immortal.
 * There is no in-memory attempt counter: a restarted process must enforce
 * the same bound, and only the row survives a restart.
 */
export const REMINDER_DELIVERY_TERMINAL_WINDOW_MS = 6 * 60 * 60 * 1_000;

/** Delay before a transiently failed reminder is claimed again. */
export const REMINDER_RETRY_BACKOFF_MS = 60_000;

/**
 * How long a row may sit in `delivering` before another pass may re-claim
 * it. A pass delivering a full batch takes seconds; five minutes separates
 * "crashed mid-pass" from "still sending" with room to spare, and the claim
 * timestamp (persisted in `dueAt` at claim time) is what the comparison
 * reads.
 */
export const REMINDER_DELIVERY_STALE_MS = 5 * 60_000;

export const createReminder = async (
  input: Omit<Reminder, 'status' | 'dedupeKey'>,
  store: ReminderStore,
  now = Date.now(),
): Promise<Reminder> => {
  if (input.dueAt <= now) throw new Error('reminder time must be in the future');
  const text = input.text.trim();
  if (text.length === 0 || text.length > 1_500)
    throw new Error('reminder text must be 1 to 1500 characters');
  const reminder: Reminder = {
    ...input,
    text,
    status: 'scheduled',
    dedupeKey: `reminder:${input.guildId}:${input.id}`,
  };
  await store.create(reminder);
  return reminder;
};

export interface ReminderDeliveryResult {
  readonly delivered: number;
  readonly failed: number;
  readonly retried: number;
}

/**
 * One delivery pass.
 *
 * The store's `claimDue` owns the at-most-once-claim: it moves due rows from
 * `scheduled` to `delivering` atomically, so two passes cannot send the same
 * row, and it re-claims rows a crashed pass stranded past the stale
 * threshold. A crash between `send` and `complete` can therefore re-send one
 * reminder once — Discord has no send idempotency key, so at-least-once with
 * a narrow, time-bounded crash window is the honest guarantee.
 *
 * Per-reminder failures never throw out of the pass: one bad destination
 * must not hold back every other due reminder behind it. Permanent failures
 * go straight to `failed`; transient ones go back to `scheduled` with their
 * next attempt persisted, until the terminal window marks them `failed`.
 */
export const deliverDueReminders = async (
  store: ReminderStore,
  delivery: ReminderDelivery,
  now = Date.now(),
  limit = 25,
): Promise<ReminderDeliveryResult> => {
  let delivered = 0;
  let failed = 0;
  let retried = 0;
  for (const reminder of await store.claimDue(now, limit, REMINDER_DELIVERY_STALE_MS)) {
    try {
      await delivery.send(reminder);
      await store.complete(reminder.id);
      delivered += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'delivery failed';
      const permanent = error instanceof ReminderDeliveryError ? error.permanent : false;
      if (permanent || now - reminder.createdAt > REMINDER_DELIVERY_TERMINAL_WINDOW_MS) {
        await store.fail(reminder.id, reason);
        failed += 1;
      } else {
        await store.retry(reminder.id, reason, now + REMINDER_RETRY_BACKOFF_MS);
        retried += 1;
      }
    }
  }
  return { delivered, failed, retried };
};
