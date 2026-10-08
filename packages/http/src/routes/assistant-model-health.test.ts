import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseGuildId, type Capability } from '@bananasaurs/core';
import { accountRepo, authzRepo, guildRepo, runRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createServer, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerAssistantModelHealthRoutes } from './assistant-model-health.js';

/** ADR 0129 §8: per-model health from the run ledger, gated on audit.read. */
const GUILD = parseGuildId('111111111111111111');
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
const MEMBER = '100000000000000001';
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

/** Stored-data fixture: fixed ids and timestamps, no narrative. */
const seedResult = (
  runId: string,
  at: number,
  over: {
    readonly ok?: boolean;
    readonly code?: string;
    readonly providerMessage?: string;
    readonly model?: string;
    readonly keyId?: string;
  } = {},
): void => {
  const scope = t.scopes.forGuild(GUILD);
  runRepo.ensureRun(scope, {
    runId,
    userId: MEMBER,
    behaviourId: 'club',
    source: 'mention',
    queuedAt: at,
  });
  runRepo.appendRunEvent(scope, runId, at, {
    kind: 'model-result',
    provider: 'openrouter',
    model: over.model ?? 'model-a',
    keyId: over.keyId ?? 'key-1',
    ok: over.ok ?? false,
    ms: 50,
    ...(over.code === undefined ? { code: 'provider-bad-model' } : { code: over.code }),
    ...(over.providerMessage === undefined ? {} : { providerMessage: over.providerMessage }),
  });
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
  accountRepo.createAccount(t.scopes.instance(), {
    accountId: ACCOUNT,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), ACCOUNT);
  app = createServer({ deps, registerRoutes: registerAssistantModelHealthRoutes });
});
afterEach(async () => {
  await app.close();
  t.close();
});

describe('assistant model health route', () => {
  it('requires audit.read', async () => {
    const { cookie } = await signIn();
    expect(
      (await app.inject({ method: 'GET', url: '/api/assistant/model-health', headers: { cookie } }))
        .statusCode,
    ).toBe(403);
  });

  it('reports persistent after three bad-model results in the window', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    seedResult('run-1', clock - 1_000);
    seedResult('run-2', clock - 2_000);
    seedResult('run-3', clock - 3_000);
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/model-health',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      window: string;
      models: { model: string; persistent?: { code: string; count: number } }[];
    }>();
    expect(body.window).toBe('24h');
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({
      model: 'model-a',
      persistent: { code: 'provider-bad-model', count: 3 },
    });
  });

  it('strips providerMessage for audit.read only and keeps it for config.read', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    seedResult('run-1', clock - 1_000, { providerMessage: 'short reason' });
    seedResult('run-2', clock - 2_000, { providerMessage: 'short reason' });
    seedResult('run-3', clock - 3_000, { providerMessage: 'short reason' });
    const without = await app.inject({
      method: 'GET',
      url: '/api/assistant/model-health',
      headers: { cookie },
    });
    expect(without.statusCode).toBe(200);
    expect(JSON.stringify(without.json())).not.toContain('providerMessage');

    grant('config.read');
    const withGrant = await app.inject({
      method: 'GET',
      url: '/api/assistant/model-health',
      headers: { cookie },
    });
    expect(withGrant.statusCode).toBe(200);
    expect(
      withGrant.json<{
        models: { lastError?: { providerMessage?: string } }[];
      }>().models[0]?.lastError?.providerMessage,
    ).toBe('short reason');
  });

  it('window=7d widens the range beyond the default 24h', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    const threeDaysAgo = clock - 3 * 24 * 60 * 60 * 1000;
    seedResult('run-old-1', threeDaysAgo);
    seedResult('run-old-2', threeDaysAgo + 1);
    seedResult('run-old-3', threeDaysAgo + 2);
    const day = await app.inject({
      method: 'GET',
      url: '/api/assistant/model-health',
      headers: { cookie },
    });
    expect(day.json<{ models: unknown[] }>().models).toEqual([]);
    const week = await app.inject({
      method: 'GET',
      url: '/api/assistant/model-health?window=7d',
      headers: { cookie },
    });
    expect(week.statusCode).toBe(200);
    expect(week.json<{ window: string; models: unknown[] }>().window).toBe('7d');
    expect(week.json<{ models: unknown[] }>().models).toHaveLength(1);
  });
});
