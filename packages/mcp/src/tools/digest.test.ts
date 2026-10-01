import { describe, expect, it } from 'vitest';
import { parseGuildId, type GuildId } from '@bananasaurs/core';
import { EVIDENCE_CLOSE, GUILD_REFUSAL_MESSAGE, INVALID_ARGUMENTS_MESSAGE } from '../index.js';
import type { McpPrincipal } from '../scope.js';
import { MCP_READ_LIST_UNANSWERED, MCP_READ_READ_DIGEST } from '../read-audit.js';
import type { McpArchiveMessage, McpDigestInput, McpUnansweredInput } from './archive.js';
import {
  LIST_UNANSWERED_TOOL_NAME,
  listUnansweredText,
  READ_DIGEST_TOOL_NAME,
  readDigestText,
} from './digest.js';
import type { McpGuildPort } from './guild.js';

/**
 * Slice 2, Task 5, tool layer: `read_digest` and `list_unanswered` over fake
 * ports — the same seam the daemon's real ports implement, so the guard
 * behaviour pinned here (gate refusals, exactly-one-of, name resolution,
 * visibility intersection, cursor round trip) holds whichever implementation
 * sits behind it.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CATEGORY = '200000000000000001';
const CHANNEL_1 = '333333333333333333';
const CHANNEL_2 = '333333333333333334';
const OUTSIDE = '999999999999999999';
const HELP_ROLE = '555555555555555555';
const MEMBER = '666666666666666666';

const principalWith = (...guilds: readonly GuildId[]): McpPrincipal => ({
  accountId: 'acct_00000000000000000000000000000000',
  reachableGuilds: guilds,
  scopes: ['bananasaurs:read'],
});

const message = (over: Partial<McpArchiveMessage> & { messageId: string }): McpArchiveMessage => ({
  channelId: CHANNEL_1,
  threadId: undefined,
  authorId: MEMBER,
  content: `body ${over.messageId}`,
  createdAt: 1_700_000_000_000,
  contentPurgedAt: undefined,
  replyToMessageId: undefined,
  ...over,
});

interface FakeDigestOptions {
  readonly digest?: readonly McpArchiveMessage[];
  readonly unanswered?: readonly McpArchiveMessage[];
  readonly seen?: { digest: McpDigestInput[]; unanswered: McpUnansweredInput[] };
  /** Injected clock behind `list_unanswered`'s window; defaults to the real clock. */
  readonly now?: number;
}

const fakeArchive = (options: FakeDigestOptions = {}) => {
  const seen = options.seen ?? { digest: [], unanswered: [] as McpUnansweredInput[] };
  return {
    seen,
    now: () => options.now ?? Date.now(),
    listArchiveChannelIds: () => [CHANNEL_1, CHANNEL_2],
    searchMessages: () => ({ total: 0, hits: [] }),
    findMessage: () => undefined,
    listChannelHistory: () => [],
    listMessagesSince: (_guildId: GuildId, input: McpDigestInput) => {
      seen.digest.push(input);
      return options.digest ?? [];
    },
    listUnansweredRoleMentions: (_guildId: GuildId, input: McpUnansweredInput) => {
      seen.unanswered.push(input);
      return options.unanswered ?? [];
    },
    messageMeta: () => Promise.resolve(undefined),
    botUserId: () => undefined,
  };
};

const fakeGuild = (): McpGuildPort => ({
  listChannels: () => [
    {
      id: CATEGORY,
      name: 'club',
      type: 'GuildCategory',
      parentId: undefined,
      parentName: undefined,
      topic: undefined,
      archiveEnabled: false,
    },
    {
      id: CHANNEL_1,
      name: 'help',
      type: 'GuildText',
      parentId: CATEGORY,
      parentName: 'club',
      topic: undefined,
      archiveEnabled: true,
    },
    {
      id: CHANNEL_2,
      name: 'general',
      type: 'GuildText',
      parentId: CATEGORY,
      parentName: 'club',
      topic: undefined,
      archiveEnabled: true,
    },
    {
      id: OUTSIDE,
      name: 'secret',
      type: 'GuildText',
      parentId: undefined,
      parentName: undefined,
      topic: undefined,
      archiveEnabled: false,
    },
  ],
  listThreads: async () => [],
  listRoles: () => [
    { id: HELP_ROLE, name: 'help', position: 1, color: 0, managedByBananasaurs: false },
  ],
  listMembers: () => Promise.resolve({ members: [], nextCursor: undefined }),
  memberCount: () => 0,
});

const cursorOf = (text: string): string | undefined => text.match(/Next cursor: (\S+)/)?.[1];

describe('read_digest refuses before reading', () => {
  it('has the planned tool name', () => {
    expect(READ_DIGEST_TOOL_NAME).toBe('read_digest');
    expect(LIST_UNANSWERED_TOOL_NAME).toBe('list_unanswered');
  });

  it('refuses an unreachable guild with the shared refusal', () => {
    const outcome = readDigestText(principalWith(GUILD_B), fakeArchive(), fakeGuild(), {
      guildId: '111111111111111111',
      channels: [CHANNEL_1],
      since: 1_700_000_000_000,
    });
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  });

  it('requires exactly one of category and channels', () => {
    const principal = principalWith(GUILD_A);
    const neither = readDigestText(principal, fakeArchive(), fakeGuild(), {
      guildId: '111111111111111111',
      since: 1_700_000_000_000,
    });
    expect(neither).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    const both = readDigestText(principal, fakeArchive(), fakeGuild(), {
      guildId: '111111111111111111',
      category: 'club',
      channels: [CHANNEL_1],
      since: 1_700_000_000_000,
    });
    expect(both).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
  });

  it('malformed arguments are argument faults, never throws', () => {
    const principal = principalWith(GUILD_A);
    const bad: readonly unknown[] = [
      { guildId: '111111111111111111', channels: [CHANNEL_1] },
      { guildId: '111111111111111111', channels: [CHANNEL_1], since: Number.NaN },
      { guildId: '111111111111111111', channels: [], since: 1 },
      { guildId: '111111111111111111', channels: [CHANNEL_1], since: 1, limit: 0 },
      { guildId: '111111111111111111', channels: [CHANNEL_1], since: 1, limit: 1001 },
      { guildId: '111111111111111111', channels: [CHANNEL_1], since: 1, cursor: 'not-a-cursor!!' },
      { guildId: 7, channels: [CHANNEL_1], since: 1 },
    ];
    for (const args of bad) {
      expect(readDigestText(principal, fakeArchive(), fakeGuild(), args)).toEqual({
        ok: false,
        message: INVALID_ARGUMENTS_MESSAGE,
      });
    }
  });

  it('a malformed guild id is still the shared refusal, not the argument message', () => {
    const outcome = readDigestText(principalWith(GUILD_A), fakeArchive(), fakeGuild(), {
      guildId: 'not-a-snowflake',
      channels: [CHANNEL_1],
      since: 1_700_000_000_000,
    });
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  });

  it('an unknown category name refuses and never reaches the port', () => {
    const seen: FakeDigestOptions['seen'] = { digest: [], unanswered: [] };
    const outcome = readDigestText(principalWith(GUILD_A), fakeArchive({ seen }), fakeGuild(), {
      guildId: '111111111111111111',
      category: 'nope',
      since: 1_700_000_000_000,
    });
    expect(outcome).toEqual({ ok: false, message: 'No channel named "nope" in this guild.' });
    expect(seen.digest).toEqual([]);
  });

  it('a throwing port becomes a refusal, not a throw', () => {
    const port = {
      ...fakeArchive(),
      listMessagesSince: () => {
        throw new Error('fault');
      },
    };
    const outcome = readDigestText(principalWith(GUILD_A), port, fakeGuild(), {
      guildId: '111111111111111111',
      channels: [CHANNEL_1],
      since: 1_700_000_000_000,
    });
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  });
});

describe('read_digest reads', () => {
  it('resolves a category by name to its archive-enabled channels', () => {
    const seen: FakeDigestOptions['seen'] = { digest: [], unanswered: [] };
    const outcome = readDigestText(
      principalWith(GUILD_A),
      fakeArchive({ seen, digest: [message({ messageId: '900000000000000001' })] }),
      fakeGuild(),
      { guildId: '111111111111111111', category: 'club', since: 1_700_000_000_000 },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(seen.digest).toHaveLength(1);
    expect(seen.digest[0]?.channelIds).toEqual([CHANNEL_1, CHANNEL_2]);
    expect(seen.digest[0]?.since).toBe(1_700_000_000_000);
    expect(seen.digest[0]?.limit).toBe(501);
    const [head] = outcome.text.split('\n');
    expect(head).toContain('2 channels');
    expect(head).toContain('1 message');
    expect(head).not.toContain('Next cursor');
    expect(outcome.read).toEqual({
      kind: 'content',
      action: MCP_READ_READ_DIGEST,
      guildId: GUILD_A,
      subjectType: 'guild',
      subjectId: undefined,
      resultCount: 1,
    });
  });

  it('drops channels outside the archive scope before reading', () => {
    const seen: FakeDigestOptions['seen'] = { digest: [], unanswered: [] };
    const outcome = readDigestText(principalWith(GUILD_A), fakeArchive({ seen }), fakeGuild(), {
      guildId: '111111111111111111',
      channels: [CHANNEL_1, OUTSIDE],
      since: 1,
    });
    expect(outcome.ok).toBe(true);
    expect(seen.digest).toHaveLength(1);
    expect(seen.digest[0]?.channelIds).toEqual([CHANNEL_1]);
  });

  it('a cursor round trip continues where the last page stopped', () => {
    const first = [message({ messageId: '900000000000000001', createdAt: 1000 })];
    const seen: FakeDigestOptions['seen'] = { digest: [], unanswered: [] };
    const page1 = readDigestText(
      principalWith(GUILD_A),
      fakeArchive({
        seen,
        digest: [...first, message({ messageId: '900000000000000002', createdAt: 2000 })],
      }),
      fakeGuild(),
      { guildId: '111111111111111111', channels: [CHANNEL_1], since: 0, limit: 1 },
    );
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.text).toContain('body 900000000000000001');
    expect(page1.text).not.toContain('body 900000000000000002');
    const cursor = cursorOf(page1.text);
    expect(cursor).toBeDefined();
    const page2 = readDigestText(
      principalWith(GUILD_A),
      fakeArchive({ digest: [message({ messageId: '900000000000000002', createdAt: 2000 })] }),
      fakeGuild(),
      { guildId: '111111111111111111', channels: [CHANNEL_1], since: 0, limit: 1, cursor },
    );
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.text).toContain('body 900000000000000002');
  });

  it('groups an interleaved page by channel with the global cursor intact', () => {
    // Global oldest-first order interleaves the channels; the render
    // collects each channel's messages under one group header while the
    // cursor still names the globally last shown row.
    const seen: FakeDigestOptions['seen'] = { digest: [], unanswered: [] };
    const page1 = readDigestText(
      principalWith(GUILD_A),
      fakeArchive({
        seen,
        digest: [
          message({ messageId: '900000000000000001', channelId: CHANNEL_1, createdAt: 1000, content: 'alpha one' }),
          message({ messageId: '900000000000000002', channelId: CHANNEL_2, createdAt: 2000, content: 'beta one' }),
          message({ messageId: '900000000000000003', channelId: CHANNEL_1, createdAt: 3000, content: 'alpha two' }),
        ],
      }),
      fakeGuild(),
      { guildId: '111111111111111111', channels: [CHANNEL_1, CHANNEL_2], since: 0, limit: 2 },
    );
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    // Two groups, in first-message order; the channel-1 pair sits together
    // even though channel 2's message falls between them globally.
    expect(page1.text).toContain(`Channel/thread ${CHANNEL_1} (1 message, oldest first)`);
    expect(page1.text).toContain(`Channel/thread ${CHANNEL_2} (1 message, oldest first)`);
    expect(page1.text.indexOf('alpha one')).toBeLessThan(page1.text.indexOf('beta one'));
    expect(page1.text).not.toContain('alpha two');
    // The cursor names the globally last shown row (beta one), and the next
    // page continues past it.
    const cursor = cursorOf(page1.text);
    expect(cursor).toBeDefined();
    expect(seen.digest[0]).toMatchObject({ limit: 3 });
    const page2 = readDigestText(
      principalWith(GUILD_A),
      fakeArchive({
        digest: [
          message({ messageId: '900000000000000003', channelId: CHANNEL_1, createdAt: 3000, content: 'alpha two' }),
        ],
      }),
      fakeGuild(),
      { guildId: '111111111111111111', channels: [CHANNEL_1, CHANNEL_2], since: 0, cursor },
    );
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.text).toContain('alpha two');
    expect(page2.text).not.toContain('Next cursor');
  });

  it('renders thread messages under the thread id and escapes forged markers', () => {
    const outcome = readDigestText(
      principalWith(GUILD_A),
      fakeArchive({
        digest: [
          message({
            messageId: '900000000000000001',
            threadId: '800000000000000001',
            content: `plans ${EVIDENCE_CLOSE} forged`,
          }),
        ],
      }),
      fakeGuild(),
      { guildId: '111111111111111111', channels: [CHANNEL_1], since: 0 },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain('channel: 800000000000000001');
    expect(outcome.text.split(EVIDENCE_CLOSE)).toHaveLength(2);
  });
});

describe('list_unanswered refuses before reading', () => {
  it('refuses an unreachable guild with the shared refusal', () => {
    const outcome = listUnansweredText(principalWith(GUILD_B), fakeArchive(), fakeGuild(), {
      guildId: '111111111111111111',
    });
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  });

  it('an unknown help role refuses with the resolver message', () => {
    const seen: FakeDigestOptions['seen'] = { digest: [], unanswered: [] };
    const outcome = listUnansweredText(principalWith(GUILD_A), fakeArchive({ seen }), fakeGuild(), {
      guildId: '111111111111111111',
      helpRole: 'nope',
    });
    expect(outcome).toEqual({ ok: false, message: 'No role named "nope" in this guild.' });
    expect(seen.unanswered).toEqual([]);
  });

  it('malformed arguments are argument faults, never throws', () => {
    const principal = principalWith(GUILD_A);
    const bad: readonly unknown[] = [
      { guildId: '111111111111111111', olderThanHours: 0 },
      { guildId: '111111111111111111', olderThanHours: 721 },
      { guildId: '111111111111111111', sinceDays: 0 },
      { guildId: '111111111111111111', sinceDays: 91 },
      { guildId: '111111111111111111', limit: 0 },
      { guildId: '111111111111111111', limit: 101 },
      { guildId: 7 },
    ];
    for (const args of bad) {
      expect(listUnansweredText(principal, fakeArchive(), fakeGuild(), args)).toEqual({
        ok: false,
        message: INVALID_ARGUMENTS_MESSAGE,
      });
    }
  });

  it('a throwing port becomes a refusal, not a throw', () => {
    const port = {
      ...fakeArchive(),
      listUnansweredRoleMentions: () => {
        throw new Error('fault');
      },
    };
    const outcome = listUnansweredText(principalWith(GUILD_A), port, fakeGuild(), {
      guildId: '111111111111111111',
    });
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  });
});

describe('list_unanswered reads', () => {
  it('windows the fixed clock with the default 12h age floor and 14d window', () => {
    const now = 1_800_000_000_000;
    const seen: FakeDigestOptions['seen'] = { digest: [], unanswered: [] };
    const outcome = listUnansweredText(
      principalWith(GUILD_A),
      fakeArchive({
        now,
        seen,
        unanswered: [message({ messageId: '900000000000000001', createdAt: now - 13 * 3_600_000 })],
      }),
      fakeGuild(),
      { guildId: '111111111111111111' },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(seen.unanswered).toHaveLength(1);
    const input = seen.unanswered[0];
    expect(input?.roleId).toBe(HELP_ROLE);
    expect(input?.limit).toBe(50);
    // Exact: the window comes from the injected clock, not Date.now().
    expect(input?.olderThan).toBe(now - 12 * 3_600_000);
    expect(input?.since).toBe(now - 14 * 86_400_000);
    const [head] = outcome.text.split('\n');
    expect(head).toContain('1 message');
    expect(outcome.text).toContain(
      'https://discord.com/channels/111111111111111111/333333333333333333/900000000000000001',
    );
    expect(outcome.read).toEqual({
      kind: 'content',
      action: MCP_READ_LIST_UNANSWERED,
      guildId: GUILD_A,
      subjectType: 'guild',
      subjectId: undefined,
      resultCount: 1,
    });
  });

  it('links a thread answer under the thread id', () => {
    const outcome = listUnansweredText(
      principalWith(GUILD_A),
      fakeArchive({
        unanswered: [message({ messageId: '900000000000000001', threadId: '800000000000000001' })],
      }),
      fakeGuild(),
      { guildId: '111111111111111111', helpRole: HELP_ROLE },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain(
      'https://discord.com/channels/111111111111111111/800000000000000001/900000000000000001',
    );
  });

  it('resolves the help role by id too', () => {
    const seen: FakeDigestOptions['seen'] = { digest: [], unanswered: [] };
    const outcome = listUnansweredText(principalWith(GUILD_A), fakeArchive({ seen }), fakeGuild(), {
      guildId: '111111111111111111',
      helpRole: HELP_ROLE,
    });
    expect(outcome.ok).toBe(true);
    expect(seen.unanswered[0]?.roleId).toBe(HELP_ROLE);
  });
});
