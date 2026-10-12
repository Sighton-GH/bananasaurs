import {
  assistantDailyDigestDedupeKey,
  JOB_KINDS,
  localDay,
  localHour,
  safeLogFields,
  type Logger,
} from '@bananasaurs/core';
import { conversationRepo, type GuildScope, type jobRepo } from '@bananasaurs/storage';

/**
 * The daily digest timer (ADR 0150 decision 1).
 *
 * The job table has no scheduler, so this is the producer: at startup and
 * every hour it enqueues one `assistant_daily_digest` job per guild that has
 * conversations, once the local hour (default 04:00 in
 * `BANANASAURS_TIME_ZONE`) is reached. The dedupe key is the local day, so a
 * second `runOnce` on the same day - or a restart - enqueues nothing: the
 * `(guild_id, dedupe_key)` partial unique index refuses it per guild while
 * the job is still pending (ADR 0016), and `oncePerBucket` (ADR 0127) keeps
 * it refused after the job has finished.
 *
 * The tick is hourly rather than daily on purpose: a 24 h `setInterval`
 * re-arms from when it actually fired, so ticks drift later, and a tick that
 * drifts past the local 04:00 would leave a day with no run at all. The day
 * key plus `oncePerBucket` makes extra ticks harmless.
 *
 * Mirrors `conversation-prune-timer.ts` in its start/stop contract (run once
 * at start, then `setInterval(...).unref()`; `stop` clears) and nothing else.
 */

export const DAILY_JOB_TICK_MS = 60 * 60 * 1000;

export interface DailyDigestTimer {
  /** Enqueues one digest job per guild for the current local day, now. */
  runOnce(): void;
  /** Runs once now, then schedules the recurring interval. */
  start(): void;
  stop(): void;
}

export interface DailyDigestTimerDeps {
  readonly guilds: () => readonly { scope: GuildScope }[];
  readonly enqueue: (
    scope: GuildScope,
    input: jobRepo.EnqueueInput,
  ) => { readonly enqueued: boolean };
  readonly hasConversations?: (scope: GuildScope) => boolean;
  readonly timeZone: () => string;
  readonly digestEnabled: () => boolean;
  readonly digestHour: () => number;
  readonly now: () => number;
  readonly logger: Logger;
}

export function createDailyDigestTimer(deps: DailyDigestTimerDeps): DailyDigestTimer {
  let timer: NodeJS.Timeout | undefined;
  const hasConversations =
    deps.hasConversations ?? ((scope) => conversationRepo.hasConversations(scope));

  const runOnce = (): void => {
    if (!deps.digestEnabled()) return;
    const now = deps.now();
    const tz = deps.timeZone();
    if (localHour(tz, now) < deps.digestHour()) return;
    const day = localDay(tz, now);
    let enqueued = 0;
    for (const { scope } of deps.guilds()) {
      if (!hasConversations(scope)) continue;
      if (
        deps.enqueue(scope, {
          kind: JOB_KINDS.assistantDailyDigest,
          payload: JSON.stringify({ day }),
          dedupeKey: assistantDailyDigestDedupeKey(day),
          oncePerBucket: true,
          now,
        }).enqueued
      ) {
        enqueued += 1;
      }
    }
    if (enqueued > 0) {
      deps.logger.info(
        safeLogFields({
          component: 'assistant-digest',
          jobKind: JOB_KINDS.assistantDailyDigest,
          day,
        }),
        'assistant-digest: enqueued for the local day',
      );
    }
  };

  return {
    runOnce,
    start() {
      runOnce();
      timer = setInterval(runOnce, DAILY_JOB_TICK_MS);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
