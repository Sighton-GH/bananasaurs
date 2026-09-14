import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelType, Client, PermissionsBitField, type Guild } from 'discord.js';
import { parseGuildId } from '@bananasaurs/core';
import { buildClientOptions } from '@bananasaurs/discord';
import { archiveRepo, guildRepo, type GuildScope } from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import type { GuildOperations } from '../runtime/guild.js';
import { opsPortsFor } from './wiring.js';

/**
 * `doctor`'s archive check: `listUnreadableArchiveChannels`
 * (`apps/daemon/src/ops/wiring.ts`).
 *
 * The permission logic — the `missing` / `no-view` / `no-history` branching
 * over the gateway cache — previously had no test anywhere: the doctor tests
 * stub `listUnreadableArchiveChannels` and assert only the renderer. These
 * reach the real function through `opsPortsFor` against a fake discord.js
 * guild shaped like the one `runtime/doctor.test.ts` builds (a real `Client`
 * that never logged in, guilds injected through `guilds._add`), with archive
 * rows in a real migrated database.
 */

const GUILD = parseGuildId('211111111111111111');
const BOT = '123456789012345678';
const OWNER = '345678901234567890';
const BOT_ROLE = '555555555555555555';

const MISSING = '611111111111111111';
const NO_VIEW = '622222222222222222';
const NO_HISTORY = '633333333333333333';
const CLEAN = '644444444444444444';

const NOW = 1_700_000_000_000;

interface Internals {
  guilds: { _add: (data: object) => Guild };
  users: { _add: (data: object) => never };
}
const internals = (c: Client): Internals => c as unknown as Internals;

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let client: Client;

const operations: GuildOperations = {
  publishPanel: async () => ({
    action: 'not-managed',
    messageId: undefined,
    reactionsSeeded: 0,
    reactionsFailed: [],
  }),
  grantAdoptionAllowance: () => {},
  adoptionAllowance: () => 0,
};

const channelPayload = (
  id: string,
  permissionOverwrites: readonly { id: string; deny: string }[],
) => ({
  id,
  guild_id: GUILD,
  type: ChannelType.GuildText,
  name: `channel-${id}`,
  position: 0,
  permission_overwrites: permissionOverwrites.map((overwrite) => ({
    id: overwrite.id,
    type: 0,
    allow: '0',
    deny: overwrite.deny,
  })),
});

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });

  client = new Client(buildClientOptions(() => BOT));
  const mutable = client as unknown as { user: unknown };
  mutable.user = internals(client).users._add({
    id: BOT,
    username: 'bananasaurs',
    discriminator: '0',
  });

  // The bot role can view and read everywhere by default; each channel below
  // denies at most one of the two, so the reason names the exact denial.
  // (Deliberately not Administrator: it bypasses channel overwrites, which
  // would make every denial invisible.)
  const rolePermissions = new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.SendMessages,
  ]).bitfield.toString();
  internals(client).guilds._add({
    id: GUILD,
    name: 'test guild',
    owner_id: OWNER,
    member_count: 30,
    channels: [
      channelPayload(NO_VIEW, [
        { id: BOT_ROLE, deny: String(PermissionsBitField.Flags.ViewChannel) },
      ]),
      channelPayload(NO_HISTORY, [
        { id: BOT_ROLE, deny: String(PermissionsBitField.Flags.ReadMessageHistory) },
      ]),
      channelPayload(CLEAN, []),
    ],
    roles: [
      { id: GUILD, name: '@everyone', position: 0, permissions: '0', managed: false },
      {
        id: BOT_ROLE,
        name: 'bananasaurs',
        position: 7,
        permissions: rolePermissions,
        managed: true,
      },
    ],
    members: [
      { user: { id: BOT, username: 'bananasaurs', discriminator: '0' }, roles: [BOT_ROLE] },
    ],
    emojis: [],
    unavailable: false,
  });
});

const enable = (...channelIds: string[]): void => {
  for (const channelId of channelIds) {
    archiveRepo.enableChannel(scope, { channelId, attachmentPolicy: 'none', now: NOW });
  }
};

const unreadable = () =>
  opsPortsFor(
    scope,
    t.scopes.instance(),
    operations,
    () => NOW,
    client,
    true,
  ).listUnreadableArchiveChannels();

describe('listUnreadableArchiveChannels', () => {
  it('reports a channel absent from the cache as missing', () => {
    enable(MISSING);

    expect(unreadable()).toEqual([{ channelId: MISSING, reason: 'missing' }]);
  });

  it('reports a channel the bot cannot view as no-view', () => {
    enable(NO_VIEW);

    expect(unreadable()).toEqual([{ channelId: NO_VIEW, reason: 'no-view' }]);
  });

  it('reports a viewable channel the bot cannot read history in as no-history', () => {
    enable(NO_HISTORY);

    expect(unreadable()).toEqual([{ channelId: NO_HISTORY, reason: 'no-history' }]);
  });

  it('reports nothing for a channel the bot can read', () => {
    enable(CLEAN);

    expect(unreadable()).toEqual([]);
  });

  it('reports each enabled channel under its own reason and stays silent on the clean one', () => {
    enable(MISSING, NO_VIEW, NO_HISTORY, CLEAN);

    expect(unreadable()).toEqual([
      { channelId: MISSING, reason: 'missing' },
      { channelId: NO_VIEW, reason: 'no-view' },
      { channelId: NO_HISTORY, reason: 'no-history' },
    ]);
  });
});
