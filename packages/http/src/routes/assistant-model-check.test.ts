import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseGuildId } from '@bananasaurs/core';
import { accountRepo, effectRepo, eligibilityRepo, guildRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createServer, CSRF_HEADER, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerAssistantModelCheckRoutes } from './assistant-model-check.js';

const GUILD = parseGuildId('111111111111111111');
const OWNER = 'acct_0123456789abcdef0123456789abcdef';
const OPERATOR = 'acct_fedcba9876543210fedcba9876543210';
const PASSWORD = 'correct horse battery staple';

let t: MigratedTestDatabase;
let deps: HttpDeps;
let app: FastifyInstance;
let clock: number;

interface Call {
  readonly toolNames: readonly string[];
  readonly reservationsBeforeCall: number;
}
let providerCalls: Call[];
let reservations: number;
let reservationAttempts: number;
let reserveLimit: number;
let toolsOffered: string[];

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

const post = async (
  who: string,
  payload: unknown,
): Promise<{ statusCode: number; json: () => Record<string, unknown> }> => {
  const session = await signInAs(who);
  const res = await app.inject({
    method: 'POST',
    url: '/api/assistant/model-check',
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrf },
    payload,
  });
  return {
    statusCode: res.statusCode,
    json: () => JSON.parse(res.body) as Record<string, unknown>,
  };
};

const auditActions = (): string[] =>
  effectRepo
    .tailAudit(t.scopes.forGuild(GUILD), {})
    .filter((row) => row.action.startsWith('assistant_provider.'))
    .map((row) => row.action);

const entryOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  providerId: 'gemini',
  model: 'gemini-3.5-flash-lite',
  keyId: 'key_a',
  keyLabel: 'Main key',
  mayTrain: false,
  rpmLimit: null,
  rpdLimit: null,
  selectedKeyId: 'key_b',
  provider: {
    id: 'gemini',
    capabilities: new Set(['text', 'tools']),
    generateText: async (request: {
      messages: readonly { text: string }[];
      tools?: readonly { name: string }[];
    }) => {
      providerCalls.push({
        toolNames: (request.tools ?? []).map((tool) => tool.name),
        reservationsBeforeCall: reservations,
      });
      toolsOffered = (request.tools ?? []).map((tool) => tool.name);
      const asksForTool = request.messages[0]?.text !== 'hi';
      return {
        text: asksForTool ? '' : 'Hello!',
        model: 'gemini-3.5-flash-lite',
        ...(asksForTool ? { toolCalls: [{ name: 'list_sources', args: {} }] } : {}),
      };
    },
  },
  ...over,
});

const fakeStore = () => ({
  chain: () => [
    entryOf(),
    entryOf({ provider: undefined, skip: 'disabled' }),
    entryOf(),
    entryOf(),
    entryOf({ provider: undefined, providerId: 'mystery', skip: 'unverified' }),
  ],
  reserveTestCall: () => {
    reservationAttempts += 1;
    if (reservations >= reserveLimit) {
      return { ok: false as const, code: 'local-rpd-limit' as const, availableAt: clock + 1 };
    }
    reservations += 1;
    return { ok: true as const };
  },
});

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  providerCalls = [];
  reservations = 0;
  reservationAttempts = 0;
  reserveLimit = 100;
  toolsOffered = [];
  deps = {
    scopes: t.scopes,
    now: () => clock,
    guildIds: [GUILD],
    logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} } as never,
    readonly: false,
    portsFor: (scope) => testPortsFor(scope, () => clock),
    instance: testInstanceFor(t.scopes.instance(), () => clock),
    assistantProviderConfig: fakeStore() as unknown as HttpDeps['assistantProviderConfig'],
  };
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
  eligibilityRepo.recordEligibilityClaim(t.scopes.instance(), {
    provider: 'gemini',
    trainsOnInput: 'no',
    evidenceUrl: 'https://example.test/terms',
    evidenceClause: 'Does not train on input.',
    productionUseAllowed: true,
    now: clock,
  });
  app = createServer({ deps, registerRoutes: registerAssistantModelCheckRoutes });
});
afterEach(async () => {
  await app.close();
  t.close();
});

describe('check models (ADR 0143)', () => {
  it('shows expected versus first action per fixture with stubbed tools', async () => {
    const res = await post('owner', { position: 0 });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      results: { id: string; expectedFirstAction: string; firstAction: string }[];
      budget: unknown;
      ledgerSource: string;
    };
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(3);
    expect(body.results[0]).toMatchObject({
      id: 'greeting-light',
      expectedFirstAction: 'answer-without-tools',
      firstAction: 'answer-without-tools',
    });
    expect(body.results[1]).toMatchObject({ id: 'reminder-standard', firstAction: 'call-tool' });
    expect(body.budget).toEqual({ reserved: 3, spent: 3 });
    expect(body.ledgerSource).toBe('dashboard-test');
    expect(auditActions()).toContain('assistant_provider.model_checked');
  });

  it('reserves the whole budget before the first call', async () => {
    reserveLimit = 3;
    await post('owner', { position: 0 });
    expect(reservationAttempts).toBe(3);
    expect(reservations).toBe(3);
    expect(providerCalls).toHaveLength(3);
    expect(providerCalls.map((call) => call.reservationsBeforeCall)).toEqual([3, 3, 3]);
  });

  it.each([0, 1, 2])(
    'refuses before any call when only %i fixtures can be reserved',
    async (limit) => {
      reserveLimit = limit;
      const res = await post('owner', { position: 0 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: false,
        error: 'budget-exhausted',
        budget: { reserved: 0, spent: 0 },
      });
      expect(reservationAttempts).toBe(3);
      // There is no release API: successful preflight reservations stay spent.
      expect(reservations).toBe(limit);
      expect(providerCalls).toHaveLength(0);
      expect(auditActions()).toEqual([]);
    },
  );

  it('only offers declaration-only stub tools and never touches member data', async () => {
    await post('owner', { position: 0 });
    expect(toolsOffered.length).toBeGreaterThan(0);
    expect(toolsOffered.every((name) => ['list_sources', 'read_chunk'].includes(name))).toBe(true);
    expect(auditActions()).toEqual(['assistant_provider.model_checked']);
  });

  it('terms-unverified entries refuse without calling', async () => {
    const res = await post('owner', { position: 4 });
    expect(res.json()).toMatchObject({ ok: false });
    expect(reservations).toBe(0);
    expect(providerCalls).toHaveLength(0);
  });

  it('is owner-only and 404s an unknown position', async () => {
    expect((await post('operator', { position: 0 })).statusCode).toBe(403);
    expect((await post('owner', { position: 9 })).statusCode).toBe(404);
    expect(providerCalls).toHaveLength(0);
  });
});
