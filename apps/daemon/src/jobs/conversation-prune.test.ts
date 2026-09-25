import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  conversationPruneDedupeKey,
  JOB_KINDS,
  parseGuildId,
  type AssistantTrace,
} from '@bananasaurs/core';
import {
  assistantRepo,
  conversationRepo,
  effectRepo,
  guildRepo,
  traceRepo,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { conversationPruneHandler } from './conversation-prune.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL = '333333333333333333';
const MEMBER = '444444444444444444';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-25T12:00:00.000Z');

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let nowMs: number;

const context = { jobId: 1, attempts: 1, cursor: null, saveCursor: () => {} } as const;

/** Stored-data fixture: fixed ids and timestamps, no narrative. */
const trace = (over: Partial<AssistantTrace> = {}): AssistantTrace => ({
  traceId: 'trace-1',
  at: NOW,
  userId: MEMBER,
  channelId: CHANNEL,
  behaviourId: 'club',
  command: 'ask',
  source: 'mention',
  conversationId: 'conv-old',
  turnId: 'conv-old-turn',
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

const seedConversation = (
  guild: typeof GUILD_A,
  conversationId: string,
  at: number,
  title = `title-${conversationId}`,
): void => {
  const scope = t.scopes.forGuild(guild);
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
    turnId: `${conversationId}-turn`,
    at,
    role: 'user',
    authorId: MEMBER,
    authorName: 'Bryan',
    text: `question text for ${conversationId}`,
  });
};

beforeEach(() => {
  t = openMigratedTestDatabase();
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_A), { name: 'guild-a', now: 0 });
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_B), { name: 'guild-b', now: 0 });
  nowMs = NOW;
});
afterEach(() => t.close());

describe('conversationPruneHandler', () => {
  it('deletes exactly the expired conversations and their traces, and keeps newer ones', async () => {
    const scope = t.scopes.forGuild(GUILD_A);
    assistantRepo.setConversationRetention(scope, 61, nowMs);
    seedConversation(GUILD_A, 'conv-old', NOW - 62 * DAY_MS, 'old-title-secret-xyz');
    seedConversation(GUILD_A, 'conv-new', NOW - 10 * DAY_MS, 'new-title');
    traceRepo.insertTrace(scope, trace({ traceId: 'old-trace', conversationId: 'conv-old' }));
    traceRepo.insertTrace(scope, trace({ traceId: 'new-trace', conversationId: 'conv-new' }));

    await conversationPruneHandler(scope, { now: () => nowMs, logger }).run(
      { day: '2026-09-25' },
      { ...context },
    );

    expect(conversationRepo.getConversation(scope, 'conv-old')).toBeUndefined();
    expect(conversationRepo.getConversation(scope, 'conv-new')).toBeDefined();
    expect(traceRepo.getTrace(scope, 'old-trace')).toBeUndefined();
    expect(traceRepo.getTrace(scope, 'new-trace')).toBeDefined();
  });

  it('writes one count-only audit row, never conversation text', async () => {
    const scope = t.scopes.forGuild(GUILD_A);
    assistantRepo.setConversationRetention(scope, 61, nowMs);
    seedConversation(GUILD_A, 'conv-old', NOW - 62 * DAY_MS, 'old-title-secret-xyz');
    seedConversation(GUILD_A, 'conv-older', NOW - 90 * DAY_MS, 'older-title-secret-xyz');

    await conversationPruneHandler(scope, { now: () => nowMs, logger }).run(
      { day: '2026-09-25' },
      { ...context },
    );

    const rows = effectRepo.tailAudit(scope, { limit: 10 });
    const pruned = rows.filter((r) => r.action === 'assistant_conversation.pruned');
    expect(pruned).toHaveLength(1);
    expect(pruned[0]?.after).toBe(JSON.stringify({ count: 2 }));
    const logged = `${pruned[0]?.before ?? ''}${pruned[0]?.after ?? ''}`;
    expect(logged).not.toContain('old-title-secret-xyz');
    expect(logged).not.toContain('question text for conv-old');
  });

  it('writes no audit row when nothing expired', async () => {
    const scope = t.scopes.forGuild(GUILD_A);
    assistantRepo.setConversationRetention(scope, 61, nowMs);
    seedConversation(GUILD_A, 'conv-new', NOW - 10 * DAY_MS);

    await conversationPruneHandler(scope, { now: () => nowMs, logger }).run(
      { day: '2026-09-25' },
      { ...context },
    );

    expect(
      effectRepo
        .tailAudit(scope, { limit: 10 })
        .filter((r) => r.action === 'assistant_conversation.pruned'),
    ).toEqual([]);
  });

  it('deletes nothing when retention is keep-forever', async () => {
    const scope = t.scopes.forGuild(GUILD_A);
    assistantRepo.setConversationRetention(scope, null, nowMs);
    seedConversation(GUILD_A, 'conv-ancient', NOW - 400 * DAY_MS);

    await conversationPruneHandler(scope, { now: () => nowMs, logger }).run(
      { day: '2026-09-25' },
      { ...context },
    );

    expect(conversationRepo.getConversation(scope, 'conv-ancient')).toBeDefined();
    expect(
      effectRepo
        .tailAudit(scope, { limit: 10 })
        .filter((r) => r.action === 'assistant_conversation.pruned'),
    ).toEqual([]);
  });

  it('prunes with the default 6 months when no retention was ever set', async () => {
    const scope = t.scopes.forGuild(GUILD_A);
    seedConversation(GUILD_A, 'conv-ancient', NOW - 200 * DAY_MS);
    seedConversation(GUILD_A, 'conv-recent', NOW - 100 * DAY_MS);

    await conversationPruneHandler(scope, { now: () => nowMs, logger }).run(
      { day: '2026-09-25' },
      { ...context },
    );

    expect(conversationRepo.getConversation(scope, 'conv-ancient')).toBeUndefined();
    expect(conversationRepo.getConversation(scope, 'conv-recent')).toBeDefined();
  });

  it('never touches another guild', async () => {
    const a = t.scopes.forGuild(GUILD_A);
    const b = t.scopes.forGuild(GUILD_B);
    assistantRepo.setConversationRetention(a, 61, nowMs);
    seedConversation(GUILD_A, 'conv-old', NOW - 62 * DAY_MS);
    seedConversation(GUILD_B, 'conv-old', NOW - 62 * DAY_MS);

    await conversationPruneHandler(a, { now: () => nowMs, logger }).run(
      { day: '2026-09-25' },
      { ...context },
    );

    expect(conversationRepo.getConversation(a, 'conv-old')).toBeUndefined();
    expect(conversationRepo.getConversation(b, 'conv-old')).toBeDefined();
    expect(
      effectRepo
        .tailAudit(b, { limit: 10 })
        .filter((r) => r.action === 'assistant_conversation.pruned'),
    ).toEqual([]);
  });

  it('registers under the conversationPrune kind with a UTC-day dedupe key', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    expect(conversationPruneHandler(scope, { now: () => nowMs, logger }).kind).toBe(
      JOB_KINDS.conversationPrune,
    );
    expect(conversationPruneDedupeKey('2026-09-25')).toBe('conversation_prune:2026-09-25');
  });
});
