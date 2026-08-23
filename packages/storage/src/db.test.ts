import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { applyPragmas, openDatabase } from './db.js';
import { DatabaseLockedError } from './lock.js';
import * as schema from './schema.js';

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
    migrate(opened.db, { migrationsFolder: './drizzle' });
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
    migrate(db, { migrationsFolder: './drizzle' });
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
