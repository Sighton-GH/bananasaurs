import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import type { AssistantTrace } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { upsertGuild } from './guilds.js';
import {
  addTraceFlag,
  dailyUsage,
  deleteTracesForConversations,
  getTrace,
  insertTrace,
  listTraces,
} from './traces.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const USER = '100000000000000001';
const OTHER_USER = '100000000000000002';

let t: MigratedTestDatabase;

beforeEach(() => {
  t = openMigratedTestDatabase();
  upsertGuild(t.scopes.forGuild(GUILD_A), { name: 'guild a', now: 0 });
  upsertGuild(t.scopes.forGuild(GUILD_B), { name: 'guild b', now: 0 });
});
afterEach(() => {
  t.close();
});

/** Stored-data fixture: fixed ids and timestamps, no narrative. */
const trace = (over: Partial<AssistantTrace> = {}): AssistantTrace => ({
  traceId: 'trace-1',
  at: 1_790_000_000_000,
  userId: USER,
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

describe('traceRepo guild scope', () => {
  it('keeps a trace in guild A invisible from guild B', () => {
    insertTrace(t.scopes.forGuild(GUILD_A), trace());
    expect(listTraces(t.scopes.forGuild(GUILD_B), { limit: 50 })).toEqual([]);
    expect(getTrace(t.scopes.forGuild(GUILD_B), 'trace-1')).toBeUndefined();
    expect(getTrace(t.scopes.forGuild(GUILD_A), 'trace-1')?.traceId).toBe('trace-1');
  });
});

describe('listTraces', () => {
  it('orders newest first and pages with before', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    insertTrace(scope, trace({ traceId: 'old', at: 1_000 }));
    insertTrace(scope, trace({ traceId: 'mid', at: 2_000 }));
    insertTrace(scope, trace({ traceId: 'new', at: 3_000 }));
    const page = listTraces(scope, { limit: 2 });
    expect(page.map((r) => r.traceId)).toEqual(['new', 'mid']);
    const older = listTraces(scope, { limit: 2, before: 2_000 });
    expect(older.map((r) => r.traceId)).toEqual(['old']);
  });

  it('filters by outcome, behaviour and member', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    insertTrace(scope, trace({ traceId: 'a', behaviourId: 'club', outcome: 'answered' }));
    insertTrace(
      scope,
      trace({ traceId: 'b', behaviourId: 'help', outcome: 'failed', userId: OTHER_USER }),
    );
    expect(listTraces(scope, { limit: 50, outcome: 'failed' }).map((r) => r.traceId)).toEqual([
      'b',
    ]);
    expect(listTraces(scope, { limit: 50, behaviourId: 'help' }).map((r) => r.traceId)).toEqual([
      'b',
    ]);
    expect(listTraces(scope, { limit: 50, userId: OTHER_USER }).map((r) => r.traceId)).toEqual([
      'b',
    ]);
  });

  it('summarises the answering model and the token total', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    insertTrace(
      scope,
      trace({
        attempts: [
          { provider: 'gemini', model: 'first', outcome: 'busy', ms: 10 },
          { provider: 'openrouter', model: 'second', outcome: 'ok', ms: 20 },
        ],
      }),
    );
    const [row] = listTraces(scope, { limit: 50 });
    expect(row?.model).toBe('second');
    expect(row?.totalTokens).toBe(130);
  });

  it('leaves the token total null when no usage was recorded', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    insertTrace(scope, trace({ usage: {} }));
    expect(listTraces(scope, { limit: 50 })[0]?.totalTokens).toBeNull();
  });
});

describe('getTrace', () => {
  it('returns undefined for a row whose body fails the schema', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    insertTrace(scope, trace());
    t.raw
      .prepare(`UPDATE assistant_traces SET body_json = ? WHERE guild_id = ? AND trace_id = ?`)
      .run(JSON.stringify({ traceId: 'trace-1' }), GUILD_A, 'trace-1');
    expect(getTrace(scope, 'trace-1')).toBeUndefined();
  });

  it('returns undefined for a row whose body is not JSON at all', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    insertTrace(scope, trace());
    t.raw
      .prepare(`UPDATE assistant_traces SET body_json = ? WHERE guild_id = ? AND trace_id = ?`)
      .run('not json', GUILD_A, 'trace-1');
    expect(getTrace(scope, 'trace-1')).toBeUndefined();
  });
});

describe('insertTrace', () => {
  it('caps an oversize trace at write time', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    const big = 'x'.repeat(1_000_000);
    insertTrace(
      scope,
      trace({ sections: [{ name: 'system', chars: big.length, estTokens: 250_000, text: big }] }),
    );
    const stored = getTrace(scope, 'trace-1');
    expect(stored).toBeDefined();
    expect(new TextEncoder().encode(JSON.stringify(stored)).length).toBeLessThanOrEqual(200_000);
    expect(stored?.sections[0]?.text.endsWith('… [truncated]')).toBe(true);
  });
});

describe('deleteTracesForConversations', () => {
  it('removes only the named conversations in the scoped guild', () => {
    const scopeA = t.scopes.forGuild(GUILD_A);
    insertTrace(scopeA, trace({ traceId: 'a1', conversationId: 'conv-1' }));
    insertTrace(scopeA, trace({ traceId: 'a2', conversationId: 'conv-2' }));
    insertTrace(scopeA, trace({ traceId: 'a3', conversationId: undefined }));
    insertTrace(t.scopes.forGuild(GUILD_B), trace({ traceId: 'b1', conversationId: 'conv-1' }));
    expect(deleteTracesForConversations(scopeA, ['conv-1'])).toBe(1);
    expect(
      listTraces(scopeA, { limit: 50 })
        .map((r) => r.traceId)
        .sort(),
    ).toEqual(['a2', 'a3']);
    expect(getTrace(t.scopes.forGuild(GUILD_B), 'b1')).toBeDefined();
    expect(deleteTracesForConversations(scopeA, [])).toBe(0);
  });
});

describe('addTraceFlag', () => {
  it('appends a flag once and reports a missing trace', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    expect(addTraceFlag(scope, 'trace-1', 'feedback:up')).toBe(false);
    insertTrace(scope, trace());
    expect(addTraceFlag(scope, 'trace-1', 'feedback:up')).toBe(true);
    expect(addTraceFlag(scope, 'trace-1', 'feedback:up')).toBe(true);
    expect(getTrace(scope, 'trace-1')?.flags).toEqual(['feedback:up']);
  });
});

describe('dailyUsage', () => {
  it('aggregates answers, failures, fallbacks and tokens per UTC day', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    // 2026-09-20T00:00:00Z and 2026-09-21T00:00:00Z.
    const dayOne = Date.UTC(2026, 8, 20);
    const dayTwo = Date.UTC(2026, 8, 21);
    insertTrace(
      scope,
      trace({
        traceId: 'u1',
        at: dayOne + 1_000,
        outcome: 'answered',
        attempts: [
          { provider: 'gemini', model: 'first', outcome: 'busy', ms: 5 },
          { provider: 'openrouter', model: 'second', outcome: 'ok', ms: 5 },
        ],
      }),
    );
    insertTrace(scope, trace({ traceId: 'u2', at: dayOne + 2_000, outcome: 'failed' }));
    insertTrace(scope, trace({ traceId: 'u3', at: dayTwo + 1_000, outcome: 'refused' }));
    expect(dailyUsage(scope, dayOne)).toEqual([
      { day: '2026-09-20', answers: 1, failures: 1, fallbacks: 1, tokens: 260 },
      { day: '2026-09-21', answers: 0, failures: 0, fallbacks: 0, tokens: 130 },
    ]);
    // A fallback that never recovered is not counted as one.
    insertTrace(
      scope,
      trace({
        traceId: 'u4',
        at: dayTwo + 2_000,
        outcome: 'failed',
        attempts: [
          { provider: 'gemini', model: 'first', outcome: 'busy', ms: 5 },
          { provider: 'openrouter', model: 'second', outcome: 'error', reason: 'down', ms: 5 },
        ],
      }),
    );
    expect(dailyUsage(scope, dayOne)[1]).toEqual({
      day: '2026-09-21',
      answers: 0,
      failures: 1,
      fallbacks: 0,
      tokens: 260,
    });
  });
});
