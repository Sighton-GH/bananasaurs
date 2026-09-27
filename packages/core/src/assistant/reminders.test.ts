import { describe, expect, it, vi } from 'vitest';
import {
  deliverDueReminders,
  REMINDER_DELIVERY_STALE_MS,
  REMINDER_DELIVERY_TERMINAL_WINDOW_MS,
  REMINDER_RETRY_BACKOFF_MS,
  ReminderDeliveryError,
  type Reminder,
  type ReminderStore,
  createReminder,
} from './reminders.js';
import { reminderRecurrence } from './recurrence.js';

/**
 * The delivery pass's own contract: classification, retry timing and the
 * terminal window. Storage transitions are proven in
 * `packages/storage/src/repos/assistant-reminders.test.ts`; the wired handler
 * end to end in `apps/daemon/src/jobs/reminders.test.ts`.
 */

const NOW = 1_700_000_000_000;

const reminder = (over: Partial<Reminder> = {}): Reminder => ({
  id: 'r1',
  guildId: 'g1',
  creatorId: 'u1',
  destinationId: 'c1',
  text: 'Monday meeting',
  dueAt: NOW - 1_000,
  createdAt: NOW - 60_000,
  status: 'delivering',
  dedupeKey: 'reminder:g1:r1',
  mentions: { userIds: [], roleIds: [], everyone: false, here: false },
  deliveredCount: 0,
  ...over,
});

const storeFor = (claimed: readonly Reminder[]) => ({
  create: vi.fn(),
  cancel: vi.fn(),
  claimDue: vi.fn(async () => claimed),
  complete: vi.fn(async () => undefined),
  reschedule: vi.fn(async () => undefined),
  fail: vi.fn(async () => undefined),
  retry: vi.fn(async () => undefined),
});

describe('deliverDueReminders', () => {
  it('claims with the stale threshold and completes a sent reminder', async () => {
    const store = storeFor([reminder()]);
    const delivery = { send: vi.fn(async () => undefined) };
    await expect(deliverDueReminders(store, delivery, NOW, 10)).resolves.toEqual({
      delivered: 1,
      failed: 0,
      retried: 0,
    });
    expect(store.claimDue).toHaveBeenCalledWith(NOW, 10, REMINDER_DELIVERY_STALE_MS);
    expect(store.complete).toHaveBeenCalledWith('r1');
    expect(store.reschedule).not.toHaveBeenCalled();
    expect(store.fail).not.toHaveBeenCalled();
    expect(store.retry).not.toHaveBeenCalled();
  });

  it('fails a permanent delivery error immediately, with no retry', async () => {
    const store = storeFor([reminder()]);
    const delivery = {
      send: vi.fn(async () => {
        throw new ReminderDeliveryError('Missing Access', true);
      }),
    };
    await expect(deliverDueReminders(store, delivery, NOW)).resolves.toEqual({
      delivered: 0,
      failed: 1,
      retried: 0,
    });
    expect(store.fail).toHaveBeenCalledWith('r1', 'Missing Access');
    expect(store.retry).not.toHaveBeenCalled();
  });

  it('returns a transient failure to scheduled with a persisted retry time', async () => {
    const store = storeFor([reminder()]);
    const delivery = {
      send: vi.fn(async () => {
        throw new ReminderDeliveryError('You are being rate limited.', false);
      }),
    };
    await expect(deliverDueReminders(store, delivery, NOW)).resolves.toEqual({
      delivered: 0,
      failed: 0,
      retried: 1,
    });
    expect(store.retry).toHaveBeenCalledWith(
      'r1',
      'You are being rate limited.',
      NOW + REMINDER_RETRY_BACKOFF_MS,
    );
    expect(store.fail).not.toHaveBeenCalled();
  });

  it('treats an unclassified error as transient', async () => {
    const store = storeFor([reminder()]);
    const delivery = {
      send: vi.fn(async () => {
        throw new Error('socket reset');
      }),
    };
    await expect(deliverDueReminders(store, delivery, NOW)).resolves.toEqual({
      delivered: 0,
      failed: 0,
      retried: 1,
    });
  });

  it('fails a transient error terminally once the reminder is past due by the window', async () => {
    const old = reminder({ dueAt: NOW - REMINDER_DELIVERY_TERMINAL_WINDOW_MS - 1 });
    const store = storeFor([old]);
    const delivery = {
      send: vi.fn(async () => {
        throw new ReminderDeliveryError('You are being rate limited.', false);
      }),
    };
    await expect(deliverDueReminders(store, delivery, NOW)).resolves.toEqual({
      delivered: 0,
      failed: 1,
      retried: 0,
    });
    expect(store.fail).toHaveBeenCalledWith('r1', 'You are being rate limited.');
    expect(store.retry).not.toHaveBeenCalled();
  });

  it('keeps delivering after one reminder fails', async () => {
    const store = storeFor([reminder(), reminder({ id: 'r2' })]);
    const delivery = {
      send: vi
        .fn<(r: Reminder) => Promise<void>>()
        .mockRejectedValueOnce(new ReminderDeliveryError('Missing Access', true))
        .mockResolvedValueOnce(undefined),
    };
    await expect(deliverDueReminders(store, delivery, NOW)).resolves.toEqual({
      delivered: 1,
      failed: 1,
      retried: 0,
    });
    expect(store.fail).toHaveBeenCalledWith('r1', 'Missing Access');
    expect(store.complete).toHaveBeenCalledWith('r2');
  });

  it('reschedules repeating reminders to the next future occurrence', async () => {
    const due = Date.parse('2026-01-05T17:00:00Z');
    const repeating = reminder({
      dueAt: due,
      recurrence: reminderRecurrence.parse({ pattern: { kind: 'daily' }, timeZone: 'UTC' }),
    });
    const store = storeFor([repeating]);
    await deliverDueReminders(store, { send: vi.fn(async () => undefined) }, due + 3 * 86_400_000);
    expect(store.reschedule).toHaveBeenCalledWith('r1', due + 4 * 86_400_000);
  });

  it('completes a repeating series at its end', async () => {
    const due = Date.parse('2026-01-05T17:00:00Z');
    const store = storeFor([reminder({
      dueAt: due,
      recurrence: reminderRecurrence.parse({ pattern: { kind: 'daily' }, timeZone: 'UTC', maxCount: 1 }),
    })]);
    await deliverDueReminders(store, { send: vi.fn(async () => undefined) }, due);
    expect(store.complete).toHaveBeenCalledWith('r1');
  });
});

describe('reminder drafts', () => {
  it('rejects overlong context', async () => {
    await expect(createReminder({ ...reminder(), dueAt: Date.now() + 60_000, context: 'x'.repeat(301) }, storeFor([]))).rejects.toThrow(
      'reminder context must be at most 300 characters',
    );
  });

  it('validates mentions', async () => {
    const { reminderMentions } = await import('./reminders.js');
    expect(reminderMentions.safeParse({ userIds: ['bad'] }).success).toBe(false);
    expect(reminderMentions.safeParse({ userIds: Array.from({ length: 26 }, () => '11111111111111111') }).success).toBe(false);
  });
});

// Type-level anchor: the fake stores above satisfy the real interface.
const _typecheck: (s: ReturnType<typeof storeFor>) => ReminderStore = (s) => s;
void _typecheck;

describe('terminal window regression (review finding 4)', () => {
  it('retries a reminder scheduled far ahead that fails on its first pass', async () => {
    // Created 12h ago but only due now: the window runs from the due time,
    // not creation, so the first transient error must retry, not fail.
    const farAhead = reminder({
      createdAt: NOW - 12 * 60 * 60 * 1_000,
      dueAt: NOW - 1_000,
    });
    const store = storeFor([farAhead]);
    const delivery = {
      send: vi.fn(async () => {
        throw new ReminderDeliveryError('You are being rate limited.', false);
      }),
    };
    await expect(deliverDueReminders(store, delivery, NOW)).resolves.toEqual({
      delivered: 0,
      failed: 0,
      retried: 1,
    });
    expect(store.retry).toHaveBeenCalled();
    expect(store.fail).not.toHaveBeenCalled();
  });
});
