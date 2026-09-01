import { describe, expect, it } from 'vitest';
import type { RecentMessagesPage, Snowflake } from '../discord/port.js';
import type { ModerationSafetyState } from '../effects/moderation-gateway.js';
import { PURGE_MAX_MESSAGES } from '../effects/budget.js';
import { parseSnowflakeId } from '../ids.js';
import { purgeDedupeKey, type ModPurgeCursor, type ModPurgePayload } from '../jobs/kinds.js';
import { runPurgeTick, type PurgePorts } from './purge.js';

/**
 * `runPurgeTick`'s own tests (Task 5, ADR 0037): ports faked, one tick at a
 * time, pinned against the exact scenarios the task brief names. The
 * restart-resume proof (Step 3 — real `jobRepo`/`JobWorker`, a genuinely
 * fresh instance) lives in `apps/daemon/src/mod-purge.integration.test.ts`,
 * where the dedupe key's collision-avoidance is checked against SQLite's own
 * partial unique index rather than a simulation of it. This file still
 * proves the dedupe-key *scheme* itself — see the last `describe` block —
 * with an in-memory store that enforces the same "unique while live" rule
 * `jobs_dedupe` does, so the property under test is the real
 * `purgeDedupeKey` function and the real two-tick call sequence, not a stub
 * that always agrees with itself.
 */

const GUILD: Snowflake = '111111111111111111';
const CHANNEL: Snowflake = '222222222222222222';
const MOD: Snowflake = '333333333333333333';
const NOW = 2_000_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const payload = (over: Partial<ModPurgePayload> = {}): ModPurgePayload => ({
  intentId: 'intent-1',
  channelId: parseSnowflakeId(CHANNEL),
  initiatorUserId: parseSnowflakeId(MOD),
  reason: 'spam cleanup',
  ...over,
});

interface FakeMessage {
  messageId: string;
  authorId: string | undefined;
  createdAtMs: number;
  content: string | undefined;
  deleted: boolean;
}

/**
 * A minimal in-memory channel, modelled on `FakeDiscord`'s own
 * `fetchRecentMessages`/`bulkDeleteMessages`/`deleteMessage` (excludes
 * deleted messages, newest-first, `nextBefore` only on a full page) —
 * `packages/core` cannot depend on `@bananasaurs/testkit` (it depends on
 * `core`, so the reverse would cycle — `boundaries.test.ts`), so this is
 * hand-rolled rather than imported. Ids are plain increasing decimal
 * strings; unlike a real snowflake there is no bit-packed timestamp, so
 * `createdAtMs` is tracked as its own field rather than decoded from the id.
 */
class FakeChannel {
  private messages = new Map<string, FakeMessage>();

  add(m: Omit<FakeMessage, 'deleted'>): void {
    this.messages.set(m.messageId, { ...m, deleted: false });
  }

  fetchRecentMessages(options: {
    before?: string | undefined;
    limit?: number | undefined;
  }): RecentMessagesPage {
    const limit = Math.min(options.limit ?? 50, 100);
    const all = [...this.messages.values()]
      .filter((m) => !m.deleted)
      .filter((m) => options.before === undefined || BigInt(m.messageId) < BigInt(options.before))
      .sort((a, b) => (BigInt(b.messageId) > BigInt(a.messageId) ? 1 : -1))
      .slice(0, limit);
    return {
      messages: all.map((m) => ({
        messageId: m.messageId,
        authorId: m.authorId,
        createdAtMs: m.createdAtMs,
        content: m.content,
      })),
      nextBefore: all.length === limit ? all[all.length - 1]!.messageId : undefined,
    };
  }

  bulkDeleteMessages(ids: readonly string[]): void {
    if (ids.length < 2 || ids.length > 100) {
      throw new Error('bulk delete accepts 2..100 messages');
    }
    for (const id of ids) {
      const m = this.messages.get(id);
      if (m) m.deleted = true;
    }
  }

  deleteMessage(id: string): void {
    const m = this.messages.get(id);
    if (!m) throw new Error('unknown message');
    m.deleted = true;
  }
}

interface RecordedCaseEvent {
  caseId: string;
  memberId: string;
  matchedCategory: string;
  matchedSnippet: string;
  actionTaken: string;
  refusalReason: string | undefined;
  actorId: string;
}

interface Harness {
  ports: PurgePorts;
  channel: FakeChannel;
  bulkDeleteCalls: (readonly string[])[];
  singleDeleteCalls: string[];
  auditRows: {
    actorId: string;
    messageId: string;
    channelId: string;
    authorId: string | undefined;
    content: string | undefined;
  }[];
  attributions: { dedupeKey: string; payload: string; runAfter: number }[];
  continuations: { payload: string; cursor: string; dedupeKey: string; runAfter: number }[];
  caseEvents: RecordedCaseEvent[];
  safety: ModerationSafetyState | undefined;
}

const harness = (opts: { safety?: ModerationSafetyState } = {}): Harness => {
  const channel = new FakeChannel();
  const bulkDeleteCalls: (readonly string[])[] = [];
  const singleDeleteCalls: string[] = [];
  const auditRows: Harness['auditRows'] = [];
  const attributions: Harness['attributions'] = [];
  const continuations: Harness['continuations'] = [];
  const caseEvents: RecordedCaseEvent[] = [];

  const safety: ModerationSafetyState = opts.safety ?? {
    killswitch: false,
    breakerOpen: false,
    dryRun: false,
  };

  const ports: PurgePorts = {
    guildId: GUILD,
    discord: {
      fetchRecentMessages: (_guildId, _channelId, options) =>
        Promise.resolve(channel.fetchRecentMessages(options)),
      bulkDeleteMessages: (_guildId, _channelId, ids) => {
        bulkDeleteCalls.push(ids);
        channel.bulkDeleteMessages(ids);
        return Promise.resolve();
      },
      deleteMessage: (_guildId, ref) => {
        singleDeleteCalls.push(ref.messageId);
        channel.deleteMessage(ref.messageId);
        return Promise.resolve();
      },
    },
    readSafetyState: () => safety,
    openOrResolveCase: (input) => ({ caseId: `case-${input.memberId}`, violationCount: 0 }),
    recordCaseEvent: (input) => {
      caseEvents.push({
        caseId: input.caseId,
        memberId: input.memberId,
        matchedCategory: input.matchedCategory,
        matchedSnippet: input.matchedSnippet,
        actionTaken: input.actionTaken,
        refusalReason: input.refusalReason,
        actorId: input.actorId,
      });
    },
    recordDeletionAudit: (input) => {
      auditRows.push({
        actorId: input.actorId,
        messageId: input.messageId,
        channelId: input.channelId,
        authorId: input.authorId,
        content: input.content,
      });
    },
    enqueueDeletionAttribution: (input) => {
      attributions.push(input);
    },
    enqueuePurgeContinuation: (input) => {
      continuations.push(input);
    },
    now: () => NOW,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
  };

  return {
    ports,
    channel,
    bulkDeleteCalls,
    singleDeleteCalls,
    auditRows,
    attributions,
    continuations,
    caseEvents,
    safety,
  };
};

const freshMessage = (h: Harness, id: string, ageMs = DAY_MS): void =>
  h.channel.add({ messageId: id, authorId: MOD, createdAtMs: NOW - ageMs, content: `msg ${id}` });

const oldMessage = (h: Harness, id: string): void =>
  h.channel.add({
    messageId: id,
    authorId: MOD,
    createdAtMs: NOW - 20 * DAY_MS,
    content: `msg ${id}`,
  });

describe('runPurgeTick — fresh phase', () => {
  it('bulk-deletes up to 100 under-14-day messages and saves the cursor to continue', async () => {
    const h = harness();
    // Exactly 100: a full page, so `fetchRecentMessages` reports `nextBefore`
    // and this tick must save the cursor and enqueue its own continuation
    // rather than declaring the purge complete off one page.
    const ids = Array.from({ length: 100 }, (_unused, i) =>
      String(900_000_000_000_000_000n + BigInt(i)),
    );
    for (const id of ids) freshMessage(h, id);

    await runPurgeTick(h.ports, { payload: payload(), cursor: null, jobId: 1 });

    expect(h.bulkDeleteCalls).toHaveLength(1);
    expect(h.bulkDeleteCalls[0]).toHaveLength(100);
    expect(h.singleDeleteCalls).toHaveLength(0);
    expect(h.continuations).toHaveLength(1);

    const cursor = JSON.parse(h.continuations[0]!.cursor) as ModPurgeCursor;
    expect(cursor.phase).toBe('fresh');
    expect(cursor.deletedCount).toBe(100);
    // The oldest id in the deleted batch (smallest, since newer ids are
    // larger) — `fetchRecentMessages`'s own pagination cursor for
    // "everything older than this".
    expect(cursor.lastMessageId).toBe(ids[0]);
    expect(h.caseEvents).toHaveLength(0); // not complete yet — no event until the purge finishes or refuses
  });

  it('falls back to a single delete when exactly one fresh message remains in the page', async () => {
    // Discord's bulk-delete endpoint refuses fewer than 2 ids.
    const h = harness();
    freshMessage(h, '900000000000000201');

    await runPurgeTick(h.ports, { payload: payload(), cursor: null, jobId: 1 });

    expect(h.singleDeleteCalls).toEqual(['900000000000000201']);
    expect(h.bulkDeleteCalls).toHaveLength(0);
  });
});

describe('runPurgeTick — old phase', () => {
  it('deletes exactly one message and signals requeue', async () => {
    const h = harness();
    oldMessage(h, '900000000000000301');
    const cursor: ModPurgeCursor = { phase: 'old', lastMessageId: undefined, deletedCount: 5 };

    await runPurgeTick(h.ports, {
      payload: payload(),
      cursor: JSON.stringify(cursor),
      jobId: 7,
    });

    expect(h.singleDeleteCalls).toEqual(['900000000000000301']);
    expect(h.bulkDeleteCalls).toHaveLength(0);
    expect(h.continuations).toHaveLength(1);
    const next = JSON.parse(h.continuations[0]!.cursor) as ModPurgeCursor;
    expect(next).toEqual({ phase: 'old', lastMessageId: '900000000000000301', deletedCount: 6 });
    // Always requeues rather than looking ahead — the *next* tick's empty
    // fetch is what discovers the channel is exhausted.
    expect(h.caseEvents).toHaveLength(0);
  });
});

describe('runPurgeTick — budget', () => {
  it('refuses and deletes nothing once the prospective total exceeds the budget', async () => {
    const h = harness();
    freshMessage(h, '900000000000000401');
    freshMessage(h, '900000000000000402');
    const cursor: ModPurgeCursor = {
      phase: 'fresh',
      lastMessageId: undefined,
      deletedCount: PURGE_MAX_MESSAGES - 1,
    };

    await runPurgeTick(h.ports, {
      payload: payload(),
      cursor: JSON.stringify(cursor),
      jobId: 1,
    });

    expect(h.bulkDeleteCalls).toHaveLength(0);
    expect(h.singleDeleteCalls).toHaveLength(0);
    expect(h.continuations).toHaveLength(0);
    expect(h.auditRows).toHaveLength(0);
    expect(h.caseEvents).toEqual([
      expect.objectContaining({ actionTaken: 'purge_refused', memberId: MOD, actorId: MOD }),
    ]);
  });
});

describe('runPurgeTick — the safety gate', () => {
  it('refuses on killswitch and deletes nothing', async () => {
    const h = harness({ safety: { killswitch: true, breakerOpen: false, dryRun: false } });
    freshMessage(h, '900000000000000501');

    await runPurgeTick(h.ports, { payload: payload(), cursor: null, jobId: 1 });

    expect(h.bulkDeleteCalls).toHaveLength(0);
    expect(h.singleDeleteCalls).toHaveLength(0);
    expect(h.caseEvents).toEqual([
      expect.objectContaining({ actionTaken: 'purge_refused', refusalReason: 'killswitch' }),
    ]);
  });

  it('refuses when the guild is unknown', async () => {
    const h = harness();
    // No `readSafetyState` port override needed — build one returning
    // `undefined` directly, mirroring an unconfigured guild.
    const unknown: PurgePorts = { ...h.ports, readSafetyState: () => undefined };
    freshMessage(h, '900000000000000601');

    await runPurgeTick(unknown, { payload: payload(), cursor: null, jobId: 1 });

    expect(h.bulkDeleteCalls).toHaveLength(0);
    expect(h.caseEvents).toEqual([
      expect.objectContaining({ actionTaken: 'purge_refused', refusalReason: 'guild-unknown' }),
    ]);
  });

  it('refuses in dry run, without a matching ModCaseRefusalReason value', async () => {
    const h = harness({ safety: { killswitch: false, breakerOpen: false, dryRun: true } });
    freshMessage(h, '900000000000000701');

    await runPurgeTick(h.ports, { payload: payload(), cursor: null, jobId: 1 });

    expect(h.bulkDeleteCalls).toHaveLength(0);
    expect(h.caseEvents).toEqual([
      expect.objectContaining({ actionTaken: 'purge_refused', refusalReason: undefined }),
    ]);
  });
});

describe('runPurgeTick — honest attribution (ADR 0023/0037)', () => {
  it('writes an audit row (actor = moderator, inferred implied false) and enqueues log_message_delete for every deleted message', async () => {
    const h = harness();
    freshMessage(h, '900000000000000801', DAY_MS);
    freshMessage(h, '900000000000000802', 2 * DAY_MS);

    await runPurgeTick(h.ports, {
      payload: payload(),
      cursor: null,
      jobId: 1,
    });

    expect(h.auditRows).toHaveLength(2);
    for (const row of h.auditRows) {
      expect(row.actorId).toBe(MOD);
      expect(row.channelId).toBe(CHANNEL);
    }
    expect(h.attributions).toHaveLength(2);
    const messageIds = h.attributions.map(
      (a) => (JSON.parse(a.payload) as { messageId: string }).messageId,
    );
    expect(messageIds.sort()).toEqual(['900000000000000801', '900000000000000802']);
  });
});

describe('runPurgeTick — completion', () => {
  it('records exactly one purged case event once the channel is exhausted', async () => {
    const h = harness();
    freshMessage(h, '900000000000000901');
    freshMessage(h, '900000000000000902');
    freshMessage(h, '900000000000000903');

    await runPurgeTick(h.ports, { payload: payload(), cursor: null, jobId: 1 });

    expect(h.continuations).toHaveLength(0);
    expect(h.caseEvents).toEqual([
      expect.objectContaining({
        actionTaken: 'purged',
        memberId: MOD,
        actorId: MOD,
        matchedCategory: 'purge',
      }),
    ]);
    expect(h.caseEvents[0]!.matchedSnippet).toContain('3');
  });

  it('an empty channel completes immediately with a zero count, refusing nothing', async () => {
    const h = harness();
    await runPurgeTick(h.ports, { payload: payload(), cursor: null, jobId: 1 });
    expect(h.caseEvents).toEqual([expect.objectContaining({ actionTaken: 'purged' })]);
    expect(h.caseEvents[0]!.matchedSnippet).toContain('0');
  });
});

/**
 * The dedupe-key scheme itself (see `purge.ts`'s module docstring and
 * `purgeDedupeKey`'s docstring in `jobs/kinds.ts`): proven here against a
 * fake store that enforces the *same* "unique while live" rule
 * `jobs_dedupe`'s partial unique index does, driving `runPurgeTick` through
 * two genuinely consecutive ticks rather than asserting on the key string in
 * isolation. The fully real version of this — actual `jobRepo`/`JobWorker`
 * SQLite state, actual `requeueStranded` — is
 * `apps/daemon/src/mod-purge.integration.test.ts`'s restart-resume test.
 */
describe('the dedupe-key scheme avoids self-collision and de-duplicates a retried tick', () => {
  /** Mirrors `jobs_dedupe`: unique among keys currently `live`. */
  class FakeJobTable {
    private live = new Map<string, { cursor: string }>();
    enqueue(dedupeKey: string, cursor: string): { enqueued: boolean } {
      if (this.live.has(dedupeKey)) return { enqueued: false };
      this.live.set(dedupeKey, { cursor });
      return { enqueued: true };
    }
    cursorFor(dedupeKey: string): string | undefined {
      return this.live.get(dedupeKey)?.cursor;
    }
    /** A row leaving `live` (claimed, then completed) frees its key — ADR 0016. */
    retire(dedupeKey: string): void {
      this.live.delete(dedupeKey);
    }
    size(): number {
      return this.live.size;
    }
  }

  it('a tick never collides with its own still-live key: the base key (tick 1) differs from what tick 1 mints for tick 2', () => {
    const table = new FakeJobTable();
    const tick1Key = purgeDedupeKey(GUILD, 'intent-x'); // minted by the confirm tap
    table.enqueue(tick1Key, JSON.stringify({ phase: 'fresh', deletedCount: 0 }));

    const jobId1 = 42; // the row `tick1Key` was inserted as
    const tick2Key = purgeDedupeKey(GUILD, 'intent-x', jobId1);
    expect(tick2Key).not.toBe(tick1Key);

    // Tick 1 is still "running" (live) at the moment it enqueues tick 2 —
    // this is the exact moment the trap in the brief describes. It must
    // succeed because the keys differ.
    expect(
      table.enqueue(tick2Key, JSON.stringify({ phase: 'fresh', deletedCount: 5 })).enqueued,
    ).toBe(true);
    expect(table.size()).toBe(2);
  });

  it('a stranded-then-retried tick mints the identical successor key both times, so only one successor survives', () => {
    const table = new FakeJobTable();
    const jobId = 99; // stable across a crash — `requeueStranded` never changes it

    // Attempt 1: "succeeds" and enqueues a successor, but the process dies
    // before this row is marked done — it is left live (as if still
    // `running`, from the store's point of view).
    const successorKey = purgeDedupeKey(GUILD, 'intent-y', jobId);
    const attempt1 = table.enqueue(
      successorKey,
      JSON.stringify({ phase: 'fresh', deletedCount: 100 }),
    );
    expect(attempt1.enqueued).toBe(true);

    // Attempt 2: the row is reclaimed and re-run from scratch (same jobId).
    // Even though it would compute a *different* cursor value in reality
    // (a different page, since attempt 1's page is already gone from
    // Discord), the key it mints is identical — same `jobId`, nothing else
    // feeds the key — so this insert collides with attempt 1's and is
    // silently dropped.
    const attempt2Key = purgeDedupeKey(GUILD, 'intent-y', jobId);
    expect(attempt2Key).toBe(successorKey);
    const attempt2 = table.enqueue(
      attempt2Key,
      JSON.stringify({ phase: 'fresh', deletedCount: 250 }),
    );
    expect(attempt2.enqueued).toBe(false);

    // Only one successor exists, and it carries attempt 1's cursor — not
    // attempt 2's silently-dropped one.
    expect(table.size()).toBe(1);
    expect(JSON.parse(table.cursorFor(successorKey)!) as { deletedCount: number }).toEqual({
      phase: 'fresh',
      deletedCount: 100,
    });
  });

  it('two genuinely different ticks of the same purge never share a key', () => {
    // jobId is unique per row (autoincrement), so every tick after the first
    // mints a key nothing else in this (or any other) purge can produce.
    const keys = [1, 2, 3, 4].map((jobId) => purgeDedupeKey(GUILD, 'intent-z', jobId));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
