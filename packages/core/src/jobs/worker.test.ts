import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { z } from 'zod';
import {
  JobWorker,
  RetryAfterError,
  type AnyJobHandler,
  type ClaimedJob,
  type FailOptions,
  type JobContext,
  type JobStore,
} from './worker.js';

const logger = pino({ level: 'silent' });

/** A real pino instance over a captured stream, so redaction runs for real. */
const capturingLogger = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { logger: pino({ level: 'info' }, stream), lines };
};

interface Recorded {
  jobId: number;
  error: string;
  permanent: boolean;
  retryAfterMs: number | undefined;
}

/**
 * An in-memory store with the same contract as `repos/jobs.ts`, including the
 * bit that matters: `attempts` increments on claim.
 */
const memoryStore = () => {
  const rows: (ClaimedJob & { state: string; runAfter: number })[] = [];
  const failures: Recorded[] = [];
  const completed: number[] = [];
  const cursors: (string | null)[] = [];
  let nextId = 1;

  const store: JobStore = {
    claimNext() {
      const row = rows.find((r) => r.state === 'queued');
      if (!row) return undefined;
      row.state = 'running';
      row.attempts += 1;
      return { ...row };
    },
    complete(jobId) {
      completed.push(jobId);
      const row = rows.find((r) => r.jobId === jobId);
      if (row) row.state = 'done';
    },
    fail(jobId, error, _now, options: FailOptions = {}) {
      const row = rows.find((r) => r.jobId === jobId);
      const permanent = options.permanent === true;
      failures.push({ jobId, error, permanent, retryAfterMs: options.retryAfterMs });
      const willRetry = !permanent && (row?.attempts ?? 0) < (row?.maxAttempts ?? 0);
      if (row) row.state = willRetry ? 'queued' : 'failed';
      return { willRetry };
    },
    saveCursor(jobId, cursor) {
      cursors.push(cursor);
      const row = rows.find((r) => r.jobId === jobId);
      if (row) row.cursor = cursor;
    },
    requeueStranded() {
      const stranded = rows.filter((r) => r.state === 'running');
      for (const row of stranded) row.state = 'queued';
      return stranded.length;
    },
  };

  const add = (over: Partial<ClaimedJob> = {}) => {
    const row = {
      jobId: nextId++,
      kind: 'sweep',
      payload: '{"olderThanMs":1000}',
      attempts: 0,
      maxAttempts: 3,
      cursor: null,
      state: 'queued',
      runAfter: 0,
      ...over,
    };
    rows.push(row);
    return row;
  };

  return { store, rows, failures, completed, cursors, add };
};

const sweepPayload = z.object({ olderThanMs: z.number() });

const handlerFor = (
  ran: { payload: unknown; context: JobContext }[],
  behaviour: 'ok' | 'throw' = 'ok',
): AnyJobHandler => ({
  kind: 'sweep',
  payload: sweepPayload,
  run(payload, context) {
    ran.push({ payload, context });
    if (behaviour === 'throw') throw new Error('handler exploded');
  },
});

let s: ReturnType<typeof memoryStore>;
let ran: { payload: unknown; context: JobContext }[];

const build = (handlers: readonly AnyJobHandler[]) =>
  new JobWorker({ store: s.store, handlers, logger, now: () => 1000 });

beforeEach(() => {
  s = memoryStore();
  ran = [];
});

describe('runOnce', () => {
  it('is idle when there is nothing to do', async () => {
    expect(await build([handlerFor(ran)]).runOnce()).toEqual({ status: 'idle' });
  });

  it('runs the handler for the claimed job kind', async () => {
    s.add();
    const outcome = await build([handlerFor(ran)]).runOnce();

    expect(outcome).toEqual({ status: 'completed', jobId: 1, kind: 'sweep' });
    expect(ran).toHaveLength(1);
    expect(s.completed).toEqual([1]);
  });

  it('hands the handler a validated payload, not the raw string', async () => {
    s.add();
    await build([handlerFor(ran)]).runOnce();
    expect(ran[0]?.payload).toEqual({ olderThanMs: 1000 });
  });
});

describe('failures that a retry cannot fix are permanent', () => {
  it('fails a job whose kind has no handler', async () => {
    s.add({ kind: 'not-registered' });
    const outcome = await build([handlerFor(ran)]).runOnce();

    expect(outcome).toMatchObject({ status: 'failed', willRetry: false });
    expect(s.failures[0]?.permanent).toBe(true);
  });

  it('fails a job whose payload does not validate', async () => {
    // A payload written by an older version is untrusted input exactly like a
    // form submission (CLAUDE.md rule 3). It gets a validator, not a cast.
    s.add({ payload: '{"olderThanMs":"not a number"}' });
    const outcome = await build([handlerFor(ran)]).runOnce();

    expect(outcome).toMatchObject({ status: 'failed', willRetry: false });
    expect(s.failures[0]?.permanent).toBe(true);
    expect(ran).toHaveLength(0);
  });

  it('fails a job whose payload is not even JSON', async () => {
    s.add({ payload: 'not json at all' });
    expect(await build([handlerFor(ran)]).runOnce()).toMatchObject({
      status: 'failed',
      willRetry: false,
    });
  });

  it('says what was wrong, rather than logging a bare stack', async () => {
    s.add({ kind: 'not-registered' });
    const outcome = await build([handlerFor(ran)]).runOnce();
    expect(outcome).toMatchObject({ error: expect.stringContaining('not-registered') as string });
  });

  it('writes the real error into the log line, not "<non-error>" (finding 2)', async () => {
    // `#fail` logs `describeError()`'s own output — already a plain string —
    // under the key `error`. `safeLogFields`'s redaction for that key used to
    // preserve only `instanceof Error`, so a string was always stomped to
    // '<non-error>', on every job failure. This is why finding 1 took a live
    // diagnostic script to find instead of a log line
    // (docs/reports/WP5-slice-6-live-test.md).
    const { logger: capturing, lines } = capturingLogger();
    s.add();
    const worker = new JobWorker({
      store: s.store,
      handlers: [handlerFor(ran, 'throw')],
      logger: capturing,
      now: () => 1000,
    });

    await worker.runOnce();

    const entry = JSON.parse(lines.at(-1) ?? '{}') as { error?: string };
    expect(entry.error).toBe('Error: handler exploded');
    expect(entry.error).not.toBe('<non-error>');
  });
});

describe('failures that might be transient are retried', () => {
  it('reschedules when the handler throws', async () => {
    s.add();
    const outcome = await build([handlerFor(ran, 'throw')]).runOnce();

    expect(outcome).toMatchObject({ status: 'failed', willRetry: true });
    expect(s.failures[0]?.permanent).toBe(false);
  });

  it('passes a handler-chosen retry delay to the store', async () => {
    s.add();
    const handler: AnyJobHandler = {
      kind: 'sweep',
      payload: sweepPayload,
      run() {
        throw new RetryAfterError('provider busy', 30_000);
      },
    };
    const outcome = await build([handler]).runOnce();

    expect(outcome).toMatchObject({
      status: 'failed',
      willRetry: true,
      error: 'RetryAfterError: provider busy',
    });
    expect(s.failures[0]).toMatchObject({ permanent: false, retryAfterMs: 30_000 });
  });

  it('leaves the delay to the store for an ordinary error', async () => {
    s.add();
    await build([handlerFor(ran, 'throw')]).runOnce();
    expect(s.failures[0]?.retryAfterMs).toBeUndefined();
  });

  it('stops retrying once attempts are exhausted', async () => {
    s.add({ maxAttempts: 2 });
    const worker = build([handlerFor(ran, 'throw')]);

    await worker.runOnce();
    const second = await worker.runOnce();

    expect(second).toMatchObject({ status: 'failed', willRetry: false });
  });
});

describe('cursors', () => {
  it('gives the handler the progress from a previous attempt', async () => {
    s.add({ cursor: 'after=999' });
    await build([handlerFor(ran)]).runOnce();
    expect(ran[0]?.context.cursor).toBe('after=999');
  });

  it('persists progress the handler saves', async () => {
    s.add();
    const saving: AnyJobHandler = {
      kind: 'sweep',
      payload: sweepPayload,
      run(_payload, context) {
        context.saveCursor('after=1234');
      },
    };

    await build([saving]).runOnce();
    expect(s.cursors).toEqual(['after=1234']);
  });
});

describe('drain', () => {
  it('works through the queue', async () => {
    s.add();
    s.add();
    s.add();
    expect(await build([handlerFor(ran)]).drain()).toBe(3);
  });

  it('stops at the limit, so a self-enqueuing handler cannot starve the process', async () => {
    // A resumable pass that queues its own successor would otherwise keep this
    // loop running forever and nothing else in the process would get a turn.
    for (let i = 0; i < 10; i += 1) s.add();
    expect(await build([handlerFor(ran)]).drain(4)).toBe(4);
  });

  it('stops when the queue empties rather than spinning', async () => {
    s.add();
    expect(await build([handlerFor(ran)]).drain(50)).toBe(1);
  });
});

describe('startup recovery', () => {
  it('returns jobs left running by a crash', async () => {
    s.add();
    s.store.claimNext(0); // simulate the claim, then the crash
    expect(build([handlerFor(ran)]).recoverStranded()).toBe(1);

    // And the recovered job is now runnable again.
    expect(await build([handlerFor(ran)]).runOnce()).toMatchObject({ status: 'completed' });
  });

  it('reports nothing to recover on a clean start', () => {
    s.add();
    expect(build([handlerFor(ran)]).recoverStranded()).toBe(0);
  });
});

describe('handler registration', () => {
  it('refuses two handlers for one kind', () => {
    // Otherwise one of them silently never runs, and which one depends on
    // array order.
    expect(() => build([handlerFor(ran), handlerFor(ran)])).toThrow(/duplicate job handler/);
  });
});

describe('Task 10 (d): job failed line carries a string code', () => {
  it('logs code chain-failed when the thrown error carries one', async () => {
    const { logger: capturing, lines } = capturingLogger();
    s.add();
    const coded: AnyJobHandler = {
      kind: 'sweep',
      payload: sweepPayload,
      run() {
        throw Object.assign(new Error('every model failed'), { code: 'chain-failed' });
      },
    };
    const worker = new JobWorker({
      store: s.store,
      handlers: [coded],
      logger: capturing,
      now: () => 1000,
    });
    await worker.runOnce();
    const entry = JSON.parse(lines.at(-1) ?? '{}') as { code?: string };
    expect(entry.code).toBe('chain-failed');
  });
});
