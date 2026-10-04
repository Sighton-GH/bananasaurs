import { archiveExpiryDedupeKey, JOB_KINDS, safeLogFields, type Logger } from '@bananasaurs/core';
import { archiveRepo, type GuildScope, type jobRepo } from '@bananasaurs/storage';

/**
 * The daily archive-expiry timer (ADR 0046 PR-70, Slice M1 Task 5, Step 2).
 *
 * The job table has no scheduler, so this is the producer: at startup and
 * every hour it enqueues one `archive_expiry` job per guild for the
 * current UTC day. The dedupe key is the day, so a second `runOnce` on the
 * same day enqueues nothing — the `(guild_id, dedupe_key)` partial unique
 * index refuses it per guild while the job is still pending (ADR 0016),
 * and `oncePerBucket` (ADR 0127) keeps it refused after the job has
 * finished — and all but the first tick of a UTC day are no-ops.
 *
 * The tick is hourly rather than daily on purpose: a 24 h `setInterval`
 * re-arms from when it actually fired, so ticks drift later, and a tick that
 * drifts past 00:00 UTC would leave a UTC day with no run at all. The day
 * key plus `oncePerBucket` (ADR 0127) makes extra ticks harmless, so an
 * hourly tick can no longer skip a day — the first tick after midnight
 * enqueues the new day within the hour.
 *
 * Mirrors `backup-timer.ts` ONLY in its start/stop contract (run once at
 * start, then `setInterval(...).unref()`; `stop` clears). Its deps are its
 * own: guild scopes to enqueue under, not the raw database handle.
 */

export const DAILY_JOB_TICK_MS = 60 * 60 * 1000;

export interface ArchiveExpiryTimer {
  /** Enqueues one expiry job per guild for the current UTC day, now. */
  runOnce(): void;
  /** Runs once now, then schedules the recurring interval. */
  start(): void;
  stop(): void;
}

export interface ArchiveExpiryTimerDeps {
  readonly guilds: () => readonly { scope: GuildScope }[];
  readonly enqueue: (
    scope: GuildScope,
    input: jobRepo.EnqueueInput,
  ) => { readonly enqueued: boolean };
  /**
   * Instance-level OAuth housekeeping (`oauthRepo.purgeExpired`): expired
   * pending rows, expired codes and tokens 14 days past expiry (ADR 0127),
   * which otherwise accumulate forever at a rate an unauthenticated stranger sets. It rides
   * this timer because the timer already runs once at start and hourly with
   * an injected clock — but it is NOT per-guild, so it runs once per
   * `runOnce`, outside the guild loop. Optional so existing callers keep
   * their shape; `daemon.ts` wires the real purge. Hourly is fine: the purge
   * is a cheap indexed delete, and its log line fires only when something
   * was actually purged.
   */
  readonly purgeOAuth?: (now: number) => OAuthPurgeCounts;
  /**
   * Whether the guild has any enabled archive channel. A guild with none
   * gets no `archive_expiry` job — an empty guild's daily row would only
   * noise up `/status`'s "queued" count. Optional with a default that reads
   * `archiveRepo` through the entry's scope, so `daemon.ts` (which builds
   * the entries and is outside this slice's Files list) needs no change and
   * production still skips; tests inject a stub or seed the repo.
   */
  readonly hasArchiveChannels?: (scope: GuildScope) => boolean;
  readonly now: () => number;
  readonly logger: Logger;
}

/** What `purgeOAuth` deleted: expired pending rows, codes, tokens 14 days past expiry. */
export interface OAuthPurgeCounts {
  readonly pending: number;
  readonly codes: number;
  readonly tokens: number;
}

const utcDay = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

export function createArchiveExpiryTimer(deps: ArchiveExpiryTimerDeps): ArchiveExpiryTimer {
  let timer: NodeJS.Timeout | undefined;

  const runOnce = (): void => {
    const now = deps.now();
    const day = utcDay(now);
    const hasArchiveChannels =
      deps.hasArchiveChannels ?? ((scope) => archiveRepo.listChannels(scope).length > 0);
    let enqueued = 0;
    for (const { scope } of deps.guilds()) {
      if (!hasArchiveChannels(scope)) continue;
      if (
        deps.enqueue(scope, {
          kind: JOB_KINDS.archiveExpiry,
          payload: JSON.stringify({ day }),
          dedupeKey: archiveExpiryDedupeKey(day),
          oncePerBucket: true,
          now,
        }).enqueued
      ) {
        enqueued += 1;
      }
    }
    // Hourly ticks after the day's first are no-ops (`oncePerBucket`, ADR
    // 0127): stay quiet unless this tick actually enqueued something.
    if (enqueued > 0) {
      deps.logger.info(
        safeLogFields({ component: 'archive', jobKind: JOB_KINDS.archiveExpiry }),
        'archive: expiry enqueued for the day',
      );
    }
    // Instance-level, so once per run — not once per guild. The three counts
    // ride the message text; the fields stay inside the allowlist (`count`
    // carries the total) and no new key is invented. Hourly, so log only
    // when something was actually purged.
    if (deps.purgeOAuth !== undefined) {
      const purged = deps.purgeOAuth(now);
      const total = purged.pending + purged.codes + purged.tokens;
      if (total > 0) {
        deps.logger.info(
          safeLogFields({ component: 'oauth', count: total }),
          `oauth: purged ${String(purged.pending)} pending authorization(s), ` +
            `${String(purged.codes)} code(s) and ${String(purged.tokens)} token(s)`,
        );
      }
    }
  };

  return {
    runOnce,
    start() {
      // Run once immediately rather than waiting out the first interval — a
      // fresh install's first deleted message would otherwise wait up to an
      // hour for its first expiry pass. The recurring tick is hourly (not
      // daily): the day key plus `oncePerBucket` (ADR 0127) makes all but
      // the first tick of a UTC day a no-op, so a drifting tick can no
      // longer skip a day.
      runOnce();
      timer = setInterval(runOnce, DAILY_JOB_TICK_MS);
      // Same reasoning as the job-poll timer: a pending expiry tick must not
      // be what keeps the process alive after the gateway connection dies.
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
