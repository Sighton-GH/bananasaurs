import { describe, expect, it, vi } from 'vitest';
import {
  deliverDueReminders,
  REMINDER_DELIVERY_STALE_MS,
  REMINDER_DELIVERY_TERMINAL_WINDOW_MS,
  REMINDER_RETRY_BACKOFF_MS,
  ReminderDeliveryError,
  type Reminder,
  type ReminderStore,
} from './reminders.js';

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
  ...over,
});

const storeFor = (claimed: readonly Reminder[]) => ({
  create: vi.fn(),
  cancel: vi.fn(),
  claimDue: vi.fn(async () => claimed),
  complete: vi.fn(async () => undefined),
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

  it('fails a transient error terminally once the reminder is older than the window', async () => {
    const old = reminder({ createdAt: NOW - REMINDER_DELIVERY_TERMINAL_WINDOW_MS - 1 });
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
});

// Type-level anchor: the fake stores above satisfy the real interface.
const _typecheck: (s: ReturnType<typeof storeFor>) => ReminderStore = (s) => s;
void _typecheck;
