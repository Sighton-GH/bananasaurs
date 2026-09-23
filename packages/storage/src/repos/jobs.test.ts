import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import { upsertGuild } from './guilds.js';
import {
  backoffMs,
  cancelJob,
  claimNext,
  completeJob,
  countByState,
  enqueue,
  failJob,
  findJob,
  listJobs,
  oldestDueAt,
  requeueStranded,
  retryJob,
  saveCursor,
} from './jobs.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  upsertGuild(a, { name: 'guild a', now: 0 });
  upsertGuild(b, { name: 'guild b', now: 0 });
});
afterEach(() => {
  t.close();
});

const put = (scope: GuildScope, over: Partial<Parameters<typeof enqueue>[1]> = {}) =>
  enqueue(scope, {
    kind: 'reconcile',
    payload: '{"panelId":"p1"}',
    dedupeKey: 'reconcile:p1',
    now: 1000,
    ...over,
  });

describe('enqueue', () => {
  it('creates a job', () => {
    const result = put(a);
    expect(result.enqueued).toBe(true);
    expect(findJob(a, result.jobId ?? -1)?.kind).toBe('reconcile');
  });

  it('is a no-op for work already queued', () => {
    // A flapping connection re-triggers reconciliation on every reconnect.
    // Without the dedupe key the worker spends the outage repeating itself.
    put(a);
    const second = put(a);
    expect(second.enqueued).toBe(false);
    expect(second.jobId).toBeUndefined();
    expect(countByState(a)).toEqual({ queued: 1 });
  });

  it('is scoped: the same dedupe key in another guild is separate work', () => {
    put(a);
    expect(put(b).enqueued).toBe(true);
  });

  /**
   * ADR 0016. The dedupe key collapses work that is still *pending*; it is not
   * a permanent record that this work was once done.
   *
   * WP2 shipped `jobs_dedupe` as an unconditional UNIQUE, and job rows are
   * never deleted, so a key was single-use for the life of the database. The
   * second gateway gap ever would enqueue nothing —
   * `createConnectionSubscriber` always passes `reconcile_guild:gateway-gap` —
   * and the drift that outage caused would never be repaired. Silently: a
   * collapse and a permanent block are the same `{enqueued: false}` at the
   * call site.
   */
  describe('dedupe is over pending work, not history (ADR 0016)', () => {
    it('still collapses a second request while the first is queued', () => {
      put(a);
      expect(put(a).enqueued).toBe(false);
      expect(countByState(a)).toEqual({ queued: 1 });
    });

    it('still collapses a second request while the first is running', () => {
      put(a);
      claimNext(a, 1000);
      expect(put(a).enqueued).toBe(false);
      expect(countByState(a)).toEqual({ running: 1 });
    });

    it('accepts the same work again once the first has completed', () => {
      put(a);
      const claimed = claimNext(a, 1000);
      completeJob(a, claimed?.jobId ?? -1, 1100);

      const again = put(a, { now: 2000 });
      expect(again.enqueued).toBe(true);
      expect(again.jobId).toBeDefined();
      expect(countByState(a)).toEqual({ done: 1, queued: 1 });
    });

    it('accepts the same work again once the first has permanently failed', () => {
      // A reconciliation pass that exhausted its attempts must not disable
      // reconciliation for the lifetime of the database.
      const first = put(a, { maxAttempts: 1 });
      claimNext(a, 1000);
      const outcome = failJob(a, first.jobId ?? -1, 'boom', 1100);
      expect(outcome.willRetry).toBe(false);

      expect(put(a, { now: 2000 }).enqueued).toBe(true);
      expect(countByState(a)).toEqual({ failed: 1, queued: 1 });
    });

    it('accepts the same work again once the first was cancelled', () => {
      const first = put(a);
      cancelJob(a, first.jobId ?? -1, 1100);
      expect(put(a, { now: 2000 }).enqueued).toBe(true);
    });
  });

  /**
   * The purge job (ADR 0037) enqueues its own continuation pre-loaded with
   * the cursor to resume from, rather than starting the new row at `null`
   * and losing the progress the tick just computed.
   */
  describe('an initial cursor, for a job that enqueues its own continuation', () => {
    it('is null when omitted, like every other job kind today', () => {
      const result = put(a);
      expect(findJob(a, result.jobId ?? -1)?.cursor).toBeNull();
    });

    it('is set on the row a successful insert creates', () => {
      const result = put(a, { cursor: '{"phase":"fresh","deletedCount":10}' });
      expect(findJob(a, result.jobId ?? -1)?.cursor).toBe('{"phase":"fresh","deletedCount":10}');
    });

    it('is not applied when the insert is skipped by the dedupe key', () => {
      // A conflicting enqueue must never overwrite a live row's progress —
      // this is not an update, only ever a starting value for a row this
      // call actually creates.
      const first = put(a, { cursor: '{"phase":"fresh","deletedCount":1}' });
      const second = put(a, { cursor: '{"phase":"old","deletedCount":99}' });
      expect(second.enqueued).toBe(false);
      expect(findJob(a, first.jobId ?? -1)?.cursor).toBe('{"phase":"fresh","deletedCount":1}');
    });
  });
});

describe('claimNext', () => {
  it('returns nothing when the queue is empty', () => {
    expect(claimNext(a, 1000)).toBeUndefined();
  });

  it('claims a due job and marks it running', () => {
    put(a);
    const claimed = claimNext(a, 1000);
    expect(claimed?.state).toBe('running');
    expect(countByState(a)).toEqual({ running: 1 });
  });

  it('does not claim a job scheduled for later', () => {
    put(a, { runAfter: 5000 });
    expect(claimNext(a, 1000)).toBeUndefined();
  });

  it('increments attempts on claim, not on failure', () => {
    // A job that crashes the process never reaches a failure handler. Counting
    // on failure lets it retry forever and take the process down every time.
    put(a);
    expect(claimNext(a, 1000)?.attempts).toBe(1);
  });

  it('takes the oldest due job first', () => {
    put(a, { dedupeKey: 'later', runAfter: 900 });
    put(a, { dedupeKey: 'earlier', runAfter: 100 });
    expect(claimNext(a, 1000)?.dedupeKey).toBe('earlier');
  });

  it('does not claim another guild work', () => {
    put(b);
    expect(claimNext(a, 1000)).toBeUndefined();
    expect(countByState(b)).toEqual({ queued: 1 });
  });

  it('does not hand the same job to two claims', () => {
    put(a);
    expect(claimNext(a, 1000)).toBeDefined();
    expect(claimNext(a, 1000)).toBeUndefined();
  });
});

describe('failJob', () => {
  it('reschedules with backoff while attempts remain', () => {
    const { jobId } = put(a);
    claimNext(a, 1000);
    const result = failJob(a, jobId ?? -1, '429 from Discord', 2000);

    expect(result.willRetry).toBe(true);
    expect(result.nextRunAfter).toBe(2000 + backoffMs(1));
    expect(findJob(a, jobId ?? -1)?.state).toBe('queued');
  });

  it('uses a caller-chosen retry delay instead of the backoff', () => {
    const { jobId } = put(a);
    claimNext(a, 1000);
    const result = failJob(a, jobId ?? -1, 'provider busy', 2000, { retryAfterMs: 30_000 });

    expect(result).toEqual({ willRetry: true, nextRunAfter: 32_000 });
    expect(findJob(a, jobId ?? -1)?.state).toBe('queued');
  });

  it('records the error so a failure is diagnosable', () => {
    const { jobId } = put(a);
    claimNext(a, 1000);
    failJob(a, jobId ?? -1, '429 from Discord', 2000);
    expect(findJob(a, jobId ?? -1)?.lastError).toBe('429 from Discord');
  });

  it('gives up after max_attempts', () => {
    const { jobId } = put(a, { maxAttempts: 2 });
    claimNext(a, 1000);
    failJob(a, jobId ?? -1, 'first', 2000);
    claimNext(a, 1_000_000);
    const last = failJob(a, jobId ?? -1, 'second', 2_000_000);

    expect(last.willRetry).toBe(false);
    expect(findJob(a, jobId ?? -1)?.state).toBe('failed');
  });

  it('keeps an exhausted job in the table rather than deleting it', () => {
    // Silently dropping work is how an outage becomes invisible. doctor and
    // `audit tail` need something to show.
    const { jobId } = put(a, { maxAttempts: 1 });
    claimNext(a, 1000);
    failJob(a, jobId ?? -1, 'boom', 2000);
    expect(findJob(a, jobId ?? -1)?.lastError).toBe('boom');
  });

  it('fails immediately when the failure is permanent', () => {
    // An unregistered kind will still be unregistered in a minute. Retrying to
    // exhaustion buries the real error under four duplicates.
    const { jobId } = put(a, { maxAttempts: 5 });
    claimNext(a, 1000);
    const result = failJob(a, jobId ?? -1, 'no handler', 2000, { permanent: true });

    expect(result.willRetry).toBe(false);
    expect(findJob(a, jobId ?? -1)?.state).toBe('failed');
  });

  it('cannot fail another guild job by passing its id', () => {
    const { jobId } = put(b);
    claimNext(b, 1000);
    failJob(a, jobId ?? -1, 'not mine', 2000);
    expect(findJob(b, jobId ?? -1)?.state).toBe('running');
  });
});

describe('backoffMs', () => {
  it('grows exponentially', () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n))).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('is capped, so a poisoned job does not recede forever', () => {
    expect(backoffMs(40)).toBe(300_000);
  });
});

describe('cursors and lifecycle', () => {
  it('saves resumable progress', () => {
    const { jobId } = put(a);
    claimNext(a, 1000);
    saveCursor(a, jobId ?? -1, 'after=999', 1100);
    expect(findJob(a, jobId ?? -1)?.cursor).toBe('after=999');
  });

  it('clears the error when a job completes', () => {
    const { jobId } = put(a);
    claimNext(a, 1000);
    failJob(a, jobId ?? -1, 'transient', 2000);
    claimNext(a, 1_000_000);
    completeJob(a, jobId ?? -1, 2_000_000);

    const done = findJob(a, jobId ?? -1);
    expect(done?.state).toBe('done');
    expect(done?.lastError).toBeNull();
  });

  it('cancels queued work but not work already running', () => {
    const claimedFirst = put(a, { dedupeKey: 'first' });
    const stillQueued = put(a, { dedupeKey: 'second' });
    claimNext(a, 1000); // takes `first`, the lower job_id of the two

    cancelJob(a, claimedFirst.jobId ?? -1, 2000);
    cancelJob(a, stillQueued.jobId ?? -1, 2000);

    // Cancelling running work would abandon a job mid-flight with no record of
    // what it had already done. Only queued work is cancellable.
    expect(findJob(a, claimedFirst.jobId ?? -1)?.state).toBe('running');
    expect(findJob(a, stillQueued.jobId ?? -1)?.state).toBe('cancelled');
  });
});

describe('requeueStranded', () => {
  it('returns a job left running by a crash', () => {
    // Without this, a job claimed at the instant of a crash stays marked
    // running forever and nothing ever picks it up again.
    put(a);
    claimNext(a, 1000);
    expect(requeueStranded(a, 5000)).toBe(1);
    expect(countByState(a)).toEqual({ queued: 1 });
  });

  it('leaves the incremented attempt count alone', () => {
    // So a job that crashes the process on every start still terminates
    // instead of looping forever.
    const { jobId } = put(a);
    claimNext(a, 1000);
    requeueStranded(a, 5000);
    expect(findJob(a, jobId ?? -1)?.attempts).toBe(1);
  });

  it('does not touch queued or done work', () => {
    put(a, { dedupeKey: 'still-queued' });
    expect(requeueStranded(a, 5000)).toBe(0);
  });

  it('does not requeue another guild work', () => {
    put(b);
    claimNext(b, 1000);
    expect(requeueStranded(a, 5000)).toBe(0);
    expect(countByState(b)).toEqual({ running: 1 });
  });
});

describe('oldestDueAt', () => {
  it('returns the run_after of the oldest queued job that is already due', () => {
    put(a, { runAfter: 500 });
    put(a, { runAfter: 200, dedupeKey: 'k2' });
    put(a, { runAfter: 900, dedupeKey: 'k3' });
    expect(oldestDueAt(a, 1_000)).toBe(200);
  });

  it('ignores a job scheduled for the future, which is not lag', () => {
    put(a, { runAfter: 5_000 });
    expect(oldestDueAt(a, 1_000)).toBeUndefined();
  });

  it('ignores jobs that are not queued', () => {
    const job = put(a, { runAfter: 100 });
    claimNext(a, 1_000);
    expect(oldestDueAt(a, 1_000)).toBeUndefined();
    completeJob(a, job.jobId ?? 0, 1_000);
    expect(oldestDueAt(a, 1_000)).toBeUndefined();
  });

  it('returns undefined when there is nothing queued at all', () => {
    expect(oldestDueAt(a, 1_000)).toBeUndefined();
  });

  it("does not see another guild's overdue job", () => {
    put(b, { runAfter: 1 });
    expect(oldestDueAt(a, 1_000)).toBeUndefined();
    expect(oldestDueAt(b, 1_000)).toBe(1);
  });
});

describe('listJobs', () => {
  it('returns the newest jobs first, so a tail is the default view', () => {
    put(a, { dedupeKey: 'k1', now: 100 });
    put(a, { dedupeKey: 'k2', now: 200 });
    const rows = listJobs(a, {});
    expect(rows.map((r) => r.dedupeKey)).toEqual(['k2', 'k1']);
  });

  it('honours the limit', () => {
    put(a, { dedupeKey: 'k1' });
    put(a, { dedupeKey: 'k2' });
    put(a, { dedupeKey: 'k3' });
    expect(listJobs(a, { limit: 2 })).toHaveLength(2);
  });

  it('can be narrowed to failures, which is the reason an operator asks', () => {
    const stuck = put(a, { dedupeKey: 'k1', maxAttempts: 1 });
    put(a, { dedupeKey: 'k2' });
    claimNext(a, 1_000);
    failJob(a, stuck.jobId ?? 0, 'it exploded', 1_000);
    const rows = listJobs(a, { failedOnly: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('failed');
    expect(rows[0]?.lastError).toBe('it exploded');
  });

  it("does not see another guild's jobs", () => {
    put(b, { dedupeKey: 'k1' });
    expect(listJobs(a, {})).toEqual([]);
    expect(listJobs(b, {})).toHaveLength(1);
  });
});

/**
 * `bananasaurs jobs retry <id> --confirm`.
 *
 * The interesting cases are all refusals. Requeueing a failed job is three
 * column writes; knowing when not to is the substance, and the one that would
 * otherwise surface as a raw SQLite constraint error is a job whose dedupe key
 * is already held by pending work (ADR 0016's partial unique index).
 */
describe('retryJob', () => {
  /** Fails loudly rather than defaulting: a fixture that enqueued nothing
   * would otherwise make every assertion below test the empty case. */
  const idOf = (result: ReturnType<typeof put>): number => {
    if (result.jobId === undefined) throw new Error('the fixture enqueued no job');
    return result.jobId;
  };

  const failToDeath = (scope: GuildScope): number => {
    const jobId = idOf(put(scope));
    for (let i = 0; i < 5; i += 1) {
      claimNext(scope, 10_000 + i * 600_000);
      failJob(scope, jobId, 'it exploded', 10_000 + i * 600_000);
    }
    expect(findJob(scope, jobId)?.state).toBe('failed');
    return jobId;
  };

  it('returns a failed job to the queue, due now', () => {
    const jobId = failToDeath(a);
    const outcome = retryJob(a, jobId, 99_000);
    expect(outcome).toMatchObject({ ok: true });
    const row = findJob(a, jobId);
    expect(row).toMatchObject({ state: 'queued', runAfter: 99_000, lastError: null });
  });

  it('resets the attempt count, or the retry would fail again immediately', () => {
    // `claimNext` increments `attempts` and `failJob` gives up once it reaches
    // `max_attempts`. Leaving the count at five would spend one claim to reach
    // exactly the state the operator asked to leave.
    const jobId = failToDeath(a);
    retryJob(a, jobId, 99_000);
    expect(findJob(a, jobId)?.attempts).toBe(0);

    const claimed = claimNext(a, 99_001);
    expect(claimed?.jobId).toBe(jobId);
    const result = failJob(a, jobId, 'again', 99_002);
    expect(result.willRetry).toBe(true);
  });

  it('refuses a job that is not failed, naming the state it is in', () => {
    const jobId = idOf(put(a));
    const outcome = retryJob(a, jobId, 99_000);
    expect(outcome).toEqual({ ok: false, reason: 'not-failed', state: 'queued' });
    expect(findJob(a, jobId)?.runAfter).toBe(1000);
  });

  it('refuses a job id that does not exist', () => {
    expect(retryJob(a, 4242, 99_000)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('refuses when pending work already holds the same dedupe key', () => {
    // The partial unique index covers `queued` and `running` only, so the
    // failed row and a fresh enqueue coexist happily — until the retry tries to
    // make the failed one queued as well. Refused with the blocking id rather
    // than raised as a UNIQUE constraint error the operator cannot act on.
    const jobId = failToDeath(a);
    const replacement = idOf(put(a, { now: 50_000 }));

    expect(retryJob(a, jobId, 99_000)).toEqual({
      ok: false,
      reason: 'dedupe-blocked',
      blockingJobId: replacement,
    });
    expect(findJob(a, jobId)?.state).toBe('failed');
  });

  it("cannot retry another guild's job", () => {
    const jobId = failToDeath(b);
    expect(retryJob(a, jobId, 99_000)).toEqual({ ok: false, reason: 'not-found' });
    expect(findJob(b, jobId)?.state).toBe('failed');
  });
});
