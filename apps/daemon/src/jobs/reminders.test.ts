import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  DiscordApiError,
  parseGuildId,
  REMINDER_RETRY_BACKOFF_MS,
  type Reminder,
} from '@bananasaurs/core';
import { assistantRepo, guildRepo, type GuildScope } from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { FakeDiscord } from '@bananasaurs/testkit';
import {
  classifyReminderSendError,
  createReminderDelivery,
  reminderStoreFor,
} from '../assistant/reminder-delivery.js';
import { deliverRemindersHandler } from './reminders.js';

/**
 * The delivery pass end to end against a real database and the FakeDiscord
 * port: the handler drives `core`'s pass through the composition adapters,
 * sends exactly once per claimed reminder with mentions disabled, and
 * settles each reminder into the state the failure class dictates.
 */

const GUILD = parseGuildId('111111111111111111');
const CREATOR = '333333333333333333';
const CHANNEL = '444444444444444444';
const NOW = 1_700_000_000_000;

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let discord: FakeDiscord;

const reminder = (id: string, over: Partial<Reminder> = {}): Reminder => ({
  id,
  guildId: GUILD,
  creatorId: CREATOR,
  destinationId: CHANNEL,
  text: `text ${id}`,
  dueAt: NOW - 1_000,
  createdAt: NOW - 60_000,
  status: 'scheduled',
  dedupeKey: `reminder:${GUILD}:${id}`,
  mentions: { userIds: [], roleIds: [], everyone: false, here: false },
  deliveredCount: 0,
  ...over,
});

const runPass = async (now: number) => {
  const handler = deliverRemindersHandler({
    store: reminderStoreFor(scope),
    delivery: createReminderDelivery(GUILD, discord),
    now: () => now,
    logger,
  });
  await handler.run({}, { jobId: 1, attempts: 1, cursor: null, saveCursor: () => undefined });
};

const statusOf = (id: string) => assistantRepo.listReminders(scope).find((r) => r.id === id);

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(scope, { name: 'guild', now: 0 });
  discord = new FakeDiscord({ guildId: GUILD });
});
afterEach(() => t.close());

describe('deliverRemindersHandler', () => {
  it('delivers a due reminder once, with mentions disabled, and leaves future rows alone', async () => {
    assistantRepo.insertReminder(scope, reminder('due', { dueAt: NOW - 2_000 }));
    assistantRepo.insertReminder(scope, reminder('later', { dueAt: NOW + 60_000 }));

    await runPass(NOW);

    const calls = discord.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[1]).toBe(CHANNEL);
    const message = calls[0]?.args[2] as { content: string; allowedMentions: { parse: [] } };
    expect(message.content).toBe(`⏰ text due\n-# Set by <@${CREATOR}>`);
    expect(message.allowedMentions).toEqual({ parse: [] });
    expect(statusOf('due')?.status).toBe('delivered');
    expect(statusOf('later')?.status).toBe('scheduled');

    // A second pass does not re-send a delivered reminder.
    await runPass(NOW + 1_000);
    expect(discord.restCalls('sendMessage')).toHaveLength(1);
  });

  it('fails a permission-refused destination permanently on the first attempt', async () => {
    assistantRepo.insertReminder(scope, reminder('blocked', { dueAt: NOW - 2_000 }));
    assistantRepo.insertReminder(scope, reminder('fine', { dueAt: NOW - 1_000 }));
    discord.failNext('sendMessage', FakeDiscord.missingPermissions());

    await runPass(NOW);

    expect(statusOf('blocked')?.status).toBe('failed');
    expect(statusOf('blocked')?.failureReason).toContain('Missing Permissions');
    // The failure did not hold the next reminder back.
    expect(statusOf('fine')?.status).toBe('delivered');
  });

  it('retries a rate-limited send after the backoff, then delivers', async () => {
    assistantRepo.insertReminder(scope, reminder('limited'));
    discord.failNext('sendMessage', FakeDiscord.rateLimited());

    await runPass(NOW);
    expect(statusOf('limited')?.status).toBe('scheduled');
    // The original due time survives; the retry time is its own field.
    expect(statusOf('limited')?.nextAttemptAt).toBe(NOW + REMINDER_RETRY_BACKOFF_MS);
    expect(statusOf('limited')?.failureReason).toContain('rate limited');
    expect(discord.restCalls('sendMessage')).toHaveLength(1);

    // Before the retry time the pass claims nothing.
    await runPass(NOW + REMINDER_RETRY_BACKOFF_MS - 1);
    expect(discord.restCalls('sendMessage')).toHaveLength(1);

    // At it, the reminder goes out and completes.
    await runPass(NOW + REMINDER_RETRY_BACKOFF_MS);
    expect(discord.restCalls('sendMessage')).toHaveLength(2);
    expect(statusOf('limited')?.status).toBe('delivered');
  });

  it('re-claims a reminder stranded mid-delivery by a crashed pass', async () => {
    assistantRepo.insertReminder(scope, reminder('stranded'));
    // Simulate the crash: claim the row without delivering it, the state a
    // process killed between claim and send leaves behind.
    const claimed = assistantRepo.claimDueReminders(scope, NOW, 25, 5 * 60_000);
    expect(claimed.map((r) => r.id)).toEqual(['stranded']);
    expect(discord.restCalls('sendMessage')).toHaveLength(0);

    // Inside the stale threshold the pass leaves the row alone.
    await runPass(NOW + 60_000);
    expect(discord.restCalls('sendMessage')).toHaveLength(0);

    // Past it, the row is re-claimed and sent.
    await runPass(NOW + 5 * 60_000);
    expect(discord.restCalls('sendMessage')).toHaveLength(1);
    expect(statusOf('stranded')?.status).toBe('delivered');
  });
});

describe('classifyReminderSendError', () => {
  it('treats permission and other 4xx failures as permanent', () => {
    expect(
      classifyReminderSendError(new DiscordApiError(403, 50_013, 'Missing Permissions')).permanent,
    ).toBe(true);
    expect(
      classifyReminderSendError(new DiscordApiError(403, 50_001, 'Missing Access')).permanent,
    ).toBe(true);
    // Unknown channel (a deleted destination, or a user id where a channel
    // was expected) is a 404: permanent, not retried.
    expect(
      classifyReminderSendError(new DiscordApiError(404, 10_003, 'Unknown Channel')).permanent,
    ).toBe(true);
  });

  it('treats rate limits, 5xx and transport failures as transient', () => {
    expect(
      classifyReminderSendError(new DiscordApiError(429, 429, 'You are being rate limited.'))
        .permanent,
    ).toBe(false);
    expect(classifyReminderSendError(new DiscordApiError(500, undefined, 'oops')).permanent).toBe(
      false,
    );
    expect(
      classifyReminderSendError(new DiscordApiError(0, undefined, 'socket reset')).permanent,
    ).toBe(false);
    expect(classifyReminderSendError(new Error('boom')).permanent).toBe(false);
  });
});
