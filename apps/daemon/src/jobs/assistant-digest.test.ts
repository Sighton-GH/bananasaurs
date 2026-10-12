import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { parseGuildId } from '@bananasaurs/core';
import {
  assistantRepo,
  conversationRepo,
  digestRepo,
  guildRepo,
  runRepo,
} from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import {
  assistantDailyDigestHandler,
  pickBackgroundEntry,
  type DigestDeps,
} from './assistant-digest.js';

const GUILD_ID = parseGuildId('111111111111111111');
const BOT = '999999999999999999';
const NOW = 1_790_000_000_000;
const CTX = { jobId: 1, attempts: 1, cursor: null, saveCursor: () => {} } as const;

let t: MigratedTestDatabase;
beforeEach(() => {
  t = openMigratedTestDatabase();
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_ID), { name: 'guild', now: 1 });
});
afterEach(() => t.close());

const scope = () => t.scopes.forGuild(GUILD_ID);

const deps = (over: Partial<DigestDeps> = {}): DigestDeps => ({
  now: () => NOW,
  logger: pino({ level: 'silent' }),
  timeZone: () => 'America/Vancouver',
  botUserId: BOT,
  forcedTier: () => 'light',
  digestModel: async () => ({
    ok: true as const,
    text: '{"daySummary": "Talked about the build night.", "memoryProposals": []}',
  }),
  digestEnabled: () => true,
  digestInputChars: () => 40_000,
  digestMaxProposals: () => 10,
  ...over,
});

const seedDay = () => {
  const s = scope();
  conversationRepo.createConversation(s, {
    conversationId: 'conv-1',
    channelId: '333333333333333333',
    behaviourId: 'club',
    startedBy: '100000000000000001',
    title: 'Build night',
    source: 'discord',
    at: Date.parse('2026-10-09T19:00:00Z'),
  });
  conversationRepo.appendTurn(s, {
    conversationId: 'conv-1',
    turnId: 't1',
    at: Date.parse('2026-10-09T19:01:00Z'),
    role: 'user',
    authorId: '100000000000000001',
    authorName: 'Sam L',
    text: 'When is build night?',
  });
  conversationRepo.appendTurn(s, {
    conversationId: 'conv-1',
    turnId: 't2',
    at: Date.parse('2026-10-09T19:02:00Z'),
    role: 'assistant',
    authorName: 'Bananasaurs',
    text: 'Second Friday.',
  });
};

describe('assistantDailyDigestHandler (ADR 0150)', () => {
  it('replay first: a second run for the same day writes nothing new', async () => {
    seedDay();
    const s = scope();
    const model = vi.fn(async () => ({
      ok: true as const,
      text: '{"daySummary": "Talked about the build night.", "memoryProposals": []}',
    }));
    const handler = assistantDailyDigestHandler(s, deps({ digestModel: model }));
    await handler.run({ day: '2026-10-09' }, { ...CTX });
    await handler.run({ day: '2026-10-09' }, { ...CTX });
    expect(model).toHaveBeenCalledTimes(1);
    expect(digestRepo.listDigests(s, 10)).toHaveLength(1);
    expect(
      runRepo.listRuns(s, { limit: 10 }).filter((r) => r.runId === 'digest-2026-10-09'),
    ).toHaveLength(1);
  });
  it('records the forced tier as a background-tier routed event, never routeRun', async () => {
    seedDay();
    const s = scope();
    await assistantDailyDigestHandler(s, deps()).run({ day: '2026-10-09' }, { ...CTX });
    expect(runRepo.listRunEvents(s, 'digest-2026-10-09', 0, 10).map((r) => r.event)).toContainEqual(
      { kind: 'routed', tier: 'light', reason: 'background-tier' },
    );
  });
  it('writes an empty digest with no model call when the day has no turns', async () => {
    const model = vi.fn(async () => ({ ok: true as const, text: '{}' }));
    const s = scope();
    await assistantDailyDigestHandler(s, deps({ digestModel: model })).run(
      { day: '2026-10-09' },
      { ...CTX },
    );
    expect(model).not.toHaveBeenCalled();
    expect(digestRepo.getDigest(s, '2026-10-09')?.summary.daySummary).toContain(
      'No assistant conversations',
    );
  });
  it('files proposals as drafts and drops duplicates of memory and pending drafts', async () => {
    seedDay();
    const s = scope();
    assistantRepo.putMemory(
      s,
      { id: 'kept', section: 'Club', content: 'Build night is the second Friday' },
      50,
    );
    assistantRepo.insertDecisionDraftOnce(s, {
      id: 'digest:2026-10-08:0',
      kind: 'memory',
      summary: 'Existing draft',
      requesterId: BOT,
      provenance: 'daily-digest',
      at: 60,
    });
    const text = JSON.stringify({
      daySummary: 'Build night plans.',
      memoryProposals: [
        {
          text: 'Build night is the second Friday!',
          why: 'Members keep asking.',
          sourceConversationIds: ['conv-1'],
        },
        {
          text: 'The laser cutter needs a new lens.',
          why: 'Alex P reported it.',
          sourceConversationIds: ['conv-1'],
        },
      ],
    });
    await assistantDailyDigestHandler(
      s,
      deps({ digestModel: async () => ({ ok: true as const, text }) }),
    ).run({ day: '2026-10-09' }, { ...CTX });
    const drafts = assistantRepo
      .listDecisions(s)
      .filter((d) => d.kind === 'memory' && d.provenance === 'daily-digest');
    expect(drafts.map((d) => d.status)).toEqual(['draft', 'draft']);
    expect(drafts.some((d) => d.summary.includes('laser cutter'))).toBe(true);
    expect(drafts.some((d) => d.summary.includes('second Friday'))).toBe(false);
    expect(assistantRepo.listMemories(s)).toHaveLength(1);
  });
  it('an invalid model reply stores nothing, fails the run, and does not throw', async () => {
    seedDay();
    const s = scope();
    const handler = assistantDailyDigestHandler(
      s,
      deps({ digestModel: async () => ({ ok: true as const, text: 'not json' }) }),
    );
    await expect(handler.run({ day: '2026-10-09' }, { ...CTX })).resolves.toBeUndefined();
    expect(digestRepo.getDigest(s, '2026-10-09')).toBeUndefined();
    expect(assistantRepo.listDecisions(s)).toEqual([]);
    expect(runRepo.getRun(s, 'digest-2026-10-09')?.state).toBe('failed');
  });
  it('does nothing when the digest is off', async () => {
    seedDay();
    const model = vi.fn(async () => ({ ok: true as const, text: '{}' }));
    const s = scope();
    await assistantDailyDigestHandler(
      s,
      deps({ digestEnabled: () => false, digestModel: model }),
    ).run({ day: '2026-10-09' }, { ...CTX });
    expect(model).not.toHaveBeenCalled();
    expect(digestRepo.getDigest(s, '2026-10-09')).toBeUndefined();
  });
});

describe('pickBackgroundEntry (ADR 0150 decision 2)', () => {
  const fakeProvider = () => ({
    id: 'fake',
    capabilities: new Set(['text', 'tools']),
    generateText: vi.fn(async () => ({ text: 'hi', model: 'm' })),
  });
  const entry = (tier: 'light' | 'standard', keyId: string, skip?: 'disabled') => ({
    providerId: 'gemini' as const,
    model: 'm',
    keyId,
    keyLabel: keyId,
    provider: fakeProvider() as never,
    ...(skip === undefined ? { skip: undefined } : { skip }),
    mayTrain: false,
    rpmLimit: null,
    rpdLimit: null,
    pool: 'key' as const,
    tier,
    selectedKeyId: keyId,
  });
  it('tries the forced tier first regardless of chain order', () => {
    const light = entry('light', 'key_light');
    const standard = entry('standard', 'key_standard');
    expect(pickBackgroundEntry([light, standard], 'standard')).toBe(standard);
    expect(pickBackgroundEntry([light, standard], 'light')).toBe(light);
    expect(pickBackgroundEntry([standard, light], 'standard')).toBe(standard);
  });
  it('skips entries with no provider and skipped entries', () => {
    const dead = { ...entry('standard', 'key_dead'), provider: undefined };
    const cooled = entry('standard', 'key_cool', 'disabled');
    const light = entry('light', 'key_light');
    expect(pickBackgroundEntry([dead, cooled, light], 'standard')).toBe(light);
    expect(pickBackgroundEntry([dead, cooled], 'standard')).toBeUndefined();
  });
});
