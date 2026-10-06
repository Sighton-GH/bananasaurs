import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseGuildId, type GuildId } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE, INVALID_ARGUMENTS_MESSAGE, type McpPrincipal } from '../scope.js';
import { createMcpServer } from '../server.js';
import type { McpHealthPort } from './health.js';
import type { McpArchivePort } from './archive.js';
import type { McpGuildPort } from './guild.js';
import type { McpRecordsPort } from './records.js';
import type { McpJobsPort } from './jobs.js';
import type { McpMembersPort } from './members.js';
import type { McpContextPort } from './context.js';
import type { McpResourcesPort } from './resources.js';
import type { McpThreadsPort } from './threads.js';
import type { McpSendPort } from './send.js';
import type { McpReadAuditPort } from '../read-audit.js';
import type { McpThreadWritesPort } from './thread-writes.js';
import type { McpEventWritesPort } from './event-writes.js';
import type { McpSchedulePort } from './schedule.js';
import type { McpRoleWritesPort } from './role-writes.js';
import {
  ADD_REACTION_TOOL_NAME,
  DELETE_MESSAGE_TOOL_NAME,
  EDIT_MESSAGE_TOOL_NAME,
  PIN_MESSAGE_TOOL_NAME,
  REMOVE_REACTION_TOOL_NAME,
  UNPIN_MESSAGE_TOOL_NAME,
  addReactionText,
  deleteMessageText,
  editMessageText,
  pinMessageText,
  removeReactionText,
  unpinMessageText,
  type McpMessageWriteOutcome,
  type McpMessageWriteRefusal,
  type McpMessageWritesPort,
} from './message-writes.js';

/**
 * Task 6 Step 1, tool layer: the six message-write tools against a fake
 * `McpMessageWritesPort` — the same seam the daemon's gateway wiring
 * implements, so the guard behaviour pinned here (guild gate, argument
 * boundary, emoji shape, refusal rendering) holds whichever implementation
 * sits behind it.
 *
 * Scope filtering is pinned through a real MCP round-trip at the bottom: a
 * read-only token must not see any of the six in `tools/list` at all, and a
 * send-only token must see them alongside `send_message` and nothing else.
 */

/** ADR 0050: this file does not exercise read logging; the server requires the port. */
const noopReadAudit: McpReadAuditPort = {
  auditContentRead: () => undefined,
  logStructuralRead: () => undefined,
};

const GUILD_A = parseGuildId('111111111111111111');
const CHANNEL = '333333333333333333';
const MESSAGE = '444444444444444444';
const ACTION = 'act-00000000000000000000000001';

const principalWith = (
  guilds: readonly GuildId[],
  scopes: readonly string[] = ['bananasaurs:send'],
): McpPrincipal => ({
  accountId: 'acct_00000000000000000000000000000000',
  reachableGuilds: guilds,
  scopes,
});

const validEditArgs = (): Record<string, unknown> => ({
  guildId: '111111111111111111',
  channelId: CHANNEL,
  messageId: MESSAGE,
  content: 'edited text',
  idempotencyKey: 'key-00000000000000000000000000000001',
});

const validDeleteArgs = (): Record<string, unknown> => ({
  guildId: '111111111111111111',
  channelId: CHANNEL,
  messageId: MESSAGE,
  idempotencyKey: 'key-00000000000000000000000000000002',
});

const validPinArgs = (): Record<string, unknown> => ({
  guildId: '111111111111111111',
  channelId: CHANNEL,
  messageId: MESSAGE,
  idempotencyKey: 'key-00000000000000000000000000000003',
});

const validReactionArgs = (): Record<string, unknown> => ({
  guildId: '111111111111111111',
  channelId: CHANNEL,
  messageId: MESSAGE,
  emoji: '👍',
  idempotencyKey: 'key-00000000000000000000000000000004',
});

/** Fake writes port: every call recorded, the outcome scripted per test. */
const fakeWritesPort = (
  outcome: McpMessageWriteOutcome,
): McpMessageWritesPort & { readonly calls: Record<string, number> } => {
  const calls: Record<string, number> = {
    edit: 0,
    delete: 0,
    pin: 0,
    unpin: 0,
    addReaction: 0,
    removeReaction: 0,
  };
  const count = (method: string) => {
    calls[method] = (calls[method] ?? 0) + 1;
    return Promise.resolve(outcome);
  };
  return {
    calls,
    edit: () => count('edit'),
    delete: () => count('delete'),
    pin: () => count('pin'),
    unpin: () => count('unpin'),
    addReaction: () => count('addReaction'),
    removeReaction: () => count('removeReaction'),
  };
};

const totalCalls = (port: { readonly calls: Record<string, number> }): number =>
  Object.values(port.calls).reduce((sum, n) => sum + n, 0);

const textOf = (outcome: { readonly ok: boolean; readonly text?: string }): string => {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error('expected ok:true');
  return (outcome as { readonly text: string }).text;
};

const messageOf = (outcome: { readonly ok: boolean; readonly message?: string }): string => {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('expected ok:false');
  return (outcome as { readonly message: string }).message;
};

const handlers = [
  ['edit_message', editMessageText, validEditArgs] as const,
  ['delete_message', deleteMessageText, validDeleteArgs] as const,
  ['pin_message', pinMessageText, validPinArgs] as const,
  ['unpin_message', unpinMessageText, validPinArgs] as const,
  ['add_reaction', addReactionText, validReactionArgs] as const,
  ['remove_reaction', removeReactionText, validReactionArgs] as const,
];

describe('message-write guild gate (CLAUDE.md rule 2)', () => {
  it.each(handlers)(
    '%s refuses an unreachable guild with the shared refusal',
    async (_name, handler, args) => {
      const port = fakeWritesPort({ status: 'done', actionId: ACTION, messageId: MESSAGE });
      const outcome = await handler(principalWith([GUILD_A]), port, {
        ...args(),
        guildId: '222222222222222222',
      });
      expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
      expect(totalCalls(port)).toBe(0);
    },
  );

  it.each(handlers)('%s refuses a malformed guild id identically', async (_name, handler, args) => {
    const port = fakeWritesPort({ status: 'done', actionId: ACTION, messageId: MESSAGE });
    const outcome = await handler(principalWith([GUILD_A]), port, {
      ...args(),
      guildId: 'not-a-snowflake',
    });
    expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    expect(totalCalls(port)).toBe(0);
  });

  it.each(handlers)(
    '%s refuses an empty reachable set identically',
    async (_name, handler, args) => {
      const port = fakeWritesPort({ status: 'done', actionId: ACTION, messageId: MESSAGE });
      const outcome = await handler(principalWith([]), port, args());
      expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
      expect(totalCalls(port)).toBe(0);
    },
  );
});

describe('edit_message argument boundary (hard rule 3)', () => {
  it.each([
    ['content over 2000 characters', { ...validEditArgs(), content: 'x'.repeat(2001) }],
    ['empty content without embeds', { ...validEditArgs(), content: '' }],
    [
      'neither content nor embeds',
      {
        guildId: '111111111111111111',
        channelId: CHANNEL,
        messageId: MESSAGE,
        idempotencyKey: 'k',
      },
    ],
    ['empty embeds without content', { ...validEditArgs(), content: undefined, embeds: [] }],
    [
      'four embeds',
      {
        ...validEditArgs(),
        content: undefined,
        embeds: [{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }],
      },
    ],
    [
      'an embed with an image field',
      {
        ...validEditArgs(),
        content: undefined,
        embeds: [{ title: 't', image: { url: 'https://x.test/i.png' } }],
      },
    ],
    ['an empty embed', { ...validEditArgs(), content: undefined, embeds: [{}] }],
    [
      'embeds over 6000 characters in total',
      {
        ...validEditArgs(),
        content: undefined,
        embeds: [{ description: 'x'.repeat(4096) }, { description: 'y'.repeat(2005) }],
      },
    ],
    ['missing idempotency key', { ...validEditArgs(), idempotencyKey: undefined }],
    ['malformed channel id', { ...validEditArgs(), channelId: 'not-a-channel' }],
    ['malformed message id', { ...validEditArgs(), messageId: 'not-a-message' }],
    ['missing guild id', { ...validEditArgs(), guildId: undefined }],
  ])('%s is the argument fault and the port was never called', async (_label, args) => {
    const port = fakeWritesPort({ status: 'done', actionId: ACTION, messageId: MESSAGE });
    const outcome = await editMessageText(principalWith([GUILD_A]), port, args);
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(totalCalls(port)).toBe(0);
  });

  it('whitespace-only content without embeds is an argument fault', async () => {
    const port = fakeWritesPort({ status: 'done', actionId: ACTION, messageId: MESSAGE });
    const outcome = await editMessageText(principalWith([GUILD_A]), port, {
      ...validEditArgs(),
      content: '   ',
    });
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(totalCalls(port)).toBe(0);
  });

  it('embeds without content reach the port', async () => {
    let seen: Parameters<McpMessageWritesPort['edit']>[1] | undefined;
    const port: McpMessageWritesPort = {
      ...fakeWritesPort({ status: 'done', actionId: ACTION, messageId: MESSAGE }),
      edit: (_guildId, input) => {
        seen = input;
        return Promise.resolve({ status: 'done', actionId: ACTION, messageId: MESSAGE });
      },
    };
    const outcome = await editMessageText(principalWith([GUILD_A]), port, {
      guildId: '111111111111111111',
      channelId: CHANNEL,
      messageId: MESSAGE,
      embeds: [{ title: 'plan' }],
      idempotencyKey: 'key-embeds',
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toMatchObject({ channelId: CHANNEL, messageId: MESSAGE, content: undefined });
    expect(seen?.embeds).toHaveLength(1);
  });
});

describe('message-write ids are snowflakes before any port call (REST path safety)', () => {
  // An id goes into a REST route path unencoded, and a URL resolves `..`
  // segments: a traversal id must die at the argument boundary, never reach
  // the port (whole-branch review, slice 3).
  it.each(handlers)('%s refuses a path-traversal message id', async (_name, text, valid) => {
    const port = fakeWritesPort({ status: 'done', actionId: ACTION, messageId: MESSAGE });
    const outcome = await text(principalWith([GUILD_A]), port, {
      ...valid(),
      messageId: '../../../../guilds/111111111111111111/bans/222222222222222222',
    });
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(totalCalls(port)).toBe(0);
  });

  it.each(handlers)('%s refuses a path-traversal channel id', async (_name, text, valid) => {
    const port = fakeWritesPort({ status: 'done', actionId: ACTION, messageId: MESSAGE });
    const outcome = await text(principalWith([GUILD_A]), port, {
      ...valid(),
      channelId: '1/../../guilds/111111111111111111',
    });
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(totalCalls(port)).toBe(0);
  });
});

describe('reaction emoji shape (hard rule 3)', () => {
  it.each([
    ['a unicode emoji', '👍'],
    ['a guild emoji as name:id', 'partyblob:123456789012345678'],
  ])('%s reaches the port untouched', async (_label, emoji) => {
    let seen: string | undefined;
    const port: McpMessageWritesPort = {
      ...fakeWritesPort({ status: 'done', actionId: ACTION, messageId: MESSAGE }),
      addReaction: (_guildId, input) => {
        seen = input.emoji;
        return Promise.resolve({ status: 'done', actionId: ACTION, messageId: MESSAGE });
      },
    };
    const outcome = await addReactionText(principalWith([GUILD_A]), port, {
      ...validReactionArgs(),
      emoji,
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toBe(emoji);
  });

  it.each([
    ['a Discord-fenced custom emoji', '<:partyblob:123456789012345678>'],
    ['a custom emoji with a non-numeric id', 'partyblob:notanid'],
    ['a custom emoji with a short id', 'partyblob:123'],
    ['an empty emoji', ''],
    ['a bare name with a trailing colon', 'partyblob:'],
  ])('%s is the argument fault and the port was never called', async (_label, emoji) => {
    const port = fakeWritesPort({ status: 'done', actionId: ACTION, messageId: MESSAGE });
    const outcome = await addReactionText(principalWith([GUILD_A]), port, {
      ...validReactionArgs(),
      emoji,
    });
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(totalCalls(port)).toBe(0);
  });

  it('remove_reaction enforces the same shape', async () => {
    const port = fakeWritesPort({ status: 'done', actionId: ACTION, messageId: MESSAGE });
    const outcome = await removeReactionText(principalWith([GUILD_A]), port, {
      ...validReactionArgs(),
      emoji: '<:partyblob:123456789012345678>',
    });
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(totalCalls(port)).toBe(0);
  });
});

describe('message-write refusal rendering', () => {
  const cases: ReadonlyArray<readonly [McpMessageWriteRefusal, string]> = [
    ['channel-not-allowlisted', 'not on the send allowlist'],
    ['channel-not-in-guild', 'not a channel this guild'],
    ['bot-lacks-permission', 'lacks the'],
    ['protected-role-panel', 'role-panel'],
    ['protected-task-post', 'task post'],
    ['not-bot-authored', 'someone else'],
    ['not-found', 'no longer exists'],
    ['unknown-emoji', 'not usable in guild'],
    ['killswitch', 'kill switch'],
    ['breaker-open', 'circuit breaker'],
    ['rate-cap', 'budget'],
    ['duplicate-key-different-content', 'different write'],
    ['duplicate-content-recently', 'already'],
  ];

  it.each(handlers)(
    '%s renders every refusal distinctly, with ids and no content',
    async (_name, handler, args) => {
      const texts = new Map<McpMessageWriteRefusal, string>();
      for (const [reason] of cases) {
        const port = fakeWritesPort({ status: 'refused', reason, detail: 'PinMessages' });
        const outcome = await handler(principalWith([GUILD_A]), port, args());
        const text = messageOf(outcome);
        expect(text).toContain('111111111111111111');
        texts.set(reason, text);
      }
      // No two reasons share a string.
      expect(new Set(texts.values()).size).toBe(cases.length);
      for (const [reason, marker] of cases) {
        expect(texts.get(reason)).toContain(marker);
      }
    },
  );

  it('a pin without pin permission names both PinMessages and ManageMessages', async () => {
    const port = fakeWritesPort({
      status: 'refused',
      reason: 'bot-lacks-permission',
      detail: 'PinMessages',
    });
    for (const handler of [pinMessageText, unpinMessageText]) {
      const text = messageOf(await handler(principalWith([GUILD_A]), port, validPinArgs()));
      expect(text).toContain('PinMessages');
      expect(text).toContain('ManageMessages');
    }
  });
});

describe('message-write outcomes', () => {
  it('done names the action and the message', async () => {
    const port = fakeWritesPort({ status: 'done', actionId: ACTION, messageId: MESSAGE });
    expect(
      textOf(await editMessageText(principalWith([GUILD_A]), port, validEditArgs())),
    ).toContain(ACTION);
    expect(
      textOf(await deleteMessageText(principalWith([GUILD_A]), port, validDeleteArgs())),
    ).toContain('cannot be undone');
  });

  it('dry-run records without calling Discord content-free', async () => {
    const port = fakeWritesPort({ status: 'dry-run', actionId: ACTION });
    const text = textOf(
      await editMessageText(principalWith([GUILD_A]), port, {
        ...validEditArgs(),
        dryRun: true,
      }),
    );
    expect(text).toContain('Dry run');
    expect(text).toContain(ACTION);
  });

  it('replayed answers without a new write', async () => {
    const port = fakeWritesPort({ status: 'replayed', actionId: ACTION, messageId: MESSAGE });
    const text = textOf(await pinMessageText(principalWith([GUILD_A]), port, validPinArgs()));
    expect(text).toContain('Already recorded under this idempotency key');
    expect(text).toContain(ACTION);
  });

  it('failed reports an unknown result with the same key to retry on', async () => {
    const port = fakeWritesPort({ status: 'failed' });
    const text = messageOf(
      await deleteMessageText(principalWith([GUILD_A]), port, validDeleteArgs()),
    );
    expect(text).toContain('same idempotency key');
  });

  it.each(handlers)(
    '%s never throws: a port fault is the shared refusal',
    async (_name, handler, args) => {
      const failing: McpMessageWritesPort = {
        edit: () => Promise.reject(new Error('discord is down')),
        delete: () => Promise.reject(new Error('discord is down')),
        pin: () => Promise.reject(new Error('discord is down')),
        unpin: () => Promise.reject(new Error('discord is down')),
        addReaction: () => Promise.reject(new Error('discord is down')),
        removeReaction: () => Promise.reject(new Error('discord is down')),
      };
      const outcome = await handler(principalWith([GUILD_A]), failing, args());
      expect(outcome).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    },
  );
});

/** Minimal ports: this block pins registration, never the tools themselves. */
const stubHealth = (): McpHealthPort => ({
  startedAtMs: 1_700_000_000_000,
  readonly: false,
  env: 'test',
  gateway: () => ({ connected: true, pingMs: 42, guildCount: 1 }),
  now: () => 1_700_000_000_000,
  guilds: () => [],
});
const stubArchive = (): McpArchivePort => ({
  now: () => 1_700_000_000_000,
  listArchiveChannelIds: () => [],
  searchMessages: () => ({ total: 0, hits: [] }),
  findMessage: () => undefined,
  listChannelHistory: () => [],
  listMessagesSince: () => [],
  listUnansweredRoleMentions: () => [],
  messageMeta: () => Promise.resolve(undefined),
  botUserId: () => undefined,
});
const stubGuild = (): McpGuildPort => ({
  listChannels: () => [],
  listThreads: async () => [],
  listRoles: () => [],
  listMembers: () => Promise.resolve({ members: [], nextCursor: undefined }),
  memberCount: () => 0,
});
const stubRecords = (): McpRecordsPort => ({
  listRecentCases: () => [],
  findCase: () => undefined,
  listCaseEvents: () => [],
  tailAudit: () => [],
  listRules: () => [],
  listPanels: () => [],
});
const stubSend = (): McpSendPort => ({
  send: () => Promise.resolve({ status: 'sent', messageId: 'mid-test', actionId: 'act-test' }),
});
const stubWrites = (): McpMessageWritesPort =>
  fakeWritesPort({ status: 'done', actionId: 'act-test', messageId: 'mid-test' });
const stubJobs = (): McpJobsPort => ({
  listJobs: () => [],
  findJob: () => undefined,
});
const stubMembers = (): McpMembersPort => ({
  listAllMembers: () => Promise.resolve({ members: [], truncated: false }),
  lastMessageAt: () => new Map(),
  now: () => 1_700_000_000_000,
});
const stubContext = (): McpContextPort => ({
  serverCard: () => '',
  timeZone: 'America/Vancouver',
  now: () => 1_700_000_000_000,
  skills: () => [],
});
const stubResources = (): McpResourcesPort => ({
  listResources: () => [],
  searchChunks: () => [],
  resourceChunks: () => [],
});
const stubThreads = (): McpThreadsPort => ({
  archiveThread: () => [],
  threadInfo: () => Promise.resolve(undefined),
  privateThreadReadable: () => Promise.resolve(false),
  liveThreadMessages: () => Promise.resolve([]),
});

/** Required since slice 3 Task 5; never called by the message-write tools pinned here. */
const stubThreadWrites = (): McpThreadWritesPort => ({
  createThread: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  addThreadMembers: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  removeThreadMembers: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  createForumPost: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  setThreadState: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
});

/** Required for the four event tools; never called by the message-write tools pinned here. */
const stubEventWrites = (): McpEventWritesPort => ({
  createEvent: () => Promise.resolve({ status: 'done', actionId: 'act-test', eventId: 'evt-test' }),
  editEvent: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  cancelEvent: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  createPoll: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', messageId: 'mid-test' }),
});

/** Required for the four schedule tools; never called by the message-write tools pinned here. */
const stubSchedule = (): McpSchedulePort => ({
  scheduleMessage: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', reminderId: 'rem-test' }),
  listScheduled: () => [],
  editScheduled: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', reminderId: 'rem-test' }),
  cancelScheduled: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', reminderId: 'rem-test' }),
});

/** Required since slice 4 Task 3; never called by the message-write tools pinned here. */
const stubRoleWrites = (): McpRoleWritesPort => ({
  grant: () => Promise.resolve({ status: 'done', actionId: 'act-test', alreadyHad: false }),
  remove: () => Promise.resolve({ status: 'done', actionId: 'act-test', alreadyHad: false }),
});

const connectPair = async (
  principal: McpPrincipal,
): Promise<{ client: Client; close: () => Promise<void> }> => {
  const client = new Client({ name: 'mcp-writes-test-client', version: '0.0.0' });
  const server = createMcpServer({
    principal,
    health: stubHealth(),
    archive: stubArchive(),
    guild: stubGuild(),
    records: stubRecords(),
    send: stubSend(),
    messageWrites: stubWrites(),
    threadWrites: stubThreadWrites(),
    eventWrites: stubEventWrites(),
    schedule: stubSchedule(),
    roleWrites: stubRoleWrites(),
    readAudit: noopReadAudit,
    jobs: stubJobs(),
    members: stubMembers(),
    context: stubContext(),
    resources: stubResources(),
    threads: stubThreads(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

describe('message-write scope filtering (ruling M4-D17)', () => {
  const SEND_TOOL_NAMES = [
    'send_message',
    EDIT_MESSAGE_TOOL_NAME,
    DELETE_MESSAGE_TOOL_NAME,
    PIN_MESSAGE_TOOL_NAME,
    UNPIN_MESSAGE_TOOL_NAME,
    ADD_REACTION_TOOL_NAME,
    REMOVE_REACTION_TOOL_NAME,
  ];

  it('a read-only token sees none of the six message-write tools', async () => {
    const { client, close } = await connectPair(principalWith([GUILD_A], ['bananasaurs:read']));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of SEND_TOOL_NAMES) expect(names).not.toContain(name);
    } finally {
      await close();
    }
  });

  it('a send-only token sees send_message and the six message-write tools', async () => {
    const { client, close } = await connectPair(principalWith([GUILD_A], ['bananasaurs:send']));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      // The thread-write tools (Task 5), the event tools and the schedule
      // tools share the scope; this file pins its own six.
      expect(names).toHaveLength(21);
      expect(names).toEqual(expect.arrayContaining(SEND_TOOL_NAMES));
    } finally {
      await close();
    }
  });
});
