import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { DiscordApiError, DiscordErrorCode } from '../discord/errors.js';
import type { FetchedMessage, RecentMessagesPage, Snowflake } from '../discord/port.js';
import type { JobContext } from '../jobs/worker.js';
import { archiveBackfillPayload } from '../jobs/kinds.js';
import { archiveBackfillHandler, type ArchiveChannel, type BackfillPorts } from './backfill.js';
import type { UpsertMessageInput } from './ports.js';

/**
 * The backfill job's own tests (Slice M1 Task 5, Step 1).
 *
 * Every port is hand-rolled: a Map-backed store plus an in-memory message
 * source modelled on `FakeDiscord`'s `fetchRecentMessages` (newest-first,
 * `nextBefore` only on a full page) — `packages/core` cannot depend on
 * `@bananasaurs/testkit` (it depends on `core`, so the reverse would cycle;
 * see `mod/purge.test.ts`'s `FakeChannel`), so this is hand-rolled rather
 * than imported. The restart-resume proof constructs a genuinely new handler
 * over the same store, the way a restarted process would.
 */

const CHANNEL: Snowflake = '333333333333333333';
const NOW = 1_700_000_000_000;

/** 18-digit base, so every seeded id is a well-formed snowflake. */
const ID_BASE = 700_000_000_000_000_000n;
const idAt = (index: number): string => (ID_BASE + BigInt(index)).toString();

interface SourceMessage {
  messageId: string;
  authorId: string | undefined;
  createdAtMs: number;
  content: string | undefined;
  editedTimestampMs: number | undefined;
  attachments: FetchedMessage['attachments'];
}

/** In-memory channel, newest-first, cursor on full pages only. */
class FakeMessageSource {
  readonly messages = new Map<string, SourceMessage & { channelId: string }>();
  readonly calls: { channelId: string; before: string | undefined }[] = [];
  failure: DiscordApiError | undefined = undefined;

  seed(channelId: string, count: number, startIndex = 0): void {
    for (let i = 0; i < count; i += 1) {
      const messageId = idAt(startIndex + i);
      this.messages.set(messageId, {
        channelId,
        messageId,
        authorId: '222222222222222222',
        createdAtMs: NOW - (count - i) * 1000,
        content: `message ${startIndex + i}`,
        editedTimestampMs: undefined,
        attachments: [],
      });
    }
  }

  async fetch(channelId: string, before: string | undefined): Promise<RecentMessagesPage> {
    this.calls.push({ channelId, before });
    if (this.failure !== undefined) {
      const error = this.failure;
      this.failure = undefined;
      throw error;
    }
    const limit = 100;
    const all = [...this.messages.values()]
      .filter((m) => m.channelId === channelId)
      .filter((m) => before === undefined || BigInt(m.messageId) < BigInt(before))
      .sort((a, b) => (BigInt(b.messageId) > BigInt(a.messageId) ? 1 : -1))
      .slice(0, limit)
      .map((m): FetchedMessage => ({
        messageId: m.messageId,
        authorId: m.authorId,
        createdAtMs: m.createdAtMs,
        content: m.content,
        editedTimestampMs: m.editedTimestampMs,
        attachments: m.attachments,
      }));
    const last = all.length > 0 ? all[all.length - 1] : undefined;
    return {
      messages: all,
      nextBefore: all.length === limit && last !== undefined ? last.messageId : undefined,
    };
  }
}

interface Harness {
  ports: BackfillPorts;
  source: FakeMessageSource;
  rows: Map<string, UpsertMessageInput>;
  continuations: {
    channelId: string;
    threadWalk?: { threadIds: readonly string[]; index: number; before: string | undefined };
    jobId: number;
    runAfter: number;
  }[];
  channel: {
    live: boolean;
    cursorMessageId: string | undefined;
    state: ArchiveChannel['backfillState'];
  };
  context: JobContext;
}

const harness = (): Harness => {
  const source = new FakeMessageSource();
  const rows = new Map<string, UpsertMessageInput>();
  const continuations: {
    channelId: string;
    threadWalk?: { threadIds: readonly string[]; index: number; before: string | undefined };
    jobId: number;
    runAfter: number;
  }[] = [];
  const channel = {
    live: true,
    cursorMessageId: undefined as string | undefined,
    state: 'pending' as ArchiveChannel['backfillState'],
  };
  const ports: BackfillPorts = {
    guildArchiveEnabled: true,
    isChannelExcluded: () => false,
    fetchRecentMessages: (channelId, before) => source.fetch(channelId, before),
    listThreads: async () => [],
    isForum: () => false,
    hasCategoryRow: () => false,
    categoryOf: () => undefined,
    setThreadProgress: () => {},
    findChannel: (channelId) =>
      channel.live && channelId === CHANNEL
        ? {
            channelId,
            scopeKind: 'channel' as const,
            derivedFrom: undefined,
            cursorMessageId: channel.cursorMessageId,
            backfillState: channel.state,
            collecting: true,
          }
        : undefined,
    upsertMessage: (input) => {
      if (rows.has(input.messageId)) return false;
      rows.set(input.messageId, input);
      return true;
    },
    setBackfillCursor: (input) => {
      channel.cursorMessageId = input.cursorMessageId;
      channel.state = input.state;
    },
    enqueueContinuation: (input) => {
      continuations.push(input);
    },
    now: () => NOW,
    logger: pino({ level: 'silent' }),
  };
  const context: JobContext = {
    jobId: 1,
    attempts: 1,
    cursor: null,
    saveCursor: () => {},
  };
  return { ports, source, rows, continuations, channel, context };
};

const rateLimited = (): DiscordApiError =>
  new DiscordApiError(429, DiscordErrorCode.RateLimited, 'You are being rate limited.', {
    retryAfter: 1.5,
  });

describe('archive backfill paging', () => {
  it('backfills public threads under the channel and records the parent beside thread ids', async () => {
    const h = harness();
    h.source.seed(CHANNEL, 1);
    h.source.seed('777777777777777777', 2, 100);
    h.source.seed('888888888888888888', 1, 200);
    h.ports.listThreads = async () => [
      { id: '777777777777777777', isPrivate: false },
      { id: '888888888888888888', isPrivate: false },
      { id: '999999999999999999', isPrivate: true },
    ];
    const handler = archiveBackfillHandler(h.ports);
    // Tick 1: the channel's own page, then the walk is queued (M2). The
    // private thread never reaches the walk: listThreads' filter drops it.
    await handler.run(archiveBackfillPayload.parse({ channelId: CHANNEL }), h.context);
    expect(h.continuations).toHaveLength(1);
    // Ticks 2 and 3: one thread per tick.
    await handler.run(
      archiveBackfillPayload.parse({
        channelId: CHANNEL,
        threadWalk: h.continuations[0]?.threadWalk,
      }),
      h.context,
    );
    await handler.run(
      archiveBackfillPayload.parse({
        channelId: CHANNEL,
        threadWalk: h.continuations[1]?.threadWalk,
      }),
      h.context,
    );
    expect(
      [...h.rows.values()].filter((row) => row.threadId !== undefined).map((row) => row.threadId),
    ).toEqual(['777777777777777777', '777777777777777777', '888888888888888888']);
    expect(h.source.calls).not.toContainEqual(
      expect.objectContaining({ channelId: '999999999999999999' }),
    );
  });

  it('a forum skips parent history and backfills only its public posts', async () => {
    const h = harness();
    h.source.seed(CHANNEL, 1);
    h.source.seed('777777777777777777', 1, 100);
    h.ports.isForum = () => true;
    h.ports.listThreads = async () => [{ id: '777777777777777777', isPrivate: false }];
    const handler = archiveBackfillHandler(h.ports);
    await handler.run(archiveBackfillPayload.parse({ channelId: CHANNEL }), h.context);
    await handler.run(
      archiveBackfillPayload.parse({
        channelId: CHANNEL,
        threadWalk: h.continuations[0]?.threadWalk,
      }),
      h.context,
    );
    expect(h.source.calls).not.toContainEqual(expect.objectContaining({ channelId: CHANNEL }));
    expect([...h.rows.values()]).toEqual([
      expect.objectContaining({ channelId: CHANNEL, threadId: '777777777777777777' }),
    ]);
  });
  it('three runs land 250 rows; the cursor after run 1 is the 100th id; done after run 3', async () => {
    const h = harness();
    h.source.seed(CHANNEL, 250);
    const handler = archiveBackfillHandler(h.ports);

    await handler.run(archiveBackfillPayload.parse({ channelId: CHANNEL }), h.context);
    expect(h.rows.size).toBe(100);
    // Page 1 holds the newest 100; the cursor is its oldest — the 100th id.
    expect(h.channel.cursorMessageId).toBe(idAt(150));
    expect(h.channel.state).toBe('running');
    expect(h.continuations).toHaveLength(1);
    expect(h.continuations[0]).toEqual({ channelId: CHANNEL, jobId: 1, runAfter: NOW });

    await handler.run(archiveBackfillPayload.parse({ channelId: CHANNEL }), h.context);
    expect(h.rows.size).toBe(200);
    expect(h.channel.cursorMessageId).toBe(idAt(50));
    expect(h.channel.state).toBe('running');
    expect(h.continuations).toHaveLength(2);

    await handler.run(archiveBackfillPayload.parse({ channelId: CHANNEL }), h.context);
    expect(h.rows.size).toBe(250);
    expect(h.channel.cursorMessageId).toBeUndefined();
    expect(h.channel.state).toBe('done');
    // The last page is short, so no continuation follows it.
    expect(h.continuations).toHaveLength(2);
  });

  it('a restart resumes from the persisted cursor and never re-fetches page 1', async () => {
    const h = harness();
    h.source.seed(CHANNEL, 250);

    await archiveBackfillHandler(h.ports).run(
      archiveBackfillPayload.parse({ channelId: CHANNEL }),
      h.context,
    );
    const cursor = h.channel.cursorMessageId;
    expect(cursor).toBe(idAt(150));

    // A new handler over the same store: what a restarted process builds.
    await archiveBackfillHandler(h.ports).run(
      archiveBackfillPayload.parse({ channelId: CHANNEL }),
      h.context,
    );

    expect(h.source.calls).toHaveLength(2);
    expect(h.source.calls[0]?.before).toBeUndefined();
    expect(h.source.calls[1]?.before).toBe(cursor);
    expect(h.rows.size).toBe(200);
  });

  it('a rate limit on run 2 propagates and leaves the cursor at run 1’s value', async () => {
    const h = harness();
    h.source.seed(CHANNEL, 250);
    const handler = archiveBackfillHandler(h.ports);

    await handler.run(archiveBackfillPayload.parse({ channelId: CHANNEL }), h.context);
    const cursor = h.channel.cursorMessageId;

    h.source.failure = rateLimited();
    const error = await Promise.resolve(
      handler.run(archiveBackfillPayload.parse({ channelId: CHANNEL }), h.context),
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DiscordApiError);
    expect((error as DiscordApiError).isRateLimit).toBe(true);

    expect(h.channel.cursorMessageId).toBe(cursor);
    expect(h.channel.state).toBe('running');
    expect(h.rows.size).toBe(100);
    expect(h.continuations).toHaveLength(1);
  });

  it('a paused own row stops the job, as "no longer enabled" does today', async () => {
    const h = harness();
    h.source.seed(CHANNEL, 250);
    // ADR 0126: `collecting = 0` keeps the row; the job must stop like the
    // row were gone — no fetch, no writes, no continuation.
    const original = h.ports.findChannel.bind(h.ports);
    h.ports.findChannel = (channelId) => {
      const row = original(channelId);
      if (row === undefined) return undefined;
      return { ...row, collecting: false };
    };

    await archiveBackfillHandler(h.ports).run(
      archiveBackfillPayload.parse({ channelId: CHANNEL }),
      h.context,
    );

    expect(h.source.calls).toHaveLength(0);
    expect(h.rows.size).toBe(0);
    expect(h.continuations).toHaveLength(0);
  });

  it('a channel whose category is excluded stops, even when the channel itself is not', async () => {
    const h = harness();
    h.source.seed(CHANNEL, 250);
    const CATEGORY = '999999999999999999';
    h.ports.categoryOf = () => CATEGORY;
    // Only the category is excluded — the own id is clean. Full No-access
    // precedence (ADR 0126) still stops the job.
    h.ports.isChannelExcluded = (id) => id === CATEGORY;

    await archiveBackfillHandler(h.ports).run(
      archiveBackfillPayload.parse({ channelId: CHANNEL }),
      h.context,
    );

    expect(h.source.calls).toHaveLength(0);
    expect(h.rows.size).toBe(0);
    expect(h.continuations).toHaveLength(0);
  });

  it('a channel disabled mid-backfill ends the job with no fetch and no writes', async () => {
    const h = harness();
    h.source.seed(CHANNEL, 250);
    h.channel.live = false;

    await archiveBackfillHandler(h.ports).run(
      archiveBackfillPayload.parse({ channelId: CHANNEL }),
      h.context,
    );

    expect(h.source.calls).toHaveLength(0);
    expect(h.rows.size).toBe(0);
    expect(h.continuations).toHaveLength(0);
  });

  it('a guild removed from the allowlist mid-backfill ends the job with no fetch and no writes', async () => {
    const h = harness();
    h.source.seed(CHANNEL, 250);
    (h.ports as { guildArchiveEnabled: boolean }).guildArchiveEnabled = false;

    await archiveBackfillHandler(h.ports).run(
      archiveBackfillPayload.parse({ channelId: CHANNEL }),
      h.context,
    );

    expect(h.source.calls).toHaveLength(0);
    expect(h.rows.size).toBe(0);
    expect(h.continuations).toHaveLength(0);
    expect(h.channel.state).toBe('pending');
  });

  it('a guild still listed backfills normally (the veto passing, not just absent)', async () => {
    const h = harness();
    h.source.seed(CHANNEL, 10);

    await archiveBackfillHandler(h.ports).run(
      archiveBackfillPayload.parse({ channelId: CHANNEL }),
      h.context,
    );

    expect(h.source.calls).toHaveLength(1);
    expect(h.rows.size).toBe(10);
  });

  it('an excluded channel ends the job with no fetch and no writes', async () => {
    const h = harness();
    h.source.seed(CHANNEL, 250);
    h.ports.isChannelExcluded = () => true;

    await archiveBackfillHandler(h.ports).run(
      archiveBackfillPayload.parse({ channelId: CHANNEL }),
      h.context,
    );

    expect(h.source.calls).toHaveLength(0);
    expect(h.rows.size).toBe(0);
    expect(h.continuations).toHaveLength(0);
    expect(h.channel.state).toBe('pending');
  });

  it('a non-excluded channel backfills normally (the veto passing, not just absent)', async () => {
    const h = harness();
    h.source.seed(CHANNEL, 10);
    h.ports.isChannelExcluded = () => false;

    await archiveBackfillHandler(h.ports).run(
      archiveBackfillPayload.parse({ channelId: CHANNEL }),
      h.context,
    );

    expect(h.source.calls).toHaveLength(1);
    expect(h.rows.size).toBe(10);
  });

  it('an excluded thread is skipped in the thread walk: never fetched, never stored', async () => {
    const h = harness();
    h.source.seed(CHANNEL, 1);
    h.source.seed('777777777777777777', 2, 100);
    h.source.seed('888888888888888888', 1, 200);
    h.ports.listThreads = async () => [
      { id: '777777777777777777', isPrivate: false },
      { id: '888888888888888888', isPrivate: false },
    ];
    // Only the first thread is excluded on its own id — the channel and the
    // sibling thread stay covered, so the walk must skip one and keep the
    // other rather than stopping.
    h.ports.isChannelExcluded = (id) => id === '777777777777777777';
    const handler = archiveBackfillHandler(h.ports);
    await handler.run(archiveBackfillPayload.parse({ channelId: CHANNEL }), h.context);
    await handler.run(
      archiveBackfillPayload.parse({
        channelId: CHANNEL,
        threadWalk: h.continuations[0]?.threadWalk,
      }),
      h.context,
    );
    await handler.run(
      archiveBackfillPayload.parse({
        channelId: CHANNEL,
        threadWalk: h.continuations[1]?.threadWalk,
      }),
      h.context,
    );
    expect(h.source.calls).not.toContainEqual(
      expect.objectContaining({ channelId: '777777777777777777' }),
    );
    expect(
      [...h.rows.values()].filter((row) => row.threadId !== undefined).map((row) => row.threadId),
    ).toEqual(['888888888888888888']);
    expect(h.channel.state).toBe('done');
  });

  it('maps edits and attachments, skipping an attachment without an id', async () => {
    const h = harness();
    h.source.seed(CHANNEL, 1);
    const only = h.source.messages.get(idAt(0));
    if (only === undefined) throw new Error('seeded message missing');
    only.editedTimestampMs = NOW + 5000;
    only.attachments = [
      {
        attachmentId: '666666666666666666',
        fileName: 'pic.png',
        contentType: 'image/png',
        sizeBytes: 1234,
      },
      // No attachment id: skipped, the subscriber's rule.
      { fileName: 'ghost.png', contentType: undefined, sizeBytes: 10 },
    ];

    await archiveBackfillHandler(h.ports).run(
      archiveBackfillPayload.parse({ channelId: CHANNEL }),
      h.context,
    );

    expect(h.rows.size).toBe(1);
    expect(h.rows.get(idAt(0))).toEqual({
      messageId: idAt(0),
      channelId: CHANNEL,
      authorId: '222222222222222222',
      content: 'message 0',
      createdAt: only.createdAtMs,
      editedAt: NOW + 5000,
      attachments: [
        {
          attachmentId: '666666666666666666',
          filename: 'pic.png',
          contentType: 'image/png',
          size: 1234,
        },
      ],
    });
  });
});
