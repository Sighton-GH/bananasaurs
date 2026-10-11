import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGuildId, RULE_KINDS } from '@bananasaurs/core';
import { SQL, StringChunk } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import * as schema from './schema.js';
import { runMigrations } from './db.js';
import { createRule, type RuleKind } from './repos/automod-rules.js';
import { disableChannel, enableChannel, upsertMessage } from './repos/archive.js';
import { upsertGuild } from './repos/guilds.js';
import {
  MIGRATIONS_FOLDER,
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from './test-support.js';

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
const INSTANCE_LEVEL = new Set<string>([
  'dashboard_accounts',
  'bootstrap_tokens',
  // ADR 0045 D3: an OAuth client is registered against the daemon, not a guild.
  'oauth_clients',
  // ADR 0045 PR-91: a consent form in flight, before any guild is chosen.
  'oauth_pending_authorizations',
  // ADR 0045 D3: a code is exchanged for a token, and a token carries no guild.
  'oauth_authorization_codes',
  // ADR 0045 PR-92: reachable guilds are computed live per call, never stored.
  'oauth_tokens',
  // ADR 0044 §7: a provider is a fact about the daemon, not a guild.
  'provider_eligibility',
  // Release 3: one encrypted provider configuration for the daemon.
  'assistant_provider_config',
  // ADR 0075 / Task 6b: instance-level provider configuration — several
  // labelled keys per provider and one ordered model chain of key + model.
  'assistant_provider_keys',
  'assistant_model_chain',
  // ADR 0080: owner-edited instance settings govern the one process.
  'instance_settings',
  // ADR 0081: the per-model call ledger is keyed by shared key; guild_id
  // records which guild spent the call.
  'assistant_model_calls',
  // ADR 0120: the per-source search keys and their call ledger are keyed by
  // shared key; guild_id records which guild spent the call.
  'assistant_search_keys',
  'assistant_search_calls',
  // ADR 0143: a cooldown belongs to a shared provider key and model, not a guild.
  'assistant_key_cooldowns',
]);

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
  // Slice 2 task 3 (migration 0091): the message a reply answers.
  'reply_to_message_id',
  'attachment_id',
  'required_role_id',
  'principal_id',
  // ADR 0072: assistant_conversations.started_by.
  'started_by',
  // Slice 3 task 1 (migration 0092): the mcp_actions targets and results, and
  // the mcp_private_threads thread and parent channel.
  'target_channel_id',
  'result_message_id',
  'result_thread_id',
  'thread_id',
  'parent_channel_id',
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
 * `mod_rules_kind`'s SQL CHECK, storage's `RuleKind` union
 * (`repos/automod-rules.ts`) and core's `RULE_KINDS` array
 * (`@bananasaurs/core`) are three hand-maintained copies of the same ten
 * values, agreeing today only because nobody has edited one without editing
 * the other two. Proved here against the *live* CHECK, independent of
 * `schema.ts`'s own literal, so drift becomes a red test rather than an
 * inert rule a hand-edited row or a future migration could quietly widen or
 * narrow out of step with core.
 */
describe("mod_rules_kind's CHECK matches core's RULE_KINDS exactly", () => {
  const GUILD_ID = parseGuildId('999999999999999999');

  it('accepts every one of the ten values RULE_KINDS names', () => {
    const scope = t.scopes.forGuild(GUILD_ID);
    upsertGuild(scope, { name: 'kind-pin-guild', now: 0 });
    for (const [i, kind] of RULE_KINDS.entries()) {
      // `RULE_KINDS` (core, `@bananasaurs/core`) and `RuleKind`
      // (`repos/automod-rules.ts`) are independently declared unions of the
      // same ten literals (ADR 0014 bars importing one from the other), so
      // TypeScript accepts a `RULE_KINDS` element here with no cast — which
      // is itself only a compile-time fact about the two *declarations*.
      // What this loop actually proves is that the live CHECK, the thing
      // neither declaration is, agrees with both.
      expect(() =>
        createRule(scope, {
          ruleId: `kind-pin-${String(i)}`,
          kind,
          name: kind,
          config: '{}',
          now: 1,
        }),
      ).not.toThrow();
    }
  });

  it('rejects a kind RULE_KINDS does not name', () => {
    const scope = t.scopes.forGuild(GUILD_ID);
    expect(() =>
      createRule(scope, {
        // Deliberately outside RULE_KINDS. If a future RULE_KINDS entry is
        // ever named 'telepathy' this assertion stops meaning anything —
        // acceptable, because that would mean core had actually grown an
        // eleventh kind, which is exactly the drift this file exists to
        // notice, loudly, rather than silently.
        kind: 'telepathy' as RuleKind,
        ruleId: 'kind-pin-rejected',
        name: 'telepathy',
        config: '{}',
        now: 1,
      }),
    ).toThrow();
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
/**
 * A migrations folder containing only the journal entries and `.sql` files
 * for migrations up to and including `tag`, so `migrate()` can be run
 * against a snapshot of the schema older than what ships. `readMigrationFiles`
 * (`drizzle-orm/migrator.js`) needs only `meta/_journal.json` and the `.sql`
 * files it names — not the `meta/*_snapshot.json` files, which are
 * drizzle-kit's own bookkeeping for the *next* `generate`, never read by
 * `migrate()`.
 *
 * Module scope, not local to one describe block: both the 0010/0011 rebuild
 * proof below and ADR 0042's own rebuild proof (0015-0017) need it, and it
 * would drift if each grew its own copy.
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

describe('mod_rules.config migration (0010/0011) carries child-table rows through the rebuild', () => {
  const GUILD_ID = '111111111111111111';
  const RULE_ID = 'rule-pre-existing';
  const CATEGORY_ID = 'cat-1';
  const TERM_ID = 'term-1';
  const ROLE_ID = '222222222222222222';

  it('keeps the rule, its word list and its exemption readable after the rebuild', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });

    // Pre-Task-1 schema: `mod_rules` has no `config` column and its `kind`
    // CHECK admits only 'keyword_filter'.
    runMigrations(raw, db, migrationsFolderUpTo(9));

    raw
      .prepare(`INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?, 'g', 0, 0)`)
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
 * M5-D5: `audit_events.actor_type` gains `'mcp_operator'` by rebuild (0023),
 * proved the same way as the 0010/0011 precedent above and for the same
 * reason: `openMigratedTestDatabase()` creates `audit_events` once, already
 * in its final shape, so 0023's rebuild statements never run against data
 * there. This migrates to 0022 (the last migration before M5 Task 1), seeds
 * three audit rows across three actor types with every nullable column set
 * somewhere and null somewhere, then applies the real 0023 and reads the rows
 * back with raw SQL, independent of any repo layer.
 *
 * 0023 is also the first rebuild of a table carrying a sort-ordered index
 * (`audit_tail … ("at" desc)`): drizzle-kit 0.31.10's rebuild path misquotes
 * it as `` `"at" desc` `` (ruling M5-D7), so the proof covers the index and
 * not only the rows.
 */
describe('the audit actor_type widening migration (0023, M5-D5) carries audit rows through the rebuild', () => {
  const GUILD_ID = '111111111111111111';

  const AUDIT_COLUMNS =
    'audit_id, guild_id, at, actor_type, actor_id, actor_unix_user_claimed, ' +
    'via, action, subject_type, subject_id, batch_id, `before`, `after`, dry_run, inferred';

  /**
   * A database migrated to 0022 and seeded with three audit rows: the state
   * 0023's rebuild has to carry through. Shared by the survival proof and the
   * CHECK-direction assertions so the two cannot drift into testing different
   * data.
   */
  const seedAt0022 = (): {
    raw: Database.Database;
    db: BetterSQLite3Database<typeof schema>;
  } => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });

    // The last migration before M5 Task 1: `audit_events.actor_type` admits
    // six values and `mcp_sends` / `mcp_send_allowlist` do not exist yet.
    runMigrations(raw, db, migrationsFolderUpTo(22));

    raw
      .prepare(`INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?, 'g', 0, 0)`)
      .run(GUILD_ID);
    // Row 1: every nullable column set except the CLI-claimed user.
    raw
      .prepare(
        `INSERT INTO audit_events (guild_id, at, actor_type, actor_id, actor_unix_user_claimed,
          via, action, subject_type, subject_id, batch_id, \`before\`, \`after\`, dry_run, inferred)
         VALUES (?, 1000, 'member', '333333333333333333', NULL,
          'gateway', 'message.delete', 'message', '444444444444444444', 'batch-1',
          '{"count":1}', '{"count":2}', 1, 0)`,
      )
      .run(GUILD_ID);
    // Row 2: the sparse shape — `via` and every payload column NULL.
    raw
      .prepare(
        `INSERT INTO audit_events (guild_id, at, actor_type, actor_id, actor_unix_user_claimed,
          via, action, subject_type, subject_id, batch_id, \`before\`, \`after\`, dry_run, inferred)
         VALUES (?, 2000, 'dashboard', 'acct-1', NULL,
          NULL, 'role.grant', 'member', NULL, NULL, NULL, NULL, 0, 1)`,
      )
      .run(GUILD_ID);
    // Row 3: the CLI shape — no Discord actor, claimed unix user instead.
    raw
      .prepare(
        `INSERT INTO audit_events (guild_id, at, actor_type, actor_id, actor_unix_user_claimed,
          via, action, subject_type, subject_id, batch_id, \`before\`, \`after\`, dry_run, inferred)
         VALUES (?, 3000, 'operator_cli', NULL, 'bryan',
          'ssh', 'mcp.allow_channel', 'channel', '555555555555555555', NULL, NULL, NULL, 0, 0)`,
      )
      .run(GUILD_ID);

    return { raw, db };
  };

  it('keeps every audit row, with audit_id intact, across the rebuild', () => {
    const { raw, db } = seedAt0022();

    const before = raw.prepare(`SELECT ${AUDIT_COLUMNS} FROM audit_events ORDER BY audit_id`).all();

    // Applies exactly 0023 against the data just inserted — migrations 0-22
    // are already recorded as applied. Through `runMigrations`, the exact
    // call this guard exists to prove is safe here.
    runMigrations(raw, db, MIGRATIONS_FOLDER);

    const after = raw.prepare(`SELECT ${AUDIT_COLUMNS} FROM audit_events ORDER BY audit_id`).all();
    expect(after).toEqual(before);
    expect(after).toEqual([
      {
        audit_id: 1,
        guild_id: GUILD_ID,
        at: 1000,
        actor_type: 'member',
        actor_id: '333333333333333333',
        actor_unix_user_claimed: null,
        via: 'gateway',
        action: 'message.delete',
        subject_type: 'message',
        subject_id: '444444444444444444',
        batch_id: 'batch-1',
        before: '{"count":1}',
        after: '{"count":2}',
        dry_run: 1,
        inferred: 0,
      },
      {
        audit_id: 2,
        guild_id: GUILD_ID,
        at: 2000,
        actor_type: 'dashboard',
        actor_id: 'acct-1',
        actor_unix_user_claimed: null,
        via: null,
        action: 'role.grant',
        subject_type: 'member',
        subject_id: null,
        batch_id: null,
        before: null,
        after: null,
        dry_run: 0,
        inferred: 1,
      },
      {
        audit_id: 3,
        guild_id: GUILD_ID,
        at: 3000,
        actor_type: 'operator_cli',
        actor_id: null,
        actor_unix_user_claimed: 'bryan',
        via: 'ssh',
        action: 'mcp.allow_channel',
        subject_type: 'channel',
        subject_id: '555555555555555555',
        batch_id: null,
        before: null,
        after: null,
        dry_run: 0,
        inferred: 0,
      },
    ]);

    raw.close();
  });

  it('accepts mcp_operator and still rejects a value it should not', () => {
    const { raw, db } = seedAt0022();
    runMigrations(raw, db, MIGRATIONS_FOLDER);

    // The widened CHECK admits the new actor type (both directions: the
    // rejection below proves the acceptance above is the CHECK's doing and
    // not a missing constraint).
    expect(() =>
      raw
        .prepare(
          `INSERT INTO audit_events (guild_id, at, actor_type, action, subject_type)
           VALUES (?, 4000, 'mcp_operator', 'message.send', 'message')`,
        )
        .run(GUILD_ID),
    ).not.toThrow();
    expect(() =>
      raw
        .prepare(
          `INSERT INTO audit_events (guild_id, at, actor_type, action, subject_type)
           VALUES (?, 4000, 'nonsense', 'message.send', 'message')`,
        )
        .run(GUILD_ID),
    ).toThrow();

    raw.close();
  });

  it('keeps audit_tail present and sort-ordered after the rebuild', () => {
    const { raw, db } = seedAt0022();
    runMigrations(raw, db, MIGRATIONS_FOLDER);

    const rebuilt = raw
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'audit_tail'`)
      .get() as { sql: string } | undefined;
    // Ruling M5-D7: drizzle-kit 0.31.10's rebuild path misquotes this as
    // `"at" desc` wrapped in backticks, a single nonexistent column. The
    // corrected migration carries 0000's rendering byte-identically.
    expect(rebuilt?.sql).toContain('"at" desc');

    raw.close();
  });

  /**
   * The schema-side half of the CHECK widening: `schema.ts` itself defines
   * `'mcp_operator'` in `audit_events_actor_type`, rendered here from the
   * table definition rather than asserted from the migrated database. The
   * migrated database cannot see `schema.ts` — a widening removed there
   * would still pass every assertion above against the frozen `drizzle/`
   * folder, so without this the definition could drift silently out of step
   * with the migration that shipped it.
   */
  it('schema.ts still defines the widened audit_events_actor_type CHECK', () => {
    // The literal SQL fragments inside a CHECK's template, collected
    // recursively (a fragment may nest inside a nested `sql` piece). Columns
    // and params are skipped — only the written literal can name the value.
    const literals = (value: SQL): string[] => {
      const out: string[] = [];
      const walk = (chunk: unknown): void => {
        if (typeof chunk === 'string') out.push(chunk);
        else if (chunk instanceof StringChunk) out.push(...chunk.value);
        else if (chunk instanceof SQL) for (const nested of chunk.queryChunks) walk(nested);
      };
      for (const chunk of value.queryChunks) walk(chunk);
      return out;
    };
    const actorType = getTableConfig(schema.auditEvents).checks.find(
      (c) => c.name === 'audit_events_actor_type',
    );
    expect(actorType).toBeDefined();
    expect(literals(actorType!.value).join('')).toContain(`'mcp_operator'`);
  });
});

/**
 * ADR 0042's own rebuild (0015-0017, Slice 6 Task 1), proved the same way and
 * for the same reason: "an earlier test covers the rebuild" is exactly the
 * assumption Amendment 1 warns against — `openMigratedTestDatabase()` builds
 * `mod_rules` once, already in its final shape, so this slice's own rebuild
 * statements never run against data there. This migrates to 0014 (the last
 * migration before this slice), seeds one rule with all four child rows
 * `word_categories`, `word_terms`, `word_allowlist`, and
 * `mod_rule_exemptions` — the same shape as the 0010/0011 proof above — then
 * applies the slice's migrations and reads every child row back, plus asserts
 * the rule's own new columns landed with their documented defaults.
 *
 * Which of the three migrations actually rebuilds, and why it took three
 * `db:generate` runs rather than the two ruling R-6 prescribed: 0015 adds the
 * four plain nullable columns and 0016 the four defaulted ones, both as plain
 * `ALTER TABLE … ADD COLUMN`, no rebuild. **0017 is the rebuild** — SQLite
 * cannot add a CHECK constraint to an existing table at all, so every new
 * CHECK forces one. Splitting the column adds from their CHECKs is what keeps
 * that rebuild valid: its `INSERT … SELECT` names all fifteen columns, and
 * every one of them already exists on the old table because 0015 and 0016 put
 * them there. Generating a column and its CHECK together is the R-6 shape that
 * emits a `SELECT` reading a column the old table does not have yet.
 *
 * 0017 rebuilds *two* tables, `guilds` and `mod_rules`. `mod_rules` carries a
 * real `ON DELETE cascade` foreign key onto `guilds`, and `word_categories`,
 * `word_allowlist` and `mod_rule_exemptions` carry one onto `mod_rules`, so
 * this proves two things at once: a `guilds` rebuild does not cascade away the
 * rules referencing it, and a `mod_rules` rebuild does not cascade away its own
 * children. 0017 also contains a mid-file `PRAGMA foreign_keys=ON` (drizzle-kit
 * emits one per rebuilt table) which would re-arm the cascade for the
 * `mod_rules` half if it took effect; it does not, because `migrate()` runs the
 * file inside a transaction and SQLite documents this pragma as a no-op there.
 * That is a claim about someone else's library, so it is not taken on trust:
 * the sibling test below drops `runMigrations`'s connection-level
 * `foreign_keys = OFF` and watches these same rows disappear.
 */
describe('the cutover-gate migration (0015-0017, ADR 0042) carries child-table rows through its own rebuild', () => {
  const GUILD_ID = '111111111111111111';
  const RULE_ID = 'rule-pre-existing';
  const CATEGORY_ID = 'cat-1';
  const TERM_ID = 'term-1';
  const ROLE_ID = '222222222222222222';

  /**
   * A database migrated to 0014 and seeded with one rule and all four of its
   * child rows: the state this slice's migrations have to carry through a
   * two-table rebuild. Shared by the survival proof and its negative control
   * so the two cannot drift into testing different data.
   */
  const seedAt0014 = (): {
    raw: Database.Database;
    db: BetterSQLite3Database<typeof schema>;
  } => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });

    // The last migration before this slice: `mod_rules` has none of the
    // eight new columns yet, and `guilds` has no `automod_testing_mode`.
    runMigrations(raw, db, migrationsFolderUpTo(14));

    raw
      .prepare(`INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?, 'g', 0, 0)`)
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

    return { raw, db };
  };

  it('keeps the rule, its word list and its exemption readable, and the rule gets the new defaults', () => {
    const { raw, db } = seedAt0014();

    // Applies exactly 0015, 0016 and 0017 against the data just inserted —
    // migrations 0-14 are already recorded as applied. Through
    // `runMigrations`, not `migrate()` directly, which is the exact call
    // this guard exists to prove is safe here (ADR 0042 Amendment 1, R-5).
    // Capped at 0017: 0101 (ADR 0121) later drops the columns read below.
    runMigrations(raw, db, migrationsFolderUpTo(17));

    const rule = raw
      .prepare(
        `SELECT kind, name, cutover_state, observe_started_at, legacy_rule_ref,
                counts_as_violation, max_false_positive_rate, min_reviewed_matches,
                enforce_signed_off_by, enforce_signed_off_at
         FROM mod_rules WHERE guild_id = ? AND rule_id = ?`,
      )
      .get(GUILD_ID, RULE_ID) as
      | {
          kind: string;
          name: string;
          cutover_state: string;
          observe_started_at: number | null;
          legacy_rule_ref: string | null;
          counts_as_violation: number;
          max_false_positive_rate: number;
          min_reviewed_matches: number;
          enforce_signed_off_by: string | null;
          enforce_signed_off_at: number | null;
        }
      | undefined;
    expect(rule).toEqual({
      kind: 'keyword_filter',
      name: 'pre-existing',
      cutover_state: 'not_started',
      observe_started_at: null,
      legacy_rule_ref: null,
      counts_as_violation: 1,
      max_false_positive_rate: 0.05,
      min_reviewed_matches: 20,
      enforce_signed_off_by: null,
      enforce_signed_off_at: null,
    });

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

    const guild = raw
      .prepare(`SELECT automod_testing_mode FROM guilds WHERE guild_id = ?`)
      .get(GUILD_ID) as { automod_testing_mode: number } | undefined;
    expect(guild?.automod_testing_mode).toBe(0);

    raw.close();
  });

  /**
   * The negative control for the test above, and the reason it is not
   * decorative: run the *same* migrations against the *same* seed with
   * `runMigrations`'s one safety measure removed — `migrate()` called
   * directly, so `foreign_keys` is never turned off at the connection level —
   * and watch the child rows go.
   *
   * A revert-and-forget experiment would have proved this once, on one
   * afternoon. Keeping it means the survival proof above can never quietly
   * become vacuous: if a future drizzle-kit stopped rebuilding, or emitted a
   * rebuild that did not drop the parent tables, that test would pass for the
   * wrong reason and this one would fail, pointing at the mechanism rather
   * than leaving the slice with a guard nobody has watched go red.
   */
  it('loses those same rows if the connection-level foreign_keys=OFF is removed', () => {
    const { raw, db } = seedAt0014();

    // Deliberately NOT `runMigrations` — that is the whole point. FKs are ON
    // from `seedAt0014`, and 0017's own in-file `PRAGMA foreign_keys=OFF` is a
    // no-op because `migrate()` wraps the file in a transaction.
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const count = (table: string): number =>
      (raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

    expect({
      rules: count('mod_rules'),
      categories: count('word_categories'),
      terms: count('word_terms'),
      allowlist: count('word_allowlist'),
      exemptions: count('mod_rule_exemptions'),
    }).toEqual({
      rules: 0,
      categories: 0,
      terms: 0,
      allowlist: 0,
      exemptions: 0,
    });

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

/**
 * ADR 0049 Amendment 1 D4, step 1: the machinery is invisible for the reason
 * we think.
 *
 * `allTables()` keeps only `PRAGMA table_list` rows with `type === 'table'`,
 * so every invariant above skips the FTS5 index — but only because SQLite
 * reports `archive_messages_fts` as `type === 'virtual'` and its four shadow
 * tables as `type === 'shadow'`. If a future SQLite reclassifies these as
 * `table`, this test fails loudly and ADR 0049 is revisited — rather than the
 * FTS table silently failing STRICT. No exemption is added here, and none is
 * wanted: an exemption would keep passing while the reason for it changed.
 */
describe('the FTS5 machinery is invisible to the invariants for the reason we think', () => {
  it('reports archive_messages_fts as virtual and its shadows as shadow in PRAGMA table_list', () => {
    const rows = t.raw.prepare(`PRAGMA table_list`).all() as {
      schema: string;
      name: string;
      type: string;
    }[];
    const byName = new Map(rows.filter((r) => r.schema === 'main').map((r) => [r.name, r.type]));
    expect(byName.get('archive_messages_fts')).toBe('virtual');
    for (const shadow of [
      'archive_messages_fts_data',
      'archive_messages_fts_idx',
      'archive_messages_fts_docsize',
      'archive_messages_fts_config',
    ]) {
      expect(byName.get(shadow)).toBe('shadow');
    }
    expect(allTables().map((r) => r.name)).not.toContain('archive_messages_fts');
  });
});
/**
 * ADR 0049 Amendment 1 D4, step 2: the index cannot outlive its content.
 *
 * The external-content triggers in `drizzle/0020_archive_fts.sql` are
 * hand-written SQL the invariants cannot see, so this proves they are attached
 * and the external-content contract holds: two guilds with colliding message
 * ids, one row each, both findable by a raw MATCH; then guild A's row deleted
 * through `archiveRepo` — `disableChannel`, whose cascade issues the real
 * DELETE on `archive_messages` the `…_ad` trigger listens for (the repo owns
 * no single-message hard delete; `recordDelete` is a soft mark) — and A's FTS
 * entry is gone while B's remains.
 */
describe('the FTS triggers keep the index from outliving its content', () => {
  it('deletes one guild’s FTS entry and keeps the colliding neighbour’s', () => {
    const scopeA = t.scopes.forGuild(parseGuildId('777777777777777777'));
    const scopeB = t.scopes.forGuild(parseGuildId('888888888888888888'));
    upsertGuild(scopeA, { name: 'fts-trigger-guild-a', now: 0 });
    upsertGuild(scopeB, { name: 'fts-trigger-guild-b', now: 0 });
    const channelA = '919191919191919191';
    const channelB = '929292929292929292';
    enableChannel(scopeA, { channelId: channelA, attachmentPolicy: 'none', now: 1 });
    enableChannel(scopeB, { channelId: channelB, attachmentPolicy: 'none', now: 1 });
    const messageId = '939393939393939393';
    for (const [scope, channelId] of [
      [scopeA, channelA],
      [scopeB, channelB],
    ] as const) {
      upsertMessage(scope, {
        messageId,
        channelId,
        authorId: undefined,
        content: 'quokkasnack trampoline',
        createdAt: 2,
        editedAt: undefined,
        attachments: [],
      });
    }

    const matchedGuilds = (): string[] =>
      (
        t.raw
          .prepare(
            `SELECT guild_id AS guildId FROM archive_messages_fts WHERE archive_messages_fts MATCH ?`,
          )
          .all('quokkasnack') as { guildId: string }[]
      ).map((r) => r.guildId);
    expect(matchedGuilds().sort()).toEqual([scopeA.guildId, scopeB.guildId].sort());

    disableChannel(scopeA, channelA);

    expect(matchedGuilds()).toEqual([scopeB.guildId]);
  });
});

/**
 * ADR 0049 Amendment 1 D4, step 3: the index carries its partition key.
 *
 * The replacement for the schema-level partition guarantee the invariants
 * cannot give the FTS table: `archive_messages_fts` has a stored (UNINDEXED)
 * `guild_id` column, so guild scope stays expressible in SQL, and a MATCH
 * query filtered by `guild_id` returns only that guild's rows — even with
 * colliding message ids and a token both guilds share.
 */
describe('the FTS index carries its partition key', () => {
  it('has a guild_id column', () => {
    expect(columns('archive_messages_fts').map((c) => c.name)).toContain('guild_id');
  });

  it('returns only the scoped guild’s rows for a MATCH filtered by guild_id', () => {
    const scopeA = t.scopes.forGuild(parseGuildId('747474747474747474'));
    const scopeB = t.scopes.forGuild(parseGuildId('848484848484848484'));
    upsertGuild(scopeA, { name: 'fts-partition-guild-a', now: 0 });
    upsertGuild(scopeB, { name: 'fts-partition-guild-b', now: 0 });
    const channelA = '717171717171717171';
    const channelB = '727272727272727272';
    enableChannel(scopeA, { channelId: channelA, attachmentPolicy: 'none', now: 1 });
    enableChannel(scopeB, { channelId: channelB, attachmentPolicy: 'none', now: 1 });
    const messageId = '737373737373737373';
    for (const [scope, channelId] of [
      [scopeA, channelA],
      [scopeB, channelB],
    ] as const) {
      upsertMessage(scope, {
        messageId,
        channelId,
        authorId: undefined,
        content: 'wombatpost strictly scoped',
        createdAt: 2,
        editedAt: undefined,
        attachments: [],
      });
    }

    const rows = t.raw
      .prepare(
        `SELECT guild_id AS guildId FROM archive_messages_fts WHERE archive_messages_fts MATCH ? AND guild_id = ?`,
      )
      .all('wombatpost', scopeA.guildId) as { guildId: string }[];
    expect(rows.map((r) => r.guildId)).toEqual([scopeA.guildId]);
  });
});

/**
 * Ruling PR-85: 0020 populates the index it creates.
 *
 * A database that already holds `archive_messages` rows when 0020 runs gets an
 * empty index without the trailing `rebuild` — and worse, the `_au`/`_ad`
 * triggers then issue FTS5 `delete` commands for rows that were never indexed,
 * which FTS5 rejects with `database disk image is malformed`. This migrates to
 * 0019, inserts one row, migrates through 0020, and proves the index is
 * populated and the purge/delete paths work.
 */
describe('0020 populates the index it creates (ruling PR-85)', () => {
  it('migrates a pre-existing archive row through 0020 with a populated, working index', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });

    runMigrations(raw, db, migrationsFolderUpTo(19));

    const GUILD_ID = '555555555555555555';
    const CHANNEL_ID = '666666666666666666';
    const MESSAGE_ID = '777777777777777777';
    raw
      .prepare(`INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?, 'g', 0, 0)`)
      .run(GUILD_ID);
    raw
      .prepare(
        `INSERT INTO archive_channels (guild_id, channel_id, attachment_policy, enabled_at, backfill_state) VALUES (?, ?, 'none', 0, 'pending')`,
      )
      .run(GUILD_ID, CHANNEL_ID);
    raw
      .prepare(
        `INSERT INTO archive_messages (guild_id, message_id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?, 1)`,
      )
      .run(GUILD_ID, MESSAGE_ID, CHANNEL_ID, '888888888888888888', 'rebuildmarker legacy content');

    runMigrations(raw, db, MIGRATIONS_FOLDER);

    const matched = raw
      .prepare(`SELECT COUNT(*) AS n FROM archive_messages_fts WHERE archive_messages_fts MATCH ?`)
      .get('rebuildmarker') as { n: number };
    expect(matched.n).toBe(1);

    expect(() =>
      raw
        .prepare(`UPDATE archive_messages SET content = NULL WHERE guild_id = ? AND message_id = ?`)
        .run(GUILD_ID, MESSAGE_ID),
    ).not.toThrow();
    expect(() =>
      raw
        .prepare(`DELETE FROM archive_messages WHERE guild_id = ? AND message_id = ?`)
        .run(GUILD_ID, MESSAGE_ID),
    ).not.toThrow();

    raw.close();
  });
});

describe('the OAuth tables are instance-level on purpose (ADR 0045 D3)', () => {
  const OAUTH_TABLES = [
    'oauth_clients',
    'oauth_pending_authorizations',
    'oauth_authorization_codes',
    'oauth_tokens',
  ];

  it.each(OAUTH_TABLES)('%s has no guild_id column', (table) => {
    // A guild_id here would be a second place where scope is decided, ahead
    // of and out of sight of the tool call that uses it (ADR 0045 PR-92).
    expect(columns(table).map((c) => c.name)).not.toContain('guild_id');
  });

  it('INSTANCE_LEVEL contains exactly the fifteen expected names', () => {
    // The tripwire. A sixteenth table cannot join the exemption without this
    // failing and a human reading ADR 0045 — or ADR 0044 §7 for
    // provider_eligibility, ADR 0075 for the provider chain tables, ADR 0080
    // for instance_settings, ADR 0081 for assistant_model_calls, or ADR 0120
    // for the search key tables, or ADR 0143 for assistant_key_cooldowns.
    expect([...INSTANCE_LEVEL].sort()).toEqual(
      [
        'assistant_provider_config',
        'assistant_provider_keys',
        'assistant_model_chain',
        'assistant_model_calls',
        'assistant_search_keys',
        'assistant_search_calls',
        'assistant_key_cooldowns',
        'instance_settings',
        'bootstrap_tokens',
        'dashboard_accounts',
        'provider_eligibility',
        ...OAUTH_TABLES,
      ].sort(),
    );
  });

  it.each(OAUTH_TABLES)('%s is still STRICT', (table) => {
    expect(allTables().find((r) => r.name === table)?.strict).toBe(1);
  });

  /**
   * Ruling PR-110: the three tests above pin exemptions, not DDL — a schema
   * regeneration could silently drop a NOT NULL, a UNIQUE index or a CHECK
   * and all three would still pass. Ruling PR-94 depends on
   * `issued_from_code_hash` being NOT NULL, so this pins the DDL itself,
   * read from the live database through the same helpers.
   */
  it('pins the OAuth DDL a regeneration could silently drop (ruling PR-110)', () => {
    expect(
      columns('oauth_tokens').find((c) => c.name === 'issued_from_code_hash')?.notnull,
      'oauth_tokens.issued_from_code_hash must be NOT NULL (ruling PR-94)',
    ).toBe(1);
    expect(
      uniqueIndexes('oauth_tokens').map((i) => i.name),
      'a UNIQUE index on oauth_tokens(token_hash) must exist',
    ).toContain('oauth_tokens_hash');
    expect(indexColumns('oauth_tokens_hash')).toEqual(['token_hash']);
    expect(ddl('oauth_tokens')).toContain('oauth_tokens_kind');
    expect(ddl('oauth_tokens')).toContain(`IN ('access','refresh')`);
    expect(ddl('oauth_clients')).toContain('oauth_clients_registration_source');
    expect(ddl('oauth_clients')).toContain(`IN ('dynamic','cli')`);
  });
});

/**
 * The migrator gates on the journal's `when`, not on a hash: an entry whose
 * `when` is equal to or smaller than the previous entry's is silently skipped
 * on a database that has already run the earlier migration. Read the shipped
 * journal and prove its timestamps are strictly increasing, so a new entry
 * that reuses or backdates a timestamp fails the build instead of looking
 * exactly like success.
 */
describe('the migration journal applies in order', () => {
  it('has strictly increasing when values', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { idx: number; when: number; tag: string }[] };
    expect(journal.entries.length).toBeGreaterThan(0);
    for (let i = 1; i < journal.entries.length; i += 1) {
      const prev = journal.entries[i - 1]!;
      const curr = journal.entries[i]!;
      expect(
        curr.when,
        `${curr.tag} (idx ${curr.idx}) has when ${curr.when}, not strictly greater than ` +
          `${prev.tag} (idx ${prev.idx}) with when ${prev.when}; the migrator would silently skip it.`,
      ).toBeGreaterThan(prev.when);
    }
  });
});
