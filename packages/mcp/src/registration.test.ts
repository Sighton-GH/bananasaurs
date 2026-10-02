import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseGuildId } from '@bananasaurs/core';
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
import type { McpRoleWritesPort } from './tools/role-writes.js';
import type { McpActionsPort } from './tools/actions.js';
import type { McpJobsPort } from './tools/jobs.js';
import type { McpMembersPort } from './tools/members.js';
import type { McpContextPort } from './tools/context.js';
import type { McpResourcesPort } from './tools/resources.js';
import type { McpThreadsPort } from './tools/threads.js';
import type { McpTaskDetailPort, McpTaskPort } from './tools/tasks.js';
import { taskAdminTools, type TaskAdminPort } from './tools/task-admin.js';

/**
 * Slice 3, Task 7: the registration pin. Tool names must be unique across
 * all registrars, including main's task tools (Global Constraints), and
 * every scope subset must advertise exactly its own set — a token without a
 * scope cannot see that scope's tools in `tools/list` at all (ruling
 * M4-D17, ADR 0114). The task-tracking write tools register under
 * `bananasaurs:tasks`, never send; the read-only task tools stay under
 * read; `undo_action` registers under send and `list_actions` under read.
 */

const GUILD = parseGuildId('111111111111111111');

const noopReadAudit: McpReadAuditPort = {
  auditContentRead: () => undefined,
  logStructuralRead: () => undefined,
};

/** Every port stubbed: scope alone decides the advertised set, never a missing port. */
const fullDeps = (principal: McpPrincipal): McpServerDeps => {
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
  const roleWrites: McpRoleWritesPort = {
    grant: () => Promise.resolve({ status: 'done', actionId: 'act', alreadyHad: false }),
    remove: () => Promise.resolve({ status: 'done', actionId: 'act', alreadyHad: false }),
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
    roleWrites,
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

/** The read-scope set: the twenty-two long-standing read tools, the four read-only task tools, and `list_actions`. */
const READ_TOOLS: readonly string[] = [
  'get_health',
  'search_messages',
  'read_channel_history',
  'get_message',
  'read_thread',
  'read_digest',
  'list_unanswered',
  'list_channels',
  'list_threads',
  'list_roles',
  'list_members',
  'list_mod_cases',
  'get_mod_case',
  'list_audit_events',
  'get_server_overview',
  'list_jobs',
  'get_job',
  'get_member',
  'search_members',
  'get_server_context',
  'search_resources',
  'open_resource',
  'list_actions',
  'list_tasks',
  'get_task_details',
  'list_task_teams',
  'list_task_reminders',
];

/** The send-scope set: `send_message`, the twelve thread/message write tools, and `undo_action`. */
const SEND_TOOLS: readonly string[] = [
  'send_message',
  'create_thread',
  'add_thread_members',
  'remove_thread_members',
  'create_forum_post',
  'archive_thread',
  'lock_thread',
  'edit_message',
  'delete_message',
  'pin_message',
  'unpin_message',
  'add_reaction',
  'remove_reaction',
  'undo_action',
];

/** The roles-scope set: the two role-change tools (slice 4, Task 3). */
const ROLES_TOOLS: readonly string[] = ['grant_role', 'remove_role'];

/** The tasks-scope set: main's task-tracking write tools, sorted. */
const TASK_TOOLS: readonly string[] = [
  'add_task_reminder',
  'add_task_team_member',
  'append_task_child',
  'approve_task_completion',
  'archive_task',
  'cancel_task_reminder',
  'clear_task_president_role',
  'complete_task_child',
  'configure_task_quiet_hours',
  'configure_task_team',
  'create_club_task',
  'create_task_team',
  'delete_club_task',
  'delete_task_child',
  'delete_task_report',
  'delete_task_team',
  'edit_club_task',
  'edit_task_child',
  'record_task_progress',
  'reject_task_completion',
  'remove_task_team_member',
  'request_task_completion',
  'set_task_president_role',
  'set_task_status',
  'unarchive_task',
];

const SCOPES = ['read', 'send', 'roles', 'tasks'] as const;
type ScopeShort = (typeof SCOPES)[number];

const scopeValue = (short: ScopeShort): string => `bananasaurs:${short}`;

const expectedFor = (subset: readonly ScopeShort[]): readonly string[] => {
  const names = [
    ...(subset.includes('read') ? READ_TOOLS : []),
    ...(subset.includes('send') ? SEND_TOOLS : []),
    ...(subset.includes('roles') ? ROLES_TOOLS : []),
    ...(subset.includes('tasks') ? TASK_TOOLS : []),
  ];
  return [...names].sort();
};

const subsets = (): ScopeShort[][] => {
  const out: ScopeShort[][] = [];
  for (let mask = 0; mask < 16; mask += 1) {
    out.push(SCOPES.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return out;
};

const toolNamesFor = async (subset: readonly ScopeShort[]): Promise<readonly string[]> => {
  const principal: McpPrincipal = {
    accountId: 'acct_test',
    reachableGuilds: [GUILD],
    scopes: subset.map(scopeValue),
  };
  const client = new Client({ name: 'registration-test-client', version: '0.0.0' });
  const server = createMcpServer(fullDeps(principal));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    // No tool registered (neither tools nor the overview resource): the SDK
    // never installs its `tools/list` handler and answers Method-not-found
    // rather than an empty array.
    const list = await client.listTools().catch((err: unknown) => err);
    if (typeof list !== 'object' || list === null || !('tools' in list)) return [];
    return (list as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
};

describe('registration pins every scope subset', () => {
  it('the three scope sets have the expected sizes', () => {
    expect(READ_TOOLS).toHaveLength(27);
    expect(SEND_TOOLS).toHaveLength(14);
    expect(ROLES_TOOLS).toHaveLength(2);
    expect(TASK_TOOLS).toHaveLength(25);
    // The hardcoded task list is the whole registrar: no drift between this
    // file and the tools main registers.
    expect(Object.keys(taskAdminTools).sort()).toEqual([...TASK_TOOLS]);
  });

  it('every name is unique across registrars', () => {
    const all = [...READ_TOOLS, ...SEND_TOOLS, ...ROLES_TOOLS, ...TASK_TOOLS];
    expect(new Set(all).size).toBe(all.length);
  });

  for (const subset of subsets()) {
    const label = subset.length === 0 ? '(no scopes)' : subset.join('+');
    it(`scopes ${label} advertise exactly their set`, async () => {
      expect(await toolNamesFor(subset)).toEqual(expectedFor(subset));
    });
  }

  it('task write tools appear only with the tasks scope', async () => {
    for (const subset of subsets()) {
      const names = await toolNamesFor(subset);
      if (subset.includes('tasks')) {
        for (const name of TASK_TOOLS) expect(names).toContain(name);
      } else {
        for (const name of TASK_TOOLS) expect(names).not.toContain(name);
      }
    }
  });

  it('send-only never sees task writes, and tasks-only never sees sends or reads', async () => {
    const sendOnly = await toolNamesFor(['send']);
    expect(sendOnly).toContain('send_message');
    expect(sendOnly).toContain('undo_action');
    expect(sendOnly).not.toContain('list_actions');
    const tasksOnly = await toolNamesFor(['tasks']);
    expect(tasksOnly).not.toContain('send_message');
    expect(tasksOnly).not.toContain('undo_action');
    expect(tasksOnly).not.toContain('list_tasks');
  });
});
