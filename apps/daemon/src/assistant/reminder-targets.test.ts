import { PermissionsBitField } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveReminderTargets,
  type ReminderTargetGuild,
  type ReminderTargetMember,
  type ReminderTargetRequest,
} from './reminder-targets.js';

const permission = PermissionsBitField.Flags;
const all = permission.ViewChannel | permission.SendMessages | permission.MentionEveryone;
const channel = (id: string, name: string, { text = true, thread = false } = {}) => ({
  id,
  name,
  isTextBased: () => text,
  isThread: () => thread,
});
const member = (id: string, displayName: string, username = displayName, allowed = all): ReminderTargetMember => ({
  id,
  displayName,
  user: { username },
  permissionsIn: () => ({ has: (requested) => (allowed & requested) === requested }),
});

const makeGuild = (overrides: {
  channels?: ReturnType<typeof channel>[];
  members?: ReminderTargetMember[];
  roles?: { id: string; name: string; mentionable: boolean }[];
  asker?: ReminderTargetMember;
  me?: ReminderTargetMember | null;
  fetch?: (id: string) => Promise<ReminderTargetMember>;
  search?: (query: string, limit: number) => Promise<ReadonlyMap<string, ReminderTargetMember>>;
} = {}): ReminderTargetGuild => {
  const channels = overrides.channels ?? [channel('10000000000000001', 'general')];
  const members = overrides.members ?? [member('20000000000000001', 'Alex', 'alex')];
  const asker = overrides.asker ?? member('30000000000000001', 'Asker');
  const memberCache = new Map(members.map((entry) => [entry.id, entry]));
  return {
    channels: { cache: new Map(channels.map((entry) => [entry.id, entry])) },
    roles: {
      cache: new Map(
        (overrides.roles ?? [{ id: '40000000000000001', name: 'Execs', mentionable: true }]).map((role) => [role.id, role]),
      ),
    },
    members: {
      me: overrides.me === undefined ? member('50000000000000001', 'Bot') : overrides.me,
      cache: memberCache,
      fetch: overrides.fetch ?? (async (id) => (id === asker.id ? asker : memberCache.get(id))!),
      search:
        overrides.search ??
        (async (query, limit) => {
          const matches = [...memberCache.values()].filter((entry) =>
            `${entry.displayName} ${entry.user.username}`.toLowerCase().includes(query.toLowerCase()),
          );
          return new Map(matches.slice(0, limit).map((entry) => [entry.id, entry]));
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
    'resolves channel form %s', async (target) => {
      expect(ok(await resolveReminderTargets(makeGuild(), request({ channel: target }))).channelId).toBe(
        '10000000000000001',
      );
    },
  );

  it('defaults to currentChannelId', async () => {
    const targets = ok(await resolveReminderTargets(makeGuild(), request()));
    expect(targets.channelId).toBe('10000000000000001');
  });

  it('resolves channel names case-insensitively and reports missing or ambiguous channels', async () => {
    const guild = makeGuild({ channels: [channel('10000000000000001', 'General'), channel('10000000000000002', 'general-2')] });
    expect(ok(await resolveReminderTargets(guild, request({ channel: 'GENERAL' }))).channelName).toBe('General');
    expect(await resolveReminderTargets(guild, request({ channel: 'unknown' }))).toEqual({
      ok: false,
      problem: `I can't find a channel called "unknown".`,
    });
    const ambiguousGuild = makeGuild({ channels: [channel('10000000000000001', 'general'), channel('10000000000000002', 'GENERAL')] });
    await expect(resolveReminderTargets(ambiguousGuild, request({ channel: 'general' }))).resolves.toMatchObject({
      ok: false,
      problem: '"general" matches more than one channel: general (10000000000000001), GENERAL (10000000000000002).',
    });
  });

  it.each(['20000000000000001', '<@20000000000000001>', '<@!20000000000000001>', 'Alex', '@Alex'])(
    'resolves member form %s', async (target) => {
      const targets = ok(await resolveReminderTargets(makeGuild(), request({ members: [target] })));
      expect(targets.mentions.userIds).toEqual(['20000000000000001']);
      expect(targets.memberNames).toEqual(['Alex']);
    },
  );

  it.each(['40000000000000001', '<@&40000000000000001>', 'Execs', '@Execs'])(
    'resolves role form %s', async (target) => {
      const targets = ok(await resolveReminderTargets(makeGuild(), request({ roles: [target] })));
      expect(targets.mentions.roleIds).toEqual(['40000000000000001']);
      expect(targets.roleNames).toEqual(['Execs']);
    },
  );

  it('resolves names case-insensitively and reports missing or ambiguous members and roles', async () => {
    const guild = makeGuild({
      members: [member('20000000000000001', 'Alex', 'alex'), member('20000000000000002', 'Other', 'aLeX')],
      roles: [
        { id: '40000000000000001', name: 'Execs', mentionable: true },
        { id: '40000000000000002', name: 'execs', mentionable: true },
      ],
    });
    await expect(resolveReminderTargets(guild, request({ members: ['missing'] }))).resolves.toMatchObject({
      ok: false,
      problem: `I can't find a member called "missing".`,
    });
    await expect(resolveReminderTargets(guild, request({ members: ['Alex'] }))).resolves.toMatchObject({
      ok: false,
      problem: '"Alex" matches more than one member: Alex (20000000000000001), Other (20000000000000002).',
    });
    await expect(resolveReminderTargets(guild, request({ roles: ['missing'] }))).resolves.toMatchObject({
      ok: false,
      problem: `I can't find a role called "missing".`,
    });
    await expect(resolveReminderTargets(guild, request({ roles: ['Execs'] }))).resolves.toMatchObject({
      ok: false,
      problem: '"Execs" matches more than one role: Execs (40000000000000001), execs (40000000000000002).',
    });
  });

  it('checks asker and bot send permissions in the target channel', async () => {
    const noSend = permission.ViewChannel;
    await expect(
      resolveReminderTargets(makeGuild({ asker: member('30000000000000001', 'Asker', 'Asker', noSend) }), request()),
    ).resolves.toMatchObject({ ok: false, problem: "You can't send messages in #general, so I can't post a reminder there." });
    await expect(
      resolveReminderTargets(makeGuild({ me: member('50000000000000001', 'Bot', 'Bot', noSend) }), request()),
    ).resolves.toMatchObject({ ok: false, problem: "I don't have permission to send messages in #general." });
  });

  it('requires MentionEveryone only for everyone, here, or non-mentionable roles', async () => {
    const noMention = permission.ViewChannel | permission.SendMessages;
    const guild = makeGuild({ roles: [{ id: '40000000000000001', name: 'Execs', mentionable: true }] });
    expect((await resolveReminderTargets(guild, request({ roles: ['Execs'] }))).ok).toBe(true);
    const restricted = makeGuild({
      asker: member('30000000000000001', 'Asker', 'Asker', noMention),
      roles: [{ id: '40000000000000001', name: 'Execs', mentionable: false }],
    });
    await expect(resolveReminderTargets(restricted, request({ roles: ['Execs'] }))).resolves.toMatchObject({
      ok: false,
      problem: 'Pinging @everyone, @here or the Execs role needs the Mention Everyone permission in #general.',
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
  ])('sets the %s flag and checks MentionEveryone', async (value, everyone, here) => {
    const noMention = makeGuild({ asker: member('30000000000000001', 'Asker', 'Asker', permission.ViewChannel | permission.SendMessages) });
    await expect(resolveReminderTargets(noMention, request({ roles: [value] }))).resolves.toMatchObject({ ok: false });
    const targets = ok(await resolveReminderTargets(makeGuild(), request({ roles: [value] })));
    expect(targets.mentions).toMatchObject({ everyone, here });
  });

  it('enforces member and role limits and deduplicates in first-seen order', async () => {
    expect(await resolveReminderTargets(makeGuild(), request({ members: Array(26).fill('Alex') }))).toMatchObject({
      ok: false,
      problem: "That's more than 25 people for one reminder.",
    });
    expect(await resolveReminderTargets(makeGuild(), request({ roles: Array(11).fill('Execs') }))).toMatchObject({
      ok: false,
      problem: "That's more than 10 roles for one reminder.",
    });
    const targets = ok(
      await resolveReminderTargets(makeGuild(), request({ members: ['Alex', 'alex'], roles: ['Execs', 'execs'] })),
    );
    expect(targets.mentions.userIds).toEqual(['20000000000000001']);
    expect(targets.mentions.roleIds).toEqual(['40000000000000001']);
  });

  it('fails closed for unavailable guild, bot, or asker and turns lookup errors into problems', async () => {
    const unavailable = "I can't check permissions right now, so I didn't set the reminder.";
    await expect(resolveReminderTargets(undefined, request())).resolves.toEqual({ ok: false, problem: unavailable });
    await expect(resolveReminderTargets(makeGuild({ me: null }), request())).resolves.toEqual({ ok: false, problem: unavailable });
    await expect(
      resolveReminderTargets(makeGuild({ fetch: async () => Promise.reject(new Error('unknown')) }), request()),
    ).resolves.toEqual({ ok: false, problem: unavailable });
    const search = vi.fn(async () => Promise.reject(new Error('offline')));
    await expect(resolveReminderTargets(makeGuild({ search }), request({ members: ['unknown'] }))).resolves.toMatchObject({
      ok: false,
      problem: expect.stringContaining('could not'),
    });
  });
});
