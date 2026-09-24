import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, guildRepo } from '@bananasaurs/storage';
import { CAPABILITIES, createLogger, parseGuildId } from '@bananasaurs/core';
import { issueBootstrapTokenIfNeeded } from './auth.js';
import { createServer, CSRF_HEADER, SESSION_COOKIE, type HttpDeps } from './server.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { hashPassword } from './secrets.js';
import { POLICY } from './policy.js';
import { testInstanceFor, testPortsFor } from './test-support.js';

const GUILD = parseGuildId('111111111111111111');
const PASSWORD = 'correct horse battery staple';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';

let t: MigratedTestDatabase;
let clock: number;
let deps: HttpDeps;
let app: FastifyInstance;

const logger = createLogger({ level: 'fatal', env: 'development' });

const build = (over: Partial<HttpDeps> = {}): FastifyInstance =>
  createServer({
    deps: { ...deps, ...over },
    registerRoutes: (instance, guard) => {
      // A stand-in for the read and write endpoints slice 14's second half
      // adds. It exists to prove the guard, not to be the dashboard.
      instance.get('/api/probe', (request, reply) => {
        const session = guard.require(request, reply);
        if (session === undefined) return reply;
        return reply.send({ accountId: session.accountId, guildId: session.guildId });
      });
      instance.post('/api/probe-write', (request, reply) => {
        const session = guard.require(request, reply);
        if (session === undefined) return reply;
        return reply.send({ ok: true, accountId: session.accountId });
      });
      instance.post('/api/probe-destructive', (request, reply) => {
        const session = guard.requireFresh(request, reply);
        if (session === undefined) return reply;
        return reply.send({ ok: true });
      });
    },
  });

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  deps = {
    scopes: t.scopes,
    now: () => clock,
    guildIds: [GUILD],
    logger,
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
  const scope = t.scopes.forGuild(GUILD);
  accountRepo.grantGuildAccess(scope, ACCOUNT);
  accountRepo.grantAllCapabilities(scope, {
    accountId: ACCOUNT,
    capabilities: CAPABILITIES,
    grantedBy: 'test',
    now: clock,
  });

  app = build();
});
afterEach(async () => {
  await app.close();
  t.close();
});

interface LoggedIn {
  cookie: string;
  csrf: string;
}

const cookieFrom = (header: string | string[] | undefined): string => {
  const raw = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  return raw.split(';')[0] ?? '';
};

const signIn = async (target = app, headers: Record<string, string> = {}): Promise<LoggedIn> => {
  const response = await target.inject({
    method: 'POST',
    url: '/api/login',
    headers,
    payload: { username: 'owner', password: PASSWORD },
  });
  const body = response.json<{ csrfToken: string }>();
  return { cookie: cookieFrom(response.headers['set-cookie']), csrf: body.csrfToken };
};

describe('login sets a session cookie with the right attributes (ADR 0029)', () => {
  it('answers 200 and sets the cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=`);
  });

  it('marks the cookie HttpOnly, so a script cannot read it', async () => {
    // Load-bearing for the CSRF design: the token is derived from the cookie,
    // so an attacker who could read the cookie could compute the CSRF token.
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: PASSWORD },
    });
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly');
  });

  it('marks the cookie SameSite=Lax', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: PASSWORD },
    });
    expect(String(response.headers['set-cookie'])).toContain('SameSite=Lax');
  });

  it('does not mark the cookie Secure on a direct request, because the bind is loopback http', async () => {
    // ADR 0029, amended by M6-D2. No `X-Forwarded-Proto` header means a direct
    // loopback client (`ssh -L`, Tailscale): a Secure cookie would never be
    // stored there, and the failure would look like a login that succeeds and
    // then bounces.
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: PASSWORD },
    });
    expect(String(response.headers['set-cookie'])).not.toContain('Secure');
  });

  it('marks the cookie Secure when the request arrived over HTTPS (M6-D2)', async () => {
    // The tunnel path: cloudflared connects to 127.0.0.1:8787 over plain
    // http, so `request.protocol` is always `http` (trustProxy stays off,
    // M6-D3) and only `X-Forwarded-Proto: https` says the browser used HTTPS.
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { username: 'owner', password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['set-cookie'])).toContain('; Secure;');
  });

  it('the logout clear matches the set: no Secure on a direct request', async () => {
    const { cookie, csrf } = await signIn();
    const out = await app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(out.statusCode).toBe(200);
    const cleared = String(out.headers['set-cookie']);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).not.toContain('Secure');
  });

  it('the logout clear matches the set: Secure when the request arrived over HTTPS', async () => {
    // A clear without `Secure` does not remove a `Secure` cookie, so without
    // this the HTTPS logout would leave the session cookie in the browser.
    const fwd = { 'x-forwarded-proto': 'https' };
    const { cookie, csrf } = await signIn(app, fwd);
    const out = await app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { cookie, [CSRF_HEADER]: csrf, ...fwd },
    });
    expect(out.statusCode).toBe(200);
    const cleared = String(out.headers['set-cookie']);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('; Secure;');
  });

  it('bounds the cookie by the session lifetime', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: PASSWORD },
    });
    expect(String(response.headers['set-cookie'])).toContain(
      `Max-Age=${String(POLICY.sessionTtlMs / 1000)}`,
    );
  });

  it('answers 401 for a wrong password and sets no cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: 'wrong' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('answers 429 once the account is locked', async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: 'owner', password: 'wrong' },
      });
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: PASSWORD },
    });
    expect(response.statusCode).toBe(429);
  });

  it('answers 400 for a malformed body rather than reaching the hasher', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'Owner With Spaces', password: PASSWORD },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a form body at /api/login exactly as before Task 4 (login-CSRF guard)', async () => {
    // Task 4 fix 1: the OAuth form parser lives in an encapsulated child
    // context. Registered on the root instance it also parsed form bodies for
    // /api/login — an unauthenticated route with no origin check, which a
    // cross-origin HTML <form> can reach without a CORS preflight while it
    // can never send application/json. Parsing the body turned a route that
    // was unreachable from such a page into a login CSRF: a silent sign-in
    // to the attacker's account. Measured pre-fix: 500 without the OAuth
    // routes, 401 with the root parser. Task 2's error-handler change keeps
    // Fastify's own 4xx statuses instead of flattening them to 500, so the
    // unsupported-media-type refusal now answers 415 with its code — still a
    // refusal, which is what this test pins, so the leak cannot return
    // quietly.
    const withOAuth = createServer({
      deps: { ...deps, mcpPublicUrl: 'https://bot.test' },
      registerRoutes: registerOAuthRoutes,
    });
    try {
      const response = await withOAuth.inject({
        method: 'POST',
        url: '/api/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ username: 'owner', password: 'wrong' }).toString(),
      });
      expect(response.statusCode).toBe(415);
      expect(response.json()).toEqual({ error: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' });
    } finally {
      await withOAuth.close();
    }
  });
});

describe('an authenticated route needs a session', () => {
  it('refuses with no cookie', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/probe' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a forged cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/probe',
      headers: { cookie: `${SESSION_COOKIE}=made-up` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('allows a real session, and hands the route the account and guild', async () => {
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/probe',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accountId: ACCOUNT, guildId: GUILD });
  });

  it('clears the cookie when it rejects, so a dead session stops being re-sent', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/probe',
      headers: { cookie: `${SESSION_COOKIE}=made-up` },
    });
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('refuses after the session expires, on the injected clock', async () => {
    const { cookie } = await signIn();
    clock += POLICY.sessionTtlMs + 1;
    const response = await app.inject({ method: 'GET', url: '/api/probe', headers: { cookie } });
    expect(response.statusCode).toBe(401);
  });

  it('refuses immediately after logout', async () => {
    const { cookie, csrf } = await signIn();
    const out = await app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(out.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/probe', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });
});

describe('CSRF is enforced on every state-changing request (ADR 0029)', () => {
  it('refuses a POST with no CSRF header', async () => {
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/probe-write',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'csrf' });
  });

  it('refuses a POST with a wrong CSRF header', async () => {
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/probe-write',
      headers: { cookie, [CSRF_HEADER]: 'f'.repeat(64) },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a POST carrying another session’s CSRF token', async () => {
    // The token is per-session by construction — derived from that session's
    // token — so this is the case a shared secret would have got wrong.
    const first = await signIn();
    const second = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/probe-write',
      headers: { cookie: first.cookie, [CSRF_HEADER]: second.csrf },
    });
    expect(response.statusCode).toBe(403);
  });

  it('accepts a POST with the right CSRF header', async () => {
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/probe-write',
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(response.statusCode).toBe(200);
  });

  it('does not require it on a GET, which changes nothing', async () => {
    const { cookie } = await signIn();
    const response = await app.inject({ method: 'GET', url: '/api/probe', headers: { cookie } });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a cross-origin POST even with a correct token', async () => {
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/probe-write',
      headers: {
        cookie,
        [CSRF_HEADER]: csrf,
        origin: 'http://evil.example',
        host: '127.0.0.1:8787',
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it('accepts a same-origin POST', async () => {
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/probe-write',
      headers: {
        cookie,
        [CSRF_HEADER]: csrf,
        origin: 'http://127.0.0.1:8787',
        host: '127.0.0.1:8787',
      },
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses logout without a CSRF token, so a cross-site page cannot log you out', async () => {
    const { cookie } = await signIn();
    const response = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /api/session', () => {
  it('reports unauthenticated with no cookie, and hands out no token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/session' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ authenticated: boolean }>().authenticated).toBe(false);
    expect(JSON.stringify(response.json())).not.toContain('csrfToken');
  });

  it('hands out the caller’s own CSRF token when authenticated', async () => {
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie },
    });
    expect(response.json<{ csrfToken: string }>().csrfToken).toBe(csrf);
  });

  it('sends no CORS headers, which is what stops a cross-origin page reading it', async () => {
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie, origin: 'http://evil.example' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('re-authentication gates destructive routes (ADR 0029)', () => {
  it('allows a destructive route right after login', async () => {
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/probe-destructive',
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses it once the window has passed, without ending the session', async () => {
    const { cookie, csrf } = await signIn();
    clock += POLICY.reauthWindowMs + 1;
    const response = await app.inject({
      method: 'POST',
      url: '/api/probe-destructive',
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'reauth-required' });

    const stillLive = await app.inject({ method: 'GET', url: '/api/probe', headers: { cookie } });
    expect(stillLive.statusCode).toBe(200);
  });

  it('allows it again after a successful re-authentication', async () => {
    const { cookie, csrf } = await signIn();
    clock += POLICY.reauthWindowMs + 1;
    const reauth = await app.inject({
      method: 'POST',
      url: '/api/reauth',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { password: PASSWORD },
    });
    expect(reauth.statusCode).toBe(200);

    const response = await app.inject({
      method: 'POST',
      url: '/api/probe-destructive',
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a re-authentication with a wrong password', async () => {
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/reauth',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { password: 'wrong' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('needs a CSRF token to re-authenticate, like every other write', async () => {
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/reauth',
      headers: { cookie },
      payload: { password: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('/api/bootstrap does not exist unless it is armed (docs/19 §6.10 step 2)', () => {
  /** An instance with no accounts, so the bootstrap can actually arm. */
  const emptyInstance = (): { server: FastifyInstance; token: string | undefined } => {
    const fresh = openMigratedTestDatabase();
    const freshClock = clock;
    guildRepo.upsertGuild(fresh.scopes.forGuild(GUILD), { name: 'guild', now: freshClock });
    const freshDeps: HttpDeps = {
      scopes: fresh.scopes,
      now: () => freshClock,
      guildIds: [GUILD],
      logger,
      readonly: false,
      portsFor: (scope) => testPortsFor(scope, () => freshClock),
      instance: testInstanceFor(fresh.scopes.instance(), () => freshClock),
    };
    const issued = issueBootstrapTokenIfNeeded(freshDeps, { readonly: false });
    return { server: createServer({ deps: freshDeps }), token: issued?.token };
  };

  it('answers 404 when an account already exists', async () => {
    // Not 403. A 403 would confirm the route exists and therefore that this
    // instance has a bootstrap path at all.
    const response = await app.inject({
      method: 'POST',
      url: '/api/bootstrap',
      payload: { token: 'x', username: 'owner2', password: PASSWORD },
    });
    expect(response.statusCode).toBe(404);
  });

  it('answers 404 when an account exists AND a live token is lying around', async () => {
    // The case mutation 205 exposed. `app` is built in `beforeEach` against an
    // instance that already has an owner; issuing a token before building a
    // second server must not bring the route back. Without this, the 404 above
    // could have been for the token's absence rather than the account's
    // presence, and dropping the account check would go unnoticed.
    issueBootstrapTokenIfNeeded({ ...deps, scopes: t.scopes }, { readonly: false });
    const server = createServer({ deps });
    const response = await server.inject({
      method: 'POST',
      url: '/api/bootstrap',
      payload: { token: 'x', username: 'owner2', password: PASSWORD },
    });
    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it('answers 404 on an empty instance with no token issued', async () => {
    const fresh = openMigratedTestDatabase();
    guildRepo.upsertGuild(fresh.scopes.forGuild(GUILD), { name: 'guild', now: clock });
    const server = createServer({
      deps: {
        scopes: fresh.scopes,
        now: () => clock,
        guildIds: [GUILD],
        logger,
        readonly: false,
        portsFor: (scope) => testPortsFor(scope, () => clock),
        instance: testInstanceFor(fresh.scopes.instance(), () => clock),
      },
    });
    const response = await server.inject({
      method: 'POST',
      url: '/api/bootstrap',
      payload: { token: 'x', username: 'owner', password: PASSWORD },
    });
    expect(response.statusCode).toBe(404);
    await server.close();
    fresh.close();
  });

  it('exists when the table is empty and a token is live', async () => {
    const { server, token } = emptyInstance();
    const response = await server.inject({
      method: 'POST',
      url: '/api/bootstrap',
      payload: { token, username: 'owner', password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    await server.close();
  });

  it('rejects a bad token with 400, having existed for a correct one', async () => {
    const { server } = emptyInstance();
    const response = await server.inject({
      method: 'POST',
      url: '/api/bootstrap',
      payload: { token: 'guessed', username: 'owner', password: PASSWORD },
    });
    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('refuses a password below the length floor', async () => {
    const { server, token } = emptyInstance();
    const response = await server.inject({
      method: 'POST',
      url: '/api/bootstrap',
      payload: { token, username: 'owner', password: 'short' },
    });
    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('logs the new owner straight in', async () => {
    const { server, token } = emptyInstance();
    const response = await server.inject({
      method: 'POST',
      url: '/api/bootstrap',
      payload: { token, username: 'owner', password: PASSWORD },
    });
    expect(String(response.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=`);
    await server.close();
  });
});

describe('read-only mode (ADR 0029)', () => {
  it('answers 503 to a login and names the environment variable', async () => {
    const ro = build({ readonly: true, scopes: t.readonlyScopes });
    const response = await ro.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: PASSWORD },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ message: string }>().message).toContain('BANANASAURS_READONLY');
    await ro.close();
  });

  it('answers 503 for an unknown username too, so read-only is not an oracle', async () => {
    /**
     * The gap mutation 216 exposed. Deleting the explicit `readonly` guard on
     * `/api/login` left every test green, because the error handler turns the
     * `ReadonlyError` thrown by `recordFailedAttempt` into the same 503.
     *
     * But only for an account that exists. An **unknown** username never
     * reaches a write, so it would have returned 401 while every real username
     * returned 503 — turning read-only mode into a username oracle, in the one
     * mode where the answer cannot be a login. The guard is what makes both
     * answers identical, and this is the test that says so.
     */
    const ro = build({ readonly: true, scopes: t.readonlyScopes });
    const unknown = await ro.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'nobody', password: PASSWORD },
    });
    const known = await ro.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: 'wrong' },
    });
    expect(unknown.statusCode).toBe(503);
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());
    await ro.close();
  });

  it('does not answer 403, which would send an operator hunting for a grant', async () => {
    const ro = build({ readonly: true, scopes: t.readonlyScopes });
    const response = await ro.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: PASSWORD },
    });
    expect(response.statusCode).not.toBe(403);
    await ro.close();
  });

  it('turns a write that slips through into a 503 rather than a 500', async () => {
    // The error handler, not the route: a route added later that writes without
    // checking `readonly` still refuses correctly instead of reporting an
    // internal error.
    const ro = createServer({
      deps: { ...deps, readonly: true, scopes: t.readonlyScopes },
      registerRoutes: (instance, guard) => {
        instance.post('/api/writes-anyway', (request, reply) => {
          const session = guard.require(request, reply);
          if (session === undefined) return reply;
          accountRepo.grantGuildAccess(session.scope, session.accountId);
          return reply.send({ ok: true });
        });
      },
    });
    const { cookie, csrf } = await signIn();
    const response = await ro.inject({
      method: 'POST',
      url: '/api/writes-anyway',
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    expect(response.statusCode).toBe(503);
    await ro.close();
  });

  it('still answers a read', async () => {
    const { cookie } = await signIn();
    const ro = build({ readonly: true, scopes: t.readonlyScopes });
    const response = await ro.inject({ method: 'GET', url: '/api/probe', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    await ro.close();
  });
});
