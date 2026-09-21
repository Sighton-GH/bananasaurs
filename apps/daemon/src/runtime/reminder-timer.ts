import {
  deliverRemindersDedupeKey,
  JOB_KINDS,
  safeLogFields,
  type Logger,
} from '@bananasaurs/core';
import type { GuildScope, jobRepo } from '@bananasaurs/storage';

/**
 * The due-reminder delivery timer (Release 3, docs/RELEASE3_ASSISTANT_SCOPE.md).
 *
 * The job table has no scheduler, so this is the producer: at startup and
 * every `REMINDER_DELIVERY_INTERVAL_MS` it enqueues one `deliver_reminders`
 * job per guild. The dedupe key is constant per guild, so a pass still
 * pending when the next tick fires enqueues nothing — the
 * `(guild_id, dedupe_key)` partial unique index refuses it (ADR 0016) — and
 * reminders a pass returned to `scheduled` for retry are picked up by the
 * first tick at or past their persisted retry time.
 *
 * Mirrors `archive-expiry-timer.ts`'s start/stop contract (run once at start,
 * then `setInterval(...).unref()`; `stop` clears) with its own deps: guild
 * scopes to enqueue under, not the raw database handle. The interval is
 * thirty seconds because reminders are user-visible to the minute and the
 * enqueue itself is one indexed insert; the actual claim/send work happens in
 * the job, not here.
 */

export const REMINDER_DELIVERY_INTERVAL_MS = 30_000;

export interface ReminderDeliveryTimer {
  /** Enqueues one delivery pass per guild, now. */
  runOnce(): void;
  /** Runs once now, then schedules the recurring interval. */
  start(): void;
  stop(): void;
}

export interface ReminderDeliveryTimerDeps {
  readonly guilds: () => readonly { scope: GuildScope }[];
  readonly enqueue: (scope: GuildScope, input: jobRepo.EnqueueInput) => unknown;
  /**
   * Cheap peek before enqueueing: without it the timer queues one empty job
   * per guild every thirty seconds around the clock (should-fix). A false
   * negative only delays a pass by one tick.
   */
  readonly hasDueWork: (scope: GuildScope) => boolean;
  readonly now: () => number;
  readonly logger: Logger;
}

export function createReminderDeliveryTimer(
  deps: ReminderDeliveryTimerDeps,
): ReminderDeliveryTimer {
  let timer: NodeJS.Timeout | undefined;

  const runOnce = (): void => {
    const now = deps.now();
    let enqueued = 0;
    for (const { scope } of deps.guilds()) {
      if (!deps.hasDueWork(scope)) continue;
      deps.enqueue(scope, {
        kind: JOB_KINDS.deliverReminders,
        payload: JSON.stringify({}),
        dedupeKey: deliverRemindersDedupeKey(),
        now,
      });
      enqueued += 1;
    }
    if (enqueued > 0) {
      deps.logger.info(
        safeLogFields({ component: 'jobs', jobKind: JOB_KINDS.deliverReminders }),
        'reminders: delivery pass enqueued',
      );
    }
  };

  return {
    runOnce,
    start() {
      // Run once immediately rather than waiting out the first interval — a
      // reminder that came due while the process was down should be claimed
      // on boot, not up to thirty seconds later. Between this and
      // `recoverStranded` requeueing a crashed pass, a restart loses no
      // reminder.
      runOnce();
      timer = setInterval(runOnce, REMINDER_DELIVERY_INTERVAL_MS);
      // Same reasoning as the job-poll timer: a pending reminder tick must
      // not be what keeps the process alive after the gateway connection
      // dies.
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
