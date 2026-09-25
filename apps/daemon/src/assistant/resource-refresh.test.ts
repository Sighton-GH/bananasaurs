import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGuildId, type ClubResource } from '@bananasaurs/core';
import type { GuildScope } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import {
  computeDocId,
  refreshAll,
  refreshResource,
  type ResourceRefreshDeps,
  type ResourceRefreshFetcher,
  type ResourceRefreshRepo,
  type UpsertDocumentInput,
} from './resource-refresh.js';

const GUILD = parseGuildId('111111111111111111');

let t: MigratedTestDatabase;
let SCOPE: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  SCOPE = t.scopes.forGuild(GUILD);
});
afterEach(() => t.close());

const resource = (over: Partial<ClubResource> = {}): ClubResource => ({
  id: 'res-1',
  guildId: GUILD,
  title: 'A resource',
  url: 'https://example.com/guide',
  kind: 'website',
  enabled: true,
  reviewedAt: new Date(0).toISOString(),
  ...over,
});

/** An in-memory stand-in for resourceCacheRepo, scoped to one guild id (this module never reads scope.guildId itself, so a bare object is enough). */
class FakeRepo implements ResourceRefreshRepo {
  readonly docs = new Map<string, UpsertDocumentInput>();
  readonly chunkCalls: { docId: string; resourceId: string; chunkCount: number }[] = [];

  getDocumentByUrl(_scope: GuildScope, url: string) {
    const docId = computeDocId(url);
    return this.docs.get(docId);
  }
  upsertDocument(_scope: GuildScope, d: UpsertDocumentInput): void {
    this.docs.set(d.docId, d);
  }
  replaceChunks(
    _scope: GuildScope,
    docId: string,
    resourceId: string,
    chunks: readonly unknown[],
  ): void {
    this.chunkCalls.push({ docId, resourceId, chunkCount: chunks.length });
  }
}

const deps = (
  fetcher: ResourceRefreshFetcher,
  repo: FakeRepo = new FakeRepo(),
  now = () => 1_000,
): ResourceRefreshDeps => ({ fetcher, repo, now });

describe('refreshResource', () => {
  it('skips a discord-channel resource entirely — no fetch, no document, no chunks', async () => {
    const fetch = vi.fn<ResourceRefreshFetcher['fetch']>();
    const repo = new FakeRepo();
    const outcome = await refreshResource(
      SCOPE,
      resource({ kind: 'discord-channel' }),
      deps({ fetch }, repo),
    );
    expect(outcome).toBe('skipped');
    expect(fetch).not.toHaveBeenCalled();
    expect(repo.docs.size).toBe(0);
    expect(repo.chunkCalls).toHaveLength(0);
  });

  it('chunks a note from its own row without fetching', async () => {
    const fetch = vi.fn<ResourceRefreshFetcher['fetch']>();
    const repo = new FakeRepo();
    const note = resource({
      kind: 'note',
      title: 'Kickoff notes',
      url: 'Meet Tuesdays at 6pm in the CS building, room 204.',
    });
    const outcome = await refreshResource(SCOPE, note, deps({ fetch }, repo));
    expect(outcome).toBe('ok');
    expect(fetch).not.toHaveBeenCalled();
    expect(repo.chunkCalls).toHaveLength(1);
    expect(repo.chunkCalls[0]?.chunkCount).toBeGreaterThan(0);
    const [doc] = [...repo.docs.values()];
    expect(doc).toMatchObject({ resourceId: 'res-1', status: 'ok' });
  });

  it('re-chunking a note with unchanged text is a no-op re-chunk (not-modified)', async () => {
    const fetch = vi.fn<ResourceRefreshFetcher['fetch']>();
    const repo = new FakeRepo();
    const note = resource({ kind: 'note', url: 'the exact same note text every time' });
    await refreshResource(
      SCOPE,
      note,
      deps({ fetch }, repo, () => 1_000),
    );
    const outcome = await refreshResource(
      SCOPE,
      note,
      deps({ fetch }, repo, () => 2_000),
    );
    expect(outcome).toBe('not-modified');
    expect(repo.chunkCalls).toHaveLength(1); // only the first refresh replaced chunks
    const [doc] = [...repo.docs.values()];
    expect(doc?.fetchedAt).toBe(2_000); // fetchedAt still bumps
  });

  it('an unchanged ETag (a 304) updates fetchedAt but never re-chunks', async () => {
    const repo = new FakeRepo();
    const fetch = vi
      .fn<ResourceRefreshFetcher['fetch']>()
      .mockResolvedValueOnce({
        ok: true,
        evidence: {
          url: 'https://example.com/guide',
          mediaType: 'text/plain',
          text: 'the guide text',
          fetchedAt: 1,
          trust: 'untrusted-reviewed-resource',
        },
        cache: 'miss',
        etag: '"v1"',
      })
      .mockResolvedValueOnce({ ok: true, notModified: true });

    const first = await refreshResource(
      SCOPE,
      resource(),
      deps({ fetch }, repo, () => 1_000),
    );
    expect(first).toBe('ok');
    expect(repo.chunkCalls).toHaveLength(1);

    const second = await refreshResource(
      SCOPE,
      resource(),
      deps({ fetch }, repo, () => 2_000),
    );
    expect(second).toBe('not-modified');
    expect(repo.chunkCalls).toHaveLength(1); // still just the one, from the first refresh
    const [doc] = [...repo.docs.values()];
    expect(doc?.fetchedAt).toBe(2_000);
    expect(doc?.status).toBe('ok');

    // The second call must have carried the etag the first fetch returned.
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://example.com/guide', { etag: '"v1"' });
  });

  it('changed content replaces the chunks', async () => {
    const repo = new FakeRepo();
    const evidence = (text: string) => ({
      ok: true as const,
      evidence: {
        url: 'https://example.com/guide',
        mediaType: 'text/plain',
        text,
        fetchedAt: 1,
        trust: 'untrusted-reviewed-resource' as const,
      },
      cache: 'miss' as const,
    });
    const fetch = vi
      .fn<ResourceRefreshFetcher['fetch']>()
      .mockResolvedValueOnce(evidence('version one'))
      .mockResolvedValueOnce(evidence('version two, quite different'));

    await refreshResource(
      SCOPE,
      resource(),
      deps({ fetch }, repo, () => 1_000),
    );
    const second = await refreshResource(
      SCOPE,
      resource(),
      deps({ fetch }, repo, () => 2_000),
    );
    expect(second).toBe('ok');
    expect(repo.chunkCalls).toHaveLength(2);
    const [doc] = [...repo.docs.values()];
    expect(doc?.contentHash).not.toBe('');
  });

  it('a fetch error sets document status error with a plain message and keeps the old chunks', async () => {
    const repo = new FakeRepo();
    const fetch = vi
      .fn<ResourceRefreshFetcher['fetch']>()
      .mockResolvedValueOnce({
        ok: true,
        evidence: {
          url: 'https://example.com/guide',
          mediaType: 'text/plain',
          text: 'good content',
          fetchedAt: 1,
          trust: 'untrusted-reviewed-resource',
        },
        cache: 'miss',
      })
      .mockResolvedValueOnce({
        ok: false,
        code: 'timeout',
        message: 'The reviewed resource could not be retrieved safely.',
      });

    await refreshResource(
      SCOPE,
      resource(),
      deps({ fetch }, repo, () => 1_000),
    );
    expect(repo.chunkCalls).toHaveLength(1);

    const outcome = await refreshResource(
      SCOPE,
      resource(),
      deps({ fetch }, repo, () => 2_000),
    );
    expect(outcome).toBe('error');
    // Old chunks kept: no second replaceChunks call.
    expect(repo.chunkCalls).toHaveLength(1);
    const [doc] = [...repo.docs.values()];
    expect(doc).toMatchObject({
      status: 'error',
      error: 'The reviewed resource could not be retrieved safely.',
      fetchedAt: 2_000,
    });
  });

  it('a resource of kind repository is fetched like a website (its URL page)', async () => {
    const repo = new FakeRepo();
    const fetch = vi.fn<ResourceRefreshFetcher['fetch']>().mockResolvedValueOnce({
      ok: true,
      evidence: {
        url: 'https://example.com/repo',
        mediaType: 'text/html',
        text: '<h1>Readme</h1>',
        fetchedAt: 1,
        trust: 'untrusted-reviewed-resource',
      },
      cache: 'miss',
    });
    const outcome = await refreshResource(
      SCOPE,
      resource({ kind: 'repository', url: 'https://example.com/repo' }),
      deps({ fetch }, repo),
    );
    expect(outcome).toBe('ok');
    expect(fetch).toHaveBeenCalledWith('https://example.com/repo', {});
  });
});

describe('refreshAll', () => {
  it('refreshes every resource, independently of one failing', async () => {
    const repo = new FakeRepo();
    const fetch = vi.fn<ResourceRefreshFetcher['fetch']>((url: string) =>
      url.includes('bad')
        ? Promise.resolve({ ok: false, code: 'network', message: 'boom' } as const)
        : Promise.resolve({
            ok: true,
            evidence: {
              url,
              mediaType: 'text/plain',
              text: `text for ${url}`,
              fetchedAt: 1,
              trust: 'untrusted-reviewed-resource',
            },
            cache: 'miss',
          } as const),
    );
    const resources = [
      resource({ id: 'good', url: 'https://example.com/good' }),
      resource({ id: 'bad', url: 'https://example.com/bad' }),
    ];
    const results = await refreshAll(SCOPE, resources, deps({ fetch }, repo));
    expect(results).toEqual([
      { resourceId: 'good', outcome: 'ok' },
      { resourceId: 'bad', outcome: 'error' },
    ]);
  });
});
