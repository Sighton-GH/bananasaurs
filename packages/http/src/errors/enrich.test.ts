import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseGuildId } from '@bananasaurs/core';
import { accountRepo, guildRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createServer, CSRF_HEADER, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerAssistantProviderRoutes } from '../routes/assistant-providers.js';

const GUILD = parseGuildId('111111111111111111');
const OWNER = 'acct_0123456789abcdef0123456789abcdef';
const OPERATOR = 'acct_fedcba9876543210fedcba9876543210';
const PASSWORD = 'correct horse battery staple';

/** The `message` the server's own read-only refusal sends (server.ts `READONLY_BODY`). */
const READONLY_MESSAGE =
  'This instance is running with BANANASAURS_READONLY set, so it cannot write. ' +
  'Logging in creates a session row and counts failed attempts, so it is ' +
  'unavailable in this mode. Use the operator CLI over SSH, which is read-only ' +
  'clean, or restart without BANANASAURS_READONLY.';

let t: MigratedTestDatabase;
let deps: HttpDeps;
let app: FastifyInstance;
let clock: number;

interface SeenCall {
  readonly level: string;
  readonly arg0: unknown;
  readonly arg1: unknown;
}
let seen: SeenCall[];

const cookieFrom = (header: string | string[] | undefined): string =>
  (Array.isArray(header) ? (header[0] ?? '') : (header ?? '')).split(';')[0] ?? '';

const signInAs = async (username: string): Promise<{ cookie: string; csrf: string }> => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username, password: PASSWORD, guildId: GUILD },
  });
  return {
    cookie: cookieFrom(response.headers['set-cookie']),
    csrf: response.json<{ csrfToken: string }>().csrfToken,
  };
};

const buildDeps = (): HttpDeps => ({
  scopes: t.scopes,
  now: () => clock,
  guildIds: [GUILD],
  logger: {
    info: (...args: unknown[]) => void seen.push({ level: 'info', arg0: args[0], arg1: args[1] }),
    warn: (...args: unknown[]) => void seen.push({ level: 'warn', arg0: args[0], arg1: args[1] }),
    error: (...args: unknown[]) => void seen.push({ level: 'error', arg0: args[0], arg1: args[1] }),
    debug: (...args: unknown[]) => void seen.push({ level: 'debug', arg0: args[0], arg1: args[1] }),
    fatal: (...args: unknown[]) => void seen.push({ level: 'fatal', arg0: args[0], arg1: args[1] }),
    trace: (...args: unknown[]) => void seen.push({ level: 'trace', arg0: args[0], arg1: args[1] }),
  } as never,
  readonly: false,
  portsFor: (scope) => testPortsFor(scope, () => clock),
  instance: testInstanceFor(t.scopes.instance(), () => clock),
  assistantProviderConfig: {
    status: () => ({
      provider: 'gemini',
      enabled: true,
      modelConfigured: true,
      keyConfigured: false,
      keyReadable: false,
      costClass: 'unknown' as const,
      secretSource: 'file' as const,
    }),
    addKey: () => 'key_new_1',
    keys: () => [],
    chain: () => [],
    isKeyReadable: () => false,
    githubTokenConfigured: () => false,
  } as unknown as HttpDeps['assistantProviderConfig'],
});

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  seen = [];
  deps = buildDeps();
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'guild', now: clock });
  accountRepo.createAccount(t.scopes.instance(), {
    accountId: OWNER,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), OWNER);
  accountRepo.createAccount(t.scopes.instance(), {
    accountId: OPERATOR,
    username: 'operator',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: false,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), OPERATOR);
  app = createServer({
    deps,
    registerRoutes: (fastify, guard, routeDeps) => {
      registerAssistantProviderRoutes(fastify, guard, routeDeps);
      fastify.get('/api/test/boom', () => {
        throw new Error('boom');
      });
    },
  });
});

afterEach(async () => {
  await app.close();
  t.close();
});

describe('enriched error bodies', () => {
  it('(a) adds title, message and requestId to a 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/assistant/providers' });
    expect(response.statusCode).toBe(401);
    const body = response.json<Record<string, unknown>>();
    expect(body['error']).toBe('unauthenticated');
    expect(typeof body['title']).toBe('string');
    expect(typeof body['message']).toBe('string');
    expect(body['requestId']).toMatch(/^req-[0-9a-f]{8}$/);
  });

  it('(b) keeps a route-set message unchanged on the read-only 503', async () => {
    const readonlyApp = createServer({
      deps: { ...deps, readonly: true },
      registerRoutes: registerAssistantProviderRoutes,
    });
    try {
      const response = await readonlyApp.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: 'owner', password: PASSWORD, guildId: GUILD },
      });
      expect(response.statusCode).toBe(503);
      const body = response.json<Record<string, unknown>>();
      expect(body['error']).toBe('read-only');
      expect(body['message']).toBe(READONLY_MESSAGE);
    } finally {
      await readonlyApp.close();
    }
  });

  it('(c) answers a bad provider with field paths only, never the pasted key', async () => {
    const owner = await signInAs('owner');
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/keys',
      headers: { cookie: owner.cookie, [CSRF_HEADER]: owner.csrf },
      payload: { provider: 'bogus', label: 'x', apiKey: 'sk-SECRET-VALUE-123' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{
      fields?: readonly { path: string; problem: string }[];
    }>();
    expect(body.fields?.some((field) => field.path === 'provider')).toBe(true);
    expect(JSON.stringify(body)).not.toContain('sk-SECRET-VALUE-123');
  });

  it('(d) ties the 500 body to the request failed log line by requestId', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/test/boom' });
    expect(response.statusCode).toBe(500);
    const body = response.json<Record<string, unknown>>();
    expect(body['error']).toBe('internal');
    expect(typeof body['title']).toBe('string');
    expect(typeof body['message']).toBe('string');
    const requestId = body['requestId'];
    expect(requestId).toMatch(/^req-[0-9a-f]{8}$/);
    const failed = seen.find(
      (call) =>
        call.level === 'error' &&
        call.arg1 === 'request failed' &&
        typeof call.arg0 === 'object' &&
        call.arg0 !== null &&
        (call.arg0 as Record<string, unknown>)['requestId'] === requestId,
    );
    expect(failed, 'expected a request failed log line with the same requestId').toBeDefined();
  });

  it('(e) reports instanceOwner on /api/session', async () => {
    const owner = await signInAs('owner');
    const asOwner = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie: owner.cookie },
    });
    expect(asOwner.json<Record<string, unknown>>()['instanceOwner']).toBe(true);
    const operator = await signInAs('operator');
    const asOperator = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie: operator.cookie },
    });
    expect(asOperator.json<Record<string, unknown>>()['instanceOwner']).toBe(false);
  });
});
