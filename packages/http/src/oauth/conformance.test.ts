import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, guildRepo } from '@bananasaurs/storage';
import { parseGuildId } from '@bananasaurs/core';
import { createServer, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerOAuthRoutes } from '../routes/oauth.js';
import { requireBearer } from './bearer.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractResourceMetadataUrl,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

/**
 * Task 7 conformance: the client in this file is the MCP SDK's own OAuth
 * client, not ours. Every protocol step — discovery, registration,
 * authorization-URL construction, code exchange, refresh and challenge
 * parsing — goes through the SDK's functions, driven over `app.inject` so no
 * socket is opened.
 *
 * Signature notes (the `.d.ts` wins over the brief):
 * - `discoverOAuthProtectedResourceMetadata` takes `fetchFn` as a third
 *   positional argument, not inside the options object.
 * - The SDK surfaces the `invalid_grant` failure code as the thrown error's
 *   class (`InvalidGrantError`, with `errorCode === 'invalid_grant'`); the
 *   message carries the server's `error_description`. The assertions below
 *   therefore check the class, not the message.
 * - The SDK has no revoke helper, so revocation is a plain `app.inject`
 *   POST (said plainly at the call site).
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const PASSWORD = 'correct horse battery staple';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const PUBLIC_URL = 'https://bot.test';
const CLIENT_REDIRECT = 'https://client.test/cb';

let t: MigratedTestDatabase;
let clock: number;
let deps: HttpDeps;
let app: FastifyInstance;

const injectFetch =
  (app: FastifyInstance): FetchLike =>
  async (url, init) => {
    const u = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    // The SDK sends JSON strings (registration) and URLSearchParams (token
    // grants). `toString()` serialises the form bodies correctly (asserted in
    // the helper test below); anything else goes through `Response.text()`
    // rather than a bare `String()`.
    const body = init?.body;
    let payload: string | undefined;
    if (typeof body === 'string') {
      payload = body;
    } else if (body instanceof URLSearchParams) {
      payload = body.toString();
    } else if (body !== undefined && body !== null) {
      payload = await new Response(body).text();
    }
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: u.pathname + u.search,
      headers,
      // Omitted (not `undefined`) on bodyless requests: light-my-request's
      // types use `exactOptionalPropertyTypes`.
      ...(payload === undefined ? {} : { payload }),
    });
    return new Response(res.body, {
      status: res.statusCode,
      headers: res.headers as unknown as Record<string, string>,
    });
  };

const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };

const hiddenInput = (html: string, name: string): string => {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (match?.[1] === undefined) throw new Error(`no hidden input ${name} in consent page`);
  return match[1];
};

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
  // Seeded with `mcp.authorize` in guild A only, exactly as bearer.test.ts.
  authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_A), {
    accountId: ACCOUNT,
    capability: 'mcp.authorize',
    grantedBy: 'test',
    now: clock,
  });

  // The Task 4 harness plus the test-only `/mcp-stub` behind `requireBearer`,
  // exactly as bearer.test.ts builds it.
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

/**
 * Drives one SDK-built authorization URL through the consent form and returns
 * the issued code and the echoed state. The POST carries
 * `Origin: https://bot.test` (with a matching `Host`, so `originMatchesHost`
 * sees what a real browser-driven client sends).
 */
const approveAuthorization = async (
  target: FastifyInstance,
  authorizationUrl: URL,
): Promise<{ code: string; state: string | null }> => {
  const relative = authorizationUrl.pathname + authorizationUrl.search;
  const page = await target.inject({ method: 'GET', url: relative });
  expect(page.statusCode).toBe(200);
  expect(page.headers['content-type']).toContain('text/html');
  const approval = await target.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { ...formHeaders, origin: 'https://bot.test', host: 'bot.test' },
    payload: new URLSearchParams({
      requestId: hiddenInput(page.body, 'requestId'),
      nonce: hiddenInput(page.body, 'nonce'),
      username: 'owner',
      password: PASSWORD,
      decision: 'approve',
    }).toString(),
  });
  expect(approval.statusCode).toBe(302);
  const location = approval.headers.location;
  if (typeof location !== 'string') throw new Error('approve did not redirect');
  expect(location.startsWith(`${CLIENT_REDIRECT}?`)).toBe(true);
  const redirect = new URL(location);
  const code = redirect.searchParams.get('code');
  if (code === null) throw new Error('redirect carried no code');
  return { code, state: redirect.searchParams.get('state') };
};

describe('conformance against the SDK client', () => {
  it('drives injectFetch through URLSearchParams bodies without a socket', async () => {
    // `String()` on a URLSearchParams serialises the form; reaching the
    // provider's `invalid_grant` proves the body arrived parsed.
    expect(String(new URLSearchParams({ grant_type: 'refresh_token', a: 'x y' }))).toBe(
      'grant_type=refresh_token&a=x+y',
    );
    const response = await injectFetch(app)('https://bot.test/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'never-minted',
        client_id: 'no-such-client',
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('discovers the protected resource and the authorization server', async () => {
    const fetchFn = injectFetch(app);
    // `.d.ts` wins: fetchFn is the third positional argument here.
    const resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      'https://bot.test/mcp',
      undefined,
      fetchFn,
    );
    expect(resourceMetadata.authorization_servers).toContain('https://bot.test');

    const metadata = await discoverAuthorizationServerMetadata('https://bot.test', { fetchFn });
    if (metadata === undefined) throw new Error('authorization-server discovery returned nothing');
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.token_endpoint).toBe('https://bot.test/oauth/token');
  });

  it('registers, authorizes, exchanges, and calls the stub', async () => {
    const fetchFn = injectFetch(app);
    const metadata = await discoverAuthorizationServerMetadata('https://bot.test', { fetchFn });
    if (metadata === undefined) throw new Error('authorization-server discovery returned nothing');

    const clientInformation = await registerClient('https://bot.test', {
      metadata,
      clientMetadata: {
        client_name: 'SDK conformance',
        redirect_uris: [CLIENT_REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      fetchFn,
    });
    expect(clientInformation.client_id.startsWith('cli_')).toBe(true);

    const { authorizationUrl, codeVerifier } = await startAuthorization('https://bot.test', {
      metadata,
      clientInformation,
      redirectUrl: CLIENT_REDIRECT,
      scope: 'bananasaurs:read',
      state: 'xyz',
    });
    const { code, state } = await approveAuthorization(app, authorizationUrl);
    expect(state).toBe('xyz');

    const tokens = await exchangeAuthorization('https://bot.test', {
      metadata,
      clientInformation,
      authorizationCode: code,
      codeVerifier,
      redirectUri: CLIENT_REDIRECT,
      fetchFn,
    });
    expect(typeof tokens.access_token).toBe('string');
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3600);
    const refreshToken = tokens.refresh_token;
    if (typeof refreshToken !== 'string') throw new Error('exchange issued no refresh token');

    const stub = await app.inject({
      method: 'GET',
      url: '/mcp-stub',
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(stub.statusCode).toBe(200);
    expect(stub.json()).toEqual({ accountId: ACCOUNT, reachableGuilds: [GUILD_A] });
  });

  it('rotates the refresh token and cascades on replay (ADR 0045 D5)', async () => {
    const fetchFn = injectFetch(app);
    const metadata = await discoverAuthorizationServerMetadata('https://bot.test', { fetchFn });
    if (metadata === undefined) throw new Error('authorization-server discovery returned nothing');
    const clientInformation = await registerClient('https://bot.test', {
      metadata,
      clientMetadata: {
        client_name: 'SDK conformance',
        redirect_uris: [CLIENT_REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      fetchFn,
    });

    const started = await startAuthorization('https://bot.test', {
      metadata,
      clientInformation,
      redirectUrl: CLIENT_REDIRECT,
      scope: 'bananasaurs:read',
      state: 'xyz',
    });
    const { code } = await approveAuthorization(app, started.authorizationUrl);
    const tokens = await exchangeAuthorization('https://bot.test', {
      metadata,
      clientInformation,
      authorizationCode: code,
      codeVerifier: started.codeVerifier,
      redirectUri: CLIENT_REDIRECT,
      fetchFn,
    });
    const firstRefresh = tokens.refresh_token;
    if (typeof firstRefresh !== 'string') throw new Error('exchange issued no refresh token');

    const rotated = await refreshAuthorization('https://bot.test', {
      metadata,
      clientInformation,
      refreshToken: firstRefresh,
      fetchFn,
    });
    expect(rotated.access_token).not.toBe(tokens.access_token);
    const secondRefresh = rotated.refresh_token;
    if (typeof secondRefresh !== 'string') throw new Error('refresh issued no refresh token');
    expect(secondRefresh).not.toBe(firstRefresh);

    // Rotation revokes only the presented refresh token's descendants; the
    // old access token is a sibling and stays valid until expiry.
    const oldStill = await app.inject({
      method: 'GET',
      url: '/mcp-stub',
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(oldStill.statusCode).toBe(200);

    // Replaying the rotated refresh token is refused, and the SDK reports the
    // failure as InvalidGrantError (`errorCode === 'invalid_grant'`).
    try {
      await refreshAuthorization('https://bot.test', {
        metadata,
        clientInformation,
        refreshToken: firstRefresh,
        fetchFn,
      });
      expect.unreachable('replaying a rotated refresh token must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidGrantError);
      expect((err as InvalidGrantError).errorCode).toBe('invalid_grant');
    }

    // After the replay the new access token is revoked too (the D5 cascade).
    const dead = await app.inject({
      method: 'GET',
      url: '/mcp-stub',
      headers: { authorization: `Bearer ${rotated.access_token}` },
    });
    expect(dead.statusCode).toBe(401);
  });

  it('revokes the lineage and the 401 challenge parses with the SDK parser', async () => {
    const fetchFn = injectFetch(app);
    const metadata = await discoverAuthorizationServerMetadata('https://bot.test', { fetchFn });
    if (metadata === undefined) throw new Error('authorization-server discovery returned nothing');
    const clientInformation = await registerClient('https://bot.test', {
      metadata,
      clientMetadata: {
        client_name: 'SDK conformance',
        redirect_uris: [CLIENT_REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      fetchFn,
    });

    const started = await startAuthorization('https://bot.test', {
      metadata,
      clientInformation,
      redirectUrl: CLIENT_REDIRECT,
      scope: 'bananasaurs:read',
      state: 'xyz',
    });
    const { code } = await approveAuthorization(app, started.authorizationUrl);
    const tokens = await exchangeAuthorization('https://bot.test', {
      metadata,
      clientInformation,
      authorizationCode: code,
      codeVerifier: started.codeVerifier,
      redirectUri: CLIENT_REDIRECT,
      fetchFn,
    });
    const refreshToken = tokens.refresh_token;
    if (typeof refreshToken !== 'string') throw new Error('exchange issued no refresh token');

    // The SDK has no revoke helper, so revocation is a plain app.inject POST.
    const revoked = await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      payload: { token: refreshToken, client_id: clientInformation.client_id },
    });
    expect(revoked.statusCode).toBe(200);

    const denied = await app.inject({
      method: 'GET',
      url: '/mcp-stub',
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(denied.statusCode).toBe(401);
    const challenge = denied.headers['www-authenticate'];
    if (typeof challenge !== 'string') throw new Error('401 carried no WWW-Authenticate challenge');
    expect(challenge).toBe(
      'Bearer resource_metadata="https://bot.test/.well-known/oauth-protected-resource"',
    );
    const probe = new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 401,
      headers: { 'WWW-Authenticate': challenge },
    });
    expect(extractResourceMetadataUrl(probe)).toEqual(
      new URL('https://bot.test/.well-known/oauth-protected-resource'),
    );
  });

  it('refuses a wrong code verifier and an unregistered redirect URI', async () => {
    const fetchFn = injectFetch(app);
    const metadata = await discoverAuthorizationServerMetadata('https://bot.test', { fetchFn });
    if (metadata === undefined) throw new Error('authorization-server discovery returned nothing');
    const clientInformation = await registerClient('https://bot.test', {
      metadata,
      clientMetadata: {
        client_name: 'SDK conformance',
        redirect_uris: [CLIENT_REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      fetchFn,
    });

    const started = await startAuthorization('https://bot.test', {
      metadata,
      clientInformation,
      redirectUrl: CLIENT_REDIRECT,
      scope: 'bananasaurs:read',
      state: 'xyz',
    });
    const { code } = await approveAuthorization(app, started.authorizationUrl);
    try {
      await exchangeAuthorization('https://bot.test', {
        metadata,
        clientInformation,
        authorizationCode: code,
        codeVerifier: 'wrong-verifier-that-matches-nothing-0123456789',
        redirectUri: CLIENT_REDIRECT,
        fetchFn,
      });
      expect.unreachable('exchanging with a wrong verifier must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidGrantError);
      expect((err as InvalidGrantError).errorCode).toBe('invalid_grant');
    }

    const bad = await startAuthorization('https://bot.test', {
      metadata,
      clientInformation,
      redirectUrl: 'https://other.test/cb',
      scope: 'bananasaurs:read',
      state: 'xyz',
    });
    const refused = await app.inject({
      method: 'GET',
      url: bad.authorizationUrl.pathname + bad.authorizationUrl.search,
    });
    expect(refused.statusCode).toBe(200);
    expect(refused.headers.location).toBeUndefined();
    expect(refused.body).toContain('invalid_request');
  });
});
