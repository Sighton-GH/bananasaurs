import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { JOB_KINDS, parseGuildId, resourceRefreshDedupeKey } from '@bananasaurs/core';
import { assistantRepo, guildRepo, jobRepo, type GuildScope } from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import {
  createResourceRefreshTimer,
  RESOURCE_REFRESH_INTERVAL_MS,
  type ResourceRefreshTimerDeps,
} from './resource-refresh-timer.js';

/**
 * The hourly resource-cache refresh timer (ADR 0073): asserted through the
 * real `jobRepo` on a test database, mirroring `archive-expiry-timer.test.ts`
 * — two `runOnce` calls inside the same hour enqueue one job per guild (the
 * `jobs_dedupe` partial unique index refuses the second), and the next hour
 * enqueues again.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let a: GuildScope;
let b: GuildScope;
let nowMs: number;

const depsFor = (over: Partial<ResourceRefreshTimerDeps> = {}): ResourceRefreshTimerDeps => ({
  guilds: () => [{ scope: a }, { scope: b }],
  enqueue: (scope, input) => jobRepo.enqueue(scope, input),
  now: () => nowMs,
  logger,
  ...over,
});

const jobsFor = (scope: GuildScope) => jobRepo.listJobs(scope, {});

const seedResource = (scope: GuildScope): void =>
  assistantRepo.putResource(scope, {
    id: 'res-1',
    guildId: scope.guildId,
    title: 'A resource',
    url: 'https://example.com/guide',
    kind: 'website',
    enabled: true,
    reviewedAt: new Date(0).toISOString(),
  });

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  guildRepo.upsertGuild(a, { name: 'guild-a', now: 0 });
  guildRepo.upsertGuild(b, { name: 'guild-b', now: 0 });
  nowMs = Date.parse('2026-09-13T12:00:00.000Z');
});

afterEach(() => {
  t.close();
  vi.useRealTimers();
});

describe('resource refresh timer', () => {
  it('runOnce enqueues one resource_refresh job per guild, resourceId absent, reason hourly', () => {
    seedResource(a);
    seedResource(b);
    createResourceRefreshTimer(depsFor()).runOnce();

    for (const scope of [a, b]) {
      const jobs = jobsFor(scope);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.kind).toBe(JOB_KINDS.resourceRefresh);
      expect(jobs[0]?.payload).toBe(JSON.stringify({ reason: 'hourly' }));
    }
  });

  it('a guild with no resources gets no job', () => {
    // Only `a` has a resource; the timer reads the real repo through its
    // default `hasResources`, the same path production uses.
    seedResource(a);
    createResourceRefreshTimer(depsFor()).runOnce();

    expect(jobsFor(a)).toHaveLength(1);
    expect(jobsFor(b)).toHaveLength(0);
  });

  it('starting twice within the hour enqueues once; the next hour enqueues again', () => {
    seedResource(a);
    seedResource(b);
    const timer = createResourceRefreshTimer(depsFor());

    timer.runOnce();
    timer.runOnce();

    expect(jobsFor(a)).toHaveLength(1);
    expect(jobsFor(b)).toHaveLength(1);
    const firstKey = jobsFor(a)[0]?.dedupeKey;

    nowMs += RESOURCE_REFRESH_INTERVAL_MS;
    timer.runOnce();

    for (const scope of [a, b]) {
      const jobs = jobsFor(scope);
      expect(jobs).toHaveLength(2);
    }
    const secondKey = jobsFor(a)[0]?.dedupeKey;
    expect(secondKey).not.toBe(firstKey);
  });

  it('the dedupe key is the hourly bucket, matching resourceRefreshDedupeKey', () => {
    seedResource(a);
    createResourceRefreshTimer(depsFor()).runOnce();
    const bucket = Math.floor(nowMs / RESOURCE_REFRESH_INTERVAL_MS);
    expect(jobsFor(a)[0]?.dedupeKey).toBe(
      resourceRefreshDedupeKey({ reason: 'hourly', hourBucket: bucket }),
    );
  });

  it('start() runs once immediately, then ticks every minute with the bucket deciding when a sweep is due', () => {
    vi.useFakeTimers();
    seedResource(a);
    const timer = createResourceRefreshTimer(depsFor());

    timer.start();
    expect(jobsFor(a)).toHaveLength(1);

    // A minute later, still the same hour bucket: the tick runs but enqueues nothing new.
    nowMs += 60_000;
    vi.advanceTimersByTime(60_000);
    expect(jobsFor(a)).toHaveLength(1);

    // The next hour bucket: the tick enqueues again.
    nowMs += RESOURCE_REFRESH_INTERVAL_MS;
    vi.advanceTimersByTime(60_000);
    expect(jobsFor(a)).toHaveLength(2);

    timer.stop();
    nowMs += RESOURCE_REFRESH_INTERVAL_MS;
    vi.advanceTimersByTime(2 * RESOURCE_REFRESH_INTERVAL_MS);
    expect(jobsFor(a)).toHaveLength(2);
  });

  it('a 15-minute intervalMs enqueues once per 15-minute bucket', () => {
    seedResource(a);
    const timer = createResourceRefreshTimer(depsFor({ intervalMs: () => 15 * 60_000 }));

    timer.runOnce();
    timer.runOnce();
    expect(jobsFor(a)).toHaveLength(1);

    nowMs += 15 * 60_000;
    timer.runOnce();
    expect(jobsFor(a)).toHaveLength(2);

    const bucket = Math.floor(nowMs / (15 * 60_000));
    expect(jobsFor(a)[0]?.dedupeKey).toBe(
      resourceRefreshDedupeKey({ reason: 'hourly', hourBucket: bucket }),
    );
  });

  it('a completed job is not repeated inside the same bucket', () => {
    seedResource(a);
    const timer = createResourceRefreshTimer(depsFor());
    timer.runOnce();
    const job = jobRepo.claimNext(a, nowMs);
    expect(job).toBeDefined();
    jobRepo.completeJob(a, job?.jobId ?? -1, nowMs);

    timer.runOnce();
    expect(jobsFor(a)).toHaveLength(1);
  });

  it('a restart inside the bucket does not repeat it', () => {
    seedResource(a);
    createResourceRefreshTimer(depsFor()).runOnce();
    const job = jobRepo.claimNext(a, nowMs);
    expect(job).toBeDefined();
    jobRepo.completeJob(a, job?.jobId ?? -1, nowMs);

    createResourceRefreshTimer(depsFor()).runOnce();
    expect(jobsFor(a)).toHaveLength(1);
  });

  it('the next bucket enqueues again after completion', () => {
    seedResource(a);
    const timer = createResourceRefreshTimer(depsFor());
    timer.runOnce();
    const job = jobRepo.claimNext(a, nowMs);
    expect(job).toBeDefined();
    jobRepo.completeJob(a, job?.jobId ?? -1, nowMs);

    nowMs += RESOURCE_REFRESH_INTERVAL_MS;
    timer.runOnce();
    expect(jobsFor(a)).toHaveLength(2);
  });
});
