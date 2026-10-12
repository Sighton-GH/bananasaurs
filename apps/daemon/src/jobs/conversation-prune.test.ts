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
  digestRepo,
  effectRepo,
  guildRepo,
  runRepo,
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
  for (const failure of ['digest-delete', 'audit-insert'] as const) {
    it(`rolls back retention deletes on ${failure} failure and audits correct counts on retry`, async () => {
      const scope = t.scopes.forGuild(GUILD_A);
      assistantRepo.setConversationRetention(scope, 61, NOW);
      seedConversation(GUILD_A, 'conv-old', NOW - 62 * DAY_MS);
      traceRepo.insertTrace(scope, trace({ traceId: 'old-trace', conversationId: 'conv-old' }));
      runRepo.ensureRun(scope, {
        runId: 'run-old',
        userId: MEMBER,
        behaviourId: 'club',
        source: 'mention',
        queuedAt: NOW,
      });
      runRepo.updateRun(scope, 'run-old', { conversationId: 'conv-old', updatedAt: NOW });
      digestRepo.putDigestOnce(scope, {
        day: '2026-01-01',
        summary: { daySummary: 'Old.', memoryProposals: [] },
        conversations: [],
        now: NOW,
      });
      t.raw.exec(
        failure === 'digest-delete'
          ? `CREATE TRIGGER fail_prune BEFORE DELETE ON assistant_daily_digests
           WHEN OLD.guild_id = '111111111111111111'
           BEGIN SELECT RAISE(ABORT, 'injected digest failure'); END;`
          : `CREATE TRIGGER fail_prune BEFORE INSERT ON audit_events
           WHEN NEW.guild_id = '111111111111111111' AND NEW.action = 'assistant_conversation.pruned'
           BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;`,
      );
      const handler = conversationPruneHandler(scope, { now: () => NOW, logger });
      expect(() => handler.run({ day: '2026-09-25' }, { ...context })).toThrow('injected');
      expect(conversationRepo.getConversation(scope, 'conv-old')).toBeDefined();
      expect(conversationRepo.listTurns(scope, 'conv-old')).toHaveLength(1);
      expect(traceRepo.getTrace(scope, 'old-trace')).toBeDefined();
      expect(runRepo.getRun(scope, 'run-old')).toBeDefined();
      expect(digestRepo.getDigest(scope, '2026-01-01')).toBeDefined();
      expect(
        effectRepo
          .tailAudit(scope, { limit: 10 })
          .filter((r) => r.action === 'assistant_conversation.pruned'),
      ).toEqual([]);
      t.raw.exec('DROP TRIGGER fail_prune');
      await handler.run({ day: '2026-09-25' }, { ...context });
      expect(conversationRepo.getConversation(scope, 'conv-old')).toBeUndefined();
      expect(traceRepo.getTrace(scope, 'old-trace')).toBeUndefined();
      expect(runRepo.getRun(scope, 'run-old')).toBeUndefined();
      expect(digestRepo.getDigest(scope, '2026-01-01')).toBeUndefined();
      const pruned = effectRepo
        .tailAudit(scope, { limit: 10 })
        .filter((r) => r.action === 'assistant_conversation.pruned');
      expect(pruned).toHaveLength(1);
      expect(pruned[0]?.after).toBe(JSON.stringify({ count: 1, digests: 1 }));
    });
  }

  it('rolls back digest-only deletion when the audit fails and audits its retry', async () => {
    const scope = t.scopes.forGuild(GUILD_A);
    assistantRepo.setConversationRetention(scope, 61, NOW);
    digestRepo.putDigestOnce(scope, {
      day: '2026-01-01',
      summary: { daySummary: 'Old.', memoryProposals: [] },
      conversations: [],
      now: NOW,
    });
    t.raw.exec(`CREATE TRIGGER fail_prune BEFORE INSERT ON audit_events
      WHEN NEW.guild_id = '111111111111111111' AND NEW.action = 'assistant_conversation.pruned'
      BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;`);
    const handler = conversationPruneHandler(scope, { now: () => NOW, logger });
    expect(() => handler.run({ day: '2026-09-25' }, { ...context })).toThrow('injected');
    expect(digestRepo.getDigest(scope, '2026-01-01')).toBeDefined();
    t.raw.exec('DROP TRIGGER fail_prune');
    await handler.run({ day: '2026-09-25' }, { ...context });
    expect(digestRepo.getDigest(scope, '2026-01-01')).toBeUndefined();
    const pruned = effectRepo
      .tailAudit(scope, { limit: 10 })
      .filter((r) => r.action === 'assistant_conversation.pruned');
    expect(pruned).toHaveLength(1);
    expect(pruned[0]?.after).toBe(JSON.stringify({ count: 0, digests: 1 }));
  });

  it('deletes an old digest in a guild with no conversations at all', async () => {
    const s = t.scopes.forGuild(GUILD_A);
    assistantRepo.setConversationRetention(s, 61, NOW);
    digestRepo.putDigestOnce(s, {
      day: '2026-01-01',
      summary: { daySummary: 'Old.', memoryProposals: [] },
      conversations: [],
      now: NOW,
    });
    await conversationPruneHandler(s, { now: () => NOW, logger }).run(
      { day: '2026-09-25' },
      { ...context },
    );
    expect(digestRepo.getDigest(s, '2026-01-01')).toBeUndefined();
    const pruned = effectRepo
      .tailAudit(s, { limit: 10 })
      .filter((r) => r.action === 'assistant_conversation.pruned');
    expect(pruned).toHaveLength(1);
    expect(pruned[0]?.after).toBe(JSON.stringify({ count: 0, digests: 1 }));
  });

  it('computes the digest cutoff in the club time zone, not UTC', async () => {
    const s = t.scopes.forGuild(GUILD_A);
    assistantRepo.setConversationRetention(s, 61, NOW);
    // 03:00 UTC is still the previous evening in Vancouver: now - 61 days is
    // 2026-08-12 in UTC but 2026-08-11 locally, so the 2026-08-11 digest is
    // exactly at the local edge and stays.
    const lateEvening = Date.parse('2026-10-12T03:00:00.000Z');
    digestRepo.putDigestOnce(s, {
      day: '2026-08-11',
      summary: { daySummary: 'Edge.', memoryProposals: [] },
      conversations: [],
      now: lateEvening,
    });
    await conversationPruneHandler(s, {
      now: () => lateEvening,
      logger,
      timeZone: () => 'America/Vancouver',
    }).run({ day: '2026-10-12' }, { ...context });
    expect(digestRepo.getDigest(s, '2026-08-11')).toBeDefined();
  });

  it('prunes digest rows older than the retention window with the conversations', async () => {
    const s = t.scopes.forGuild(GUILD_A);
    assistantRepo.setConversationRetention(s, 61, 100);
    seedConversation(GUILD_A, 'conv-old', NOW - 62 * DAY_MS);
    digestRepo.putDigestOnce(s, {
      day: '2026-01-01',
      summary: { daySummary: 'Old.', memoryProposals: [] },
      conversations: [],
      now: 100,
    });
    digestRepo.putDigestOnce(s, {
      day: '2026-09-25',
      summary: { daySummary: 'New.', memoryProposals: [] },
      conversations: [],
      now: NOW,
    });
    await conversationPruneHandler(s, { now: () => NOW, logger }).run(
      { day: '2026-09-25' },
      { ...context },
    );
    expect(digestRepo.listDigests(s, 10).map((d) => d.day)).toEqual(['2026-09-25']);
    const pruned = effectRepo
      .tailAudit(s, { limit: 10 })
      .filter((r) => r.action === 'assistant_conversation.pruned');
    expect(pruned).toHaveLength(1);
    expect(pruned[0]?.after).toBe(JSON.stringify({ count: 1, digests: 1 }));
  });

  it('audits digest-only pruning and keeps the UTC cutoff day and other guilds', async () => {
    const s = t.scopes.forGuild(GUILD_A);
    const other = t.scopes.forGuild(GUILD_B);
    assistantRepo.setConversationRetention(s, 61, NOW);
    const cutoff = new Date(NOW - 61 * DAY_MS).toISOString().slice(0, 10);
    for (const scope of [s, other]) {
      for (const day of ['2026-01-01', cutoff]) {
        digestRepo.putDigestOnce(scope, {
          day,
          summary: { daySummary: 'Summary.', memoryProposals: [] },
          conversations: [],
          now: NOW,
        });
      }
    }
    await conversationPruneHandler(s, { now: () => NOW, logger }).run(
      { day: '2026-09-25' },
      { ...context },
    );
    expect(digestRepo.listDigests(s, 10).map((d) => d.day)).toEqual([cutoff]);
    expect(digestRepo.listDigests(other, 10).map((d) => d.day)).toEqual([cutoff, '2026-01-01']);
    const pruned = effectRepo
      .tailAudit(s, { limit: 10 })
      .filter((r) => r.action === 'assistant_conversation.pruned');
    expect(pruned).toHaveLength(1);
    expect(pruned[0]?.after).toBe(JSON.stringify({ count: 0, digests: 1 }));
    expect(
      effectRepo
        .tailAudit(other, { limit: 10 })
        .filter((r) => r.action === 'assistant_conversation.pruned'),
    ).toEqual([]);
    await conversationPruneHandler(s, { now: () => NOW, logger }).run(
      { day: '2026-09-25' },
      { ...context },
    );
    expect(
      effectRepo
        .tailAudit(s, { limit: 10 })
        .filter((r) => r.action === 'assistant_conversation.pruned'),
    ).toHaveLength(1);
  });

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
    expect(pruned[0]?.after).toBe(JSON.stringify({ count: 2, digests: 0 }));
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
    digestRepo.putDigestOnce(scope, {
      day: '2025-01-01',
      summary: { daySummary: 'Ancient.', memoryProposals: [] },
      conversations: [],
      now: 100,
    });

    await conversationPruneHandler(scope, { now: () => nowMs, logger }).run(
      { day: '2026-09-25' },
      { ...context },
    );

    expect(conversationRepo.getConversation(scope, 'conv-ancient')).toBeDefined();
    expect(digestRepo.listDigests(scope, 10).map((d) => d.day)).toEqual(['2025-01-01']);
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

  it('ADR 0129 §6: deletes runs of pruned conversations', async () => {
    const scope = t.scopes.forGuild(GUILD_A);
    assistantRepo.setConversationRetention(scope, 61, nowMs);
    seedConversation(GUILD_A, 'conv-old', NOW - 62 * DAY_MS);
    seedConversation(GUILD_A, 'conv-new', NOW - 10 * DAY_MS);
    runRepo.ensureRun(scope, {
      runId: 'run-old',
      userId: MEMBER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: NOW - 62 * DAY_MS,
    });
    runRepo.updateRun(scope, 'run-old', {
      conversationId: 'conv-old',
      updatedAt: NOW - 62 * DAY_MS,
    });
    runRepo.ensureRun(scope, {
      runId: 'run-new',
      userId: MEMBER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: NOW - 10 * DAY_MS,
    });
    runRepo.updateRun(scope, 'run-new', {
      conversationId: 'conv-new',
      updatedAt: NOW - 10 * DAY_MS,
    });

    await conversationPruneHandler(scope, { now: () => nowMs, logger }).run(
      { day: '2026-09-25' },
      { ...context },
    );

    expect(runRepo.getRun(scope, 'run-old')).toBeUndefined();
    expect(runRepo.getRun(scope, 'run-new')).toBeDefined();
  });

  it('ADR 0129 §6: deletes old orphans even when retention is keep-forever', async () => {
    const scope = t.scopes.forGuild(GUILD_A);
    assistantRepo.setConversationRetention(scope, null, nowMs);
    runRepo.ensureRun(scope, {
      runId: 'orphan-old',
      userId: MEMBER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: NOW - 31 * DAY_MS,
    });
    runRepo.updateRun(scope, 'orphan-old', { updatedAt: NOW - 31 * DAY_MS });
    traceRepo.insertTrace(
      scope,
      trace({ traceId: 'orphan-trace-old', at: NOW - 31 * DAY_MS, conversationId: undefined }),
    );

    runRepo.ensureRun(scope, {
      runId: 'orphan-new',
      userId: MEMBER,
      behaviourId: 'club',
      source: 'mention',
      queuedAt: NOW,
    });
    runRepo.updateRun(scope, 'orphan-new', { updatedAt: NOW });

    await conversationPruneHandler(scope, { now: () => nowMs, logger }).run(
      { day: '2026-09-25' },
      { ...context },
    );

    expect(runRepo.getRun(scope, 'orphan-old')).toMatchObject({
      state: 'failed',
      stage: 'done',
      errorCode: 'stalled',
      finishedAt: NOW,
    });
    expect(runRepo.getRun(scope, 'orphan-new')).toBeDefined();
    expect(traceRepo.getTrace(scope, 'orphan-trace-old')).toBeUndefined();
  });
});
