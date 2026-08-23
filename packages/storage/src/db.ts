import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { claimDatabaseLock, type DbLock } from './lock.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenOptions {
  dbPath: string;
  /** Recorded in the lock file so a refusal can name the other instance. */
  socketPath?: string | undefined;
  /** BANANASAURS_READONLY=1. Enforced here so every write path inherits it. */
  readonly?: boolean;
  onStaleReclaim?: (reason: string) => void;
}

export interface OpenedDatabase {
  db: Db;
  raw: Database.Database;
  lock: DbLock;
  close(): void;
}

let openInThisProcess = false;

export function openDatabase(options: OpenOptions): OpenedDatabase {
  if (openInThisProcess) {
    throw new Error('a database is already open in this process; there is exactly one writer');
  }

  const dbPath = path.resolve(options.dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const lock = claimDatabaseLock(`${dbPath}.lock`, {
    socketPath: options.socketPath,
    onStaleReclaim: (reason) => options.onStaleReclaim?.(reason),
  });

  let raw: Database.Database;
  try {
    raw = new Database(dbPath);
    applyPragmas(raw);
  } catch (err) {
    lock.release();
    throw err;
  }

  openInThisProcess = true;
  const db = drizzle(raw, { schema });

  return {
    db,
    raw,
    lock,
    close() {
      openInThisProcess = false;
      try {
        // Fold the WAL back into the main file so a copy of the .db alone is
        // complete. Matters for the backup and restore drill in WP6.
        raw.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        raw.close();
        lock.release();
      }
    },
  };
}

export function applyPragmas(raw: Database.Database): void {
  // WAL lets readers proceed during a write, which is what keeps the job worker
  // from throwing SQLITE_BUSY at an interactive command (ADR 0008, REVIEW C12).
  raw.pragma('journal_mode = WAL');
  // Covers checkpoint contention, the only SQLITE_BUSY left once WAL is on.
  raw.pragma('busy_timeout = 5000');
  // NORMAL is the documented companion to WAL: a crash can lose the last commit
  // but cannot corrupt the file. FULL costs an fsync per transaction for a
  // durability guarantee a Discord bot does not need.
  raw.pragma('synchronous = NORMAL');
  // Composite foreign keys carry guild scope, so they are load-bearing rather
  // than decorative. SQLite defaults this OFF, per connection.
  raw.pragma('foreign_keys = ON');
}

/** In-memory database for tests. No lock, no file, same pragmas that apply. */
export function openTestDatabase(): { db: Db; raw: Database.Database; close(): void } {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  return { db: drizzle(raw, { schema }), raw, close: () => raw.close() };
}
