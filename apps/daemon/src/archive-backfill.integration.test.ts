import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  archiveBackfillDedupeKey,
  archiveBackfillHandler,
  JOB_KINDS,
  JobWorker,
  parseGuildId,
  type BackfillPorts,
} from '@bananasaurs/core';
import type { FetchedMessage, RecentMessagesPage } from '@bananasaurs/core';
import {
  archiveRepo,
  guildRepo,
  jobRepo,
  jobStoreFor,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';

/**
 * The backfill continuation through the real `jobRepo` (PR-75).
 *
 * `packages/core/src/archive/backfill.test.ts` drives the handler by hand
 * with `enqueueContinuation` as an array push, so no test there could detect
 * the self-collision this proves: the continuation used to be enqueued under
 * `archiveBackfillDedupeKey(guildId, channelId)` — the exact key the
 * currently-`running` row holds — and `jobs_dedupe`'s partial unique index
 * plus `onConflictDoNothing` silently dropped it, so a channel over 100
 * messages backfilled exactly one page. This lives here, in `apps/daemon`,
 * because `packages/core` may not import `@bananasaurs/storage` (ADR 0014,
 * eslint-enforced) and the proof needs the real queue, not a fake.
 *
 * Ports are wired exactly the way `runtime/guild.ts` wires them: the fetch
 * is faked (Discord is the one thing never real here), everything else —
 * `archiveRepo`, `jobRepo`, the `JobWorker` — is production code on a
 * migrated test database.
 */

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = '333333333333333333';
const NOW = 1_700_000_000_000;

/** 18-digit base, so every seeded id is a well-formed snowflake. */
const ID_BASE = 700_000_000_000_000_000n;
const idAt = (index: number): string => (ID_BASE + BigInt(index)).toString();

/** In-memory channel, newest-first, cursor on full pages only. */
class FakeMessageSource {
  readonly messages = new Map<string, { messageId: string; channelId: string }>();

  seed(channelId: string, count: number, start = 0): void {
    for (let i = start; i < start + count; i += 1) {
      const messageId = idAt(i);
      this.messages.set(messageId, { messageId, channelId });
    }
  }

  async fetch(channelId: string, before: string | undefined): Promise<RecentMessagesPage> {
    const limit = 100;
    const all = [...this.messages.values()]
      .filter((m) => m.channelId === channelId)
      .filter((m) => before === undefined || BigInt(m.messageId) < BigInt(before))
      .sort((a, b) => (BigInt(b.messageId) > BigInt(a.messageId) ? 1 : -1))
      .slice(0, limit)
      .map((m): FetchedMessage => ({
        messageId: m.messageId,
        authorId: '222222222222222222',
        createdAtMs: NOW - 1000,
        content: `message ${m.messageId}`,
        editedTimestampMs: undefined,
        attachments: [],
      }));
    const last = all.length > 0 ? all[all.length - 1] : undefined;
    return {
      messages: all,
      nextBefore: all.length === limit && last !== undefined ? last.messageId : undefined,
    };
  }
}

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let nowMs: number;

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(scope, { name: 'guild', now: 0 });
  nowMs = NOW;
});

afterEach(() => {
  t.close();
});

describe('archive backfill continuation through the real queue', () => {
  it('each tick enqueues its successor under a fresh key until the channel is done', async () => {
    const source = new FakeMessageSource();
    source.seed(CHANNEL, 250);
    archiveRepo.enableChannel(scope, { channelId: CHANNEL, attachmentPolicy: 'none', now: nowMs });

    // Wired exactly like `runtime/guild.ts`: the successor's key is minted
    // from the tick's own `jobId`, never from the channel alone.
    const ports: BackfillPorts = {
      guildArchiveEnabled: true,
      isChannelExcluded: () => false,
      fetchRecentMessages: (channelId, before) => source.fetch(channelId, before),
      listThreads: async () => [],
      isForum: () => false,
      hasCategoryRow: (categoryId) => archiveRepo.hasCategoryRow(scope, categoryId),
      categoryOf: () => undefined,
      setThreadProgress: (input) => archiveRepo.setThreadProgress(scope, input),
      findChannel: (channelId) => archiveRepo.findChannel(scope, channelId),
      upsertMessage: (input) => archiveRepo.upsertMessage(scope, input),
      setBackfillCursor: (input) => archiveRepo.setBackfillCursor(scope, input),
      enqueueContinuation: ({ channelId, threadWalk, jobId, runAfter }) =>
        void jobRepo.enqueue(scope, {
          kind: JOB_KINDS.archiveBackfill,
          payload: JSON.stringify({ channelId, threadWalk }),
          dedupeKey: archiveBackfillDedupeKey(GUILD, channelId, jobId),
          runAfter,
          now: nowMs,
        }),
      now: () => nowMs,
      logger,
    };
    const worker = new JobWorker({
      store: jobStoreFor(scope),
      handlers: [archiveBackfillHandler(ports)],
      logger,
      now: () => nowMs,
    });

    // The first job: the bare per-channel key `archive enable-channel` enqueues.
    const first = jobRepo.enqueue(scope, {
      kind: JOB_KINDS.archiveBackfill,
      payload: JSON.stringify({ channelId: CHANNEL }),
      dedupeKey: archiveBackfillDedupeKey(GUILD, CHANNEL),
      now: nowMs,
    });
    expect(first.enqueued).toBe(true);
    const firstJobId = first.jobId;
    expect(firstJobId).toBeDefined();

    // Tick 1 lands page 1 and queues a *second* row for the same channel —
    // the row the old same-key code silently dropped.
    const tick1 = await worker.runOnce();
    expect(tick1.status).toBe('completed');
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(100);
    let jobs = jobRepo.listJobs(scope, {});
    const second = jobs.find((job) => job.state === 'queued');
    expect(second).toBeDefined();
    expect(second?.kind).toBe(JOB_KINDS.archiveBackfill);
    expect(second?.dedupeKey).toBe(archiveBackfillDedupeKey(GUILD, CHANNEL, firstJobId as number));
    expect(second?.dedupeKey).not.toBe(archiveBackfillDedupeKey(GUILD, CHANNEL));

    // Tick 2 lands page 2 and queues a third row keyed off its own id.
    const secondJobId = second?.jobId;
    expect(secondJobId).toBeDefined();
    const tick2 = await worker.runOnce();
    expect(tick2.status).toBe('completed');
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(200);
    jobs = jobRepo.listJobs(scope, {});
    const third = jobs.find((job) => job.state === 'queued');
    expect(third).toBeDefined();
    expect(third?.dedupeKey).toBe(archiveBackfillDedupeKey(GUILD, CHANNEL, secondJobId as number));

    // Tick 3 lands the short final page: done, no further continuation.
    const tick3 = await worker.runOnce();
    expect(tick3.status).toBe('completed');
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(250);
    expect(archiveRepo.findChannel(scope, CHANNEL)?.backfillState).toBe('done');
    expect(jobRepo.listJobs(scope, {}).filter((job) => job.state === 'queued')).toHaveLength(0);
  });
});

describe('resumable thread walk (M2)', () => {
  const THREAD_A = '555555555555555551';
  const THREAD_B = '555555555555555552';

  it('walks threads one page per tick, persisting progress between ticks', async () => {
    const source = new FakeMessageSource();
    // The channel's own listing is already exhausted: the first tick moves
    // straight to the thread walk.
    archiveRepo.enableChannel(scope, { channelId: CHANNEL, attachmentPolicy: 'none', now: nowMs });
    // Distinct id ranges: the source keys messages by id, so overlapping
    // ranges would silently re-home the low ids to the last channel seeded.
    source.seed(THREAD_A, 150); // two pages
    source.seed(THREAD_B, 50, 1000); // one page
    jobRepo.enqueue(scope, {
      kind: JOB_KINDS.archiveBackfill,
      payload: JSON.stringify({ channelId: CHANNEL }),
      dedupeKey: archiveBackfillDedupeKey(GUILD, CHANNEL),
      now: nowMs,
    });
    const ports: BackfillPorts = {
      guildArchiveEnabled: true,
      isChannelExcluded: () => false,
      fetchRecentMessages: (channelId, before) => source.fetch(channelId, before),
      listThreads: async () => [
        { id: THREAD_A, isPrivate: false },
        { id: THREAD_B, isPrivate: false },
      ],
      isForum: () => false,
      hasCategoryRow: (categoryId) => archiveRepo.hasCategoryRow(scope, categoryId),
      categoryOf: () => undefined,
      setThreadProgress: (input) => archiveRepo.setThreadProgress(scope, input),
      findChannel: (channelId) => archiveRepo.findChannel(scope, channelId),
      upsertMessage: (input) => archiveRepo.upsertMessage(scope, input),
      setBackfillCursor: (input) => archiveRepo.setBackfillCursor(scope, input),
      enqueueContinuation: ({ channelId, threadWalk, jobId, runAfter }) =>
        void jobRepo.enqueue(scope, {
          kind: JOB_KINDS.archiveBackfill,
          payload: JSON.stringify({ channelId, threadWalk }),
          dedupeKey: archiveBackfillDedupeKey(GUILD, channelId, jobId),
          runAfter,
          now: nowMs,
        }),
      now: () => nowMs,
      logger,
    };
    const worker = new JobWorker({
      store: jobStoreFor(scope),
      handlers: [archiveBackfillHandler(ports)],
      logger,
      now: () => nowMs,
    });

    // Tick 1: channel page done, thread walk queued; nothing archived yet.
    expect((await worker.runOnce()).status).toBe('completed');
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(0);
    expect(archiveRepo.findChannel(scope, CHANNEL)?.threadsFound).toBe(2);
    expect(archiveRepo.findChannel(scope, CHANNEL)?.threadsDone).toBe(0);

    // Tick 2: ONE page of thread A — 100 messages, not the whole walk.
    expect((await worker.runOnce()).status).toBe('completed');
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(100);
    expect(archiveRepo.findChannel(scope, CHANNEL)?.threadsDone).toBe(0);

    // Tick 3: thread A's second page — thread A complete, progress persisted.
    expect((await worker.runOnce()).status).toBe('completed');
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(150);
    expect(archiveRepo.findChannel(scope, CHANNEL)?.threadsDone).toBe(1);
    expect(archiveRepo.findChannel(scope, CHANNEL)?.backfillState).not.toBe('done');

    // Tick 4: thread B's only page — the walk is complete.
    expect((await worker.runOnce()).status).toBe('completed');
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(200);
    expect(archiveRepo.findChannel(scope, CHANNEL)?.threadsDone).toBe(2);
    expect(archiveRepo.findChannel(scope, CHANNEL)?.backfillState).toBe('done');
    expect((await worker.runOnce()).status).toBe('idle');
  });
});

describe('category-covered channels (B2, ADR 0047 amendment)', () => {
  const CATEGORY = '444444444444444444';

  /**
   * Ports wired exactly the way `runtime/guild.ts` wires them after the fix:
   * the category lookup and the live category membership come from real
   * sources (the repository, and here a stand-in for the client cache).
   */
  const buildWorker = (categoryOf: (channelId: string) => string | undefined) => {
    const source = new FakeMessageSource();
    const ports: BackfillPorts = {
      guildArchiveEnabled: true,
      isChannelExcluded: () => false,
      fetchRecentMessages: (channelId, before) => source.fetch(channelId, before),
      listThreads: async () => [],
      isForum: () => false,
      hasCategoryRow: (categoryId) => archiveRepo.hasCategoryRow(scope, categoryId),
      categoryOf,
      setThreadProgress: (input) => archiveRepo.setThreadProgress(scope, input),
      findChannel: (channelId) => archiveRepo.findChannel(scope, channelId),
      upsertMessage: (input) => archiveRepo.upsertMessage(scope, input),
      setBackfillCursor: (input) => archiveRepo.setBackfillCursor(scope, input),
      enqueueContinuation: ({ channelId, threadWalk, jobId, runAfter }) =>
        void jobRepo.enqueue(scope, {
          kind: JOB_KINDS.archiveBackfill,
          payload: JSON.stringify({ channelId, threadWalk }),
          dedupeKey: archiveBackfillDedupeKey(GUILD, channelId, jobId),
          runAfter,
          now: nowMs,
        }),
      now: () => nowMs,
      logger,
    };
    const worker = new JobWorker({
      store: jobStoreFor(scope),
      handlers: [archiveBackfillHandler(ports)],
      logger,
      now: () => nowMs,
    });
    return { source, worker };
  };

  const seedCategoryCoverage = (messageCount: number, source: FakeMessageSource): void => {
    archiveRepo.enableChannel(scope, {
      channelId: CATEGORY,
      attachmentPolicy: 'none',
      now: nowMs,
      scopeKind: 'category',
    });
    // What `archive enable-category`'s wiring does for every covered channel.
    archiveRepo.ensureDerivedChannel(scope, {
      channelId: CHANNEL,
      categoryId: CATEGORY,
      attachmentPolicy: 'none',
      now: nowMs,
    });
    source.seed(CHANNEL, messageCount);
    jobRepo.enqueue(scope, {
      kind: JOB_KINDS.archiveBackfill,
      payload: JSON.stringify({ channelId: CHANNEL }),
      dedupeKey: archiveBackfillDedupeKey(GUILD, CHANNEL),
      now: nowMs,
    });
  };

  it('a channel covered by an enabled category actually backfills', async () => {
    const { source, worker } = buildWorker(() => CATEGORY);
    seedCategoryCoverage(250, source);

    for (let i = 0; i < 8; i += 1) {
      const tick = await worker.runOnce();
      if (tick.status === 'idle') break;
      expect(tick.status).toBe('completed');
    }
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(250);
    expect(archiveRepo.findChannel(scope, CHANNEL)?.backfillState).toBe('done');
  });

  it('a channel that left its category before the job ran is not backfilled', async () => {
    // The live cache no longer has the channel under any category.
    const { source, worker } = buildWorker(() => undefined);
    seedCategoryCoverage(250, source);

    const tick = await worker.runOnce();
    expect(tick.status).toBe('completed');
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(0);
    expect(jobRepo.listJobs(scope, {}).filter((job) => job.state === 'queued')).toHaveLength(0);
  });

  it('a channel whose category row was disabled is not backfilled', async () => {
    // Still in some category, but not an enabled one.
    const { source, worker } = buildWorker(() => CATEGORY);
    seedCategoryCoverage(250, source);
    archiveRepo.disableCategory(scope, CATEGORY);
    // delete-category removed the derived row: the job finds nothing.
    const tick = await worker.runOnce();
    expect(tick.status).toBe('completed');
    expect(archiveRepo.countMessages(scope, CHANNEL)).toBe(0);
  });
});
