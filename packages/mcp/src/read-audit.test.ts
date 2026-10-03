import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseGuildId, type GuildId } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE, type McpPrincipal } from './scope.js';
import {
  MCP_READ_GET_HEALTH,
  MCP_READ_GET_MESSAGE,
  MCP_READ_GET_MOD_CASE,
  MCP_READ_GET_SERVER_OVERVIEW,
  MCP_READ_LIST_AUDIT_EVENTS,
  MCP_READ_LIST_CHANNELS,
  MCP_READ_LIST_MEMBERS,
  MCP_READ_LIST_MOD_CASES,
  MCP_READ_LIST_ROLES,
  MCP_READ_LIST_UNANSWERED,
  MCP_READ_OPEN_RESOURCE,
  MCP_READ_READ_CHANNEL_HISTORY,
  MCP_READ_READ_DIGEST,
  MCP_READ_READ_THREAD,
  MCP_READ_SEARCH_MESSAGES,
  MCP_READ_SEARCH_RESOURCES,
  type McpContentReadRecord,
  type McpReadAuditPort,
} from './read-audit.js';
import { createMcpServer } from './server.js';
import {
  GET_MESSAGE_TOOL_NAME,
  getMessageText,
  readChannelHistoryText,
  searchMessagesText,
  type McpArchivePort,
} from './tools/archive.js';
import { GET_HEALTH_TOOL_NAME, getHealthText, type McpHealthPort } from './tools/health.js';
import {
  LIST_CHANNELS_TOOL_NAME,
  listChannelsText,
  listMembersText,
  listRolesText,
  type McpGuildPort,
} from './tools/guild.js';
import {
  getModCaseText,
  getServerOverviewText,
  listAuditEventsText,
  listModCasesText,
  type McpRecordsPort,
} from './tools/records.js';
import { OVERVIEW_RESOURCE_URI_TEMPLATE, readOverviewResource } from './resources/overview.js';
import type { McpSendPort } from './tools/send.js';
import type { McpMessageWritesPort } from './tools/message-writes.js';
import type { McpEventWritesPort } from './tools/event-writes.js';
import type { McpSchedulePort } from './tools/schedule.js';
import type { McpJobsPort } from './tools/jobs.js';
import type { McpMembersPort } from './tools/members.js';
import type { McpContextPort } from './tools/context.js';
import { openResourceText, searchResourcesText, type McpResourcesPort } from './tools/resources.js';
import { readThreadText, type McpThreadsPort } from './tools/threads.js';
import type { McpThreadWritesPort } from './tools/thread-writes.js';
import type { McpRoleWritesPort } from './tools/role-writes.js';
import { listUnansweredText, readDigestText } from './tools/digest.js';

/**
 * ADR 0050, tool layer: every successful read annotates its outcome with the
 * record the server must perform — one content record (an audit row) for the
 * six tools that return members' words or moderation history, one structural
 * record (an info line) for the tools that return only structure — and every
 * refusal annotates nothing, because nothing was read.
 *
 * The privacy half is asserted by shape, not by hope: the record type has no
 * field that could carry a query string, a message body or returned content,
 * and the serialised record is checked against the operator's own search
 * text. A log of what someone searched for is itself a record of member
 * content, so the query can never ride along.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL = '333333333333333333';
const MESSAGE = '444444444444444444';
const CASE = 'case-0001';

const principalWith = (...guilds: readonly GuildId[]): McpPrincipal => ({
  accountId: 'acct_00000000000000000000000000000000',
  reachableGuilds: guilds,
  scopes: ['bananasaurs:read'],
});

const archivePort = (): McpArchivePort => ({
  now: () => 1,
  listArchiveChannelIds: () => [CHANNEL],
  searchMessages: () => ({
    total: 3,
    hits: [
      { messageId: MESSAGE, channelId: CHANNEL, authorId: undefined, createdAt: 1, excerpt: 'x' },
    ],
  }),
  findMessage: () => undefined,
  listChannelHistory: () => [
    {
      messageId: MESSAGE,
      channelId: CHANNEL,
      threadId: undefined,
      authorId: undefined,
      content: null,
      createdAt: 1,
      contentPurgedAt: undefined,
      replyToMessageId: undefined,
    },
  ],
  listMessagesSince: () => [
    {
      messageId: MESSAGE,
      channelId: CHANNEL,
      threadId: undefined,
      authorId: undefined,
      content: null,
      createdAt: 1,
      contentPurgedAt: undefined,
      replyToMessageId: undefined,
    },
  ],
  listUnansweredRoleMentions: () => [],
  messageMeta: () => Promise.resolve(undefined),
  botUserId: () => undefined,
});

const recordsPort = (tailAuditInput?: { captured: unknown }): McpRecordsPort => ({
  listRecentCases: () => [
    {
      caseId: CASE,
      memberId: 'm',
      openedAt: 1,
      violationCount: 1,
      escalationTier: 0,
      status: 'open',
    },
  ],
  findCase: () => ({
    caseId: CASE,
    memberId: 'm',
    openedAt: 1,
    violationCount: 1,
    escalationTier: 0,
    status: 'open',
  }),
  listCaseEvents: () => [
    {
      eventId: 'e1',
      ruleId: 'r1',
      memberId: 'm',
      at: 1,
      matchedCategory: 'spam',
      matchedSnippet: 'x',
      actionTaken: 'warn',
      escalationAction: undefined,
      refusalReason: undefined,
      actorId: undefined,
    },
  ],
  tailAudit: (_guildId, input) => {
    if (tailAuditInput !== undefined) tailAuditInput.captured = input;
    return [];
  },
  listRules: () => [],
  listPanels: () => [],
});

const guildPort = (): McpGuildPort => ({
  listChannels: () => [
    {
      id: CHANNEL,
      name: 'general',
      type: 'GuildText',
      parentId: undefined,
      parentName: undefined,
      topic: undefined,
      archiveEnabled: true,
    },
  ],
  listThreads: async () => [],
  listRoles: () => [
    { id: '555555555555555555', name: 'dev', position: 1, color: 0, managedByBananasaurs: false },
  ],
  listMembers: () =>
    Promise.resolve({
      members: [
        {
          id: '666666666666666666',
          username: 'sam',
          displayName: 'sam',
          roleIds: [],
          joinedAt: undefined,
        },
      ],
      nextCursor: undefined,
    }),
  memberCount: () => 42,
});

const healthPort = (): McpHealthPort => ({
  startedAtMs: 0,
  readonly: false,
  env: 'test',
  now: () => 1000,
  gateway: () => ({ connected: true, pingMs: 1, guildCount: 2 }),
  guilds: () => [],
});

describe('ADR 0050: content-bearing reads annotate an audit record', () => {
  it('search_messages records guild, tool and result count — never the query', () => {
    const outcome = searchMessagesText(principalWith(GUILD_A), archivePort(), guildPort(), {
      guildId: String(GUILD_A),
      query: 'secret operator query text',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.read).toEqual({
      kind: 'content',
      action: MCP_READ_SEARCH_MESSAGES,
      guildId: GUILD_A,
      subjectType: 'guild',
      subjectId: undefined,
      resultCount: 3,
    });
    expect(JSON.stringify(outcome.read)).not.toContain('secret operator query text');
  });

  it('read_channel_history records the channel as subject', () => {
    const outcome = readChannelHistoryText(principalWith(GUILD_A), archivePort(), guildPort(), {
      guildId: String(GUILD_A),
      channelId: CHANNEL,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.read).toMatchObject({
      kind: 'content',
      action: MCP_READ_READ_CHANNEL_HISTORY,
      subjectType: 'channel',
      subjectId: CHANNEL,
      resultCount: 1,
    });
  });

  it('get_message records the message id, found or not — the read happened either way', async () => {
    const found = await getMessageText(principalWith(GUILD_A), archivePort(), {
      guildId: String(GUILD_A),
      messageId: MESSAGE,
    });
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error('expected ok');
    expect(found.read).toMatchObject({
      kind: 'content',
      action: MCP_READ_GET_MESSAGE,
      subjectType: 'message',
      subjectId: MESSAGE,
      resultCount: 0,
    });
  });

  it('list_mod_cases and get_mod_case record, the case read keyed by case id', () => {
    const list = listModCasesText(principalWith(GUILD_A), recordsPort(), {
      guildId: String(GUILD_A),
    });
    expect(list.ok).toBe(true);
    if (!list.ok) throw new Error('expected ok');
    expect(list.read).toMatchObject({
      kind: 'content',
      action: MCP_READ_LIST_MOD_CASES,
      subjectType: 'guild',
      resultCount: 1,
    });
    const one = getModCaseText(principalWith(GUILD_A), recordsPort(), {
      guildId: String(GUILD_A),
      caseId: CASE,
    });
    expect(one.ok).toBe(true);
    if (!one.ok) throw new Error('expected ok');
    expect(one.read).toMatchObject({
      kind: 'content',
      action: MCP_READ_GET_MOD_CASE,
      subjectType: 'mod_case',
      subjectId: CASE,
      resultCount: 1,
    });
  });

  it('list_audit_events is audited, and its own action is excluded from its results (ADR 0050)', () => {
    const captured: { captured: unknown } = { captured: undefined };
    const outcome = listAuditEventsText(principalWith(GUILD_A), recordsPort(captured), {
      guildId: String(GUILD_A),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.read).toMatchObject({
      kind: 'content',
      action: MCP_READ_LIST_AUDIT_EVENTS,
      subjectType: 'guild',
    });
    expect(captured.captured).toMatchObject({ excludeActions: [MCP_READ_LIST_AUDIT_EVENTS] });
  });

  it('search_resources records a guild content read with the hit count', () => {
    const outcome = searchResourcesText(
      principalWith(GUILD_A),
      {
        listResources: () => [
          { id: 'handbook', title: 'Handbook', kind: 'document', url: 'https://example.com/h' },
        ],
        searchChunks: () => [
          {
            chunkId: 'c1',
            docId: 'd1',
            resourceId: 'handbook',
            headingPath: 'H',
            text: 'secret operator query text',
          },
        ],
        resourceChunks: () => [],
      },
      { guildId: String(GUILD_A), query: 'secret operator query text' },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.read).toEqual({
      kind: 'content',
      action: MCP_READ_SEARCH_RESOURCES,
      guildId: GUILD_A,
      subjectType: 'guild',
      subjectId: undefined,
      resultCount: 1,
    });
    expect(JSON.stringify(outcome.read)).not.toContain('secret operator query text');
  });

  it('open_resource records a resource content read keyed by resource id', () => {
    const port: McpResourcesPort = {
      listResources: () => [
        { id: 'handbook', title: 'Handbook', kind: 'document', url: 'https://example.com/h' },
      ],
      searchChunks: () => [],
      resourceChunks: () => [
        { chunkId: 'c1', docId: 'd1', resourceId: 'handbook', headingPath: 'H', text: 'body' },
      ],
    };
    const outcome = openResourceText(principalWith(GUILD_A), port, {
      guildId: String(GUILD_A),
      resourceId: 'handbook',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.read).toEqual({
      kind: 'content',
      action: MCP_READ_OPEN_RESOURCE,
      guildId: GUILD_A,
      subjectType: 'resource',
      subjectId: 'handbook',
      resultCount: 1,
    });
  });

  it('read_digest and list_unanswered record guild content reads', () => {
    const digestGuild: McpGuildPort = {
      ...guildPort(),
      listRoles: () => [
        {
          id: '777777777777777777',
          name: 'help',
          position: 1,
          color: 0,
          managedByBananasaurs: false,
        },
      ],
    };
    const digest = readDigestText(principalWith(GUILD_A), archivePort(), digestGuild, {
      guildId: String(GUILD_A),
      channels: [CHANNEL],
      since: 0,
    });
    expect(digest.ok).toBe(true);
    if (!digest.ok) throw new Error('expected ok');
    expect(digest.read).toEqual({
      kind: 'content',
      action: MCP_READ_READ_DIGEST,
      guildId: GUILD_A,
      subjectType: 'guild',
      subjectId: undefined,
      resultCount: 1,
    });
    const unanswered = listUnansweredText(principalWith(GUILD_A), archivePort(), digestGuild, {
      guildId: String(GUILD_A),
      helpRole: 'help',
    });
    expect(unanswered.ok).toBe(true);
    if (!unanswered.ok) throw new Error('expected ok');
    expect(unanswered.read).toEqual({
      kind: 'content',
      action: MCP_READ_LIST_UNANSWERED,
      guildId: GUILD_A,
      subjectType: 'guild',
      subjectId: undefined,
      resultCount: 0,
    });
  });

  it('read_thread records a public thread read and a live private read by subject', async () => {
    const THREAD = '800000000000000001';
    const PRIVATE = '800000000000000002';
    const port: McpThreadsPort = {
      archiveThread: () => [
        {
          messageId: MESSAGE,
          channelId: CHANNEL,
          threadId: THREAD,
          authorId: undefined,
          content: null,
          createdAt: 1,
          contentPurgedAt: undefined,
          replyToMessageId: undefined,
        },
      ],
      threadInfo: (guildId, threadId) => {
        void guildId;
        return Promise.resolve(
          threadId === THREAD
            ? { id: THREAD, name: 'build night', parentId: CHANNEL, isPrivate: false }
            : threadId === PRIVATE
              ? { id: PRIVATE, name: 'secret', parentId: CHANNEL, isPrivate: true }
              : undefined,
        );
      },
      privateThreadReadable: () => Promise.resolve(true),
      liveThreadMessages: () => Promise.resolve([]),
    };
    const pub = await readThreadText(principalWith(GUILD_A), port, {
      guildId: String(GUILD_A),
      threadId: THREAD,
    });
    expect(pub.ok).toBe(true);
    if (!pub.ok) throw new Error('expected ok');
    expect(pub.read).toEqual({
      kind: 'content',
      action: MCP_READ_READ_THREAD,
      guildId: GUILD_A,
      subjectType: 'thread',
      subjectId: THREAD,
      resultCount: 1,
    });
    const priv = await readThreadText(principalWith(GUILD_A), port, {
      guildId: String(GUILD_A),
      threadId: PRIVATE,
    });
    expect(priv.ok).toBe(true);
    if (!priv.ok) throw new Error('expected ok');
    expect(priv.read).toMatchObject({
      kind: 'content',
      action: MCP_READ_READ_THREAD,
      subjectType: 'private_thread',
      subjectId: PRIVATE,
    });
  });
});

describe('ADR 0050: structural reads annotate a log record, never an audit row', () => {
  it('list_channels, list_roles and list_members record structural reads with counts', () => {
    const channels = listChannelsText(principalWith(GUILD_A), guildPort(), {
      guildId: String(GUILD_A),
    });
    expect(channels.ok).toBe(true);
    if (!channels.ok) throw new Error('expected ok');
    expect(channels.read).toEqual({
      kind: 'structural',
      action: MCP_READ_LIST_CHANNELS,
      guildIds: [GUILD_A],
      resultCount: 1,
    });
    const roles = listRolesText(principalWith(GUILD_A), guildPort(), { guildId: String(GUILD_A) });
    expect(roles.ok).toBe(true);
    if (!roles.ok) throw new Error('expected ok');
    expect(roles.read).toMatchObject({ kind: 'structural', action: MCP_READ_LIST_ROLES });
    // `list_members` is async and is pinned by the test below. It was
    // asserted here too, inside an un-awaited async IIFE — assertions a
    // failing run could never surface, which is worse than no assertion.
  });

  it('list_members records a structural read', async () => {
    const members = await listMembersText(principalWith(GUILD_A), guildPort(), {
      guildId: String(GUILD_A),
    });
    expect(members.ok).toBe(true);
    if (!members.ok) throw new Error('expected ok');
    expect(members.read).toEqual({
      kind: 'structural',
      action: MCP_READ_LIST_MEMBERS,
      guildIds: [GUILD_A],
      resultCount: 1,
    });
  });

  it('get_health records one structural read per reachable guild (hard rule 2)', () => {
    const outcome = getHealthText(principalWith(GUILD_A, GUILD_B), healthPort());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.read).toEqual({
      kind: 'structural',
      action: MCP_READ_GET_HEALTH,
      guildIds: [GUILD_A, GUILD_B],
      resultCount: undefined,
    });
  });

  it('get_server_overview and its resource door record structural reads (ADR 0050)', () => {
    const tool = getServerOverviewText(principalWith(GUILD_A), guildPort(), recordsPort(), {
      guildId: String(GUILD_A),
    });
    expect(tool.ok).toBe(true);
    if (!tool.ok) throw new Error('expected ok');
    expect(tool.read).toMatchObject({ kind: 'structural', action: MCP_READ_GET_SERVER_OVERVIEW });
    const resource = readOverviewResource(
      principalWith(GUILD_A),
      guildPort(),
      recordsPort(),
      String(GUILD_A),
    );
    expect(resource.ok).toBe(true);
    if (!resource.ok) throw new Error('expected ok');
    expect(resource.read).toMatchObject({
      kind: 'structural',
      action: MCP_READ_GET_SERVER_OVERVIEW,
      guildIds: [GUILD_A],
    });
  });
});

describe('ADR 0050: a refused read annotates nothing', () => {
  it('guild refusal, argument fault and empty reachable set carry no record', () => {
    const refused = searchMessagesText(principalWith(GUILD_B), archivePort(), guildPort(), {
      guildId: String(GUILD_A),
      query: 'x',
    });
    expect(refused).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    const invalidArgs = searchMessagesText(principalWith(GUILD_A), archivePort(), guildPort(), {
      guildId: 7,
    });
    expect(invalidArgs.ok).toBe(false);
    if (invalidArgs.ok) throw new Error('expected refusal');
    expect('read' in invalidArgs && invalidArgs.read !== undefined).toBe(false);
    const healthRefused = getHealthText(principalWith(), healthPort());
    expect(healthRefused).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
  });
});

/**
 * ADR 0050, fail closed. The ADR's strongest claim is that a read whose
 * record cannot be written is refused rather than served unrecorded, so it
 * is asserted the only way a guard may be trusted: by watching it fail. A
 * port that throws stands in for the failure that matters in production —
 * the `audit_events` insert not landing — and the assertion is not merely
 * that the call errored but that the member content the read had already
 * fetched never reaches the connector.
 */

const SECRET_MESSAGE_TEXT = 'the member words this read must never leak unrecorded';

/** An archive that really returns a member's words, so a leak would be visible. */
const contentfulArchivePort = (): McpArchivePort => ({
  ...archivePort(),
  findMessage: () => ({
    messageId: MESSAGE,
    channelId: CHANNEL,
    threadId: undefined,
    authorId: '666666666666666666',
    content: SECRET_MESSAGE_TEXT,
    createdAt: 1,
    contentPurgedAt: undefined,
    replyToMessageId: undefined,
  }),
});

const stubSendPort = (): McpSendPort => ({
  send: () => Promise.resolve({ status: 'sent', messageId: 'mid-test', actionId: 'act-test' }),
});

/** Minimal message-writes port: this file pins read logging, never the write tools. */
const stubMessageWritesPort = (): McpMessageWritesPort => ({
  edit: () => Promise.resolve({ status: 'done', actionId: 'act-test', messageId: 'mid-test' }),
  delete: () => Promise.resolve({ status: 'done', actionId: 'act-test', messageId: 'mid-test' }),
  pin: () => Promise.resolve({ status: 'done', actionId: 'act-test', messageId: 'mid-test' }),
  unpin: () => Promise.resolve({ status: 'done', actionId: 'act-test', messageId: 'mid-test' }),
  addReaction: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', messageId: 'mid-test' }),
  removeReaction: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', messageId: 'mid-test' }),
});

/** Minimal event-writes port: required for the four event tools; never called by the reads pinned here. */
const stubEventWritesPort = (): McpEventWritesPort => ({
  createEvent: () => Promise.resolve({ status: 'done', actionId: 'act-test', eventId: 'evt-test' }),
  editEvent: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  cancelEvent: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  createPoll: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', messageId: 'mid-test' }),
});

/** Minimal schedule port: required for the four schedule tools; never called by the reads pinned here. */
const stubSchedulePort = (): McpSchedulePort => ({
  scheduleMessage: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', reminderId: 'rem-test' }),
  listScheduled: () => [],
  editScheduled: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', reminderId: 'rem-test' }),
  cancelScheduled: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', reminderId: 'rem-test' }),
});

/** Minimal jobs port: this file pins read logging, never the jobs tools. */
const stubJobsPort = (): McpJobsPort => ({
  listJobs: () => [],
  findJob: () => undefined,
});

/** Minimal members port: this file pins read logging, never the member tools. */
const stubMembersPort = (): McpMembersPort => ({
  listAllMembers: () => Promise.resolve({ members: [], truncated: false }),
  lastMessageAt: () => new Map(),
  now: () => 1_700_000_000_000,
});

/** Minimal context port: this file pins read logging, never the context tool. */
const stubContextPort = (): McpContextPort => ({
  serverCard: () => '',
  timeZone: 'America/Vancouver',
  now: () => 1_700_000_000_000,
  skills: () => [],
});

/** Minimal resources port: this file pins read logging, never the resource tools. */
const stubResourcesPort = (): McpResourcesPort => ({
  listResources: () => [],
  searchChunks: () => [],
  resourceChunks: () => [],
});

/** Minimal threads port: this file pins read logging, never the thread tool. */
const stubThreadsPort = (): McpThreadsPort => ({
  archiveThread: () => [],
  threadInfo: () => Promise.resolve(undefined),
  privateThreadReadable: () => Promise.resolve(false),
  liveThreadMessages: () => Promise.resolve([]),
});

/** Minimal thread-writes port: required since slice 3 Task 5; never called by the reads pinned here. */
const stubThreadWritesPort = (): McpThreadWritesPort => ({
  createThread: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  addThreadMembers: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  removeThreadMembers: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  createForumPost: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  setThreadState: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
});

/** Minimal role-writes port: required since slice 4 Task 3; never called by the reads pinned here. */
const stubRoleWritesPort = (): McpRoleWritesPort => ({
  grant: () => Promise.resolve({ status: 'done', actionId: 'act-test', alreadyHad: false }),
  remove: () => Promise.resolve({ status: 'done', actionId: 'act-test', alreadyHad: false }),
});

/** One connected client/server pair whose read-audit port is the one under test. */
const connectWithReadAudit = async (
  readAudit: McpReadAuditPort,
): Promise<{ client: Client; close: () => Promise<void> }> => {
  const client = new Client({ name: 'mcp-read-audit-test-client', version: '0.0.0' });
  const server = createMcpServer({
    principal: principalWith(GUILD_A),
    health: healthPort(),
    archive: contentfulArchivePort(),
    guild: guildPort(),
    records: recordsPort(),
    readAudit,
    jobs: stubJobsPort(),
    members: stubMembersPort(),
    context: stubContextPort(),
    resources: stubResourcesPort(),
    threads: stubThreadsPort(),
    send: stubSendPort(),
    threadWrites: stubThreadWritesPort(),
    messageWrites: stubMessageWritesPort(),
    eventWrites: stubEventWritesPort(),
    schedule: stubSchedulePort(),
    roleWrites: stubRoleWritesPort(),
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

const toolTextOf = (result: CallToolResult): string =>
  (result.content as ReadonlyArray<{ readonly type: string; readonly text: string }>)
    .map((block) => block.text)
    .join('\n');

const throwingAudit = (): McpReadAuditPort => ({
  auditContentRead: () => {
    throw new Error('audit_events insert failed');
  },
  logStructuralRead: () => undefined,
});

const throwingLog = (): McpReadAuditPort => ({
  auditContentRead: () => undefined,
  logStructuralRead: () => {
    throw new Error('logger unavailable');
  },
});

describe('ADR 0050: a read whose record cannot be written is refused, not served', () => {
  it('get_message answers the shared refusal and leaks no member content when the audit row throws', async () => {
    const { client, close } = await connectWithReadAudit(throwingAudit());
    try {
      const result = (await client.callTool({
        name: GET_MESSAGE_TOOL_NAME,
        arguments: { guildId: String(GUILD_A), messageId: MESSAGE },
      })) as CallToolResult;
      const text = toolTextOf(result);
      // The read had already fetched the message before the record failed;
      // what matters is that none of it reached the connector.
      expect(text).not.toContain(SECRET_MESSAGE_TEXT);
      expect(text).toBe(GUILD_REFUSAL_MESSAGE);
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('a structural read is refused too when its log line throws', async () => {
    const { client, close } = await connectWithReadAudit(throwingLog());
    try {
      const channels = (await client.callTool({
        name: LIST_CHANNELS_TOOL_NAME,
        arguments: { guildId: String(GUILD_A) },
      })) as CallToolResult;
      expect(toolTextOf(channels)).toBe(GUILD_REFUSAL_MESSAGE);
      expect(channels.isError).toBe(true);
      const health = (await client.callTool({
        name: GET_HEALTH_TOOL_NAME,
        arguments: {},
      })) as CallToolResult;
      expect(toolTextOf(health)).toBe(GUILD_REFUSAL_MESSAGE);
      expect(health.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('the overview resource door refuses rather than answering unlogged', async () => {
    const { client, close } = await connectWithReadAudit(throwingLog());
    try {
      await expect(
        client.readResource({ uri: `bananasaurs://guild/${String(GUILD_A)}/overview` }),
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });
});

/**
 * ADR 0050, the resource door's wiring. The outcome-shape test above proves
 * `readOverviewResource` *carries* a structural record; this proves the
 * registered resource handler actually performs it, which is otherwise the
 * one read path whose recording nothing observes.
 */
describe('ADR 0050: the overview resource handler performs its record', () => {
  it('a successful resource read emits exactly one structural log line for its guild', async () => {
    const seen: { action: string; guildId: GuildId }[] = [];
    const { client, close } = await connectWithReadAudit({
      auditContentRead: () => {
        throw new Error('the overview card is structural — it must never audit');
      },
      logStructuralRead: (input) => {
        seen.push({ action: input.action, guildId: input.guildId });
      },
    });
    try {
      const result = await client.readResource({
        uri: `bananasaurs://guild/${String(GUILD_A)}/overview`,
      });
      expect(result.contents).toHaveLength(1);
      expect(seen).toEqual([{ action: MCP_READ_GET_SERVER_OVERVIEW, guildId: GUILD_A }]);
    } finally {
      await close();
    }
  });

  it('the template the handler is registered under is the one the record follows', () => {
    expect(OVERVIEW_RESOURCE_URI_TEMPLATE).toBe('bananasaurs://guild/{guildId}/overview');
  });
});

/** Compile-time proof that a content record cannot carry a query string. */
const recordCannotHoldContent: McpContentReadRecord = {
  kind: 'content',
  action: MCP_READ_SEARCH_MESSAGES,
  guildId: GUILD_A,
  subjectType: 'guild',
  subjectId: undefined,
  resultCount: 0,
};
void recordCannotHoldContent;
