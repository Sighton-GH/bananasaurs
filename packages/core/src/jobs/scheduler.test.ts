import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { z } from 'zod';
import { JOB_KINDS } from './kinds.js';
import { JobWorker, type AnyJobHandler, type ClaimFilter, type JobStore } from './worker.js';
import { LaneScheduler } from './scheduler.js';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

interface Row {
  jobId: number;
  kind: string;
  payload: string;
  orderingKey: string | null;
  state: 'queued' | 'running' | 'done' | 'failed';
  runAfter: number;
  attempts: number;
  maxAttempts: number;
}

/**
 * An in-memory store implementing the ADR 0135 claim semantics: the same
 * contract the storage tests pin on the real `claimNext`.
 */
const fakeStore = () => {
  const rows: Row[] = [];
  const failures: { jobId: number; error: string }[] = [];
  let nextId = 1;

  const matches = (row: Row, filter: ClaimFilter | undefined): boolean => {
    if (filter?.kinds !== undefined && !filter.kinds.includes(row.kind)) return false;
    if (filter?.excludeKinds !== undefined && filter.excludeKinds.includes(row.kind)) return false;
    return true;
  };

  const store: JobStore = {
    claimNext(_nowMs: number, filter?: ClaimFilter) {
      const due = rows
        .filter((r) => r.state === 'queued' && r.runAfter <= 1000 && matches(r, filter))
        .sort((x, y) => x.runAfter - y.runAfter || x.jobId - y.jobId);
      const oldest = due[0];
      if (oldest === undefined) return undefined;
      const claim = (row: Row) => {
        row.state = 'running';
        row.attempts += 1;
        return {
          jobId: row.jobId,
          kind: row.kind,
          payload: row.payload,
          attempts: row.attempts,
          maxAttempts: row.maxAttempts,
          cursor: null,
          orderingKey: row.orderingKey,
        };
      };
      if (oldest.orderingKey === null) {
        if (filter?.laneBusy === true) return undefined;
        return claim(oldest);
      }
      const busy = new Set(filter?.busyOrderingKeys ?? []);
      const keyed = due.find((r) => r.orderingKey !== null && !busy.has(r.orderingKey));
      if (keyed === undefined) return undefined;
      return claim(keyed);
    },
    complete(jobId: number) {
      const row = rows.find((r) => r.jobId === jobId);
      if (row) row.state = 'done';
    },
    fail(jobId: number, error: string) {
      failures.push({ jobId, error });
      const row = rows.find((r) => r.jobId === jobId);
      if (row) row.state = row.attempts < row.maxAttempts ? 'queued' : 'failed';
      return { willRetry: (row?.attempts ?? 0) < (row?.maxAttempts ?? 0) };
    },
    saveCursor() {},
    requeueStranded() {
      return 0;
    },
  };

  const queue = (
    kind: string,
    orderingKey: string | null,
    payload: unknown = {},
    runAfter = 0,
  ): number => {
    const jobId = nextId++;
    rows.push({
      jobId,
      kind,
      payload: JSON.stringify(payload),
      orderingKey,
      state: 'queued',
      runAfter,
      attempts: 0,
      maxAttempts: 3,
    });
    return jobId;
  };

  return { store, rows, failures, queue };
};

type Store = ReturnType<typeof fakeStore>;

const payloadSchema = z.object({ token: z.string().optional(), boom: z.boolean().optional() });

/** Handlers block on deferred promises the test resolves by hand; nothing sleeps. */
const setup = (gates: Map<string, ReturnType<typeof deferred>>) => {
  const started: string[] = [];
  const blocking = (kind: string): AnyJobHandler => ({
    kind,
    payload: payloadSchema,
    async run(raw: unknown) {
      const token = (raw as { token?: string }).token ?? kind;
      started.push(token);
      const gate = gates.get(token);
      if (gate) await gate.promise;
      if ((raw as { boom?: boolean }).boom === true) throw new Error('handler exploded');
    },
  });
  const immediate = (kind: string): AnyJobHandler => ({
    kind,
    payload: payloadSchema,
    run(raw: unknown) {
      started.push((raw as { token?: string }).token ?? kind);
      if ((raw as { boom?: boolean }).boom === true) throw new Error('handler exploded');
    },
  });
  return { started, blocking, immediate };
};

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

const build = (
  s: Store,
  handlers: readonly AnyJobHandler[],
  assistantConcurrency: () => number,
  logger = pino({ level: 'silent' }),
) => {
  const worker = new JobWorker({ store: s.store, handlers, logger, now: () => 1000 });
  const scheduler = new LaneScheduler({
    worker,
    lanes: [
      { lane: 'assistant', concurrency: assistantConcurrency },
      { lane: 'background', concurrency: () => 1 },
      { lane: 'default', concurrency: () => 1 },
    ],
    logger,
  });
  return scheduler;
};

const flush = async (rounds = 10): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

let s: Store;
let gates: Map<string, ReturnType<typeof deferred>>;

beforeEach(() => {
  s = fakeStore();
  gates = new Map();
});

describe('LaneScheduler', () => {
  it('(a) a blocked background job does not stop other lanes in the same tick', () => {
    const h = setup(gates);
    gates.set(JOB_KINDS.resourceRefresh, deferred());
    gates.set(JOB_KINDS.assistantInvoke, deferred());
    s.queue(JOB_KINDS.resourceRefresh, null, { token: JOB_KINDS.resourceRefresh });
    s.queue(JOB_KINDS.assistantInvoke, 'chan:A', { token: 'invoke' });
    s.queue(JOB_KINDS.reconcileGuild, null, { token: 'reconcile' });
    const scheduler = build(
      s,
      [
        h.blocking(JOB_KINDS.resourceRefresh),
        h.blocking(JOB_KINDS.assistantInvoke),
        h.immediate(JOB_KINDS.reconcileGuild),
      ],
      () => 4,
    );
    expect(scheduler.tick()).toBe(3);
    expect(h.started).toContain('invoke');
    expect(h.started).toContain('reconcile');
    expect(h.started).toContain(JOB_KINDS.resourceRefresh);
  });

  it('(b) assistant concurrency 2 runs two invokes and holds the third', async () => {
    const h = setup(gates);
    for (const key of ['chan:A', 'chan:B', 'chan:C']) gates.set(key, deferred());
    s.queue(JOB_KINDS.assistantInvoke, 'chan:A', { token: 'chan:A' });
    s.queue(JOB_KINDS.assistantInvoke, 'chan:B', { token: 'chan:B' });
    s.queue(JOB_KINDS.assistantInvoke, 'chan:C', { token: 'chan:C' });
    const scheduler = build(s, [h.blocking(JOB_KINDS.assistantInvoke)], () => 2);
    expect(scheduler.tick()).toBe(2);
    expect(scheduler.runningCount('assistant')).toBe(2);
    expect(scheduler.tick()).toBe(0);
    gates.get('chan:A')!.resolve();
    await flush();
    expect(scheduler.tick()).toBe(1);
    expect(h.started).toEqual(['chan:A', 'chan:B', 'chan:C']);
  });

  it('(c) two invokes on one key run in enqueue order, one at a time', async () => {
    const h = setup(gates);
    gates.set('first', deferred());
    gates.set('second', deferred());
    s.queue(JOB_KINDS.assistantInvoke, 'chan:A', { token: 'first' });
    s.queue(JOB_KINDS.assistantInvoke, 'chan:A', { token: 'second' });
    const scheduler = build(s, [h.blocking(JOB_KINDS.assistantInvoke)], () => 4);
    expect(scheduler.tick()).toBe(1);
    expect(h.started).toEqual(['first']);
    expect(scheduler.tick()).toBe(0);
    gates.get('first')!.resolve();
    await scheduler.idle();
    expect(scheduler.tick()).toBe(1);
    expect(h.started).toEqual(['first', 'second']);
  });

  it('(d) a thread invoke keyed by its parent waits for the parent-channel invoke', () => {
    const h = setup(gates);
    gates.set('parent', deferred());
    gates.set('thread', deferred());
    s.queue(JOB_KINDS.assistantInvoke, 'chan:A', { token: 'parent' });
    const scheduler = build(s, [h.blocking(JOB_KINDS.assistantInvoke)], () => 4);
    expect(scheduler.tick()).toBe(1);
    s.queue(JOB_KINDS.assistantInvoke, 'chan:A', { token: 'thread' });
    expect(scheduler.tick()).toBe(0);
    expect(h.started).toEqual(['parent']);
  });

  it('(e) a summarise on chan:A waits for a running invoke on chan:A', () => {
    const h = setup(gates);
    gates.set('invoke', deferred());
    s.queue(JOB_KINDS.assistantInvoke, 'chan:A', { token: 'invoke' });
    s.queue(JOB_KINDS.assistantSummarise, 'chan:A', { token: 'summary' });
    const scheduler = build(
      s,
      [h.blocking(JOB_KINDS.assistantInvoke), h.immediate(JOB_KINDS.assistantSummarise)],
      () => 4,
    );
    expect(scheduler.tick()).toBe(1);
    expect(h.started).toEqual(['invoke']);
  });

  it('(f) a keyless prune waits for lane empty, and blocks the lane while running', async () => {
    const h = setup(gates);
    gates.set('invoke', deferred());
    gates.set('prune', deferred());
    gates.set('later', deferred());
    s.queue(JOB_KINDS.assistantInvoke, 'chan:A', { token: 'invoke' });
    s.queue(JOB_KINDS.conversationPrune, null, { token: 'prune' });
    const scheduler = build(
      s,
      [h.blocking(JOB_KINDS.assistantInvoke), h.blocking(JOB_KINDS.conversationPrune)],
      () => 4,
    );
    expect(scheduler.tick()).toBe(1);
    expect(h.started).toEqual(['invoke']);
    gates.get('invoke')!.resolve();
    await scheduler.idle();
    expect(scheduler.tick()).toBe(1);
    expect(h.started).toEqual(['invoke', 'prune']);
    s.queue(JOB_KINDS.assistantInvoke, 'chan:B', { token: 'later' });
    expect(scheduler.tick()).toBe(0);
    expect(h.started).toEqual(['invoke', 'prune']);
    gates.get('prune')!.resolve();
    await scheduler.idle();
    expect(scheduler.tick()).toBe(1);
    expect(h.started).toEqual(['invoke', 'prune', 'later']);
  });

  it('(g) the default lane runs strictly one at a time, in FIFO order', async () => {
    const h = setup(gates);
    gates.set('first', deferred());
    gates.set('second', deferred());
    s.queue(JOB_KINDS.reconcileGuild, null, { token: 'first' });
    s.queue(JOB_KINDS.adoptPanel, null, { token: 'second' });
    const scheduler = build(
      s,
      [h.blocking(JOB_KINDS.reconcileGuild), h.blocking(JOB_KINDS.adoptPanel)],
      () => 4,
    );
    expect(scheduler.tick()).toBe(1);
    expect(h.started).toEqual(['first']);
    expect(scheduler.tick()).toBe(0);
    gates.get('first')!.resolve();
    await scheduler.idle();
    expect(scheduler.tick()).toBe(1);
    expect(h.started).toEqual(['first', 'second']);
  });

  it('(h) a throwing handler fails via the store without breaking the scheduler', async () => {
    const h = setup(gates);
    s.queue(JOB_KINDS.assistantInvoke, 'chan:A', { token: 'bad', boom: true });
    s.queue(JOB_KINDS.assistantInvoke, 'chan:B', { token: 'good' });
    const { logger, lines } = capturingLogger();
    const scheduler = build(s, [h.immediate(JOB_KINDS.assistantInvoke)], () => 4, logger);
    expect(scheduler.tick()).toBe(2);
    await scheduler.idle();
    expect(s.failures.map((f) => f.jobId)).toEqual([1]);
    expect(lines.join('')).toContain('job failed');
    s.queue(JOB_KINDS.assistantInvoke, 'chan:C', { token: 'next' });
    // The failed job is back in the queue (attempts remain), so the next tick
    // retries it and starts the new job too.
    expect(scheduler.tick()).toBe(2);
    expect(h.started).toContain('next');
  });

  it('(i) the concurrency function is re-read every tick', () => {
    const h = setup(gates);
    for (const key of ['chan:A', 'chan:B']) gates.set(key, deferred());
    s.queue(JOB_KINDS.assistantInvoke, 'chan:A', { token: 'chan:A' });
    s.queue(JOB_KINDS.assistantInvoke, 'chan:B', { token: 'chan:B' });
    let limit = 1;
    const scheduler = build(s, [h.blocking(JOB_KINDS.assistantInvoke)], () => limit);
    expect(scheduler.tick()).toBe(1);
    limit = 2;
    expect(scheduler.tick()).toBe(1);
    expect(scheduler.runningCount('assistant')).toBe(2);
  });

  it('(j) idle resolves only after every started job settles', async () => {
    const h = setup(gates);
    gates.set('one', deferred());
    s.queue(JOB_KINDS.assistantInvoke, 'chan:A', { token: 'one' });
    const scheduler = build(s, [h.blocking(JOB_KINDS.assistantInvoke)], () => 4);
    scheduler.tick();
    let idled = false;
    const waiting = scheduler.idle().then(() => {
      idled = true;
    });
    await flush();
    expect(idled).toBe(false);
    gates.get('one')!.resolve();
    await waiting;
    expect(idled).toBe(true);
  });

  it('treats concurrency below 1 as 1', () => {
    const h = setup(gates);
    gates.set('one', deferred());
    s.queue(JOB_KINDS.assistantInvoke, 'chan:A', { token: 'one' });
    const scheduler = build(s, [h.blocking(JOB_KINDS.assistantInvoke)], () => 0);
    expect(scheduler.tick()).toBe(1);
  });
});
