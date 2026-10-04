import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { parseGuildId } from '@bananasaurs/core';
import { guildRepo, jobRepo, type GuildScope } from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { pruneJobsHandler } from './handlers.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let a: GuildScope;
let b: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  guildRepo.upsertGuild(a, { name: 'guild-a', now: 0 });
  guildRepo.upsertGuild(b, { name: 'guild-b', now: 0 });
});
afterEach(() => t.close());

const runCtx = { jobId: 1, attempts: 1, cursor: null, saveCursor: () => undefined };

const OLD = 1_000;
const CUTOFF = 2_000;
const RECENT = 3_000;

describe('pruneJobsHandler (ADR 0127)', () => {
  it('deletes old done rows in batches, keeping queued, recent and other-guild rows', async () => {
    let keySeq = 0;
    const oldDoneIds: number[] = [];
    for (let i = 0; i < 1_200; i += 1) {
      keySeq += 1;
      const created = jobRepo.enqueue(a, {
        kind: 'reconcile_guild',
        payload: '{}',
        dedupeKey: `prune-handler-test:${keySeq}`,
        now: OLD,
      });
      const id = created.jobId ?? -1;
      jobRepo.claimNext(a, OLD);
      jobRepo.completeJob(a, id, OLD);
      oldDoneIds.push(id);
    }

    keySeq += 1;
    const recent = jobRepo.enqueue(a, {
      kind: 'reconcile_guild',
      payload: '{}',
      dedupeKey: `prune-handler-test:${keySeq}`,
      now: RECENT,
    });
    jobRepo.claimNext(a, RECENT);
    jobRepo.completeJob(a, recent.jobId ?? -1, RECENT);

    keySeq += 1;
    const otherGuild = jobRepo.enqueue(b, {
      kind: 'reconcile_guild',
      payload: '{}',
      dedupeKey: `prune-handler-test:${keySeq}`,
      now: OLD,
    });
    jobRepo.claimNext(b, OLD);
    jobRepo.completeJob(b, otherGuild.jobId ?? -1, OLD);

    // Enqueued last and never claimed: `claimNext` takes the oldest due job,
    // so claiming anything after this row exists would take this row instead.
    keySeq += 1;
    const queued = jobRepo.enqueue(a, {
      kind: 'reconcile_guild',
      payload: '{}',
      dedupeKey: `prune-handler-test:${keySeq}`,
      now: OLD,
    });

    await pruneJobsHandler(a, logger).run({ olderThanMs: CUTOFF }, runCtx);

    for (const id of oldDoneIds) {
      expect(jobRepo.findJob(a, id)).toBeUndefined();
    }
    expect(jobRepo.findJob(a, queued.jobId ?? -1)?.state).toBe('queued');
    expect(jobRepo.findJob(a, recent.jobId ?? -1)?.state).toBe('done');
    expect(jobRepo.findJob(b, otherGuild.jobId ?? -1)?.state).toBe('done');
    expect(jobRepo.countByState(a)).toEqual({ queued: 1, done: 1 });
  });
});
