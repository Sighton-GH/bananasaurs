import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId, ReminderDeliveryError, type Reminder } from '@bananasaurs/core';
import { assistantRepo, guildRepo, type GuildScope } from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { FakeDiscord } from '@bananasaurs/testkit';
import { createReminderDelivery, reminderStoreFor, renderReminder } from './reminder-delivery.js';

/**
 * Reminder delivery renders exactly the stored pings (ADR 0086 decisions 5
 * and 6): `allowedMentions` lists the stored members, roles and `everyone`
 * only, never anything parsed from the reminder text.
 */

const GUILD = parseGuildId('111111111111111111');
const CREATOR = '333333333333333333';
const CHANNEL = '444444444444444444';
const USER = '555555555555555555';
const ROLE = '666666666666666666';
const NOW = 1_700_000_000_000;

const reminder = (over: Partial<Reminder> = {}): Reminder => ({
  id: 'r1',
  guildId: GUILD,
  creatorId: CREATOR,
  destinationId: CHANNEL,
  text: 'standup in five',
  dueAt: NOW - 1_000,
  createdAt: NOW - 60_000,
  status: 'scheduled',
  dedupeKey: `reminder:${GUILD}:r1`,
  mentions: { userIds: [], roleIds: [], everyone: false, here: false },
  deliveredCount: 0,
  ...over,
});

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(scope, { name: 'guild', now: 0 });
});
afterEach(() => t.close());

describe('renderReminder', () => {
  it('sends no pings and parses nothing when no mentions are stored', () => {
    const rendered = renderReminder(reminder());
    expect(rendered.allowedMentions).toEqual({ parse: [] });
    expect(rendered.content).toBe(`⏰ standup in five\n-# Set by <@${CREATOR}>`);
  });

  it('lists exactly the stored users and roles, roles before users', () => {
    const rendered = renderReminder(
      reminder({ mentions: { userIds: [USER], roleIds: [ROLE], everyone: false, here: false } }),
    );
    expect(rendered.content.split('\n')[0]).toBe(`<@&${ROLE}> <@${USER}>`);
    expect(rendered.allowedMentions).toEqual({ parse: [], roles: [ROLE], users: [USER] });
  });

  it('puts @everyone first and parses everyone when stored', () => {
    const rendered = renderReminder(
      reminder({ mentions: { userIds: [USER], roleIds: [ROLE], everyone: true, here: false } }),
    );
    expect(rendered.content.split('\n')[0]).toBe(`@everyone <@&${ROLE}> <@${USER}>`);
    expect(rendered.allowedMentions).toEqual({
      parse: ['everyone'],
      roles: [ROLE],
      users: [USER],
    });
  });

  it('parses everyone for @here alone', () => {
    const rendered = renderReminder(
      reminder({ mentions: { userIds: [], roleIds: [], everyone: false, here: true } }),
    );
    expect(rendered.content.split('\n')[0]).toBe('@here');
    expect(rendered.allowedMentions).toEqual({ parse: ['everyone'] });
  });

  it('never pings text the member typed when nothing is stored', () => {
    const rendered = renderReminder(
      reminder({
        text: '@everyone free pizza <@123456789012345678>',
        mentions: { userIds: [], roleIds: [], everyone: false, here: false },
      }),
    );
    expect(rendered.allowedMentions).toEqual({ parse: [] });
    // No pings line: the content starts with the text itself.
    expect(rendered.content.startsWith('⏰ @everyone')).toBe(true);
  });

  it('adds the context line and the Set by line', () => {
    const rendered = renderReminder(reminder({ context: 'because the deploy moved' }));
    expect(rendered.content).toBe(
      `⏰ standup in five\n-# because the deploy moved\n-# Set by <@${CREATOR}>`,
    );
  });

  it('never pings the creator through the Set by line', () => {
    const rendered = renderReminder(reminder());
    expect(rendered.allowedMentions).toEqual({ parse: [] });
    expect(rendered.content).toContain(`<@${CREATOR}>`);
  });

  it('caps the content at 2,000 characters by truncating the text, never the pings', () => {
    const rendered = renderReminder(
      reminder({
        text: 'x'.repeat(5_000),
        mentions: { userIds: [USER], roleIds: [ROLE], everyone: true, here: false },
      }),
    );
    expect(rendered.content.length).toBeLessThanOrEqual(2_000);
    const lines = rendered.content.split('\n');
    expect(lines[0]).toBe(`@everyone <@&${ROLE}> <@${USER}>`);
    expect(lines.at(-1)).toBe(`-# Set by <@${CREATOR}>`);
  });
});

describe('reminderStoreFor', () => {
  it('reschedules a claimed reminder to its next due time', async () => {
    assistantRepo.insertReminder(scope, reminder());
    assistantRepo.claimDueReminders(scope, NOW, 25, 5 * 60_000);

    await reminderStoreFor(scope).reschedule('r1', NOW + 86_400_000);

    expect(assistantRepo.getReminder(scope, 'r1')?.dueAt).toBe(NOW + 86_400_000);
    expect(assistantRepo.getReminder(scope, 'r1')?.status).toBe('scheduled');
  });
});

describe('createReminderDelivery', () => {
  it('sends the rendered reminder to the destination channel', async () => {
    const discord = new FakeDiscord({ guildId: GUILD });
    const delivery = createReminderDelivery(GUILD, discord);
    const due = reminder({
      mentions: { userIds: [USER], roleIds: [], everyone: false, here: false },
      context: 'why it matters',
    });

    await delivery.send(due);

    const calls = discord.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[1]).toBe(CHANNEL);
    expect(calls[0]?.args[2]).toEqual(renderReminder(due));
  });

  it('keeps the error classification on send failures', async () => {
    const discord = new FakeDiscord({ guildId: GUILD });
    discord.failNext('sendMessage', FakeDiscord.missingPermissions());
    const delivery = createReminderDelivery(GUILD, discord);

    const error = await delivery.send(reminder()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReminderDeliveryError);
    expect((error as ReminderDeliveryError).permanent).toBe(true);
  });
});
