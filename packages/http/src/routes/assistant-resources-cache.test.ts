import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseGuildId, type Capability, type ClubResource } from '@bananasaurs/core';
import {
  accountRepo,
  assistantRepo,
  authzRepo,
  effectRepo,
  guildRepo,
  jobRepo,
  resourceCacheRepo,
} from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createServer, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerAssistantResourceCacheRoutes } from './assistant-resources-cache.js';

const GUILD = parseGuildId('111111111111111111');
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
let t: MigratedTestDatabase;
let deps: HttpDeps;
let app: FastifyInstance;
let clock: number;

const cookieFrom = (header: string | string[] | undefined): string =>
  (Array.isArray(header) ? (header[0] ?? '') : (header ?? '')).split(';')[0] ?? '';
const signIn = async (): Promise<{ cookie: string; csrf: string }> => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'owner', password: PASSWORD, guildId: GUILD },
  });
  return {
    cookie: cookieFrom(response.headers['set-cookie']),
    csrf: response.json<{ csrfToken: string }>().csrfToken,
  };
};
const grant = (capability: Capability): void =>
  authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD), {
    accountId: ACCOUNT,
    capability,
    grantedBy: 'test',
    now: clock,
  });

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

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  deps = {
    scopes: t.scopes,
    now: () => clock,
    guildIds: [GUILD],
    logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} } as never,
    readonly: false,
    portsFor: (scope) => testPortsFor(scope, () => clock),
    instance: testInstanceFor(t.scopes.instance(), () => clock),
  };
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'guild', now: clock });
  accountRepo.createAccount(t.scopes.instance(), {
    accountId: ACCOUNT,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), ACCOUNT);
  app = createServer({ deps, registerRoutes: registerAssistantResourceCacheRoutes });
});
afterEach(async () => {
  await app.close();
  t.close();
});

describe('assistant resource cache routes', () => {
  it('requires config.read for freshness and config.write for both refresh routes', async () => {
    const { cookie, csrf } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.putResource(scope, resource());

    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/assistant/resources/freshness',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/assistant/resources/res-1/refresh',
          headers: { cookie, 'x-bananasaurs-csrf': csrf },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/assistant/resources/refresh',
          headers: { cookie, 'x-bananasaurs-csrf': csrf },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('GET freshness returns resourceCacheRepo.resourceFreshness for this guild only', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.putResource(scope, resource());
    resourceCacheRepo.upsertDocument(scope, {
      resourceId: 'res-1',
      docId: 'd_test',
      url: 'https://example.com/guide',
      path: '/guide',
      title: 'Guide',
      contentHash: 'h',
      fetchedAt: clock,
      bytes: 42,
      status: 'ok',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/assistant/resources/freshness',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ freshness: { resourceId: string; bytes: number }[] }>();
    expect(body.freshness).toEqual([expect.objectContaining({ resourceId: 'res-1', bytes: 42 })]);
  });

  it('GET freshness reports githubTokenConfigured false when no token is saved', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    deps.assistantProviderConfig = { githubTokenConfigured: () => false };

    const res = await app.inject({
      method: 'GET',
      url: '/api/assistant/resources/freshness',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ githubTokenConfigured?: boolean }>().githubTokenConfigured).toBe(false);
  });

  it('GET freshness reports githubTokenConfigured true when a token is saved', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    deps.assistantProviderConfig = { githubTokenConfigured: () => true };

    const res = await app.inject({
      method: 'GET',
      url: '/api/assistant/resources/freshness',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ githubTokenConfigured?: boolean }>().githubTokenConfigured).toBe(true);
  });

  it('GET freshness omits githubTokenConfigured when the server cannot tell', async () => {
    grant('config.read');
    const { cookie } = await signIn();

    const res = await app.inject({
      method: 'GET',
      url: '/api/assistant/resources/freshness',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Record<string, unknown>>()).not.toHaveProperty('githubTokenConfigured');
  });

  it('GET freshness explains a challenge failure with the resource-failure catalog text', async () => {
    grant('config.read');
    const { cookie } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.putResource(scope, resource());
    resourceCacheRepo.upsertDocument(scope, {
      resourceId: 'res-1',
      docId: 'd_test',
      url: 'https://example.com/guide',
      path: '/guide',
      title: 'Guide',
      contentHash: '',
      fetchedAt: clock,
      bytes: 0,
      status: 'error',
      error: "The site's Cloudflare bot protection challenged Bananasaurs.",
      errorCode: 'challenge',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/assistant/resources/freshness',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      freshness: { resourceId: string; errorCode: string; errorExplain: { title: string } }[];
    }>();
    expect(body.freshness).toEqual([
      expect.objectContaining({
        resourceId: 'res-1',
        errorCode: 'challenge',
        errorExplain: expect.objectContaining({
          title: "The site's bot protection blocked Bananasaurs",
        }),
      }),
    ]);
  });

  it('POST /:id/refresh enqueues a manual resource_refresh job for that resource and audits it, 404 for an unknown id', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.putResource(scope, resource());

    const res = await app.inject({
      method: 'POST',
      url: '/api/assistant/resources/res-1/refresh',
      headers: { cookie, 'x-bananasaurs-csrf': csrf },
    });
    expect(res.statusCode).toBe(200);

    const jobs = jobRepo.listJobs(scope, {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toBe(JSON.stringify({ resourceId: 'res-1', reason: 'manual' }));

    const audit = effectRepo.tailAudit(scope, {});
    expect(audit[0]).toMatchObject({
      action: 'assistant_resource.refresh_requested',
      subjectType: 'assistant_resource',
      subjectId: 'res-1',
    });

    const missing = await app.inject({
      method: 'POST',
      url: '/api/assistant/resources/no-such-resource/refresh',
      headers: { cookie, 'x-bananasaurs-csrf': csrf },
    });
    expect(missing.statusCode).toBe(404);
    // The 404 must not have enqueued anything.
    expect(jobRepo.listJobs(scope, {})).toHaveLength(1);
  });

  it('POST /refresh (Update all) enqueues one guild-wide manual job with no resourceId', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const scope = t.scopes.forGuild(GUILD);

    const res = await app.inject({
      method: 'POST',
      url: '/api/assistant/resources/refresh',
      headers: { cookie, 'x-bananasaurs-csrf': csrf },
    });
    expect(res.statusCode).toBe(200);

    const jobs = jobRepo.listJobs(scope, {});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toBe(JSON.stringify({ reason: 'manual' }));
  });

  it('a second manual refresh in the same minute collapses into the one already queued', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    assistantRepo.putResource(scope, resource());

    await app.inject({
      method: 'POST',
      url: '/api/assistant/resources/res-1/refresh',
      headers: { cookie, 'x-bananasaurs-csrf': csrf },
    });
    await app.inject({
      method: 'POST',
      url: '/api/assistant/resources/res-1/refresh',
      headers: { cookie, 'x-bananasaurs-csrf': csrf },
    });
    expect(jobRepo.listJobs(scope, {})).toHaveLength(1);
  });
});
