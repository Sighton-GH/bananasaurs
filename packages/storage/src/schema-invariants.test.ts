import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as schema from './schema.js';
import { runMigrations } from './db.js';
import { MIGRATIONS_FOLDER, openMigratedTestDatabase, type MigratedTestDatabase } from './test-support.js';

/**
 * The invariants every Release 1 table must satisfy, read from the live schema
 * rather than from `schema.ts`.
 *
 * Written before the tables it governs, deliberately. Written afterwards this
 * would be a one-time audit of work already done — it would pass on the day it
 * was added and prove nothing about the next table anyone writes. Written
 * first, every table that arrives has to satisfy it on arrival, and a table
 * missing `guild_id` or carrying a unique index that does not lead with
 * `guild_id` fails the build the moment it appears.
 *
 * Reading the live schema also means it covers things `schema.ts` cannot
 * express: STRICT exists only in the migration SQL, because drizzle-kit cannot
 * emit it and `scripts/strictify.mjs` adds it after generation.
 */

/**
 * Tables that are legitimately not guild-partitioned.
 *
 * An account and a bootstrap token exist before any guild is chosen, and both
 * are instance-level by ADR 0012. Adding to this list requires editing this
 * test, which is the point — it is a decision, not an oversight.
 */
const INSTANCE_LEVEL = new Set<string>(['dashboard_accounts', 'bootstrap_tokens']);

/**
 * Unique indexes that may not lead with `guild_id`, each because leading with
 * it would be wrong rather than merely inconvenient.
 *
 * Same rule: adding an entry is an edit to this file with a reason attached.
 */
const UNIQUE_BY_DESIGN = new Map<string, string>([
  [
    'sqlite_autoindex_dashboard_sessions_1',
    'dashboard_sessions primary key. A session is looked up by its token before ' +
      'the guild is known — guild-scoping this index would mean trusting a ' +
      'client-supplied guild in order to authenticate the session, which is ' +
      'backwards. The session row still carries guild_id, and every query that ' +
      'reads guild data through a session checks it (ADR 0012).',
  ],
]);

/** SQLite's own tables, and drizzle's migration bookkeeping. */
const INTERNAL = /^(sqlite_|__drizzle_)/;

/**
 * Columns that hold a Discord snowflake and therefore need a format CHECK.
 *
 * Our own identifiers — `panel_id`, `option_id`, `batch_id`, `effect_id`,
 * `job_id`, `account_id`, `session_id` — are not snowflakes and are absent.
 * So are `actor_id` and `granted_by`, which may hold either a Discord user id
 * or a dashboard account id; a snowflake CHECK on those would be wrong.
 */
const SNOWFLAKE_COLUMNS = new Set<string>([
  'guild_id',
  'user_id',
  'role_id',
  'channel_id',
  'message_id',
  'required_role_id',
  'principal_id',
]);

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
}
interface ForeignKeyRow {
  id: number;
  table: string;
  from: string;
}
interface IndexRow {
  name: string;
  unique: number;
  origin: string;
}
interface TableRow {
  name: string;
  strict: number;
}

/**
 * Opened at module scope, not in `beforeAll`. `it.each` builds its cases while
 * the file is being collected, which happens before any hook runs — a database
 * opened in `beforeAll` is still undefined when the table list is read.
 */
const t: MigratedTestDatabase = openMigratedTestDatabase();

afterAll(() => {
  t.close();
});

const allTables = (): TableRow[] =>
  (t.raw.prepare('PRAGMA table_list').all() as (TableRow & { schema: string; type: string })[])
    .filter((r) => r.schema === 'main' && r.type === 'table' && !INTERNAL.test(r.name))
    .map(({ name, strict }) => ({ name, strict }));

const columns = (table: string): ColumnInfo[] =>
  t.raw.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];

const foreignKeys = (table: string): ForeignKeyRow[] =>
  t.raw.prepare(`PRAGMA foreign_key_list(${table})`).all() as ForeignKeyRow[];

const uniqueIndexes = (table: string): IndexRow[] =>
  (t.raw.prepare(`PRAGMA index_list(${table})`).all() as IndexRow[]).filter((i) => i.unique === 1);

const indexColumns = (index: string): string[] =>
  (t.raw.prepare(`PRAGMA index_info('${index}')`).all() as { name: string | null }[])
    .map((r) => r.name)
    .filter((n): n is string => n !== null);

const ddl = (table: string): string => {
  const row = t.raw
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { sql: string } | undefined;
  return row?.sql ?? '';
};

const guildPartitioned = (): string[] =>
  allTables()
    .map((r) => r.name)
    .filter((name) => !INSTANCE_LEVEL.has(name));

describe('the schema has tables to check at all', () => {
  // Guards against the whole suite passing vacuously if migrations stop
  // applying — every loop below is over a table list, and an empty list makes
  // every invariant trivially true.
  it('found at least one table', () => {
    expect(allTables().length).toBeGreaterThan(0);
  });

  it('applied the migrations, not just an empty database', () => {
    expect(allTables().map((r) => r.name)).toContain('guilds');
  });
});

describe('every table is STRICT', () => {
  it.each(allTables().map((r) => r.name))('%s', (table) => {
    const row = allTables().find((r) => r.name === table);
    expect(
      row?.strict,
      `${table} is not STRICT. drizzle-kit cannot emit STRICT; scripts/strictify.mjs adds it ` +
        `after generation and runs as part of npm run db:generate. If this table was added by a ` +
        `hand-written migration, add STRICT to it.`,
    ).toBe(1);
  });
});

describe('every guild-partitioned table carries the partition key', () => {
  it.each(guildPartitioned())('%s has guild_id TEXT NOT NULL', (table) => {
    const guildId = columns(table).find((c) => c.name === 'guild_id');
    expect(
      guildId,
      `${table} has no guild_id. Guild scope is a mandatory partition key: every query, index ` +
        `and export carries it. If this table really is instance-level, add it to INSTANCE_LEVEL ` +
        `in this file with a reason.`,
    ).toBeDefined();
    expect(guildId?.type).toBe('TEXT');
    expect(guildId?.notnull, `${table}.guild_id must be NOT NULL`).toBe(1);
  });
});

describe('every foreign key into a guild-partitioned table carries guild_id', () => {
  it.each(guildPartitioned())('%s', (table) => {
    const partitioned = new Set(guildPartitioned());
    const byConstraint = new Map<number, ForeignKeyRow[]>();
    for (const fk of foreignKeys(table)) {
      byConstraint.set(fk.id, [...(byConstraint.get(fk.id) ?? []), fk]);
    }

    for (const [id, parts] of byConstraint) {
      const target = parts[0]?.table ?? '';
      if (!partitioned.has(target)) continue;
      const from = parts.map((p) => p.from);
      expect(
        from,
        `${table} foreign key #${id} references ${target} without guild_id (${from.join(', ')}). ` +
          `A composite key including guild_id is what makes a child row physically unable to ` +
          `reference a parent in another guild.`,
      ).toContain('guild_id');
    }
  });
});

describe('every unique index on a guild-partitioned table leads with guild_id', () => {
  it.each(guildPartitioned())('%s', (table) => {
    for (const index of uniqueIndexes(table)) {
      if (UNIQUE_BY_DESIGN.has(index.name)) continue;
      const cols = indexColumns(index.name);
      expect(
        cols[0],
        `${table}.${index.name} (${index.origin}) leads with ${String(cols[0])}, not guild_id. ` +
          `A unique index that does not lead with the partition key can collide across guilds, ` +
          `or force a scan to answer a scoped question. If it must be globally unique, add it ` +
          `to UNIQUE_BY_DESIGN in this file with a reason.`,
      ).toBe('guild_id');
    }
  });
});

describe('every snowflake column has a format CHECK', () => {
  it.each(allTables().map((r) => r.name))('%s', (table) => {
    const sql = ddl(table);
    for (const column of columns(table)) {
      if (!SNOWFLAKE_COLUMNS.has(column.name)) continue;
      expect(
        new RegExp(`"${table}"\\."${column.name}" NOT GLOB`).test(sql),
        `${table}.${column.name} holds a snowflake but has no format CHECK. Pair every ` +
          `snowflake() column with snowflakeCheck() or nullableSnowflakeCheck() in the table's ` +
          `constraint list.`,
      ).toBe(true);
    }
  });
});

/**
 * `mod_rules`'s `config`/CHECK migration (ADR 0040, Task 1) rebuilds the
 * table — SQLite cannot `ALTER TABLE … ADD CONSTRAINT` — and four tables
 * carry composite foreign keys onto `mod_rules(guild_id, rule_id)`:
 * `mod_rule_exemptions`, `word_categories`, `word_allowlist`, and
 * (transitively, through `word_categories`) `word_terms`. A rebuild that
 * drops and recreates the parent table is exactly the shape of change that
 * can silently orphan or cascade-delete those children if the generated
 * migration gets the column list, the FK pragma, or the drop/rename order
 * wrong — so this is proved directly, against real migration files, rather
 * than trusted from reading the SQL.
 *
 * Deliberately does not use `openMigratedTestDatabase()`: that applies every
 * migration to an empty database, so `mod_rules` is created *once*, already
 * in its final shape, and the table-rebuild statements in migrations
 * 0010/0011 never actually run against data. This test instead migrates a
 * database up to the last pre-Task-1 migration (0009), inserts one rule with
 * a category, a term, an allowlist phrase and a role exemption — the same
 * shape `automod-rules.test.ts` builds through the repo — then applies the
 * remaining (real, shipped) migration files and reads the rows back with raw
 * SQL, independent of the repo layer this same task rewrites.
 */
describe('mod_rules.config migration (0010/0011) carries child-table rows through the rebuild', () => {
  const GUILD_ID = '111111111111111111';
  const RULE_ID = 'rule-pre-existing';
  const CATEGORY_ID = 'cat-1';
  const TERM_ID = 'term-1';
  const ROLE_ID = '222222222222222222';

  /**
   * A migrations folder containing only the journal entries and `.sql` files
   * for migrations up to and including `tag`, so `migrate()` can be run
   * against a snapshot of the schema older than what ships. `readMigrationFiles`
   * (`drizzle-orm/migrator.js`) needs only `meta/_journal.json` and the `.sql`
   * files it names — not the `meta/*_snapshot.json` files, which are
   * drizzle-kit's own bookkeeping for the *next* `generate`, never read by
   * `migrate()`.
   */
  const migrationsFolderUpTo = (lastIdx: number): string => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { version: string; dialect: string; entries: { idx: number; tag: string }[] };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-rules-migration-'));
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

  it('keeps the rule, its word list and its exemption readable after the rebuild', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });

    // Pre-Task-1 schema: `mod_rules` has no `config` column and its `kind`
    // CHECK admits only 'keyword_filter'.
    runMigrations(raw, db, migrationsFolderUpTo(9));

    raw
      .prepare(
        `INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?, 'g', 0, 0)`,
      )
      .run(GUILD_ID);
    raw
      .prepare(
        `INSERT INTO mod_rules (guild_id, rule_id, kind, name, mode, enabled, created_at, updated_at)
         VALUES (?, ?, 'keyword_filter', 'pre-existing', 'test', 1, 0, 0)`,
      )
      .run(GUILD_ID, RULE_ID);
    raw
      .prepare(
        `INSERT INTO word_categories (guild_id, category_id, rule_id, name, default_action, enabled)
         VALUES (?, ?, ?, 'profanity', 'delete', 1)`,
      )
      .run(GUILD_ID, CATEGORY_ID, RULE_ID);
    raw
      .prepare(
        `INSERT INTO word_terms (guild_id, term_id, category_id, text, enabled)
         VALUES (?, ?, ?, 'badword', 1)`,
      )
      .run(GUILD_ID, TERM_ID, CATEGORY_ID);
    raw
      .prepare(`INSERT INTO word_allowlist (guild_id, rule_id, phrase) VALUES (?, ?, 'assassin')`)
      .run(GUILD_ID, RULE_ID);
    raw
      .prepare(
        `INSERT INTO mod_rule_exemptions (guild_id, rule_id, exempt_type, exempt_id)
         VALUES (?, ?, 'role', ?)`,
      )
      .run(GUILD_ID, RULE_ID, ROLE_ID);

    // Applies every migration the real folder carries that is not yet
    // recorded as applied — 0010 (`ALTER TABLE … ADD config`) and 0011 (the
    // `mod_rules_kind` rebuild), against the data just inserted. Goes
    // through `runMigrations`, not `migrate()` directly — this is the exact
    // call this guard exists to prove is now safe (ADR 0040 ledger R-5).
    runMigrations(raw, db, MIGRATIONS_FOLDER);

    const rule = raw
      .prepare(`SELECT kind, config, name FROM mod_rules WHERE guild_id = ? AND rule_id = ?`)
      .get(GUILD_ID, RULE_ID) as { kind: string; config: string; name: string } | undefined;
    expect(rule).toEqual({ kind: 'keyword_filter', config: '{}', name: 'pre-existing' });

    const category = raw
      .prepare(`SELECT name FROM word_categories WHERE guild_id = ? AND category_id = ?`)
      .get(GUILD_ID, CATEGORY_ID) as { name: string } | undefined;
    expect(category?.name).toBe('profanity');

    const term = raw
      .prepare(`SELECT text FROM word_terms WHERE guild_id = ? AND term_id = ?`)
      .get(GUILD_ID, TERM_ID) as { text: string } | undefined;
    expect(term?.text).toBe('badword');

    const allowlist = raw
      .prepare(`SELECT phrase FROM word_allowlist WHERE guild_id = ? AND rule_id = ?`)
      .all(GUILD_ID, RULE_ID) as { phrase: string }[];
    expect(allowlist.map((r) => r.phrase)).toEqual(['assassin']);

    const exemption = raw
      .prepare(
        `SELECT exempt_type, exempt_id FROM mod_rule_exemptions WHERE guild_id = ? AND rule_id = ?`,
      )
      .get(GUILD_ID, RULE_ID) as { exempt_type: string; exempt_id: string } | undefined;
    expect(exemption).toEqual({ exempt_type: 'role', exempt_id: ROLE_ID });

    raw.close();
  });
});

/**
 * The other half of `runMigrations` (`db.ts`): disabling `foreign_keys` for
 * the run is only safe because `PRAGMA foreign_key_check` runs immediately
 * afterwards and fails loudly if the migration left anything referentially
 * broken. This cannot be exercised against the real `drizzle/` migrations —
 * none of them are broken — so this builds a throwaway, single-migration
 * fixture folder whose own SQL inserts a child row with no matching parent.
 * That insert only succeeds *because* `runMigrations` has enforcement off
 * for the duration of the migration, which is exactly the scenario the
 * check exists to catch on the way out.
 */
describe('runMigrations fails the run when a migration leaves a dangling reference', () => {
  /** A one-migration fixture folder: `sql` is the migration's full body. */
  const fakeMigrationsFolder = (sql: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dangling-fk-migration-'));
    fs.mkdirSync(path.join(dir, 'meta'));
    const tag = '0000_dangling';
    fs.writeFileSync(
      path.join(dir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [{ idx: 0, version: '6', when: Date.now(), tag, breakpoints: true }],
      }),
    );
    fs.writeFileSync(path.join(dir, `${tag}.sql`), sql);
    return dir;
  };

  it('throws instead of returning a database with an orphaned row', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });

    const folder = fakeMigrationsFolder(
      [
        `CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;`,
        `CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL, FOREIGN KEY (parent_id) REFERENCES parent(id)) STRICT;`,
        // Only succeeds because runMigrations has foreign_keys off for the
        // migration itself — with enforcement on, this INSERT would throw
        // and this fixture would prove nothing.
        `INSERT INTO child (id, parent_id) VALUES (1, 999);`,
      ].join('\n--> statement-breakpoint\n'),
    );

    expect(() => runMigrations(raw, db, folder)).toThrow(/foreign key violation/i);

    raw.close();
  });

  it('leaves foreign_keys restored to on after the failed run', () => {
    // A thrown migration must not leave the connection permanently
    // unprotected for whatever runs next against it.
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });
    const folder = fakeMigrationsFolder(
      [
        `CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;`,
        `CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL, FOREIGN KEY (parent_id) REFERENCES parent(id)) STRICT;`,
        `INSERT INTO child (id, parent_id) VALUES (1, 999);`,
      ].join('\n--> statement-breakpoint\n'),
    );

    expect(() => runMigrations(raw, db, folder)).toThrow();
    expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);

    raw.close();
  });
});
