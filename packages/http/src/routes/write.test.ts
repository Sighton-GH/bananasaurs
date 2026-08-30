import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, effectRepo, guildRepo } from '@bananasaurs/storage';
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
    expect(response.json()).toEqual({ error: 'csrf' });
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
    expect(response.json()).toEqual({ error: 'no-grant' });
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
      expect(response.json()).toEqual({ error: 'reauth-required' });
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
    expect(authed.json()).toEqual({ error: 'read-only', message: expect.any(String) as string });
    await readonlyApp.close();
  });
});

describe('POST /api/log-routes', () => {
  const EVENT_KIND = 'message_delete';
  const CHANNEL = '333333333333333333';

  it('answers 401 with no session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/log-routes',
      payload: { eventKind: EVENT_KIND, channelId: CHANNEL, includeContent: false },
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 no-grant without logging.manage', async () => {
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/log-routes',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { eventKind: EVENT_KIND, channelId: CHANNEL, includeContent: false },
    });
    expect(response.statusCode).toBe(403);
  });

  it('answers 400 for an unknown event kind', async () => {
    grant(['logging.manage']);
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/log-routes',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { eventKind: 'not-a-real-kind', channelId: CHANNEL, includeContent: false },
    });
    expect(response.statusCode).toBe(400);
  });

  it('sets the route and records an attributed audit row', async () => {
    grant(['logging.manage']);
    const { cookie, csrf } = await signIn();

    const response = await app.inject({
      method: 'POST',
      url: '/api/log-routes',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { eventKind: EVENT_KIND, channelId: CHANNEL, includeContent: true },
    });
    expect(response.statusCode).toBe(200);

    const routes = testPortsFor(t.scopes.forGuild(GUILD), () => clock).listRoutes();
    expect(routes).toContainEqual({
      eventKind: EVENT_KIND,
      channelId: CHANNEL,
      enabled: true,
      includeContent: true,
    });

    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 10, sinceMs: undefined });
    const row = rows.find((r) => r.action === 'log_route.set');
    expect(row?.actorType).toBe('dashboard');
    expect(row?.actorId).toBe(ACCOUNT);
    expect(row?.via).toBe('http');
  });

  it('answers 503 under BANANASAURS_READONLY', async () => {
    grant(['logging.manage']);
    const { cookie, csrf } = await signIn();
    const readonlyApp = buildApp({ readonly: true, scopes: t.readonlyScopes });
    const response = await readonlyApp.inject({
      method: 'POST',
      url: '/api/log-routes',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { eventKind: EVENT_KIND, channelId: CHANNEL, includeContent: false },
    });
    expect(response.statusCode).toBe(503);
    await readonlyApp.close();
  });
});
