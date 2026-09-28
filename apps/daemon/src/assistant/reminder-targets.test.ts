import { ChannelType, PermissionsBitField } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveReminderTargets,
  type ReminderTargetGuild,
  type ReminderTargetMember,
  type ReminderTargetRequest,
} from './reminder-targets.js';

const permission = PermissionsBitField.Flags;
const all = permission.ViewChannel | permission.SendMessages | permission.MentionEveryone;
const channel = (
  id: string,
  name: string,
  { text = true, thread = false, type = ChannelType.GuildText } = {},
) => ({
  id,
  name,
  type,
  isTextBased: () => text,
  isThread: () => thread,
});
const member = (
  id: string,
  displayName: string,
  username = displayName,
  allowed = all,
): ReminderTargetMember => ({
  id,
  displayName,
  user: { username },
  permissionsIn: () => ({ has: (requested: bigint) => (allowed & requested) === requested }),
});

const makeGuild = (
  overrides: {
    channels?: ReturnType<typeof channel>[];
    members?: ReminderTargetMember[];
    roles?: { id: string; name: string; mentionable: boolean }[];
    asker?: ReminderTargetMember;
    me?: ReminderTargetMember | null;
    fetch?: (id: string) => Promise<ReminderTargetMember>;
    search?: (options: {
      query: string;
      limit: number;
    }) => Promise<ReadonlyMap<string, ReminderTargetMember>>;
    visibleChannelIds?: readonly string[];
  } = {},
): ReminderTargetGuild => {
  const channels = overrides.channels ?? [channel('10000000000000001', 'general')];
  const members = overrides.members ?? [member('20000000000000001', 'Alex', 'alex')];
  const asker = overrides.asker ?? member('30000000000000001', 'Asker');
  const visibleChannelIds = overrides.visibleChannelIds;
  const withChannelPermissions = (target: ReminderTargetMember) => ({
    ...target,
    permissionsIn: (targetChannel: { readonly id: string }) => {
      const permissions = target.permissionsIn(targetChannel);
      return {
        has: (requested: bigint) =>
          permissions.has(requested) &&
          (requested !== permission.ViewChannel ||
            visibleChannelIds === undefined ||
            visibleChannelIds.includes(targetChannel.id)),
      };
    },
  });
  const memberCache = new Map(members.map((entry) => [entry.id, entry]));
  return {
    channels: { cache: new Map(channels.map((entry) => [entry.id, entry])) },
    roles: {
      cache: new Map(
        (overrides.roles ?? [{ id: '40000000000000001', name: 'Execs', mentionable: true }]).map(
          (role) => [role.id, role],
        ),
      ),
    },
    members: {
      me:
        overrides.me === null
          ? null
          : withChannelPermissions(overrides.me ?? member('50000000000000001', 'Bot')),
      cache: memberCache,
      fetch:
        overrides.fetch ??
        (async (id) => withChannelPermissions((id === asker.id ? asker : memberCache.get(id))!)),
      search:
        overrides.search ??
        (async (options: { query: string; limit: number }) => {
          const matches = [...memberCache.values()].filter(
            (entry) =>
              entry.displayName.toLowerCase().startsWith(options.query.toLowerCase()) ||
              entry.user.username.toLowerCase().startsWith(options.query.toLowerCase()),
          );
          return new Map(matches.slice(0, options.limit).map((entry) => [entry.id, entry]));
        }),
    },
  };
};

const request = (overrides: Partial<ReminderTargetRequest> = {}): ReminderTargetRequest => ({
  askerId: '30000000000000001',
  currentChannelId: '10000000000000001',
  members: [],
  roles: [],
  ...overrides,
});

const ok = (result: Awaited<ReturnType<typeof resolveReminderTargets>>) => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.problem);
  return result.targets;
};

describe('resolveReminderTargets', () => {
  it.each(['10000000000000001', '<#10000000000000001>', '#general', 'general'])(
    'resolves channel form %s',
    async (target) => {
      expect(
        ok(await resolveReminderTargets(makeGuild(), request({ channel: target }))).channelId,
      ).toBe('10000000000000001');
    },
  );

  it('defaults to currentChannelId', async () => {
    const targets = ok(await resolveReminderTargets(makeGuild(), request()));
    expect(targets.channelId).toBe('10000000000000001');
  });

  it('resolves channel names case-insensitively and reports missing or ambiguous channels', async () => {
    const guild = makeGuild({
      channels: [
        channel('10000000000000001', 'General'),
        channel('10000000000000002', 'general-2'),
      ],
    });
    expect(
      ok(await resolveReminderTargets(guild, request({ channel: 'GENERAL' }))).channelName,
    ).toBe('General');
    expect(await resolveReminderTargets(guild, request({ channel: 'unknown' }))).toEqual({
      ok: false,
      problem: `I can't find a channel called "unknown".`,
    });
    const ambiguousGuild = makeGuild({
      channels: [channel('10000000000000001', 'general'), channel('10000000000000002', 'GENERAL')],
    });
    await expect(
      resolveReminderTargets(ambiguousGuild, request({ channel: 'general' })),
    ).resolves.toMatchObject({
      ok: false,
      problem:
        '"general" matches more than one channel: general (10000000000000001), GENERAL (10000000000000002).',
    });
  });

  it.each(['general', '10000000000000001', '<#10000000000000001>'])(
    'does not disclose an invisible channel when requested by %s',
    async (target) => {
      const guild = makeGuild({ visibleChannelIds: [] });
      await expect(resolveReminderTargets(guild, request({ channel: target }))).resolves.toEqual({
        ok: false,
        problem: `I can't find a channel called "${target}".`,
      });
    },
  );

  it('omits invisible channels from ambiguity candidates', async () => {
    const guild = makeGuild({
      channels: [channel('10000000000000001', 'general'), channel('10000000000000002', 'GENERAL')],
      visibleChannelIds: ['10000000000000001'],
    });
    expect(ok(await resolveReminderTargets(guild, request({ channel: 'general' }))).channelId).toBe(
      '10000000000000001',
    );
  });

  it('filters channel types before deciding name matches', async () => {
    // A real discord.js voice channel reports `isTextBased() === true`
    // (it carries a `messages` manager); only the type excludes it.
    const guild = makeGuild({
      channels: [
        channel('10000000000000002', 'General', { text: true, type: ChannelType.GuildVoice }),
        channel('10000000000000001', 'general'),
      ],
    });
    expect(
      ok(await resolveReminderTargets(guild, request({ channel: '#general' }))).channelId,
    ).toBe('10000000000000001');
    await expect(
      resolveReminderTargets(
        makeGuild({
          channels: [
            channel('10000000000000002', 'voice', { text: true, type: ChannelType.GuildVoice }),
          ],
        }),
        request({ channel: 'voice' }),
      ),
    ).resolves.toEqual({ ok: false, problem: "I can't post reminders in #voice." });
  });

  it('does not disclose a channel when the bot cannot view it', async () => {
    const guild = makeGuild({
      me: member('50000000000000001', 'Bot', 'Bot', permission.SendMessages),
    });
    await expect(resolveReminderTargets(guild, request())).resolves.toEqual({
      ok: false,
      problem: "I don't have permission to send messages in #general.",
    });
  });

  it('truncates channel ambiguity candidates to five', async () => {
    const channels = Array.from({ length: 6 }, (_, index) =>
      channel(`1000000000000000${index + 1}`, 'general'),
    );
    const result = await resolveReminderTargets(
      makeGuild({ channels }),
      request({ channel: 'general' }),
    );
    expect(result).toMatchObject({
      ok: false,
      problem: expect.stringContaining('general (10000000000000005).'),
    });
    if (!result.ok) expect(result.problem).not.toContain('10000000000000006');
  });

  it.each(['20000000000000001', '<@20000000000000001>', '<@!20000000000000001>', 'Alex', '@Alex'])(
    'resolves member form %s',
    async (target) => {
      const targets = ok(await resolveReminderTargets(makeGuild(), request({ members: [target] })));
      expect(targets.mentions.userIds).toEqual(['20000000000000001']);
      expect(targets.memberNames).toEqual(['Alex']);
    },
  );

  it.each(['40000000000000001', '<@&40000000000000001>', 'Execs', '@Execs'])(
    'resolves role form %s',
    async (target) => {
      const targets = ok(await resolveReminderTargets(makeGuild(), request({ roles: [target] })));
      expect(targets.mentions.roleIds).toEqual(['40000000000000001']);
      expect(targets.roleNames).toEqual(['Execs']);
    },
  );

  it('resolves names case-insensitively and reports missing or ambiguous members and roles', async () => {
    const guild = makeGuild({
      members: [
        member('20000000000000001', 'Alex', 'alex'),
        member('20000000000000002', 'Alex', 'other'),
      ],
      roles: [
        { id: '40000000000000001', name: 'Execs', mentionable: true },
        { id: '40000000000000002', name: 'execs', mentionable: true },
      ],
    });
    await expect(
      resolveReminderTargets(guild, request({ members: ['missing'] })),
    ).resolves.toMatchObject({
      ok: false,
      problem: `I can't find a member called "missing".`,
    });
    await expect(
      resolveReminderTargets(guild, request({ members: ['Alex'] })),
    ).resolves.toMatchObject({
      ok: false,
      problem:
        '"Alex" matches more than one member: Alex (20000000000000001), Alex (20000000000000002).',
    });
    await expect(
      resolveReminderTargets(guild, request({ roles: ['missing'] })),
    ).resolves.toMatchObject({
      ok: false,
      problem: `I can't find a role called "missing".`,
    });
    await expect(
      resolveReminderTargets(guild, request({ roles: ['Execs'] })),
    ).resolves.toMatchObject({
      ok: false,
      problem:
        '"Execs" matches more than one role: Execs (40000000000000001), execs (40000000000000002).',
    });
  });

  it('prefers display-name matches over username matches across cache and search', async () => {
    const displayMatch = member('20000000000000001', 'Sam', 'different');
    const usernameMatch = member('20000000000000002', 'Different', 'sam');
    const guild = makeGuild({
      members: [usernameMatch],
      search: async () => new Map([[displayMatch.id, displayMatch]]),
    });
    const targets = ok(await resolveReminderTargets(guild, request({ members: ['Sam'] })));
    expect(targets.mentions.userIds).toEqual([displayMatch.id]);
  });

  it('checks asker and bot send permissions in the target channel', async () => {
    const noSend = permission.ViewChannel;
    await expect(
      resolveReminderTargets(
        makeGuild({ asker: member('30000000000000001', 'Asker', 'Asker', noSend) }),
        request(),
      ),
    ).resolves.toMatchObject({
      ok: false,
      problem: "You can't send messages in #general, so I can't post a reminder there.",
    });
    await expect(
      resolveReminderTargets(
        makeGuild({ me: member('50000000000000001', 'Bot', 'Bot', noSend) }),
        request(),
      ),
    ).resolves.toMatchObject({
      ok: false,
      problem: "I don't have permission to send messages in #general.",
    });
  });

  it('requires MentionEveryone only for everyone, here, or non-mentionable roles', async () => {
    const noMention = permission.ViewChannel | permission.SendMessages;
    const guild = makeGuild({
      roles: [{ id: '40000000000000001', name: 'Execs', mentionable: true }],
    });
    expect((await resolveReminderTargets(guild, request({ roles: ['Execs'] }))).ok).toBe(true);
    const restricted = makeGuild({
      asker: member('30000000000000001', 'Asker', 'Asker', noMention),
      roles: [{ id: '40000000000000001', name: 'Execs', mentionable: false }],
    });
    await expect(
      resolveReminderTargets(restricted, request({ roles: ['Execs'] })),
    ).resolves.toMatchObject({
      ok: false,
      problem:
        'Pinging @everyone, @here or the Execs role needs the Mention Everyone permission in #general.',
    });
    const permitted = makeGuild({
      asker: member('30000000000000001', 'Asker'),
      roles: [{ id: '40000000000000001', name: 'Execs', mentionable: false }],
    });
    expect((await resolveReminderTargets(permitted, request({ roles: ['Execs'] }))).ok).toBe(true);
  });

  it.each([
    ['@everyone', true, false],
    ['here', false, true],
  ] as const)('sets the %s flag and checks MentionEveryone', async (value, everyone, here) => {
    const noMention = makeGuild({
      asker: member(
        '30000000000000001',
        'Asker',
        'Asker',
        permission.ViewChannel | permission.SendMessages,
      ),
    });
    await expect(
      resolveReminderTargets(noMention, request({ roles: [value] })),
    ).resolves.toMatchObject({ ok: false });
    const targets = ok(await resolveReminderTargets(makeGuild(), request({ roles: [value] })));
    expect(targets.mentions).toMatchObject({ everyone, here });
  });

  it('enforces member and role limits and deduplicates in first-seen order', async () => {
    const tooManyMembers = Array.from({ length: 26 }, (_, index) =>
      member(`20000000000000${100 + index}`, `Member${index}`),
    );
    expect(
      await resolveReminderTargets(
        makeGuild({ members: tooManyMembers }),
        request({ members: tooManyMembers.map((entry) => entry.id) }),
      ),
    ).toMatchObject({
      ok: false,
      problem: "That's more than 25 people for one reminder.",
    });
    const tooManyRoles = Array.from({ length: 11 }, (_, index) => ({
      id: `40000000000000${String(1 + index).padStart(3, '0')}`,
      name: `Role${index}`,
      mentionable: true,
    }));
    expect(
      await resolveReminderTargets(
        makeGuild({ roles: tooManyRoles }),
        request({ roles: tooManyRoles.map((role) => role.id) }),
      ),
    ).toMatchObject({
      ok: false,
      problem: "That's more than 10 roles for one reminder.",
    });
    const targets = ok(
      await resolveReminderTargets(
        makeGuild(),
        request({ members: ['Alex', 'alex'], roles: ['Execs', 'execs'] }),
      ),
    );
    expect(targets.mentions.userIds).toEqual(['20000000000000001']);
    expect(targets.mentions.roleIds).toEqual(['40000000000000001']);
  });

  it('applies member limits after deduplicating resolved ids', async () => {
    const ids = Array.from({ length: 25 }, (_, index) => `20000000000000${100 + index}`);
    const members = ids.map((id) => member(id, `Member ${id}`));
    const guild = makeGuild({ members });
    const result = ok(await resolveReminderTargets(guild, request({ members: [...ids, ids[0]!] })));
    expect(result.mentions.userIds).toHaveLength(25);
  });

  it('resolves cached display-name matches when search rejects', async () => {
    const search = vi.fn(async (_options: { query: string; limit: number }) =>
      Promise.reject(new Error('offline')),
    );
    const targets = ok(
      await resolveReminderTargets(makeGuild({ search }), request({ members: ['Alex'] })),
    );
    expect(targets.mentions.userIds).toEqual(['20000000000000001']);
    expect(targets.memberNames).toEqual(['Alex']);
  });

  it('fails closed for unavailable guild, bot, or asker and turns lookup errors into problems', async () => {
    const unavailable = "I can't check permissions right now, so I didn't set the reminder.";
    await expect(resolveReminderTargets(undefined, request())).resolves.toEqual({
      ok: false,
      problem: unavailable,
    });
    await expect(resolveReminderTargets(makeGuild({ me: null }), request())).resolves.toEqual({
      ok: false,
      problem: unavailable,
    });
    await expect(
      resolveReminderTargets(
        makeGuild({ fetch: async () => Promise.reject(new Error('unknown')) }),
        request(),
      ),
    ).resolves.toEqual({ ok: false, problem: unavailable });
    const search = vi.fn(async (_options: { query: string; limit: number }) =>
      Promise.reject(new Error('offline')),
    );
    await expect(
      resolveReminderTargets(makeGuild({ search }), request({ members: ['unknown'] })),
    ).resolves.toMatchObject({
      ok: false,
      problem: expect.stringContaining("couldn't look up members"),
    });
  });
});
