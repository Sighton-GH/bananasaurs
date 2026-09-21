import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { JOB_KINDS, parseGuildId } from '@bananasaurs/core';
import { guildRepo, jobRepo, type GuildScope } from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import {
  createReminderDeliveryTimer,
  REMINDER_DELIVERY_INTERVAL_MS,
  type ReminderDeliveryTimerDeps,
} from './reminder-timer.js';

/**
 * The reminder delivery timer against the real job table, mirroring
 * `archive-expiry-timer.test.ts`: a tick enqueues one `deliver_reminders`
 * pass per guild, the constant dedupe key collapses repeat ticks while a
 * pass is pending, and finishing the pass lets the next tick enqueue again.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let a: GuildScope;
let b: GuildScope;
let nowMs: number;

const depsFor = (over: Partial<ReminderDeliveryTimerDeps> = {}): ReminderDeliveryTimerDeps => ({
  guilds: () => [{ scope: a }, { scope: b }],
  enqueue: (scope, input) => jobRepo.enqueue(scope, input),
  now: () => nowMs,
  logger,
  ...over,
});

const jobsFor = (scope: GuildScope) => jobRepo.listJobs(scope, {});

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  guildRepo.upsertGuild(a, { name: 'guild-a', now: 0 });
  guildRepo.upsertGuild(b, { name: 'guild-b', now: 0 });
  nowMs = Date.parse('2026-09-20T12:00:00.000Z');
});

afterEach(() => {
  t.close();
  vi.useRealTimers();
});

describe('reminder delivery timer', () => {
  it('enqueues one delivery pass per guild per tick, collapsing repeats', () => {
    const timer = createReminderDeliveryTimer(depsFor());
    timer.runOnce();
    expect(jobsFor(a).filter((j) => j.kind === JOB_KINDS.deliverReminders)).toHaveLength(1);
    expect(jobsFor(b).filter((j) => j.kind === JOB_KINDS.deliverReminders)).toHaveLength(1);
    // A second tick while the pass is still pending enqueues nothing.
    timer.runOnce();
    expect(jobsFor(a).filter((j) => j.kind === JOB_KINDS.deliverReminders)).toHaveLength(1);
  });

  it('enqueues again once the previous pass has finished', () => {
    const timer = createReminderDeliveryTimer(depsFor());
    timer.runOnce();
    const claimed = jobRepo.claimNext(a, nowMs);
    expect(claimed?.kind).toBe(JOB_KINDS.deliverReminders);
    jobRepo.completeJob(a, claimed!.jobId, nowMs);
    nowMs += REMINDER_DELIVERY_INTERVAL_MS;
    timer.runOnce();
    expect(jobsFor(a).filter((j) => j.kind === JOB_KINDS.deliverReminders)).toHaveLength(2);
  });

  it('start runs immediately, then fires on the interval until stopped', () => {
    vi.useFakeTimers();
    const timer = createReminderDeliveryTimer(depsFor());
    timer.start();
    expect(jobsFor(a).filter((j) => j.kind === JOB_KINDS.deliverReminders)).toHaveLength(1);
    // The interval fires, but the pending pass collapses the enqueue.
    vi.advanceTimersByTime(REMINDER_DELIVERY_INTERVAL_MS * 3);
    expect(jobsFor(a).filter((j) => j.kind === JOB_KINDS.deliverReminders)).toHaveLength(1);
    timer.stop();
  });
});
