import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOB_KINDS, parseGuildId } from '@bananasaurs/core';
import { conversationRepo, guildRepo, jobRepo } from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import {
  createDailyDigestTimer,
  DAILY_JOB_TICK_MS,
  type DailyDigestTimerDeps,
} from './digest-timer.js';

const scopeFor = (guildId: string) => ({ guildId }) as never;
const logInfo = vi.fn();
const stubLogger = { info: logInfo, warn: vi.fn(), error: vi.fn() } as never;

// 2026-10-09T11:00:00Z is 04:00 in America/Vancouver.
const PAST_FOUR = Date.parse('2026-10-09T11:00:00Z');
const BEFORE_FOUR = Date.parse('2026-10-09T10:00:00Z');

const setup = (nowMs: number, enabled = true, shared: string[] = []) => {
  const keys = shared;
  const enqueue = vi.fn((_scope: unknown, input: { dedupeKey: string }) => {
    if (keys.includes(input.dedupeKey)) return { enqueued: false };
    keys.push(input.dedupeKey);
    return { enqueued: true };
  });
  const timer = createDailyDigestTimer({
    guilds: () => [{ scope: scopeFor('111111111111111111') }],
    enqueue,
    hasConversations: () => true,
    timeZone: () => 'America/Vancouver',
    digestEnabled: () => enabled,
    digestHour: () => 4,
    now: () => nowMs,
    logger: stubLogger,
  });
  return { timer, enqueue, keys };
};

describe('createDailyDigestTimer (ADR 0150 decision 1, restart first)', () => {
  it('enqueues one digest per guild per local day, and a replay enqueues nothing', () => {
    const { timer, enqueue } = setup(PAST_FOUR);
    timer.runOnce();
    timer.runOnce();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.results[0]).toMatchObject({ value: { enqueued: true } });
    expect(enqueue.mock.results[1]).toMatchObject({ value: { enqueued: false } });
  });
  it('a restart after the job finished still enqueues nothing (the storage oncePerBucket guarantee)', () => {
    // A restart rebuilds the timer but the bucket key lives in the job
    // table: model that by sharing one key store across both timers, the way
    // `jobRepo.enqueue` with `oncePerBucket` collapses the second enqueue
    // (covered in `packages/storage/src/repos/jobs.test.ts`).
    const shared: string[] = [];
    setup(PAST_FOUR, true, shared).timer.runOnce();
    const second = setup(PAST_FOUR, true, shared);
    second.timer.runOnce();
    expect(second.enqueue).toHaveBeenCalledTimes(1);
    expect(second.enqueue.mock.results[0]).toMatchObject({ value: { enqueued: false } });
  });
  it('stays quiet before the local hour and when off', () => {
    const early = setup(BEFORE_FOUR);
    early.timer.runOnce();
    expect(early.enqueue).not.toHaveBeenCalled();
    const off = setup(PAST_FOUR, false);
    off.timer.runOnce();
    expect(off.enqueue).not.toHaveBeenCalled();
  });
  it('uses the local day and the digest kind', () => {
    const { timer, enqueue, keys } = setup(PAST_FOUR);
    timer.runOnce();
    expect(keys).toEqual(['assistant_daily_digest:2026-10-09']);
    expect(enqueue.mock.calls[0]?.[1]).toMatchObject({ kind: JOB_KINDS.assistantDailyDigest });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('daily digest timer boundaries', () => {
  const configured = (over: Partial<DailyDigestTimerDeps> = {}) => {
    const enqueue = vi.fn(
      (
        _scope: Parameters<DailyDigestTimerDeps['enqueue']>[0],
        _input: Parameters<DailyDigestTimerDeps['enqueue']>[1],
      ) => ({ enqueued: true }),
    );
    const timer = createDailyDigestTimer({
      guilds: () => [{ scope: scopeFor('111111111111111111') }],
      enqueue,
      hasConversations: () => true,
      timeZone: () => 'America/Vancouver',
      digestEnabled: () => true,
      digestHour: () => 4,
      now: () => PAST_FOUR,
      logger: stubLogger,
      ...over,
    });
    return { timer, enqueue };
  };

  it('passes the payload, timestamp and durable bucket flag to storage', () => {
    const { timer, enqueue } = configured();
    timer.runOnce();
    expect(enqueue).toHaveBeenCalledWith(scopeFor('111111111111111111'), {
      kind: JOB_KINDS.assistantDailyDigest,
      payload: JSON.stringify({ day: '2026-10-09' }),
      dedupeKey: 'assistant_daily_digest:2026-10-09',
      oncePerBucket: true,
      now: PAST_FOUR,
    });
  });

  it('uses the local date when it differs from UTC', () => {
    const { timer, enqueue } = configured({
      now: () => Date.parse('2026-10-10T01:00:00Z'),
    });
    timer.runOnce();
    expect(enqueue.mock.calls[0]?.[1]).toMatchObject({
      payload: JSON.stringify({ day: '2026-10-09' }),
      dedupeKey: 'assistant_daily_digest:2026-10-09',
    });
  });

  it('skips guilds without conversations and keeps each guild scope', () => {
    const { timer, enqueue } = configured({
      guilds: () => [
        { scope: scopeFor('111111111111111111') },
        { scope: scopeFor('222222222222222222') },
      ],
      hasConversations: (scope) => scope.guildId === '222222222222222222',
    });
    timer.runOnce();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toEqual(scopeFor('222222222222222222'));
  });

  it('reads the enable and hour settings live on each tick', () => {
    let enabled = false;
    let hour = 5;
    const { timer, enqueue } = configured({
      digestEnabled: () => enabled,
      digestHour: () => hour,
    });
    timer.runOnce();
    enabled = true;
    timer.runOnce();
    expect(enqueue).not.toHaveBeenCalled();
    hour = 4;
    timer.runOnce();
    expect(enqueue).toHaveBeenCalledTimes(1);
    enabled = false;
    timer.runOnce();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('runs at start, ticks hourly, unrefs and clears on stop', () => {
    vi.useFakeTimers();
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const { timer, enqueue } = configured();
    timer.stop();
    timer.start();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(DAILY_JOB_TICK_MS).toBe(60 * 60 * 1000);
    const handle = intervals.mock.results[0]?.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    vi.advanceTimersByTime(DAILY_JOB_TICK_MS);
    expect(enqueue).toHaveBeenCalledTimes(2);
    timer.stop();
    timer.stop();
    vi.advanceTimersByTime(DAILY_JOB_TICK_MS);
    expect(enqueue).toHaveBeenCalledTimes(2);
    intervals.mockRestore();
  });

  it('logs only successful enqueues, never a duplicate tick', () => {
    const shared: string[] = [];
    const { timer } = setup(PAST_FOUR, true, shared);
    timer.runOnce();
    timer.runOnce();
    expect(logInfo).toHaveBeenCalledTimes(1);
  });
});

describe('daily digest timer with real storage', () => {
  it('keeps guild buckets separate, survives completion and restart, and allows the next day', () => {
    const db = openMigratedTestDatabase();
    try {
      const a = db.scopes.forGuild(parseGuildId('111111111111111111'));
      const b = db.scopes.forGuild(parseGuildId('222222222222222222'));
      const empty = db.scopes.forGuild(parseGuildId('555555555555555555'));
      for (const scope of [a, b, empty]) {
        guildRepo.upsertGuild(scope, { name: 'Car Team A', now: 0 });
      }
      for (const scope of [a, b]) {
        conversationRepo.createConversation(scope, {
          conversationId: `conv-${scope.guildId}`,
          channelId: '333333333333333333',
          behaviourId: 'club',
          startedBy: '444444444444444444',
          title: 'Handbook question',
          source: 'discord',
          at: 0,
        });
      }
      let nowMs = PAST_FOUR;
      const deps: DailyDigestTimerDeps = {
        guilds: () => [a, b, empty].map((scope) => ({ scope })),
        enqueue: (scope, input) => jobRepo.enqueue(scope, input),
        timeZone: () => 'America/Vancouver',
        digestEnabled: () => true,
        digestHour: () => 4,
        now: () => nowMs,
        logger: stubLogger,
      };
      const timer = createDailyDigestTimer(deps);
      timer.runOnce();
      timer.runOnce();
      for (const scope of [a, b]) {
        expect(jobRepo.listJobs(scope, {})).toHaveLength(1);
        const job = jobRepo.claimNext(scope, nowMs);
        expect(job).toBeDefined();
        jobRepo.completeJob(scope, job?.jobId ?? -1, nowMs);
      }
      expect(jobRepo.listJobs(empty, {})).toHaveLength(0);
      createDailyDigestTimer(deps).runOnce();
      for (const scope of [a, b]) expect(jobRepo.listJobs(scope, {})).toHaveLength(1);
      nowMs = Date.parse('2026-10-10T11:00:00Z');
      timer.runOnce();
      for (const scope of [a, b]) {
        const jobs = jobRepo.listJobs(scope, {});
        expect(jobs).toHaveLength(2);
        expect(jobs[0]?.dedupeKey).toBe('assistant_daily_digest:2026-10-10');
      }
    } finally {
      db.close();
    }
  });
});
