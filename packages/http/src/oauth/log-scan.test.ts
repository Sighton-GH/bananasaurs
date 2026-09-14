import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { pino, type DestinationStream } from 'pino';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { accountRepo, authzRepo, guildRepo } from '@bananasaurs/storage';
import { parseGuildId } from '@bananasaurs/core';
import { createServer, type HttpDeps } from '../server.js';
import { generateToken, hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerOAuthRoutes } from '../routes/oauth.js';
import { requireBearer } from './bearer.js';

/**
 * The test the tree did not have (Task 5 step 5): a full authorize →
 * exchange → refresh → revoke cycle against an app whose logger is a real
 * Pino instance writing to an in-memory sink, failing if any raw secret
 * reaches any log line.
 *
 * The logger is built the same way `createLogger`
 * (`packages/core/src/obs/logger.ts`) builds its production instance — same
 * level handling, same redact block — so the redaction hook is in the path.
 * The scan is for secret VALUES regardless of key, which is what catches a
 * value smuggled under an allowlisted key (`oauthTokenId`) that no
 * field-name redaction could stop.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const PASSWORD = 'correct horse battery staple';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const PUBLIC_URL = 'https://bot.test';
const REDIRECT = 'https://client.test/cb';

let t: MigratedTestDatabase;
let clock: number;
let app: FastifyInstance;
/** Every raw line the Pino instance emitted. */
let lines: string[];

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  lines = [];
  const sink: DestinationStream = {
    write: (line: string): void => {
      lines.push(line);
    },
  };
  // Same construction as `createLogger`'s production branch (no pretty
  // transport), redact block copied verbatim so drift is visible here.
  const logger = pino(
    {
      level: 'trace',
      base: { component: 'bananasaurs' },
      redact: {
        paths: [
          'token',
          '*.token',
          'DISCORD_BOT_TOKEN',
          '*.DISCORD_BOT_TOKEN',
          'secret',
          '*.secret',
          'DASHBOARD_SESSION_SECRET',
          '*.DASHBOARD_SESSION_SECRET',
          'password',
          '*.password',
          'passwordHash',
          '*.passwordHash',
          'authorization',
          '*.authorization',
          'cookie',
          '*.cookie',
        ],
        censor: '<redacted>',
      },
    },
    sink,
  );
  const deps: HttpDeps = {
    scopes: t.scopes,
    now: () => clock,
    guildIds: [GUILD_A, GUILD_B],
    logger,
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
      // Test-only stub so the guard can be exercised end to end. `/mcp`
      // itself is M4's and lives nowhere in this slice.
      instance.get('/mcp-stub', (req, reply) => {
        const p = requireBearer(
          { ...routeDeps, mcpPublicUrl: routeDeps.mcpPublicUrl! },
          req,
          reply,
        );
        if (p === undefined) return reply;
        return reply.send({ accountId: p.accountId });
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

const hiddenInput = (html: string, name: string): string => {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (match?.[1] === undefined) throw new Error(`no hidden input ${name} in consent page`);
  return match[1];
};

describe('no OAuth secret reaches a log line', () => {
  it('runs authorize, exchange, refresh and revoke with no raw value in the captured output', async () => {
    const secrets: string[] = [];
    const registered = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'test client', redirect_uris: [REDIRECT] },
    });
    expect(registered.statusCode).toBe(201);
    const clientId = registered.json<{ client_id: string }>().client_id;

    const verifier = generateToken();
    secrets.push(verifier);
    const page = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: 'code',
        code_challenge: s256(verifier),
        code_challenge_method: 'S256',
        scope: 'bananasaurs:read',
        state: 'st-1',
      }).toString()}`,
    });
    expect(page.statusCode).toBe(200);
    const requestId = hiddenInput(page.body, 'requestId');
    const nonce = hiddenInput(page.body, 'nonce');
    secrets.push(nonce);

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
    const location = approval.headers.location;
    if (typeof location !== 'string') throw new Error('approve did not redirect');
    const code = new URL(location).searchParams.get('code');
    if (code === null) throw new Error('redirect carried no code');
    secrets.push(code);

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
    const first = exchanged.json<{ access_token: string; refresh_token: string }>();
    secrets.push(first.access_token, first.refresh_token);

    const stubbed = await app.inject({
      method: 'GET',
      url: '/mcp-stub',
      headers: { authorization: `Bearer ${first.access_token}` },
    });
    expect(stubbed.statusCode).toBe(200);

    const refreshed = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: formHeaders,
      payload: formBody({
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: clientId,
      }),
    });
    expect(refreshed.statusCode).toBe(200);
    const second = refreshed.json<{ access_token: string; refresh_token: string }>();
    secrets.push(second.access_token, second.refresh_token);

    const stubbedAgain = await app.inject({
      method: 'GET',
      url: '/mcp-stub',
      headers: { authorization: `Bearer ${second.access_token}` },
    });
    expect(stubbedAgain.statusCode).toBe(200);

    const revoked = await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      payload: { token: second.refresh_token, client_id: clientId },
    });
    expect(revoked.statusCode).toBe(200);

    const refused = await app.inject({
      method: 'GET',
      url: '/mcp-stub',
      headers: { authorization: `Bearer ${second.access_token}` },
    });
    expect(refused.statusCode).toBe(401);

    const dump = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [...secrets, PASSWORD]) {
      expect(dump).not.toContain(secret);
    }
    // The ids must flow, or the test would prove nothing: this is what shows
    // the allowlist lets the row keys through while the values above stay out.
    expect(dump).toContain(clientId);
    expect(dump).toMatch(/tok_[0-9a-f]{32}/);
  });
});
