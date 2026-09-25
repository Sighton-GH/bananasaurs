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
