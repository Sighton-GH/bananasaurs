import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId, type Reminder } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { guildRepo } from '../index.js';
import {
  cancelReminder,
  claimDueReminders,
  completeReminder,
  failReminder,
  hasDeliverableReminders,
  insertReminder,
  listReminders,
  retryReminder,
} from './assistant.js';

/**
 * The reminder store's state machine against a real database: claiming is
 * atomic and state-guarded, stranded `delivering` rows are re-claimed only
 * past the stale threshold, and every transition refuses the wrong starting
 * state. The pass that drives these is `core`'s `deliverDueReminders`; the
 * wiring is proven in `apps/daemon/src/jobs/reminders.test.ts`.
 */

const G = parseGuildId('111111111111111111');
const CREATOR = '333333333333333333';
const CHANNEL = '444444444444444444';
const STALE_MS = 5 * 60_000;

let t: MigratedTestDatabase;

const reminder = (id: string, over: Partial<Reminder> = {}): Reminder => ({
  id,
  guildId: G,
  creatorId: CREATOR,
  destinationId: CHANNEL,
  text: `text ${id}`,
  dueAt: 1_000,
  createdAt: 500,
  status: 'scheduled',
  dedupeKey: `reminder:${G}:${id}`,
  ...over,
});

const scope = () => t.scopes.forGuild(G);
const statusOf = (id: string) => listReminders(scope()).find((r) => r.id === id);

beforeEach(() => {
  t = openMigratedTestDatabase();
  guildRepo.upsertGuild(scope(), { name: 'guild', now: 1 });
});
afterEach(() => t.close());

describe('claimDueReminders', () => {
  it('claims due scheduled rows atomically, stamping only the claim time', () => {
    insertReminder(scope(), reminder('a', { dueAt: 900 }));
    insertReminder(scope(), reminder('b', { dueAt: 1_100 }));
    const claimed = claimDueReminders(scope(), 1_000, 25, STALE_MS);
    expect(claimed.map((r) => r.id)).toEqual(['a']);
    expect(claimed[0]?.status).toBe('delivering');
    // due_at keeps the original due time; the claim is stamped in claimed_at
    // so the delivery terminal window can be measured from the due time.
    expect(claimed[0]?.dueAt).toBe(900);
    expect(claimed[0]?.claimedAt).toBe(1_000);
    expect(statusOf('a')?.status).toBe('delivering');
    // The future row is untouched.
    expect(statusOf('b')?.status).toBe('scheduled');
    expect(statusOf('b')?.dueAt).toBe(1_100);
    // A second concurrent pass finds nothing: the row is already delivering.
    expect(claimDueReminders(scope(), 1_000, 25, STALE_MS)).toEqual([]);
  });

  it('re-claims a stranded delivering row only past the stale threshold', () => {
    insertReminder(scope(), reminder('a', { dueAt: 900 }));
    const first = claimDueReminders(scope(), 1_000, 25, STALE_MS);
    expect(first).toHaveLength(1);
    // Inside the threshold the row belongs to the pass that claimed it.
    expect(claimDueReminders(scope(), 1_000 + STALE_MS - 1, 25, STALE_MS)).toEqual([]);
    // Past it, the row is stranded work from a crashed pass and is re-claimed.
    const reclaimed = claimDueReminders(scope(), 1_000 + STALE_MS, 25, STALE_MS);
    expect(reclaimed.map((r) => r.id)).toEqual(['a']);
    expect(reclaimed[0]?.dueAt).toBe(900);
    expect(reclaimed[0]?.claimedAt).toBe(1_000 + STALE_MS);
  });

  it('honours the claim limit across both claim sources', () => {
    insertReminder(scope(), reminder('a', { dueAt: 900 }));
    insertReminder(scope(), reminder('b', { dueAt: 950 }));
    insertReminder(scope(), reminder('c', { dueAt: 100, status: 'delivering' }));
    const claimed = claimDueReminders(scope(), 1_000 + STALE_MS, 2, STALE_MS);
    expect(claimed.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('insertReminder', () => {
  it('reports a dedupe-key replay as a typed duplicate instead of throwing', () => {
    // The typed result is what lets the service answer "already scheduled"
    // for exactly the idempotency case while real write failures still throw
    // (independent audit, round 2).
    expect(insertReminder(scope(), reminder('a'))).toBe('created');
    expect(insertReminder(scope(), reminder('b', { dedupeKey: `reminder:${G}:a` }))).toBe(
      'duplicate',
    );
    expect(listReminders(scope()).map((r) => r.id)).toEqual(['a']);
  });
});

describe('hasDeliverableReminders', () => {
  it('mirrors the claim predicates: due scheduled rows and stranded delivering rows only', () => {
    const NOW = 1_000;
    // Nothing scheduled at all.
    expect(hasDeliverableReminders(scope(), NOW, STALE_MS)).toBe(false);
    // A future row does not make work. (Far enough out to stay future
    // through every clock step below.)
    insertReminder(scope(), reminder('future', { dueAt: NOW + STALE_MS * 3 }));
    expect(hasDeliverableReminders(scope(), NOW, STALE_MS)).toBe(false);
    // A due row does.
    insertReminder(scope(), reminder('due', { dueAt: NOW }));
    expect(hasDeliverableReminders(scope(), NOW, STALE_MS)).toBe(true);
    // A fresh delivering claim belongs to its pass - no extra delivery job.
    claimDueReminders(scope(), NOW, 25, STALE_MS);
    expect(hasDeliverableReminders(scope(), NOW + 1, STALE_MS)).toBe(false);
    // Past the stale threshold the stranded row is deliverable again.
    expect(hasDeliverableReminders(scope(), NOW + STALE_MS, STALE_MS)).toBe(true);
    // A reminder waiting on its retry time is not deliverable before it.
    cancelReminder(scope(), 'future');
    retryReminder(scope(), 'due', 'rate limited', NOW + STALE_MS + 60_000);
    expect(hasDeliverableReminders(scope(), NOW + STALE_MS + 59_999, STALE_MS)).toBe(false);
    expect(hasDeliverableReminders(scope(), NOW + STALE_MS + 60_000, STALE_MS)).toBe(true);
    // Terminal states never make work.
    claimDueReminders(scope(), NOW + STALE_MS + 60_000, 25, STALE_MS);
    completeReminder(scope(), 'due');
    expect(hasDeliverableReminders(scope(), NOW + STALE_MS + 60_000, STALE_MS)).toBe(false);
  });
});

describe('state-guarded transitions', () => {
  it('completes a delivering reminder and clears its last error', () => {
    insertReminder(scope(), reminder('a'));
    claimDueReminders(scope(), 1_000, 25, STALE_MS);
    retryReminder(scope(), 'a', 'rate limited', 2_000);
    claimDueReminders(scope(), 2_000, 25, STALE_MS);
    completeReminder(scope(), 'a');
    expect(statusOf('a')?.status).toBe('delivered');
    expect(statusOf('a')?.failureReason).toBeUndefined();
  });

  it('fails a delivering reminder with its reason', () => {
    insertReminder(scope(), reminder('a'));
    claimDueReminders(scope(), 1_000, 25, STALE_MS);
    failReminder(scope(), 'a', 'Missing Access');
    expect(statusOf('a')?.status).toBe('failed');
    expect(statusOf('a')?.failureReason).toBe('Missing Access');
  });

  it('returns a transiently failed reminder to scheduled with its retry time', () => {
    insertReminder(scope(), reminder('a'));
    claimDueReminders(scope(), 1_000, 25, STALE_MS);
    retryReminder(scope(), 'a', 'rate limited', 1_000 + 60_000);
    const row = statusOf('a');
    expect(row?.status).toBe('scheduled');
    // The original due time survives; the next attempt lives in its own field.
    expect(row?.dueAt).toBe(1_000);
    expect(row?.nextAttemptAt).toBe(1_000 + 60_000);
    expect(row?.claimedAt).toBeUndefined();
    expect(row?.failureReason).toBe('rate limited');
    // Not claimable again before the retry time; claimable at it.
    expect(claimDueReminders(scope(), 1_000 + 59_999, 25, STALE_MS)).toEqual([]);
    expect(claimDueReminders(scope(), 1_000 + 60_000, 25, STALE_MS).map((r) => r.id)).toEqual([
      'a',
    ]);
  });

  it('refuses a transition from the wrong state instead of double-completing', () => {
    insertReminder(scope(), reminder('a'));
    expect(() => completeReminder(scope(), 'a')).toThrow('not delivering');
    expect(() => failReminder(scope(), 'a', 'x')).toThrow('not delivering');
    expect(() => retryReminder(scope(), 'a', 'x', 2_000)).toThrow('not delivering');
    expect(statusOf('a')?.status).toBe('scheduled');
  });

  it('cancels only a scheduled reminder', () => {
    insertReminder(scope(), reminder('a'));
    insertReminder(scope(), reminder('b'));
    claimDueReminders(scope(), 1_000, 25, STALE_MS);
    expect(cancelReminder(scope(), 'a')).toBe(false);
    expect(cancelReminder(scope(), 'b')).toBe(false);
    expect(statusOf('a')?.status).toBe('delivering');
    insertReminder(scope(), reminder('c', { dueAt: 9_999 }));
    expect(cancelReminder(scope(), 'c')).toBe(true);
    expect(statusOf('c')?.status).toBe('cancelled');
  });
});
