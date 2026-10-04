import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { conversationPruneDedupeKey, JOB_KINDS, parseGuildId } from '@bananasaurs/core';
import { conversationRepo, guildRepo, jobRepo, type GuildScope } from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import {
  CONVERSATION_PRUNE_INTERVAL_MS,
  createConversationPruneTimer,
  type ConversationPruneTimerDeps,
} from './conversation-prune-timer.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let a: GuildScope;
let b: GuildScope;
let nowMs: number;

const depsFor = (over: Partial<ConversationPruneTimerDeps> = {}): ConversationPruneTimerDeps => ({
  guilds: () => [{ scope: a }, { scope: b }],
  enqueue: (scope, input) => jobRepo.enqueue(scope, input),
  now: () => nowMs,
  logger,
  ...over,
});

const jobsFor = (scope: GuildScope) => jobRepo.listJobs(scope, {});

const seedConversation = (scope: GuildScope): void =>
  conversationRepo.createConversation(scope, {
    conversationId: `conv-${scope.guildId}`,
    channelId: '333333333333333333',
    behaviourId: 'club',
    startedBy: '444444444444444444',
    title: 'where is the handbook',
    source: 'discord',
    at: 0,
  });

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  guildRepo.upsertGuild(a, { name: 'guild-a', now: 0 });
  guildRepo.upsertGuild(b, { name: 'guild-b', now: 0 });
  nowMs = Date.parse('2026-09-25T12:00:00.000Z');
});
afterEach(() => t.close());

describe('conversation prune timer', () => {
  it('runOnce enqueues one job per guild carrying the UTC day', () => {
    seedConversation(a);
    seedConversation(b);
    createConversationPruneTimer(depsFor()).runOnce();

    for (const scope of [a, b]) {
      const jobs = jobsFor(scope);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.kind).toBe(JOB_KINDS.conversationPrune);
      expect(jobs[0]?.payload).toBe(JSON.stringify({ day: '2026-09-25' }));
      expect(jobs[0]?.dedupeKey).toBe(conversationPruneDedupeKey('2026-09-25'));
    }
  });

  it('a second runOnce on the same day enqueues nothing; the next day enqueues again', () => {
    seedConversation(a);
    seedConversation(b);
    const timer = createConversationPruneTimer(depsFor());
    timer.runOnce();
    timer.runOnce();
    expect(jobsFor(a)).toHaveLength(1);

    nowMs = Date.parse('2026-09-26T01:00:00.000Z');
    timer.runOnce();
    expect(jobsFor(a)).toHaveLength(2);
    // `listJobs` is newest-first: index 0 is the next day's job.
    expect(jobsFor(a)[0]?.dedupeKey).toBe(conversationPruneDedupeKey('2026-09-26'));
  });

  it('ticks once a day', () => {
    expect(CONVERSATION_PRUNE_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('skips a guild with no conversations, enqueues for one with conversations', () => {
    // Only `a` has a conversation; the timer reads the real repo through its
    // default `hasConversations`, the same path production uses.
    seedConversation(a);
    createConversationPruneTimer(depsFor()).runOnce();

    expect(jobsFor(a)).toHaveLength(1);
    expect(jobsFor(b)).toHaveLength(0);
  });

  it('enqueues nothing when no guild has conversations', () => {
    createConversationPruneTimer(depsFor()).runOnce();

    expect(jobsFor(a)).toHaveLength(0);
    expect(jobsFor(b)).toHaveLength(0);
  });

  it('accepts an injected hasConversations gate', () => {
    createConversationPruneTimer(depsFor({ hasConversations: () => false })).runOnce();
    expect(jobsFor(a)).toHaveLength(0);
    expect(jobsFor(b)).toHaveLength(0);

    createConversationPruneTimer(depsFor({ hasConversations: () => true })).runOnce();
    expect(jobsFor(a)).toHaveLength(1);
    expect(jobsFor(b)).toHaveLength(1);
  });

  it('a completed job is not repeated inside the same bucket', () => {
    seedConversation(a);
    seedConversation(b);
    const timer = createConversationPruneTimer(depsFor());
    timer.runOnce();
    const job = jobRepo.claimNext(a, nowMs);
    expect(job).toBeDefined();
    jobRepo.completeJob(a, job?.jobId ?? -1, nowMs);

    timer.runOnce();
    expect(jobsFor(a)).toHaveLength(1);
  });

  it('a restart inside the bucket does not repeat it', () => {
    seedConversation(a);
    seedConversation(b);
    createConversationPruneTimer(depsFor()).runOnce();
    const job = jobRepo.claimNext(a, nowMs);
    expect(job).toBeDefined();
    jobRepo.completeJob(a, job?.jobId ?? -1, nowMs);

    createConversationPruneTimer(depsFor()).runOnce();
    expect(jobsFor(a)).toHaveLength(1);
  });

  it('the next bucket enqueues again after completion', () => {
    seedConversation(a);
    seedConversation(b);
    const timer = createConversationPruneTimer(depsFor());
    timer.runOnce();
    const job = jobRepo.claimNext(a, nowMs);
    expect(job).toBeDefined();
    jobRepo.completeJob(a, job?.jobId ?? -1, nowMs);

    nowMs = Date.parse('2026-09-26T01:00:00.000Z');
    timer.runOnce();
    expect(jobsFor(a)).toHaveLength(2);
  });
});
