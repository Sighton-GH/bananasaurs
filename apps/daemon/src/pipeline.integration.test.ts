import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  createConnectionSubscriber,
  JobWorker,
  JOB_KINDS,
  parseGuildId,
  Pipeline,
  reconcileDedupeKey,
  sweepDedupeKey,
  type DomainEvent,
  type Subscriber,
} from '@bananasaurs/core';
import {
  guildRepo,
  jobRepo,
  jobStoreFor,
  pipelineRepo,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { sweepEventDedupeHandler } from './jobs/handlers.js';

/**
 * Slice 4's demonstrable, end to end through the real database.
 *
 * The unit tests use in-memory fakes for the dedupe store and the job store,
 * which is the right shape for testing behaviour — but a fake agreeing with
 * itself proves nothing about the SQL. This wires `core`'s pipeline and worker
 * to the real repositories and asserts the three outcomes `docs/19` names for
 * this slice: a duplicate event produces one effect, a fresh reconnect writes a
 * gap and enqueues reconciliation, and the dedupe table is bounded.
 *
 * It lives in `apps/daemon` because the composition root is the only package
 * allowed to know both `core` and `storage` (ADR 0014).
 */

const GUILD = parseGuildId('111111111111111111');
const logger = pino({ level: 'silent' });
const RETENTION_MS = 86_400_000;

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let delivered: DomainEvent[];
let pipeline: Pipeline;

const recordingSubscriber = (): Subscriber => ({
  name: 'recorder',
  handle(event) {
    delivered.push(event);
  },
});

const interaction = (interactionId: string, guildId = GUILD): DomainEvent => ({
  kind: 'interaction',
  guildId,
  receivedAtMs: 1_700_000_000_000,
  interactionId,
  token: `tok-${interactionId}`,
  channelId: '222222222222222222',
  messageId: '333333333333333333',
  userId: '444444444444444444',
  customId: 'panel:opt',
});

const connection = (resumed: boolean, atMs = 1_700_000_060_000): DomainEvent => ({
  kind: 'connection',
  guildId: GUILD,
  receivedAtMs: atMs,
  resumed,
  disconnectedAtMs: 1_700_000_000_000,
});

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });
  delivered = [];

  pipeline = new Pipeline({
    allowlist: new Set([GUILD]),
    dedupe: {
      firstSight: ({ eventKind, fingerprint, atMs }) =>
        pipelineRepo.recordFirstSight(scope, { eventKind, fingerprint, atMs }),
    },
    subscribers: [
      recordingSubscriber(),
      createConnectionSubscriber(
        {
          recordGap: (input) => pipelineRepo.recordGap(scope, input),
          enqueueReconcile: ({ dedupeKey, payload }) =>
            jobRepo.enqueue(scope, {
              kind: JOB_KINDS.reconcileGuild,
              payload,
              dedupeKey,
              now: 1_700_000_060_000,
            }),
        },
        logger,
      ),
    ],
    leaveGuild: () => Promise.resolve(),
    logger,
  });
});

afterEach(() => {
  t.close();
});

describe('a duplicate event produces one effect', () => {
  it('delivers the first dispatch and drops the replay', async () => {
    // Gateway events replay on reconnect. This is what makes that harmless.
    await pipeline.dispatch(interaction('900000000000000001'));
    const replay = await pipeline.dispatch(interaction('900000000000000001'));

    expect(delivered).toHaveLength(1);
    expect(replay).toEqual({ status: 'dropped', reason: 'duplicate' });
  });

  it('persists the fingerprint, so the replay is dropped after a restart too', async () => {
    await pipeline.dispatch(interaction('900000000000000001'));

    // A fresh Pipeline over the same database is what a restart looks like.
    const afterRestart = new Pipeline({
      allowlist: new Set([GUILD]),
      dedupe: {
        firstSight: ({ eventKind, fingerprint, atMs }) =>
          pipelineRepo.recordFirstSight(scope, { eventKind, fingerprint, atMs }),
      },
      subscribers: [recordingSubscriber()],
      leaveGuild: () => Promise.resolve(),
      logger,
    });

    expect(await afterRestart.dispatch(interaction('900000000000000001'))).toEqual({
      status: 'dropped',
      reason: 'duplicate',
    });
  });
});

describe('a fresh reconnect writes a gap and enqueues reconciliation', () => {
  it('records the gap', async () => {
    await pipeline.dispatch(connection(false));

    const gaps = pipelineRepo.unreconciledGaps(scope);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.resumed).toBe(0);
  });

  it('queues a reconciliation pass', async () => {
    await pipeline.dispatch(connection(false));
    expect(jobRepo.countByState(scope)).toEqual({ queued: 1 });
  });

  it('records the gap but queues nothing when the session resumed', async () => {
    // A resume replays the window, so there is nothing to repair — but the gap
    // is still recorded, because claiming the period was quiet would be a lie.
    await pipeline.dispatch(connection(true));

    expect(pipelineRepo.unreconciledGaps(scope)).toHaveLength(1);
    expect(jobRepo.countByState(scope)).toEqual({});
  });

  it('queues one pass for a flapping connection, not one per reconnect', async () => {
    // Without the dedupe key, an unstable link queues a reconciliation every
    // few seconds and the worker spends the whole outage repeating a pass
    // whose inputs have not changed.
    await pipeline.dispatch(connection(false, 1_700_000_060_000));
    await pipeline.dispatch(connection(false, 1_700_000_070_000));
    await pipeline.dispatch(connection(false, 1_700_000_080_000));

    expect(jobRepo.countByState(scope)).toEqual({ queued: 1 });
    // Every gap is still recorded, though — three outages happened.
    expect(pipelineRepo.unreconciledGaps(scope)).toHaveLength(3);
  });

  it('uses the dedupe key core defines, not one invented here', () => {
    expect(reconcileDedupeKey('gateway-gap')).toBe(`${JOB_KINDS.reconcileGuild}:gateway-gap`);
  });
});

describe('the dedupe table is bounded rather than growing forever', () => {
  it('is swept by the worker, through the real job table', async () => {
    // One row per non-reaction event, forever, is a slow leak that only shows
    // up months later. The sweep is a job like any other, so it retries and is
    // visible in `doctor` alongside everything else.
    for (let i = 1; i <= 5; i += 1) {
      await pipeline.dispatch({
        ...interaction(`90000000000000000${i}`),
        receivedAtMs: 1_000,
      });
    }
    await pipeline.dispatch({ ...interaction('900000000000000009'), receivedAtMs: 9_000_000 });
    expect(pipelineRepo.countEventDedupe(scope)).toBe(6);

    const now = 9_000_000 + RETENTION_MS;
    jobRepo.enqueue(scope, {
      kind: JOB_KINDS.sweepEventDedupe,
      payload: JSON.stringify({ olderThanMs: now - RETENTION_MS }),
      dedupeKey: sweepDedupeKey('2026-10-04'),
      now,
    });

    const worker = new JobWorker({
      store: jobStoreFor(scope),
      handlers: [sweepEventDedupeHandler(scope, logger)],
      logger,
      now: () => now,
    });

    expect(await worker.drain()).toBe(1);
    expect(pipelineRepo.countEventDedupe(scope)).toBe(1);
    expect(jobRepo.countByState(scope)).toEqual({ done: 1 });
  });

  it('fails the job visibly when the payload is malformed', async () => {
    // Rather than sweeping nothing and reporting success, which is how a
    // retention bug hides for a year.
    const now = 5_000;
    jobRepo.enqueue(scope, {
      kind: JOB_KINDS.sweepEventDedupe,
      payload: '{"olderThanMs":"yesterday"}',
      dedupeKey: sweepDedupeKey('2026-10-04'),
      now,
    });

    const worker = new JobWorker({
      store: jobStoreFor(scope),
      handlers: [sweepEventDedupeHandler(scope, logger)],
      logger,
      now: () => now,
    });

    await worker.drain();
    expect(jobRepo.countByState(scope)).toEqual({ failed: 1 });
  });
});
