import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, guildRepo } from '@bananasaurs/storage';
import { parseGuildId } from '@bananasaurs/core';
import { createServer, type HttpDeps } from '../server.js';
import { generateToken, hashPassword } from '../secrets.js';
import { verifyAccessToken } from '../oauth/provider.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerOAuthRoutes } from './oauth.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const PASSWORD = 'correct horse battery staple';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const PUBLIC_URL = 'https://bot.test';
const REDIRECT = 'https://client.test/cb';

let t: MigratedTestDatabase;
let clock: number;
let deps: HttpDeps;
let app: FastifyInstance;

/** Every raw secret minted during the run, for the no-secrets test at the end. */
const seenSecrets: string[] = [];
/** Response bodies that must never contain a raw secret (token + consent page excluded). */
const scannedBodies: string[] = [];
/** Captured logger output, stringified per call. */
const logLines: string[] = [];

const trackSecrets = (...values: string[]): void => {
  seenSecrets.push(...values);
};

const buildApp = (over: Partial<HttpDeps> = {}): FastifyInstance =>
  createServer({ deps: { ...deps, ...over }, registerRoutes: registerOAuthRoutes });

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  // `logLines`, `seenSecrets` and `scannedBodies` deliberately accumulate
  // across tests: the no-secrets test at the end scans the whole run.
  deps = {
    scopes: t.scopes,
    now: () => clock,
    guildIds: [GUILD_A, GUILD_B],
    logger: {
      info(obj: unknown) {
        logLines.push(JSON.stringify(obj));
      },
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

  app = buildApp();
});

afterEach(async () => {
  await app.close();
  t.close();
});

/** Re-implemented here so the test does not import its own oracle. */
const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier, 'utf8').digest('base64url');

const newPkce = (): { verifier: string; challenge: string } => {
  const verifier = generateToken();
  trackSecrets(verifier);
  return { verifier, challenge: s256(verifier) };
};

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

const registerClient = async (
  target = app,
  redirectUris: readonly string[] = [REDIRECT],
): Promise<string> => {
  const response = await target.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: { client_name: 'Claude Desktop', redirect_uris: [...redirectUris] },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ client_id: string }>();
  return body.client_id;
};

const exchange = async (
  target = app,
  input: { code: string; clientId: string; verifier: string },
): Promise<{ accessToken: string; refreshToken: string }> => {
  const response = await target.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: formHeaders,
    payload: formBody({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.clientId,
      redirect_uri: REDIRECT,
      code_verifier: input.verifier,
    }),
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ access_token: string; refresh_token: string }>();
  trackSecrets(body.access_token, body.refresh_token);
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
};

describe('the metadata documents', () => {
  it('serves the authorization-server document', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });
    expect(response.statusCode).toBe(200);
    scannedBodies.push(response.body);
    const body = response.json<Record<string, unknown>>();
    expect(body.issuer).toBe(PUBLIC_URL);
    expect(body.authorization_endpoint).toBe(`${PUBLIC_URL}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${PUBLIC_URL}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${PUBLIC_URL}/oauth/register`);
    expect(body.revocation_endpoint).toBe(`${PUBLIC_URL}/oauth/revoke`);
    expect(body.response_types_supported).toEqual(['code']);
    expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(body.scopes_supported).toEqual(['bananasaurs:read', 'bananasaurs:send']);
  });

  it('serves the protected-resource document', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource',
    });
    expect(response.statusCode).toBe(200);
    scannedBodies.push(response.body);
    const body = response.json<Record<string, unknown>>();
    expect(body.resource).toBe(`${PUBLIC_URL}/mcp`);
    expect(body.authorization_servers).toEqual([PUBLIC_URL]);
    expect(body.scopes_supported).toEqual(['bananasaurs:read', 'bananasaurs:send']);
    expect(body.bearer_methods_supported).toEqual(['header']);
  });
});

describe('GET /oauth/authorize', () => {
  it('renders the consent page with the security headers', async () => {
    const clientId = await registerClient();
    const { challenge } = newPkce();
    const response = await app.inject({
      method: 'GET',
      url: authorizeQuery({ client_id: clientId, code_challenge: challenge }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'");
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain(
      'Approve only if you started this from a client you recognise.',
    );
  });

  it('(g) refuses an unregistered redirect_uri with an error page and no redirect', async () => {
    const clientId = await registerClient();
    const { challenge } = newPkce();
    const response = await app.inject({
      method: 'GET',
      url: authorizeQuery({
        client_id: clientId,
        redirect_uri: 'https://other.test/cb',
        code_challenge: challenge,
      }),
    });
    expect(response.statusCode).toBe(200);
    scannedBodies.push(response.body);
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toContain('invalid_request');
  });

  it('refuses response_type=token with an error page and no redirect', async () => {
    const clientId = await registerClient();
    const { challenge } = newPkce();
    const response = await app.inject({
      method: 'GET',
      url: authorizeQuery({
        client_id: clientId,
        code_challenge: challenge,
        response_type: 'token',
      }),
    });
    expect(response.statusCode).toBe(200);
    scannedBodies.push(response.body);
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toContain('invalid_request');
  });

  it('refuses the 61st authorization in an hour with 429 and recovers after rollover', async () => {
    const clientId = await registerClient();
    const { challenge } = newPkce();
    const url = authorizeQuery({ client_id: clientId, code_challenge: challenge });
    for (let i = 0; i < 60; i++) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
    }
    const refused = await app.inject({ method: 'GET', url });
    expect(refused.statusCode).toBe(429);
    scannedBodies.push(refused.body);
    expect(refused.headers['retry-after']).toBe('3600');
    expect(refused.body).toContain('too many authorization requests; try again later');

    clock += 3_600_000;
    const recovered = await app.inject({ method: 'GET', url });
    expect(recovered.statusCode).toBe(200);
  });
});

describe('POST /oauth/authorize', () => {
  const grantAuthorize = (): void => {
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_A), {
      accountId: ACCOUNT,
      capability: 'mcp.authorize',
      grantedBy: 'test',
      now: clock,
    });
  };

  it('(f) refuses an account with guild access but no mcp.authorize, then succeeds after the grant', async () => {
    const clientId = await registerClient();
    const { challenge } = newPkce();
    const page = await app.inject({
      method: 'GET',
      url: authorizeQuery({ client_id: clientId, code_challenge: challenge }),
    });
    const fields = {
      requestId: hiddenInput(page.body, 'requestId'),
      nonce: hiddenInput(page.body, 'nonce'),
      username: 'owner',
      password: PASSWORD,
      decision: 'approve',
    };
    const refused = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: formHeaders,
      payload: formBody(fields),
    });
    expect(refused.statusCode).toBe(403);
    scannedBodies.push(refused.body);
    expect(refused.body).toContain('no-grant');

    grantAuthorize();
    const approved = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: formHeaders,
      payload: formBody(fields),
    });
    expect(approved.statusCode).toBe(302);
    expect(approved.headers.location).toContain('code=');
  });

  it('answers 403 when the Origin does not match the host', async () => {
    grantAuthorize();
    const clientId = await registerClient();
    const { challenge } = newPkce();
    const page = await app.inject({
      method: 'GET',
      url: authorizeQuery({ client_id: clientId, code_challenge: challenge }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { ...formHeaders, origin: 'https://evil.test' },
      payload: formBody({
        requestId: hiddenInput(page.body, 'requestId'),
        nonce: hiddenInput(page.body, 'nonce'),
        username: 'owner',
        password: PASSWORD,
        decision: 'approve',
      }),
    });
    expect(response.statusCode).toBe(403);
    scannedBodies.push(response.body);
  });

  it('follows a deny with a 302 carrying error=access_denied and the state', async () => {
    grantAuthorize();
    const clientId = await registerClient();
    const { challenge } = newPkce();
    const page = await app.inject({
      method: 'GET',
      url: authorizeQuery({ client_id: clientId, code_challenge: challenge }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: formHeaders,
      payload: formBody({
        requestId: hiddenInput(page.body, 'requestId'),
        nonce: hiddenInput(page.body, 'nonce'),
        username: 'owner',
        password: 'wrong even so — deny needs no password',
        decision: 'deny',
      }),
    });
    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('st-1');
  });

  it('lets a wrong password be followed by the right one on the same form', async () => {
    grantAuthorize();
    const clientId = await registerClient();
    const { challenge } = newPkce();
    const page = await app.inject({
      method: 'GET',
      url: authorizeQuery({ client_id: clientId, code_challenge: challenge }),
    });
    const fields = {
      requestId: hiddenInput(page.body, 'requestId'),
      nonce: hiddenInput(page.body, 'nonce'),
      username: 'owner',
      password: 'wrong',
      decision: 'approve',
    };
    const failed = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: formHeaders,
      payload: formBody(fields),
    });
    expect(failed.statusCode).toBe(200);
    scannedBodies.push(failed.body);

    const retried = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: formHeaders,
      payload: formBody({ ...fields, password: PASSWORD }),
    });
    expect(retried.statusCode).toBe(302);
    expect(retried.headers.location).toContain('code=');
  });

  it('ignores the dashboard session cookie: cookie plus wrong password equals no cookie', async () => {
    grantAuthorize();
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: PASSWORD, guildId: GUILD_A },
    });
    expect(signIn.statusCode).toBe(200);
    const raw = signIn.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')).split(';')[0] ?? '';

    const clientId = await registerClient();
    const { challenge } = newPkce();
    const page = await app.inject({
      method: 'GET',
      url: authorizeQuery({ client_id: clientId, code_challenge: challenge }),
    });
    const fields = {
      requestId: hiddenInput(page.body, 'requestId'),
      nonce: hiddenInput(page.body, 'nonce'),
      username: 'owner',
      password: 'wrong',
      decision: 'approve',
    };
    const withCookie = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { ...formHeaders, cookie },
      payload: formBody(fields),
    });
    const withoutCookie = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: formHeaders,
      payload: formBody(fields),
    });
    expect(withCookie.statusCode).toBe(200);
    expect(withoutCookie.statusCode).toBe(200);
    expect(withCookie.body).toBe(withoutCookie.body);
  });
});

describe('POST /oauth/token', () => {
  const grantAuthorize = (): void => {
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_A), {
      accountId: ACCOUNT,
      capability: 'mcp.authorize',
      grantedBy: 'test',
      now: clock,
    });
  };

  it('returns a token pair on the full happy path', async () => {
    grantAuthorize();
    const clientId = await registerClient();
    const { verifier, challenge } = newPkce();
    const query = authorizeQuery({ client_id: clientId, code_challenge: challenge });
    const page = await app.inject({ method: 'GET', url: query });
    const requestId = hiddenInput(page.body, 'requestId');
    const nonce = hiddenInput(page.body, 'nonce');
    trackSecrets(nonce);
    const approval = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: formHeaders,
      payload: formBody({
        requestId,
        nonce,
        username: 'owner',
        password: PASSWORD,
        decision: 'approve',
      }),
    });
    const location = approval.headers.location;
    if (typeof location !== 'string') throw new Error('approve did not redirect');
    const code = new URL(location).searchParams.get('code');
    if (code === null) throw new Error('redirect carried no code');
    trackSecrets(code);

    const response = await app.inject({
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
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    const body = response.json<{
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    }>();
    trackSecrets(body.access_token, body.refresh_token);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
    expect(body.scope).toBe('bananasaurs:read');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });

  it('answers grant_type=password with unsupported_grant_type', async () => {
    grantAuthorize();
    const response = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: formHeaders,
      payload: formBody({ grant_type: 'password', username: 'owner', password: PASSWORD }),
    });
    expect(response.statusCode).toBe(400);
    scannedBodies.push(response.body);
    expect(response.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('still parses a form body at POST /oauth/token inside the child context', async () => {
    // Without the child-context parser this never reaches the provider: the
    // route answers 500. Reaching `invalid_grant` proves the form was parsed.
    const response = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: formHeaders,
      payload: formBody({
        grant_type: 'refresh_token',
        refresh_token: 'never-minted',
        client_id: 'no-such-client',
      }),
    });
    expect(response.statusCode).toBe(400);
    scannedBodies.push(response.body);
    expect(response.json()).toMatchObject({ error: 'invalid_grant' });
  });

  /** register -> authorize -> approve -> exchange through the routes. */
  const mintRoutePair = async (): Promise<{
    clientId: string;
    accessToken: string;
    refreshToken: string;
  }> => {
    const clientId = await registerClient();
    const { verifier, challenge } = newPkce();
    const page = await app.inject({
      method: 'GET',
      url: authorizeQuery({ client_id: clientId, code_challenge: challenge }),
    });
    expect(page.statusCode).toBe(200);
    const requestId = hiddenInput(page.body, 'requestId');
    const nonce = hiddenInput(page.body, 'nonce');
    trackSecrets(nonce);
    const approval = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: formHeaders,
      payload: formBody({
        requestId,
        nonce,
        username: 'owner',
        password: PASSWORD,
        decision: 'approve',
      }),
    });
    expect(approval.statusCode).toBe(302);
    const code = new URL(approval.headers.location as string).searchParams.get('code');
    if (code === null) throw new Error('redirect carried no code');
    trackSecrets(code);
    return { clientId, ...(await exchange(app, { code, clientId, verifier })) };
  };

  const tokenRowCount = (): number =>
    (t.raw.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get() as { n: number }).n;

  const refreshGrant = (input: { refreshToken: string; clientId: string }) =>
    app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: formHeaders,
      payload: formBody({
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
        client_id: input.clientId,
      }),
    });

  it('rotates with the grant still held: the same request answers 200', async () => {
    grantAuthorize();
    const { clientId, refreshToken } = await mintRoutePair();
    const response = await refreshGrant({ refreshToken, clientId });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ access_token: string; refresh_token: string }>();
    trackSecrets(body.access_token, body.refresh_token);
    expect(typeof body.access_token).toBe('string');
  });

  it('refuses to mint when the approving account no longer holds mcp.authorize, and writes no rows', async () => {
    grantAuthorize();
    const { clientId, accessToken, refreshToken } = await mintRoutePair();
    authzRepo.revokeAccountCapability(t.scopes.forGuild(GUILD_A), {
      accountId: ACCOUNT,
      capability: 'mcp.authorize',
    });
    const before = tokenRowCount();
    const response = await refreshGrant({ refreshToken, clientId });
    expect(response.statusCode).toBe(400);
    scannedBodies.push(response.body);
    expect(response.json()).toMatchObject({
      error: 'invalid_grant',
      error_description: 'the account that approved this token no longer holds mcp.authorize',
    });
    // The refusal refuses to mint: no new token rows were written.
    expect(tokenRowCount()).toBe(before);
    // And it does not revoke: the original access token still verifies.
    expect(
      verifyAccessToken(
        { scopes: t.scopes, now: () => clock, guildIds: [GUILD_A, GUILD_B] },
        accessToken,
      ).ok,
    ).toBe(true);
  });
});

describe('POST /oauth/register', () => {
  it('refuses an http redirect URI that is not loopback', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'evil', redirect_uris: ['http://evil.test/cb'] },
    });
    expect(response.statusCode).toBe(400);
    scannedBodies.push(response.body);
    expect(response.json()).toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('rate-limits the 21st registration in an hour, then recovers after rollover', async () => {
    const limited = buildApp();
    try {
      for (let i = 0; i < 20; i++) {
        const response = await limited.inject({
          method: 'POST',
          url: '/oauth/register',
          payload: { client_name: `client ${String(i)}`, redirect_uris: [REDIRECT] },
        });
        expect(response.statusCode).toBe(201);
      }
      const refused = await limited.inject({
        method: 'POST',
        url: '/oauth/register',
        payload: { client_name: 'client 20', redirect_uris: [REDIRECT] },
      });
      expect(refused.statusCode).toBe(429);
      scannedBodies.push(refused.body);
      expect(refused.json()).toMatchObject({ error: 'too_many_requests' });

      clock += 3_600_000;
      const recovered = await limited.inject({
        method: 'POST',
        url: '/oauth/register',
        payload: { client_name: 'client 21', redirect_uris: [REDIRECT] },
      });
      expect(recovered.statusCode).toBe(201);
    } finally {
      await limited.close();
    }
  });
});

describe('POST /oauth/revoke', () => {
  it('answers 200 and the revoked refresh token no longer refreshes', async () => {
    authzRepo.grantAccountCapability(t.scopes.forGuild(GUILD_A), {
      accountId: ACCOUNT,
      capability: 'mcp.authorize',
      grantedBy: 'test',
      now: clock,
    });
    const clientId = await registerClient();
    const { verifier, challenge } = newPkce();
    const page = await app.inject({
      method: 'GET',
      url: authorizeQuery({ client_id: clientId, code_challenge: challenge }),
    });
    const requestId = hiddenInput(page.body, 'requestId');
    const nonce = hiddenInput(page.body, 'nonce');
    trackSecrets(nonce);
    const approval = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: formHeaders,
      payload: formBody({
        requestId,
        nonce,
        username: 'owner',
        password: PASSWORD,
        decision: 'approve',
      }),
    });
    const code = new URL(approval.headers.location as string).searchParams.get('code');
    if (code === null) throw new Error('redirect carried no code');
    trackSecrets(code);
    const { refreshToken } = await exchange(app, { code, clientId, verifier });

    const revoked = await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: formHeaders,
      payload: formBody({ token: refreshToken, client_id: clientId }),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.body).toBe('');

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
    scannedBodies.push(refresh.body);
    expect(refresh.json()).toMatchObject({ error: 'invalid_grant' });
  });
});

describe('MCP_PUBLIC_URL unset', () => {
  it('answers 404 on every OAuth and well-known route', async () => {
    const bare = buildApp({ mcpPublicUrl: undefined });
    try {
      for (const url of [
        '/.well-known/oauth-authorization-server',
        '/.well-known/oauth-protected-resource',
        '/oauth/authorize?client_id=x',
      ]) {
        const get = await bare.inject({ method: 'GET', url });
        expect(get.statusCode).toBe(404);
      }
      for (const url of ['/oauth/authorize', '/oauth/token', '/oauth/register', '/oauth/revoke']) {
        const post = await bare.inject({
          method: 'POST',
          url,
          headers: formHeaders,
          payload: formBody({ grant_type: 'refresh_token' }),
        });
        expect(post.statusCode).toBe(404);
      }
    } finally {
      await bare.close();
    }
  });
});

describe('no raw secret anywhere it must not be', () => {
  it('keeps tokens, codes and nonces out of other bodies and out of the logs', async () => {
    expect(seenSecrets.length).toBeGreaterThan(0);
    expect(scannedBodies.length).toBeGreaterThan(0);
    for (const body of scannedBodies) {
      for (const secret of seenSecrets) {
        expect(body).not.toContain(secret);
      }
      expect(body).not.toContain(PASSWORD);
    }
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      for (const secret of seenSecrets) {
        expect(line).not.toContain(secret);
      }
      expect(line).not.toContain(PASSWORD);
    }
  });
});
