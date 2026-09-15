import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, guildRepo, oauthRepo } from '@bananasaurs/storage';
import { parseGuildId } from '@bananasaurs/core';
import { createServer, type HttpDeps } from '../server.js';
import { generateToken, hashPassword, hashToken } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerOAuthRoutes } from '../routes/oauth.js';
import { requireBearer, wwwAuthenticateFor } from './bearer.js';
import { ACCESS_TOKEN_TTL_MS } from './provider.js';

/**
 * The bearer guard M4's `/mcp` route will sit behind (Task 5), exercised end
 * to end through a test-only stub. The stub lives only in this file — `/mcp`
 * itself is M4's.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const PASSWORD = 'correct horse battery staple';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const PUBLIC_URL = 'https://bot.test';
const REDIRECT = 'https://client.test/cb';
const CHALLENGE = `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`;

let t: MigratedTestDatabase;
let clock: number;
let deps: HttpDeps;
let app: FastifyInstance;

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  deps = {
    scopes: t.scopes,
    now: () => clock,
    guildIds: [GUILD_A, GUILD_B],
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
      fatal() {},
      trace() {},
    } as never,
    readonly: false,
    portsFor: (scope) => testPortsFor(scope, () => clock),
    instance: testInstanceFor(t.scopes.instance(), () => clock),
    mcpPublicUrl: PUBLIC_URL,
  };
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_A), { name: 'guild a', now: clock });
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_B), { name: 'guild b', now: clock });

  accountRepo.createAccount(t.scopes.instance(), {
    accountId: ACCOUNT,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD_A), ACCOUNT);
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD_B), ACCOUNT);
  // Seeded with `mcp.authorize` in guild A only.
  authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_A), {
    accountId: ACCOUNT,
    capability: 'mcp.authorize',
    grantedBy: 'test',
    now: clock,
  });

  app = createServer({
    deps,
    registerRoutes: (instance, guard, routeDeps) => {
      registerOAuthRoutes(instance, guard, routeDeps);
      instance.get('/mcp-stub', (req, reply) => {
        const p = requireBearer(
          { ...routeDeps, mcpPublicUrl: routeDeps.mcpPublicUrl! },
          req,
          reply,
        );
        if (p === undefined) return reply;
        return reply.send({ accountId: p.accountId, reachableGuilds: p.reachableGuilds });
      });
    },
  });
});

afterEach(async () => {
  await app.close();
  t.close();
});

/** Re-implemented here so the test does not import its own oracle. */
const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier, 'utf8').digest('base64url');

const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };

const formBody = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

const authorizeQuery = (over: Record<string, string> = {}): string => {
  const params = new URLSearchParams({
    client_id: '',
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: '',
    code_challenge_method: 'S256',
    scope: 'bananasaurs:read',
    state: 'st-1',
    ...over,
  });
  return `/oauth/authorize?${params.toString()}`;
};

const hiddenInput = (html: string, name: string): string => {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (match?.[1] === undefined) throw new Error(`no hidden input ${name} in consent page`);
  return match[1];
};

/** A real token through the full flow: register, authorize, approve, exchange. */
const mintToken = async (): Promise<{
  clientId: string;
  accessToken: string;
  refreshToken: string;
}> => {
  const registered = await app.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: { client_name: 'test client', redirect_uris: [REDIRECT] },
  });
  expect(registered.statusCode).toBe(201);
  const clientId = registered.json<{ client_id: string }>().client_id;

  const verifier = generateToken();
  const page = await app.inject({
    method: 'GET',
    url: authorizeQuery({ client_id: clientId, code_challenge: s256(verifier) }),
  });
  expect(page.statusCode).toBe(200);
  const approval = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: formHeaders,
    payload: formBody({
      requestId: hiddenInput(page.body, 'requestId'),
      nonce: hiddenInput(page.body, 'nonce'),
      username: 'owner',
      password: PASSWORD,
      decision: 'approve',
    }),
  });
  expect(approval.statusCode).toBe(302);
  const location = approval.headers.location;
  if (typeof location !== 'string') throw new Error('approve did not redirect');
  const code = new URL(location).searchParams.get('code');
  if (code === null) throw new Error('redirect carried no code');

  const exchanged = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: formHeaders,
    payload: formBody({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  });
  expect(exchanged.statusCode).toBe(200);
  const body = exchanged.json<{ access_token: string; refresh_token: string }>();
  return { clientId, accessToken: body.access_token, refreshToken: body.refresh_token };
};

const stubWith = (authorization: string | undefined) =>
  app.inject({
    method: 'GET',
    url: '/mcp-stub',
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  });

describe('wwwAuthenticateFor', () => {
  it('points at the protected-resource document Task 4 serves', () => {
    expect(wwwAuthenticateFor(PUBLIC_URL)).toBe(CHALLENGE);
  });
});

describe('requireBearer', () => {
  it('answers a missing header with the RFC 9728 challenge', async () => {
    const response = await stubWith(undefined);
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe(CHALLENGE);
    expect(response.json()).toEqual({ error: 'invalid_token' });
  });

  it('answers a non-bearer scheme with the same 401 and challenge', async () => {
    const response = await stubWith('Basic xyz');
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe(CHALLENGE);
    expect(response.json()).toEqual({ error: 'invalid_token' });
  });

  it('accepts the scheme case-insensitively (RFC 6750 §3)', async () => {
    const { accessToken } = await mintToken();
    const response = await stubWith(`bearer ${accessToken}`);
    expect(response.statusCode).toBe(200);
  });

  it('returns the principal with the live reachable set for a valid token', async () => {
    const { accessToken } = await mintToken();
    const response = await stubWith(`Bearer ${accessToken}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accountId: ACCOUNT, reachableGuilds: [GUILD_A] });
  });

  it('(e) refuses a revoked token in the same millisecond — no grace', async () => {
    const { clientId, accessToken } = await mintToken();
    const revoked = await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      payload: { token: accessToken, client_id: clientId },
    });
    expect(revoked.statusCode).toBe(200);
    const response = await stubWith(`Bearer ${accessToken}`);
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe(CHALLENGE);
    expect(response.json()).toEqual({ error: 'invalid_token' });
  });

  it('refuses an expired token at exactly the TTL and accepts it one millisecond before', async () => {
    const { accessToken } = await mintToken();
    const mintedAt = clock;
    clock = mintedAt + ACCESS_TOKEN_TTL_MS - 1;
    const fresh = await stubWith(`Bearer ${accessToken}`);
    expect(fresh.statusCode).toBe(200);
    clock = mintedAt + ACCESS_TOKEN_TTL_MS;
    const expired = await stubWith(`Bearer ${accessToken}`);
    expect(expired.statusCode).toBe(401);
    expect(expired.headers['www-authenticate']).toBe(CHALLENGE);
    expect(expired.json()).toEqual({ error: 'invalid_token' });
  });

  it('refuses a refresh token presented as a bearer', async () => {
    const { refreshToken } = await mintToken();
    const response = await stubWith(`Bearer ${refreshToken}`);
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe(CHALLENGE);
    expect(response.json()).toEqual({ error: 'invalid_token' });
  });

  it('(PR-95) refuses on the next call after the account is disabled', async () => {
    const { accessToken } = await mintToken();
    // No accountRepo setter exists, so the flag goes through the raw handle.
    t.raw.prepare('UPDATE dashboard_accounts SET disabled = 1 WHERE account_id = ?').run(ACCOUNT);
    const response = await stubWith(`Bearer ${accessToken}`);
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe(CHALLENGE);
    expect(response.json()).toEqual({ error: 'invalid_token' });
  });

  it('(PR-92) reports an emptied reachable set without refusing — nothing was cached', async () => {
    const { accessToken } = await mintToken();
    authzRepo.revokeAccountCapability(t.scopes.forGuild(GUILD_A), {
      accountId: ACCOUNT,
      capability: 'mcp.authorize',
    });
    const response = await stubWith(`Bearer ${accessToken}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accountId: ACCOUNT, reachableGuilds: [] });
  });

  it('sees a revocation between two requests at the same instant', async () => {
    const { clientId, accessToken } = await mintToken();
    const first = await stubWith(`Bearer ${accessToken}`);
    expect(first.statusCode).toBe(200);
    const revoked = await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      payload: { token: accessToken, client_id: clientId },
    });
    expect(revoked.statusCode).toBe(200);
    // The clock never moves in this test: a cache of any kind — of the row,
    // the principal, or the verification result — would answer 200 again.
    const second = await stubWith(`Bearer ${accessToken}`);
    expect(second.statusCode).toBe(401);
    expect(second.headers['www-authenticate']).toBe(CHALLENGE);
    expect(second.json()).toEqual({ error: 'invalid_token' });
  });

  it('touches lastUsedAt on every successful verification (PR-107)', async () => {
    const { accessToken } = await mintToken();
    const first = await stubWith(`Bearer ${accessToken}`);
    expect(first.statusCode).toBe(200);
    const rowAfterFirst = oauthRepo.findTokenByHash(t.scopes.instance(), hashToken(accessToken));
    expect(rowAfterFirst?.lastUsedAt).toBe(clock);
    clock += 1000;
    const second = await stubWith(`Bearer ${accessToken}`);
    expect(second.statusCode).toBe(200);
    const rowAfterSecond = oauthRepo.findTokenByHash(t.scopes.instance(), hashToken(accessToken));
    expect(rowAfterSecond?.lastUsedAt).toBe(clock);
  });

  it('never names the failure reason in a 401 body', async () => {
    const { clientId, accessToken } = await mintToken();
    const bodies: string[] = [];
    const unknown = await stubWith('Bearer never-minted-nor-matchable');
    expect(unknown.statusCode).toBe(401);
    bodies.push(unknown.body);
    const mintedAt = clock;
    clock = mintedAt + ACCESS_TOKEN_TTL_MS;
    const expired = await stubWith(`Bearer ${accessToken}`);
    expect(expired.statusCode).toBe(401);
    bodies.push(expired.body);
    clock = mintedAt;
    await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      payload: { token: accessToken, client_id: clientId },
    });
    const revoked = await stubWith(`Bearer ${accessToken}`);
    expect(revoked.statusCode).toBe(401);
    bodies.push(revoked.body);
    for (const body of bodies) {
      expect(JSON.parse(body)).toEqual({ error: 'invalid_token' });
      expect(body).not.toContain('revoked');
      expect(body).not.toContain('expired');
      expect(body).not.toContain('unknown');
    }
  });
});

describe('ADR 0045 D6: revoking the account revokes what it approved (M3b)', () => {
  it("a deleted account's live access token dies on the next request", async () => {
    const { accessToken } = await mintToken();
    const before = await stubWith(`Bearer ${accessToken}`);
    expect(before.statusCode).toBe(200);

    accountRepo.deleteAccount(t.scopes.instance(), { accountId: ACCOUNT, now: clock });

    // The SAME token, the SAME clock — nothing has expired.
    const after = await stubWith(`Bearer ${accessToken}`);
    expect(after.statusCode).toBe(401);
    expect(after.headers['www-authenticate']).toBe(CHALLENGE);
    expect(after.json()).toEqual({ error: 'invalid_token' });
  });

  it('a deleted account cannot refresh — the row was revoked, not just unfindable', async () => {
    const { clientId, refreshToken } = await mintToken();

    accountRepo.deleteAccount(t.scopes.instance(), { accountId: ACCOUNT, now: clock });

    const refresh = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: formHeaders,
      payload: formBody({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    expect(refresh.statusCode).toBe(400);
    expect(refresh.json()).toMatchObject({ error: 'invalid_grant' });

    const row = oauthRepo.findTokenByHash(t.scopes.instance(), hashToken(refreshToken));
    expect(row?.revokedAt).not.toBeNull();
  });

  it("a disabled account's live access token dies on the next request", async () => {
    const { accessToken } = await mintToken();
    const before = await stubWith(`Bearer ${accessToken}`);
    expect(before.statusCode).toBe(200);

    accountRepo.setAccountDisabled(t.scopes.instance(), { accountId: ACCOUNT, disabled: true });

    // The SAME token, the SAME clock — nothing has expired.
    const after = await stubWith(`Bearer ${accessToken}`);
    expect(after.statusCode).toBe(401);
    expect(after.headers['www-authenticate']).toBe(CHALLENGE);
    expect(after.json()).toEqual({ error: 'invalid_token' });
  });

  it('enabling the account restores the same token — nothing was cached', async () => {
    const { accessToken } = await mintToken();
    const before = await stubWith(`Bearer ${accessToken}`);
    expect(before.statusCode).toBe(200);
    const reachableBefore = before.json<{ reachableGuilds: string[] }>().reachableGuilds;

    accountRepo.setAccountDisabled(t.scopes.instance(), { accountId: ACCOUNT, disabled: true });
    const refused = await stubWith(`Bearer ${accessToken}`);
    expect(refused.statusCode).toBe(401);

    accountRepo.setAccountDisabled(t.scopes.instance(), { accountId: ACCOUNT, disabled: false });
    const restored = await stubWith(`Bearer ${accessToken}`);
    expect(restored.statusCode).toBe(200);
    expect(restored.json<{ reachableGuilds: string[] }>().reachableGuilds).toEqual(
      reachableBefore,
    );
  });

  it('a disabled account cannot refresh, and enabling restores the refresh', async () => {
    const { clientId, refreshToken } = await mintToken();

    accountRepo.setAccountDisabled(t.scopes.instance(), { accountId: ACCOUNT, disabled: true });
    const refused = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: formHeaders,
      payload: formBody({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'invalid_grant' });

    accountRepo.setAccountDisabled(t.scopes.instance(), { accountId: ACCOUNT, disabled: false });
    const renewed = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: formHeaders,
      payload: formBody({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json()).toMatchObject({ access_token: expect.any(String) });
  });
});
