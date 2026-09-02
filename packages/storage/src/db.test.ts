import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { applyPragmas, openDatabase, runMigrations } from './db.js';
import { DatabaseLockedError } from './lock.js';
import * as schema from './schema.js';
import { MIGRATIONS_FOLDER } from './test-support.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnn-db-'));
  dbPath = path.join(dir, 'test.db');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('applyPragmas', () => {
  it('puts the database in WAL', () => {
    const raw = new Database(dbPath);
    applyPragmas(raw);
    expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
    raw.close();
  });

  /**
   * This asserts the BEHAVIOUR, not the pragma value.
   *
   * The original test read `pragma('foreign_keys') === 1` and passed with the
   * pragma line deleted, because better-sqlite3 turns foreign keys on by
   * default (raw SQLite does not). It was asserting the library's default, so
   * it could never fail against a broken implementation.
   *
   * What actually matters is that a child row cannot reference a parent in
   * another guild, which is the invariant the whole Release 1 schema rests on.
   * That is worth guarding whatever the cause of a regression: our pragma, a
   * library upgrade changing its default, or a connection opened elsewhere.
   */
  it('rejects a foreign key that crosses guild scope', () => {
    const raw = new Database(dbPath);
    applyPragmas(raw);
    raw.exec(`
      CREATE TABLE parent (guild_id TEXT NOT NULL, item_id TEXT NOT NULL,
                           PRIMARY KEY (guild_id, item_id));
      CREATE TABLE child  (guild_id TEXT NOT NULL, item_id TEXT NOT NULL, note TEXT,
                           FOREIGN KEY (guild_id, item_id)
                             REFERENCES parent (guild_id, item_id));
    `);
    raw.prepare('INSERT INTO parent VALUES (?, ?)').run('111111111111111111', 'item-a');

    // Same guild, existing parent: allowed.
    expect(() =>
      raw.prepare('INSERT INTO child VALUES (?, ?, ?)').run('111111111111111111', 'item-a', 'ok'),
    ).not.toThrow();

    // Same item id, DIFFERENT guild. Without enforcement this silently succeeds
    // and one guild's row points at another guild's parent.
    expect(() =>
      raw.prepare('INSERT INTO child VALUES (?, ?, ?)').run('222222222222222222', 'item-a', 'leak'),
    ).toThrow(/FOREIGN KEY/i);

    raw.close();
  });

  it('sets a busy timeout so a checkpoint does not fail an interactive command', () => {
    const raw = new Database(dbPath);
    applyPragmas(raw);
    expect(raw.pragma('busy_timeout', { simple: true })).toBe(5000);
    raw.close();
  });

  it('sets synchronous to NORMAL, the documented companion to WAL', () => {
    const raw = new Database(dbPath);
    applyPragmas(raw);
    expect(raw.pragma('synchronous', { simple: true })).toBe(1); // 1 = NORMAL
    raw.close();
  });
});

describe('openDatabase', () => {
  it('opens, creates the lock, and closes cleanly', () => {
    const opened = openDatabase({ dbPath });
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(true);
    expect(opened.raw.pragma('journal_mode', { simple: true })).toBe('wal');
    opened.close();
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
  });

  it('refuses a second open in the same process', () => {
    const opened = openDatabase({ dbPath });
    try {
      expect(() => openDatabase({ dbPath })).toThrow(/already open in this process/);
    } finally {
      opened.close();
    }
  });

  it('refuses when another live process holds the database lock', () => {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(
      `${dbPath}.lock`,
      JSON.stringify({ pid: process.pid, socketPath: '/run/other.sock', startedAt: 'x' }),
    );
    expect(() => openDatabase({ dbPath })).toThrow(DatabaseLockedError);
    // and it names the other instance's socket so the operator knows which one
    try {
      openDatabase({ dbPath });
    } catch (err) {
      expect((err as Error).message).toContain('/run/other.sock');
    }
  });

  it('does not leave a lock behind when opening fails', () => {
    // A directory where the database file should be makes sqlite fail to open.
    fs.mkdirSync(dbPath, { recursive: true });
    expect(() => openDatabase({ dbPath })).toThrow();
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
  });

  it('checkpoints the WAL on close so the .db file alone is complete', () => {
    const opened = openDatabase({ dbPath });
    runMigrations(opened.raw, opened.db, './drizzle');
    opened.db
      .insert(schema.guilds)
      .values({
        guildId: '123456789012345678',
        name: 'test',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    opened.close();

    // Read the file with no -wal alongside it: the row must still be there.
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    const reopened = new Database(dbPath, { readonly: true });
    const rows = drizzle(reopened, { schema }).select().from(schema.guilds).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.guildId).toBe('123456789012345678');
    reopened.close();
  });
});

describe('schema constraints', () => {
  function migrated() {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });
    runMigrations(raw, db, './drizzle');
    return { db, raw };
  }

  it('rejects a guild_id that is not a snowflake', () => {
    const { db, raw } = migrated();
    const insert = (guildId: string) =>
      db.insert(schema.guilds).values({ guildId, name: 'n', createdAt: 1, updatedAt: 1 }).run();
    expect(() => insert('not-a-snowflake')).toThrow(/CHECK/i);
    expect(() => insert('12345')).toThrow(/CHECK/i);
    expect(() => insert('')).toThrow(/CHECK/i);
    expect(() => insert('123456789012345678')).not.toThrow();
    raw.close();
  });

  it('defaults dry_run to 1, so a newly seen guild performs no side effects', () => {
    const { db, raw } = migrated();
    db.insert(schema.guilds)
      .values({
        guildId: '123456789012345678',
        name: 'n',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const row = db.select().from(schema.guilds).get();
    expect(row?.dryRun).toBe(1);
    expect(row?.killswitch).toBe(0);
    expect(row?.breakerState).toBe('closed');
    raw.close();
  });

  it('rejects an invalid breaker state', () => {
    const { db, raw } = migrated();
    expect(() =>
      db
        .insert(schema.guilds)
        .values({
          guildId: '123456789012345678',
          name: 'n',
          breakerState: 'half-open',
          createdAt: 1,
          updatedAt: 1,
        })
        .run(),
    ).toThrow(/CHECK/i);
    raw.close();
  });

  it('rejects a non-positive rate cap, which would silently disable the limiter', () => {
    const { db, raw } = migrated();
    expect(() =>
      db
        .insert(schema.guilds)
        .values({
          guildId: '123456789012345678',
          name: 'n',
          roleRatePerMin: 0,
          createdAt: 1,
          updatedAt: 1,
        })
        .run(),
    ).toThrow(/CHECK/i);
    raw.close();
  });
});

/**
 * Migration 0012 (ADR 0041, Task 1) adds `automod_fixtures`, `mod_match_reviews`,
 * and two nullable columns on `mod_case_events`. Every statement in it is
 * additive (`CREATE TABLE` / `ALTER TABLE ... ADD COLUMN`), but the ledger's
 * R-5 finding (`docs/LEDGER_RELEASE2_SLICES_1_6.md`) is that "additive" is
 * exactly the property that must be demonstrated against real data, not
 * inferred from reading the SQL — a table-rebuild disguised as an ALTER would
 * still pass a typecheck and a schema-invariants read.
 *
 * Reuses the harness `schema-invariants.test.ts`'s
 * "mod_rules.config migration (0010/0011)" test established: migrate to the
 * last pre-Task-1 migration, seed a row with raw SQL the way a real upgrade
 * would find it, then apply the remaining shipped migration files through
 * `runMigrations` (never `migrate()` directly) and read the result back with
 * raw SQL, independent of the repo layer.
 */
describe('migration 0012 adds the fixture corpus without disturbing existing case events', () => {
  const GUILD_ID = '111111111111111111';
  const MEMBER_ID = '222222222222222222';

  /**
   * A migrations folder containing only the journal entries and `.sql` files
   * up to and including `tag`, so `migrate()` can run against a snapshot of
   * the schema older than what ships. `readMigrationFiles`
   * (`drizzle-orm/migrator.js`) needs only `meta/_journal.json` and the named
   * `.sql` files — not `meta/*_snapshot.json`, which is drizzle-kit's own
   * bookkeeping for the *next* `generate` and is never read by `migrate()`.
   */
  const migrationsFolderUpTo = (lastIdx: number): string => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { version: string; dialect: string; entries: { idx: number; tag: string }[] };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-corpus-migration-'));
    fs.mkdirSync(path.join(dir, 'meta'));
    const entries = journal.entries.filter((e) => e.idx <= lastIdx);
    fs.writeFileSync(
      path.join(dir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries }),
    );
    for (const entry of entries) {
      fs.copyFileSync(
        path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
        path.join(dir, `${entry.tag}.sql`),
      );
    }
    return dir;
  };

  it('keeps the seeded case event readable, with the new columns null, after the migration', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });

    // A database migrated to the *previous* state, seeded, then migrated the
    // rest of the way — the shape a real upgrade takes, and the only shape in
    // which a table rebuild's cascade (R-5) would be visible.
    runMigrations(raw, db, migrationsFolderUpTo(11));

    raw
      .prepare(`INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?, 'g', 0, 0)`)
      .run(GUILD_ID);
    raw
      .prepare(
        `INSERT INTO mod_cases (guild_id, case_id, member_id, opened_at)
         VALUES (?, 'c1', ?, 0)`,
      )
      .run(GUILD_ID, MEMBER_ID);
    raw
      .prepare(
        `INSERT INTO mod_case_events
           (guild_id, event_id, case_id, rule_id, member_id, at, matched_category, matched_snippet, action_taken)
         VALUES (?, 'e1', 'c1', 'rule-1', ?, 0, 'profanity', 'badword', 'would_delete')`,
      )
      .run(GUILD_ID, MEMBER_ID);

    // Applies every migration the real folder carries that is not yet
    // recorded as applied — 0012 — against the data just inserted. Goes
    // through `runMigrations`, not `migrate()` directly, exercising the same
    // foreign-key-off / foreign_key_check bracket a real upgrade uses.
    runMigrations(raw, db, MIGRATIONS_FOLDER);

    const events = raw.prepare('SELECT event_id, trace, fixture_id FROM mod_case_events').all() as {
      event_id: string;
      trace: string | null;
      fixture_id: string | null;
    }[];
    expect(events).toEqual([{ event_id: 'e1', trace: null, fixture_id: null }]);
    expect(raw.pragma('foreign_key_check')).toEqual([]);

    raw.close();
  });
});
