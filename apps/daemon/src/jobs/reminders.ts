import {
  deliverDueReminders,
  deliverRemindersPayload,
  JOB_KINDS,
  safeLogFields,
  type DeliverRemindersPayload,
  type JobHandler,
  type Logger,
  type ReminderDelivery,
  type ReminderStore,
} from '@bananasaurs/core';

/**
 * The due-reminder delivery pass, as a job handler (Release 3,
 * docs/RELEASE3_ASSISTANT_SCOPE.md: "deliver due reminders through a durable,
 * idempotent job").
 *
 * Thin wiring only — the pass itself lives in `core`'s `deliverDueReminders`
 * (`packages/core/src/assistant/reminders.ts`), including the permanent /
 * transient classification and the terminal retry window. This mirrors
 * `logMessageDeleteHandler` (`apps/daemon/src/jobs/logging.ts`): the
 * composition root is the only place allowed to know both the domain and the
 * database, so the store and delivery arrive already adapted
 * (`apps/daemon/src/assistant/reminder-delivery.ts`).
 *
 * Durability and idempotency come from the layers around this handler:
 *
 * - the timer enqueues at most one pending pass per guild (the
 *   `deliverRemindersDedupeKey` partial unique index collapses repeats);
 * - a crash mid-pass leaves the job `running` for `recoverStranded` to
 *   requeue at startup, and leaves its claimed reminders `delivering` for
 *   the next pass to re-claim past the stale threshold;
 * - a thrown store error fails the job into the worker's exponential retry,
 *   while per-reminder Discord failures are settled inside the pass and never
 *   throw.
 */
export const deliverRemindersHandler = (deps: {
  store: ReminderStore;
  delivery: ReminderDelivery;
  now: () => number;
  logger: Logger;
}): JobHandler<DeliverRemindersPayload> => ({
  kind: JOB_KINDS.deliverReminders,
  payload: deliverRemindersPayload,
  async run(payload) {
    const result = await deliverDueReminders(deps.store, deps.delivery, deps.now(), payload.limit);
    deps.logger.info(
      safeLogFields({
        component: 'jobs',
        jobKind: JOB_KINDS.deliverReminders,
        count: result.delivered + result.failed + result.retried,
      }),
      `reminders: delivered ${String(result.delivered)}, ` +
        `failed ${String(result.failed)}, retrying ${String(result.retried)}`,
    );
  },
});
