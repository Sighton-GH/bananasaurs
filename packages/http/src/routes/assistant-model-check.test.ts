import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
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
import { createProviderConfigStore } from '../../../../apps/daemon/src/assistant/provider-config.js';
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
let toolExecute: ReturnType<typeof vi.fn>;
let toolArgs: ReturnType<typeof vi.fn<() => Record<string, unknown>>>;
let logCalls: ReturnType<typeof vi.fn>;
const BUDGET_REFUSAL = {
  ok: false,
  error: 'budget-exhausted',
  budget: { reserved: 0, spent: 0 },
};

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
    payload: payload as object,
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
        ...(asksForTool
          ? {
              toolCalls: [
                {
                  name: 'list_sources',
                  get args() {
                    return toolArgs();
                  },
                  run: toolExecute,
                  execute: toolExecute,
                },
              ],
            }
          : {}),
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
  reserveTestEntry: () => {
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
  toolExecute = vi.fn(() => {
    throw new Error('tool execution forbidden');
  });
  toolArgs = vi.fn(() => ({}));
  logCalls = vi.fn();
  deps = {
    scopes: t.scopes,
    now: () => clock,
    guildIds: [GUILD],
    logger: {
      info: logCalls,
      warn: logCalls,
      error: logCalls,
      debug: logCalls,
      fatal: logCalls,
      trace: logCalls,
    } as never,
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
  vi.restoreAllMocks();
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
    expect(toolExecute).not.toHaveBeenCalled();
    expect(toolArgs).not.toHaveBeenCalled();
  });

  it('terms-unverified entries refuse without calling', async () => {
    const res = await post('owner', { position: 4 });
    expect(res.json()).toMatchObject({ ok: false });
    expect(reservations).toBe(0);
    expect(providerCalls).toHaveLength(0);
  });

  it.each(['absent', 'undefined'] as const)(
    'fails closed with an %s entry reserver',
    async (kind) => {
      const store = fakeStore();
      deps = {
        ...deps,
        assistantProviderConfig: {
          ...store,
          reserveTestEntry: kind === 'absent' ? undefined : () => undefined,
        } as unknown as HttpDeps['assistantProviderConfig'],
      };
      await app.close();
      app = createServer({ deps, registerRoutes: registerAssistantModelCheckRoutes });
      const res = await post('owner', { position: 0 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(BUDGET_REFUSAL);
      expect(providerCalls).toHaveLength(0);
      expect(auditActions()).toEqual([]);
    },
  );

  it('redacts a throwing reserver from both response and logs', async () => {
    const secret = 'test-only-reserver-secret-marker';
    const store = fakeStore();
    deps = {
      ...deps,
      assistantProviderConfig: {
        ...store,
        reserveTestEntry: () => {
          throw new Error(secret);
        },
      } as unknown as HttpDeps['assistantProviderConfig'],
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantModelCheckRoutes });
    const res = await post('owner', { position: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(BUDGET_REFUSAL);
    expect(JSON.stringify(res.json())).not.toContain(secret);
    expect(inspect(logCalls.mock.calls, { depth: null })).not.toContain(secret);
    expect(providerCalls).toHaveLength(0);
  });

  it.each(['unverified', 'ineligible'] as const)(
    'refuses an independently %s terms row',
    async (state) => {
      if (state === 'unverified') {
        t.raw.prepare('DELETE FROM provider_eligibility WHERE provider = ?').run('gemini');
      } else {
        eligibilityRepo.recordEligibilityClaim(t.scopes.instance(), {
          provider: 'gemini',
          trainsOnInput: 'unknown',
          evidenceUrl: 'https://example.test/terms',
          evidenceClause: 'Testing only.',
          productionUseAllowed: false,
          now: clock,
        });
      }
      const res = await post('owner', { position: 0 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: false,
        error:
          "The AI provider's terms are not recorded or don't allow this use, so no content was sent outside the server.",
      });
      expect(reservationAttempts).toBe(0);
      expect(providerCalls).toHaveLength(0);
    },
  );

  it('leaves all member-data tables unchanged', async () => {
    t.raw
      .prepare(
        'INSERT INTO log_member_snapshots (guild_id, user_id, username, role_ids, updated_at_ms) VALUES (?, ?, ?, ?, ?)',
      )
      .run(GUILD, '222222222222222222', 'Sam L', '[]', clock);
    // Snapshot every persisted table except the known owner-session, audit and quota writes.
    const tables = (
      t.raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    )
      .map(({ name }) => name)
      .filter(
        (name) => !['dashboard_sessions', 'audit_events', 'assistant_model_calls'].includes(name),
      );
    const snapshot = () =>
      Object.fromEntries(
        tables.map((name) => [name, t.raw.prepare(`SELECT * FROM "${name}"`).all()]),
      );
    const before = snapshot();
    await post('owner', { position: 0 });
    expect(snapshot()).toEqual(before);
  });

  it('pins a real provider pool and reserves all three calls on the key actually called', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const store = createProviderConfigStore(
      t.scopes.instance(),
      'a'.repeat(32),
      'env',
      undefined,
      undefined,
      { now: () => clock },
    );
    const first = store.addKey(
      { provider: 'gemini', label: 'One', apiKey: 'AIza-test-one' },
      clock,
    );
    const second = store.addKey(
      { provider: 'gemini', label: 'Two', apiKey: 'AIza-test-two' },
      clock + 1,
    );
    const model = 'gemini-3.5-flash-lite';
    store.saveChain([{ keyId: first, model, pool: 'provider', rpdLimit: 10 }], clock);
    const chain = vi.fn(() =>
      store.chain().map((entry) => ({
        ...entry,
        provider: {
          ...entry.provider,
          generateText: vi.fn(async (request: { model: string }) => {
            called.push({ keyId: entry.selectedKeyId, model: request.model });
            return { text: 'Hello!', model: request.model };
          }),
        },
      })),
    );
    const called: { keyId: string; model: string }[] = [];
    const reserve = vi.fn((entry: Parameters<typeof store.reserveTestEntry>[0], guildId: string) =>
      store.reserveTestEntry(entry, guildId),
    );
    deps = {
      ...deps,
      assistantProviderConfig: {
        ...store,
        chain,
        reserveTestEntry: reserve,
      } as unknown as HttpDeps['assistantProviderConfig'],
    };
    await app.close();
    app = createServer({ deps, registerRoutes: registerAssistantModelCheckRoutes });
    const res = await post('owner', { position: 0 });
    expect(res.json()).toMatchObject({ ok: true, budget: { reserved: 3, spent: 3 } });
    expect(chain).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(3);
    expect(called).toHaveLength(3);
    expect([first, second]).toContain(called[0]?.keyId);
    expect(called).toEqual(Array.from({ length: 3 }, () => ({ keyId: called[0]!.keyId, model })));
    expect(
      reserve.mock.calls.every(
        ([entry, guildId]) =>
          entry === reserve.mock.calls[0]![0] &&
          entry.selectedKeyId === called[0]!.keyId &&
          entry.model === model &&
          guildId === GUILD,
      ),
    ).toBe(true);
    expect(
      t.raw
        .prepare(
          'SELECT key_id, model, guild_id, count(*) AS calls FROM assistant_model_calls GROUP BY key_id, model, guild_id',
        )
        .all(),
    ).toEqual([{ key_id: called[0]!.keyId, model, guild_id: GUILD, calls: 3 }]);
  });

  it('is owner-only and 404s an unknown position', async () => {
    expect((await post('operator', { position: 0 })).statusCode).toBe(403);
    expect((await post('owner', { position: 9 })).statusCode).toBe(404);
    expect(providerCalls).toHaveLength(0);
  });
});
