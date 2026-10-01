import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, effectRepo, guildRepo, loggingRepo } from '@bananasaurs/storage';
import { parseGuildId, type Capability } from '@bananasaurs/core';
import { createServer, CSRF_HEADER, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { POLICY } from '../policy.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerWriteRoutes } from './write.js';

const GUILD = parseGuildId('111111111111111111');
const PASSWORD = 'correct horse battery staple';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';

let t: MigratedTestDatabase;
let clock: number;
let deps: HttpDeps;
let app: FastifyInstance;

const buildApp = (over: Partial<HttpDeps> = {}): FastifyInstance =>
  createServer({ deps: { ...deps, ...over }, registerRoutes: registerWriteRoutes });

const grant = (capabilities: readonly Capability[]): void => {
  const scope = t.scopes.forGuild(GUILD);
  for (const capability of capabilities) {
    authzRepo.grantAccountCapability(scope, {
      accountId: ACCOUNT,
      capability,
      grantedBy: 'test',
      now: clock,
    });
  }
};

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

  const instance = t.scopes.instance();
  accountRepo.createAccount(instance, {
    accountId: ACCOUNT,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), ACCOUNT);

  app = buildApp();
});

afterEach(async () => {
  await app.close();
  t.close();
});

const cookieFrom = (header: string | string[] | undefined): string => {
  const raw = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  return raw.split(';')[0] ?? '';
};

const signIn = async (target = app): Promise<{ cookie: string; csrf: string }> => {
  const response = await target.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'owner', password: PASSWORD },
  });
  const body = response.json<{ csrfToken: string }>();
  return { cookie: cookieFrom(response.headers['set-cookie']), csrf: body.csrfToken };
};

describe('POST /api/killswitch', () => {
  it('answers 401 with no session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/killswitch',
      payload: { on: true },
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 csrf without the header', async () => {
    grant(['killswitch.toggle']);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/killswitch',
      headers: { cookie },
      payload: { on: true },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'csrf' });
  });

  it('answers 403 no-grant without killswitch.toggle', async () => {
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/killswitch',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { on: true },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'no-grant' });
  });

  it('answers 400 for a malformed body', async () => {
    grant(['killswitch.toggle']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/killswitch',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { on: 'yes' },
    });
    expect(response.statusCode).toBe(400);
  });

  describe('the asymmetry (ADR 0029): enabling never needs re-authentication, disabling does', () => {
    it('enables without a fresh re-auth', async () => {
      grant(['killswitch.toggle']);
      const { cookie, csrf } = await signIn();
      // `reauthAt` is set at login, and `deps.now()` has not advanced, so the
      // session is still fresh here — advance the clock so a passing "enable"
      // test cannot be mistaken for a freshness check that never ran.
      clock += POLICY.reauthWindowMs + 1;

      const response = await app.inject({
        method: 'POST',
        url: '/api/killswitch',
        headers: { cookie, [CSRF_HEADER]: csrf },
        payload: { on: true },
      });
      expect(response.statusCode).toBe(200);
      expect(testPortsFor(t.scopes.forGuild(GUILD), () => clock).safetyState()?.killswitch).toBe(
        true,
      );
    });

    it('refuses to disable once the re-auth window has passed', async () => {
      grant(['killswitch.toggle']);
      const { cookie, csrf } = await signIn();
      clock += POLICY.reauthWindowMs + 1;

      const response = await app.inject({
        method: 'POST',
        url: '/api/killswitch',
        headers: { cookie, [CSRF_HEADER]: csrf },
        payload: { on: false },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: 'reauth-required' });
    });

    it('disables while re-auth is fresh', async () => {
      grant(['killswitch.toggle']);
      const { cookie, csrf } = await signIn();

      const response = await app.inject({
        method: 'POST',
        url: '/api/killswitch',
        headers: { cookie, [CSRF_HEADER]: csrf },
        payload: { on: false },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  it('records an audit row attributed to the dashboard account (ADR 0031)', async () => {
    grant(['killswitch.toggle']);
    const { cookie, csrf } = await signIn();

    await app.inject({
      method: 'POST',
      url: '/api/killswitch',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { on: false },
    });

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 10, sinceMs: undefined });
    const row = rows.find((r) => r.action === 'killswitch.disabled');
    expect(row?.actorType).toBe('dashboard');
    expect(row?.actorId).toBe(ACCOUNT);
    expect(row?.actorUnixUserClaimed).toBeNull();
    expect(row?.via).toBe('http');
  });

  it('answers 503 under BANANASAURS_READONLY, identically to an unauthenticated request', async () => {
    grant(['killswitch.toggle']);
    const { cookie, csrf } = await signIn();
    const readonlyApp = buildApp({ readonly: true, scopes: t.readonlyScopes });
    // Re-sign-in against the readonly app would fail (login is itself a
    // write); a session created against the writable app is still a valid row
    // in the same database, so it works for asserting the write route's own
    // readonly behaviour.
    const authed = await readonlyApp.inject({
      method: 'POST',
      url: '/api/killswitch',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { on: true },
    });
    expect(authed.statusCode).toBe(503);
    expect(authed.json()).toMatchObject({
      error: 'read-only',
      message: expect.any(String) as string,
    });
    await readonlyApp.close();
  });
});

describe('POST /api/log-routes', () => {
  const CHANNEL = '333333333333333333';
  const UNKNOWN_ROUTE_ID = '123e4567-e89b-12d3-a456-426614174000';

  const validBody = {
    channelId: CHANNEL,
    eventKinds: ['message_delete'],
  };

  it('answers 401 with no session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/log-routes',
      payload: validBody,
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 no-grant without logging.manage', async () => {
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/log-routes',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: validBody,
    });
    expect(response.statusCode).toBe(403);
  });

  it.each([
    { name: 'an unknown event kind', body: { channelId: CHANNEL, eventKinds: ['not-a-real-kind'] } },
    { name: 'an empty event-kind list', body: { channelId: CHANNEL, eventKinds: [] } },
    { name: 'a non-snowflake channel', body: { channelId: 'not-a-channel', eventKinds: ['message_delete'] } },
    {
      name: 'the destination among the exclusions',
      body: { channelId: CHANNEL, eventKinds: ['message_delete'], excludedChannelIds: [CHANNEL] },
    },
  ])('answers 400 for $name', async ({ body }) => {
    grant(['logging.manage']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/log-routes',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: body,
    });
    expect(response.statusCode).toBe(400);
  });

  it('creates the route and records an attributed audit row', async () => {
    grant(['logging.manage']);
    const { cookie, csrf } = await signIn();

    const response = await app.inject({
      method: 'POST',
      url: '/api/log-routes',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { ...validBody, name: 'mod log', includeContent: false },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ ok: boolean; route: { routeId: string } }>();
    expect(body.ok).toBe(true);

    const routes = testPortsFor(t.scopes.forGuild(GUILD), () => clock).listRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      routeId: body.route.routeId,
      name: 'mod log',
      channelId: CHANNEL,
      includeContent: false,
      enabled: true,
      eventKinds: ['message_delete'],
    });

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 10, sinceMs: undefined });
    const row = rows.find((r) => r.action === 'log_route.created');
    expect(row?.actorType).toBe('dashboard');
    expect(row?.actorId).toBe(ACCOUNT);
    expect(row?.via).toBe('http');
    expect(JSON.parse(row?.after ?? 'null')).toMatchObject({
      name: 'mod log',
      channelId: CHANNEL,
      eventKinds: ['message_delete'],
    });
  });

  it('answers 503 under BANANASAURS_READONLY', async () => {
    grant(['logging.manage']);
    const { cookie, csrf } = await signIn();
    const readonlyApp = buildApp({ readonly: true, scopes: t.readonlyScopes });
    const response = await readonlyApp.inject({
      method: 'POST',
      url: '/api/log-routes',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: validBody,
    });
    expect(response.statusCode).toBe(503);
    await readonlyApp.close();
  });

  describe('PUT /api/log-routes/:routeId', () => {
    const seedRoute = (): string =>
      loggingRepo.createRoute(t.scopes.forGuild(GUILD), {
        name: 'old',
        channelId: CHANNEL,
        includeContent: true,
        enabled: true,
        eventKinds: ['message_delete'],
        excludedChannelIds: [],
        nowMs: clock,
      }).routeId;

    it('answers 401 with no session', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/log-routes/${UNKNOWN_ROUTE_ID}`,
        payload: validBody,
      });
      expect(response.statusCode).toBe(401);
    });

    it('answers 403 no-grant without logging.manage', async () => {
      const routeId = seedRoute();
      const { cookie, csrf } = await signIn();
      const response = await app.inject({
        method: 'PUT',
        url: `/api/log-routes/${routeId}`,
        headers: { cookie, [CSRF_HEADER]: csrf },
        payload: validBody,
      });
      expect(response.statusCode).toBe(403);
    });

    it('answers 400 for a route id that is not a UUID', async () => {
      grant(['logging.manage']);
      const { cookie, csrf } = await signIn();
      const response = await app.inject({
        method: 'PUT',
        url: '/api/log-routes/abc',
        headers: { cookie, [CSRF_HEADER]: csrf },
        payload: validBody,
      });
      expect(response.statusCode).toBe(400);
    });

    it('answers 400 for a bad body', async () => {
      grant(['logging.manage']);
      const routeId = seedRoute();
      const { cookie, csrf } = await signIn();
      const response = await app.inject({
        method: 'PUT',
        url: `/api/log-routes/${routeId}`,
        headers: { cookie, [CSRF_HEADER]: csrf },
        payload: { channelId: CHANNEL, eventKinds: ['not-a-real-kind'] },
      });
      expect(response.statusCode).toBe(400);
    });

    it('answers 404 for an unknown route id', async () => {
      grant(['logging.manage']);
      const { cookie, csrf } = await signIn();
      const response = await app.inject({
        method: 'PUT',
        url: `/api/log-routes/${UNKNOWN_ROUTE_ID}`,
        headers: { cookie, [CSRF_HEADER]: csrf },
        payload: validBody,
      });
      expect(response.statusCode).toBe(404);
    });

    it('replaces the route and records before and after', async () => {
      grant(['logging.manage']);
      const routeId = seedRoute();
      const { cookie, csrf } = await signIn();

      const response = await app.inject({
        method: 'PUT',
        url: `/api/log-routes/${routeId}`,
        headers: { cookie, [CSRF_HEADER]: csrf },
        payload: { channelId: '444444444444444444', eventKinds: ['member_join'], name: 'new' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true });

      expect(loggingRepo.getRoute(t.scopes.forGuild(GUILD), routeId)).toMatchObject({
        name: 'new',
        channelId: '444444444444444444',
        eventKinds: ['member_join'],
      });

      const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), {
        limit: 10,
        sinceMs: undefined,
      });
      const row = rows.find((r) => r.action === 'log_route.updated');
      expect(row?.actorType).toBe('dashboard');
      expect(row?.subjectId).toBe(routeId);
      expect(JSON.parse(row?.before ?? 'null')).toMatchObject({ name: 'old' });
      expect(JSON.parse(row?.after ?? 'null')).toMatchObject({ name: 'new' });
    });

    it('keeps a disabled route disabled when the body omits enabled', async () => {
      grant(['logging.manage']);
      const routeId = loggingRepo.createRoute(t.scopes.forGuild(GUILD), {
        name: 'old',
        channelId: CHANNEL,
        includeContent: true,
        enabled: false,
        eventKinds: ['message_delete'],
        excludedChannelIds: [],
        nowMs: clock,
      }).routeId;
      const { cookie, csrf } = await signIn();

      const response = await app.inject({
        method: 'PUT',
        url: `/api/log-routes/${routeId}`,
        headers: { cookie, [CSRF_HEADER]: csrf },
        payload: { channelId: '444444444444444444', eventKinds: ['member_join'], name: 'new' },
      });
      expect(response.statusCode).toBe(200);
      expect(loggingRepo.getRoute(t.scopes.forGuild(GUILD), routeId)).toMatchObject({
        enabled: false,
      });
    });

    it('enables a disabled route when the body says enabled: true', async () => {
      grant(['logging.manage']);
      const routeId = loggingRepo.createRoute(t.scopes.forGuild(GUILD), {
        name: 'old',
        channelId: CHANNEL,
        includeContent: true,
        enabled: false,
        eventKinds: ['message_delete'],
        excludedChannelIds: [],
        nowMs: clock,
      }).routeId;
      const { cookie, csrf } = await signIn();

      const response = await app.inject({
        method: 'PUT',
        url: `/api/log-routes/${routeId}`,
        headers: { cookie, [CSRF_HEADER]: csrf },
        payload: {
          channelId: '444444444444444444',
          eventKinds: ['member_join'],
          name: 'new',
          enabled: true,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(loggingRepo.getRoute(t.scopes.forGuild(GUILD), routeId)).toMatchObject({
        enabled: true,
      });
    });
  });

  describe('DELETE /api/log-routes/:routeId', () => {
    const seedRoute = (): string =>
      loggingRepo.createRoute(t.scopes.forGuild(GUILD), {
        name: 'old',
        channelId: CHANNEL,
        includeContent: true,
        enabled: true,
        eventKinds: ['message_delete'],
        excludedChannelIds: [],
        nowMs: clock,
      }).routeId;

    it('answers 401 with no session', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/log-routes/${UNKNOWN_ROUTE_ID}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('answers 403 no-grant without logging.manage', async () => {
      const routeId = seedRoute();
      const { cookie, csrf } = await signIn();
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/log-routes/${routeId}`,
        headers: { cookie, [CSRF_HEADER]: csrf },
      });
      expect(response.statusCode).toBe(403);
    });

    it('answers 400 for a route id that is not a UUID', async () => {
      grant(['logging.manage']);
      const { cookie, csrf } = await signIn();
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/log-routes/abc',
        headers: { cookie, [CSRF_HEADER]: csrf },
      });
      expect(response.statusCode).toBe(400);
    });

    it('answers 404 for an unknown route id', async () => {
      grant(['logging.manage']);
      const { cookie, csrf } = await signIn();
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/log-routes/${UNKNOWN_ROUTE_ID}`,
        headers: { cookie, [CSRF_HEADER]: csrf },
      });
      expect(response.statusCode).toBe(404);
    });

    it('removes the route and records what it was', async () => {
      grant(['logging.manage']);
      const routeId = seedRoute();
      const { cookie, csrf } = await signIn();

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/log-routes/${routeId}`,
        headers: { cookie, [CSRF_HEADER]: csrf },
      });
      expect(response.statusCode).toBe(200);
      expect(loggingRepo.getRoute(t.scopes.forGuild(GUILD), routeId)).toBeUndefined();

      const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), {
        limit: 10,
        sinceMs: undefined,
      });
      const row = rows.find((r) => r.action === 'log_route.deleted');
      expect(row?.actorType).toBe('dashboard');
      expect(row?.subjectId).toBe(routeId);
      expect(JSON.parse(row?.before ?? 'null')).toMatchObject({ name: 'old' });
    });
  });
});
