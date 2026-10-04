import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import {
  EVENT_DEDUPE_RETENTION_MS,
  JOB_KINDS,
  JOB_RETENTION_MS,
  parseGuildId,
  pruneJobsDedupeKey,
  sweepDedupeKey,
  type Logger,
} from '@bananasaurs/core';
import { guildRepo, jobRepo, type GuildScope } from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import {
  createHousekeepingTimer,
  DAILY_JOB_TICK_MS,
  type HousekeepingTimerDeps,
} from './housekeeping-timer.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let a: GuildScope;
let b: GuildScope;
let nowMs: number;

const captured: { guildId: string; input: jobRepo.EnqueueInput; enqueued: boolean }[] = [];

const depsFor = (over: Partial<HousekeepingTimerDeps> = {}): HousekeepingTimerDeps => ({
  guilds: () => [{ scope: a }, { scope: b }],
  enqueue: (scope, input) => {
    const result = jobRepo.enqueue(scope, input);
    captured.push({ guildId: scope.guildId, input, enqueued: result.enqueued });
    return result;
  },
  now: () => nowMs,
  logger,
  ...over,
});

const jobsFor = (scope: GuildScope) => jobRepo.listJobs(scope, {});
const kindsFor = (scope: GuildScope) =>
  jobsFor(scope)
    .map((job) => job.kind)
    .sort();

const completeAll = (scope: GuildScope): void => {
  for (;;) {
    const claimed = jobRepo.claimNext(scope, nowMs);
    if (claimed === undefined) return;
    jobRepo.completeJob(scope, claimed.jobId, nowMs);
  }
};

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  guildRepo.upsertGuild(a, { name: 'guild-a', now: 0 });
  guildRepo.upsertGuild(b, { name: 'guild-b', now: 0 });
  nowMs = Date.parse('2026-10-04T12:00:00.000Z');
  captured.length = 0;
});
afterEach(() => {
  t.close();
  vi.useRealTimers();
});

describe('housekeeping timer (ADR 0127)', () => {
  it('runOnce enqueues one prune_jobs and one sweep_event_dedupe per guild', () => {
    createHousekeepingTimer(depsFor()).runOnce();

    for (const scope of [a, b]) {
      expect(kindsFor(scope)).toEqual([JOB_KINDS.pruneJobs, JOB_KINDS.sweepEventDedupe]);
    }

    const prune = captured.find((c) => c.input.kind === JOB_KINDS.pruneJobs);
    expect(prune?.input.dedupeKey).toBe(pruneJobsDedupeKey('2026-10-04'));
    expect(JSON.parse(prune?.input.payload ?? '{}')).toEqual({
      olderThanMs: nowMs - JOB_RETENTION_MS,
    });
    expect(prune?.input.oncePerBucket).toBe(true);

    const sweep = captured.find((c) => c.input.kind === JOB_KINDS.sweepEventDedupe);
    expect(sweep?.input.dedupeKey).toBe(sweepDedupeKey('2026-10-04'));
    expect(JSON.parse(sweep?.input.payload ?? '{}')).toEqual({
      olderThanMs: nowMs - EVENT_DEDUPE_RETENTION_MS,
    });
    expect(sweep?.input.oncePerBucket).toBe(true);

    expect(JOB_RETENTION_MS).toBe(14 * 24 * 60 * 60 * 1000);
    expect(EVENT_DEDUPE_RETENTION_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('a guild with no archive channels, resources or conversations still gets both', () => {
    // Nothing seeded at all: no peek may skip a guild.
    createHousekeepingTimer(depsFor()).runOnce();

    expect(kindsFor(a)).toEqual([JOB_KINDS.pruneJobs, JOB_KINDS.sweepEventDedupe]);
    expect(kindsFor(b)).toEqual([JOB_KINDS.pruneJobs, JOB_KINDS.sweepEventDedupe]);
  });

  it('a second runOnce the same day enqueues nothing after both jobs completed', () => {
    const timer = createHousekeepingTimer(depsFor());
    timer.runOnce();
    completeAll(a);
    completeAll(b);
    captured.length = 0;

    timer.runOnce();

    expect(captured.every((c) => c.enqueued === false)).toBe(true);
    expect(jobsFor(a)).toHaveLength(2);
  });

  it('a restart the same day enqueues nothing after both jobs completed', () => {
    createHousekeepingTimer(depsFor()).runOnce();
    completeAll(a);
    completeAll(b);
    captured.length = 0;

    createHousekeepingTimer(depsFor()).runOnce();

    expect(captured.every((c) => c.enqueued === false)).toBe(true);
    expect(jobsFor(a)).toHaveLength(2);
  });

  it('the next UTC day enqueues both again', () => {
    const timer = createHousekeepingTimer(depsFor());
    timer.runOnce();
    completeAll(a);

    nowMs = Date.parse('2026-10-05T01:00:00.000Z');
    timer.runOnce();

    expect(jobsFor(a)).toHaveLength(4);
    // `listJobs` is newest-first: the next day's pair sorts first.
    expect(kindsFor(a)).toEqual([
      JOB_KINDS.pruneJobs,
      JOB_KINDS.pruneJobs,
      JOB_KINDS.sweepEventDedupe,
      JOB_KINDS.sweepEventDedupe,
    ]);
    const days = jobsFor(a)
      .map((job) => job.dedupeKey)
      .sort();
    expect(days).toEqual(
      [
        pruneJobsDedupeKey('2026-10-04'),
        pruneJobsDedupeKey('2026-10-05'),
        sweepDedupeKey('2026-10-04'),
        sweepDedupeKey('2026-10-05'),
      ].sort(),
    );
  });

  it('ticks hourly', () => {
    expect(DAILY_JOB_TICK_MS).toBe(60 * 60 * 1000);
  });

  it('ticks hourly: quiet on the same UTC day, next day enqueued within an hour of midnight', () => {
    vi.useFakeTimers();
    const infos: string[] = [];
    const capture = {
      info(_fields: unknown, msg: string) {
        infos.push(msg);
      },
      warn() {},
      error() {},
      debug() {},
      fatal() {},
      trace() {},
    } as unknown as Logger;
    const timer = createHousekeepingTimer(depsFor({ logger: capture }));

    timer.start();
    expect(jobsFor(a)).toHaveLength(2); // the day's prune + sweep
    expect(infos).toEqual(['housekeeping: enqueued for the day']);

    // One hourly tick, same UTC day: nothing new, no new "enqueued" line.
    vi.advanceTimersByTime(DAILY_JOB_TICK_MS);
    expect(jobsFor(a)).toHaveLength(2);
    expect(infos).toHaveLength(1);

    // Across 00:00 UTC the first tick after midnight enqueues the next day —
    // within one hour, not twenty-four.
    nowMs = Date.parse('2026-10-05T00:30:00.000Z');
    vi.advanceTimersByTime(DAILY_JOB_TICK_MS);
    expect(jobsFor(a)).toHaveLength(4);
    expect(infos).toEqual([
      'housekeeping: enqueued for the day',
      'housekeeping: enqueued for the day',
    ]);

    timer.stop();
  });
});
