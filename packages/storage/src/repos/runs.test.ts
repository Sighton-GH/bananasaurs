import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { upsertGuild } from './guilds.js';
import {
  appendRunEvent,
  deleteRunsForConversations,
  deleteRunsForUser,
  ensureRun,
  getRun,
  listRunEvents,
  listRuns,
  modelResultsSince,
  pruneOrphanRuns,
  failStaleRuns,
  updateRun,
} from './runs.js';

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

const seed = (
  guild: typeof GUILD_A = GUILD_A,
  over: { runId?: string; userId?: string; queuedAt?: number } = {},
) => {
  const scope = t.scopes.forGuild(guild);
  ensureRun(scope, {
    runId: over.runId ?? 'run-1',
    userId: over.userId ?? USER,
    behaviourId: 'club',
    source: 'mention',
    queuedAt: over.queuedAt ?? 1_000,
  });
  return scope;
};

describe('ensureRun', () => {
  it('inserts once in state queued and keeps one row on repeat', () => {
    const scope = seed();
    seed(GUILD_A, {});
    expect(getRun(scope, 'run-1')?.state).toBe('queued');
    const rows = t.raw
      .prepare(`SELECT count(*) AS n FROM assistant_runs WHERE guild_id = ?`)
      .get(GUILD_A) as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe('appendRunEvent', () => {
  it('returns 1, 2, 3 in order and fills the typed columns of a model-result', () => {
    const scope = seed();
    expect(appendRunEvent(scope, 'run-1', 1_001, { kind: 'queued', via: 'mention' })).toBe(1);
    expect(
      appendRunEvent(scope, 'run-1', 1_002, {
        kind: 'model-result',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        keyId: 'key-1',
        ok: false,
        ms: 900,
        promptTokens: 100,
        completionTokens: 20,
        costUsd: 0.001,
        code: 'provider-timeout',
      }),
    ).toBe(2);
    expect(appendRunEvent(scope, 'run-1', 1_003, { kind: 'delivering', parts: 1 })).toBe(3);
    const row = t.raw
      .prepare(
        `SELECT ok, code, ms, tokens, cost_usd AS "costUsd" FROM assistant_run_events ` +
          `WHERE guild_id = ? AND run_id = ? AND seq = 2`,
      )
      .get(GUILD_A, 'run-1') as {
      ok: number;
      code: string;
      ms: number;
      tokens: number;
      costUsd: number;
    };
    expect(row).toMatchObject({ ok: 0, code: 'provider-timeout', ms: 900, tokens: 120 });
    expect(row.costUsd).toBeCloseTo(0.001);
  });

  it('rejects an event carrying an extra field', () => {
    const scope = seed();
    expect(() =>
      appendRunEvent(scope, 'run-1', 1_001, {
        kind: 'queued',
        via: 'mention',
        question: 'hi',
      } as unknown as { kind: 'queued'; via: 'mention' }),
    ).toThrow();
  });
});

describe('listRunEvents', () => {
  it('pages by afterSeq ascending', () => {
    const scope = seed();
    appendRunEvent(scope, 'run-1', 1_001, { kind: 'queued', via: 'mention' });
    appendRunEvent(scope, 'run-1', 1_002, { kind: 'delivering', parts: 1 });
    appendRunEvent(scope, 'run-1', 1_003, {
      kind: 'finished',
      outcome: 'answered',
      durationMs: 1200,
    });
    expect(listRunEvents(scope, 'run-1', 1, 10).map((r) => r.seq)).toEqual([2, 3]);
  });

  it('skips a row whose data_json no longer parses', () => {
    const scope = seed();
    appendRunEvent(scope, 'run-1', 1_001, { kind: 'queued', via: 'mention' });
    appendRunEvent(scope, 'run-1', 1_002, { kind: 'delivering', parts: 1 });
    t.raw
      .prepare(
        `UPDATE assistant_run_events SET data_json = ? WHERE guild_id = ? AND run_id = ? AND seq = 1`,
      )
      .run(JSON.stringify({ kind: 'queued' }), GUILD_A, 'run-1');
    expect(listRunEvents(scope, 'run-1', 0, 10).map((r) => r.seq)).toEqual([2]);
  });
});

describe('updateRun', () => {
  it('changes only the given fields', () => {
    const scope = seed(GUILD_A, { queuedAt: 1_000 });
    updateRun(scope, 'run-1', { state: 'running', stage: 'calling-model', updatedAt: 2_000 });
    expect(getRun(scope, 'run-1')).toMatchObject({
      state: 'running',
      stage: 'calling-model',
      userId: USER,
      behaviourId: 'club',
      queuedAt: 1_000,
      updatedAt: 2_000,
    });
  });
});

describe('listRuns', () => {
  it('active:true excludes answered and failed runs, newest update first', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    seed(GUILD_A, { runId: 'old-active', queuedAt: 1_000 });
    seed(GUILD_A, { runId: 'new-active', queuedAt: 2_000 });
    seed(GUILD_A, { runId: 'done', queuedAt: 3_000 });
    seed(GUILD_A, { runId: 'broken', queuedAt: 4_000 });
    updateRun(scope, 'old-active', { updatedAt: 1_000 });
    updateRun(scope, 'new-active', { updatedAt: 5_000 });
    updateRun(scope, 'done', { state: 'answered', stage: 'done', updatedAt: 6_000 });
    updateRun(scope, 'broken', { state: 'failed', stage: 'done', updatedAt: 7_000 });
    expect(listRuns(scope, { active: true, limit: 10 }).map((r) => r.runId)).toEqual([
      'new-active',
      'old-active',
    ]);
  });
});

describe('runRepo guild scope (ADR 0129 §6)', () => {
  it('keeps guild B runs invisible from guild A', () => {
    seed(GUILD_B, { runId: 'run-b' });
    const scopeA = t.scopes.forGuild(GUILD_A);
    expect(getRun(scopeA, 'run-b')).toBeUndefined();
    expect(listRuns(scopeA, { limit: 10 })).toEqual([]);
    appendRunEvent(t.scopes.forGuild(GUILD_B), 'run-b', 1_001, {
      kind: 'queued',
      via: 'mention',
    });
    expect(listRunEvents(scopeA, 'run-b', 0, 10)).toEqual([]);
  });

  it('rejects a raw insert with a non-snowflake guild id', () => {
    expect(() =>
      t.raw
        .prepare(
          `INSERT INTO assistant_runs (guild_id, run_id, user_id, behaviour_id, source, state, stage, attempt, queued_at, updated_at) ` +
            `VALUES ('abc', 'run-x', ?, 'club', 'mention', 'queued', 'queued', 1, 1, 1)`,
        )
        .run(USER),
    ).toThrow();
  });
});

describe('deleteRunsForConversations', () => {
  it('removes the runs and their events by cascade', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    seed(GUILD_A, { runId: 'run-1' });
    seed(GUILD_A, { runId: 'run-2' });
    updateRun(scope, 'run-1', { conversationId: 'conv-1', updatedAt: 2_000 });
    updateRun(scope, 'run-2', { conversationId: 'conv-2', updatedAt: 2_000 });
    appendRunEvent(scope, 'run-1', 1_001, { kind: 'queued', via: 'mention' });
    appendRunEvent(scope, 'run-2', 1_001, { kind: 'queued', via: 'mention' });
    expect(deleteRunsForConversations(scope, ['conv-1'])).toBe(1);
    expect(getRun(scope, 'run-1')).toBeUndefined();
    expect(getRun(scope, 'run-2')).toBeDefined();
    expect(listRunEvents(scope, 'run-1', 0, 10)).toEqual([]);
    expect(deleteRunsForConversations(scope, [])).toBe(0);
  });
});

describe('failStaleRuns', () => {
  it('fails old active runs only in the scoped guild', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    seed(GUILD_A, { runId: 'old', queuedAt: 1_000 });
    seed(GUILD_A, { runId: 'new', queuedAt: 9_000 });
    seed(GUILD_B, { runId: 'other', queuedAt: 1_000 });
    updateRun(scope, 'old', { state: 'running', stage: 'calling-model', updatedAt: 1_000 });
    updateRun(scope, 'new', { state: 'retry-wait', stage: 'retry-wait', updatedAt: 9_000 });
    expect(failStaleRuns(scope, 5_000, 10_000)).toBe(1);
    expect(getRun(scope, 'old')).toMatchObject({
      state: 'failed',
      stage: 'done',
      errorCode: 'stalled',
      finishedAt: 10_000,
    });
    expect(getRun(scope, 'new')?.state).toBe('retry-wait');
    expect(getRun(t.scopes.forGuild(GUILD_B), 'other')?.state).toBe('queued');
  });
});

describe('pruneOrphanRuns', () => {
  it('deletes only orphan runs older than the cutoff', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    seed(GUILD_A, { runId: 'orphan-old', queuedAt: 1_000 });
    seed(GUILD_A, { runId: 'orphan-new', queuedAt: 9_000 });
    seed(GUILD_A, { runId: 'linked-old', queuedAt: 1_000 });
    updateRun(scope, 'orphan-old', { updatedAt: 1_000 });
    updateRun(scope, 'orphan-new', { updatedAt: 9_000 });
    updateRun(scope, 'linked-old', { conversationId: 'conv-1', updatedAt: 1_000 });
    expect(pruneOrphanRuns(scope, 5_000)).toBe(1);
    expect(getRun(scope, 'orphan-old')).toBeUndefined();
    expect(getRun(scope, 'orphan-new')).toBeDefined();
    expect(getRun(scope, 'linked-old')).toBeDefined();
  });
});

describe('deleteRunsForUser', () => {
  it('deletes only that member’s runs', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    seed(GUILD_A, { runId: 'mine', userId: USER });
    seed(GUILD_A, { runId: 'theirs', userId: OTHER_USER });
    seed(GUILD_B, { runId: 'mine', userId: USER });
    expect(deleteRunsForUser(scope, USER)).toBe(1);
    expect(getRun(scope, 'mine')).toBeUndefined();
    expect(getRun(scope, 'theirs')).toBeDefined();
    expect(getRun(t.scopes.forGuild(GUILD_B), 'mine')).toBeDefined();
  });
});

describe('modelResultsSince (ADR 0129 §8)', () => {
  it('returns only model-result events at or after since, oldest first, with tokens and cost', () => {
    const scope = t.scopes.forGuild(GUILD_A);
    seed(GUILD_A, { runId: 'run-1', queuedAt: 1_000 });
    appendRunEvent(scope, 'run-1', 900, {
      kind: 'model-result',
      provider: 'openrouter',
      model: 'model-a',
      keyId: 'key-1',
      ok: true,
      ms: 100,
      promptTokens: 10,
      completionTokens: 5,
      costUsd: 0.0012,
    });
    appendRunEvent(scope, 'run-1', 1_000, {
      kind: 'model-call',
      position: 0,
      of: 1,
      provider: 'openrouter',
      model: 'model-a',
      keyId: 'key-1',
      round: 1,
    });
    appendRunEvent(scope, 'run-1', 1_001, {
      kind: 'model-result',
      provider: 'openrouter',
      model: 'model-a',
      keyId: 'key-1',
      ok: true,
      ms: 120,
      promptTokens: 10,
      completionTokens: 5,
      costUsd: 0.0012,
    });
    appendRunEvent(scope, 'run-1', 1_002, {
      kind: 'model-result',
      provider: 'openrouter',
      model: 'model-b',
      keyId: 'key-2',
      ok: false,
      ms: 30,
      code: 'provider-auth',
      providerMessage: 'bad key',
    });
    const results = modelResultsSince(scope, 1_000);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      at: 1_001,
      model: 'model-a',
      keyId: 'key-1',
      ok: true,
      ms: 120,
      tokens: 15,
      costUsd: 0.0012,
    });
    expect(results[1]).toMatchObject({
      at: 1_002,
      model: 'model-b',
      keyId: 'key-2',
      ok: false,
      code: 'provider-auth',
      providerMessage: 'bad key',
    });
    expect(results[1]?.tokens).toBeUndefined();
  });

  it('does not return another guild’s rows', () => {
    seed(GUILD_B, { runId: 'run-b', queuedAt: 1_000 });
    appendRunEvent(t.scopes.forGuild(GUILD_B), 'run-b', 2_000, {
      kind: 'model-result',
      provider: 'openrouter',
      model: 'model-a',
      keyId: 'key-1',
      ok: true,
      ms: 100,
    });
    expect(modelResultsSince(t.scopes.forGuild(GUILD_A), 0)).toEqual([]);
  });
});

it('stores a daily-digest run and still refuses an unknown source', () => {
  const scope = t.scopes.forGuild(GUILD_A);
  ensureRun(scope, {
    runId: 'digest-2026-10-09',
    userId: USER,
    behaviourId: 'default',
    source: 'daily-digest',
    queuedAt: 1_790_000_000_000,
  });
  expect(getRun(scope, 'digest-2026-10-09')?.source).toBe('daily-digest');
  expect(() =>
    ensureRun(scope, {
      runId: 'digest-bogus',
      userId: USER,
      behaviourId: 'default',
      source: 'nope' as 'mention',
      queuedAt: 1_790_000_000_000,
    }),
  ).toThrow();
});
