import fs from 'node:fs';
import path from 'node:path';

/**
 * Single-writer guard, part two of two.
 *
 * SQLite permits exactly one writer, and ADR 0013 keeps the operator CLI behind
 * the daemon's socket for that reason. Two guards enforce it:
 *
 *   1. The daemon binds its Unix socket before opening the database. A second
 *      daemon on the same socket path fails with EADDRINUSE.
 *   2. This lockfile, keyed to the *database path*. The socket guard alone is
 *      not enough: docs/15 gives dev and production different socket paths, so
 *      a dev instance misconfigured onto the production BANANASAURS_DB_PATH
 *      binds its own socket happily and opens the database as a second writer.
 *      drizzle-kit and a stray `sqlite3` shell have the same shape.
 *
 * Node has no flock — neither `fs.flock` nor `fs.flockSync` exists — so this
 * uses O_EXCL creation, which is atomic, plus a liveness probe on the recorded
 * pid to recover from a crash.
 */

export class DatabaseLockedError extends Error {
  constructor(
    readonly lockPath: string,
    readonly holder: LockInfo,
  ) {
    super(
      `database is already open by another Bananasaurs process (pid ${holder.pid}` +
        `${holder.socketPath ? `, socket ${holder.socketPath}` : ''}).\n` +
        `  Lock file: ${lockPath}\n` +
        `  Check: systemctl status bananasaurs`,
    );
    this.name = 'DatabaseLockedError';
  }
}

export interface LockInfo {
  pid: number;
  socketPath?: string | undefined;
  startedAt: string;
}

export interface DbLock {
  readonly path: string;
  release(): void;
}

interface ClaimOptions {
  socketPath?: string | undefined;
  /** Injectable for tests. Defaults to a real signal-0 probe. */
  isAlive?: (pid: number) => boolean;
  onStaleReclaim?: (reason: string, previous: LockInfo | undefined) => void;
}

/** signal 0 performs permission and existence checks without delivering a signal. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but belongs to another user. Treat it as
    // live: refusing to start is the safe direction when we cannot tell.
    return code === 'EPERM';
  }
}

function readLockInfo(lockPath: string): LockInfo | undefined {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as LockInfo).pid === 'number' &&
      Number.isInteger((parsed as LockInfo).pid) &&
      (parsed as LockInfo).pid > 0
    ) {
      return parsed as LockInfo;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function claimDatabaseLock(lockPath: string, options: ClaimOptions = {}): DbLock {
  const isAlive = options.isAlive ?? defaultIsAlive;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, 'wx'); // O_CREAT | O_EXCL — atomic
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      const previous = readLockInfo(lockPath);

      if (previous && isAlive(previous.pid)) {
        throw new DatabaseLockedError(lockPath, previous);
      }

      // Either the recorded process is gone, or the file is empty/malformed
      // because a crash landed between the atomic create and the write. That
      // window is microseconds, and the socket bind already guards against a
      // live second daemon, so reclaiming is the better failure mode: refusing
      // would leave the bot down until someone SSHes in to delete a file.
      options.onStaleReclaim?.(
        previous ? `holder pid ${previous.pid} is not running` : 'lock file is empty or malformed',
        previous,
      );
      fs.rmSync(lockPath, { force: true });
      continue;
    }

    const info: LockInfo = {
      pid: process.pid,
      socketPath: options.socketPath,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(fd, JSON.stringify(info));
    fs.closeSync(fd);

    let released = false;
    return {
      path: lockPath,
      release() {
        if (released) return; // idempotent: shutdown paths call it more than once
        released = true;
        const current = readLockInfo(lockPath);
        // Only remove our own lock. If a stale-reclaim race handed it to someone
        // else, deleting it would strand them.
        if (!current || current.pid === process.pid) {
          fs.rmSync(lockPath, { force: true });
        }
      },
    };
  }

  throw new Error(`could not claim ${lockPath} after reclaiming a stale lock`);
}
