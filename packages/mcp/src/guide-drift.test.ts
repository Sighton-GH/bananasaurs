import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GUIDE_TOPICS, parseGuildId } from '@bananasaurs/core';
import { createMcpServer, type McpServerDeps } from './server.js';
import type { McpPrincipal } from './scope.js';
import type { McpReadAuditPort } from './read-audit.js';
import type { McpHealthPort } from './tools/health.js';
import type { McpArchivePort } from './tools/archive.js';
import type { McpGuildPort } from './tools/guild.js';
import type { McpRecordsPort } from './tools/records.js';
import type { McpSendPort } from './tools/send.js';
import type { McpThreadWritesPort } from './tools/thread-writes.js';
import type { McpMessageWritesPort } from './tools/message-writes.js';
import type { McpEventWritesPort } from './tools/event-writes.js';
import type { McpSchedulePort } from './tools/schedule.js';
import type { McpRoleWritesPort } from './tools/role-writes.js';
import type { McpBulkRolesPort } from './tools/bulk-roles.js';
import type { McpRoleAdminPort } from './tools/role-admin.js';
import type { McpPanelsPort } from './tools/panels.js';
import type { McpActionsPort } from './tools/actions.js';
import type { McpJobsPort } from './tools/jobs.js';
import type { McpMembersPort } from './tools/members.js';
import type { McpContextPort } from './tools/context.js';
import type { McpResourcesPort } from './tools/resources.js';
import type { McpThreadsPort } from './tools/threads.js';
import type { McpTaskDetailPort, McpTaskPort } from './tools/tasks.js';
import type { TaskAdminPort } from './tools/task-admin.js';

/**
 * ADR 0133: every tool a connected app can see must be named in the guide, so a
 * tool added later without a guide line fails here. The all-scope owner sees the
 * full set. The port stubs match the ones in `registration.test.ts`; that file
 * keeps its helper private, so the same stubs are repeated here.
 */

const GUILD = parseGuildId('111111111111111111');

const OWNER: McpPrincipal = {
  accountId: 'acct_owner',
  reachableGuilds: [GUILD],
  scopes: ['bananasaurs:read', 'bananasaurs:send', 'bananasaurs:roles', 'bananasaurs:tasks'],
};

const noopReadAudit: McpReadAuditPort = {
  auditContentRead: () => undefined,
  logStructuralRead: () => undefined,
};

/** Every port stubbed: scope alone decides the advertised set, never a missing port. */
const allPorts = (principal: McpPrincipal): McpServerDeps => {
  const health: McpHealthPort = {
    startedAtMs: 1_700_000_000_000,
    readonly: false,
    env: 'test',
    gateway: () => ({ connected: true, pingMs: 42, guildCount: 1 }),
    now: () => 1_700_000_000_000,
    guilds: () => [],
  };
  const archive: McpArchivePort = {
    now: () => 1_700_000_000_000,
    listArchiveChannelIds: () => [],
    searchMessages: () => ({ total: 0, hits: [] }),
    findMessage: () => undefined,
    listChannelHistory: () => [],
    listMessagesSince: () => [],
    listUnansweredRoleMentions: () => [],
    messageMeta: () => Promise.resolve(undefined),
    botUserId: () => undefined,
  };
  const guild: McpGuildPort = {
    listChannels: () => [],
    listThreads: () => Promise.resolve([]),
    listRoles: () => [],
    listMembers: () => Promise.resolve({ members: [], nextCursor: undefined }),
    memberCount: () => 0,
  };
  const records: McpRecordsPort = {
    listRecentCases: () => [],
    findCase: () => undefined,
    listCaseEvents: () => [],
    tailAudit: () => [],
    listRules: () => [],
    listPanels: () => [],
  };
  const send: McpSendPort = {
    send: () => Promise.resolve({ status: 'sent', messageId: 'mid', actionId: 'act' }),
  };
  const threadWrites: McpThreadWritesPort = {
    createThread: () => Promise.resolve({ status: 'done', actionId: 'act' }),
    addThreadMembers: () => Promise.resolve({ status: 'done', actionId: 'act' }),
    removeThreadMembers: () => Promise.resolve({ status: 'done', actionId: 'act' }),
    createForumPost: () => Promise.resolve({ status: 'done', actionId: 'act' }),
    setThreadState: () => Promise.resolve({ status: 'done', actionId: 'act' }),
  };
  const messageWrites: McpMessageWritesPort = {
    edit: () => Promise.resolve({ status: 'done', actionId: 'act' }),
    delete: () => Promise.resolve({ status: 'done', actionId: 'act' }),
    pin: () => Promise.resolve({ status: 'done', actionId: 'act' }),
    unpin: () => Promise.resolve({ status: 'done', actionId: 'act' }),
    addReaction: () => Promise.resolve({ status: 'done', actionId: 'act' }),
    removeReaction: () => Promise.resolve({ status: 'done', actionId: 'act' }),
  };
  const eventWrites: McpEventWritesPort = {
    createEvent: () => Promise.resolve({ status: 'done', actionId: 'act', eventId: 'evt' }),
    editEvent: () => Promise.resolve({ status: 'done', actionId: 'act' }),
    cancelEvent: () => Promise.resolve({ status: 'done', actionId: 'act' }),
    createPoll: () => Promise.resolve({ status: 'done', actionId: 'act', messageId: 'mid' }),
  };
  const schedule: McpSchedulePort = {
    scheduleMessage: () => Promise.resolve({ status: 'done', actionId: 'act', reminderId: 'rem' }),
    listScheduled: () => [],
    editScheduled: () => Promise.resolve({ status: 'done', actionId: 'act', reminderId: 'rem' }),
    cancelScheduled: () => Promise.resolve({ status: 'done', actionId: 'act', reminderId: 'rem' }),
  };
  const roleWrites: McpRoleWritesPort = {
    grant: () => Promise.resolve({ status: 'done', actionId: 'act', alreadyHad: false }),
    remove: () => Promise.resolve({ status: 'done', actionId: 'act', alreadyHad: false }),
  };
  const bulkRoles: McpBulkRolesPort = {
    preview: () => Promise.resolve({ status: 'done', token: 'tok', expiresAt: 1 }),
    confirm: () => Promise.resolve({ status: 'done', actionId: 'act', jobId: 1 }),
  };
  const roleAdmin: McpRoleAdminPort = {
    createRole: () => Promise.resolve({ status: 'done', actionId: 'act', roleId: 'role' }),
    editRole: () => Promise.resolve({ status: 'done', actionId: 'act', roleId: 'role' }),
  };
  const panels: McpPanelsPort = {
    list: () => [],
    get: () => undefined,
    create: () => Promise.resolve({ status: 'done', actionId: 'act', panelId: 'mcp-1a2b3c4d' }),
    edit: () => Promise.resolve({ status: 'done', actionId: 'act', panelId: 'mcp-1a2b3c4d' }),
    remove: () => Promise.resolve({ status: 'done', actionId: 'act', panelId: 'mcp-1a2b3c4d' }),
  };
  const actions: McpActionsPort = {
    undo: () =>
      Promise.resolve({ status: 'done', actionId: 'undo', undoneActionId: 'act', kind: 'edit' }),
    list: () => [],
  };
  const tasks: McpTaskPort = {
    list: () => ({ teams: [], tasks: [] }),
    teams: () => ({
      teams: [],
      presidentRoleId: null,
      quietHours: { startMinute: 0, endMinute: 480, timezone: 'America/Vancouver' },
    }),
  };
  const taskDetail: McpTaskDetailPort = {
    detail: () => undefined,
    reminders: () => undefined,
  };
  const taskAdmin: TaskAdminPort = {
    execute: () => Promise.resolve({ ok: true, text: 'ok' }),
  };
  return {
    principal,
    health,
    archive,
    guild,
    records,
    send,
    threadWrites,
    messageWrites,
    eventWrites,
    schedule,
    roleWrites,
    roleAdmin,
    bulkRoles,
    panels,
    actions,
    tasks,
    taskDetail,
    taskAdmin,
    readAudit: noopReadAudit,
    jobs: {
      listJobs: () => [],
      findJob: () => undefined,
    } satisfies McpJobsPort,
    members: {
      listAllMembers: () => Promise.resolve({ members: [], truncated: false }),
      lastMessageAt: () => new Map(),
      now: () => 1_700_000_000_000,
    } satisfies McpMembersPort,
    context: {
      serverCard: () => '',
      timeZone: 'America/Vancouver',
      now: () => 1_700_000_000_000,
      skills: () => [],
    } satisfies McpContextPort,
    resources: {
      listResources: () => [],
      searchChunks: () => [],
      resourceChunks: () => [],
    } satisfies McpResourcesPort,
    threads: {
      archiveThread: () => [],
      threadInfo: () => Promise.resolve(undefined),
      privateThreadReadable: () => Promise.resolve(false),
      liveThreadMessages: () => Promise.resolve([]),
    } satisfies McpThreadsPort,
  };
};

/** The names `tools/list` advertises to this principal, sorted. */
const advertisedToolNames = async (principal: McpPrincipal): Promise<readonly string[]> => {
  const client = new Client({ name: 'guide-drift-test-client', version: '0.0.0' });
  const server = createMcpServer(allPorts(principal));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const list = await client.listTools();
    return list.tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
};

describe('the guide names every MCP tool', () => {
  it('lists the tools an all-scope owner sees, including the core reads and writes', async () => {
    const names = await advertisedToolNames(OWNER);
    expect(names).toContain('get_health');
    expect(names).toContain('send_message');
    expect(names).toContain('create_task');
  });

  it('names every advertised tool, as code, in some guide topic', async () => {
    const names = await advertisedToolNames(OWNER);
    const guideText = GUIDE_TOPICS.map((topic) => topic.body).join('\n');
    const unnamed = names.filter((name) => !guideText.includes(`\`${name}\``));
    expect(unnamed).toEqual([]);
  });
});
