import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseGuildId, type AssistantTrace, type Capability } from '@bananasaurs/core';
import type * as Storage from '@bananasaurs/storage';
import {
  accountRepo,
  authzRepo,
  conversationRepo,
  effectRepo,
  guildRepo,
  traceRepo,
} from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createServer, CSRF_HEADER, type HttpDeps } from '../server.js';
import { hashPassword } from '../secrets.js';
import { testInstanceFor, testPortsFor } from '../test-support.js';
import { registerAssistantConversationRoutes } from './assistant-conversations.js';

/**
 * Counts the batched repo calls the routes under test make. The wrappers
 * delegate to the real repos, so seeding and every other behaviour is
 * unchanged — only the call count is observable.
 */
const batchedCalls = vi.hoisted(() => ({ people: 0, tracesByIds: 0 }));
vi.mock('@bananasaurs/storage', async (importOriginal) => {
  const mod = await importOriginal<typeof Storage>();
  return {
    ...mod,
    conversationRepo: {
      ...mod.conversationRepo,
      peopleForConversations: (
        scope: Parameters<typeof mod.conversationRepo.peopleForConversations>[0],
        ids: Parameters<typeof mod.conversationRepo.peopleForConversations>[1],
      ) => {
        batchedCalls.people += 1;
        return mod.conversationRepo.peopleForConversations(scope, ids);
      },
    },
    traceRepo: {
      ...mod.traceRepo,
      getTracesByIds: (
        scope: Parameters<typeof mod.traceRepo.getTracesByIds>[0],
        ids: Parameters<typeof mod.traceRepo.getTracesByIds>[1],
      ) => {
        batchedCalls.tracesByIds += 1;
        return mod.traceRepo.getTracesByIds(scope, ids);
      },
    },
  };
});

const GUILD = parseGuildId('111111111111111111');
const OTHER_GUILD = parseGuildId('222222222222222222');
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
const MEMBER = '100000000000000001';
const CHANNEL = '333333333333333333';

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
  channelId: CHANNEL,
  behaviourId: 'club',
  command: 'ask',
  source: 'mention',
  conversationId: 'conv-1',
  turnId: 'turn-user',
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
  sources: [{ title: 'Meetings page', url: 'https://example.com/meetings' }],
  flags: [],
  ...over,
});

const seedConversation = (
  conversationId: string,
  at: number,
  title = `title-${conversationId}`,
): void => {
  const scope = t.scopes.forGuild(GUILD);
  conversationRepo.createConversation(scope, {
    conversationId,
    channelId: CHANNEL,
    behaviourId: 'club',
    startedBy: MEMBER,
    title,
    source: 'discord',
    at,
  });
  conversationRepo.appendTurn(scope, {
    conversationId,
    turnId: `${conversationId}-turn-user`,
    at,
    role: 'user',
    authorId: MEMBER,
    authorName: 'Bryan',
    text: `question text for ${conversationId}`,
  });
  conversationRepo.appendTurn(scope, {
    conversationId,
    turnId: `${conversationId}-turn-assistant`,
    at: at + 1,
    role: 'assistant',
    authorName: 'Bananasaurs',
    text: `answer text for ${conversationId}`,
    traceId: `${conversationId}-trace`,
  });
  traceRepo.insertTrace(
    scope,
    trace({
      traceId: `${conversationId}-trace`,
      at: at + 1,
      conversationId,
      turnId: `${conversationId}-turn-assistant`,
    }),
  );
};

beforeEach(async () => {
  t = openMigratedTestDatabase();
  batchedCalls.people = 0;
  batchedCalls.tracesByIds = 0;
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
  guildRepo.upsertGuild(t.scopes.forGuild(OTHER_GUILD), { name: 'other', now: clock });
  accountRepo.createAccount(t.scopes.instance(), {
    accountId: ACCOUNT,
    username: 'owner',
    passwordHash: await hashPassword(PASSWORD),
    isOwner: true,
    now: clock,
  });
  accountRepo.grantGuildAccess(t.scopes.forGuild(GUILD), ACCOUNT);
  app = createServer({ deps, registerRoutes: registerAssistantConversationRoutes });
});
afterEach(async () => {
  await app.close();
  t.close();
});

describe('assistant conversation routes', () => {
  it('requires audit.read to read the list, one conversation and the retention', async () => {
    const { cookie } = await signIn();
    for (const url of [
      '/api/assistant/conversations',
      '/api/assistant/conversations/conv-1',
      '/api/assistant/conversation-retention',
    ]) {
      expect((await app.inject({ method: 'GET', url, headers: { cookie } })).statusCode).toBe(403);
    }
  });

  it('requires config.write to end, delete and set the retention', async () => {
    grant('audit.read');
    seedConversation('conv-1', 1_790_000_000_000);
    const { cookie, csrf } = await signIn();
    const headers = { cookie, [CSRF_HEADER]: csrf };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/assistant/conversations/conv-1/end',
          headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/assistant/conversations/conv-1', headers }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/assistant/conversation-retention',
          headers,
          payload: { days: 61 },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('lists last activity newest first when no sort is given', async () => {
    grant('audit.read');
    seedConversation('conv-old', 1_000, 'old-unique-title');
    seedConversation('conv-new', 3_000, 'new-unique-title');
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/conversations',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ conversations: { conversationId: string }[] }>();
    expect(body.conversations.map((c) => c.conversationId)).toEqual(['conv-new', 'conv-old']);
  });

  it('refuses a limit above 100', async () => {
    grant('audit.read');
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/conversations?limit=101',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers 404 not-found for an unknown conversation id', async () => {
    grant('audit.read');
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const headers = { cookie, [CSRF_HEADER]: csrf };
    expect(
      (await app.inject({ method: 'GET', url: '/api/assistant/conversations/nope', headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/assistant/conversations/nope',
          headers: { cookie },
        })
      ).json(),
    ).toMatchObject({ error: 'not-found' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/assistant/conversations/nope/end',
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/assistant/conversations/nope', headers }))
        .statusCode,
    ).toBe(404);
  });

  it('ends a conversation and audits the id without conversation text', async () => {
    grant('audit.read');
    grant('config.write');
    seedConversation('conv-1', 1_790_000_000_000, 'end-me-title-secret-xyz');
    const { cookie, csrf } = await signIn();
    const headers = { cookie, [CSRF_HEADER]: csrf };
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/conversations/conv-1/end',
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(conversationRepo.getConversation(t.scopes.forGuild(GUILD), 'conv-1')?.status).toBe(
      'ended',
    );
    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 10 });
    const ended = rows.find((r) => r.action === 'assistant_conversation.ended');
    expect(ended?.subjectId).toBe('conv-1');
    expect(`${ended?.before ?? ''}${ended?.after ?? ''}`).not.toContain('end-me-title-secret-xyz');
    expect(`${ended?.before ?? ''}${ended?.after ?? ''}`).not.toContain('question text for conv-1');
  });

  it('deletes a conversation with its traces and audits ids and counts only', async () => {
    grant('audit.read');
    grant('config.write');
    seedConversation('conv-1', 1_790_000_000_000, 'delete-me-title-secret-xyz');
    const { cookie, csrf } = await signIn();
    const headers = { cookie, [CSRF_HEADER]: csrf };
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/assistant/conversations/conv-1',
      headers,
    });
    expect(response.statusCode).toBe(200);
    const scope = t.scopes.forGuild(GUILD);
    expect(conversationRepo.getConversation(scope, 'conv-1')).toBeUndefined();
    expect(traceRepo.getTrace(scope, 'conv-1-trace')).toBeUndefined();
    const rows = effectRepo.tailAudit(scope, { limit: 10 });
    const deleted = rows.find((r) => r.action === 'assistant_conversation.deleted');
    expect(deleted?.subjectId).toBe('conv-1');
    expect(`${deleted?.before ?? ''}${deleted?.after ?? ''}`).not.toContain(
      'delete-me-title-secret-xyz',
    );
    expect(`${deleted?.before ?? ''}${deleted?.after ?? ''}`).not.toContain(
      'answer text for conv-1',
    );
  });

  it('keeps one guild conversations out of another', async () => {
    grant('audit.read');
    seedConversation('conv-here', 1_000, 'here-title');
    const other = t.scopes.forGuild(OTHER_GUILD);
    conversationRepo.createConversation(other, {
      conversationId: 'conv-there',
      channelId: CHANNEL,
      behaviourId: 'club',
      startedBy: MEMBER,
      title: 'there-title',
      source: 'discord',
      at: 2_000,
    });
    const { cookie } = await signIn();
    const list = await app.inject({
      method: 'GET',
      url: '/api/assistant/conversations',
      headers: { cookie },
    });
    const body = list.json<{ conversations: { conversationId: string }[] }>();
    expect(body.conversations.map((c) => c.conversationId)).toEqual(['conv-here']);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/assistant/conversations/conv-there',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('reads the default 6-month retention and only accepts 61, 182, 365 or null', async () => {
    grant('audit.read');
    grant('config.write');
    const { cookie, csrf } = await signIn();
    const headers = { cookie, [CSRF_HEADER]: csrf };
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/assistant/conversation-retention',
          headers: { cookie },
        })
      ).json(),
    ).toEqual({ days: 182 });
    for (const bad of [{ days: 30 }, { days: 'forever' }, {}]) {
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/assistant/conversation-retention',
            headers,
            payload: bad,
          })
        ).statusCode,
      ).toBe(400);
    }
    for (const days of [61, 365, null, 182]) {
      const set = await app.inject({
        method: 'PUT',
        url: '/api/assistant/conversation-retention',
        headers,
        payload: { days },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json()).toEqual({ days });
    }
    const rows = effectRepo.tailAudit(t.scopes.forGuild(GUILD), { limit: 10 });
    const retention = rows.find((r) => r.action === 'assistant_settings.retention_set');
    expect(retention).toBeDefined();
  });

  it('returns the transcript with each assistant turn trace id and sources', async () => {
    grant('audit.read');
    seedConversation('conv-1', 1_790_000_000_000);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/conversations/conv-1',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      conversation: { conversationId: string };
      turns: {
        turnId: string;
        role: string;
        traceId?: string;
        sources?: { title: string; url: string }[];
      }[];
    }>();
    expect(body.conversation.conversationId).toBe('conv-1');
    const assistant = body.turns.find((turn) => turn.role === 'assistant');
    expect(assistant?.traceId).toBe('conv-1-trace');
    expect(assistant?.sources).toEqual([
      { title: 'Meetings page', url: 'https://example.com/meetings' },
    ]);
  });

  it('returns links in both directions with joinRule and keeps guild scope', async () => {
    grant('audit.read');
    seedConversation('conv-1', 1_000);
    seedConversation('conv-2', 2_000);
    const scope = t.scopes.forGuild(GUILD);
    conversationRepo.appendTurn(scope, {
      conversationId: 'conv-1',
      turnId: 'conv-1-turn-followup',
      at: 1_001,
      role: 'user',
      authorId: MEMBER,
      authorName: 'Bryan',
      text: 'a follow-up question',
      joinRule: 'follow-up',
    });
    conversationRepo.linkConversations(scope, {
      conversationId: 'conv-1',
      linkedConversationId: 'conv-2',
      kind: 'same-channel',
      at: 3_000,
    });
    const other = t.scopes.forGuild(OTHER_GUILD);
    conversationRepo.createConversation(other, {
      conversationId: 'conv-1',
      channelId: CHANNEL,
      behaviourId: 'club',
      startedBy: MEMBER,
      title: 'other-title-conv-1',
      source: 'discord',
      at: 1_000,
    });
    conversationRepo.createConversation(other, {
      conversationId: 'conv-other',
      channelId: CHANNEL,
      behaviourId: 'club',
      startedBy: MEMBER,
      title: 'other-title-conv-other',
      source: 'discord',
      at: 2_000,
    });
    conversationRepo.linkConversations(other, {
      conversationId: 'conv-1',
      linkedConversationId: 'conv-other',
      kind: 'same-channel',
      at: 3_000,
    });
    const { cookie } = await signIn();
    const first = await app.inject({
      method: 'GET',
      url: '/api/assistant/conversations/conv-1',
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{
      turns: { turnId: string; joinRule?: string }[];
      links: {
        otherConversationId: string;
        otherTitle: string;
        kind: string;
        direction: string;
        at: number;
      }[];
    }>();
    expect(firstBody.turns.find((turn) => turn.turnId === 'conv-1-turn-followup')?.joinRule).toBe(
      'follow-up',
    );
    expect(firstBody.links).toEqual([
      {
        otherConversationId: 'conv-2',
        otherTitle: 'title-conv-2',
        kind: 'same-channel',
        direction: 'outgoing',
        at: 3_000,
      },
    ]);
    const second = await app.inject({
      method: 'GET',
      url: '/api/assistant/conversations/conv-2',
      headers: { cookie },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<{
      links: {
        otherConversationId: string;
        otherTitle: string;
        kind: string;
        direction: string;
        at: number;
      }[];
    }>();
    expect(secondBody.links).toEqual([
      {
        otherConversationId: 'conv-1',
        otherTitle: 'title-conv-1',
        kind: 'same-channel',
        direction: 'incoming',
        at: 3_000,
      },
    ]);
  });

  it('batches the people lookup into one call per list page', async () => {
    grant('audit.read');
    seedConversation('conv-1', 1_000);
    seedConversation('conv-2', 2_000);
    seedConversation('conv-3', 3_000);
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/conversations?limit=3',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ conversations: { people: string[] }[] }>();
    expect(batchedCalls.people).toBe(1);
    for (const conversation of body.conversations) {
      expect(conversation.people).toEqual(['Bryan']);
    }
  });

  it('batches the transcript trace lookup into one call', async () => {
    grant('audit.read');
    seedConversation('conv-1', 1_790_000_000_000);
    const scope = t.scopes.forGuild(GUILD);
    conversationRepo.appendTurn(scope, {
      conversationId: 'conv-1',
      turnId: 'conv-1-turn-assistant-2',
      at: 1_790_000_000_002,
      role: 'assistant',
      authorName: 'Bananasaurs',
      text: 'a second answer',
      traceId: 'conv-1-trace-2',
    });
    traceRepo.insertTrace(
      scope,
      trace({ traceId: 'conv-1-trace-2', at: 1_790_000_000_002, conversationId: 'conv-1' }),
    );
    const { cookie } = await signIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/assistant/conversations/conv-1',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(batchedCalls.tracesByIds).toBe(1);
    const body = response.json<{ turns: { role: string; sources?: unknown[] }[] }>();
    const assistants = body.turns.filter((turn) => turn.role === 'assistant');
    expect(assistants).toHaveLength(2);
    for (const assistant of assistants) {
      expect(assistant.sources).toEqual([
        { title: 'Meetings page', url: 'https://example.com/meetings' },
      ]);
    }
  });
});
