import { beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId, type Chunk } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import { upsertGuild } from './guilds.js';
import { putResource } from './assistant.js';
import {
  computeDocId,
  deleteDocument,
  deleteForResource,
  deleteStaleDocuments,
  getChunk,
  getDocumentByUrl,
  listDocuments,
  neighbours,
  outline,
  replaceChunks,
  resourceFreshness,
  sanitiseFtsQuery,
  searchChunks,
  upsertDocument,
} from './resource-cache.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;

const chunk = (over: Partial<Chunk> = {}): Chunk => ({
  ordinal: 0,
  headingPath: 'doc.md',
  lineStart: 1,
  lineEnd: 1,
  text: 'hello world',
  ...over,
});

const seedResource = (scope: GuildScope, id: string, url: string, title = 'A resource') =>
  putResource(scope, {
    id,
    guildId: scope.guildId,
    title,
    url,
    kind: 'website',
    enabled: true,
    reviewedAt: new Date(0).toISOString(),
  });

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  upsertGuild(a, { name: 'guild-a', now: 0 });
  upsertGuild(b, { name: 'guild-b', now: 0 });
});

describe('computeDocId', () => {
  it('is stable for the same URL and differs across URLs', () => {
    expect(computeDocId('https://example.com/a')).toBe(computeDocId('https://example.com/a'));
    expect(computeDocId('https://example.com/a')).not.toBe(computeDocId('https://example.com/b'));
    expect(computeDocId('https://example.com/a')).toMatch(/^d_[0-9a-f]{16}$/);
  });
});

describe('upsertDocument / getDocumentByUrl / listDocuments', () => {
  it('round-trips a document and finds it by URL', () => {
    seedResource(a, 'res-1', 'https://example.com/guide');
    const docId = computeDocId('https://example.com/guide');
    upsertDocument(a, {
      resourceId: 'res-1',
      docId,
      url: 'https://example.com/guide',
      path: '/guide',
      title: 'Guide',
      etag: '"v1"',
      contentHash: 'hash-1',
      fetchedAt: 1000,
      bytes: 42,
      status: 'ok',
    });
    const doc = getDocumentByUrl(a, 'https://example.com/guide');
    expect(doc).toMatchObject({
      docId,
      resourceId: 'res-1',
      etag: '"v1"',
      contentHash: 'hash-1',
      fetchedAt: 1000,
      bytes: 42,
      status: 'ok',
    });
    expect(listDocuments(a)).toHaveLength(1);
    expect(listDocuments(a, 'res-1')).toHaveLength(1);
    expect(listDocuments(a, 'no-such-resource')).toHaveLength(0);
  });

  it('upsert replaces the prior row for the same (guild, docId)', () => {
    seedResource(a, 'res-1', 'https://example.com/guide');
    const docId = computeDocId('https://example.com/guide');
    upsertDocument(a, {
      resourceId: 'res-1',
      docId,
      url: 'https://example.com/guide',
      path: '/guide',
      title: 'Guide',
      contentHash: 'hash-1',
      fetchedAt: 1000,
      bytes: 10,
      status: 'ok',
    });
    upsertDocument(a, {
      resourceId: 'res-1',
      docId,
      url: 'https://example.com/guide',
      path: '/guide',
      title: 'Guide',
      contentHash: 'hash-2',
      fetchedAt: 2000,
      bytes: 20,
      status: 'ok',
    });
    expect(listDocuments(a)).toHaveLength(1);
    expect(getDocumentByUrl(a, 'https://example.com/guide')).toMatchObject({
      contentHash: 'hash-2',
      fetchedAt: 2000,
      bytes: 20,
    });
  });

  it('records a fetch error and the plain message', () => {
    seedResource(a, 'res-1', 'https://example.com/guide');
    const docId = computeDocId('https://example.com/guide');
    upsertDocument(a, {
      resourceId: 'res-1',
      docId,
      url: 'https://example.com/guide',
      path: '/guide',
      title: 'Guide',
      contentHash: '',
      fetchedAt: 1000,
      bytes: 0,
      status: 'error',
      error: 'timeout: the reviewed resource could not be retrieved safely.',
    });
    expect(getDocumentByUrl(a, 'https://example.com/guide')).toMatchObject({
      status: 'error',
      error: 'timeout: the reviewed resource could not be retrieved safely.',
    });
  });

  it('round-trips errorCode on an error document and omits it on ok documents', () => {
    seedResource(a, 'res-1', 'https://example.com/guide');
    const docId = computeDocId('https://example.com/guide');
    upsertDocument(a, {
      resourceId: 'res-1',
      docId,
      url: 'https://example.com/guide',
      path: '/guide',
      title: 'Guide',
      contentHash: '',
      fetchedAt: 1000,
      bytes: 0,
      status: 'error',
      error: 'x',
      errorCode: 'challenge',
    });
    expect(getDocumentByUrl(a, 'https://example.com/guide')).toMatchObject({
      status: 'error',
      errorCode: 'challenge',
    });

    seedResource(a, 'res-2', 'https://example.com/ok');
    const okId = computeDocId('https://example.com/ok');
    upsertDocument(a, {
      resourceId: 'res-2',
      docId: okId,
      url: 'https://example.com/ok',
      path: '/ok',
      title: 'Ok',
      contentHash: 'h',
      fetchedAt: 1000,
      bytes: 10,
      status: 'ok',
    });
    const okDoc = getDocumentByUrl(a, 'https://example.com/ok');
    expect(okDoc?.status).toBe('ok');
    expect(okDoc).not.toHaveProperty('errorCode');
  });
});

describe('replaceChunks / getChunk / neighbours / outline', () => {
  it('inserts chunks and reads them back in order', () => {
    seedResource(a, 'res-1', 'https://example.com/guide');
    const docId = computeDocId('https://example.com/guide');
    upsertDocument(a, {
      resourceId: 'res-1',
      docId,
      url: 'https://example.com/guide',
      path: '/guide',
      title: 'Guide',
      contentHash: 'hash-1',
      fetchedAt: 1000,
      bytes: 100,
      status: 'ok',
    });
    replaceChunks(a, docId, 'res-1', [
      chunk({ ordinal: 0, headingPath: 'Guide › Intro', text: 'intro text' }),
      chunk({ ordinal: 1, headingPath: 'Guide › Setup', text: 'setup text' }),
      chunk({ ordinal: 2, headingPath: 'Guide › Docker', text: 'docker text' }),
    ]);
    const out = outline(a, docId);
    expect(out.map((o) => o.headingPath)).toEqual([
      'Guide › Intro',
      'Guide › Setup',
      'Guide › Docker',
    ]);

    const middle = out[1]!;
    expect(getChunk(a, middle.chunkId)).toMatchObject({ text: 'setup text', ordinal: 1 });

    // n=1: the chunk itself plus one on each side.
    const around = neighbours(a, middle.chunkId, 1);
    expect(around.map((c) => c.ordinal)).toEqual([0, 1, 2]);

    // n=0: just the chunk itself.
    expect(neighbours(a, middle.chunkId, 0).map((c) => c.ordinal)).toEqual([1]);
  });

  it('replaceChunks deletes the prior set before inserting the new one (delete + insert in one write)', () => {
    seedResource(a, 'res-1', 'https://example.com/guide');
    const docId = computeDocId('https://example.com/guide');
    upsertDocument(a, {
      resourceId: 'res-1',
      docId,
      url: 'https://example.com/guide',
      path: '/guide',
      title: 'Guide',
      contentHash: 'h',
      fetchedAt: 1,
      bytes: 1,
      status: 'ok',
    });
    replaceChunks(a, docId, 'res-1', [chunk({ ordinal: 0, text: 'zzzoldneedle' })]);
    expect(searchChunks(a, { query: 'zzzoldneedle', limit: 10 })).toHaveLength(1);

    replaceChunks(a, docId, 'res-1', [chunk({ ordinal: 0, text: 'zzznewneedle' })]);
    expect(outline(a, docId)).toHaveLength(1);
    // The search index after replace finds only the new text.
    expect(searchChunks(a, { query: 'zzznewneedle', limit: 10 })).toHaveLength(1);
    expect(searchChunks(a, { query: 'zzzoldneedle', limit: 10 })).toHaveLength(0);
  });
});

describe('deleteForResource', () => {
  it('removes docs, chunks and FTS rows for that resource only', () => {
    seedResource(a, 'res-1', 'https://example.com/one');
    seedResource(a, 'res-2', 'https://example.com/two');
    const doc1 = computeDocId('https://example.com/one');
    const doc2 = computeDocId('https://example.com/two');
    upsertDocument(a, {
      resourceId: 'res-1',
      docId: doc1,
      url: 'https://example.com/one',
      path: '/one',
      title: 'One',
      contentHash: 'h1',
      fetchedAt: 1000,
      bytes: 10,
      status: 'ok',
    });
    upsertDocument(a, {
      resourceId: 'res-2',
      docId: doc2,
      url: 'https://example.com/two',
      path: '/two',
      title: 'Two',
      contentHash: 'h2',
      fetchedAt: 1000,
      bytes: 10,
      status: 'ok',
    });
    replaceChunks(a, doc1, 'res-1', [chunk({ text: 'zzzalphaneedle' })]);
    replaceChunks(a, doc2, 'res-2', [chunk({ text: 'zzzbetaneedle' })]);

    deleteForResource(a, 'res-1');

    expect(listDocuments(a, 'res-1')).toHaveLength(0);
    expect(outline(a, doc1)).toHaveLength(0);
    expect(searchChunks(a, { query: 'zzzalphaneedle', limit: 10 })).toHaveLength(0);
    // res-2 is untouched.
    expect(listDocuments(a, 'res-2')).toHaveLength(1);
    expect(searchChunks(a, { query: 'zzzbetaneedle', limit: 10 })).toHaveLength(1);
  });
});

describe('deleteStaleDocuments', () => {
  it('drops only the stale documents for a resource, with chunks, FTS rows and freshness', () => {
    seedResource(a, 'res-1', 'https://example.com/new');
    const oldDoc = computeDocId('https://example.com/old');
    const newDoc = computeDocId('https://example.com/new');
    upsertDocument(a, {
      resourceId: 'res-1',
      docId: oldDoc,
      url: 'https://example.com/old',
      path: '/old',
      title: 'Old',
      contentHash: 'h-old',
      fetchedAt: 1000,
      bytes: 10,
      status: 'ok',
    });
    upsertDocument(a, {
      resourceId: 'res-1',
      docId: newDoc,
      url: 'https://example.com/new',
      path: '/new',
      title: 'New',
      contentHash: 'h-new',
      fetchedAt: 2000,
      bytes: 10,
      status: 'ok',
    });
    replaceChunks(a, oldDoc, 'res-1', [chunk({ text: 'staleoldneedle unique old words here' })]);
    replaceChunks(a, newDoc, 'res-1', [chunk({ text: 'freshnewneedle unique new words here' })]);

    deleteStaleDocuments(a, 'res-1', newDoc);

    expect(listDocuments(a, 'res-1').map((d) => d.docId)).toEqual([newDoc]);
    expect(outline(a, oldDoc)).toHaveLength(0);
    expect(outline(a, newDoc)).toHaveLength(1);
    expect(searchChunks(a, { query: 'staleoldneedle', limit: 10 })).toHaveLength(0);
    expect(searchChunks(a, { query: 'freshnewneedle', limit: 10 })).toHaveLength(1);
    const freshness = resourceFreshness(a);
    expect(freshness).toHaveLength(1);
    expect(freshness[0]).toMatchObject({ resourceId: 'res-1' });
  });

  it('leaves other resources alone', () => {
    seedResource(a, 'res-1', 'https://example.com/new');
    seedResource(a, 'res-2', 'https://example.com/other');
    const oldDoc = computeDocId('https://example.com/old');
    const newDoc = computeDocId('https://example.com/new');
    const otherDoc = computeDocId('https://example.com/other');
    for (const [docId, resourceId, url] of [
      [oldDoc, 'res-1', 'https://example.com/old'],
      [newDoc, 'res-1', 'https://example.com/new'],
      [otherDoc, 'res-2', 'https://example.com/other'],
    ] as const) {
      upsertDocument(a, {
        resourceId,
        docId,
        url,
        path: '/x',
        title: 'X',
        contentHash: 'h',
        fetchedAt: 1,
        bytes: 1,
        status: 'ok',
      });
    }
    replaceChunks(a, otherDoc, 'res-2', [chunk({ text: 'otherneedle stays here' })]);

    deleteStaleDocuments(a, 'res-1', newDoc);

    expect(listDocuments(a, 'res-2').map((d) => d.docId)).toEqual([otherDoc]);
    expect(searchChunks(a, { query: 'otherneedle', limit: 10 })).toHaveLength(1);
  });
});

describe('deleteDocument (Task 17: one removed GitHub file)', () => {
  it('removes one document with its chunks and FTS rows, leaving siblings and other guilds alone', () => {
    seedResource(a, 'res-1', 'https://example.com/repo');
    const readme = computeDocId('https://raw.example/README.md');
    const old = computeDocId('https://raw.example/OLD.md');
    for (const [docId, url, needle] of [
      [readme, 'https://raw.example/README.md', 'zzzgonekeptneedle'],
      [old, 'https://raw.example/OLD.md', 'zzzremovedneedle'],
    ] as const) {
      upsertDocument(a, {
        resourceId: 'res-1',
        docId,
        url,
        path: url,
        title: url,
        contentHash: 'h',
        fetchedAt: 1000,
        bytes: 10,
        status: 'ok',
      });
      replaceChunks(a, docId, 'res-1', [chunk({ text: needle })]);
    }

    deleteDocument(a, old);

    expect(getDocumentByUrl(a, 'https://raw.example/OLD.md')).toBeUndefined();
    expect(outline(a, old)).toHaveLength(0);
    expect(searchChunks(a, { query: 'zzzremovedneedle', limit: 10 })).toHaveLength(0);
    expect(listDocuments(a, 'res-1').map((d) => d.docId)).toEqual([readme]);
    expect(searchChunks(a, { query: 'zzzgonekeptneedle', limit: 10 })).toHaveLength(1);
  });

  it('is a no-op for an unknown doc id, scoped to the calling guild', () => {
    seedResource(a, 'res-1', 'https://example.com/repo');
    seedResource(b, 'res-1', 'https://example.com/repo');
    const docId = computeDocId('https://example.com/repo');
    for (const scope of [a, b]) {
      upsertDocument(scope, {
        resourceId: 'res-1',
        docId,
        url: 'https://example.com/repo',
        path: '/repo',
        title: 'Repo',
        contentHash: 'h',
        fetchedAt: 1000,
        bytes: 10,
        status: 'ok',
      });
    }
    deleteDocument(a, 'd_doesnotexist0000');
    deleteDocument(a, docId);
    expect(getDocumentByUrl(a, 'https://example.com/repo')).toBeUndefined();
    expect(getDocumentByUrl(b, 'https://example.com/repo')).not.toBeUndefined();
  });
});

describe('resourceFreshness', () => {
  it('reports fetchedAt, chunk count, bytes and the last error per resource', () => {
    seedResource(a, 'res-1', 'https://example.com/guide');
    const docId = computeDocId('https://example.com/guide');
    upsertDocument(a, {
      resourceId: 'res-1',
      docId,
      url: 'https://example.com/guide',
      path: '/guide',
      title: 'Guide',
      contentHash: 'h1',
      fetchedAt: 5000,
      bytes: 321,
      status: 'ok',
    });
    replaceChunks(a, docId, 'res-1', [chunk({ ordinal: 0 }), chunk({ ordinal: 1 })]);

    const [row] = resourceFreshness(a);
    expect(row).toMatchObject({ resourceId: 'res-1', fetchedAt: 5000, chunks: 2, bytes: 321 });
    expect(row?.lastError).toBeUndefined();

    upsertDocument(a, {
      resourceId: 'res-1',
      docId,
      url: 'https://example.com/guide',
      path: '/guide',
      title: 'Guide',
      contentHash: 'h1',
      fetchedAt: 6000,
      bytes: 321,
      status: 'error',
      error: 'timeout: could not be retrieved safely.',
    });
    const [after] = resourceFreshness(a);
    expect(after?.lastError).toBe('timeout: could not be retrieved safely.');
  });
});

describe('sanitiseFtsQuery', () => {
  it('quotes every word token and joins them with OR', () => {
    expect(sanitiseFtsQuery('docker setup')).toBe('"docker" OR "setup"');
  });

  it('neutralises FTS5 syntax characters instead of passing them through', () => {
    // Every character FTS5 would otherwise parse as query syntax — quotes,
    // NEAR, parentheses, `-`, `*` — is dropped by the word-token extraction;
    // only the word-shaped pieces survive, each safely quoted.
    expect(sanitiseFtsQuery('a" OR 1=1 --')).toBe('"a" OR "OR" OR "1" OR "1"');
    expect(sanitiseFtsQuery('"unbalanced')).toBe('"unbalanced"');
    expect(sanitiseFtsQuery('NEAR(foo, bar)')).toBe('"NEAR" OR "foo" OR "bar"');
    expect(sanitiseFtsQuery('foo* -bar')).toBe('"foo" OR "bar"');
    expect(sanitiseFtsQuery('***')).toBe('');
  });
});

describe('searchChunks', () => {
  it("never returns another guild's chunks, even for identical text", () => {
    seedResource(a, 'res-1', 'https://example.com/guide');
    seedResource(b, 'res-1', 'https://example.com/guide');
    const docA = computeDocId('https://example.com/guide');
    const docB = computeDocId('https://example.com/guide');
    upsertDocument(a, {
      resourceId: 'res-1',
      docId: docA,
      url: 'https://example.com/guide',
      path: '/guide',
      title: 'Guide',
      contentHash: 'h',
      fetchedAt: 1,
      bytes: 1,
      status: 'ok',
    });
    upsertDocument(b, {
      resourceId: 'res-1',
      docId: docB,
      url: 'https://example.com/guide',
      path: '/guide',
      title: 'Guide',
      contentHash: 'h',
      fetchedAt: 1,
      bytes: 1,
      status: 'ok',
    });
    replaceChunks(a, docA, 'res-1', [chunk({ text: 'the shared docker setup guide' })]);
    replaceChunks(b, docB, 'res-1', [chunk({ text: 'the shared docker setup guide' })]);

    const hitsA = searchChunks(a, { query: 'docker', limit: 10 });
    expect(hitsA).toHaveLength(1);
    expect(hitsA[0]?.resourceId).toBe('res-1');

    const hitsB = searchChunks(b, { query: 'docker', limit: 10 });
    expect(hitsB).toHaveLength(1);

    // Neither result set leaks the other guild's row identity.
    const [rowA] = t.raw
      .prepare('SELECT guild_id FROM resource_chunks WHERE chunk_id = ?')
      .all(hitsA[0]!.chunkId) as { guild_id: string }[];
    expect(rowA?.guild_id).toBe(GUILD_A);
  });

  it('ranks the chunk containing both query words first', () => {
    seedResource(a, 'res-1', 'https://example.com/guide');
    const docId = computeDocId('https://example.com/guide');
    upsertDocument(a, {
      resourceId: 'res-1',
      docId,
      url: 'https://example.com/guide',
      path: '/guide',
      title: 'Guide',
      contentHash: 'h',
      fetchedAt: 1,
      bytes: 1,
      status: 'ok',
    });
    replaceChunks(a, docId, 'res-1', [
      chunk({ ordinal: 0, headingPath: 'only docker', text: 'docker docker docker' }),
      chunk({ ordinal: 1, headingPath: 'both words', text: 'docker compose setup guide' }),
    ]);
    const hits = searchChunks(a, { query: 'docker compose', limit: 10 });
    expect(hits[0]?.headingPath).toBe('both words');
  });

  it('filters by resourceIds when given, and returns empty for an empty list', () => {
    seedResource(a, 'res-1', 'https://example.com/one');
    seedResource(a, 'res-2', 'https://example.com/two');
    const doc1 = computeDocId('https://example.com/one');
    const doc2 = computeDocId('https://example.com/two');
    for (const [docId, resourceId, url] of [
      [doc1, 'res-1', 'https://example.com/one'],
      [doc2, 'res-2', 'https://example.com/two'],
    ] as const) {
      upsertDocument(a, {
        resourceId,
        docId,
        url,
        path: '/x',
        title: 'X',
        contentHash: 'h',
        fetchedAt: 1,
        bytes: 1,
        status: 'ok',
      });
    }
    replaceChunks(a, doc1, 'res-1', [chunk({ text: 'widget alpha' })]);
    replaceChunks(a, doc2, 'res-2', [chunk({ text: 'widget beta' })]);

    expect(searchChunks(a, { query: 'widget', resourceIds: ['res-1'], limit: 10 })).toHaveLength(1);
    expect(searchChunks(a, { query: 'widget', limit: 10 })).toHaveLength(2);
    expect(searchChunks(a, { query: 'widget', resourceIds: [], limit: 10 })).toHaveLength(0);
  });

  it('caps a snippet at 300 characters including the ellipsis', () => {
    seedResource(a, 'res-1', 'https://example.com/guide');
    const docId = computeDocId('https://example.com/guide');
    upsertDocument(a, {
      resourceId: 'res-1',
      docId,
      url: 'https://example.com/guide',
      path: '/guide',
      title: 'Guide',
      contentHash: 'h',
      fetchedAt: 1,
      bytes: 1,
      status: 'ok',
    });
    replaceChunks(a, docId, 'res-1', [
      chunk({ text: `needle ${'supercalifragilisticexpialidocious '.repeat(60)}` }),
    ]);
    const [hit] = searchChunks(a, { query: 'needle', limit: 10 });
    expect(hit?.snippet.length).toBeLessThanOrEqual(300);
  });

  it('returns no results and raises no error for a query with no word characters', () => {
    seedResource(a, 'res-1', 'https://example.com/guide');
    expect(searchChunks(a, { query: '*** ---', limit: 10 })).toEqual([]);
  });
});
