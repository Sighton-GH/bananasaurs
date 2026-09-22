import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseGuildId, type Capability } from '@bananasaurs/core';
import { accountRepo, assistantRepo, authzRepo, guildRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createServer, CSRF_HEADER, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerAssistantRoutes } from './assistant.js';

const GUILD = parseGuildId('111111111111111111');
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
const ROLE_A = '222222222222222222';
const ROLE_B = '333333333333333333';
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
const body = (over: Record<string, unknown> = {}) => ({
  id: 'club',
  surface: 'bananasaurs',
  mentionRoleId: ROLE_A,
  name: 'Club',
  systemPrompt: 'Be helpful.',
  promptVersion: 0,
  allowedSkillIds: ['search-club'],
  callerRoleIds: [],
  ticket: { reviewerRoleIds: [] },
  resourceIds: [],
  enabled: true,
  ...over,
});
const put = (cookie: string, csrf: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PUT',
    url: `/api/assistant/behaviours/${String(payload.id)}`,
    headers: { cookie, [CSRF_HEADER]: csrf },
    payload,
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
  app = createServer({ deps, registerRoutes: registerAssistantRoutes });
});
afterEach(async () => {
  await app.close();
  t.close();
});

describe('assistant routes', () => {
  it('requires config.read for the directory and config.write for changes', async () => {
    const { cookie, csrf } = await signIn();
    expect(
      (await app.inject({ method: 'GET', url: '/api/assistant', headers: { cookie } })).statusCode,
    ).toBe(403);
    grant('config.read');
    expect(
      (await app.inject({ method: 'GET', url: '/api/assistant', headers: { cookie } })).statusCode,
    ).toBe(200);
    expect((await put(cookie, csrf, body())).statusCode).toBe(403);
  });

  it('returns prompt-version-conflict without overwriting', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    expect((await put(cookie, csrf, body())).statusCode).toBe(200);
    const conflict = await put(cookie, csrf, body({ systemPrompt: 'stale edit' }));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'prompt-version-conflict', currentVersion: 1 });
    expect(assistantRepo.listBehaviours(t.scopes.forGuild(GUILD))[0]?.systemPrompt).toBe(
      'Be helpful.',
    );
  });

  it('requires a mention role outside direct command and refuses ambiguous enabled routes', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const missing = await put(cookie, csrf, body({ mentionRoleId: undefined }));
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ error: 'mention-role-required' });
    expect((await put(cookie, csrf, body())).statusCode).toBe(200);
    const duplicateMention = await put(
      cookie,
      csrf,
      body({ id: 'help', surface: 'help', name: 'Help', promptVersion: 0 }),
    );
    expect(duplicateMention.statusCode).toBe(409);
    expect(duplicateMention.json()).toEqual({ error: 'behaviour-conflict', behaviourId: 'club' });
    expect(
      (
        await put(
          cookie,
          csrf,
          body({ id: 'direct', surface: 'direct-command', mentionRoleId: undefined }),
        )
      ).statusCode,
    ).toBe(200);
    const duplicateDirect = await put(
      cookie,
      csrf,
      body({ id: 'direct-two', surface: 'direct-command', mentionRoleId: undefined }),
    );
    expect(duplicateDirect.statusCode).toBe(409);
    expect(duplicateDirect.json()).toEqual({ error: 'behaviour-conflict', behaviourId: 'direct' });
    expect(
      (
        await put(
          cookie,
          csrf,
          body({ id: 'disabled', surface: 'help', mentionRoleId: ROLE_A, enabled: false }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await put(cookie, csrf, body({ id: 'other', surface: 'help', mentionRoleId: ROLE_B })))
        .statusCode,
    ).toBe(200);
  });
});

describe('assistant provider configuration', () => {
  it('refuses key input when the encrypted secret store is not configured', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/assistant/provider',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { provider: 'gemini', model: 'x', apiKey: 'must-not-echo', enabled: true },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('must-not-echo');
  });
  it('returns only keyConfigured after a write', async () => {
    grant('config.write');
    const { cookie, csrf } = await signIn();
    let saved = false;
    deps = {
      ...deps,
      assistantProviderConfig: {
        status: () => ({
          provider: 'gemini',
          enabled: true,
          modelConfigured: true,
          keyConfigured: saved,
        }),
        save: (input) => {
          expect(input.apiKey).toBe('must-not-echo');
          saved = true;
        },
      },
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantRoutes });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/assistant/provider',
      headers: { cookie, [CSRF_HEADER]: csrf },
      payload: { provider: 'gemini', model: 'x', apiKey: 'must-not-echo', enabled: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      provider: 'gemini',
      enabled: true,
      modelConfigured: true,
      keyConfigured: true,
    });
    expect(response.body).not.toContain('must-not-echo');
  });
});

describe('assistant memory routes', () => {
  it('round-trips server card and sectioned memory without exposing another guild', async () => {
    grant('config.read');
    grant('config.write');
    const { cookie, csrf } = await signIn();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/assistant/server-card',
          headers: { cookie, [CSRF_HEADER]: csrf },
          payload: { content: 'Club operating context' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/assistant/memories/goal-1',
          headers: { cookie, [CSRF_HEADER]: csrf },
          payload: { id: 'goal-1', section: 'Club goals', content: 'Finish the EV build' },
        })
      ).statusCode,
    ).toBe(200);
    const result = await app.inject({ method: 'GET', url: '/api/assistant', headers: { cookie } });
    expect(result.json()).toMatchObject({
      serverCard: 'Club operating context',
      memories: [{ id: 'goal-1', section: 'Club goals', content: 'Finish the EV build' }],
    });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/assistant/memories/goal-1',
          headers: { cookie, [CSRF_HEADER]: csrf },
        })
      ).statusCode,
    ).toBe(200);
    expect(assistantRepo.listMemories(t.scopes.forGuild(GUILD))).toEqual([]);
  });
});
