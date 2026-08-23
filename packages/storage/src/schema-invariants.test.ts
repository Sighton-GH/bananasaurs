import { afterAll, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from './test-support.js';

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
