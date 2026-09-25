import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { parseGuildId, type ClubResource } from '@bananasaurs/core';
import type { GuildScope } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
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
});
