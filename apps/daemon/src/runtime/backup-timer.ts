import type Database from 'better-sqlite3';
import {
  listBackups,
  performBackup,
  pruneBackups,
  type BackupResult,
  type PrunedBackup,
} from '@bananasaurs/storage';
import { safeLogFields, type Config, type Logger } from '@bananasaurs/core';

/**
 * The instance-level backup timer (ADR 0034).
 *
 * A sibling of the job-poll timer in `daemon.ts`, not nested inside it: a
 * backup is a property of the one database file the whole process shares, not
 * of any guild, so this owns no `GuildScope` and runs exactly once regardless
 * of how many guilds are allowlisted.
 */

export interface BackupOutcome {
  readonly ok: true;
  readonly backup: BackupResult;
  readonly pruned: readonly PrunedBackup[];
}

export interface BackupFailure {
  readonly ok: false;
  readonly error: string;
}

export type BackupRunResult = BackupOutcome | BackupFailure;

export interface BackupTimer {
  /** Runs one backup-and-prune cycle immediately, on this call site's thread. */
  runOnce(): BackupRunResult;
  /** Backs up now unless the newest backup is younger than the interval, then schedules the recurring interval. */
  start(): void;
  stop(): void;
}

export interface BackupTimerDeps {
  readonly raw: Database.Database;
  readonly config: Config;
  readonly logger: Logger;
  /** Injectable for tests; defaults to the real clock. */
  readonly now?: () => number;
}

export function createBackupTimer(deps: BackupTimerDeps): BackupTimer {
  let timer: NodeJS.Timeout | undefined;
  let firstRun: NodeJS.Timeout | undefined;
  const now = deps.now ?? Date.now;

  const runOnce = (): BackupRunResult => {
    try {
      const backup = performBackup(deps.raw, { destDir: deps.config.BANANASAURS_BACKUP_DIR });
      const pruned = pruneBackups({
        destDir: deps.config.BANANASAURS_BACKUP_DIR,
        retain: deps.config.BANANASAURS_BACKUP_RETAIN,
      });
      deps.logger.info(
        safeLogFields({
          component: 'backup',
          fileName: backup.fileName,
          sizeBytes: backup.sizeBytes,
          prunedCount: pruned.length,
        }),
        'backup complete',
      );
      return { ok: true, backup, pruned };
    } catch (err) {
      // Logged, not fatal (ADR 0034, matching ADR 0032's registration
      // failure): a bot that stops moderating because a backup write failed
      // once is worse than a missed backup. `doctor`'s backup-health section
      // is what surfaces repeated silent failure.
      deps.logger.error(safeLogFields({ component: 'backup', err }), 'backup failed');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  return {
    runOnce,
    start() {
      // Back up immediately unless the newest existing backup is younger than
      // one interval — at the daily default, waiting would leave a fresh
      // install with no backup at all for up to twenty-four hours, but a
      // restart inside the interval must not take another backup either.
      const intervalMs = deps.config.BANANASAURS_BACKUP_INTERVAL_MIN * 60_000;
      const scheduleRecurring = () => {
        timer = setInterval(runOnce, intervalMs);
        // Same reasoning as the job-poll timer: a pending backup tick must not
        // be what keeps the process alive after the gateway connection dies.
        timer.unref();
      };
      // listBackups reads the directory synchronously and throws when the
      // configured path is a regular file (ENOTDIR), is unreadable (EACCES)
      // or a file vanishes mid-listing. That fault must stay a logged backup
      // failure like runOnce's — never a throw out of start(), which would
      // take daemon.start() and the whole process down into a systemd
      // restart loop — so only the lookup is guarded, and on error we take
      // the "no recent backup" path below.
      let newest: ReturnType<typeof listBackups>[number] | undefined;
      try {
        newest = listBackups(deps.config.BANANASAURS_BACKUP_DIR).at(-1);
      } catch (err) {
        deps.logger.warn(
          safeLogFields({ component: 'backup', err }),
          'backup: could not list existing backups; backing up now',
        );
        runOnce();
        scheduleRecurring();
        return;
      }
      const ageMs = newest === undefined ? Infinity : now() - newest.createdAt.getTime();
      if (newest === undefined || ageMs >= intervalMs) {
        runOnce();
        scheduleRecurring();
      } else {
        // A restart inside the interval must not take another backup: retention is
        // by count, so restart backups would push out the daily history.
        const delayMs = Math.min(intervalMs, intervalMs - Math.max(0, ageMs));
        firstRun = setTimeout(() => {
          firstRun = undefined;
          runOnce();
          scheduleRecurring();
        }, delayMs);
        firstRun.unref();
        deps.logger.info(
          safeLogFields({ component: 'backup', fileName: newest.fileName }),
          'backup: newest is recent; next backup scheduled',
        );
      }
    },
    stop() {
      if (firstRun !== undefined) clearTimeout(firstRun);
      firstRun = undefined;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
