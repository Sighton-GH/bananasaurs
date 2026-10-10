import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Chunk } from '@bananasaurs/core';
import { resourceChunks, resourceDocuments } from '../schema.js';
import type { Db } from '../db.js';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';

/**
 * The persistent resource cache (ADR 0073): fetched documents, their
 * chunker output, and a hand-written FTS5 index over the chunk text
 * (the hand-written resource_chunks_fts migration, ADR 0049 pattern).
 *
 * Guild isolation for the FTS table works differently than for an ordinary
 * table: `resource_chunks_fts` carries no `guild_id` column of its own (the
 * plan's column list is `(text, heading_path)` only), so `searchChunks`
 * filters by joining back to `resource_chunks`, which does — a chunk row a
 * caller's guild scope was never given cannot be named by this module at
 * all, the same guarantee every other repo gets from `scope.only()`.
 */

/** `d_<sha256(url) first 16 hex>` — stable, so re-fetching the same URL always lands on the same document row. */
export const computeDocId = (url: string): string =>
  `d_${createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 16)}`;

/** `c_<docId>_<ordinal>` — deterministic from the chunker's own ordinal, so `replaceChunks` never has to invent ids. */
const chunkIdFor = (docId: string, ordinal: number): string => `c_${docId}_${String(ordinal)}`;

export interface StoredDocument {
  readonly docId: string;
  readonly resourceId: string;
  readonly url: string;
  readonly path: string;
  readonly title: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly contentHash: string;
  readonly fetchedAt: number;
  readonly bytes: number;
  readonly status: 'ok' | 'error';
  readonly error?: string;
  readonly errorCode?: string;
  readonly blobSha?: string;
}

export interface StoredChunk {
  readonly chunkId: string;
  readonly docId: string;
  readonly resourceId: string;
  readonly ordinal: number;
  readonly headingPath: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly text: string;
}

export interface UpsertDocumentInput {
  readonly resourceId: string;
  readonly docId: string;
  readonly url: string;
  readonly path: string;
  readonly title: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly contentHash: string;
  readonly fetchedAt: number;
  readonly bytes: number;
  readonly status: 'ok' | 'error';
  readonly error?: string;
  readonly errorCode?: string;
  readonly blobSha?: string;
}

const toDocument = (r: typeof resourceDocuments.$inferSelect): StoredDocument => ({
  docId: r.docId,
  resourceId: r.resourceId,
  url: r.url,
  path: r.path,
  title: r.title,
  ...(r.etag === null ? {} : { etag: r.etag }),
  ...(r.lastModified === null ? {} : { lastModified: r.lastModified }),
  contentHash: r.contentHash,
  fetchedAt: r.fetchedAt,
  bytes: r.bytes,
  status: r.status as 'ok' | 'error',
  ...(r.error === null ? {} : { error: r.error }),
  ...(r.errorCode === null ? {} : { errorCode: r.errorCode }),
  ...(r.blobSha === null ? {} : { blobSha: r.blobSha }),
});

const toChunk = (r: typeof resourceChunks.$inferSelect): StoredChunk => ({
  chunkId: r.chunkId,
  docId: r.docId,
  resourceId: r.resourceId,
  ordinal: r.ordinal,
  headingPath: r.headingPath,
  lineStart: r.lineStart,
  lineEnd: r.lineEnd,
  text: r.text,
});

/** Insert-or-replace by `(guildId, docId)`. One document per fetched URL (or per note). */
export const upsertDocument = (scope: GuildScope, d: UpsertDocumentInput): void =>
  write(scope, ({ db }) => {
    const values = {
      guildId: scope.guildId,
      docId: d.docId,
      resourceId: d.resourceId,
      url: d.url,
      path: d.path,
      title: d.title,
      etag: d.etag ?? null,
      lastModified: d.lastModified ?? null,
      contentHash: d.contentHash,
      fetchedAt: d.fetchedAt,
      bytes: d.bytes,
      status: d.status,
      error: d.error ?? null,
      // Null when absent or when the fetch succeeded — an ok document never
      // carries a stale code from an earlier failure.
      errorCode: d.status === 'ok' ? null : (d.errorCode ?? null),
      blobSha: d.blobSha ?? null,
    };
    db.insert(resourceDocuments)
      .values(values)
      .onConflictDoUpdate({
        target: [resourceDocuments.guildId, resourceDocuments.docId],
        set: values,
      })
      .run();
  });

/**
 * Deletes every existing chunk for `docId` and inserts `chunks`, in one
 * write — so a search between the two calls a caller might otherwise make
 * never sees a half-replaced document (the interface's own "delete + insert
 * in one write" note).
 */
export const replaceChunks = (
  scope: GuildScope,
  docId: string,
  resourceId: string,
  chunks: readonly Chunk[],
): void =>
  write(scope, ({ db }) => {
    db.delete(resourceChunks)
      .where(scope.only(resourceChunks, eq(resourceChunks.docId, docId)))
      .run();
    if (chunks.length === 0) return;
    db.insert(resourceChunks)
      .values(
        chunks.map((c) => ({
          guildId: scope.guildId,
          chunkId: chunkIdFor(docId, c.ordinal),
          docId,
          resourceId,
          ordinal: c.ordinal,
          headingPath: c.headingPath,
          lineStart: c.lineStart,
          lineEnd: c.lineEnd,
          text: c.text,
        })),
      )
      .run();
  });

export const getDocumentByUrl = (scope: GuildScope, url: string): StoredDocument | undefined =>
  read(scope, (db) => {
    const docId = computeDocId(url);
    const row = db
      .select()
      .from(resourceDocuments)
      .where(scope.only(resourceDocuments, eq(resourceDocuments.docId, docId)))
      .get();
    return row === undefined ? undefined : toDocument(row);
  });

export const listDocuments = (scope: GuildScope, resourceId?: string): readonly StoredDocument[] =>
  read(scope, (db) =>
    db
      .select()
      .from(resourceDocuments)
      .where(
        scope.only(
          resourceDocuments,
          resourceId === undefined ? undefined : eq(resourceDocuments.resourceId, resourceId),
        ),
      )
      .orderBy(asc(resourceDocuments.title))
      .all()
      .map(toDocument),
  );

export const getChunk = (scope: GuildScope, chunkId: string): StoredChunk | undefined =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(resourceChunks)
      .where(scope.only(resourceChunks, eq(resourceChunks.chunkId, chunkId)))
      .get();
    return row === undefined ? undefined : toChunk(row);
  });

/** The chunk itself plus up to `n` on each side of it, by ordinal, within the same document. */
export const neighbours = (
  scope: GuildScope,
  chunkId: string,
  n: 0 | 1 | 2,
): readonly StoredChunk[] =>
  read(scope, (db) => {
    const center = db
      .select()
      .from(resourceChunks)
      .where(scope.only(resourceChunks, eq(resourceChunks.chunkId, chunkId)))
      .get();
    if (center === undefined) return [];
    return db
      .select()
      .from(resourceChunks)
      .where(
        and(
          scope.only(resourceChunks, eq(resourceChunks.docId, center.docId)),
          sql`${resourceChunks.ordinal} BETWEEN ${center.ordinal - n} AND ${center.ordinal + n}`,
        ),
      )
      .orderBy(asc(resourceChunks.ordinal))
      .all()
      .map(toChunk);
  });

/** A document's chunks as a table of contents, ordered by position in the document. */
export const outline = (
  scope: GuildScope,
  docId: string,
): readonly {
  readonly chunkId: string;
  readonly headingPath: string;
  readonly lineStart: number;
}[] =>
  read(scope, (db) =>
    db
      .select({
        chunkId: resourceChunks.chunkId,
        headingPath: resourceChunks.headingPath,
        lineStart: resourceChunks.lineStart,
      })
      .from(resourceChunks)
      .where(scope.only(resourceChunks, eq(resourceChunks.docId, docId)))
      .orderBy(asc(resourceChunks.ordinal))
      .all(),
  );

export interface ResourceFreshness {
  readonly resourceId: string;
  readonly fetchedAt?: number;
  readonly chunks: number;
  readonly bytes: number;
  readonly lastError?: string;
  readonly errorCode?: string;
}

/** One row per cached document — a resource with no document yet (never refreshed, or a kind that is never fetched) has none here. */
export const resourceFreshness = (scope: GuildScope): readonly ResourceFreshness[] =>
  read(scope, (db) =>
    db
      .select({
        resourceId: resourceDocuments.resourceId,
        fetchedAt: resourceDocuments.fetchedAt,
        bytes: resourceDocuments.bytes,
        error: resourceDocuments.error,
        errorCode: resourceDocuments.errorCode,
        chunks: sql<number>`(
          SELECT COUNT(*) FROM resource_chunks rc
          WHERE rc.guild_id = ${resourceDocuments.guildId} AND rc.doc_id = ${resourceDocuments.docId}
        )`,
      })
      .from(resourceDocuments)
      .where(scope.only(resourceDocuments))
      .all()
      .map((r) => ({
        resourceId: r.resourceId,
        fetchedAt: r.fetchedAt,
        chunks: Number(r.chunks),
        bytes: r.bytes,
        ...(r.error === null ? {} : { lastError: r.error }),
        ...(r.errorCode === null ? {} : { errorCode: r.errorCode }),
      })),
  );

/** Removes every cached document and chunk for a resource (its FTS rows go with them, via the sync triggers). */
export const deleteForResource = (scope: GuildScope, resourceId: string): void =>
  write(scope, ({ db }) => {
    const docIds = db
      .select({ docId: resourceDocuments.docId })
      .from(resourceDocuments)
      .where(scope.only(resourceDocuments, eq(resourceDocuments.resourceId, resourceId)))
      .all()
      .map((r) => r.docId);
    if (docIds.length > 0) {
      db.delete(resourceChunks)
        .where(scope.only(resourceChunks, inArray(resourceChunks.docId, docIds)))
        .run();
    }
    db.delete(resourceDocuments)
      .where(scope.only(resourceDocuments, eq(resourceDocuments.resourceId, resourceId)))
      .run();
  });

/**
 * Deletes every cached document for `resourceId` except `keepDocId`, with
 * their chunks (FTS rows go with them, via the sync triggers).
 *
 * A resource's URL is editable, but its document id is a hash of the URL —
 * so after an edit the refresh writes a new document row and the old one
 * would stay searchable under the same resource id, leaving
 * `resourceFreshness` with several unordered rows per resource. The refresh
 * calls this after every upsert with the current URL's doc id, so exactly
 * the current document survives.
 */
export const deleteStaleDocuments = (
  scope: GuildScope,
  resourceId: string,
  keepDocId: string,
): void =>
  write(scope, ({ db }) => {
    const staleIds = db
      .select({ docId: resourceDocuments.docId })
      .from(resourceDocuments)
      .where(
        and(
          scope.only(resourceDocuments, eq(resourceDocuments.resourceId, resourceId)),
          sql`${resourceDocuments.docId} != ${keepDocId}`,
        ),
      )
      .all()
      .map((r) => r.docId);
    if (staleIds.length > 0) {
      db.delete(resourceChunks)
        .where(scope.only(resourceChunks, inArray(resourceChunks.docId, staleIds)))
        .run();
    }
    db.delete(resourceDocuments)
      .where(
        and(
          scope.only(resourceDocuments, eq(resourceDocuments.resourceId, resourceId)),
          sql`${resourceDocuments.docId} != ${keepDocId}`,
        ),
      )
      .run();
  });

/**
 * Deletes one cached document with its chunks (FTS rows go with them, via
 * the sync triggers). Task 17: a `github-repo` caches one document per
 * selected file, so a file the repo no longer selects is deleted on its own
 * — `deleteStaleDocuments` (keep exactly one) and `deleteForResource` (drop
 * them all) are both the wrong shape here. A no-op for an unknown doc id.
 */
export const deleteDocument = (scope: GuildScope, docId: string): void =>
  write(scope, ({ db }) => {
    db.delete(resourceChunks)
      .where(scope.only(resourceChunks, eq(resourceChunks.docId, docId)))
      .run();
    db.delete(resourceDocuments)
      .where(scope.only(resourceDocuments, eq(resourceDocuments.docId, docId)))
      .run();
  });

/**
 * The raw better-sqlite3 handle behind a Drizzle `Db` (mirrors
 * `archive-search.ts`'s `rawOf`: `bm25()`/`snippet()` are not expressible
 * through the query builder).
 */
const rawOf = (db: Db): Database.Database =>
  (db as unknown as { readonly $client: Database.Database }).$client;

/**
 * Every word-ish run in `raw`, `\p{L}\p{N}_`-matched. Anything else —
 * quotes, `*`, `-`, parentheses, `NEAR`'s own syntax — is dropped rather
 * than passed through, so FTS5 query syntax never reaches `MATCH` from an
 * untrusted caller (CLAUDE.md rule 3: model output is untrusted input, same
 * as a form submission).
 */
const WORD_RE = /[\p{L}\p{N}_]+/gu;

/** Words too common to narrow a search; dropped from queries unless nothing else is left. */
const FTS_STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'could',
  'do',
  'does',
  'for',
  'from',
  'get',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'please',
  'should',
  'so',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'this',
  'to',
  'want',
  'was',
  'we',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

/** Quoted tokens joined by `OR` — every token an FTS5 string literal, never operator syntax. Empty for a query with no word characters. */
export const sanitiseFtsQuery = (raw: string): string => {
  const words = raw.match(WORD_RE) ?? [];
  const kept = words.filter((w) => !FTS_STOPWORDS.has(w.toLowerCase()));
  const narrowed = kept.length > 0 ? kept : words;
  const seen = new Set<string>();
  const deduped = narrowed.filter((w) => {
    const key = w.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return deduped.map((w) => `"${w}"`).join(' OR ');
};

const SNIPPET_MAX_CHARS = 300;

export interface SearchChunksInput {
  readonly query: string;
  readonly resourceIds?: readonly string[];
  readonly limit: number;
}

export interface SearchChunkHit {
  readonly chunkId: string;
  readonly docId: string;
  readonly resourceId: string;
  readonly headingPath: string;
  readonly snippet: string;
  readonly score: number;
}

interface SearchRow {
  readonly chunkId: string;
  readonly docId: string;
  readonly resourceId: string;
  readonly headingPath: string;
  readonly snippet: string;
  readonly score: number;
}

/**
 * Full-text search over this guild's cached chunks. Never returns another
 * guild's rows, even when the other guild's chunk text is identical
 * (guild-scoped via the join to `resource_chunks`, not via caller
 * discipline — hard rule 2). Ranked by `bm25()` (lower is a better match, as
 * SQLite returns it — the same convention `archive-search.ts` documents),
 * snippets capped at 300 characters after FTS5's own 40-token `snippet()`.
 */
export const searchChunks = (scope: GuildScope, q: SearchChunksInput): readonly SearchChunkHit[] =>
  read(scope, (db) => {
    const match = sanitiseFtsQuery(q.query);
    if (match === '') return [];
    if (q.resourceIds !== undefined && q.resourceIds.length === 0) return [];

    const where = ['resource_chunks_fts MATCH ?', 'c.guild_id = ?'];
    const params: unknown[] = [match, scope.guildId];
    if (q.resourceIds !== undefined) {
      where.push(`c.resource_id IN (${q.resourceIds.map(() => '?').join(', ')})`);
      params.push(...q.resourceIds);
    }
    const querySql =
      'SELECT c.chunk_id AS chunkId, c.doc_id AS docId, c.resource_id AS resourceId, ' +
      'c.heading_path AS headingPath, ' +
      "snippet(resource_chunks_fts, 0, '', '', ' … ', 40) AS snippet, " +
      'bm25(resource_chunks_fts) AS score ' +
      'FROM resource_chunks_fts ' +
      'JOIN resource_chunks c ON c.rowid = resource_chunks_fts.rowid ' +
      `WHERE ${where.join(' AND ')} ` +
      'ORDER BY bm25(resource_chunks_fts) LIMIT ?';

    const rows = rawOf(db)
      .prepare<unknown[], SearchRow>(querySql)
      .all(...params, q.limit);
    return rows.map((r) => ({
      ...r,
      snippet:
        r.snippet.length > SNIPPET_MAX_CHARS
          ? `${r.snippet.slice(0, SNIPPET_MAX_CHARS - 1)}…`
          : r.snippet,
    }));
  });
