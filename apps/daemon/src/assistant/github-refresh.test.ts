import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId, type ClubResource } from '@bananasaurs/core';
import { computeDocId, type GuildScope } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { GitHubError } from './github-client.js';
import {
  refreshGithubOrg,
  refreshGithubRepo,
  refreshGithubResource,
  type GithubCacheStore,
  type GithubRefreshDeps,
  type GithubResourceStore,
  type StoredDoc,
} from './github-refresh.js';
import type { UpsertDocumentInput } from './resource-refresh.js';

const GUILD = parseGuildId('111111111111111111');

let t: MigratedTestDatabase;
let SCOPE: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  SCOPE = t.scopes.forGuild(GUILD);
});
afterEach(() => t.close());

const org = (over: Partial<ClubResource> = {}): ClubResource => ({
  id: 'gh-acme',
  guildId: GUILD,
  title: 'acme',
  url: 'https://github.com/acme',
  kind: 'github-org',
  enabled: true,
  reviewedAt: new Date(0).toISOString(),
  meta: { owner: 'acme' },
  ...over,
});

const repo = (over: Partial<ClubResource> = {}): ClubResource => ({
  id: 'gh-acme-widget',
  guildId: GUILD,
  title: 'acme/widget',
  url: 'https://github.com/acme/widget',
  kind: 'github-repo',
  enabled: true,
  reviewedAt: new Date(0).toISOString(),
  parentId: 'gh-acme',
  meta: { owner: 'acme', repo: 'widget', branch: 'main' },
  ...over,
});

const summary = (
  name: string,
  over: Partial<{
    description: string | null;
    defaultBranch: string;
    fork: boolean;
    archived: boolean;
    private: boolean;
  }> = {},
) => ({
  name,
  description: `${name} description`,
  defaultBranch: 'main',
  fork: false,
  archived: false,
  private: false,
  ...over,
});

class FakeClient {
  authenticated = true;
  orgRepos: unknown[] | Error = [];
  repoDetail: unknown = { defaultBranch: 'main', description: null, private: false };
  tree: unknown = { entries: [], truncated: false };
  fileRaw: unknown | Error = { notModified: false, text: 'private file text', etag: '"v1"' };
  readonly calls = { listOrgRepos: 0, getRepo: 0, listTree: 0, getFileRaw: 0 };
  readonly fileRawCalls: {
    owner: string;
    repo: string;
    ref: string;
    path: string;
    etag?: string;
  }[] = [];

  async listOrgRepos(_owner: string) {
    this.calls.listOrgRepos += 1;
    if (this.orgRepos instanceof Error) throw this.orgRepos;
    return { repos: this.orgRepos, truncated: false } as never;
  }
  async getRepo(_owner: string, _repo: string) {
    this.calls.getRepo += 1;
    if (this.repoDetail instanceof Error) throw this.repoDetail;
    return this.repoDetail as never;
  }
  async listTree(_owner: string, _repo: string, _ref: string) {
    this.calls.listTree += 1;
    if (this.tree instanceof Error) throw this.tree;
    return this.tree as never;
  }
  async getFileRaw(owner: string, repo: string, ref: string, path: string, etag?: string) {
    this.calls.getFileRaw += 1;
    this.fileRawCalls.push({ owner, repo, ref, path, ...(etag === undefined ? {} : { etag }) });
    if (this.fileRaw instanceof Error) throw this.fileRaw;
    if (typeof this.fileRaw === 'function')
      return (this.fileRaw as (args: { owner: string; repo: string; ref: string; path: string; etag?: string }) => unknown)({ owner, repo, ref, path, ...(etag === undefined ? {} : { etag }) }) as never;
    return this.fileRaw as never;
  }
}

const okFile = (url: string, text: string) => ({
  ok: true as const,
  evidence: {
    url,
    mediaType: 'text/plain',
    text,
    fetchedAt: 1,
    trust: 'untrusted-reviewed-resource' as const,
  },
  cache: 'miss' as const,
  etag: '"v1"',
});

class FakeFetcher {
  readonly calls: { url: string; conditional: unknown }[] = [];
  constructor(private readonly respond: (url: string) => unknown) {}
  async fetch(url: string, conditional?: unknown) {
    this.calls.push({ url, conditional });
    return (await this.respond(url)) as never;
  }
}

class FakeStore implements GithubResourceStore {
  rows = new Map<string, ClubResource>();
  readonly fetchRecords: { id: string; status: string; detail: string; at: number }[] = [];

  listResources(_scope: GuildScope): readonly ClubResource[] {
    return [...this.rows.values()];
  }
  putResource(_scope: GuildScope, input: ClubResource): void {
    this.rows.set(input.id, input);
  }
  setResourceEnabled(
    _scope: GuildScope,
    id: string,
    input: { readonly enabled: boolean; readonly meta: ClubResource['meta'] },
  ): boolean {
    const row = this.rows.get(id);
    if (row === undefined) return false;
    const { meta: _dropped, ...rest } = row;
    this.rows.set(
      id,
      input.meta === undefined
        ? { ...rest, enabled: input.enabled }
        : { ...rest, enabled: input.enabled, meta: input.meta },
    );
    return true;
  }
  recordResourceFetch(
    _scope: GuildScope,
    id: string,
    input: {
      readonly status: 'ok' | 'failed' | 'blocked';
      readonly at: number;
      readonly detail: string;
    },
  ): void {
    this.fetchRecords.push({ id, ...input });
    const row = this.rows.get(id);
    if (row !== undefined) {
      this.rows.set(id, {
        ...row,
        lastFetchedAt: input.at,
        fetchStatus: input.status === 'ok' ? 'ok' : 'failed',
        fetchDetail: input.detail,
      });
    }
  }
}

class FakeCache implements GithubCacheStore {
  readonly docs = new Map<string, UpsertDocumentInput>();
  readonly chunkCalls: { docId: string; resourceId: string; count: number }[] = [];
  readonly deleted: string[] = [];

  getDocumentByUrl(_scope: GuildScope, url: string): StoredDoc | undefined {
    return this.docs.get(computeDocId(url));
  }
  listDocuments(_scope: GuildScope, resourceId: string): readonly StoredDoc[] {
    return [...this.docs.values()].filter((d) => d.resourceId === resourceId);
  }
  upsertDocument(_scope: GuildScope, d: UpsertDocumentInput): void {
    this.docs.set(d.docId, { ...d });
  }
  replaceChunks(
    _scope: GuildScope,
    docId: string,
    resourceId: string,
    chunks: readonly unknown[],
  ): void {
    this.chunkCalls.push({ docId, resourceId, count: chunks.length });
  }
  deleteDocument(_scope: GuildScope, docId: string): void {
    this.deleted.push(docId);
    this.docs.delete(docId);
  }
}

const deps = (
  client: FakeClient,
  fetcher: FakeFetcher,
  store = new FakeStore(),
  cache = new FakeCache(),
  now = () => 1_000,
): { deps: GithubRefreshDeps; store: FakeStore; cache: FakeCache; client: FakeClient } => ({
  deps: {
    client,
    fetcher,
    store,
    cache,
    now,
  },
  store,
  cache,
  client,
});

const rateLimited = (resetAt?: number) =>
  new GitHubError('rate-limited', 'GitHub rate limit reached.', resetAt);

describe('refreshGithubOrg', () => {
  it('creates a missing child per listed repo, forks and archived included', async () => {
    const client = new FakeClient();
    client.orgRepos = [
      summary('widget'),
      summary('forked', { fork: true }),
      summary('old', { archived: true }),
    ];
    const fetcher = new FakeFetcher(() => {
      throw new Error('raw fetches never happen for an org');
    });
    const { deps: d, store } = deps(client, fetcher);
    store.rows.set('gh-acme', org());

    const outcome = await refreshGithubOrg(SCOPE, org(), d);

    expect(outcome).toBe('ok');
    expect(client.calls.listOrgRepos).toBe(1);
    const children = [...store.rows.values()].filter((r) => r.parentId === 'gh-acme');
    expect(children.map((c) => c.title).sort()).toEqual(
      ['acme/forked', 'acme/old', 'acme/widget'].sort(),
    );
    for (const child of children) {
      expect(child).toMatchObject({ kind: 'github-repo', enabled: true, parentId: 'gh-acme' });
    }
    const widget = children.find((c) => c.title === 'acme/widget');
    expect(widget).toMatchObject({
      meta: { owner: 'acme', repo: 'widget', branch: 'main', autoDiscovered: true },
    });
    expect(widget?.url).toBe('https://github.com/acme/widget');
    expect(store.fetchRecords).toHaveLength(1);
    expect(store.fetchRecords[0]).toMatchObject({ id: 'gh-acme', status: 'ok' });
  });

  it('creates enabled children for private repos with meta.private', async () => {
    const client = new FakeClient();
    client.orgRepos = [summary('widget'), summary('secret', { private: true })];
    const fetcher = new FakeFetcher(() => {
      throw new Error('raw fetches never happen for an org');
    });
    const { deps: d, store } = deps(client, fetcher);
    store.rows.set('gh-acme', org());

    const outcome = await refreshGithubOrg(SCOPE, org(), d);

    expect(outcome).toBe('ok');
    const children = [...store.rows.values()].filter((r) => r.parentId === 'gh-acme');
    expect(children.map((c) => c.title).sort()).toEqual(['acme/secret', 'acme/widget']);
    for (const child of children) expect(child.enabled).toBe(true);
    const secret = children.find((c) => c.title === 'acme/secret');
    expect(secret).toMatchObject({
      meta: { owner: 'acme', repo: 'secret', branch: 'main', autoDiscovered: true, private: true },
    });
    const widget = children.find((c) => c.title === 'acme/widget');
    expect(widget?.meta?.private).toBeUndefined();
    expect(store.fetchRecords[0]).toMatchObject({
      id: 'gh-acme',
      status: 'ok',
      detail: 'GitHub organisation refreshed: 2 repositories.',
    });
  });

  it('ignores the old includeForks and includeArchived toggles: every repo is included', async () => {
    const client = new FakeClient();
    client.orgRepos = [summary('forked', { fork: true }), summary('old', { archived: true })];
    const fetcher = new FakeFetcher(() => {
      throw new Error('no raw fetch');
    });
    const { deps: d, store } = deps(client, fetcher);
    const withToggles = org({ meta: { owner: 'acme', includeForks: true, includeArchived: true } });
    store.rows.set('gh-acme', withToggles);

    await refreshGithubOrg(SCOPE, withToggles, d);

    expect([...store.rows.values()].filter((r) => r.parentId === 'gh-acme')).toHaveLength(2);

    // And without the toggles the same two repositories are still included.
    const client2 = new FakeClient();
    client2.orgRepos = [summary('forked', { fork: true }), summary('old', { archived: true })];
    const second = deps(client2, fetcher);
    second.store.rows.set('gh-acme', org());

    await refreshGithubOrg(SCOPE, org(), second.deps);

    expect([...second.store.rows.values()].filter((r) => r.parentId === 'gh-acme')).toHaveLength(2);
  });

  it('never re-enables a child the owner turned off', async () => {
    const client = new FakeClient();
    client.orgRepos = [summary('widget')];
    const fetcher = new FakeFetcher(() => {
      throw new Error('no raw fetch');
    });
    const { deps: d, store } = deps(client, fetcher);
    const current = org();
    store.rows.set('gh-acme', current);
    const off = repo({
      id: 'widget-id',
      title: 'acme/widget',
      enabled: false,
      meta: {
        owner: 'acme',
        repo: 'widget',
        branch: 'main',
        autoDiscovered: true,
        disabledByOwner: true,
      },
    });
    store.rows.set('widget-id', off);

    await refreshGithubOrg(SCOPE, current, d);

    expect(store.rows.get('widget-id')).toMatchObject({
      enabled: false,
      meta: { disabledByOwner: true },
    });
  });

  it('re-enables a child that left the organisation and came back, unless the owner turned it off', async () => {
    const client = new FakeClient();
    client.orgRepos = [summary('widget')];
    const fetcher = new FakeFetcher(() => {
      throw new Error('no raw fetch');
    });
    const { deps: d, store } = deps(client, fetcher);
    const current = org();
    store.rows.set('gh-acme', current);
    // Disabled because it left the organisation: no disabledByOwner flag.
    const returned = repo({
      id: 'widget-id',
      title: 'acme/widget',
      enabled: false,
      meta: { owner: 'acme', repo: 'widget', branch: 'main', autoDiscovered: true },
    });
    store.rows.set('widget-id', returned);

    await refreshGithubOrg(SCOPE, current, d);

    expect(store.rows.get('widget-id')).toMatchObject({ enabled: true });
  });

  it('re-enabling a returned child does not reset its recorded fetch status', async () => {
    const client = new FakeClient();
    client.orgRepos = [summary('widget')];
    const fetcher = new FakeFetcher(() => {
      throw new Error('no raw fetch');
    });
    const { deps: d, store } = deps(client, fetcher);
    const current = org();
    store.rows.set('gh-acme', current);
    const returned = repo({
      id: 'widget-id',
      title: 'acme/widget',
      enabled: false,
      meta: { owner: 'acme', repo: 'widget', branch: 'main', autoDiscovered: true },
      lastFetchedAt: 123,
      fetchStatus: 'ok',
    });
    store.rows.set('widget-id', returned);

    await refreshGithubOrg(SCOPE, current, d);

    expect(store.rows.get('widget-id')).toMatchObject({
      enabled: true,
      fetchStatus: 'ok',
      lastFetchedAt: 123,
      title: 'acme/widget',
      url: 'https://github.com/acme/widget',
    });
  });

  it('disables auto-discovered children no longer listed, never deletes, and leaves owner children alone', async () => {
    const client = new FakeClient();
    client.orgRepos = [summary('widget')];
    const fetcher = new FakeFetcher(() => {
      throw new Error('no raw fetch');
    });
    const { deps: d, store } = deps(client, fetcher);
    const current = org();
    store.rows.set('gh-acme', current);
    const gone = repo({
      id: 'gone-id',
      title: 'acme/gone',
      meta: { owner: 'acme', repo: 'gone', branch: 'main', autoDiscovered: true },
    });
    const kept = repo({
      id: 'widget-id',
      title: 'acme/widget',
      meta: { owner: 'acme', repo: 'widget', branch: 'main', autoDiscovered: true },
    });
    const owned = repo({
      id: 'owned-id',
      title: 'My hand-picked fork',
      meta: { owner: 'acme', repo: 'forked', branch: 'main' },
    });
    for (const row of [gone, kept, owned]) store.rows.set(row.id, row);

    await refreshGithubOrg(SCOPE, current, d);

    expect(store.rows.get('gone-id')).toMatchObject({ enabled: false });
    // Never deleted: the row is still there for the owner to re-enable or edit.
    expect(store.rows.has('gone-id')).toBe(true);
    expect(store.rows.get('widget-id')).toMatchObject({ enabled: true });
    expect(store.rows.get('owned-id')).toMatchObject({ enabled: true });
  });

  it('unauthenticated: re-lists an org at most once per 24 hours', async () => {
    const client = new FakeClient();
    client.authenticated = false;
    client.orgRepos = [summary('widget')];
    const fetcher = new FakeFetcher(() => {
      throw new Error('no raw fetch');
    });
    const { deps: d, store } = deps(
      client,
      fetcher,
      new FakeStore(),
      new FakeCache(),
      () => 100_000_000,
    );
    store.rows.set('gh-acme', org({ lastFetchedAt: 100_000_000 - 1_000 }));

    const outcome = await refreshGithubOrg(SCOPE, org({ lastFetchedAt: 100_000_000 - 1_000 }), d);

    expect(outcome).toBe('skipped');
    expect(client.calls.listOrgRepos).toBe(0);
  });

  it('unauthenticated: re-lists once 24 hours have passed', async () => {
    const client = new FakeClient();
    client.authenticated = false;
    client.orgRepos = [summary('widget')];
    const fetcher = new FakeFetcher(() => {
      throw new Error('no raw fetch');
    });
    const now = 200_000_000;
    const { deps: d, store } = deps(client, fetcher, new FakeStore(), new FakeCache(), () => now);
    store.rows.set('gh-acme', org({ lastFetchedAt: now - 25 * 3_600_000 }));

    const outcome = await refreshGithubOrg(SCOPE, org({ lastFetchedAt: now - 25 * 3_600_000 }), d);

    expect(outcome).toBe('ok');
    expect(client.calls.listOrgRepos).toBe(1);
  });

  it('authenticated: re-lists even when recently fetched', async () => {
    const client = new FakeClient();
    client.orgRepos = [summary('widget')];
    const fetcher = new FakeFetcher(() => {
      throw new Error('no raw fetch');
    });
    const { deps: d, store } = deps(
      client,
      fetcher,
      new FakeStore(),
      new FakeCache(),
      () => 100_000_000,
    );
    store.rows.set('gh-acme', org({ lastFetchedAt: 100_000_000 - 1_000 }));

    const outcome = await refreshGithubOrg(SCOPE, org({ lastFetchedAt: 100_000_000 - 1_000 }), d);

    expect(outcome).toBe('ok');
    expect(client.calls.listOrgRepos).toBe(1);
  });

  it('falls back to the URL owner when meta is missing, and errors when neither parses', async () => {
    const client = new FakeClient();
    client.orgRepos = [summary('widget')];
    const fetcher = new FakeFetcher(() => {
      throw new Error('no raw fetch');
    });
    const { deps: d, store } = deps(client, fetcher);
    const base = org();
    const orgWithoutMeta: ClubResource = {
      id: base.id,
      guildId: base.guildId,
      title: base.title,
      url: base.url,
      kind: base.kind,
      enabled: base.enabled,
      reviewedAt: base.reviewedAt,
    };
    store.rows.set('gh-acme', orgWithoutMeta);

    expect(await refreshGithubOrg(SCOPE, orgWithoutMeta, d)).toBe('ok');
    expect(client.calls.listOrgRepos).toBe(1);

    const bad = { ...orgWithoutMeta, id: 'bad', url: 'https://example.com/not-github' };
    expect(await refreshGithubOrg(SCOPE, bad, d)).toBe('error');
    expect(store.fetchRecords.find((r) => r.id === 'bad')).toMatchObject({ status: 'failed' });
  });

  it('rate-limited: records the retry sentence and keeps old chunks', async () => {
    const client = new FakeClient();
    client.orgRepos = rateLimited(1_893_456_000_000);
    const fetcher = new FakeFetcher(() => {
      throw new Error('no raw fetch');
    });
    const { deps: d, store, cache } = deps(client, fetcher);
    store.rows.set('gh-acme', org());

    const outcome = await refreshGithubOrg(SCOPE, org(), d);

    expect(outcome).toBe('error');
    expect(store.fetchRecords[0]).toMatchObject({
      id: 'gh-acme',
      status: 'failed',
      detail: 'GitHub rate limit reached; will retry after 2030-01-01T00:00:00.000Z.',
    });
    expect(cache.chunkCalls).toHaveLength(0);
  });
});

describe('refreshGithubRepo (authenticated)', () => {
  const treeEntries = [
    { path: 'README.md', type: 'blob' as const, size: 120 },
    { path: 'docs/guide.md', type: 'blob' as const, size: 120 },
    { path: 'src/app.js', type: 'blob' as const, size: 120 },
    { path: 'notes.txt', type: 'blob' as const, size: 120 },
  ];

  const setup = () => {
    const client = new FakeClient();
    client.tree = { entries: treeEntries, truncated: false };
    const fetcher = new FakeFetcher(async (url: string) => okFile(url, `# text for ${url}`));
    // The spread already carries this same `client` reference; naming it twice
    // let the second silently win, so only the spread names it.
    return { fetcher, ...deps(client, fetcher) };
  };

  it('caches the default file selection, one document per file with the path as title', async () => {
    const { deps: d, cache, store, client } = setup();
    store.rows.set('gh-acme-widget', repo());

    const outcome = await refreshGithubRepo(SCOPE, repo(), d);

    expect(outcome).toBe('ok');
    expect(client.calls.getRepo).toBe(1);
    expect(client.calls.listTree).toBe(1);
    const urls = cache.docs.size > 0 ? [...cache.docs.values()].map((doc) => doc.url) : [];
    expect(urls.sort()).toEqual(
      [
        'https://raw.githubusercontent.com/acme/widget/main/README.md',
        'https://raw.githubusercontent.com/acme/widget/main/docs/guide.md',
      ].sort(),
    );
    for (const doc of cache.docs.values()) {
      expect(doc.title).toBe(doc.path);
      expect(doc.resourceId).toBe('gh-acme-widget');
    }
    expect(cache.chunkCalls).toHaveLength(2);
    expect(store.fetchRecords[0]).toMatchObject({ id: 'gh-acme-widget', status: 'ok' });
  });

  it('honours meta.include globs', async () => {
    const { deps: d, cache, store, fetcher } = setup();
    const withInclude = repo({
      meta: { owner: 'acme', repo: 'widget', branch: 'main', include: ['docs/**'] },
    });
    store.rows.set('gh-acme-widget', withInclude);

    await refreshGithubRepo(SCOPE, withInclude, d);

    expect(fetcher.calls.map((c) => c.url)).toEqual([
      'https://raw.githubusercontent.com/acme/widget/main/docs/guide.md',
    ]);
    expect(cache.chunkCalls).toHaveLength(1);
  });

  it('a private repo with a token caches via getFileRaw and stores meta.private', async () => {
    const client = new FakeClient();
    client.tree = { entries: treeEntries, truncated: false };
    client.repoDetail = { defaultBranch: 'main', description: null, private: true };
    client.fileRaw = ({ path }: { path: string }) => ({
      notModified: false,
      text: `# text for ${path}`,
      etag: '"v1"',
    });
    const fetcher = new FakeFetcher(() => {
      throw new Error('public fetcher never runs for a private repo');
    });
    const { deps: d, store, cache } = deps(client, fetcher);
    store.rows.set('gh-acme-widget', repo());

    const outcome = await refreshGithubRepo(SCOPE, repo(), d);

    expect(outcome).toBe('ok');
    expect(client.calls.getFileRaw).toBeGreaterThan(0);
    expect(fetcher.calls).toHaveLength(0);
    expect(client.fileRawCalls.map((c) => c.path).sort()).toEqual(
      ['README.md', 'docs/guide.md'].sort(),
    );
    expect(client.fileRawCalls[0]).toMatchObject({
      owner: 'acme',
      repo: 'widget',
      ref: 'main',
    });
    expect(store.rows.get('gh-acme-widget')).toMatchObject({
      enabled: true,
      meta: { owner: 'acme', repo: 'widget', branch: 'main', private: true },
    });
    expect(cache.chunkCalls.length).toBeGreaterThan(0);
    expect(store.fetchRecords[0]).toMatchObject({ id: 'gh-acme-widget', status: 'ok' });
  });

  it('a public repo still uses the raw fetcher and never getFileRaw', async () => {
    const { deps: d, cache, store, client, fetcher } = setup();

    const outcome = await refreshGithubRepo(SCOPE, repo(), d);

    expect(outcome).toBe('ok');
    expect(fetcher.calls.length).toBeGreaterThan(0);
    expect(client.calls.getFileRaw).toBe(0);
    expect(cache.chunkCalls.length).toBeGreaterThan(0);
  });

  it('a private getFileRaw 304 keeps the existing document', async () => {
    const client = new FakeClient();
    client.tree = {
      entries: [{ path: 'README.md', type: 'blob' as const, size: 120 }],
      truncated: false,
    };
    client.repoDetail = { defaultBranch: 'main', description: null, private: true };
    client.fileRaw = ({ path }: { path: string }) => ({
      notModified: false,
      text: `# text for ${path}`,
      etag: '"v1"',
    });
    const fetcher = new FakeFetcher(() => {
      throw new Error('public fetcher never runs for a private repo');
    });
    const first = deps(client, fetcher, new FakeStore(), new FakeCache(), () => 1_000);
    first.store.rows.set('gh-acme-widget', repo());
    expect(await refreshGithubRepo(SCOPE, repo(), first.deps)).toBe('ok');
    expect(first.cache.chunkCalls).toHaveLength(1);

    client.fileRaw = { notModified: true };
    const secondFetcher = new FakeFetcher(() => {
      throw new Error('public fetcher never runs for a private repo');
    });
    const second = deps(client, secondFetcher, first.store, first.cache, () => 2_000);
    const outcome = await refreshGithubRepo(SCOPE, repo(), second.deps);

    expect(outcome).toBe('not-modified');
    expect(secondFetcher.calls).toHaveLength(0);
    expect(first.cache.chunkCalls).toHaveLength(1);
    const docId = computeDocId('https://raw.githubusercontent.com/acme/widget/main/README.md');
    expect(first.cache.docs.get(docId)?.fetchedAt).toBe(2_000);
    expect(client.fileRawCalls.at(-1)).toMatchObject({ path: 'README.md', etag: '"v1"' });
  });

  it('a not-found getRepo disables the resource with the lost-access detail', async () => {
    const client = new FakeClient();
    client.repoDetail = new GitHubError('not-found', 'GitHub returned 404 for this URL.');
    const fetcher = new FakeFetcher(async (url: string) => okFile(url, 'text'));
    const { deps: d, store, cache } = deps(client, fetcher);
    store.rows.set('gh-acme-widget', repo());

    const outcome = await refreshGithubRepo(SCOPE, repo(), d);

    expect(outcome).toBe('error');
    expect(store.rows.get('gh-acme-widget')).toMatchObject({ enabled: false });
    expect(fetcher.calls).toHaveLength(0);
    expect(cache.chunkCalls).toHaveLength(0);
    expect(store.fetchRecords[0]).toMatchObject({
      id: 'gh-acme-widget',
      status: 'failed',
      detail:
        "GitHub can't find this repository, or the token can't read it. It has been turned off, so its cached text is no longer searched.",
    });
  });

  it('rate-limited: records the retry sentence and keeps old chunks', async () => {
    const client = new FakeClient();
    client.repoDetail = rateLimited(1_893_456_000_000);
    const fetcher = new FakeFetcher(async (url: string) => okFile(url, 'text'));
    const { deps: d, store, cache } = deps(client, fetcher);
    const current = repo();
    store.rows.set('gh-acme-widget', current);
    // An old cached document with chunks, from a previous good refresh.
    const oldUrl = 'https://raw.githubusercontent.com/acme/widget/main/README.md';
    cache.docs.set(computeDocId(oldUrl), {
      resourceId: 'gh-acme-widget',
      docId: computeDocId(oldUrl),
      url: oldUrl,
      path: 'README.md',
      title: 'README.md',
      contentHash: 'old-hash',
      fetchedAt: 500,
      bytes: 8,
      status: 'ok',
    });
    cache.chunkCalls.push({ docId: computeDocId(oldUrl), resourceId: 'gh-acme-widget', count: 1 });

    const outcome = await refreshGithubRepo(SCOPE, current, d);

    expect(outcome).toBe('error');
    expect(store.fetchRecords[0]).toMatchObject({
      status: 'failed',
      detail: 'GitHub rate limit reached; will retry after 2030-01-01T00:00:00.000Z.',
    });
    // Old chunks kept: no new chunk writes, no deletions.
    expect(cache.chunkCalls).toHaveLength(1);
    expect(cache.deleted).toHaveLength(0);
    expect(cache.docs.has(computeDocId(oldUrl))).toBe(true);
  });

  it('deletes documents for removed files', async () => {
    const { deps: d, cache, store, client } = setup();
    client.tree = {
      entries: [{ path: 'README.md', type: 'blob' as const, size: 120 }],
      truncated: false,
    };
    store.rows.set('gh-acme-widget', repo());
    const staleUrl = 'https://raw.githubusercontent.com/acme/widget/main/docs/gone.md';
    cache.docs.set(computeDocId(staleUrl), {
      resourceId: 'gh-acme-widget',
      docId: computeDocId(staleUrl),
      url: staleUrl,
      path: 'docs/gone.md',
      title: 'docs/gone.md',
      contentHash: 'old',
      fetchedAt: 500,
      bytes: 8,
      status: 'ok',
    });

    await refreshGithubRepo(SCOPE, repo(), d);

    expect(cache.deleted).toEqual([computeDocId(staleUrl)]);
    expect(cache.docs.has(computeDocId(staleUrl))).toBe(false);
    expect([...cache.docs.values()].map((doc) => doc.url)).toEqual([
      'https://raw.githubusercontent.com/acme/widget/main/README.md',
    ]);
  });

  it('an unchanged file (304) bumps fetchedAt without re-chunking', async () => {
    const client = new FakeClient();
    client.tree = {
      entries: [{ path: 'README.md', type: 'blob' as const, size: 120 }],
      truncated: false,
    };
    const fetcher = new FakeFetcher(async (url: string) => okFile(url, 'same text'));
    const first = deps(client, fetcher, new FakeStore(), new FakeCache(), () => 1_000);
    first.store.rows.set('gh-acme-widget', repo());
    expect(await refreshGithubRepo(SCOPE, repo(), first.deps)).toBe('ok');
    expect(first.cache.chunkCalls).toHaveLength(1);

    const secondFetcher = new FakeFetcher(async () => ({
      ok: true as const,
      notModified: true as const,
    }));
    const second = deps(client, secondFetcher, first.store, first.cache, () => 2_000);
    const outcome = await refreshGithubRepo(SCOPE, repo(), second.deps);

    expect(outcome).toBe('not-modified');
    expect(first.cache.chunkCalls).toHaveLength(1);
    const docId = computeDocId('https://raw.githubusercontent.com/acme/widget/main/README.md');
    expect(first.cache.docs.get(docId)?.fetchedAt).toBe(2_000);
    // The conditional request carried the stored etag.
    expect(secondFetcher.calls[0]?.conditional).toMatchObject({ etag: '"v1"' });
  });
});

describe('refreshGithubRepo (unauthenticated)', () => {
  it('fetches README only, with no listTree and no getRepo when the branch is known', async () => {
    const client = new FakeClient();
    client.authenticated = false;
    const fetcher = new FakeFetcher(async (url: string) => okFile(url, 'readme text'));
    const { deps: d, cache, store } = deps(client, fetcher);
    store.rows.set('gh-acme-widget', repo());

    const outcome = await refreshGithubRepo(SCOPE, repo(), d);

    expect(outcome).toBe('ok');
    expect(fetcher.calls.map((c) => c.url)).toEqual([
      'https://raw.githubusercontent.com/acme/widget/main/README.md',
    ]);
    expect(client.calls.listTree).toBe(0);
    expect(client.calls.getRepo).toBe(0);
    expect(cache.chunkCalls).toHaveLength(1);
  });

  it('falls back to the getRepo default branch when meta.branch is unknown', async () => {
    const client = new FakeClient();
    client.authenticated = false;
    client.repoDetail = { defaultBranch: 'develop', description: null, private: false };
    const fetcher = new FakeFetcher(async (url: string) => okFile(url, 'readme text'));
    const { deps: d, cache } = deps(client, fetcher);
    const noBranch = repo({ meta: { owner: 'acme', repo: 'widget' } });

    const outcome = await refreshGithubRepo(SCOPE, noBranch, d);

    expect(outcome).toBe('ok');
    expect(client.calls.getRepo).toBe(1);
    expect(fetcher.calls.map((c) => c.url)).toEqual([
      'https://raw.githubusercontent.com/acme/widget/develop/README.md',
    ]);
    expect(cache.chunkCalls).toHaveLength(1);
  });

  it('a missing repo disables the resource with the lost-access detail and keeps old chunks', async () => {
    const client = new FakeClient();
    client.authenticated = false;
    client.repoDetail = new GitHubError('not-found', 'GitHub returned 404 for this URL.');
    const fetcher = new FakeFetcher(async (url: string) => okFile(url, 'readme text'));
    const { deps: d, store, cache } = deps(client, fetcher);
    const noBranch = repo({ meta: { owner: 'acme', repo: 'missing' } });
    store.rows.set('gh-acme-widget', noBranch);

    const outcome = await refreshGithubRepo(SCOPE, noBranch, d);

    expect(outcome).toBe('error');
    expect(store.rows.get('gh-acme-widget')).toMatchObject({ enabled: false });
    expect(fetcher.calls).toHaveLength(0);
    expect(cache.chunkCalls).toHaveLength(0);
    expect(store.fetchRecords[0]).toMatchObject({
      id: 'gh-acme-widget',
      status: 'failed',
      detail:
        "GitHub can't find this repository, or the token can't read it. It has been turned off, so its cached text is no longer searched.",
    });
  });

  it('a private repo with no token is turned off with no fetch at all', async () => {
    const client = new FakeClient();
    client.authenticated = false;
    const fetcher = new FakeFetcher(async (url: string) => okFile(url, 'readme text'));
    const { deps: d, store, cache } = deps(client, fetcher);
    const privateRepo = repo({
      meta: { owner: 'acme', repo: 'secret', branch: 'main', private: true },
    });
    store.rows.set('gh-acme-widget', privateRepo);

    const outcome = await refreshGithubRepo(SCOPE, privateRepo, d);

    expect(outcome).toBe('error');
    expect(store.rows.get('gh-acme-widget')).toMatchObject({ enabled: false });
    expect(fetcher.calls).toHaveLength(0);
    expect(client.calls.getRepo).toBe(0);
    expect(client.calls.listTree).toBe(0);
    expect(client.calls.getFileRaw).toBe(0);
    expect(cache.chunkCalls).toHaveLength(0);
    expect(store.fetchRecords[0]).toMatchObject({
      id: 'gh-acme-widget',
      status: 'failed',
      detail:
        'This repository is private and no GitHub token is saved. It has been turned off, so its cached text is no longer searched.',
    });
  });
});

describe('refreshGithubResource', () => {
  it('routes by kind and refuses anything else', async () => {
    const client = new FakeClient();
    client.orgRepos = [];
    const fetcher = new FakeFetcher(() => {
      throw new Error('no raw fetch');
    });
    const { deps: d, store } = deps(client, fetcher);
    store.rows.set('gh-acme', org());

    await expect(refreshGithubResource(SCOPE, org(), d)).resolves.toBe('ok');
    await expect(
      refreshGithubResource(
        SCOPE,
        { ...org(), id: 'web', kind: 'website', url: 'https://example.com' },
        d,
      ),
    ).rejects.toThrow();
  });
});
