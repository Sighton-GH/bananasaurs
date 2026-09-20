import { describe, expect, it } from 'vitest';
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
  MCP_READ_LIST_ROLES,
  MCP_READ_LIST_MOD_CASES,
  MCP_READ_READ_CHANNEL_HISTORY,
  MCP_READ_SEARCH_MESSAGES,
  type McpContentReadRecord,
} from './read-audit.js';
import {
  getMessageText,
  readChannelHistoryText,
  searchMessagesText,
  type McpArchivePort,
} from './tools/archive.js';
import { getHealthText, type McpHealthPort } from './tools/health.js';
import {
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
import { readOverviewResource } from './resources/overview.js';

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
      authorId: undefined,
      content: null,
      createdAt: 1,
      contentPurgedAt: undefined,
    },
  ],
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
    const outcome = searchMessagesText(principalWith(GUILD_A), archivePort(), {
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
    const outcome = readChannelHistoryText(principalWith(GUILD_A), archivePort(), {
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

  it('get_message records the message id, found or not — the read happened either way', () => {
    const found = getMessageText(principalWith(GUILD_A), archivePort(), {
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
    void (async () => {
      const members = await listMembersText(principalWith(GUILD_A), guildPort(), {
        guildId: String(GUILD_A),
      });
      expect(members.ok).toBe(true);
      if (!members.ok) throw new Error('expected ok');
      expect(members.read).toMatchObject({
        kind: 'structural',
        action: MCP_READ_LIST_MEMBERS,
        resultCount: 1,
      });
    })();
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
    const refused = searchMessagesText(principalWith(GUILD_B), archivePort(), {
      guildId: String(GUILD_A),
      query: 'x',
    });
    expect(refused).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
    const invalidArgs = searchMessagesText(principalWith(GUILD_A), archivePort(), { guildId: 7 });
    expect(invalidArgs.ok).toBe(false);
    if (invalidArgs.ok) throw new Error('expected refusal');
    expect('read' in invalidArgs && invalidArgs.read !== undefined).toBe(false);
    const healthRefused = getHealthText(principalWith(), healthPort());
    expect(healthRefused).toEqual({ ok: false, message: GUILD_REFUSAL_MESSAGE });
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
