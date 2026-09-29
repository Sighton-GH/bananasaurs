import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseGuildId, type Capability } from '@bananasaurs/core';
import { accountRepo, assistantRepo, authzRepo, effectRepo, guildRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createServer, CSRF_HEADER, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import {
  registerAssistantTryRoutes,
  resetTryRateLimits,
  type TryAssistantDeps,
} from './assistant-try.js';

const GUILD = parseGuildId('111111111111111111');
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
const ROLE_A = '222222222222222222';

let t: MigratedTestDatabase;
let deps: HttpDeps & TryAssistantDeps;
let app: FastifyInstance;
let clock: number;
let tried: { question: string; conversationId: string | undefined }[];

const cookieFrom = (header: string | string[] | undefined): string =>
  (Array.isArray(header) ? (header[0] ?? '') : (header ?? '')).split(';')[0] ?? '';
const signIn = async (
  username = 'owner',
  password = PASSWORD,
): Promise<{ cookie: string; csrf: string }> => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username, password, guildId: GUILD },
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
const post = (cookie: string, csrf: string, id: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/api/assistant/behaviours/${id}/try`,
    headers: { cookie, [CSRF_HEADER]: csrf },
    payload,
  });

beforeEach(async () => {
  t = openMigratedTestDatabase();
  clock = 1_700_000_000_000;
  tried = [];
  resetTryRateLimits();
  const tryAssistant: TryAssistantDeps['tryAssistant'] = async (_scope, input) => {
    tried.push({ question: input.question, conversationId: input.conversationId });
    return {
      answer: `Answer to ${input.question}.`,
      traceId: `try_trace_${String(tried.length)}`,
      conversationId: input.conversationId ?? `try_conv_${String(tried.length)}`,
    };
  };
  deps = {
    scopes: t.scopes,
    now: () => clock,
    guildIds: [GUILD],
    logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {} } as never,
    readonly: false,
    portsFor: (scope) => testPortsFor(scope, () => clock),
    instance: testInstanceFor(t.scopes.instance(), () => clock),
    tryAssistant,
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
  assistantRepo.putBehaviour(
    t.scopes.forGuild(GUILD),
    {
      id: 'club',
      guildId: GUILD,
      surface: 'bananasaurs',
      mentionRoleId: ROLE_A,
      name: 'Club',
      systemPrompt: 'Be helpful.',
      promptVersion: 1,
      preferredSkillIds: ['search-club'],
      callerRoleIds: [],
      reviewerRoleIds: [],
      resourceIds: [],
      enabled: true,
    },
    clock,
  );
  app = createServer({ deps, registerRoutes: registerAssistantTryRoutes });
});
afterEach(async () => {
  await app.close();
  t.close();
});

describe('POST /api/assistant/behaviours/:id/try', () => {
  it('requires config.write', async () => {
    const { cookie, csrf } = await signIn();
    const response = await post(cookie, csrf, 'club', { question: 'hi' });
    expect(response.statusCode).toBe(403);
  });

  it('answers 404 for an unknown behaviour and 400 for an empty question', async () => {
    const { cookie, csrf } = await signIn();
    grant('config.write');
    expect((await post(cookie, csrf, 'missing', { question: 'hi' })).statusCode).toBe(404);
    expect((await post(cookie, csrf, 'club', { question: '  ' })).statusCode).toBe(400);
  });

  it('tries the behaviour and forwards a continuing conversation id', async () => {
    const { cookie, csrf } = await signIn();
    grant('config.write');
    const first = await post(cookie, csrf, 'club', { question: 'when is the meeting?' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      answer: 'Answer to when is the meeting?.',
      traceId: 'try_trace_1',
      conversationId: 'try_conv_1',
    });
    const second = await post(cookie, csrf, 'club', {
      question: 'and parking?',
      conversationId: 'try_conv_1',
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ conversationId: 'try_conv_1' });
    expect(tried[1]).toEqual({ question: 'and parking?', conversationId: 'try_conv_1' });
  });

  it('audits the try without the question text', async () => {
    const { cookie, csrf } = await signIn();
    grant('config.write');
    await post(cookie, csrf, 'club', { question: 'the secret meeting question' });
    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 10 });
    const row = rows.find((r) => r.action === 'assistant_behaviour.tried');
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain('the secret meeting question');
  });

  it('rate-limits the 21st try in an hour with 429 rate-limited', async () => {
    const { cookie, csrf } = await signIn();
    grant('config.write');
    for (let i = 0; i < 20; i += 1) {
      const response = await post(cookie, csrf, 'club', { question: `q${String(i)}` });
      expect(response.statusCode).toBe(200);
    }
    const limited = await post(cookie, csrf, 'club', { question: 'one too many' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      error: 'rate-limited',
      message: 'You have used your 20 tries for this hour. Try again later.',
    });
  });
});
