import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseGuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  MCP_ROLES_SCOPE,
  MCP_TASKS_SCOPE,
  type McpPrincipal,
} from './scope.js';
import type { McpReadAuditPort } from './read-audit.js';
import { createMcpServer } from './server.js';
import {
  GET_MESSAGE_TOOL_NAME,
  READ_CHANNEL_HISTORY_TOOL_NAME,
  SEARCH_MESSAGES_TOOL_NAME,
  type McpArchivePort,
} from './tools/archive.js';
import { GET_HEALTH_TOOL_NAME, getHealthText, type McpHealthPort } from './tools/health.js';
import {
  GET_MOD_CASE_TOOL_NAME,
  GET_SERVER_OVERVIEW_TOOL_NAME,
  LIST_AUDIT_EVENTS_TOOL_NAME,
  LIST_MOD_CASES_TOOL_NAME,
  type McpRecordsPort,
} from './tools/records.js';
import {
  LIST_CHANNELS_TOOL_NAME,
  LIST_MEMBERS_TOOL_NAME,
  LIST_ROLES_TOOL_NAME,
  LIST_THREADS_TOOL_NAME,
  type McpGuildPort,
} from './tools/guild.js';
import { MCP_READ_LIST_THREADS } from './read-audit.js';
import { MCP_SERVER_INSTRUCTIONS } from './instructions.js';
import { SEND_MESSAGE_TOOL_NAME, type McpSendPort } from './tools/send.js';
import {
  CREATE_FORUM_POST_TOOL_NAME,
  CREATE_THREAD_TOOL_NAME,
  type McpThreadWritesPort,
} from './tools/thread-writes.js';
import {
  DELETE_MESSAGE_TOOL_NAME,
  EDIT_MESSAGE_TOOL_NAME,
  type McpMessageWritesPort,
} from './tools/message-writes.js';
import {
  REACT_TOOL_NAME,
  SET_PIN_TOOL_NAME,
  SET_THREAD_STATE_TOOL_NAME,
  THREAD_MEMBERS_TOOL_NAME,
  UPDATE_SCHEDULED_TOOL_NAME,
} from './tools/pair-tools.js';
import type { McpRoleWritesPort } from './tools/role-writes.js';
import {
  CANCEL_EVENT_TOOL_NAME,
  CREATE_EVENT_TOOL_NAME,
  CREATE_POLL_TOOL_NAME,
  EDIT_EVENT_TOOL_NAME,
  type McpEventWritesPort,
} from './tools/event-writes.js';
import {
  LIST_SCHEDULED_TOOL_NAME,
  SCHEDULE_MESSAGE_TOOL_NAME,
  type McpSchedulePort,
} from './tools/schedule.js';
import {
  LIST_ACTIONS_TOOL_NAME,
  UNDO_ACTION_TOOL_NAME,
  type McpActionsPort,
} from './tools/actions.js';
import type { McpJobsPort } from './tools/jobs.js';
import type { McpMembersPort } from './tools/members.js';
import { GET_SERVER_CONTEXT_TOOL_NAME, type McpContextPort } from './tools/context.js';
import {
  OPEN_RESOURCE_TOOL_NAME,
  SEARCH_RESOURCES_TOOL_NAME,
  type McpResourcesPort,
} from './tools/resources.js';
import { READ_THREAD_TOOL_NAME, type McpThreadsPort } from './tools/threads.js';
import { LIST_UNANSWERED_TOOL_NAME, READ_DIGEST_TOOL_NAME } from './tools/digest.js';
import type { McpRoleAdminPort } from './tools/role-admin.js';
import type { McpPanelsPort } from './tools/panels.js';

/** ADR 0050: the tests in this file do not exercise read logging; the server requires the port. */
const noopReadAudit: McpReadAuditPort = {
  auditContentRead: () => undefined,
  logStructuralRead: () => undefined,
};

/**
 * Task 3, `packages/mcp` side: `get_health` exercised through a real MCP
 * round-trip (client over the in-memory transport), with no Fastify. The
 * daemon-level refusal — a valid token whose reachable set was emptied after
 * minting — is pinned in `apps/daemon/src/mcp/wiring.test.ts`; this file pins
 * the handler contract that makes that refusal possible.
 */

const GUILD = parseGuildId('111111111111111111');

const stubPort = (): McpHealthPort => ({
  startedAtMs: 1_700_000_000_000,
  readonly: false,
  env: 'test',
  gateway: () => ({ connected: true, pingMs: 42, guildCount: 1 }),
  now: () => 1_700_000_000_000 + 3_661_000,
  guilds: () => [
    {
      guildId: GUILD,
      guildName: 'guild a',
      safety: {
        killswitch: false,
        dryRun: false,
        breakerOpen: false,
        breakerReason: null,
        automodState: 'off',
        taskPostsEnabled: false,
      },
      jobCounts: { queued: 1, running: 0, failed: 0 },
      schedulerLagMs: 0,
    },
  ],
});

const principalWith = (
  reachableGuilds: McpPrincipal['reachableGuilds'],
  scopes: McpPrincipal['scopes'] = ['bananasaurs:read'],
): McpPrincipal => ({
  accountId: 'acct_test',
  reachableGuilds,
  scopes,
});

/** Minimal archive port: this file pins `get_health`, never the archive tools. */
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

/** Minimal guild port: this file pins `get_health`, never the guild tools. */
const stubGuild = (): McpGuildPort => ({
  listChannels: () => [],
  listThreads: async () => [],
  listRoles: () => [],
  listMembers: () => Promise.resolve({ members: [], nextCursor: undefined }),
  memberCount: () => 0,
});

/** Minimal records port: this file pins `get_health`, never the records tools. */
const stubRecords = (): McpRecordsPort => ({
  listRecentCases: () => [],
  findCase: () => undefined,
  listCaseEvents: () => [],
  tailAudit: () => [],
  listRules: () => [],
  listPanels: () => [],
});

/** Minimal send port: this file pins registration, never the send itself. */
const stubSend = (): McpSendPort => ({
  send: () => Promise.resolve({ status: 'sent', messageId: 'mid-test', actionId: 'act-test' }),
});

/** Minimal thread-writes port: this file pins registration, never the writes themselves. */
const stubThreadWrites = (): McpThreadWritesPort => ({
  createThread: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', threadId: 'thread-test' }),
  addThreadMembers: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  removeThreadMembers: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  createForumPost: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', threadId: 'thread-test' }),
  setThreadState: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
});

/** Minimal message-writes port: this file pins registration, never the writes themselves. */
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

/** Minimal event-writes port: this file pins registration, never the writes themselves. */
const stubEventWrites = (): McpEventWritesPort => ({
  createEvent: () => Promise.resolve({ status: 'done', actionId: 'act-test', eventId: 'evt-test' }),
  editEvent: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  cancelEvent: () => Promise.resolve({ status: 'done', actionId: 'act-test' }),
  createPoll: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', messageId: 'mid-test' }),
});

/** Minimal schedule port: this file pins registration, never the schedules themselves. */
const stubSchedule = (): McpSchedulePort => ({
  scheduleMessage: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', reminderId: 'rem-test' }),
  listScheduled: () => [],
  editScheduled: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', reminderId: 'rem-test' }),
  cancelScheduled: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', reminderId: 'rem-test' }),
});

/** Minimal role-writes port: this file pins registration, never the writes themselves. */
const stubRoleWrites = (): McpRoleWritesPort => ({
  grant: () => Promise.resolve({ status: 'done', actionId: 'act-test', alreadyHad: false }),
  remove: () => Promise.resolve({ status: 'done', actionId: 'act-test', alreadyHad: false }),
});

/** Minimal actions port: this file pins registration, never undo or list themselves. */
const stubActions = (): McpActionsPort => ({
  undo: () =>
    Promise.resolve({
      status: 'done',
      actionId: 'act-undo',
      undoneActionId: 'act-1',
      kind: 'edit',
    }),
  list: () => [],
});
/** Minimal jobs port: this file pins registration, never the jobs tools. */
const stubJobs = (): McpJobsPort => ({
  listJobs: () => [],
  findJob: () => undefined,
});

/** Minimal members port: this file pins registration, never the member tools. */
const stubMembers = (): McpMembersPort => ({
  listAllMembers: () => Promise.resolve({ members: [], truncated: false }),
  lastMessageAt: () => new Map(),
  now: () => 1_700_000_000_000,
});

/** Minimal context port: this file pins registration, never the context tool. */
const stubContext = (): McpContextPort => ({
  serverCard: () => '',
  timeZone: 'America/Vancouver',
  now: () => 1_700_000_000_000,
  skills: () => [],
});

/** Minimal resources port: this file pins registration, never the resource tools. */
const stubResources = (): McpResourcesPort => ({
  listResources: () => [],
  searchChunks: () => [],
  resourceChunks: () => [],
});

/** Minimal threads port: this file pins registration, never the thread tool. */
const stubThreads = (): McpThreadsPort => ({
  archiveThread: () => [],
  threadInfo: () => Promise.resolve(undefined),
  privateThreadReadable: () => Promise.resolve(false),
  liveThreadMessages: () => Promise.resolve([]),
});

/** One connected client/server pair over the in-memory transport. */
/** Minimal role-admin port: this file pins registration, never the role writes themselves. */
const stubRoleAdmin = (): McpRoleAdminPort => ({
  createRole: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', roleId: '511111111111111111' }),
  editRole: () =>
    Promise.resolve({ status: 'done', actionId: 'act-test', roleId: '511111111111111111' }),
});

/** Minimal panels port: this file pins registration, never the panel reads or writes themselves. */
const stubPanels = (): McpPanelsPort => ({
  list: () => [],
  get: () => undefined,
  create: () => Promise.resolve({ status: 'done', actionId: 'act-test', panelId: 'mcp-1a2b3c4d' }),
  edit: () => Promise.resolve({ status: 'done', actionId: 'act-test', panelId: 'mcp-1a2b3c4d' }),
  remove: () => Promise.resolve({ status: 'done', actionId: 'act-test', panelId: 'mcp-1a2b3c4d' }),
});

const connectPair = async (
  principal: McpPrincipal,
  send: McpSendPort = stubSend(),
  overrides: { readonly guild?: McpGuildPort; readonly readAudit?: McpReadAuditPort } = {},
): Promise<{ client: Client; close: () => Promise<void> }> => {
  const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
  const server = createMcpServer({
    principal,
    health: stubPort(),
    archive: stubArchive(),
    guild: overrides.guild ?? stubGuild(),
    records: stubRecords(),
    readAudit: overrides.readAudit ?? noopReadAudit,
    jobs: stubJobs(),
    members: stubMembers(),
    context: stubContext(),
    resources: stubResources(),
    threads: stubThreads(),
    send,
    threadWrites: stubThreadWrites(),
    messageWrites: stubMessageWrites(),
    eventWrites: stubEventWrites(),
    schedule: stubSchedule(),
    roleWrites: stubRoleWrites(),
    actions: stubActions(),
    roleAdmin: stubRoleAdmin(),
    panels: stubPanels(),
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

const textOf = (result: CallToolResult): string => {
  const blocks = result.content as ReadonlyArray<{ type: string; text: string }> | undefined;
  expect(blocks).toHaveLength(1);
  expect(blocks?.[0]?.type).toBe('text');
  const text = blocks?.[0]?.text;
  expect(typeof text).toBe('string');
  return text as string;
};

describe('getHealthText', () => {
  it('refuses a principal with an empty reachable set, with the shared refusal', () => {
    expect(getHealthText(principalWith([]), stubPort())).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
  });

  it('reports process facts for a principal that reaches a guild', () => {
    const outcome = getHealthText(principalWith([GUILD]), stubPort());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain('connected');
    expect(outcome.text).toContain('guild a');
    expect(outcome.text).toContain('uptime');
  });
});

describe('createMcpServer', () => {
  it('sends MCP_SERVER_INSTRUCTIONS at initialize, exactly', async () => {
    const { client, close } = await connectPair(principalWith([GUILD]));
    try {
      expect(client.getInstructions()).toBe(MCP_SERVER_INSTRUCTIONS);
    } finally {
      await close();
    }
  });

  it('lists send_message and the sixteen send-scope tools first, alongside the twenty-six read tools', async () => {
    const { client, close } = await connectPair(
      principalWith([GUILD], ['bananasaurs:read', 'bananasaurs:send']),
    );
    try {
      const list = await client.listTools();
      expect(list.tools).toHaveLength(43);
      expect(list.tools.map((tool) => tool.name)).toEqual([
        SEND_MESSAGE_TOOL_NAME,
        CREATE_THREAD_TOOL_NAME,
        THREAD_MEMBERS_TOOL_NAME,
        CREATE_FORUM_POST_TOOL_NAME,
        SET_THREAD_STATE_TOOL_NAME,
        EDIT_MESSAGE_TOOL_NAME,
        DELETE_MESSAGE_TOOL_NAME,
        SET_PIN_TOOL_NAME,
        REACT_TOOL_NAME,
        CREATE_EVENT_TOOL_NAME,
        EDIT_EVENT_TOOL_NAME,
        CANCEL_EVENT_TOOL_NAME,
        CREATE_POLL_TOOL_NAME,
        SCHEDULE_MESSAGE_TOOL_NAME,
        UPDATE_SCHEDULED_TOOL_NAME,
        LIST_SCHEDULED_TOOL_NAME,
        UNDO_ACTION_TOOL_NAME,
        GET_HEALTH_TOOL_NAME,
        'bananasaurs_guide',
        SEARCH_MESSAGES_TOOL_NAME,
        READ_CHANNEL_HISTORY_TOOL_NAME,
        GET_MESSAGE_TOOL_NAME,
        READ_THREAD_TOOL_NAME,
        READ_DIGEST_TOOL_NAME,
        LIST_UNANSWERED_TOOL_NAME,
        LIST_CHANNELS_TOOL_NAME,
        'list_threads',
        LIST_ROLES_TOOL_NAME,
        LIST_MEMBERS_TOOL_NAME,
        'list_panels',
        'get_panel',
        LIST_MOD_CASES_TOOL_NAME,
        GET_MOD_CASE_TOOL_NAME,
        LIST_AUDIT_EVENTS_TOOL_NAME,
        GET_SERVER_OVERVIEW_TOOL_NAME,
        'list_jobs',
        'get_job',
        'get_member',
        'search_members',
        GET_SERVER_CONTEXT_TOOL_NAME,
        SEARCH_RESOURCES_TOOL_NAME,
        OPEN_RESOURCE_TOOL_NAME,
        LIST_ACTIONS_TOOL_NAME,
      ]);
      const resources = await client.listResourceTemplates();
      expect(resources.resourceTemplates).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('a read-scoped tools/list includes list_jobs and get_job; a send-only one does not', async () => {
    const read = await connectPair(principalWith([GUILD]));
    try {
      const list = await read.client.listTools();
      expect(list.tools.map((tool) => tool.name)).toContain('list_jobs');
      expect(list.tools.map((tool) => tool.name)).toContain('get_job');
    } finally {
      await read.close();
    }
    const sendOnly = await connectPair(principalWith([GUILD], ['bananasaurs:send']));
    try {
      const list = await sendOnly.client.listTools();
      expect(list.tools.map((tool) => tool.name)).not.toContain('list_jobs');
      expect(list.tools.map((tool) => tool.name)).not.toContain('get_job');
    } finally {
      await sendOnly.close();
    }
  });

  it('a read-scoped tools/list includes get_member and search_members; a send-only one does not', async () => {
    const read = await connectPair(principalWith([GUILD]));
    try {
      const list = await read.client.listTools();
      expect(list.tools.map((tool) => tool.name)).toContain('get_member');
      expect(list.tools.map((tool) => tool.name)).toContain('search_members');
    } finally {
      await read.close();
    }
    const sendOnly = await connectPair(principalWith([GUILD], ['bananasaurs:send']));
    try {
      const list = await sendOnly.client.listTools();
      expect(list.tools.map((tool) => tool.name)).not.toContain('get_member');
      expect(list.tools.map((tool) => tool.name)).not.toContain('search_members');
    } finally {
      await sendOnly.close();
    }
  });

  it('(ruling M4-D17) a send-only principal gets send_message and the sixteen send-scope tools', async () => {
    const { client, close } = await connectPair(principalWith([GUILD], ['bananasaurs:send']));
    try {
      // `send_message`, the four thread-write tools (Task 5, consolidated by
      // ADR 0132 Task 2), the four message-write tools (Task 6, likewise),
      // the four event tools, the three schedule tools (slice 5 Task 3,
      // likewise) and `undo_action` (Task 7) register under the
      // send scope independently of the read-scope block, so a send-only
      // server lists exactly seventeen tools — and still no resource, which
      // stays behind the read scope.
      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name)).toEqual([
        SEND_MESSAGE_TOOL_NAME,
        CREATE_THREAD_TOOL_NAME,
        THREAD_MEMBERS_TOOL_NAME,
        CREATE_FORUM_POST_TOOL_NAME,
        SET_THREAD_STATE_TOOL_NAME,
        EDIT_MESSAGE_TOOL_NAME,
        DELETE_MESSAGE_TOOL_NAME,
        SET_PIN_TOOL_NAME,
        REACT_TOOL_NAME,
        CREATE_EVENT_TOOL_NAME,
        EDIT_EVENT_TOOL_NAME,
        CANCEL_EVENT_TOOL_NAME,
        CREATE_POLL_TOOL_NAME,
        SCHEDULE_MESSAGE_TOOL_NAME,
        UPDATE_SCHEDULED_TOOL_NAME,
        LIST_SCHEDULED_TOOL_NAME,
        UNDO_ACTION_TOOL_NAME,
      ]);
      // The SDK installs its `resources/templates/list` handler lazily on the
      // first `registerResource()` call, so a server with no resource answers
      // Method-not-found rather than an empty array.
      await expect(client.listResourceTemplates()).rejects.toMatchObject({ code: -32601 });
    } finally {
      await close();
    }
  });

  it('(slice M5) a read-only principal never sees send_message', async () => {
    // Required (ruling M5-D11) means the port is always present, not that the
    // tool is always advertised: without the send scope there is no
    // `send_message`, even with the port threaded through.
    const { client, close } = await connectPair(principalWith([GUILD]));
    try {
      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name)).not.toContain(SEND_MESSAGE_TOOL_NAME);
    } finally {
      await close();
    }
  });

  it('(ADR 0114) a roles-only principal sees the role and panel tools and no resources', async () => {
    // Slice 4 registers `grant_role` / `remove_role` (Task 3), `create_role` /
    // `edit_role` (Task 5), `create_panel` / `edit_panel` / `delete_panel`
    // (Task 6b) and `undo_action` (which serves send and roles)
    // under the roles scope — never the read/send tools and never the
    // overview resource.
    const { client, close } = await connectPair(principalWith([GUILD], [MCP_ROLES_SCOPE]));
    try {
      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name).sort()).toEqual([
        'create_panel',
        'create_role',
        'delete_panel',
        'edit_panel',
        'edit_role',
        'grant_role',
        'remove_role',
        'undo_action',
      ]);
      await expect(client.listResourceTemplates()).rejects.toMatchObject({ code: -32601 });
    } finally {
      await close();
    }
  });

  it('(ADR 0114) a tasks-only principal sees no tools and no resources', async () => {
    // The task-tracking write tools register under the tasks scope (ADR
    // 0114), but only when the daemon threads the task-admin port — this
    // file's server has none, so a token carrying only `bananasaurs:tasks`
    // still sees neither tools nor the overview resource. The tasks-scope
    // pin with the port present lives in `registration.test.ts`.
    const { client, close } = await connectPair(principalWith([GUILD], [MCP_TASKS_SCOPE]));
    try {
      await expect(client.listTools()).rejects.toMatchObject({ code: -32601 });
      await expect(client.listResourceTemplates()).rejects.toMatchObject({ code: -32601 });
    } finally {
      await close();
    }
  });

  it('answers get_health for a principal that reaches a guild', async () => {
    const { client, close } = await connectPair(principalWith([GUILD]));
    try {
      const result = (await client.callTool({
        name: GET_HEALTH_TOOL_NAME,
      })) as CallToolResult;
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('guild a');
    } finally {
      await close();
    }
  });

  it('refuses get_health for a principal with an empty reachable set', async () => {
    const { client, close } = await connectPair(principalWith([]));
    try {
      const result = (await client.callTool({
        name: GET_HEALTH_TOOL_NAME,
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(GUILD_REFUSAL_MESSAGE);
    } finally {
      await close();
    }
  });

  it('a successful list_threads call performs its read record exactly once (ADR 0050)', async () => {
    // The handler used to return the text directly, skipping `okReadResult`
    // — the one read path whose record nothing observed. A counting port
    // proves the fix: one call, one structural log line, never an audit row.
    const seen: { action: string; guildId: unknown }[] = [];
    const { client, close } = await connectPair(principalWith([GUILD]), stubSend(), {
      readAudit: {
        auditContentRead: () => {
          throw new Error('list_threads is structural — it must never audit');
        },
        logStructuralRead: (input) => {
          seen.push({ action: input.action, guildId: input.guildId });
        },
      },
    });
    try {
      const result = (await client.callTool({
        name: LIST_THREADS_TOOL_NAME,
        arguments: { guildId: '111111111111111111', channelId: '333333333333333333' },
      })) as CallToolResult;
      expect(result.isError).not.toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.action).toBe(MCP_READ_LIST_THREADS);
      expect(String(seen[0]?.guildId)).toBe('111111111111111111');
    } finally {
      await close();
    }
  });
});
