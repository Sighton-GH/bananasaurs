import { JOB_KINDS, resourceRefreshDedupeKey, safeLogFields, type Logger } from '@bananasaurs/core';
import { assistantRepo, type GuildScope, type jobRepo } from '@bananasaurs/storage';

/**
 * The hourly resource-cache refresh timer (ADR 0073).
 *
 * The job table has no scheduler, so this is the producer: at startup and
 * every hour it enqueues one `resource_refresh` job — with no `resourceId`,
 * meaning every resource in the guild — for each guild that actually has a
 * resource. The dedupe key is the current UTC hour bucket, so a tick that
 * lands while the previous hour's job is still `queued`/`running` enqueues
 * nothing — the `(guild_id, dedupe_key)` partial unique index refuses it
 * (ADR 0016) — which is also what makes starting the timer twice inside the
 * same hour a no-op rather than a doubled sweep.
 *
 * Mirrors `reminder-timer.ts`/`archive-expiry-timer.ts` in its start/stop
 * contract (run once at start, then `setInterval(...).unref()`; `stop`
 * clears) with its own deps: guild scopes to enqueue under, not the raw
 * database handle.
 */

export const RESOURCE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export interface ResourceRefreshTimer {
  /** Enqueues one refresh job per guild, now. */
  runOnce(): void;
  /** Runs once now, then schedules the recurring interval. */
  start(): void;
  stop(): void;
}

export interface ResourceRefreshTimerDeps {
  readonly guilds: () => readonly { scope: GuildScope }[];
  readonly enqueue: (scope: GuildScope, input: jobRepo.EnqueueInput) => unknown;
  /**
   * Cheap peek before enqueueing: without it every guild gets one empty
   * `resource_refresh` job an hour forever, which only noise up `/status`'s
   * queued count (the same reasoning `archive-expiry-timer.ts`'s
   * `hasArchiveChannels` documents). Optional, defaulting to the real
   * `assistantRepo.listResources(scope).length > 0` — production gets this
   * for free; tests can inject a stub.
   */
  readonly hasResources?: (scope: GuildScope) => boolean;
  readonly now: () => number;
  readonly logger: Logger;
}

const hourBucket = (nowMs: number): number => Math.floor(nowMs / RESOURCE_REFRESH_INTERVAL_MS);

export function createResourceRefreshTimer(deps: ResourceRefreshTimerDeps): ResourceRefreshTimer {
  let timer: NodeJS.Timeout | undefined;
  const hasResources =
    deps.hasResources ?? ((scope) => assistantRepo.listResources(scope).length > 0);

  const runOnce = (): void => {
    const now = deps.now();
    const bucket = hourBucket(now);
    let enqueued = 0;
    for (const { scope } of deps.guilds()) {
      if (!hasResources(scope)) continue;
      deps.enqueue(scope, {
        kind: JOB_KINDS.resourceRefresh,
        payload: JSON.stringify({ reason: 'hourly' }),
        dedupeKey: resourceRefreshDedupeKey({ reason: 'hourly', hourBucket: bucket }),
        now,
      });
      enqueued += 1;
    }
    if (enqueued > 0) {
      deps.logger.info(
        safeLogFields({ component: 'jobs', jobKind: JOB_KINDS.resourceRefresh }),
        'resource cache: hourly refresh enqueued',
      );
    }
  };

  return {
    runOnce,
    start() {
      // Run once immediately rather than waiting out the first hour — a
      // fresh install's resources should be fetched into the cache right
      // away, not up to an hour later.
      runOnce();
      timer = setInterval(runOnce, RESOURCE_REFRESH_INTERVAL_MS);
      // Same reasoning as the other timers: a pending refresh tick must not
      // be what keeps the process alive after the gateway connection dies.
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
