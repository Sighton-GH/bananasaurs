import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseGuildId, type GuildId } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE, INVALID_ARGUMENTS_MESSAGE, type McpPrincipal } from '../scope.js';
import { createMcpServer } from '../server.js';
import {
  ADD_THREAD_MEMBERS_TOOL_NAME,
  ARCHIVE_THREAD_TOOL_NAME,
  CREATE_FORUM_POST_TOOL_NAME,
  CREATE_THREAD_TOOL_NAME,
  LOCK_THREAD_TOOL_NAME,
  REMOVE_THREAD_MEMBERS_TOOL_NAME,
  addThreadMembersText,
  archiveThreadText,
  createForumPostText,
  createThreadText,
  lockThreadText,
  removeThreadMembersText,
  type McpThreadWriteOutcome,
  type McpThreadWriteRefusal,
  type McpThreadWritesPort,
} from './thread-writes.js';
import type { McpHealthPort } from './health.js';
import type { McpArchivePort } from './archive.js';
import type { McpGuildPort } from './guild.js';
import type { McpRecordsPort } from './records.js';
import type { McpSendPort } from './send.js';
import type { McpJobsPort } from './jobs.js';
import type { McpMembersPort } from './members.js';
import type { McpContextPort } from './context.js';
import type { McpResourcesPort } from './resources.js';
import type { McpThreadsPort } from './threads.js';
import type { McpReadAuditPort } from '../read-audit.js';
import type { McpMessageWritesPort } from './message-writes.js';
import type { McpEventWritesPort } from './event-writes.js';
import type { McpRoleWritesPort } from './role-writes.js';

/**
 * Task 5, tool layer: the six thread/forum write tools against a fake
 * `McpThreadWritesPort` — the same seam the daemon's gateway wiring
 * implements, so the guard behaviour pinned here (guild gate, argument
 * boundary, refusal rendering) holds whichever implementation sits behind
 * it.
 */

/** ADR 0050: this file does not exercise read logging; the server requires the port. */
const noopReadAudit: McpReadAuditPort = {
  auditContentRead: () => undefined,
  logStructuralRead: () => undefined,
};

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL = '333333333333333333';
const THREAD = '344444444444444444';
const FORUM = '355555555555555555';
const USER = '366666666666666666';
const ACTION = 'act-00000000000000000000000001';

const principalWith = (
  guilds: readonly GuildId[],
  scopes: readonly string[] = ['bananasaurs:send'],
): McpPrincipal => ({
  accountId: 'acct_00000000000000000000000000000000',
  reachableGuilds: guilds,
  scopes,
});

const createArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  channel: CHANNEL,
  name: 'planning thread',
  type: 'public',
  idempotencyKey: 'thread-k1',
  ...over,
});

const membersArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  threadId: THREAD,
  userIds: [USER],
  idempotencyKey: 'members-k1',
  ...over,
});

const forumArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  forum: FORUM,
  title: 'club question',
  content: 'when is the next build night?',
  idempotencyKey: 'forum-k1',
  ...over,
});

const archiveArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  threadId: THREAD,
  archived: true,
  idempotencyKey: 'archive-k1',
  ...over,
});

const lockArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guildId: '111111111111111111',
  threadId: THREAD,
  locked: true,
  idempotencyKey: 'lock-k1',
  ...over,
});

/** Fake thread-writes port: every call recorded, the outcome scripted per test. */
const fakeThreadPort = (
  outcome: McpThreadWriteOutcome,
): McpThreadWritesPort & { readonly calls: number; readonly lastInput: unknown } => {
  let calls = 0;
  let lastInput: unknown;
  const record = (input: unknown): Promise<McpThreadWriteOutcome> => {
    calls += 1;
    lastInput = input;
    return Promise.resolve(outcome);
  };
  return {
    get calls(): number {
      return calls;
    },
    get lastInput(): unknown {
      return lastInput;
    },
    createThread: (_guildId, input) => record(input),
    addThreadMembers: (_guildId, input) => record(input),
    removeThreadMembers: (_guildId, input) => record(input),
    createForumPost: (_guildId, input) => record(input),
    setThreadState: (_guildId, input) => record(input),
  };
};

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

describe('create_thread guild gate (CLAUDE.md rule 2)', () => {
  it.each([
    ['unreachable guild id', '222222222222222222', [GUILD_A]],
    ['malformed guild id', 'not-a-snowflake', [GUILD_A]],
    ['empty reachable set', '111111111111111111', []],
  ])('%s is the shared refusal and the port was never called', async (_label, guildId, guilds) => {
    const port = fakeThreadPort({ status: 'done', actionId: ACTION, threadId: THREAD });
    const outcome = await createThreadText(principalWith(guilds), port, createArgs({ guildId }));
    expect(messageOf(outcome)).toBe(GUILD_REFUSAL_MESSAGE);
    expect(port.calls).toBe(0);
  });

  it('a two-guild principal calling the other guild is refused without a port call', async () => {
    const port = fakeThreadPort({ status: 'done', actionId: ACTION, threadId: THREAD });
    const outcome = await createThreadText(principalWith([GUILD_B]), port, createArgs());
    expect(messageOf(outcome)).toBe(GUILD_REFUSAL_MESSAGE);
    expect(port.calls).toBe(0);
  });
});

describe('create_thread argument boundary (hard rule 3)', () => {
  it.each([
    ['missing idempotency key', { idempotencyKey: undefined }],
    ['empty idempotency key', { idempotencyKey: '' }],
    ['name over 100 characters', { name: 'n'.repeat(101) }],
    ['empty name', { name: '' }],
    ['bad thread type', { type: 'announcement' }],
    ['bad auto-archive minutes', { autoArchiveMinutes: 30 }],
    ['invitable on a public thread', { invitable: true }],
    ['fromMessageId on a private thread', { type: 'private', fromMessageId: '400000000000000000' }],
    ['malformed fromMessageId', { fromMessageId: 'nope' }],
    ['firstMessage with neither content nor embeds', { firstMessage: {} }],
    ['firstMessage with blank content', { firstMessage: { content: '   ' } }],
    [
      'firstMessage with four embeds',
      {
        firstMessage: { embeds: [{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }] },
      },
    ],
    [
      'firstMessage embed with an image field',
      { firstMessage: { embeds: [{ title: 'a', image: 'x' }] } },
    ],
  ])('%s is the argument fault and the port was never called', async (_label, over) => {
    const args: Record<string, unknown> = { ...createArgs() };
    for (const [key, value] of Object.entries(over)) {
      if (value === undefined) delete args[key];
      else args[key] = value;
    }
    const port = fakeThreadPort({ status: 'done', actionId: ACTION, threadId: THREAD });
    const outcome = await createThreadText(principalWith([GUILD_A]), port, args);
    expect(messageOf(outcome)).toBe(INVALID_ARGUMENTS_MESSAGE);
    expect(port.calls).toBe(0);
  });

  it('malformed channel and thread ids are the argument fault', async () => {
    const port = fakeThreadPort({ status: 'done', actionId: ACTION, threadId: THREAD });
    expect(
      messageOf(
        await createThreadText(principalWith([GUILD_A]), port, membersArgs({ threadId: 'nope' })),
      ),
    ).toBe(INVALID_ARGUMENTS_MESSAGE);
    expect(
      messageOf(
        await addThreadMembersText(
          principalWith([GUILD_A]),
          port,
          membersArgs({ userIds: [USER, 'nope'] }),
        ),
      ),
    ).toBe(INVALID_ARGUMENTS_MESSAGE);
    expect(port.calls).toBe(0);
  });

  it('member lists are capped at 25 and forum tags at 5', async () => {
    const port = fakeThreadPort({ status: 'done', actionId: ACTION });
    const tooManyUsers = Array.from({ length: 26 }, (_, i) => String(400000000000000000 + i));
    expect(
      messageOf(
        await addThreadMembersText(
          principalWith([GUILD_A]),
          port,
          membersArgs({ userIds: tooManyUsers }),
        ),
      ),
    ).toBe(INVALID_ARGUMENTS_MESSAGE);
    expect(
      messageOf(
        await removeThreadMembersText(principalWith([GUILD_A]), port, membersArgs({ userIds: [] })),
      ),
    ).toBe(INVALID_ARGUMENTS_MESSAGE);
    expect(
      messageOf(
        await createForumPostText(
          principalWith([GUILD_A]),
          port,
          forumArgs({ tags: ['a', 'b', 'c', 'd', 'e', 'f'] }),
        ),
      ),
    ).toBe(INVALID_ARGUMENTS_MESSAGE);
    expect(
      messageOf(
        await createForumPostText(
          principalWith([GUILD_A]),
          port,
          forumArgs({ title: 't'.repeat(101) }),
        ),
      ),
    ).toBe(INVALID_ARGUMENTS_MESSAGE);
    expect(
      messageOf(
        await createForumPostText(principalWith([GUILD_A]), port, {
          ...forumArgs(),
          content: undefined,
        }),
      ),
    ).toBe(INVALID_ARGUMENTS_MESSAGE);
    expect(port.calls).toBe(0);
  });
});

describe('thread-write ids are snowflakes before any port call (REST path safety)', () => {
  // Ids go into REST route paths unencoded and a URL resolves `..`: a
  // traversal id must die at the argument boundary (whole-branch review).
  const TRAVERSAL = '../../../guilds/111111111111111111/members/222222222222222222';
  it.each([
    ['create_thread fromMessageId', createThreadText, createArgs({ fromMessageId: TRAVERSAL })],
    ['add_thread_members userIds', addThreadMembersText, membersArgs({ userIds: [TRAVERSAL] })],
    [
      'remove_thread_members userIds',
      removeThreadMembersText,
      membersArgs({ userIds: [USER, TRAVERSAL] }),
    ],
    [
      'remove_thread_members threadId',
      removeThreadMembersText,
      membersArgs({ threadId: TRAVERSAL }),
    ],
    ['archive_thread threadId', archiveThreadText, archiveArgs({ threadId: TRAVERSAL })],
    ['lock_thread threadId', lockThreadText, lockArgs({ threadId: TRAVERSAL })],
  ] as const)('%s refuses a path-traversal id', async (_label, text, args) => {
    const port = fakeThreadPort({ status: 'done', actionId: ACTION, threadId: THREAD });
    expect(messageOf(await text(principalWith([GUILD_A]), port, args))).toBe(
      INVALID_ARGUMENTS_MESSAGE,
    );
    expect(port.calls).toBe(0);
  });
});

describe('create_thread outcomes', () => {
  it('a created thread names the thread id and the action', async () => {
    const port = fakeThreadPort({ status: 'done', actionId: ACTION, threadId: THREAD });
    const text = textOf(await createThreadText(principalWith([GUILD_A]), port, createArgs()));
    expect(text).toContain(THREAD);
    expect(text).toContain(ACTION);
    expect(text).toContain('public');
  });

  it('invitable defaults to false on the port input', async () => {
    const port = fakeThreadPort({ status: 'done', actionId: ACTION, threadId: THREAD });
    await createThreadText(principalWith([GUILD_A]), port, createArgs({ type: 'private' }));
    expect(port.calls).toBe(1);
    expect(port.lastInput).toMatchObject({ invitable: false, type: 'private' });
  });

  it('autoArchiveMinutes defaults to 1440 on the port input', async () => {
    const port = fakeThreadPort({ status: 'done', actionId: ACTION, threadId: THREAD });
    await createThreadText(principalWith([GUILD_A]), port, createArgs());
    expect(port.lastInput).toMatchObject({ autoArchiveMinutes: 1440 });
  });

  it('a created thread with a first message names the message id', async () => {
    const port = fakeThreadPort({
      status: 'done',
      actionId: ACTION,
      threadId: THREAD,
      messageId: '455555555555555555',
    });
    const text = textOf(
      await createThreadText(
        principalWith([GUILD_A]),
        port,
        createArgs({ firstMessage: { content: 'welcome' } }),
      ),
    );
    expect(text).toContain(THREAD);
    expect(text).toContain('455555555555555555');
  });

  it('a dry run names the action and posts nothing', async () => {
    const port = fakeThreadPort({ status: 'dry-run', actionId: ACTION });
    const text = textOf(
      await createThreadText(principalWith([GUILD_A]), port, createArgs({ dryRun: true })),
    );
    expect(text).toContain('nothing was created');
    expect(text).toContain(ACTION);
  });

  it('a replay names the same thread id and posts nothing new', async () => {
    const port = fakeThreadPort({ status: 'replayed', actionId: ACTION, threadId: THREAD });
    const text = textOf(await createThreadText(principalWith([GUILD_A]), port, createArgs()));
    expect(text).toContain('Already');
    expect(text).toContain(THREAD);
    expect(text).toContain(ACTION);
  });

  it('a replay with no stored thread id says the outcome is unknown', async () => {
    const port = fakeThreadPort({ status: 'replayed', actionId: ACTION });
    const text = textOf(await createThreadText(principalWith([GUILD_A]), port, createArgs()));
    expect(text).toContain('outcome is unknown');
    expect(text).not.toContain('Created');
  });

  it('a failed call says the result is unknown and reuses the key', async () => {
    const port = fakeThreadPort({ status: 'failed' });
    const message = messageOf(await createThreadText(principalWith([GUILD_A]), port, createArgs()));
    expect(message).toContain('unknown result');
    expect(message).toContain('same idempotency key');
  });

  it('a port throw is the shared refusal, never an exception', async () => {
    const port = fakeThreadPort({ status: 'done', actionId: ACTION, threadId: THREAD });
    const throwing: McpThreadWritesPort = {
      ...port,
      createThread: () => Promise.reject(new Error('boom')),
    };
    const outcome = await createThreadText(principalWith([GUILD_A]), throwing, createArgs());
    expect(messageOf(outcome)).toBe(GUILD_REFUSAL_MESSAGE);
  });
});

describe('thread-write refusals', () => {
  const reasons: McpThreadWriteRefusal[] = [
    'channel-not-allowlisted',
    'channel-not-in-guild',
    'bot-lacks-permission',
    'private-thread',
    'not-a-forum',
    'use-forum-post',
    'invalid-parent',
    'thread-not-found',
    'user-not-member',
    'tag-unknown',
    'ambiguous-channel',
    'killswitch',
    'breaker-open',
    'rate-cap',
    'duplicate-key-different-content',
    'duplicate-content-recently',
  ];

  it('no two reasons share a text', async () => {
    const texts = new Map<string, string>();
    for (const reason of reasons) {
      const detail =
        reason === 'bot-lacks-permission'
          ? 'ManageThreads'
          : reason === 'tag-unknown'
            ? JSON.stringify({ unknown: ['nope'], available: ['Question', 'Answers'] })
            : reason === 'ambiguous-channel'
              ? 'planning (111), planning (222)'
              : reason === 'rate-cap'
                ? '2026-10-01T00:00:00.000Z'
                : undefined;
      const port = fakeThreadPort({
        status: 'refused',
        reason,
        ...(detail !== undefined ? { detail } : {}),
      });
      const message = messageOf(
        await createThreadText(principalWith([GUILD_A]), port, createArgs()),
      );
      texts.set(reason, message);
    }
    expect(new Set(texts.values()).size).toBe(reasons.length);
  });

  it('create_thread in a forum points at create_forum_post', async () => {
    const port = fakeThreadPort({ status: 'refused', reason: 'use-forum-post' });
    const message = messageOf(await createThreadText(principalWith([GUILD_A]), port, createArgs()));
    expect(message).toContain('forum');
    expect(message).toContain(CREATE_FORUM_POST_TOOL_NAME);
  });

  it('an unknown forum tag lists the available tag names', async () => {
    const port = fakeThreadPort({
      status: 'refused',
      reason: 'tag-unknown',
      detail: JSON.stringify({ unknown: ['nope'], available: ['Question', 'Answers'] }),
    });
    const message = messageOf(
      await createForumPostText(principalWith([GUILD_A]), port, forumArgs({ tags: ['nope'] })),
    );
    expect(message).toContain('Question');
    expect(message).toContain('Answers');
    expect(message).toContain('nope');
  });

  it('a missing thread names the thread id', async () => {
    const port = fakeThreadPort({ status: 'refused', reason: 'thread-not-found' });
    const message = messageOf(
      await archiveThreadText(principalWith([GUILD_A]), port, archiveArgs()),
    );
    expect(message).toContain(THREAD);
  });

  it('a non-member names the user id', async () => {
    const port = fakeThreadPort({
      status: 'refused',
      reason: 'user-not-member',
      detail: USER,
    });
    const message = messageOf(
      await addThreadMembersText(principalWith([GUILD_A]), port, membersArgs()),
    );
    expect(message).toContain(USER);
  });

  it('the kill switch refuses every write tool without a port call beyond the one made', async () => {
    for (const call of [
      () =>
        createThreadText(
          principalWith([GUILD_A]),
          fakeThreadPort({ status: 'refused', reason: 'killswitch' }),
          createArgs(),
        ),
      () =>
        addThreadMembersText(
          principalWith([GUILD_A]),
          fakeThreadPort({ status: 'refused', reason: 'killswitch' }),
          membersArgs(),
        ),
      () =>
        removeThreadMembersText(
          principalWith([GUILD_A]),
          fakeThreadPort({ status: 'refused', reason: 'killswitch' }),
          membersArgs(),
        ),
      () =>
        createForumPostText(
          principalWith([GUILD_A]),
          fakeThreadPort({ status: 'refused', reason: 'killswitch' }),
          forumArgs(),
        ),
      () =>
        archiveThreadText(
          principalWith([GUILD_A]),
          fakeThreadPort({ status: 'refused', reason: 'killswitch' }),
          archiveArgs(),
        ),
      () =>
        lockThreadText(
          principalWith([GUILD_A]),
          fakeThreadPort({ status: 'refused', reason: 'killswitch' }),
          lockArgs(),
        ),
    ]) {
      expect(messageOf(await call())).toContain('kill switch');
    }
  });

  it('a reused key for other arguments says to retry with a fresh key', async () => {
    const port = fakeThreadPort({ status: 'refused', reason: 'duplicate-key-different-content' });
    const message = messageOf(
      await createForumPostText(principalWith([GUILD_A]), port, forumArgs()),
    );
    expect(message).toContain('fresh key');
  });
});

describe('member and state outcomes', () => {
  it('added members name the thread and the action', async () => {
    const port = fakeThreadPort({ status: 'done', actionId: ACTION });
    const text = textOf(await addThreadMembersText(principalWith([GUILD_A]), port, membersArgs()));
    expect(text).toContain(THREAD);
    expect(text).toContain(ACTION);
    expect(text).toContain('added 1 member');
  });

  it('removed members name the thread and the action', async () => {
    const port = fakeThreadPort({ status: 'done', actionId: ACTION });
    const text = textOf(
      await removeThreadMembersText(
        principalWith([GUILD_A]),
        port,
        membersArgs({ userIds: [USER, '377777777777777777'] }),
      ),
    );
    expect(text).toContain('removed 2 members');
  });

  it('archiving and locking name the new state', async () => {
    const port = fakeThreadPort({ status: 'done', actionId: ACTION });
    expect(
      textOf(await archiveThreadText(principalWith([GUILD_A]), port, archiveArgs())),
    ).toContain('Archived');
    expect(
      textOf(
        await archiveThreadText(principalWith([GUILD_A]), port, archiveArgs({ archived: false })),
      ),
    ).toContain('Unarchived');
    expect(textOf(await lockThreadText(principalWith([GUILD_A]), port, lockArgs()))).toContain(
      'Locked',
    );
    expect(
      textOf(await lockThreadText(principalWith([GUILD_A]), port, lockArgs({ locked: false }))),
    ).toContain('Unlocked');
  });

  it('a forum post names the thread, the starter message and the action', async () => {
    const port = fakeThreadPort({
      status: 'done',
      actionId: ACTION,
      threadId: THREAD,
      messageId: '455555555555555555',
    });
    const text = textOf(await createForumPostText(principalWith([GUILD_A]), port, forumArgs()));
    expect(text).toContain(THREAD);
    expect(text).toContain('455555555555555555');
    expect(text).toContain(ACTION);
    expect(text).toContain(FORUM);
  });
});

/** Minimal ports: this file pins the thread-write tools, never the other tools. */
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
  listThreads: () => Promise.resolve([]),
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
  send: () => Promise.resolve({ status: 'sent', messageId: 'mid', actionId: 'act-test' }),
});
const stubThreadWrites = (): McpThreadWritesPort => ({
  createThread: () => Promise.resolve({ status: 'done', actionId: 'act-test', threadId: THREAD }),
  addThreadMembers: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  removeThreadMembers: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  createForumPost: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', threadId: THREAD }),
  setThreadState: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
});
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

/** Required since slice 3 Task 6; never called by the thread-write tools pinned here. */
const stubMessageWrites = (): McpMessageWritesPort => ({
  edit: () => Promise.resolve({ status: 'done', actionId: 'act-test', messageId: 'mid-test' }),
  delete: () => Promise.resolve({ status: 'done', actionId: 'act-test', messageId: 'mid-test' }),
  pin: () => Promise.resolve({ status: 'done', actionId: 'act-test', messageId: 'mid-test' }),
  unpin: () => Promise.resolve({ status: 'done', actionId: 'act-test', messageId: 'mid-test' }),
  addReaction: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', messageId: 'mid-test' }),
  removeReaction: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', messageId: 'mid-test' }),
});

/** Required for the four event tools; never called by the thread-write tools pinned here. */
const stubEventWrites = (): McpEventWritesPort => ({
  createEvent: () => Promise.resolve({ status: 'done', actionId: 'act-test', eventId: 'evt-test' }),
  editEvent: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  cancelEvent: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  createPoll: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', messageId: 'mid-test' }),
});

/** Required since slice 4 Task 3; never called by the thread-write tools pinned here. */
const stubRoleWrites = (): McpRoleWritesPort => ({
  grant: () => Promise.resolve({ status: 'done', actionId: 'act-test', alreadyHad: false }),
  remove: () => Promise.resolve({ status: 'done', actionId: 'act-test', alreadyHad: false }),
});

const connectPair = async (
  principal: McpPrincipal,
): Promise<{ client: Client; close: () => Promise<void> }> => {
  const client = new Client({ name: 'mcp-thread-writes-test-client', version: '0.0.0' });
  const server = createMcpServer({
    principal,
    health: stubHealth(),
    archive: stubArchive(),
    guild: stubGuild(),
    records: stubRecords(),
    send: stubSend(),
    messageWrites: stubMessageWrites(),
    threadWrites: stubThreadWrites(),
    eventWrites: stubEventWrites(),
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

describe('thread-write scope filtering (ruling M4-D17)', () => {
  it('a send-only token sees send_message plus the six thread-write tools', async () => {
    const { client, close } = await connectPair(principalWith([GUILD_A]));
    try {
      const list = await client.listTools();
      // The message-write and event tools share the scope; this file pins its own six.
      const names = list.tools.map((tool) => tool.name);
      expect(names).toHaveLength(17);
      expect(names.slice(0, 7)).toEqual([
        'send_message',
        CREATE_THREAD_TOOL_NAME,
        ADD_THREAD_MEMBERS_TOOL_NAME,
        REMOVE_THREAD_MEMBERS_TOOL_NAME,
        CREATE_FORUM_POST_TOOL_NAME,
        ARCHIVE_THREAD_TOOL_NAME,
        LOCK_THREAD_TOOL_NAME,
      ]);
    } finally {
      await close();
    }
  });

  it('a read-only token sees none of the thread-write tools', async () => {
    const { client, close } = await connectPair(principalWith([GUILD_A], ['bananasaurs:read']));
    try {
      const list = await client.listTools();
      const names = list.tools.map((tool) => tool.name);
      for (const name of [
        CREATE_THREAD_TOOL_NAME,
        ADD_THREAD_MEMBERS_TOOL_NAME,
        REMOVE_THREAD_MEMBERS_TOOL_NAME,
        CREATE_FORUM_POST_TOOL_NAME,
        ARCHIVE_THREAD_TOOL_NAME,
        LOCK_THREAD_TOOL_NAME,
      ]) {
        expect(names).not.toContain(name);
      }
    } finally {
      await close();
    }
  });
});
