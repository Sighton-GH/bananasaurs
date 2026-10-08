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
import { taskAdminTools, type TaskAdminPort } from './tools/task-admin.js';
import {
  TASK_PROGRESS_ACTIONS,
  TASK_REMINDERS_ACTIONS,
  TASK_SETTINGS_ACTIONS,
  TASK_STEPS_ACTIONS,
  TASK_TEAMS_ACTIONS,
  UPDATE_TASK_ACTIONS,
} from './tools/task-tools.js';

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

/** The read-scope set: the twenty-two long-standing read tools, the two panel reads, the two read-only task tools, and `list_actions`. */
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
  'list_panels',
  'get_panel',
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
  'get_task',
  'task_teams',
];

/** The send-scope set: `send_message`, the eight thread/message write tools (ADR 0132 Task 2), the four event tools, the three schedule tools, and `undo_action`. */
const SEND_TOOLS: readonly string[] = [
  'send_message',
  'create_thread',
  'thread_members',
  'create_forum_post',
  'set_thread_state',
  'edit_message',
  'delete_message',
  'set_pin',
  'react',
  'create_event',
  'edit_event',
  'cancel_event',
  'create_poll',
  'schedule_message',
  'update_scheduled',
  'list_scheduled',
  'undo_action',
];

/** The roles-scope set: role changes (slice 4, Task 3), bulk changes (Task 4), role creation and editing (Task 5), and role panels (Task 6b), sorted. */
const ROLES_TOOLS: readonly string[] = [
  'bulk_role_change',
  'create_panel',
  'create_role',
  'delete_panel',
  'edit_panel',
  'edit_role',
  'grant_role',
  'remove_role',
];

/** The tasks-scope set: the action-based task write tools (ADR 0132), sorted. */
const TASK_TOOLS: readonly string[] = [
  'create_task',
  'delete_task',
  'task_progress',
  'task_reminders',
  'task_settings',
  'task_steps',
  'update_task',
];

const SCOPES = ['read', 'send', 'roles', 'tasks'] as const;
type ScopeShort = (typeof SCOPES)[number];

const scopeValue = (short: ScopeShort): string => `bananasaurs:${short}`;

const expectedFor = (subset: readonly ScopeShort[]): readonly string[] => {
  const names = [
    ...(subset.includes('read') ? READ_TOOLS : []),
    ...(subset.includes('send') ? SEND_TOOLS : []),
    ...(subset.includes('roles') ? ROLES_TOOLS : []),
    // `undo_action` registers under send or roles, whichever is carried —
    // once. SEND_TOOLS already names it, so only a roles-without-send subset
    // adds it here.
    ...(subset.includes('roles') && !subset.includes('send') ? ['undo_action'] : []),
    ...(subset.includes('tasks') ? TASK_TOOLS : []),
  ];
  return [...new Set(names)].sort();
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
  it('the four scope sets have the expected sizes', () => {
    expect(READ_TOOLS).toHaveLength(28);
    expect(SEND_TOOLS).toHaveLength(17);
    expect(ROLES_TOOLS).toHaveLength(8);
    expect(TASK_TOOLS).toHaveLength(7);
    // The hardcoded task lists are the whole registrar: no drift between
    // this file and the tools the server registers, and every internal
    // task-admin name is routed by exactly one new tool action (ADR 0132).
    expect(
      [
        'create_club_task',
        'delete_club_task',
        ...Object.values(UPDATE_TASK_ACTIONS),
        ...Object.values(TASK_STEPS_ACTIONS),
        ...Object.values(TASK_REMINDERS_ACTIONS),
        ...Object.values(TASK_PROGRESS_ACTIONS),
        ...Object.values(TASK_TEAMS_ACTIONS),
        ...Object.values(TASK_SETTINGS_ACTIONS),
      ].sort(),
    ).toEqual(Object.keys(taskAdminTools).sort());
  });

  it('every name is unique across registrars', () => {
    // `undo_action` is advertised under both send and roles from one shared
    // block, but named once: it lives in SEND_TOOLS only.
    const all = [...READ_TOOLS, ...SEND_TOOLS, ...ROLES_TOOLS, ...TASK_TOOLS];
    expect(new Set(all).size).toBe(all.length);
  });

  for (const subset of subsets()) {
    const label = subset.length === 0 ? '(no scopes)' : subset.join('+');
    it(`scopes ${label} advertise exactly their set`, async () => {
      expect(await toolNamesFor(subset)).toEqual(expectedFor(subset));
    });
  }

  it('role tools appear only with the roles scope, and undo follows send or roles', async () => {
    for (const subset of subsets()) {
      const names = await toolNamesFor(subset);
      if (subset.includes('roles')) {
        for (const name of ROLES_TOOLS) expect(names).toContain(name);
        expect(names).toContain('undo_action');
      } else {
        for (const name of ROLES_TOOLS) expect(names).not.toContain(name);
      }
      if (!subset.includes('send') && !subset.includes('roles')) {
        expect(names).not.toContain('undo_action');
      }
    }
  });

  it('roles-only sees the eight role and panel tools and undo_action, and nothing else writable', async () => {
    const names = await toolNamesFor(['roles']);
    expect(names).toEqual([
      'bulk_role_change',
      'create_panel',
      'create_role',
      'delete_panel',
      'edit_panel',
      'edit_role',
      'grant_role',
      'remove_role',
      'undo_action',
    ]);
  });

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
    expect(tasksOnly).not.toContain('get_task');
    expect(tasksOnly).not.toContain('task_teams');
  });

  it('(ADR 0132) an all-scope owner sees exactly the ten task tools and none of the removed names', async () => {
    const names = await toolNamesFor(['read', 'send', 'roles', 'tasks']);
    const taskNames = [
      'create_task',
      'delete_task',
      'get_task',
      'list_tasks',
      'task_progress',
      'task_reminders',
      'task_settings',
      'task_steps',
      'task_teams',
      'update_task',
    ];
    expect(names.filter((name) => taskNames.includes(name)).sort()).toEqual(taskNames);
    for (const removed of [
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
      'get_task_details',
      'list_task_reminders',
      'list_task_teams',
      'record_task_progress',
      'reject_task_completion',
      'remove_task_team_member',
      'request_task_completion',
      'set_task_president_role',
      'set_task_status',
      'unarchive_task',
    ]) {
      expect(names).not.toContain(removed);
    }
  });

  it('(ADR 0132 Task 2) an all-scope owner sees exactly the full tool set, with the five pair tools', async () => {
    // The snapshot later consolidation tasks update: every advertised tool
    // name, sorted. `undo_action` registers under send or roles from one
    // shared block, so it appears once.
    const expected: readonly string[] = [
      'bulk_role_change',
      'cancel_event',
      'create_event',
      'create_forum_post',
      'create_panel',
      'create_poll',
      'create_role',
      'create_task',
      'create_thread',
      'delete_message',
      'delete_panel',
      'delete_task',
      'edit_event',
      'edit_message',
      'edit_panel',
      'edit_role',
      'get_health',
      'get_job',
      'get_member',
      'get_message',
      'get_mod_case',
      'get_panel',
      'get_server_context',
      'get_server_overview',
      'get_task',
      'grant_role',
      'list_actions',
      'list_audit_events',
      'list_channels',
      'list_jobs',
      'list_members',
      'list_mod_cases',
      'list_panels',
      'list_roles',
      'list_scheduled',
      'list_tasks',
      'list_threads',
      'list_unanswered',
      'open_resource',
      'react',
      'read_channel_history',
      'read_digest',
      'read_thread',
      'remove_role',
      'schedule_message',
      'search_members',
      'search_messages',
      'search_resources',
      'send_message',
      'set_pin',
      'set_thread_state',
      'task_progress',
      'task_reminders',
      'task_settings',
      'task_steps',
      'task_teams',
      'thread_members',
      'undo_action',
      'update_scheduled',
      'update_task',
    ];
    expect(expected).toEqual([...expected].sort());
    expect(await toolNamesFor(['read', 'send', 'roles', 'tasks'])).toEqual(expected);
    for (const removed of [
      'add_reaction',
      'remove_reaction',
      'pin_message',
      'unpin_message',
      'add_thread_members',
      'remove_thread_members',
      'archive_thread',
      'lock_thread',
      'edit_scheduled',
      'cancel_scheduled',
    ]) {
      expect(expected).not.toContain(removed);
    }
  });
});
