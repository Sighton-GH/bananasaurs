import {
  EVENT_DEDUPE_RETENTION_MS,
  JOB_KINDS,
  JOB_RETENTION_MS,
  pruneJobsDedupeKey,
  safeLogFields,
  sweepDedupeKey,
  type Logger,
} from '@bananasaurs/core';
import { type GuildScope, type jobRepo } from '@bananasaurs/storage';

/**
 * The daily housekeeping timer (ADR 0127).
 *
 * The job table has no scheduler, so this is the producer: at startup and
 * every 24 hours it enqueues one `prune_jobs` job and one
 * `sweep_event_dedupe` job per guild for the current UTC day. The dedupe keys
 * are the day, enqueued with `oncePerBucket`, so a second `runOnce` on the
 * same day — or a restart — enqueues nothing.
 *
 * Unlike the conversation-prune timer there is deliberately no peek: every
 * guild gets housekeeping whether or not it has archive channels, resources
 * or conversations, because finished jobs and event fingerprints accumulate
 * in every guild that ever ran anything.
 *
 * Mirrors `conversation-prune-timer.ts` in its start/stop contract (run once
 * at start, then `setInterval(...).unref()`; `stop` clears) and nothing else.
 */

export const HOUSEKEEPING_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface HousekeepingTimer {
  /** Enqueues the day's housekeeping jobs per guild, now. */
  runOnce(): void;
  /** Runs once now, then schedules the recurring interval. */
  start(): void;
  stop(): void;
}

export interface HousekeepingTimerDeps {
  readonly guilds: () => readonly { scope: GuildScope }[];
  readonly enqueue: (scope: GuildScope, input: jobRepo.EnqueueInput) => { readonly enqueued: boolean };
  readonly now: () => number;
  readonly logger: Logger;
}

const utcDay = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

export function createHousekeepingTimer(deps: HousekeepingTimerDeps): HousekeepingTimer {
  let timer: NodeJS.Timeout | undefined;

  const runOnce = (): void => {
    const now = deps.now();
    const day = utcDay(now);
    let enqueued = 0;
    for (const { scope } of deps.guilds()) {
      if (
        deps.enqueue(scope, {
          kind: JOB_KINDS.pruneJobs,
          payload: JSON.stringify({ olderThanMs: now - JOB_RETENTION_MS }),
          dedupeKey: pruneJobsDedupeKey(day),
          oncePerBucket: true,
          now,
        }).enqueued
      ) {
        enqueued += 1;
      }
      if (
        deps.enqueue(scope, {
          kind: JOB_KINDS.sweepEventDedupe,
          payload: JSON.stringify({ olderThanMs: now - EVENT_DEDUPE_RETENTION_MS }),
          dedupeKey: sweepDedupeKey(day),
          oncePerBucket: true,
          now,
        }).enqueued
      ) {
        enqueued += 1;
      }
    }
    if (enqueued > 0) {
      deps.logger.info(
        safeLogFields({ component: 'jobs', count: enqueued }),
        'housekeeping: enqueued for the day',
      );
    }
  };

  return {
    runOnce,
    start() {
      // Run once immediately rather than waiting out the first interval — a
      // fresh install's finished rows would otherwise wait up to a full day
      // for their first prune pass.
      runOnce();
      timer = setInterval(runOnce, HOUSEKEEPING_INTERVAL_MS);
      // Same reasoning as the job-poll timer: a pending housekeeping tick must
      // not be what keeps the process alive after the gateway connection dies.
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
