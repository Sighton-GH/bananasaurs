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
 * R-5 finding (`docs/reports/release2-slices-1-6-ledger.md`) is that "additive" is
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
    // which a rebuild of `mod_case_events` could be caught losing its rows.
    //
    // Precise about what this does and does not prove. R-5's *cascade*
    // mechanism — a rebuild of table X silently emptying X's `ON DELETE
    // CASCADE` children — needs a populated child table, and
    // `mod_case_events` has none: `mod_match_reviews` is created by this very
    // migration, so nothing references `mod_case_events` before 0012 runs.
    // The Slice 1 fixture in `schema-invariants.test.ts` (`mod_rules` ->
    // `word_categories`/`word_terms`/`word_allowlist`/`mod_rule_exemptions`)
    // is the test that reproduces the cascade itself, and it stays the
    // authority on it.
    //
    // What this guards is the other half: that 0012 leaves the rows already
    // in `mod_case_events` intact and readable, with the two new columns
    // null. A drizzle-kit table rebuild that copied columns wrongly, or
    // dropped and recreated without copying, fails here.
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

    // Applies 0012 against the data just inserted. Goes through
    // `runMigrations`, not `migrate()` directly, exercising the same
    // foreign-key-off / foreign_key_check bracket a real upgrade uses.
    // Capped at 0012: 0101 (ADR 0121) later drops `fixture_id`.
    runMigrations(raw, db, migrationsFolderUpTo(12));

    const events = raw.prepare('SELECT event_id, trace, fixture_id FROM mod_case_events').all() as {
      event_id: string;
      trace: string | null;
      fixture_id: string | null;
    }[];
    expect(events).toEqual([{ event_id: 'e1', trace: null, fixture_id: null }]);
    // Deliberately no `foreign_key_check` assertion here: `runMigrations`
    // already runs that pragma and throws on a violation before returning
    // (`db.ts`), so an assertion at this point could never be the thing that
    // caught one. `schema-invariants.test.ts` tests that detection separately,
    // against a synthetic broken migration — which is the only way to make it
    // fail on purpose, and therefore the only way it is worth testing.

    raw.close();
  });
});

describe('migration 0024 adds thread and category scope without losing archive structure', () => {
  it('preserves old rows, the archive FK and all message indexes', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });
    const migrationsFolderUpTo = (lastIdx: number): string => {
      const journal = JSON.parse(
        fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
      ) as { version: string; dialect: string; entries: { idx: number; tag: string }[] };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-migration-'));
      fs.mkdirSync(path.join(dir, 'meta'));
      const entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
      fs.writeFileSync(
        path.join(dir, 'meta', '_journal.json'),
        JSON.stringify({ ...journal, entries }),
      );
      for (const entry of entries)
        fs.copyFileSync(
          path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
          path.join(dir, `${entry.tag}.sql`),
        );
      return dir;
    };
    runMigrations(raw, db, migrationsFolderUpTo(23));
    const guild = '111111111111111111';
    const channel = '222222222222222222';
    raw
      .prepare(`INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?, 'g', 0, 0)`)
      .run(guild);
    raw
      .prepare(`INSERT INTO archive_channels (guild_id, channel_id, enabled_at) VALUES (?, ?, 0)`)
      .run(guild, channel);
    raw
      .prepare(
        `INSERT INTO archive_messages (guild_id, message_id, channel_id, created_at) VALUES (?, '333333333333333333', ?, 0)`,
      )
      .run(guild, channel);
    runMigrations(raw, db, MIGRATIONS_FOLDER);
    expect(
      raw
        .prepare(
          `SELECT scope_kind, include_threads, threads_found, threads_done FROM archive_channels`,
        )
        .get(),
    ).toEqual({ scope_kind: 'channel', include_threads: 1, threads_found: null, threads_done: 0 });
    expect(raw.prepare(`SELECT thread_id FROM archive_messages`).get()).toEqual({
      thread_id: null,
    });
    const fks = raw.prepare(`PRAGMA foreign_key_list(archive_messages)`).all() as {
      table: string;
    }[];
    expect(fks.some((fk) => fk.table === 'archive_channels')).toBe(true);
    const indexes = raw.prepare(`PRAGMA index_list(archive_messages)`).all() as { name: string }[];
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'archive_messages_channel_created',
        'archive_messages_deleted',
        'archive_messages_thread_created',
      ]),
    );
    raw.close();
  });
});

describe('migration 0027 grants accounts.manage to existing owners (ADR 0056)', () => {
  it('owners with guild access gain the capability; non-owners do not; older grants are untouched', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });
    const migrationsFolderUpTo = (lastIdx: number): string => {
      const journal = JSON.parse(
        fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
      ) as { version: string; dialect: string; entries: { idx: number; tag: string }[] };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-manage-migration-'));
      fs.mkdirSync(path.join(dir, 'meta'));
      const entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
      fs.writeFileSync(
        path.join(dir, 'meta', '_journal.json'),
        JSON.stringify({ ...journal, entries }),
      );
      for (const entry of entries)
        fs.copyFileSync(
          path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
          path.join(dir, `${entry.tag}.sql`),
        );
      return dir;
    };
    // The shape a real upgrade takes: bootstrap issued every capability the
    // instance knew at the time, and `accounts.manage` was not one of them.
    runMigrations(raw, db, migrationsFolderUpTo(26));
    const guild = '111111111111111111';
    const owner = 'acct_owner';
    const member = 'acct_member';
    raw
      .prepare(`INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?, 'g', 0, 0)`)
      .run(guild);
    const insertAccount = raw.prepare(
      `INSERT INTO dashboard_accounts (account_id, username, password_hash, is_owner, created_at) VALUES (?, ?, 'h', ?, 0)`,
    );
    insertAccount.run(owner, 'owner', 1);
    insertAccount.run(member, 'member', 0);
    const insertAccess = raw.prepare(
      `INSERT INTO account_guild_access (guild_id, account_id) VALUES (?, ?)`,
    );
    insertAccess.run(guild, owner);
    insertAccess.run(guild, member);
    raw
      .prepare(
        `INSERT INTO account_capabilities (guild_id, account_id, capability, granted_at, granted_by) VALUES (?, ?, 'config.write', 0, 'bootstrap')`,
      )
      .run(guild, owner);

    runMigrations(raw, db, MIGRATIONS_FOLDER);

    const holders = raw
      .prepare(
        `SELECT account_id, granted_by FROM account_capabilities WHERE guild_id = ? AND capability = 'accounts.manage' ORDER BY account_id`,
      )
      .all(guild) as { account_id: string; granted_by: string }[];
    expect(holders).toEqual([{ account_id: owner, granted_by: 'migration-0027' }]);

    const configWrite = raw
      .prepare(
        `SELECT granted_by FROM account_capabilities WHERE guild_id = ? AND account_id = ? AND capability = 'config.write'`,
      )
      .get(guild, owner) as { granted_by: string };
    expect(configWrite.granted_by).toBe('bootstrap');
    raw.close();
  });
});

describe('migration 0035 adds the bot-tag flag and flags the one club assistant (ADR 0063)', () => {
  it('keeps every behaviour and flags only a guild with exactly one enabled bananasaurs behaviour', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });
    const migrationsFolderUpTo = (lastIdx: number): string => {
      const journal = JSON.parse(
        fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
      ) as { version: string; dialect: string; entries: { idx: number; tag: string }[] };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-tag-migration-'));
      fs.mkdirSync(path.join(dir, 'meta'));
      const entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
      fs.writeFileSync(
        path.join(dir, 'meta', '_journal.json'),
        JSON.stringify({ ...journal, entries }),
      );
      for (const entry of entries)
        fs.copyFileSync(
          path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
          path.join(dir, `${entry.tag}.sql`),
        );
      return dir;
    };
    runMigrations(raw, db, migrationsFolderUpTo(34));
    const one = '111111111111111111';
    const two = '222222222222222222';
    const insertGuild = raw.prepare(
      `INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?, 'g', 0, 0)`,
    );
    insertGuild.run(one);
    insertGuild.run(two);
    const insertBehaviour = raw.prepare(
      `INSERT INTO assistant_behaviours (guild_id, behaviour_id, surface, mention_role_id, name, system_prompt, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'prompt', ?, 0, 0)`,
    );
    insertBehaviour.run(one, 'club', 'bananasaurs', '333333333333333333', 'Club', 1);
    insertBehaviour.run(one, 'it', 'it-services', '444444444444444444', 'IT', 1);
    insertBehaviour.run(one, 'old-club', 'bananasaurs', '555555555555555555', 'Old club', 0);
    insertBehaviour.run(two, 'club-a', 'bananasaurs', '666666666666666666', 'Club A', 1);
    insertBehaviour.run(two, 'club-b', 'bananasaurs', '777777777777777777', 'Club B', 1);

    runMigrations(raw, db, MIGRATIONS_FOLDER);

    const rows = raw
      .prepare(
        `SELECT guild_id, behaviour_id, name, answers_bot_tag FROM assistant_behaviours ORDER BY guild_id, behaviour_id`,
      )
      .all();
    expect(rows).toEqual([
      { guild_id: one, behaviour_id: 'club', name: 'Club', answers_bot_tag: 1 },
      { guild_id: one, behaviour_id: 'it', name: 'IT', answers_bot_tag: 0 },
      { guild_id: one, behaviour_id: 'old-club', name: 'Old club', answers_bot_tag: 0 },
      { guild_id: two, behaviour_id: 'club-a', name: 'Club A', answers_bot_tag: 0 },
      { guild_id: two, behaviour_id: 'club-b', name: 'Club B', answers_bot_tag: 0 },
    ]);
    raw.close();
  });
});

describe('migration 0036 adds the fallback model, web search and assistant settings', () => {
  it('keeps the saved provider row, with search off and no fallback', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });
    const migrationsFolderUpTo = (lastIdx: number): string => {
      const journal = JSON.parse(
        fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
      ) as { version: string; dialect: string; entries: { idx: number; tag: string }[] };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-migration-'));
      fs.mkdirSync(path.join(dir, 'meta'));
      const entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
      fs.writeFileSync(
        path.join(dir, 'meta', '_journal.json'),
        JSON.stringify({ ...journal, entries }),
      );
      for (const entry of entries)
        fs.copyFileSync(
          path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
          path.join(dir, `${entry.tag}.sql`),
        );
      return dir;
    };
    runMigrations(raw, db, migrationsFolderUpTo(35));
    raw
      .prepare(
        `INSERT INTO assistant_provider_config (config_id, provider, model, api_key_enc, enabled, cost_class, updated_at)
         VALUES ('active', 'gemini', 'gemini-2.5-flash', 'sealed', 1, 'free', 7)`,
      )
      .run();

    runMigrations(raw, db, MIGRATIONS_FOLDER);

    expect(raw.prepare('SELECT * FROM assistant_provider_config').all()).toEqual([
      {
        config_id: 'active',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        api_key_enc: 'sealed',
        enabled: 1,
        cost_class: 'free',
        fallback_models_json: '[]',
        search_api_key_enc: null,
        search_enabled: 0,
        // ADR 0120 (migration 0090) adds this column after this test's own
        // migration; the row it seeded predates it, so it reads back the
        // rebuild default.
        search_source: 'brave',
        // ADR 0075 (migration 0038) adds this column after this test's own
        // migration; the row it seeded predates it, so it reads back null.
        github_token_enc: null,
        updated_at: 7,
      },
    ]);
    raw.close();
  });
});

describe('migration 0039 keeps one chain row per model when 0038 duplicated fallbacks', () => {
  it('migrates past the chain unique index with a fallback list that repeats the primary', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });
    const migrationsFolderUpTo = (lastIdx: number): string => {
      const journal = JSON.parse(
        fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
      ) as { version: string; dialect: string; entries: { idx: number; tag: string }[] };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-dedupe-migration-'));
      fs.mkdirSync(path.join(dir, 'meta'));
      const entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
      fs.writeFileSync(
        path.join(dir, 'meta', '_journal.json'),
        JSON.stringify({ ...journal, entries }),
      );
      for (const entry of entries)
        fs.copyFileSync(
          path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
          path.join(dir, `${entry.tag}.sql`),
        );
      return dir;
    };
    runMigrations(raw, db, migrationsFolderUpTo(36));
    // 0038 copies the primary plus every fallback with no dedupe: a
    // fallback list that repeats the primary (or itself) leaves duplicate
    // (provider, model) rows for 0039's chain copy to carry over. Seed
    // before 0038 runs, the way a real upgrade would find the row.
    raw
      .prepare(
        `INSERT INTO assistant_provider_config (config_id, provider, model, api_key_enc, enabled, cost_class, fallback_models_json, updated_at)
         VALUES ('active', 'gemini', 'gemini-2.5-flash', 'sealed', 1, 'free', '["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-pro"]', 7)`,
      )
      .run();

    runMigrations(raw, db, MIGRATIONS_FOLDER);

    expect(
      raw.prepare('SELECT key_id, model FROM assistant_model_chain ORDER BY position').all(),
    ).toEqual([
      { key_id: 'key_gemini', model: 'gemini-2.5-flash' },
      { key_id: 'key_gemini', model: 'gemini-2.5-pro' },
    ]);
    raw.close();
  });
});

/**
 * A migrations folder containing only the journal entries and `.sql` files up
 * to and including `tag`, so `migrate()` can run against a snapshot of the
 * schema older than what ships. Keyed by tag rather than idx so a test names
 * the migration it stops before. Shared by the 0091 and 0092 data tests.
 */
const migrationsFolderUpToTag = (tag: string): string => {
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { version: string; dialect: string; entries: { idx: number; tag: string }[] };
  const last = journal.entries.find((entry) => entry.tag === tag);
  expect(last, `journal has no entry tagged ${tag}`).toBeDefined();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-up-to-tag-'));
  fs.mkdirSync(path.join(dir, 'meta'));
  const entries = journal.entries.filter((entry) => entry.idx <= last!.idx);
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

describe('migration 0091 rebuild preserves archive rows, edits, attachments and FTS', () => {
  const GUILD_ID = '111111111111111111';
  const CHANNEL_ID = '222222222222222222';
  const MEMBER_ID = '333333333333333333';
  const MESSAGE_ONE = '444444444444444444';
  const MESSAGE_PURGED = '555555555555555555';
  const ATTACHMENT_ID = '666666666666666666';

  it('0091 rebuild preserves archive rows, edits, attachments and FTS', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });

    // A database migrated to the state just before 0091, seeded the way a
    // real upgrade would find it: two message rows (one live with searchable
    // content, one purged), an edit row and an attachment row on the first.
    runMigrations(raw, db, migrationsFolderUpToTag('0052_conversation_summary_search'));

    raw
      .prepare(`INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?, 'g', 0, 0)`)
      .run(GUILD_ID);
    raw
      .prepare(`INSERT INTO archive_channels (guild_id, channel_id, enabled_at) VALUES (?, ?, 0)`)
      .run(GUILD_ID, CHANNEL_ID);
    raw
      .prepare(
        `INSERT INTO archive_messages
           (guild_id, message_id, channel_id, thread_id, author_id, content,
            created_at, edited_at, deleted_at, retention_class, case_id, content_purged_at)
         VALUES (?, ?, ?, NULL, ?, 'quokka snack manifest for the picnic', 1000, NULL, NULL, 'default', NULL, NULL)`,
      )
      .run(GUILD_ID, MESSAGE_ONE, CHANNEL_ID, MEMBER_ID);
    raw
      .prepare(
        `INSERT INTO archive_messages
           (guild_id, message_id, channel_id, thread_id, author_id, content,
            created_at, edited_at, deleted_at, retention_class, case_id, content_purged_at)
         VALUES (?, ?, ?, NULL, ?, NULL, 2000, NULL, 2500, 'default', NULL, 4000)`,
      )
      .run(GUILD_ID, MESSAGE_PURGED, CHANNEL_ID, MEMBER_ID);
    raw
      .prepare(
        `INSERT INTO archive_message_edits (guild_id, message_id, edit_seq, content, edited_at)
         VALUES (?, ?, 1, 'quokka snack draft', 900)`,
      )
      .run(GUILD_ID, MESSAGE_ONE);
    raw
      .prepare(
        `INSERT INTO archive_attachments
           (guild_id, message_id, attachment_id, filename, content_type, size, sha256, bytes_path)
         VALUES (?, ?, ?, 'menu.png', 'image/png', 1234, NULL, NULL)`,
      )
      .run(GUILD_ID, MESSAGE_ONE, ATTACHMENT_ID);

    // Applies 0091 against the seeded rows, through `runMigrations` — the
    // exact call a real upgrade makes — never `migrate()` directly.
    runMigrations(raw, db, MIGRATIONS_FOLDER);

    // Both message rows survive with every original column value unchanged.
    expect(
      raw
        .prepare(
          `SELECT guild_id, message_id, channel_id, thread_id, author_id, content,
                  created_at, edited_at, deleted_at, retention_class, case_id, content_purged_at
           FROM archive_messages ORDER BY message_id`,
        )
        .all(),
    ).toEqual([
      {
        guild_id: GUILD_ID,
        message_id: MESSAGE_ONE,
        channel_id: CHANNEL_ID,
        thread_id: null,
        author_id: MEMBER_ID,
        content: 'quokka snack manifest for the picnic',
        created_at: 1000,
        edited_at: null,
        deleted_at: null,
        retention_class: 'default',
        case_id: null,
        content_purged_at: null,
      },
      {
        guild_id: GUILD_ID,
        message_id: MESSAGE_PURGED,
        channel_id: CHANNEL_ID,
        thread_id: null,
        author_id: MEMBER_ID,
        content: null,
        created_at: 2000,
        edited_at: null,
        deleted_at: 2500,
        retention_class: 'default',
        case_id: null,
        content_purged_at: 4000,
      },
    ]);
    // The two new columns land NULL on the carried rows.
    expect(
      raw
        .prepare(
          `SELECT message_id, reply_to_message_id, mentioned_role_ids
           FROM archive_messages ORDER BY message_id`,
        )
        .all(),
    ).toEqual([
      { message_id: MESSAGE_ONE, reply_to_message_id: null, mentioned_role_ids: null },
      { message_id: MESSAGE_PURGED, reply_to_message_id: null, mentioned_role_ids: null },
    ]);
    // The edit and attachment rows survive with the message they belong to.
    expect(
      raw
        .prepare(
          `SELECT guild_id, message_id, edit_seq, content, edited_at FROM archive_message_edits`,
        )
        .all(),
    ).toEqual([
      {
        guild_id: GUILD_ID,
        message_id: MESSAGE_ONE,
        edit_seq: 1,
        content: 'quokka snack draft',
        edited_at: 900,
      },
    ]);
    expect(
      raw
        .prepare(
          `SELECT guild_id, message_id, attachment_id, filename, content_type, size, sha256, bytes_path
           FROM archive_attachments`,
        )
        .all(),
    ).toEqual([
      {
        guild_id: GUILD_ID,
        message_id: MESSAGE_ONE,
        attachment_id: ATTACHMENT_ID,
        filename: 'menu.png',
        content_type: 'image/png',
        size: 1234,
        sha256: null,
        bytes_path: null,
      },
    ]);
    // The rebuild leaves no dangling reference behind.
    expect(raw.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    // The re-attached triggers plus the trailing rebuild keep the FTS index
    // tracking content: the distinctive word still finds the first message.
    expect(
      raw
        .prepare(
          `SELECT guild_id, channel_id, message_id FROM archive_messages_fts
           WHERE archive_messages_fts MATCH 'quokka'`,
        )
        .all(),
    ).toEqual([{ guild_id: GUILD_ID, channel_id: CHANNEL_ID, message_id: MESSAGE_ONE }]);

    raw.close();
  });
});

describe('migration 0092 copies mcp_sends into mcp_actions (ADR 0116 section 2)', () => {
  const GUILD_ID = '111111111111111111';
  const CHANNEL_SENT = '222222222222222222';
  const CHANNEL_DRY = '333333333333333333';
  const MESSAGE_ID = '444444444444444444';

  it('copies every mcp_sends row with the mapped values and leaves mcp_sends unchanged', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });

    // A database migrated to the state just before 0092, seeded the way a
    // real upgrade would find it: one accepted send with a message id and one
    // dry run without.
    runMigrations(raw, db, migrationsFolderUpToTag('0091_archive_reply_links'));

    raw
      .prepare(`INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?, 'g', 0, 0)`)
      .run(GUILD_ID);
    raw
      .prepare(
        `INSERT INTO mcp_sends
           (guild_id, idempotency_key, channel_id, content_hash, message_id, token_id, sent_at, outcome)
         VALUES (?, 'plain-key', ?, 'hash-plain', ?, 'tok_1', 1000, 'sent')`,
      )
      .run(GUILD_ID, CHANNEL_SENT, MESSAGE_ID);
    raw
      .prepare(
        `INSERT INTO mcp_sends
           (guild_id, idempotency_key, channel_id, content_hash, message_id, token_id, sent_at, outcome)
         VALUES (?, 'dry-key', ?, 'hash-dry', NULL, 'tok_2', 2000, 'dry_run')`,
      )
      .run(GUILD_ID, CHANNEL_DRY);

    // Applies 0092 against the seeded rows, through `runMigrations` — the
    // exact call a real upgrade makes — never `migrate()` directly.
    runMigrations(raw, db, MIGRATIONS_FOLDER);

    // Both rows are in mcp_actions with every mapped value.
    expect(
      raw
        .prepare(
          `SELECT guild_id, action_id, idempotency_key, kind, cap_group, args_hash, status,
                  token_id, target_channel_id, result_message_id, result_thread_id,
                  undo_json, undone_by_action_id, created_at, completed_at
           FROM mcp_actions ORDER BY idempotency_key`,
        )
        .all(),
    ).toEqual([
      {
        guild_id: GUILD_ID,
        action_id: 'legacy:dry-key',
        idempotency_key: 'dry-key',
        kind: 'message.send',
        cap_group: 'message',
        args_hash: 'hash-dry',
        status: 'dry_run',
        token_id: 'tok_2',
        target_channel_id: CHANNEL_DRY,
        result_message_id: null,
        result_thread_id: null,
        undo_json: null,
        undone_by_action_id: null,
        created_at: 2000,
        completed_at: 2000,
      },
      {
        guild_id: GUILD_ID,
        action_id: 'legacy:plain-key',
        idempotency_key: 'plain-key',
        kind: 'message.send',
        cap_group: 'message',
        args_hash: 'hash-plain',
        status: 'done',
        token_id: 'tok_1',
        target_channel_id: CHANNEL_SENT,
        result_message_id: MESSAGE_ID,
        result_thread_id: null,
        undo_json: null,
        undone_by_action_id: null,
        created_at: 1000,
        completed_at: 1000,
      },
    ]);
    // mcp_sends still has both rows unchanged: the copy reads, never moves.
    expect(
      raw
        .prepare(
          `SELECT guild_id, idempotency_key, channel_id, content_hash, message_id,
                  token_id, sent_at, outcome
           FROM mcp_sends ORDER BY idempotency_key`,
        )
        .all(),
    ).toEqual([
      {
        guild_id: GUILD_ID,
        idempotency_key: 'dry-key',
        channel_id: CHANNEL_DRY,
        content_hash: 'hash-dry',
        message_id: null,
        token_id: 'tok_2',
        sent_at: 2000,
        outcome: 'dry_run',
      },
      {
        guild_id: GUILD_ID,
        idempotency_key: 'plain-key',
        channel_id: CHANNEL_SENT,
        content_hash: 'hash-plain',
        message_id: MESSAGE_ID,
        token_id: 'tok_1',
        sent_at: 1000,
        outcome: 'sent',
      },
    ]);
    expect(raw.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);

    raw.close();
  });
});

describe('migration 0094 widens the effect_batches source CHECK to admit mcp', () => {
  const GUILD_ID = '111111111111111111';
  const ROLE_ID = '222222222222222222';
  const MEMBER_ID = '333333333333333333';

  it('carries every effect_batches and role_effects row across the rebuild, then admits mcp', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });

    // A database migrated to the state just before 0094, seeded the way a
    // real upgrade would find it: one batch row and the role effect that
    // belongs to it, through the managed_roles row the foreign key demands.
    runMigrations(raw, db, migrationsFolderUpToTag('0093_mcp_bulk_previews'));

    raw
      .prepare(`INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?, 'g', 0, 0)`)
      .run(GUILD_ID);
    raw
      .prepare(`INSERT INTO managed_roles (guild_id, role_id) VALUES (?, ?)`)
      .run(GUILD_ID, ROLE_ID);
    raw
      .prepare(
        `INSERT INTO effect_batches
           (guild_id, batch_id, source, actor_type, actor_id, started_at, finished_at, undone_at)
         VALUES (?, 'batch-1', 'dashboard', 'dashboard', 'acct_1', 1000, 2000, NULL)`,
      )
      .run(GUILD_ID);
    raw
      .prepare(
        `INSERT INTO role_effects
           (guild_id, effect_id, batch_id, dedupe_key, user_id, role_id, action,
            state, had_role_before, panel_id, attempted_at, completed_at, error_code)
         VALUES (?, 'effect-1', 'batch-1', 'dedupe-1', ?, ?, 'grant',
            'applied', 0, NULL, 1000, 2000, NULL)`,
      )
      .run(GUILD_ID, MEMBER_ID, ROLE_ID);

    // Applies 0094 against the seeded rows, through `runMigrations` — the
    // exact call a real upgrade makes — never `migrate()` directly.
    runMigrations(raw, db, MIGRATIONS_FOLDER);

    // The batch row survives with every original column value unchanged.
    expect(
      raw
        .prepare(
          `SELECT guild_id, batch_id, source, actor_type, actor_id,
                  started_at, finished_at, undone_at
           FROM effect_batches`,
        )
        .all(),
    ).toEqual([
      {
        guild_id: GUILD_ID,
        batch_id: 'batch-1',
        source: 'dashboard',
        actor_type: 'dashboard',
        actor_id: 'acct_1',
        started_at: 1000,
        finished_at: 2000,
        undone_at: null,
      },
    ]);
    // The role effect survives with the batch it belongs to.
    expect(
      raw
        .prepare(
          `SELECT guild_id, effect_id, batch_id, dedupe_key, user_id, role_id, action,
                  state, had_role_before, panel_id, attempted_at, completed_at, error_code
           FROM role_effects`,
        )
        .all(),
    ).toEqual([
      {
        guild_id: GUILD_ID,
        effect_id: 'effect-1',
        batch_id: 'batch-1',
        dedupe_key: 'dedupe-1',
        user_id: MEMBER_ID,
        role_id: ROLE_ID,
        action: 'grant',
        state: 'applied',
        had_role_before: 0,
        panel_id: null,
        attempted_at: 1000,
        completed_at: 2000,
        error_code: null,
      },
    ]);
    // The rebuild leaves no dangling reference behind.
    expect(raw.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);

    // And the widened CHECK admits the new source the MCP role tools open
    // their batches with.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO effect_batches
             (guild_id, batch_id, source, actor_type, actor_id, started_at)
           VALUES (?, 'batch-mcp', 'mcp', 'mcp_operator', 'tok_1', 3000)`,
        )
        .run(GUILD_ID),
    ).not.toThrow();
    expect(
      raw.prepare(`SELECT source FROM effect_batches WHERE batch_id = 'batch-mcp'`).get(),
    ).toEqual({ source: 'mcp' });

    raw.close();
  });
});

describe('migration 0095 adds the reminder origin column (ADR 0119)', () => {
  const GUILD_ID = '111111111111111111';
  const CREATOR_ID = '222222222222222222';
  const CHANNEL_ID = '333333333333333333';

  it('reads pre-0095 rows back as assistant with every other column intact', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });

    // A database migrated to the state just before 0095, seeded the way a
    // real upgrade would find it: one reminder row with every column set.
    runMigrations(raw, db, migrationsFolderUpToTag('0094_effect_batches_mcp_source'));

    raw
      .prepare(`INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?, 'g', 0, 0)`)
      .run(GUILD_ID);
    raw
      .prepare(
        `INSERT INTO assistant_reminders
           (guild_id, reminder_id, creator_id, destination_id, text, due_at,
            next_attempt_at, claimed_at, created_at, status, dedupe_key,
            failure_reason, mentions_json, recurrence_json, context,
            delivered_count, updated_at)
         VALUES (?, 'r1', ?, ?, 'quokka snack', 1000, 1500, NULL, 500,
            'scheduled', 'reminder:r1',
            NULL, '{"userIds":[],"roleIds":[],"everyone":false,"here":false}',
            NULL, 'why', 2, 700)`,
      )
      .run(GUILD_ID, CREATOR_ID, CHANNEL_ID);

    // Applies 0095 against the seeded row, through `runMigrations` — the
    // exact call a real upgrade makes — never `migrate()` directly.
    runMigrations(raw, db, MIGRATIONS_FOLDER);

    // The carried row reads back as assistant with every other column intact.
    expect(
      raw
        .prepare(
          `SELECT guild_id, reminder_id, creator_id, destination_id, text, due_at,
                  next_attempt_at, claimed_at, created_at, status, dedupe_key,
                  failure_reason, mentions_json, recurrence_json, context,
                  delivered_count, updated_at, origin
           FROM assistant_reminders`,
        )
        .all(),
    ).toEqual([
      {
        guild_id: GUILD_ID,
        reminder_id: 'r1',
        creator_id: CREATOR_ID,
        destination_id: CHANNEL_ID,
        text: 'quokka snack',
        due_at: 1000,
        next_attempt_at: 1500,
        claimed_at: null,
        created_at: 500,
        status: 'scheduled',
        dedupe_key: 'reminder:r1',
        failure_reason: null,
        mentions_json: '{"userIds":[],"roleIds":[],"everyone":false,"here":false}',
        recurrence_json: null,
        context: 'why',
        delivered_count: 2,
        updated_at: 700,
        origin: 'assistant',
      },
    ]);
    // The rebuild leaves no dangling reference behind.
    expect(raw.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);

    // The primary key, the guild foreign key, the dedupe unique key and
    // every CHECK survived the rebuild.
    const pk = raw.prepare(`PRAGMA table_info(assistant_reminders)`).all() as {
      pk: number;
      name: string;
    }[];
    expect(
      pk
        .filter((c) => c.pk > 0)
        .map((c) => c.name)
        .sort(),
    ).toEqual(['guild_id', 'reminder_id']);
    const fks = raw.prepare(`PRAGMA foreign_key_list(assistant_reminders)`).all() as {
      table: string;
    }[];
    expect(fks.some((fk) => fk.table === 'guilds')).toBe(true);
    const indexes = raw.prepare(`PRAGMA index_list(assistant_reminders)`).all() as {
      name: string;
      unique: number;
    }[];
    // The dedupe unique key and the due-date index survive under their names;
    // the refused duplicate insert below proves the unique one still enforces.
    expect(indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining(['assistant_reminders_dedupe', 'assistant_reminders_due']),
    );
    expect(indexes.find((i) => i.name === 'assistant_reminders_dedupe')?.unique).toBe(1);
    // A second row with the same dedupe key in the same guild is refused.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO assistant_reminders
             (guild_id, reminder_id, creator_id, destination_id, text, due_at,
              created_at, status, dedupe_key, delivered_count)
           VALUES (?, 'r2', ?, ?, 'other', 2000, 600, 'scheduled', 'reminder:r1', 0)`,
        )
        .run(GUILD_ID, CREATOR_ID, CHANNEL_ID),
    ).toThrow();
    // A reminder naming a guild that does not exist is refused.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO assistant_reminders
             (guild_id, reminder_id, creator_id, destination_id, text, due_at,
              created_at, status, dedupe_key, delivered_count)
           VALUES ('999999999999999999', 'r9', ?, ?, 'other', 2000, 600, 'scheduled', 'reminder:r9', 0)`,
        )
        .run(CREATOR_ID, CHANNEL_ID),
    ).toThrow(/FOREIGN KEY/i);
    // The widened table still refuses a bad status and a bad origin.
    for (const sql of [
      `INSERT INTO assistant_reminders
         (guild_id, reminder_id, creator_id, destination_id, text, due_at,
          created_at, status, dedupe_key, delivered_count)
       VALUES (?, 'bad-status', ?, ?, 'other', 2000, 600, 'snoozed', 'reminder:bad-status', 0)`,
      `INSERT INTO assistant_reminders
         (guild_id, reminder_id, creator_id, destination_id, text, due_at,
          created_at, status, dedupe_key, delivered_count, origin)
       VALUES (?, 'bad-origin', ?, ?, 'other', 2000, 600, 'scheduled', 'reminder:bad-origin', 0, 'sms')`,
    ])
      expect(() => raw.prepare(sql).run(GUILD_ID, CREATOR_ID, CHANNEL_ID)).toThrow(/CHECK/i);

    raw.close();
  });
});

describe('migration journal ordering (ADR 0115 section 3)', () => {
  interface JournalEntry {
    readonly idx: number;
    readonly when: number;
    readonly tag: string;
  }

  /**
   * The migrator applies a migration only when its journal `when` is later
   * than the newest migration already applied, so an entry whose `when` is
   * equal to or smaller than its predecessor's is silently skipped on a
   * database that has already run the earlier migration. Returns a
   * description of the first disorder, or undefined when strictly increasing.
   */
  const firstOutOfOrder = (entries: readonly JournalEntry[]): string | undefined => {
    for (let i = 1; i < entries.length; i += 1) {
      const prev = entries[i - 1]!;
      const curr = entries[i]!;
      if (curr.when <= prev.when) {
        return (
          `${curr.tag} (idx ${curr.idx}) has when ${curr.when}, not strictly greater than ` +
          `${prev.tag} (idx ${prev.idx}) with when ${prev.when}; ` +
          `the migrator would silently skip it.`
        );
      }
    }
    return undefined;
  };

  const readJournal = (): { entries: JournalEntry[] } =>
    JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
      entries: JournalEntry[];
    };

  it('journal when strictly increases', () => {
    const { entries } = readJournal();
    expect(entries.length).toBeGreaterThan(0);
    expect(firstOutOfOrder(entries)).toBeUndefined();
  });

  it('every journal tag has a matching .sql file', () => {
    const { entries } = readJournal();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(
        fs.existsSync(path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`)),
        `${entry.tag} has no matching .sql file`,
      ).toBe(true);
    }
  });

  it('the ordering checker fails on a crafted out-of-order journal', () => {
    expect(
      firstOutOfOrder([
        { idx: 0, when: 100, tag: '0000_first' },
        { idx: 1, when: 90, tag: '0001_second' },
      ]),
    ).toContain('0001_second');
    // Equal timestamps fail too: the migrator's gate is `created_at <`, so an
    // equal `when` is skipped just like a smaller one.
    expect(
      firstOutOfOrder([
        { idx: 0, when: 100, tag: '0000_first' },
        { idx: 1, when: 100, tag: '0001_second' },
      ]),
    ).toContain('0001_second');
  });
});

describe('migration 0101 removes the staged rollout without losing rules, word lists or flags (ADR 0121)', () => {
  const GUILD_ID = '111111111111111111';
  const MEMBER_ID = '222222222222222222';
  const ROLE_ID = '333333333333333333';

  /** The same journal-prefix folder the 0012 test above builds; see its comment. */
  const migrationsFolderUpTo = (lastIdx: number): string => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { version: string; dialect: string; entries: { idx: number; tag: string }[] };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automod-cleanup-migration-'));
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

  /** The journal idx of `0100_automod_state`, the switch column migration. */
  const AUTOMOD_STATE_IDX = (() => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    const entry = journal.entries.find((e) => e.tag === '0100_automod_state');
    if (entry === undefined) throw new Error('0100_automod_state is not in the journal');
    return entry.idx;
  })();

  const columnsOf = (raw: Database.Database, table: string): string[] =>
    (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

  it('keeps rules, their children, case events and flags; drops fixtures; the guild is off', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });

    runMigrations(raw, db, migrationsFolderUpTo(AUTOMOD_STATE_IDX));

    // Seeded against the staged-rollout shape: a guild in testing mode, a
    // rule half way through observing, with every child table populated,
    // and a recorded match with its fixture and a false-positive flag.
    raw
      .prepare(
        `INSERT INTO guilds (guild_id, name, automod_testing_mode, created_at, updated_at)
         VALUES (?, 'g', 1, 0, 0)`,
      )
      .run(GUILD_ID);
    raw
      .prepare(
        `INSERT INTO mod_rules
           (guild_id, rule_id, kind, name, config, mode, enabled, observe_started_at,
            legacy_rule_ref, enforce_signed_off_by, enforce_signed_off_at, cutover_state,
            counts_as_violation, max_false_positive_rate, min_reviewed_matches,
            created_at, updated_at)
         VALUES (?, 'kw', 'keyword_filter', 'word filter', '{}', 'observe', 1, 1000,
                 'legacy-1', 'owner', 2000, 'observing', 1, 0.05, 20, 0, 0)`,
      )
      .run(GUILD_ID);
    raw
      .prepare(
        `INSERT INTO word_categories (guild_id, category_id, rule_id, name, default_action, enabled)
         VALUES (?, 'c1', 'kw', 'profanity', 'delete', 1)`,
      )
      .run(GUILD_ID);
    raw
      .prepare(
        `INSERT INTO word_terms (guild_id, term_id, category_id, text, enabled)
         VALUES (?, 't1', 'c1', 'badword', 1)`,
      )
      .run(GUILD_ID);
    raw
      .prepare(
        `INSERT INTO word_allowlist (guild_id, rule_id, phrase) VALUES (?, 'kw', 'assassin')`,
      )
      .run(GUILD_ID);
    raw
      .prepare(
        `INSERT INTO mod_rule_exemptions (guild_id, rule_id, exempt_type, exempt_id)
         VALUES (?, 'kw', 'role', ?)`,
      )
      .run(GUILD_ID, ROLE_ID);
    raw
      .prepare(
        `INSERT INTO automod_fixtures (guild_id, fixture_id, content, author_id, label, source, created_at)
         VALUES (?, 'm1:abc', 'hello badword everyone', ?, 'should_not_match', 'observed', 0)`,
      )
      .run(GUILD_ID, MEMBER_ID);
    raw
      .prepare(
        `INSERT INTO automod_fixture_attachments
           (guild_id, fixture_id, ordinal, file_name, content_type, size_bytes)
         VALUES (?, 'm1:abc', 0, 'a.png', 'image/png', 10)`,
      )
      .run(GUILD_ID);
    raw
      .prepare(
        `INSERT INTO mod_cases (guild_id, case_id, member_id, opened_at) VALUES (?, 'case1', ?, 0)`,
      )
      .run(GUILD_ID, MEMBER_ID);
    raw
      .prepare(
        `INSERT INTO mod_case_events
           (guild_id, event_id, case_id, rule_id, member_id, at, matched_category,
            matched_snippet, action_taken, trace, fixture_id)
         VALUES (?, 'e1', 'case1', 'kw', ?, 0, 'profanity', 'badword', 'would_delete',
                 '{"kind":"keyword_filter"}', 'm1:abc')`,
      )
      .run(GUILD_ID, MEMBER_ID);
    raw
      .prepare(
        `INSERT INTO mod_match_reviews (guild_id, event_id, verdict, reviewed_by, reviewed_at, note)
         VALUES (?, 'e1', 'false_positive', 'owner', 5, 'a quote, not abuse')`,
      )
      .run(GUILD_ID);
    // Channel permissions (0098–0099) cascade from `guilds` too, and 0101
    // rebuilds `guilds`: these rows must survive it.
    raw
      .prepare(
        `INSERT INTO channel_read_scope (guild_id, channel_id, scope_kind, added_at)
         VALUES (?, '444444444444444444', 'channel', 0)`,
      )
      .run(GUILD_ID);
    raw.prepare(`INSERT INTO channel_read_seeds (guild_id, seeded_at) VALUES (?, 0)`).run(GUILD_ID);
    raw
      .prepare(`INSERT INTO channel_write_seeds (guild_id, seeded_at) VALUES (?, 0)`)
      .run(GUILD_ID);

    runMigrations(raw, db, MIGRATIONS_FOLDER);

    expect(
      raw
        .prepare(`SELECT rule_id, kind, name, config, enabled, counts_as_violation FROM mod_rules`)
        .all(),
    ).toEqual([
      {
        rule_id: 'kw',
        kind: 'keyword_filter',
        name: 'word filter',
        config: '{}',
        enabled: 1,
        counts_as_violation: 1,
      },
    ]);
    expect(raw.prepare(`SELECT category_id, rule_id, name FROM word_categories`).all()).toEqual([
      { category_id: 'c1', rule_id: 'kw', name: 'profanity' },
    ]);
    expect(raw.prepare(`SELECT term_id, text FROM word_terms`).all()).toEqual([
      { term_id: 't1', text: 'badword' },
    ]);
    expect(raw.prepare(`SELECT rule_id, phrase FROM word_allowlist`).all()).toEqual([
      { rule_id: 'kw', phrase: 'assassin' },
    ]);
    expect(
      raw.prepare(`SELECT rule_id, exempt_type, exempt_id FROM mod_rule_exemptions`).all(),
    ).toEqual([{ rule_id: 'kw', exempt_type: 'role', exempt_id: ROLE_ID }]);
    expect(
      raw.prepare(`SELECT event_id, case_id, action_taken, trace FROM mod_case_events`).all(),
    ).toEqual([
      {
        event_id: 'e1',
        case_id: 'case1',
        action_taken: 'would_delete',
        trace: '{"kind":"keyword_filter"}',
      },
    ]);
    expect(
      raw.prepare(`SELECT event_id, verdict, reviewed_by, note FROM mod_match_reviews`).all(),
    ).toEqual([
      {
        event_id: 'e1',
        verdict: 'false_positive',
        reviewed_by: 'owner',
        note: 'a quote, not abuse',
      },
    ]);
    expect(raw.prepare(`SELECT case_id FROM mod_cases`).all()).toEqual([{ case_id: 'case1' }]);
    expect(raw.prepare(`SELECT channel_id FROM channel_read_scope`).all()).toEqual([
      { channel_id: '444444444444444444' },
    ]);
    expect(raw.prepare(`SELECT guild_id FROM channel_read_seeds`).all()).toEqual([
      { guild_id: GUILD_ID },
    ]);
    expect(raw.prepare(`SELECT guild_id FROM channel_write_seeds`).all()).toEqual([
      { guild_id: GUILD_ID },
    ]);

    expect(
      raw
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE name IN ('automod_fixtures', 'automod_fixture_attachments')`,
        )
        .all(),
    ).toEqual([]);
    const ruleColumns = columnsOf(raw, 'mod_rules');
    for (const dropped of [
      'mode',
      'cutover_state',
      'observe_started_at',
      'legacy_rule_ref',
      'enforce_signed_off_by',
      'enforce_signed_off_at',
      'max_false_positive_rate',
      'min_reviewed_matches',
    ]) {
      expect(ruleColumns).not.toContain(dropped);
    }
    expect(columnsOf(raw, 'mod_case_events')).not.toContain('fixture_id');
    expect(columnsOf(raw, 'guilds')).not.toContain('automod_testing_mode');

    expect(raw.prepare(`SELECT name, automod_state, dry_run FROM guilds`).all()).toEqual([
      { name: 'g', automod_state: 'off', dry_run: 1 },
    ]);
    expect(() =>
      raw.prepare(`UPDATE guilds SET automod_state = 'enforce' WHERE guild_id = ?`).run(GUILD_ID),
    ).toThrow(/CHECK constraint failed: guilds_automod_state/);
    for (const state of ['off', 'watch', 'on']) {
      raw.prepare(`UPDATE guilds SET automod_state = ? WHERE guild_id = ?`).run(state, GUILD_ID);
    }
    expect(raw.pragma('foreign_key_check')).toEqual([]);

    raw.close();
  });
});

describe('migrations 0102/0103 add the per-guild task-posts switch defaulting off (ADR 0131)', () => {
  const GUILD_ONE = '111111111111111111';
  const GUILD_TWO = '222222222222222222';

  /** The same journal-prefix folder the 0101 test above builds; see its comment. */
  const migrationsFolderUpTo = (lastIdx: number): string => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { version: string; dialect: string; entries: { idx: number; tag: string }[] };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-posts-migration-'));
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

  /** The journal idx of `0101_automod_cleanup`, the migration before the switch. */
  const BEFORE_SWITCH_IDX = (() => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    const entry = journal.entries.find((e) => e.tag === '0101_automod_cleanup');
    if (entry === undefined) throw new Error('0101_automod_cleanup is not in the journal');
    return entry.idx;
  })();

  it('existing guilds read as off after the upgrade, and anything but 0/1 is refused', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });

    runMigrations(raw, db, migrationsFolderUpTo(BEFORE_SWITCH_IDX));

    // Seeded against the pre-switch shape: no `task_posts_enabled` column yet.
    for (const guildId of [GUILD_ONE, GUILD_TWO]) {
      raw
        .prepare(`INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?, 'g', 0, 0)`)
        .run(guildId);
    }

    runMigrations(raw, db, MIGRATIONS_FOLDER);

    // Existing installs read as off, as before (ADR 0131 consequences).
    expect(
      raw.prepare(`SELECT guild_id, task_posts_enabled FROM guilds ORDER BY guild_id`).all(),
    ).toEqual([
      { guild_id: GUILD_ONE, task_posts_enabled: 0 },
      { guild_id: GUILD_TWO, task_posts_enabled: 0 },
    ]);
    // The 0103 CHECK, not just the 0102 default: a 2 is refused on write…
    expect(() =>
      raw.prepare(`UPDATE guilds SET task_posts_enabled = 2 WHERE guild_id = ?`).run(GUILD_ONE),
    ).toThrow(/CHECK constraint failed: guilds_task_posts_enabled_bool/);
    // …and on insert.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO guilds (guild_id, name, task_posts_enabled, created_at, updated_at)
           VALUES ('333333333333333333', 'h', 2, 0, 0)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed: guilds_task_posts_enabled_bool/);
    // While 0 and 1 both write fine.
    for (const value of [0, 1]) {
      raw.prepare(`UPDATE guilds SET task_posts_enabled = ? WHERE guild_id = ?`).run(value, GUILD_ONE);
    }
    expect(raw.pragma('foreign_key_check')).toEqual([]);

    raw.close();
  });
});
