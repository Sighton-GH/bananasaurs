import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { parseGuildId, type Chunk, type ClubResource, type Logger } from '@bananasaurs/core';
import type { GuildScope } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import type {
  GitHubClient,
  GitHubFileResult,
  GitHubOrgRepos,
  GitHubRepoDetail,
  GitHubRepoSummary,
  GitHubTreeResult,
} from '../assistant/github-client.js';
import type {
  GithubCacheStore,
  GithubRefreshDeps,
  GithubResourceStore,
  StoredDoc,
} from '../assistant/github-refresh.js';
import type {
  ResourceRefreshDeps,
  ResourceRefreshFetcher,
  ResourceRefreshRepo,
  UpsertDocumentInput,
} from '../assistant/resource-refresh.js';
import { resourceRefreshHandler } from './resource-refresh.js';

const GUILD = parseGuildId('111111111111111111');
const logger = pino({ level: 'silent' });

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
  url: 'https://example.com/one',
  kind: 'website',
  enabled: true,
  reviewedAt: new Date(0).toISOString(),
  ...over,
});

class FakeRepo implements ResourceRefreshRepo {
  readonly docs = new Map<string, UpsertDocumentInput>();
  getDocumentByUrl() {
    return undefined;
  }
  upsertDocument(_scope: GuildScope, d: UpsertDocumentInput): void {
    this.docs.set(d.docId, d);
  }
  replaceChunks(): void {
    /* not asserted here */
  }
  deleteStaleDocuments(): void {
    /* not asserted here */
  }
}

const okResult = (url: string) => ({
  ok: true as const,
  evidence: {
    url,
    mediaType: 'text/plain',
    text: `text for ${url}`,
    fetchedAt: 1,
    trust: 'untrusted-reviewed-resource' as const,
  },
  cache: 'miss' as const,
});

const runCtx = { jobId: 1, attempts: 1, cursor: null, saveCursor: () => undefined };

describe('resourceRefreshHandler', () => {
  it('refreshes one resource by id, and does nothing for a resource id that no longer exists', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(okResult(url)));
    const fetcher: ResourceRefreshFetcher = { fetch: fetchMock };
    const repo = new FakeRepo();
    const refresh: ResourceRefreshDeps = { fetcher, repo, now: () => 1_000 };
    const resources = [resource({ id: 'res-1' }), resource({ id: 'res-2' })];
    const handler = resourceRefreshHandler({
      scope: SCOPE,
      listResources: () => resources,
      refresh,
      logger,
    });

    await handler.run({ resourceId: 'res-1', reason: 'manual' }, runCtx);
    expect(repo.docs.size).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A resourceId that no longer exists is a no-op, not a failure.
    await handler.run({ resourceId: 'no-such-resource', reason: 'manual' }, runCtx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes every resource, enabled or not, when resourceId is absent', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(okResult(url)));
    const fetcher: ResourceRefreshFetcher = { fetch: fetchMock };
    const repo = new FakeRepo();
    const refresh: ResourceRefreshDeps = { fetcher, repo, now: () => 1_000 };
    const resources = [
      resource({ id: 'res-1', enabled: true }),
      resource({ id: 'res-2', url: 'https://example.com/two', enabled: false }),
    ];
    const handler = resourceRefreshHandler({
      scope: SCOPE,
      listResources: () => resources,
      refresh,
      logger,
    });

    await handler.run({ reason: 'hourly' }, runCtx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(repo.docs.size).toBe(2);
  });

  it('validates its payload with resourceRefreshPayload', () => {
    const handler = resourceRefreshHandler({
      scope: SCOPE,
      listResources: () => [],
      refresh: { fetcher: { fetch: vi.fn() }, repo: new FakeRepo(), now: () => 1 },
      logger,
    });
    expect(() => handler.payload.parse({ reason: 'not-a-reason' })).toThrow();
    expect(handler.payload.parse({ reason: 'hourly' })).toEqual({ reason: 'hourly' });
  });

  it('the single-resource log carries code and httpStatus for a failed fetch', async () => {
    const info = vi.fn();
    const capturing = {
      info,
      warn() {},
      error() {},
      debug() {},
      fatal() {},
      trace() {},
    } as unknown as Logger;
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      code: 'challenge',
      message: "The site's Cloudflare bot protection challenged Bananasaurs.",
      httpStatus: 403,
      host: 'example.com',
    });
    const repo = new FakeRepo();
    const handler = resourceRefreshHandler({
      scope: SCOPE,
      listResources: () => [resource({ id: 'res-1', url: 'https://example.com/guide' })],
      refresh: { fetcher: { fetch }, repo, now: () => 1_000 },
      logger: capturing,
    });

    await handler.run({ resourceId: 'res-1', reason: 'manual' }, runCtx);

    // The code persists on the document row.
    const [doc] = [...repo.docs.values()];
    expect(doc).toMatchObject({ status: 'error', errorCode: 'challenge' });
    // And the log line names it: fields plus the "(challenge)" suffix.
    expect(info).toHaveBeenCalledTimes(1);
    const [fields, message] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({
      resourceId: 'res-1',
      outcome: 'error',
      code: 'challenge',
      httpStatus: 403,
    });
    expect(message).toBe('resource cache: refreshed res-1 -> error (challenge) (reason=manual)');
  });

  it('the GitHub single-resource log carries resourceId and outcome', async () => {
    const info = vi.fn();
    const capturing = {
      info,
      warn() {},
      error() {},
      debug() {},
      fatal() {},
      trace() {},
    } as unknown as Logger;
    const handler = resourceRefreshHandler({
      scope: SCOPE,
      listResources: () => [
        resource({ id: 'gh-1', url: 'https://github.com/acme/widget', kind: 'github-repo' }),
      ],
      refresh: { fetcher: { fetch: vi.fn() }, repo: new FakeRepo(), now: () => 1_000 },
      logger: capturing,
    });

    await handler.run({ resourceId: 'gh-1', reason: 'manual' }, runCtx);

    // No github deps wired: the GitHub path refreshes as `skipped`.
    expect(info).toHaveBeenCalledTimes(1);
    const [fields, message] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ resourceId: 'gh-1', outcome: 'skipped' });
    expect(message).toBe('resource cache: refreshed gh-1 -> skipped (reason=manual)');
  });
});

describe('resourceRefreshHandler — new org children refresh in the same run (ADR 0084)', () => {
  const ghOrg = (over: Partial<ClubResource> = {}): ClubResource =>
    resource({
      id: 'gh-acme',
      title: 'acme',
      url: 'https://github.com/acme',
      kind: 'github-org',
      meta: { owner: 'acme' },
      ...over,
    });

  const repoSummary = (name: string): GitHubRepoSummary => ({
    name,
    description: `${name} description`,
    defaultBranch: 'main',
    fork: false,
    archived: false,
    private: false,
  });

  class FakeGithubClient implements GitHubClient {
    authenticated = true;
    orgRepos: GitHubRepoSummary[] = [];
    readonly repoCalls: string[] = [];

    async listOrgRepos(_owner: string): Promise<GitHubOrgRepos> {
      return { repos: this.orgRepos, truncated: false };
    }
    async getRepo(_owner: string, repo: string): Promise<GitHubRepoDetail> {
      this.repoCalls.push(repo);
      return { defaultBranch: 'main', description: null, private: false };
    }
    async listTree(): Promise<GitHubTreeResult> {
      return { entries: [], truncated: false };
    }
    async getFileRaw(): Promise<GitHubFileResult> {
      throw new Error('public repos never use getFileRaw');
    }
  }

  class FakeGithubStore implements GithubResourceStore {
    readonly rows = new Map<string, ClubResource>();
    readonly fetchRecords: string[] = [];

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
      _input: {
        readonly status: 'ok' | 'failed' | 'blocked';
        readonly at: number;
        readonly detail: string;
      },
    ): void {
      this.fetchRecords.push(id);
    }
  }

  class FakeGithubCache implements GithubCacheStore {
    getDocumentByUrl(_scope: GuildScope, _url: string): StoredDoc | undefined {
      return undefined;
    }
    listDocuments(_scope: GuildScope, _resourceId: string): readonly StoredDoc[] {
      return [];
    }
    upsertDocument(): void {
      /* not asserted here */
    }
    replaceChunks(
      _scope: GuildScope,
      _docId: string,
      _resourceId: string,
      _chunks: readonly Chunk[],
    ): void {
      /* not asserted here */
    }
    deleteDocument(): void {
      /* not asserted here */
    }
  }

  const capturingLogger = () => {
    const info = vi.fn();
    const capturing = {
      info,
      warn() {},
      error() {},
      debug() {},
      fatal() {},
      trace() {},
    } as unknown as Logger;
    return { info, capturing };
  };

  const setup = () => {
    const client = new FakeGithubClient();
    client.orgRepos = [repoSummary('widget')];
    const store = new FakeGithubStore();
    store.rows.set('gh-acme', ghOrg());
    const github: GithubRefreshDeps = {
      client,
      fetcher: { fetch: (url: string) => Promise.resolve(okResult(url)) },
      store,
      cache: new FakeGithubCache(),
      now: () => 1_000,
    };
    return { client, store, github };
  };

  it('a sweep refreshes an org-created child in the same run and counts it', async () => {
    const { info, capturing } = capturingLogger();
    const { client, store, github } = setup();
    const handler = resourceRefreshHandler({
      scope: SCOPE,
      listResources: (scope) => store.listResources(scope),
      refresh: { fetcher: { fetch: vi.fn() }, repo: new FakeRepo(), now: () => 1_000 },
      github,
      logger: capturing,
    });

    await handler.run({ reason: 'hourly' }, runCtx);

    expect(store.rows.has('gh-acme-widget')).toBe(true);
    // The new child was refreshed in this same run, not left for the next sweep.
    expect(client.repoCalls).toEqual(['widget']);
    expect(store.fetchRecords).toEqual(['gh-acme', 'gh-acme-widget']);
    expect(info).toHaveBeenCalledTimes(1);
    const [fields, message] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ count: 2 });
    expect(message).toBe('resource cache: refreshed 2 resource(s) (reason=hourly)');
  });

  it('an existing child is not refreshed twice in one sweep', async () => {
    const { client, store, github } = setup();
    store.rows.set(
      'gh-acme-widget',
      resource({
        id: 'gh-acme-widget',
        title: 'acme/widget',
        url: 'https://github.com/acme/widget',
        kind: 'github-repo',
        parentId: 'gh-acme',
        meta: { owner: 'acme', repo: 'widget', branch: 'main', autoDiscovered: true },
      }),
    );
    const handler = resourceRefreshHandler({
      scope: SCOPE,
      listResources: (scope) => store.listResources(scope),
      refresh: { fetcher: { fetch: vi.fn() }, repo: new FakeRepo(), now: () => 1_000 },
      github,
      logger,
    });

    await handler.run({ reason: 'hourly' }, runCtx);

    // Once from the sweep loop; the new-children pass skips it.
    expect(client.repoCalls).toEqual(['widget']);
    expect(store.fetchRecords).toEqual(['gh-acme', 'gh-acme-widget']);
  });

  it('a single-org refresh refreshes the new child in the same run', async () => {
    const { info, capturing } = capturingLogger();
    const { client, store, github } = setup();
    const handler = resourceRefreshHandler({
      scope: SCOPE,
      listResources: (scope) => store.listResources(scope),
      refresh: { fetcher: { fetch: vi.fn() }, repo: new FakeRepo(), now: () => 1_000 },
      github,
      logger: capturing,
    });

    await handler.run({ resourceId: 'gh-acme', reason: 'manual' }, runCtx);

    expect(store.rows.has('gh-acme-widget')).toBe(true);
    expect(client.repoCalls).toEqual(['widget']);
    expect(info).toHaveBeenCalledTimes(2);
    const [, orgMessage] = info.mock.calls[0] as [Record<string, unknown>, string];
    const [childFields, childMessage] = info.mock.calls[1] as [Record<string, unknown>, string];
    expect(orgMessage).toBe('resource cache: refreshed gh-acme -> ok (reason=manual)');
    expect(childFields).toMatchObject({ resourceId: 'gh-acme-widget' });
    expect(childMessage).toBe(
      'resource cache: refreshed gh-acme-widget -> not-modified (reason=manual)',
    );
  });
});
