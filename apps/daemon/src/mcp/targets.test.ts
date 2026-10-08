import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelType, Client, PermissionsBitField } from 'discord.js';
import { buildClientOptions } from '@bananasaurs/discord';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { guildRepo, loggingRepo, mcpSendRepo } from '@bananasaurs/storage';
import { parseGuildId } from '@bananasaurs/core';
import {
  checkRolePing,
  filterPings,
  resolvePings,
  resolveSendPings,
  resolveSendTarget,
  textMentions,
} from './targets.js';

/**
 * Task 4 Step 1: target resolution — send scope ∩ the bot's live Discord
 * permissions, plus explicit role/user pings under the role policy and the
 * dangerous-permission floor.
 *
 * The client is a real discord.js `Client` that never logged in, with the
 * guild injected through `guilds._add` the way `ops/wiring.test.ts` injects
 * its own — so `channel.permissionsFor(guild.members.me)` runs the real
 * overwrite math, and the floor reads the live role objects.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const BOT = '123456789012345678';
const BOT_ROLE = '555555555555555555';
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const NOW = 1_700_000_000_000;

const CHANNEL = '444444444444444444';
const OTHER_CHANNEL = '455555555555555555';
const NO_SEND_CHANNEL = '466666666666666666';
const THREAD = '488888888888888888';
const PRIVATE_THREAD = '499999999999999999';
const MISSING_CHANNEL = '400000000000000000';
const CATEGORY = '433333333333333333';
const CATCHANNEL = '434444444444444444';

const LOW_ROLE = '511111111111111111';
const HIGH_ROLE = '522222222222222222';
const MANAGED_ROLE = '533333333333333333';
const MEMBER_USER = '611111111111111111';
const STRANGER_USER = '622222222222222222';

interface TestClientOptions {
  /** Guild-level permission bits for the bot role. */
  readonly botPermissions?: bigint;
  /** Extra roles in the guild. */
  readonly roles?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly position: number;
    readonly permissions: string;
    readonly managed?: boolean;
  }>;
  /** Extra members in the guild. */
  readonly members?: ReadonlyArray<{ readonly id: string; readonly roles?: readonly string[] }>;
  /** Channel ids whose overwrite denies SendMessages for the bot role. */
  readonly denySendOn?: readonly string[];
}

const textPayload = (
  id: string,
  overwrites: readonly { id: string; deny: string }[] = [],
  parentId?: string,
): object => ({
  id,
  guild_id: GUILD_A,
  type: ChannelType.GuildText,
  name: `channel-${id}`,
  position: 0,
  ...(parentId !== undefined ? { parent_id: parentId } : {}),
  permission_overwrites: overwrites.map((overwrite) => ({
    id: overwrite.id,
    type: 0,
    allow: '0',
    deny: overwrite.deny,
  })),
});

const categoryPayload = (id: string): object => ({
  id,
  guild_id: GUILD_A,
  type: ChannelType.GuildCategory,
  name: `category-${id}`,
  position: 0,
  permission_overwrites: [],
});

const threadPayload = (id: string, type: ChannelType, parentId: string): object => ({
  id,
  guild_id: GUILD_A,
  parent_id: parentId,
  owner_id: ACCOUNT,
  type,
  name: `thread-${id}`,
  position: 0,
  permission_overwrites: [],
  thread_metadata: {
    archived: false,
    auto_archive_duration: 60,
    archive_timestamp: new Date().toISOString(),
    locked: false,
  },
});

const makeClient = (options: TestClientOptions = {}): Client => {
  const client = new Client(buildClientOptions(() => BOT));
  const mutable = client as unknown as { user: unknown };
  const internals = client as unknown as {
    guilds: { _add: (data: object) => unknown };
    users: { _add: (data: object) => unknown };
  };
  mutable.user = internals.users._add({ id: BOT, username: 'bananasaurs', discriminator: '0' });
  const botPermissions =
    options.botPermissions ??
    PermissionsBitField.Flags.ViewChannel |
      PermissionsBitField.Flags.SendMessages |
      PermissionsBitField.Flags.SendMessagesInThreads;
  const denySet = new Set(options.denySendOn ?? []);
  internals.guilds._add({
    id: GUILD_A,
    name: 'guild a',
    owner_id: '345678901234567890',
    channels: [
      textPayload(CHANNEL),
      textPayload(OTHER_CHANNEL),
      categoryPayload(CATEGORY),
      textPayload(CATCHANNEL, [], CATEGORY),
      textPayload(
        NO_SEND_CHANNEL,
        denySet.has(NO_SEND_CHANNEL)
          ? [{ id: BOT_ROLE, deny: String(PermissionsBitField.Flags.SendMessages) }]
          : [],
      ),
      threadPayload(THREAD, ChannelType.PublicThread, CHANNEL),
      threadPayload(PRIVATE_THREAD, ChannelType.PrivateThread, CHANNEL),
    ],
    roles: [
      { id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false },
      {
        id: BOT_ROLE,
        name: 'bananasaurs',
        position: 7,
        permissions: botPermissions.toString(),
        managed: true,
      },
      ...(options.roles ?? []),
    ],
    members: [
      { user: { id: BOT, username: 'bananasaurs', discriminator: '0' }, roles: [BOT_ROLE] },
      ...(options.members ?? []).map((member) => ({
        user: { id: member.id, username: member.id, discriminator: '0' },
        roles: [...(member.roles ?? [])],
      })),
    ],
    emojis: [],
    unavailable: false,
  });
  return client;
};

const defaultRoles = (): NonNullable<TestClientOptions['roles']> => [
  { id: LOW_ROLE, name: 'helpers', position: 3, permissions: '0' },
  { id: HIGH_ROLE, name: 'admins', position: 9, permissions: '0' },
  { id: MANAGED_ROLE, name: 'integration', position: 2, permissions: '0', managed: true },
];

let t: MigratedTestDatabase;

beforeEach(() => {
  t = openMigratedTestDatabase();
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_A), { name: 'guild a', now: NOW });
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD_B), { name: 'guild b', now: NOW });
});

afterEach(() => {
  t.close();
});

const allow = (channelId: string): void => {
  mcpSendRepo.allowChannel(t.scopes.forGuild(GUILD_A), {
    channelId,
    addedByAccountId: ACCOUNT,
    now: NOW,
  });
};

const allowCategory = (categoryId: string): void => {
  mcpSendRepo.allowChannel(t.scopes.forGuild(GUILD_A), {
    channelId: categoryId,
    addedByAccountId: ACCOUNT,
    scopeKind: 'category',
    now: NOW,
  });
};

describe('resolveSendTarget', () => {
  it('an in-scope channel passes with need post', async () => {
    allow(CHANNEL);
    const resolved = await resolveSendTarget(
      makeClient(),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      CHANNEL,
      'post',
    );
    expect(resolved).toMatchObject({ ok: true, channelId: CHANNEL, isThread: false });
  });

  it('a thread under an in-scope parent passes with need post-in-thread', async () => {
    allow(CHANNEL);
    const resolved = await resolveSendTarget(
      makeClient(),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      THREAD,
      'post-in-thread',
    );
    expect(resolved).toMatchObject({ ok: true, channelId: THREAD, isThread: true });
  });

  it('a private thread without its own row inherits its allowlisted parent', async () => {
    allow(CHANNEL);
    const resolved = await resolveSendTarget(
      makeClient(),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      PRIVATE_THREAD,
      'post-in-thread',
    );
    expect(resolved).toMatchObject({
      ok: true,
      channelId: PRIVATE_THREAD,
      isPrivateThread: true,
      derivedGrant: true,
    });
  });

  it('a private thread with no grant anywhere is refused as not-in-send-scope', async () => {
    const resolved = await resolveSendTarget(
      makeClient(),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      PRIVATE_THREAD,
      'post-in-thread',
    );
    expect(resolved).toEqual({ ok: false, reason: 'not-in-send-scope' });
  });

  it('a private thread with its own row passes', async () => {
    allow(CHANNEL);
    allow(PRIVATE_THREAD);
    const resolved = await resolveSendTarget(
      makeClient(),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      PRIVATE_THREAD,
      'post-in-thread',
    );
    expect(resolved).toMatchObject({ ok: true, channelId: PRIVATE_THREAD, isPrivateThread: true });
  });

  it('a channel under a Write category grant passes with a derived grant', async () => {
    allowCategory(CATEGORY);
    const resolved = await resolveSendTarget(
      makeClient(),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      CATCHANNEL,
      'post',
    );
    expect(resolved).toMatchObject({
      ok: true,
      channelId: CATCHANNEL,
      grantId: CATEGORY,
      derivedGrant: true,
    });
  });

  it('a target under an excluded category is refused as not-in-send-scope', async () => {
    // The channel's own Write row cannot beat the category exclusion:
    // No access overrides every grant.
    allow(CATCHANNEL);
    loggingRepo.excludeChannel(t.scopes.forGuild(GUILD_A), CATEGORY);
    const resolved = await resolveSendTarget(
      makeClient(),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      CATCHANNEL,
      'post',
    );
    expect(resolved).toEqual({ ok: false, reason: 'not-in-send-scope' });
  });

  it('a private thread under an excluded parent is refused as not-in-send-scope', async () => {
    // The parent's Write grant cannot beat the parent exclusion either.
    allow(CHANNEL);
    loggingRepo.excludeChannel(t.scopes.forGuild(GUILD_A), CHANNEL);
    const resolved = await resolveSendTarget(
      makeClient(),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      PRIVATE_THREAD,
      'post-in-thread',
    );
    expect(resolved).toEqual({ ok: false, reason: 'not-in-send-scope' });
  });

  it('an excluded channel is refused as not-in-send-scope', async () => {
    allow(CHANNEL);
    loggingRepo.excludeChannel(t.scopes.forGuild(GUILD_A), CHANNEL);
    const resolved = await resolveSendTarget(
      makeClient(),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      CHANNEL,
      'post',
    );
    expect(resolved).toEqual({ ok: false, reason: 'not-in-send-scope' });
  });

  it('a channel without any granting row is refused as not-in-send-scope', async () => {
    const resolved = await resolveSendTarget(
      makeClient(),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      OTHER_CHANNEL,
      'post',
    );
    expect(resolved).toEqual({ ok: false, reason: 'not-in-send-scope' });
  });

  it('a channel of another guild is refused as not-in-guild', async () => {
    allow(CHANNEL);
    const resolved = await resolveSendTarget(
      makeClient(),
      t.scopes.forGuild(GUILD_B),
      GUILD_B,
      CHANNEL,
      'post',
    );
    expect(resolved).toEqual({ ok: false, reason: 'not-in-guild' });
  });

  it('a channel the client never saw is refused as not-in-guild', async () => {
    const resolved = await resolveSendTarget(
      makeClient(),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      MISSING_CHANNEL,
      'post',
    );
    expect(resolved).toEqual({ ok: false, reason: 'not-in-guild' });
  });

  it('a channel the bot cannot send in is refused naming SendMessages', async () => {
    allow(NO_SEND_CHANNEL);
    const resolved = await resolveSendTarget(
      makeClient({ denySendOn: [NO_SEND_CHANNEL] }),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      NO_SEND_CHANNEL,
      'post',
    );
    expect(resolved).toEqual({
      ok: false,
      reason: 'bot-lacks-permission',
      missing: 'SendMessages',
    });
  });

  it('pin passes with PinMessages alone', async () => {
    allow(CHANNEL);
    const client = makeClient({
      botPermissions:
        PermissionsBitField.Flags.ViewChannel |
        PermissionsBitField.Flags.SendMessages |
        PermissionsBitField.Flags.PinMessages,
    });
    const resolved = await resolveSendTarget(
      client,
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      CHANNEL,
      'pin',
    );
    expect(resolved).toMatchObject({ ok: true, channelId: CHANNEL });
  });

  it('pin passes with ManageMessages alone', async () => {
    allow(CHANNEL);
    const client = makeClient({
      botPermissions:
        PermissionsBitField.Flags.ViewChannel |
        PermissionsBitField.Flags.SendMessages |
        PermissionsBitField.Flags.ManageMessages,
    });
    const resolved = await resolveSendTarget(
      client,
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      CHANNEL,
      'pin',
    );
    expect(resolved).toMatchObject({ ok: true, channelId: CHANNEL });
  });
});

describe('resolvePings', () => {
  it('no pings passes with empty lists and reads nothing live', async () => {
    const resolved = await resolvePings(makeClient(), t.scopes.forGuild(GUILD_A), GUILD_A, {
      roles: [],
      users: [],
    });
    expect(resolved).toEqual({ ok: true, roleIds: [], userIds: [] });
  });

  it('a role below the bot passes, by id and by name', async () => {
    const client = makeClient({ roles: defaultRoles() });
    const scope = t.scopes.forGuild(GUILD_A);
    expect(await resolvePings(client, scope, GUILD_A, { roles: [LOW_ROLE], users: [] })).toEqual({
      ok: true,
      roleIds: [LOW_ROLE],
      userIds: [],
    });
    expect(await resolvePings(client, scope, GUILD_A, { roles: ['helpers'], users: [] })).toEqual({
      ok: true,
      roleIds: [LOW_ROLE],
      userIds: [],
    });
  });

  it('the floor is live: a role below the bot passes, then gains ManageRoles in the cache and is refused', async () => {
    const client = makeClient({ roles: defaultRoles() });
    const scope = t.scopes.forGuild(GUILD_A);
    expect(
      await resolvePings(client, scope, GUILD_A, { roles: [LOW_ROLE], users: [] }),
    ).toMatchObject({
      ok: true,
    });
    const guild = client.guilds.cache.get(GUILD_A);
    const role = guild?.roles.cache.get(LOW_ROLE) as unknown as {
      permissions: PermissionsBitField;
    };
    role.permissions = new PermissionsBitField(PermissionsBitField.Flags.ManageRoles);
    expect(await resolvePings(client, scope, GUILD_A, { roles: [LOW_ROLE], users: [] })).toEqual({
      ok: false,
      reason: 'role-dangerous',
      ref: LOW_ROLE,
    });
  });

  it('a role above the bot is refused', async () => {
    const resolved = await resolvePings(
      makeClient({ roles: defaultRoles() }),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      { roles: [HIGH_ROLE], users: [] },
    );
    expect(resolved).toEqual({ ok: false, reason: 'role-above-bot', ref: HIGH_ROLE });
  });

  it.each([[MANAGED_ROLE], [GUILD_A]])(
    'managed and @everyone roles are refused (%s)',
    async (id) => {
      const resolved = await resolvePings(
        makeClient({ roles: defaultRoles() }),
        t.scopes.forGuild(GUILD_A),
        GUILD_A,
        { roles: [id], users: [] },
      );
      expect(resolved).toEqual({ ok: false, reason: 'role-managed-or-everyone', ref: id });
    },
  );

  it('an unknown role is refused', async () => {
    const resolved = await resolvePings(
      makeClient({ roles: defaultRoles() }),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      { roles: ['no-such-role'], users: [] },
    );
    expect(resolved).toEqual({ ok: false, reason: 'role-unknown', ref: 'no-such-role' });
  });

  it('allowlist mode without a row refuses, with a row passes', async () => {
    const scope = t.scopes.forGuild(GUILD_A);
    t.raw.exec(
      `INSERT INTO mcp_role_policy (guild_id, grant_mode, ping_mode, updated_at) VALUES ('${GUILD_A}', 'below-bot', 'allowlist', ${String(NOW)})`,
    );
    const client = makeClient({ roles: defaultRoles() });
    expect(await resolvePings(client, scope, GUILD_A, { roles: [LOW_ROLE], users: [] })).toEqual({
      ok: false,
      reason: 'role-not-allowlisted',
      ref: LOW_ROLE,
    });
    t.raw.exec(
      `INSERT INTO mcp_role_allowlist (guild_id, role_id, purpose, added_by_account_id, added_at) VALUES ('${GUILD_A}', '${LOW_ROLE}', 'ping', '${ACCOUNT}', ${String(NOW)})`,
    );
    expect(await resolvePings(client, scope, GUILD_A, { roles: [LOW_ROLE], users: [] })).toEqual({
      ok: true,
      roleIds: [LOW_ROLE],
      userIds: [],
    });
  });

  it('a current member passes as a user ping', async () => {
    const resolved = await resolvePings(
      makeClient({ members: [{ id: MEMBER_USER, roles: [] }] }),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      { roles: [], users: [MEMBER_USER] },
    );
    expect(resolved).toEqual({ ok: true, roleIds: [], userIds: [MEMBER_USER] });
  });

  it('a user not in the guild is refused after one live lookup answered Unknown Member', async () => {
    const client = makeClient({ members: [{ id: MEMBER_USER, roles: [] }] });
    const guild = client.guilds.cache.get(GUILD_A);
    if (guild === undefined) throw new Error('guild missing from test client cache');
    // A cache miss proves nothing (the cache caps at fifty), so the miss path
    // makes exactly one live fetch; Discord's 10007 answer means not a member.
    let fetches = 0;
    guild.members.fetch = (() => {
      fetches += 1;
      return Promise.reject(
        Object.assign(new Error('Unknown Member'), { code: 10007, status: 404 }),
      );
    }) as typeof guild.members.fetch;
    const resolved = await resolvePings(client, t.scopes.forGuild(GUILD_A), GUILD_A, {
      roles: [],
      users: [STRANGER_USER],
    });
    expect(resolved).toEqual({ ok: false, reason: 'user-not-member', ref: STRANGER_USER });
    expect(fetches).toBe(1);
  });

  it('a transport fault on the membership lookup throws instead of refusing as not-a-member', async () => {
    const client = makeClient({ members: [{ id: MEMBER_USER, roles: [] }] });
    const guild = client.guilds.cache.get(GUILD_A);
    if (guild === undefined) throw new Error('guild missing from test client cache');
    guild.members.fetch = (() =>
      Promise.reject(new Error('connection reset'))) as typeof guild.members.fetch;
    await expect(
      resolvePings(client, t.scopes.forGuild(GUILD_A), GUILD_A, {
        roles: [],
        users: [STRANGER_USER],
      }),
    ).rejects.toThrow('connection reset');
  });
});

describe('checkRolePing', () => {
  it('passes a role below the bot with its resolved id', () => {
    expect(
      checkRolePing(
        makeClient({ roles: defaultRoles() }),
        t.scopes.forGuild(GUILD_A),
        GUILD_A,
        LOW_ROLE,
      ),
    ).toEqual({ ok: true, id: LOW_ROLE });
  });

  it('refuses a role above the bot with the same reason resolvePings reports', () => {
    expect(
      checkRolePing(
        makeClient({ roles: defaultRoles() }),
        t.scopes.forGuild(GUILD_A),
        GUILD_A,
        HIGH_ROLE,
      ),
    ).toEqual({ ok: false, reason: 'role-above-bot', ref: HIGH_ROLE, id: HIGH_ROLE });
  });

  it('reports an unknown ref as role-unknown', () => {
    expect(
      checkRolePing(
        makeClient({ roles: defaultRoles() }),
        t.scopes.forGuild(GUILD_A),
        GUILD_A,
        'no-such-role',
      ),
    ).toEqual({ ok: false, reason: 'role-unknown', ref: 'no-such-role', id: 'no-such-role' });
  });
});

describe('filterPings', () => {
  const fetchUnknownMember = (client: Client): { fetches: () => number } => {
    const guild = client.guilds.cache.get(GUILD_A);
    if (guild === undefined) throw new Error('guild missing from test client cache');
    let fetches = 0;
    guild.members.fetch = (() => {
      fetches += 1;
      return Promise.reject(
        Object.assign(new Error('Unknown Member'), { code: 10007, status: 404 }),
      );
    }) as typeof guild.members.fetch;
    return { fetches: () => fetches };
  };

  it('keeps the pingable roles and users, dropping each refusal with its reason', async () => {
    const client = makeClient({
      roles: defaultRoles(),
      members: [{ id: MEMBER_USER, roles: [] }],
    });
    const counted = fetchUnknownMember(client);
    const filtered = await filterPings(client, t.scopes.forGuild(GUILD_A), GUILD_A, {
      roles: [LOW_ROLE, LOW_ROLE, HIGH_ROLE, MANAGED_ROLE, 'no-such-role'],
      users: [MEMBER_USER, MEMBER_USER, STRANGER_USER],
    });
    expect(filtered.roleIds).toEqual([LOW_ROLE]);
    expect(filtered.userIds).toEqual([MEMBER_USER]);
    expect(filtered.dropped).toEqual([
      { kind: 'role', id: HIGH_ROLE, reason: 'role-above-bot' },
      { kind: 'role', id: MANAGED_ROLE, reason: 'role-managed-or-everyone' },
      { kind: 'role', id: 'no-such-role', reason: 'role-unknown' },
      { kind: 'user', id: STRANGER_USER, reason: 'user-not-member' },
    ]);
    expect(counted.fetches()).toBe(1);
  });

  it('drops a role that turned dangerous after scheduling, keeping the rest', async () => {
    const client = makeClient({ roles: defaultRoles() });
    const scope = t.scopes.forGuild(GUILD_A);
    expect(await filterPings(client, scope, GUILD_A, { roles: [LOW_ROLE], users: [] })).toEqual({
      roleIds: [LOW_ROLE],
      userIds: [],
      dropped: [],
    });
    const guild = client.guilds.cache.get(GUILD_A);
    const role = guild?.roles.cache.get(LOW_ROLE) as unknown as {
      permissions: PermissionsBitField;
    };
    role.permissions = new PermissionsBitField(PermissionsBitField.Flags.ManageRoles);
    expect(await filterPings(client, scope, GUILD_A, { roles: [LOW_ROLE], users: [] })).toEqual({
      roleIds: [],
      userIds: [],
      dropped: [{ kind: 'role', id: LOW_ROLE, reason: 'role-dangerous' }],
    });
  });

  it('passes empty pings through with no drops', async () => {
    await expect(
      filterPings(makeClient(), t.scopes.forGuild(GUILD_A), GUILD_A, { roles: [], users: [] }),
    ).resolves.toEqual({ roleIds: [], userIds: [], dropped: [] });
  });

  it('uses the row guild only: roles of another guild are unknown there', async () => {
    const filtered = await filterPings(
      makeClient({ roles: defaultRoles() }),
      t.scopes.forGuild(GUILD_B),
      GUILD_B,
      { roles: [LOW_ROLE], users: [] },
    );
    expect(filtered.roleIds).toEqual([]);
    expect(filtered.dropped).toEqual([{ kind: 'role', id: LOW_ROLE, reason: 'role-unknown' }]);
  });

  it('a transport fault on the membership lookup throws instead of dropping', async () => {
    const client = makeClient({ members: [{ id: MEMBER_USER, roles: [] }] });
    const guild = client.guilds.cache.get(GUILD_A);
    if (guild === undefined) throw new Error('guild missing from test client cache');
    guild.members.fetch = (() =>
      Promise.reject(new Error('connection reset'))) as typeof guild.members.fetch;
    await expect(
      filterPings(client, t.scopes.forGuild(GUILD_A), GUILD_A, {
        roles: [],
        users: [STRANGER_USER],
      }),
    ).rejects.toThrow('connection reset');
  });
});

describe('resolveSendTarget with need manage-events', () => {
  const VOICE = '477777777777777777';
  const TEXT = '488888888888888888';

  const voicePayload = (id: string): object => ({
    id,
    guild_id: GUILD_A,
    type: ChannelType.GuildVoice,
    name: `voice-${id}`,
    position: 0,
    permission_overwrites: [],
  });

  const makeEventClient = (botPermissions: bigint): Client => {
    const client = new Client(buildClientOptions(() => BOT));
    const mutable = client as unknown as { user: unknown };
    const internals = client as unknown as {
      guilds: { _add: (data: object) => unknown };
      users: { _add: (data: object) => unknown };
    };
    mutable.user = internals.users._add({ id: BOT, username: 'bananasaurs', discriminator: '0' });
    internals.guilds._add({
      id: GUILD_A,
      name: 'guild a',
      owner_id: '345678901234567890',
      channels: [voicePayload(VOICE), textPayload(TEXT)],
      roles: [
        { id: GUILD_A, name: '@everyone', position: 0, permissions: '0', managed: false },
        {
          id: BOT_ROLE,
          name: 'bananasaurs',
          position: 7,
          permissions: botPermissions.toString(),
          managed: true,
        },
      ],
      members: [
        { user: { id: BOT, username: 'bananasaurs', discriminator: '0' }, roles: [BOT_ROLE] },
      ],
      emojis: [],
      unavailable: false,
    });
    return client;
  };

  const withManageEvents =
    PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.ManageEvents;
  const withoutManageEvents = PermissionsBitField.Flags.ViewChannel;

  it('an allowlisted voice channel passes with need manage-events', async () => {
    allow(VOICE);
    const resolved = await resolveSendTarget(
      makeEventClient(withManageEvents),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      VOICE,
      'manage-events',
    );
    expect(resolved).toMatchObject({ ok: true, channelId: VOICE });
  });

  it('a voice channel without ManageEvents is refused naming the permission', async () => {
    allow(VOICE);
    const resolved = await resolveSendTarget(
      makeEventClient(withoutManageEvents),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      VOICE,
      'manage-events',
    );
    expect(resolved).toEqual({
      ok: false,
      reason: 'bot-lacks-permission',
      missing: 'ManageEvents',
    });
  });

  it('a voice channel without any granting row is refused as not-in-send-scope', async () => {
    const resolved = await resolveSendTarget(
      makeEventClient(withManageEvents),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      VOICE,
      'manage-events',
    );
    expect(resolved).toEqual({ ok: false, reason: 'not-in-send-scope' });
  });

  it('a voice channel the client never saw is refused as not-in-guild', async () => {
    const resolved = await resolveSendTarget(
      makeEventClient(withManageEvents),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      MISSING_CHANNEL,
      'manage-events',
    );
    expect(resolved).toEqual({ ok: false, reason: 'not-in-guild' });
  });

  it('the target layer does not check the voice-or-stage rule: a text channel passes and the event wiring refuses it', async () => {
    // The voice-or-stage type check lives in the daemon's event wiring
    // (which reads the live channel type); the target layer only owns send
    // scope and the live permission, so an allowlisted text channel with the
    // permission passes here.
    allow(TEXT);
    const resolved = await resolveSendTarget(
      makeEventClient(withManageEvents),
      t.scopes.forGuild(GUILD_A),
      GUILD_A,
      TEXT,
      'manage-events',
    );
    expect(resolved).toMatchObject({ ok: true, channelId: TEXT });
  });
});

describe('textMentions (ADR 0128)', () => {
  it('reads user, nickname-form and role mentions, in order and without repeats', () => {
    expect(
      textMentions(
        `hi <@${MEMBER_USER}> and <@!${STRANGER_USER}>, <@&${LOW_ROLE}> again <@${MEMBER_USER}>`,
      ),
    ).toEqual({ users: [MEMBER_USER, STRANGER_USER], roles: [LOW_ROLE] });
  });

  it('skips mentions inside inline code and fenced blocks, which Discord never pings', () => {
    expect(
      textMentions(
        `\`<@${STRANGER_USER}>\` then\n\`\`\`\n<@&${LOW_ROLE}>\n\`\`\`\n<@${MEMBER_USER}>`,
      ),
    ).toEqual({ users: [MEMBER_USER], roles: [] });
  });

  it('ignores @everyone, @here, channel mentions, bare ids and absent text', () => {
    expect(textMentions(`@everyone @here <#${CHANNEL}> ${MEMBER_USER} <@abc>`)).toEqual({
      users: [],
      roles: [],
    });
    expect(textMentions(undefined)).toEqual({ users: [], roles: [] });
  });
});

describe('resolveSendPings (ADR 0128)', () => {
  /** Every lookup outside the cache answers Discord's Unknown Member. */
  const strangersUnknown = (client: Client): Client => {
    const guild = client.guilds.cache.get(GUILD_A);
    if (guild === undefined) throw new Error('guild missing from test client cache');
    guild.members.fetch = (() =>
      Promise.reject(
        Object.assign(new Error('Unknown Member'), { code: 10007, status: 404 }),
      )) as typeof guild.members.fetch;
    return client;
  };

  it('a member and a pingable role mentioned in the text ping with no explicit lists', async () => {
    const client = strangersUnknown(
      makeClient({ roles: defaultRoles(), members: [{ id: MEMBER_USER, roles: [] }] }),
    );
    expect(
      await resolveSendPings(client, t.scopes.forGuild(GUILD_A), GUILD_A, {
        roles: [],
        users: [],
        text: `<@${MEMBER_USER}> and <@&${LOW_ROLE}> please look`,
      }),
    ).toEqual({ ok: true, userIds: [MEMBER_USER], roleIds: [LOW_ROLE], notPinged: [] });
  });

  it('text mentions that fail a check are reported, not pinged, and do not refuse', async () => {
    const client = strangersUnknown(
      makeClient({ roles: defaultRoles(), members: [{ id: MEMBER_USER, roles: [] }] }),
    );
    expect(
      await resolveSendPings(client, t.scopes.forGuild(GUILD_A), GUILD_A, {
        roles: [],
        users: [],
        text: `<@${STRANGER_USER}> <@&${HIGH_ROLE}> <@&${MANAGED_ROLE}> <@&${GUILD_A}> <@${MEMBER_USER}>`,
      }),
    ).toEqual({
      ok: true,
      userIds: [MEMBER_USER],
      roleIds: [],
      notPinged: [
        { kind: 'role', id: HIGH_ROLE, reason: 'role-above-bot' },
        { kind: 'role', id: MANAGED_ROLE, reason: 'role-managed-or-everyone' },
        { kind: 'role', id: GUILD_A, reason: 'role-managed-or-everyone' },
        { kind: 'user', id: STRANGER_USER, reason: 'user-not-member' },
      ],
    });
  });

  it('a dangerous role mentioned in the text is never pinged', async () => {
    const roles = [{ id: LOW_ROLE, name: 'helpers', position: 3, permissions: '8' }];
    expect(
      await resolveSendPings(makeClient({ roles }), t.scopes.forGuild(GUILD_A), GUILD_A, {
        roles: [],
        users: [],
        text: `<@&${LOW_ROLE}>`,
      }),
    ).toEqual({
      ok: true,
      userIds: [],
      roleIds: [],
      notPinged: [{ kind: 'role', id: LOW_ROLE, reason: 'role-dangerous' }],
    });
  });

  it('explicit pings stay strict: a bad explicit ping refuses the call', async () => {
    const client = strangersUnknown(makeClient({ roles: defaultRoles() }));
    expect(
      await resolveSendPings(client, t.scopes.forGuild(GUILD_A), GUILD_A, {
        roles: [HIGH_ROLE],
        users: [],
        text: 'no mentions',
      }),
    ).toEqual({ ok: false, reason: 'role-above-bot', ref: HIGH_ROLE });
  });

  it('explicit and text pings merge without repeats, explicit first', async () => {
    const client = makeClient({ roles: defaultRoles(), members: [{ id: MEMBER_USER, roles: [] }] });
    expect(
      await resolveSendPings(client, t.scopes.forGuild(GUILD_A), GUILD_A, {
        roles: ['helpers'],
        users: [MEMBER_USER],
        text: `<@${MEMBER_USER}> <@&${LOW_ROLE}>`,
      }),
    ).toEqual({ ok: true, userIds: [MEMBER_USER], roleIds: [LOW_ROLE], notPinged: [] });
  });

  it('a transport fault on a text mention lookup is reported, never thrown', async () => {
    const client = makeClient({ members: [{ id: MEMBER_USER, roles: [] }] });
    const guild = client.guilds.cache.get(GUILD_A);
    if (guild === undefined) throw new Error('guild missing from test client cache');
    guild.members.fetch = (() =>
      Promise.reject(new Error('connection reset'))) as typeof guild.members.fetch;
    expect(
      await resolveSendPings(client, t.scopes.forGuild(GUILD_A), GUILD_A, {
        roles: [],
        users: [],
        text: `<@${STRANGER_USER}> <@${MEMBER_USER}>`,
      }),
    ).toEqual({
      ok: true,
      roleIds: [],
      userIds: [MEMBER_USER],
      notPinged: [{ kind: 'user', id: STRANGER_USER, reason: 'member-check-failed' }],
    });
  });

  it('mentions past the cap cost no lookup', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `8${String(i).padStart(17, '0')}`);
    const client = makeClient();
    const guild = client.guilds.cache.get(GUILD_A);
    if (guild === undefined) throw new Error('guild missing from test client cache');
    let fetches = 0;
    guild.members.fetch = (() => {
      fetches += 1;
      return Promise.resolve({});
    }) as unknown as typeof guild.members.fetch;
    const resolved = await resolveSendPings(client, t.scopes.forGuild(GUILD_A), GUILD_A, {
      roles: [],
      users: [],
      text: ids.map((id) => `<@${id}>`).join(' '),
    });
    expect(resolved).toMatchObject({ ok: true, userIds: ids.slice(0, 25) });
    expect(fetches).toBe(25);
  });

  it('text mentions past the 25-user cap are reported as over-cap, not pinged', async () => {
    const ids = Array.from({ length: 27 }, (_, i) => `7${String(i).padStart(17, '0')}`);
    const client = makeClient({ members: ids.map((id) => ({ id, roles: [] })) });
    const resolved = await resolveSendPings(client, t.scopes.forGuild(GUILD_A), GUILD_A, {
      roles: [],
      users: [ids[0] ?? ''],
      text: ids.map((id) => `<@${id}>`).join(' '),
    });
    expect(resolved).toEqual({
      ok: true,
      roleIds: [],
      userIds: ids.slice(0, 25),
      notPinged: ids.slice(25).map((id) => ({ kind: 'user', id, reason: 'over-cap' })),
    });
  });
});
