import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelType, Client, PermissionsBitField } from 'discord.js';
import { pino } from 'pino';
import { buildClientOptions } from '@bananasaurs/discord';
import {
  deliverDueReminders,
  parseGuildId,
  ReminderDeliveryError,
  type Logger,
  type Reminder,
  type ReminderStore,
} from '@bananasaurs/core';
import { assistantRepo, guildRepo, mcpSendRepo, type GuildScope } from '@bananasaurs/storage';
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
    // No pings line: the content starts with the neutralised text itself.
    expect(rendered.content.startsWith('⏰ @\u200beveryone')).toBe(true);
  });

  it('neutralises @everyone in the text when only @here is stored', () => {
    const rendered = renderReminder(
      reminder({
        text: '@everyone meeting moved',
        mentions: { userIds: [], roleIds: [], everyone: false, here: true },
      }),
    );
    expect(rendered.content.split('\n')[0]).toBe('@here');
    expect(rendered.content).not.toContain('@everyone');
    expect(rendered.content).toContain('@\u200beveryone');
  });

  it('collapses newlines in the context line', () => {
    const rendered = renderReminder(reminder({ context: 'line one\nline two' }));
    const lines = rendered.content.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('-# line one line two');
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

/**
 * Task 2 (ADR 0119 §2): the delivery-time re-check for `origin='mcp'` rows.
 * A real discord.js `Client` that never logged in carries the live guild
 * facts (roles, members, channels, overwrites) the way `mcp/targets.test.ts`
 * builds its own; the `FakeDiscord` port only receives the post itself.
 */

const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL_B = '477777777777777777';
const BOT_USER = '123456789012345678';
const BOT_ROLE = '777777777777777777';
const LOW_ROLE = '511111111111111111';
const EVIL_ROLE = '522222222222222222';
const MEMBER = '611111111111111111';
const STRANGER = '622222222222222222';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const MCP_TEXT = 'mcp scheduled hello world';

type McpReminder = Reminder & { readonly origin: 'mcp' };

const mcpReminder = (over: Partial<Reminder> = {}): McpReminder => ({
  ...reminder({ destinationId: CHANNEL, text: MCP_TEXT, ...over }),
  origin: 'mcp',
});

const textChannelPayload = (guildId: string, id: string): object => ({
  id,
  guild_id: guildId,
  type: ChannelType.GuildText,
  name: `channel-${id}`,
  position: 0,
  permission_overwrites: [],
});

const makeDeliveryClient = (
  options: {
    readonly guilds?: ReadonlyArray<{
      readonly guildId: string;
      readonly channels: readonly string[];
      readonly evilPermissions?: string;
      readonly members?: readonly string[];
    }>;
  } = {},
): Client => {
  const client = new Client(buildClientOptions(() => BOT_USER));
  const mutable = client as unknown as { user: unknown };
  const internals = client as unknown as {
    guilds: { _add: (data: object) => unknown };
    users: { _add: (data: object) => unknown };
  };
  mutable.user = internals.users._add({
    id: BOT_USER,
    username: 'bananasaurs',
    discriminator: '0',
  });
  const botPermissions =
    PermissionsBitField.Flags.ViewChannel |
    PermissionsBitField.Flags.SendMessages |
    PermissionsBitField.Flags.SendMessagesInThreads;
  for (const guild of options.guilds ?? [
    { guildId: GUILD, channels: [CHANNEL] as readonly string[] },
  ]) {
    internals.guilds._add({
      id: guild.guildId,
      name: `guild ${guild.guildId}`,
      owner_id: '345678901234567890',
      channels: guild.channels.map((id) => textChannelPayload(guild.guildId, id)),
      roles: [
        { id: guild.guildId, name: '@everyone', position: 0, permissions: '0', managed: false },
        {
          id: BOT_ROLE,
          name: 'bananasaurs',
          position: 7,
          permissions: botPermissions.toString(),
          managed: true,
        },
        { id: LOW_ROLE, name: 'helpers', position: 3, permissions: '0' },
        {
          id: EVIL_ROLE,
          name: 'old-mods',
          position: 2,
          permissions: guild.evilPermissions ?? '0',
        },
      ],
      members: [
        { user: { id: BOT_USER, username: 'bananasaurs', discriminator: '0' }, roles: [BOT_ROLE] },
        ...(guild.members ?? []).map((id) => ({
          user: { id, username: id, discriminator: '0' },
          roles: [],
        })),
      ],
      emojis: [],
      unavailable: false,
    });
  }
  return client;
};

const setRolePermissions = (
  client: Client,
  guildId: string,
  roleId: string,
  bits: bigint,
): void => {
  const role = client.guilds.cache.get(guildId)?.roles.cache.get(roleId) as unknown as {
    permissions: PermissionsBitField;
  };
  if (role === undefined) throw new Error('role missing from test client cache');
  role.permissions = new PermissionsBitField(bits);
};

/** A real pino over a captured stream, so the ids-only redaction runs for real. */
const capturingLogger = (): { logger: Logger; lines: string[] } => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, callback: () => void) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { logger: pino({ level: 'info' }, stream), lines };
};

const loggedFields = (lines: string[]): Record<string, unknown>[] =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

const allowChannel = (guildScope: GuildScope, channelId: string): void => {
  mcpSendRepo.allowChannel(guildScope, {
    channelId,
    addedByAccountId: ACCOUNT,
    now: NOW,
  });
};

describe('mcp scheduled sends (origin mcp)', () => {
  it('RF1: a role made dangerous after scheduling is dropped from the pings, and the message is still delivered', async () => {
    allowChannel(scope, CHANNEL);
    const client = makeDeliveryClient({ guilds: [{ guildId: GUILD, channels: [CHANNEL] }] });
    // Scheduled while the role was benign; it gains a dangerous permission after.
    setRolePermissions(client, GUILD, EVIL_ROLE, PermissionsBitField.Flags.ManageRoles);
    const port = new FakeDiscord({ guildId: GUILD });
    const { logger, lines } = capturingLogger();

    await createReminderDelivery(GUILD, port, { client, scope, logger }).send(
      mcpReminder({
        mentions: { userIds: [], roleIds: [LOW_ROLE, EVIL_ROLE], everyone: false, here: false },
      }),
    );

    const calls = port.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    const sent = calls[0]?.args[2] as { content: string; allowedMentions: unknown };
    expect(sent.allowedMentions).toEqual({ parse: [], roles: [LOW_ROLE] });
    // The rendered content is unchanged: the dropped mention renders as typed
    // text but no longer notifies.
    expect(sent.content).toContain(`<@&${LOW_ROLE}>`);
    expect(sent.content).toContain(`<@&${EVIL_ROLE}>`);
    const fields = loggedFields(lines);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      guildId: GUILD,
      roleId: EVIL_ROLE,
      reason: 'role-dangerous',
    });
    expect(JSON.stringify(fields[0])).not.toContain(MCP_TEXT);
  });

  it('RF2: a destination removed from send scope fails target-out-of-scope, and nothing is posted', async () => {
    const client = makeDeliveryClient({ guilds: [{ guildId: GUILD, channels: [CHANNEL] }] });
    const port = new FakeDiscord({ guildId: GUILD });
    const { logger, lines } = capturingLogger();
    const delivery = createReminderDelivery(GUILD, port, { client, scope, logger });
    const row = mcpReminder();

    const error = await delivery.send(row).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReminderDeliveryError);
    expect((error as ReminderDeliveryError).message).toBe('target-out-of-scope');
    expect((error as ReminderDeliveryError).permanent).toBe(true);
    expect(port.restCalls('sendMessage')).toHaveLength(0);
    const fields = loggedFields(lines);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      guildId: GUILD,
      channelId: CHANNEL,
      reason: 'not-in-send-scope',
    });
    expect(JSON.stringify(fields[0])).not.toContain(MCP_TEXT);
  });

  it('RF2 through the existing fail path: the pass fails the reminder with no retry', async () => {
    const client = makeDeliveryClient({ guilds: [{ guildId: GUILD, channels: [CHANNEL] }] });
    const port = new FakeDiscord({ guildId: GUILD });
    const { logger } = capturingLogger();
    const row = mcpReminder();
    const failed: Array<{ id: string; reason: string }> = [];
    let retried = 0;
    const store: ReminderStore = {
      create: () => Promise.resolve(),
      cancel: () => Promise.resolve(false),
      claimDue: () => Promise.resolve([row]),
      complete: () => Promise.resolve(),
      fail: (id, reason) => {
        failed.push({ id, reason });
        return Promise.resolve();
      },
      retry: () => {
        retried += 1;
        return Promise.resolve();
      },
      reschedule: () => Promise.resolve(),
    };

    const result = await deliverDueReminders(
      store,
      createReminderDelivery(GUILD, port, { client, scope, logger }),
      NOW,
    );

    expect(result).toEqual({ delivered: 0, failed: 1, retried: 0 });
    expect(failed).toEqual([{ id: 'r1', reason: 'target-out-of-scope' }]);
    expect(retried).toBe(0);
    expect(port.restCalls('sendMessage')).toHaveLength(0);
  });

  it('a user who left the guild is dropped from the pings, and the message is still delivered', async () => {
    allowChannel(scope, CHANNEL);
    const client = makeDeliveryClient({
      guilds: [{ guildId: GUILD, channels: [CHANNEL], members: [MEMBER] }],
    });
    const guild = client.guilds.cache.get(GUILD);
    if (guild === undefined) throw new Error('guild missing from test client cache');
    guild.members.fetch = (() =>
      Promise.reject(
        Object.assign(new Error('Unknown Member'), { code: 10007, status: 404 }),
      )) as typeof guild.members.fetch;
    const port = new FakeDiscord({ guildId: GUILD });
    const { logger, lines } = capturingLogger();

    await createReminderDelivery(GUILD, port, { client, scope, logger }).send(
      mcpReminder({
        mentions: { userIds: [MEMBER, STRANGER], roleIds: [], everyone: false, here: false },
      }),
    );

    const calls = port.restCalls('sendMessage');
    expect(calls).toHaveLength(1);
    const sent = calls[0]?.args[2] as { content: string; allowedMentions: unknown };
    expect(sent.allowedMentions).toEqual({ parse: [], users: [MEMBER] });
    expect(sent.content).toContain(`<@${MEMBER}>`);
    expect(sent.content).toContain(`<@${STRANGER}>`);
    const fields = loggedFields(lines);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      guildId: GUILD,
      userId: STRANGER,
      reason: 'user-not-member',
    });
    expect(JSON.stringify(fields[0])).not.toContain(MCP_TEXT);
  });

  it('the checks use the row guild only: a channel allowlisted in another guild stays out of scope', async () => {
    // CHANNEL is allowlisted in GUILD only; the row belongs to GUILD_B, where
    // nothing is allowlisted — and CHANNEL itself lives in GUILD.
    allowChannel(scope, CHANNEL);
    guildRepo.upsertGuild(t.scopes.forGuild(GUILD_B), { name: 'guild b', now: 0 });
    const client = makeDeliveryClient({
      guilds: [
        { guildId: GUILD, channels: [CHANNEL] },
        { guildId: GUILD_B, channels: [CHANNEL_B] },
      ],
    });
    const port = new FakeDiscord({ guildId: GUILD_B });
    const { logger } = capturingLogger();
    const scopeB = t.scopes.forGuild(GUILD_B);

    const error = await createReminderDelivery(GUILD, port, { client, scope: scopeB, logger })
      .send(mcpReminder({ guildId: GUILD_B, destinationId: CHANNEL }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReminderDeliveryError);
    expect((error as ReminderDeliveryError).message).toBe('target-out-of-scope');
    expect(port.restCalls('sendMessage')).toHaveLength(0);
  });

  it('an mcp row carrying everyone is refused in the render path, never posted', async () => {
    allowChannel(scope, CHANNEL);
    const client = makeDeliveryClient({ guilds: [{ guildId: GUILD, channels: [CHANNEL] }] });
    const port = new FakeDiscord({ guildId: GUILD });
    const { logger } = capturingLogger();

    expect(() =>
      renderReminder({
        ...mcpReminder(),
        mentions: { userIds: [], roleIds: [], everyone: true, here: false },
      }),
    ).toThrow('mcp reminders cannot ping everyone or here');
    expect(port.restCalls('sendMessage')).toHaveLength(0);
    const error = await createReminderDelivery(GUILD, port, { client, scope, logger })
      .send({
        ...mcpReminder(),
        mentions: { userIds: [], roleIds: [], everyone: true, here: false },
      })
      .catch((e: unknown) => e);
    // Permanent: a poisoned row fails at once rather than retrying until the
    // terminal window closes.
    expect(error).toBeInstanceOf(ReminderDeliveryError);
    expect((error as ReminderDeliveryError).message).toBe(
      'mcp reminders cannot ping everyone or here',
    );
    expect((error as ReminderDeliveryError).permanent).toBe(true);
    expect(port.restCalls('sendMessage')).toHaveLength(0);
  });

  it('an mcp row with no live-check deps fails closed as permanent, never posting unchecked', async () => {
    allowChannel(scope, CHANNEL);
    const port = new FakeDiscord({ guildId: GUILD });
    const error = await createReminderDelivery(GUILD, port)
      .send(mcpReminder())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReminderDeliveryError);
    expect((error as ReminderDeliveryError).message).toBe('mcp delivery requires live checks');
    expect((error as ReminderDeliveryError).permanent).toBe(true);
    expect(port.restCalls('sendMessage')).toHaveLength(0);
  });
});

describe('assistant reminders are untouched by the re-check', () => {
  it('RF3: an assistant reminder whose role would fail the MCP policy is still delivered with that ping', async () => {
    allowChannel(scope, CHANNEL);
    const client = makeDeliveryClient({
      guilds: [{ guildId: GUILD, channels: [CHANNEL], evilPermissions: '0' }],
    });
    setRolePermissions(client, GUILD, EVIL_ROLE, PermissionsBitField.Flags.ManageRoles);
    const port = new FakeDiscord({ guildId: GUILD });
    const { logger, lines } = capturingLogger();
    const delivery = createReminderDelivery(GUILD, port, { client, scope, logger });

    for (const row of [
      reminder({
        mentions: { userIds: [], roleIds: [EVIL_ROLE], everyone: false, here: false },
      }),
      {
        ...reminder({
          mentions: { userIds: [], roleIds: [EVIL_ROLE], everyone: false, here: false },
        }),
        origin: 'assistant' as const,
      },
    ]) {
      await delivery.send(row);
    }

    const calls = port.restCalls('sendMessage');
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const sent = call.args[2] as { allowedMentions: unknown };
      expect(sent.allowedMentions).toEqual({ parse: [], roles: [EVIL_ROLE] });
    }
    expect(lines).toHaveLength(0);
  });
});

describe('no model in the scheduled-send path', () => {
  it('the delivery adapter module has no provider-layer import', () => {
    const source = readFileSync(new URL('./reminder-delivery.ts', import.meta.url), 'utf8');
    const specifiers = [
      ...source.matchAll(/from\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/import\(\s*['"]([^'"]+)['"]/g),
    ].map((match) => match[1] ?? '');
    expect(
      specifiers.filter((specifier) =>
        /provider|model-chain|quota-ledger|web-search|generateText/i.test(specifier),
      ),
    ).toEqual([]);
    expect(source).not.toContain('generateText');
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
