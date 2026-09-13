import { archiveExpiryDedupeKey, JOB_KINDS, safeLogFields, type Logger } from '@bananasaurs/core';
import { archiveRepo, type GuildScope, type jobRepo } from '@bananasaurs/storage';

/**
 * The daily archive-expiry timer (ADR 0046 PR-70, Slice M1 Task 5, Step 2).
 *
 * The job table has no scheduler, so this is the producer: at startup and
 * every 24 hours it enqueues one `archive_expiry` job per guild for the
 * current UTC day. The dedupe key is the day, so a second `runOnce` on the
 * same day enqueues nothing — the `(guild_id, dedupe_key)` partial unique
 * index refuses it per guild (ADR 0016).
 *
 * Mirrors `backup-timer.ts` ONLY in its start/stop contract (run once at
 * start, then `setInterval(...).unref()`; `stop` clears). Its deps are its
 * own: guild scopes to enqueue under, not the raw database handle.
 */

export const ARCHIVE_EXPIRY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ArchiveExpiryTimer {
  /** Enqueues one expiry job per guild for the current UTC day, now. */
  runOnce(): void;
  /** Runs once now, then schedules the recurring interval. */
  start(): void;
  stop(): void;
}

export interface ArchiveExpiryTimerDeps {
  readonly guilds: () => readonly { scope: GuildScope }[];
  readonly enqueue: (scope: GuildScope, input: jobRepo.EnqueueInput) => unknown;
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

const utcDay = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

export function createArchiveExpiryTimer(deps: ArchiveExpiryTimerDeps): ArchiveExpiryTimer {
  let timer: NodeJS.Timeout | undefined;

  const runOnce = (): void => {
    const now = deps.now();
    const day = utcDay(now);
    const hasArchiveChannels =
      deps.hasArchiveChannels ?? ((scope) => archiveRepo.listChannels(scope).length > 0);
    for (const { scope } of deps.guilds()) {
      if (!hasArchiveChannels(scope)) continue;
      deps.enqueue(scope, {
        kind: JOB_KINDS.archiveExpiry,
        payload: JSON.stringify({ day }),
        dedupeKey: archiveExpiryDedupeKey(day),
        now,
      });
    }
    deps.logger.info(
      safeLogFields({ component: 'archive', jobKind: JOB_KINDS.archiveExpiry }),
      'archive: expiry enqueued for the day',
    );
  };

  return {
    runOnce,
    start() {
      // Run once immediately rather than waiting out the first interval — a
      // fresh install's first deleted message would otherwise wait up to a
      // full day for its first expiry pass.
      runOnce();
      timer = setInterval(runOnce, ARCHIVE_EXPIRY_INTERVAL_MS);
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
