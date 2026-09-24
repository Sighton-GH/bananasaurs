import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseGuildId, type AssistantTrace, type Capability } from '@bananasaurs/core';
import { accountRepo, authzRepo, guildRepo, traceRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createServer, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerAssistantTraceRoutes } from './assistant-traces.js';

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
const trace = (over: Partial<AssistantTrace> = {}): AssistantTrace => ({
  traceId: 'trace-1',
  at: 1_790_000_000_000,
  userId: MEMBER,
  channelId: '333333333333333333',
  behaviourId: 'club',
  command: 'ask',
  source: 'mention',
  conversationId: 'conv-1',
  turnId: 'turn-1',
  question: 'When is the next club meeting?',
  answer: 'Thursday at 6 pm.',
  outcome: 'answered',
  durationMs: 1200,
  attempts: [{ provider: 'gemini', model: 'gemini-2.5-flash', outcome: 'ok', ms: 900 }],
  finishReason: 'stop',
  usage: { promptTokens: 100, completionTokens: 20, thinkingTokens: 10 },
  sections: [{ name: 'system', chars: 12, estTokens: 3, text: 'Be helpful.' }],
  toolCalls: [],
  guard: { removed: [] },
  timeline: [{ label: 'posted', atMs: 1200 }],
  discordMessageIds: [],
  sources: [],
  flags: [],
  ...over,
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
  app = createServer({ deps, registerRoutes: registerAssistantTraceRoutes });
});
afterEach(async () => {
  await app.close();
  t.close();
});

describe('assistant trace routes', () => {
  it('requires audit.read for the list, the detail and the usage strip', async () => {
    const { cookie } = await signIn();
    for (const url of ['/api/assistant/traces', '/api/assistant/traces/trace-1']) {
      expect((await app.inject({ method: 'GET', url, headers: { cookie } })).statusCode).toBe(
        403,
      );
    }
    expect(
      (await app.inject({ method: 'GET', url: '/api/assistant/usage', headers: { cookie } }))
        .statusCode,
    ).toBe(403);
  });

  it('lists newest first and honours the outcome filter', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    traceRepo.insertTrace(scope, trace({ traceId: 'old', at: 1_000, outcome: 'answered' }));
    traceRepo.insertTrace(scope, trace({ traceId: 'new', at: 2_000, outcome: 'failed' }));
    const list = await app.inject({ method: 'GET', url: '/api/assistant/traces', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ traces: { traceId: string }[] }>().traces.map((r) => r.traceId)).toEqual([
      'new',
      'old',
    ]);
    const filtered = await app.inject({
      method: 'GET',
      url: '/api/assistant/traces?outcome=failed',
      headers: { cookie },
    });
    expect(filtered.json<{ traces: { traceId: string }[] }>().traces.map((r) => r.traceId)).toEqual(
      ['new'],
    );
  });

  it('resolves the member behind each row from live Discord, null when unknown', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    const scope = t.scopes.forGuild(GUILD);
    traceRepo.insertTrace(scope, trace({ traceId: 'known', userId: MEMBER }));
    traceRepo.insertTrace(scope, trace({ traceId: 'gone', userId: '199999999999999999' }));
    const list = await app.inject({
      method: 'GET',
      url: '/api/assistant/traces?limit=50',
      headers: { cookie },
    });
    const rows = list.json<{
      traces: { traceId: string; member: { username: string } | null }[];
    }>().traces;
    expect(rows.find((r) => r.traceId === 'known')?.member?.username).toBe('bryan');
    expect(rows.find((r) => r.traceId === 'gone')?.member).toBeNull();
  });

  it('answers 400 for an invalid limit or day count', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    expect(
      (await app.inject({ method: 'GET', url: '/api/assistant/traces?limit=0', headers: { cookie } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/api/assistant/usage?days=many', headers: { cookie } }))
        .statusCode,
    ).toBe(400);
  });

  it('withholds prompt text without config.read but still answers the detail', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    traceRepo.insertTrace(t.scopes.forGuild(GUILD), trace());
    const without = await app.inject({
      method: 'GET',
      url: '/api/assistant/traces/trace-1',
      headers: { cookie },
    });
    expect(without.statusCode).toBe(200);
    const redacted = without.json<{ trace: AssistantTrace }>().trace;
    expect(redacted.question).toBe('When is the next club meeting?');
    expect(redacted.sections).toHaveLength(1);
    expect(redacted.sections[0]?.text).toBe('');
    expect(redacted.sections[0]?.name).toBe('system');

    grant('config.read');
    const withGrant = await app.inject({
      method: 'GET',
      url: '/api/assistant/traces/trace-1',
      headers: { cookie },
    });
    expect(withGrant.statusCode).toBe(200);
    expect(withGrant.json<{ trace: AssistantTrace }>().trace.sections[0]?.text).toBe(
      'Be helpful.',
    );
  });

  it('answers 404 for an unknown trace id', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/traces/nope',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not-found' });
  });

  it('serves the daily usage strip', async () => {
    clock = Date.UTC(2026, 8, 21, 12, 0, 0);
    grant('audit.read');
    const { cookie } = await signIn();
    traceRepo.insertTrace(
      t.scopes.forGuild(GUILD),
      trace({ at: Date.UTC(2026, 8, 21, 1, 0, 0), outcome: 'answered' }),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/usage?days=14',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      days: [{ day: '2026-09-21', answers: 1, failures: 0, fallbacks: 0, tokens: 130 }],
    });
  });
});
