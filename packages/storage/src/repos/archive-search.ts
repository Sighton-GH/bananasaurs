import type Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import type { Db } from '../db.js';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { SEARCH_LIMIT_MAX } from './archive.js';

export { SEARCH_LIMIT_MAX };

/**
 * Full-text search over the archive (ADR 0049, Slice M2 Task 3).
 *
 * This module holds the project's only raw SQL against the FTS5 index
 * (`archive_messages_fts`, created by `drizzle/0020_archive_fts.sql`). The
 * guild predicate and the visibility filter are both part of the `WHERE`, so
 * an invisible channel contributes to neither the hit list nor the count
 * (ADR 0046 D6, §7.3). Never interpolate the query string: every value,
 * including the `MATCH` query itself, is a bound parameter.
 */

/** The channels a principal may be shown. Always passed; never defaulted. For the MCP operator: every archive-enabled channel in the guild. */
export interface VisibilitySet {
  readonly channelIds: readonly string[];
}

export interface SearchHit {
  readonly messageId: string;
  readonly channelId: string;
  readonly authorId: string | undefined;
  readonly createdAt: number;
  /** FTS5 `snippet()` over `content`, with the match marked by the delimiters below. */
  readonly excerpt: string;
  /** BM25; lower is a better match, as SQLite returns it. */
  readonly rank: number;
}

export interface SearchResult {
  readonly hits: readonly SearchHit[];
  /** Total matching rows **within the visibility set** — never the unfiltered count (§7.3). */
  readonly total: number;
}

export const SEARCH_SNIPPET_OPEN = '[';
export const SEARCH_SNIPPET_CLOSE = ']';
/**
 * The largest visibility set a search binds: one `?` placeholder per channel,
 * well under SQLite's 32766-variable limit. Above it the function throws
 * rather than truncating — a truncated visibility set is a wrong answer (rows
 * silently excluded), not a small one.
 */
export const SEARCH_MAX_CHANNELS = 1000;

const SEARCH_LIMIT_DEFAULT = 20;
const SEARCH_SNIPPET_ELLIPSIS = '…';
const SEARCH_SNIPPET_TOKENS = 12;

/**
 * The FTS5 query-syntax family: the signatures SQLite produces for a malformed
 * `MATCH` query, read off the installed `better-sqlite3` rather than assumed —
 * `"unbalanced` raises `unterminated string`, a bare `column:` term raises
 * `no such column: column`, a bare `AND` or unbalanced paren raises
 * `fts5: syntax error near …`, and a bare `*` raises `unknown special query`.
 * Anything outside this family (`no such table`, `too many SQL variables`,
 * `database disk image is malformed`) is a fault, not a typo, and is rethrown.
 */
const FTS_QUERY_SYNTAX_SIGNATURES = [
  'fts5: syntax error',
  'unterminated string',
  'unknown special query',
  'no such column',
] as const;

const isFtsQuerySyntaxError = (err: unknown): boolean =>
  err instanceof Error &&
  FTS_QUERY_SYNTAX_SIGNATURES.some((signature) => err.message.includes(signature));

/**
 * The raw better-sqlite3 handle behind a Drizzle `Db`.
 *
 * drizzle attaches it at construction (`better-sqlite3/driver.js`: `db.$client
 * = client`) and types it on `drizzle()`'s return (`better-sqlite3/driver.d.ts`:
 * `$client: Database`); the repo's `Db` alias is the bare class and does not
 * name the member. This recovers exactly that declared type — never `any` —
 * so a drizzle upgrade that stops attaching the handle fails here loudly
 * instead of crashing somewhere downstream.
 */
const rawOf = (db: Db): Database.Database =>
  (db as unknown as { readonly $client: Database.Database }).$client;

interface SearchRow {
  readonly messageId: string;
  readonly channelId: string;
  readonly authorId: string | null;
  readonly createdAt: number;
  readonly excerpt: string;
  readonly rank: number;
}

export const searchMessages = (
  scope: GuildScope,
  input: {
    readonly query: string;
    readonly visibility: VisibilitySet;
    readonly channelIds?: readonly string[];
    readonly authorId?: string;
    readonly before?: number;
    readonly after?: number;
    readonly limit?: number;
  },
): SearchResult =>
  read(scope, (db) => {
    // Narrow within the visibility set; never widen. An empty set — no visible
    // channels, or a narrowing outside them — returns empty without running a
    // query: `IN ()` is a syntax error, and "nothing visible" is a real state.
    // De-duplicated: one placeholder per channel, so a repeated entry cannot
    // inflate the `IN` list toward the variable limit.
    const channels = [
      ...new Set(
        input.channelIds === undefined
          ? input.visibility.channelIds
          : input.channelIds.filter((channelId) => input.visibility.channelIds.includes(channelId)),
      ),
    ];
    if (channels.length > SEARCH_MAX_CHANNELS) {
      throw new Error(
        `search visibility set of ${String(channels.length)} channels exceeds the ` +
          `${String(SEARCH_MAX_CHANNELS)}-channel limit; narrow the search with --channel`,
      );
    }
    if (channels.length === 0) return { hits: [], total: 0 };

    const limit =
      input.limit === undefined || !Number.isFinite(input.limit)
        ? SEARCH_LIMIT_DEFAULT
        : Math.min(Math.max(Math.floor(input.limit), 1), SEARCH_LIMIT_MAX);

    // One WHERE shared by the hits query and the count query. `MATCH` names
    // the table, never the alias: `f MATCH ?` is `no such column: f` (ADR 0049
    // Amendment 1 D5).
    const where = [
      'archive_messages_fts MATCH ?',
      'f.guild_id = ?',
      `f.channel_id IN (${channels.map(() => '?').join(', ')})`,
    ];
    const params: unknown[] = [input.query, scope.guildId, ...channels];
    if (input.authorId !== undefined) {
      where.push('m.author_id = ?');
      params.push(input.authorId);
    }
    if (input.before !== undefined) {
      where.push('m.created_at < ?');
      params.push(input.before);
    }
    if (input.after !== undefined) {
      where.push('m.created_at > ?');
      params.push(input.after);
    }
    const fromWhere =
      'FROM archive_messages_fts f ' +
      'JOIN archive_messages m ON m.rowid = f.rowid ' +
      `WHERE ${where.join(' AND ')}`;

    const hitsSql =
      'SELECT m.message_id AS messageId, m.channel_id AS channelId, m.author_id AS authorId, ' +
      'm.created_at AS createdAt, ' +
      `snippet(archive_messages_fts, 0, '${SEARCH_SNIPPET_OPEN}', '${SEARCH_SNIPPET_CLOSE}', ` +
      `'${SEARCH_SNIPPET_ELLIPSIS}', ${SEARCH_SNIPPET_TOKENS}) AS excerpt, ` +
      `bm25(archive_messages_fts) AS rank ${fromWhere} ORDER BY rank LIMIT ?`;
    const countSql = `SELECT COUNT(*) AS n ${fromWhere}`;

    try {
      const raw = rawOf(db);
      const rows = raw.prepare<unknown[], SearchRow>(hitsSql).all(...params, limit);
      const counted = raw.prepare<unknown[], { readonly n: number }>(countSql).get(...params);
      return {
        hits: rows.map((row): SearchHit => ({
          messageId: row.messageId,
          channelId: row.channelId,
          authorId: row.authorId ?? undefined,
          createdAt: row.createdAt,
          excerpt: row.excerpt,
          rank: row.rank,
        })),
        total: counted?.n ?? 0,
      };
    } catch (err) {
      // An operator's typo is a usage answer, not a fault: a malformed FTS5
      // query (e.g. `MATCH '"unbalanced'` raising `SqliteError: unterminated
      // string`) returns empty rather than throwing out of the function.
      // Everything else — a missing table, `too many SQL variables`,
      // SQLITE_CORRUPT — is rethrown: the caller is an operator command that
      // will surface it, and answering "no matches" to a broken index is the
      // failure mode ruling PR-85 fixed.
      if (isFtsQuerySyntaxError(err)) return { hits: [], total: 0 };
      throw err;
    }
  });

/**
 * The FTS row count beside the `archive_messages` row count, both for this
 * guild — what `doctor` compares to say whether the index is stale (a restored
 * database's index is rebuilt from the restored rows, so the two disagree
 * until `archive reindex` runs).
 */
export interface IndexHealth {
  readonly indexed: number;
  readonly rows: number;
}

export const indexHealth = (scope: GuildScope): IndexHealth =>
  read(scope, (db) => {
    const raw = rawOf(db);
    const indexed = raw
      .prepare<unknown[], { readonly n: number }>(
        'SELECT COUNT(*) AS n FROM archive_messages_fts WHERE guild_id = ?',
      )
      .get(scope.guildId)?.n;
    const rows = raw
      .prepare<unknown[], { readonly n: number }>(
        'SELECT COUNT(*) AS n FROM archive_messages WHERE guild_id = ?',
      )
      .get(scope.guildId)?.n;
    return { indexed: indexed ?? 0, rows: rows ?? 0 };
  });

/**
 * `INSERT INTO archive_messages_fts(archive_messages_fts) VALUES('rebuild')`, then the index row count.
 * The rebuild is table-global — FTS5 has no per-guild rebuild — while the count returned is this
 * guild's. That seam is deliberate and is why the command is operator-only and its audit row names
 * the guild that asked: a reindex on a single-tenant deployment rebuilds everything, and saying
 * otherwise would be the lie ADR 0004 exists to prevent.
 */
export const rebuildSearchIndex = (scope: GuildScope): number =>
  write(scope, ({ db }) => {
    // Through the transaction's drizzle handle, not the raw client: a
    // transaction object carries no `$client`, and this keeps the rebuild in
    // the transaction `write()` opened (and refused in readonly mode).
    db.run(sql`INSERT INTO archive_messages_fts(archive_messages_fts) VALUES('rebuild')`);
    const counted = db.get<{ readonly n: number }>(
      sql`SELECT COUNT(*) AS n FROM archive_messages_fts WHERE guild_id = ${scope.guildId}`,
    );
    return counted?.n ?? 0;
  });

// Re-exported here so the purge test can assert the tombstone promise
// without a second import; the reader itself lives in `archive.ts` (ADR 0049
// Amendment 1 D7).
export { findMessage } from './archive.js';
export type { ArchiveMessage } from './archive.js';
