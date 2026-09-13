import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import {
  archiveExpiryDedupeKey,
  archiveExpiryHandler,
  JOB_KINDS,
  parseGuildId,
} from '@bananasaurs/core';
import {
  archiveRepo,
  guildRepo,
  jobRepo,
  read,
  schema,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import {
  ARCHIVE_EXPIRY_INTERVAL_MS,
  createArchiveExpiryTimer,
  type ArchiveExpiryTimerDeps,
} from './archive-expiry-timer.js';

/**
 * The daily archive-expiry timer and the expiry job's end-to-end proof
 * (Slice M1 Task 5, Step 2).
 *
 * The timer asserts through the real `jobRepo` on a test database: two
 * `runOnce` calls on the same UTC day enqueue one job per guild (the
 * `jobs_dedupe` partial unique index refuses the second), and the next day
 * enqueues again. The handler's 30-day boundary is exercised here too —
 * `archiveExpiryHandler` wired to the real `archiveRepo`, frozen clocks at
 * day 29 / 30 / 31 after a deletion purging 0 / 1 / 1 — because
 * `packages/core` may not import `@bananasaurs/storage` (ADR 0014,
 * eslint-enforced), so `packages/core/src/archive/expiry.test.ts` proves
 * only the handler's delegation with faked ports.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL = '333333333333333333';
const MEMBER = '444444444444444444';
const MESSAGE = '555555555555555555';

const DAY_MS = 24 * 60 * 60 * 1000;
const DELETED_AT = 1_700_000_000_000;

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let a: GuildScope;
let b: GuildScope;
let nowMs: number;

const depsFor = (): ArchiveExpiryTimerDeps => ({
  guilds: () => [{ scope: a }, { scope: b }],
  enqueue: (scope, input) => jobRepo.enqueue(scope, input),
  now: () => nowMs,
  logger,
});

const jobsFor = (scope: GuildScope) => jobRepo.listJobs(scope, {});

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

describe('archive expiry timer', () => {
  it('runOnce enqueues one job per guild carrying the UTC day', () => {
    createArchiveExpiryTimer(depsFor()).runOnce();

    for (const scope of [a, b]) {
      const jobs = jobsFor(scope);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.kind).toBe(JOB_KINDS.archiveExpiry);
      expect(jobs[0]?.payload).toBe(JSON.stringify({ day: '2026-09-13' }));
      expect(jobs[0]?.dedupeKey).toBe(archiveExpiryDedupeKey('2026-09-13'));
    }
  });

  it('a second runOnce on the same day enqueues nothing; the next day enqueues again', () => {
    const timer = createArchiveExpiryTimer(depsFor());

    timer.runOnce();
    timer.runOnce();

    expect(jobsFor(a)).toHaveLength(1);
    expect(jobsFor(b)).toHaveLength(1);

    nowMs += DAY_MS;
    timer.runOnce();

    for (const scope of [a, b]) {
      const jobs = jobsFor(scope);
      expect(jobs).toHaveLength(2);
      // `listJobs` is newest-first: index 0 is the next day's job.
      expect(jobs[0]?.payload).toBe(JSON.stringify({ day: '2026-09-14' }));
      expect(jobs[0]?.dedupeKey).toBe(archiveExpiryDedupeKey('2026-09-14'));
      expect(jobs[1]?.payload).toBe(JSON.stringify({ day: '2026-09-13' }));
    }
  });

  it('start() runs once immediately then every 24h; stop() cancels the interval', () => {
    vi.useFakeTimers();
    const timer = createArchiveExpiryTimer(depsFor());

    timer.start();
    expect(jobsFor(a)).toHaveLength(1);

    nowMs += DAY_MS;
    vi.advanceTimersByTime(ARCHIVE_EXPIRY_INTERVAL_MS);
    expect(jobsFor(a)).toHaveLength(2);

    timer.stop();
    nowMs += DAY_MS;
    vi.advanceTimersByTime(2 * ARCHIVE_EXPIRY_INTERVAL_MS);
    expect(jobsFor(a)).toHaveLength(2);
  });
});

describe('archive expiry handler against the real repository', () => {
  const seedDeletedMessage = (scope: GuildScope): void => {
    archiveRepo.enableChannel(scope, { channelId: CHANNEL, attachmentPolicy: 'none', now: 1000 });
    archiveRepo.upsertMessage(scope, {
      messageId: MESSAGE,
      channelId: CHANNEL,
      authorId: MEMBER,
      content: 'doomed',
      createdAt: 2000,
      editedAt: undefined,
      attachments: [],
    });
    expect(archiveRepo.recordDelete(scope, { messageId: MESSAGE, deletedAt: DELETED_AT })).toBe(
      'recorded',
    );
  };

  const readContent = (scope: GuildScope): string | null | undefined =>
    read(scope, (db) =>
      db
        .select({ content: schema.archiveMessages.content })
        .from(schema.archiveMessages)
        .where(scope.only(schema.archiveMessages))
        .get(),
    )?.content;

  const runExpiryAt = (scope: GuildScope, at: number): number => {
    let purged = -1;
    const handler = archiveExpiryHandler({
      expireContent: (now) => {
        purged = archiveRepo.expireContent(scope, now);
        return purged;
      },
      now: () => at,
      logger,
    });
    const day = new Date(at).toISOString().slice(0, 10);
    void handler.run({ day }, { jobId: 1, attempts: 1, cursor: null, saveCursor: () => {} });
    return purged;
  };

  it.each([
    { label: 'day 29', at: DELETED_AT + 29 * DAY_MS, purged: 0, content: 'doomed' },
    { label: 'day 30', at: DELETED_AT + 30 * DAY_MS, purged: 1, content: null },
    { label: 'day 31', at: DELETED_AT + 31 * DAY_MS, purged: 1, content: null },
  ])('$label after deletion purges $purged', ({ at, purged, content }) => {
    seedDeletedMessage(a);

    expect(runExpiryAt(a, at)).toBe(purged);
    expect(readContent(a)).toBe(content);
  });
});
