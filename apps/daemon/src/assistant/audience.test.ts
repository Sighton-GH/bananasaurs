import { describe, expect, it } from 'vitest';
import { ChannelType, OverwriteType, PermissionsBitField } from 'discord.js';
import {
  audienceChannels,
  buildAudienceMap,
  guildAudienceChannels,
  type AudienceChannel,
  type AudienceGuild,
} from './audience.js';

const VIEW = PermissionsBitField.Flags.ViewChannel;
const HISTORY = PermissionsBitField.Flags.ReadMessageHistory;
const SEND = PermissionsBitField.Flags.SendMessages;

const chan = (id: string, over: Partial<AudienceChannel> = {}): AudienceChannel => ({
  id,
  isThread: false,
  isPrivateThread: false,
  parentId: undefined,
  everyoneCanRead: true,
  overwrites: [],
  ...over,
});

const ow = (
  id: string,
  type: 'role' | 'member',
  allow: bigint,
  deny: bigint,
): AudienceChannel['overwrites'][number] => ({ id, type, allow, deny });

describe('audienceChannels (ADR 0090)', () => {
  it('excludes a private channel from a public answer channel', () => {
    const channels = new Map<string, AudienceChannel>([
      ['general', chan('general')],
      [
        'private',
        chan('private', {
          everyoneCanRead: false,
          overwrites: [ow('everyone', 'role', 0n, VIEW | HISTORY)],
        }),
      ],
    ]);
    const audience = audienceChannels('general', channels);
    expect(audience.has('general')).toBe(true);
    expect(audience.has('private')).toBe(false);
  });

  it('shares an audience between channels with identical overwrites', () => {
    const synced = [
      ow('everyone', 'role', 0n, VIEW),
      ow('team', 'role', VIEW | HISTORY, 0n),
    ];
    const channels = new Map<string, AudienceChannel>([
      ['a', chan('a', { everyoneCanRead: false, overwrites: synced })],
      [
        'b',
        chan('b', {
          everyoneCanRead: false,
          overwrites: [
            ow('team', 'role', VIEW | HISTORY, 0n),
            ow('everyone', 'role', 0n, VIEW),
          ],
        }),
      ],
    ]);
    expect(audienceChannels('a', channels).has('b')).toBe(true);
    expect(audienceChannels('b', channels).has('a')).toBe(true);
  });

  it('excludes an otherwise open channel with a role deny', () => {
    const channels = new Map<string, AudienceChannel>([
      ['general', chan('general')],
      [
        'gated',
        chan('gated', {
          everyoneCanRead: true,
          overwrites: [ow('visitors', 'role', 0n, VIEW)],
        }),
      ],
    ]);
    expect(audienceChannels('general', channels).has('gated')).toBe(false);
  });

  it('excludes on a member-overwrite difference', () => {
    const channels = new Map<string, AudienceChannel>([
      [
        'c',
        chan('c', {
          everyoneCanRead: false,
          overwrites: [ow('member-1', 'member', VIEW | HISTORY, 0n)],
        }),
      ],
      [
        'x',
        chan('x', {
          everyoneCanRead: false,
          overwrites: [ow('member-2', 'member', VIEW | HISTORY, 0n)],
        }),
      ],
    ]);
    expect(audienceChannels('c', channels).has('x')).toBe(false);
  });

  it('includes an open channel in the audience of a private answer channel', () => {
    const channels = new Map<string, AudienceChannel>([
      [
        'private',
        chan('private', {
          everyoneCanRead: false,
          overwrites: [ow('everyone', 'role', 0n, VIEW | HISTORY)],
        }),
      ],
      ['general', chan('general')],
    ]);
    const audience = audienceChannels('private', channels);
    expect(audience.has('private')).toBe(true);
    expect(audience.has('general')).toBe(true);
  });

  it('uses the parent audience for a public thread and includes the thread', () => {
    const channels = new Map<string, AudienceChannel>([
      ['general', chan('general')],
      [
        'thread',
        chan('thread', {
          isThread: true,
          isPrivateThread: false,
          parentId: 'general',
          everyoneCanRead: false,
        }),
      ],
      [
        'private',
        chan('private', {
          everyoneCanRead: false,
          overwrites: [ow('everyone', 'role', 0n, VIEW | HISTORY)],
        }),
      ],
    ]);
    const audience = audienceChannels('thread', channels);
    expect(audience.has('thread')).toBe(true);
    expect(audience.has('general')).toBe(true);
    expect(audience.has('private')).toBe(false);
  });

  it('a private thread yields only itself', () => {
    const channels = new Map<string, AudienceChannel>([
      ['general', chan('general')],
      [
        'secret-thread',
        chan('secret-thread', {
          isThread: true,
          isPrivateThread: true,
          parentId: 'general',
          everyoneCanRead: false,
        }),
      ],
    ]);
    expect(audienceChannels('secret-thread', channels)).toEqual(new Set(['secret-thread']));
  });

  it('a public thread with an unknown parent yields only itself', () => {
    const channels = new Map<string, AudienceChannel>([
      ['general', chan('general')],
      [
        'orphan',
        chan('orphan', {
          isThread: true,
          isPrivateThread: false,
          parentId: 'missing',
          everyoneCanRead: false,
        }),
      ],
    ]);
    expect(audienceChannels('orphan', channels)).toEqual(new Set(['orphan']));
  });

  it('an unknown answer channel gives the empty set', () => {
    const channels = new Map<string, AudienceChannel>([['general', chan('general')]]);
    expect(audienceChannels('missing', channels)).toEqual(new Set());
    expect(audienceChannels('general', new Map())).toEqual(new Set());
  });

  it('ignores overwrites that touch only unrelated bits', () => {
    const channels = new Map<string, AudienceChannel>([
      ['general', chan('general')],
      [
        'quiet',
        chan('quiet', {
          everyoneCanRead: true,
          overwrites: [ow('team', 'role', SEND, 0n)],
        }),
      ],
      [
        'readonly',
        chan('readonly', {
          everyoneCanRead: true,
          overwrites: [ow('team', 'role', 0n, SEND)],
        }),
      ],
    ]);
    const audience = audienceChannels('general', channels);
    expect(audience.has('quiet')).toBe(true);
    expect(audience.has('readonly')).toBe(true);
  });

  it('never offers a thread as a candidate', () => {
    const channels = new Map<string, AudienceChannel>([
      ['general', chan('general')],
      [
        'thread',
        chan('thread', {
          isThread: true,
          isPrivateThread: false,
          parentId: 'general',
          everyoneCanRead: true,
        }),
      ],
    ]);
    expect(audienceChannels('general', channels).has('thread')).toBe(false);
  });
});

describe('buildAudienceMap (discord.js mapping)', () => {
  const READ = VIEW | HISTORY;
  const everyone = { id: 'everyone-role' };

  const guildChannel = (over: {
    id?: string;
    canRead?: boolean | null;
    overwrites?: readonly {
      id: string;
      type: number;
      allow: bigint;
      deny: bigint;
    }[];
  }) => ({
    id: over.id ?? 'general',
    isThread: () => false,
    type: ChannelType.GuildText,
    parentId: null,
    permissionsFor: (role: unknown) =>
      over.canRead === null || role !== everyone
        ? null
        : {
            has: (bits: bigint) => (READ & bits) === bits && over.canRead === true,
          },
    permissionOverwrites: {
      cache: new Map(
        (over.overwrites ?? []).map((entry) => [
          entry.id,
          {
            id: entry.id,
            type: entry.type,
            allow: { bitfield: entry.allow },
            deny: { bitfield: entry.deny },
          },
        ]),
      ),
    },
  });

  const guildWith = (channels: readonly ReturnType<typeof guildChannel>): AudienceGuild => ({
    channels: { cache: new Map(channels.map((channel) => [channel.id, channel])) },
    roles: { everyone },
  });

  it('reads everyoneCanRead from permissionsFor and masks overwrites to the read bits', () => {
    const guild = guildWith([
      guildChannel({
        id: 'general',
        canRead: true,
        overwrites: [
          { id: 'team', type: OverwriteType.Role, allow: VIEW | SEND, deny: 0n },
          { id: 'member-1', type: OverwriteType.Member, allow: 0n, deny: HISTORY },
        ],
      }),
      guildChannel({ id: 'private', canRead: false }),
    ]);
    const map = buildAudienceMap(guild);
    expect(map.get('general')).toMatchObject({
      id: 'general',
      isThread: false,
      everyoneCanRead: true,
      overwrites: [
        { id: 'team', type: 'role', allow: VIEW, deny: 0n },
        { id: 'member-1', type: 'member', allow: 0n, deny: HISTORY },
      ],
    });
    expect(map.get('private')).toMatchObject({ everyoneCanRead: false, overwrites: [] });
  });

  it('drops overwrites that touch only unrelated bits', () => {
    const guild = guildWith([
      guildChannel({
        id: 'quiet',
        canRead: true,
        overwrites: [{ id: 'team', type: OverwriteType.Role, allow: SEND, deny: 0n }],
      }),
    ]);
    expect(buildAudienceMap(guild).get('quiet')?.overwrites).toEqual([]);
  });

  it('maps threads from their type and parent, with no overwrites', () => {
    const guild: AudienceGuild = {
      channels: {
        cache: new Map([
          ['general', guildChannel({ id: 'general', canRead: true })],
          [
            'open-thread',
            {
              id: 'open-thread',
              isThread: () => true,
              type: ChannelType.PublicThread,
              parentId: 'general',
              permissionsFor: () => null,
            },
          ],
          [
            'secret-thread',
            {
              id: 'secret-thread',
              isThread: () => true,
              type: ChannelType.PrivateThread,
              parentId: 'general',
              permissionsFor: () => null,
            },
          ],
        ]),
      },
      roles: { everyone },
    };
    const map = buildAudienceMap(guild);
    expect(map.get('open-thread')).toMatchObject({
      isThread: true,
      isPrivateThread: false,
      parentId: 'general',
      overwrites: [],
    });
    expect(map.get('secret-thread')).toMatchObject({
      isThread: true,
      isPrivateThread: true,
      parentId: 'general',
    });
  });

  it('an uncached guild maps to nothing and answers nothing', () => {
    expect(buildAudienceMap(undefined).size).toBe(0);
    expect(guildAudienceChannels(undefined, 'general')).toEqual(new Set());
  });

  it('answers through the guild helper end to end', () => {
    const guild = guildWith([
      guildChannel({ id: 'general', canRead: true }),
      guildChannel({ id: 'private', canRead: false }),
    ]);
    const audience = guildAudienceChannels(guild, 'general');
    expect(audience.has('general')).toBe(true);
    expect(audience.has('private')).toBe(false);
  });
});
