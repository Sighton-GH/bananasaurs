import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'node:path';
import fs from 'node:fs';
import { claimDatabaseLock, type DbLock } from './lock.js';
import { createScopeFactory, type ScopeFactory } from './scope.js';
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
  /**
   * The only source of guild scopes, and therefore the only route to guild
   * data. It carries the readonly flag so `write()` can refuse without every
   * caller having to remember to check.
   */
  scopes: ScopeFactory;
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
    scopes: createScopeFactory(db, { readonly: options.readonly === true }),
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
  // than decorative. Raw SQLite defaults this OFF per connection; better-sqlite3
  // already turns it on, so this line is belt-and-braces against that default
  // changing or a connection being opened by something else. Deleting it does
  // not currently change behaviour — see the guild-scope FK test, which asserts
  // the outcome rather than this pragma's value.
  raw.pragma('foreign_keys = ON');
}

/**
 * The one path every caller applies pending migrations through (ADR 0040
 * ledger R-5) — `scripts/migrate.mjs`, `test-support.ts`'s
 * `openMigratedTestDatabase`, and any test that needs a partially-migrated
 * database. Never call `drizzle-orm`'s own `migrate()` directly.
 *
 * *Why this exists*: SQLite's documented procedure for the "table rebuild"
 * dance drizzle-kit emits for a change it cannot do in place (a widened
 * CHECK, here `mod_rules_kind`) requires `PRAGMA foreign_keys=OFF` to be set
 * with no transaction open. `drizzle-orm`'s migrator wraps every pending
 * migration statement, across every `.sql` file being applied in one call,
 * in a single `BEGIN … COMMIT` — so a migration's own
 * `PRAGMA foreign_keys=OFF;` is a documented no-op, foreign key enforcement
 * stays on through the rebuild's `DROP TABLE`, and `ON DELETE CASCADE`
 * fires and silently deletes every row in a child table. Reproduced against
 * `mod_rules`' four children (`word_categories`, `word_terms`,
 * `word_allowlist`, `mod_rule_exemptions`) before this function existed —
 * see `docs/reports/release2-slices-1-6-ledger.md` R-5. Calling `migrate()` once per
 * migration file does not fix it either: drizzle opens a transaction per
 * call regardless.
 *
 * So instead: turn enforcement off on the *connection*, outside any
 * transaction, before calling drizzle's migrator at all, then turn it back
 * on afterwards. That reopens a real hazard — a migration could now insert a
 * referentially broken row and nothing would object — which is exactly what
 * the trailing `PRAGMA foreign_key_check` closes: it runs immediately after
 * migrating, still with the pragma off, and this function throws if it
 * finds anything. A migration that leaves a dangling reference fails the
 * run loudly instead of shipping a database nothing can query correctly.
 *
 * `foreign_keys` is restored to whatever it was before this call, not
 * unconditionally turned back on, so a caller that had deliberately left it
 * off is not surprised — and always in a `finally`, so a migration or the
 * consistency check throwing does not leave the connection with foreign
 * keys off for whatever runs next.
 */
export function runMigrations(
  raw: Database.Database,
  db: BetterSQLite3Database<typeof schema>,
  migrationsFolder: string,
): void {
  const wasOn = raw.pragma('foreign_keys', { simple: true }) === 1;
  raw.pragma('foreign_keys = OFF');
  try {
    migrate(db, { migrationsFolder });
    const violations = raw.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new Error(
        `migration left ${String(violations.length)} foreign key violation(s) behind: ` +
          `${JSON.stringify(violations)}`,
      );
    }
  } finally {
    raw.pragma(`foreign_keys = ${wasOn ? 'ON' : 'OFF'}`);
  }
}

/** In-memory database for tests. No lock, no file, same pragmas that apply. */
export function openTestDatabase(): {
  db: Db;
  raw: Database.Database;
  scopes: ScopeFactory;
  close(): void;
} {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  const db = drizzle(raw, { schema });
  return { db, raw, scopes: createScopeFactory(db, { readonly: false }), close: () => raw.close() };
}
