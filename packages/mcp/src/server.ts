import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  GET_HEALTH_TOOL_DESCRIPTION,
  GET_HEALTH_TOOL_NAME,
  getHealthText,
  type McpHealthPort,
} from './tools/health.js';
import {
  GET_MESSAGE_TOOL_DESCRIPTION,
  GET_MESSAGE_TOOL_NAME,
  getMessageParams,
  getMessageText,
  READ_CHANNEL_HISTORY_TOOL_DESCRIPTION,
  READ_CHANNEL_HISTORY_TOOL_NAME,
  readChannelHistoryParams,
  readChannelHistoryText,
  SEARCH_MESSAGES_TOOL_DESCRIPTION,
  SEARCH_MESSAGES_TOOL_NAME,
  searchMessagesParams,
  searchMessagesText,
  type McpArchivePort,
} from './tools/archive.js';
import {
  LIST_CHANNELS_TOOL_DESCRIPTION,
  LIST_CHANNELS_TOOL_NAME,
  LIST_MEMBERS_TOOL_DESCRIPTION,
  LIST_MEMBERS_TOOL_NAME,
  LIST_THREADS_TOOL_DESCRIPTION,
  LIST_THREADS_TOOL_NAME,
  LIST_ROLES_TOOL_DESCRIPTION,
  LIST_ROLES_TOOL_NAME,
  listChannelsParams,
  listChannelsText,
  listMembersParams,
  listMembersText,
  listThreadsParams,
  listThreadsText,
  listRolesParams,
  listRolesText,
  type McpGuildPort,
} from './tools/guild.js';
import {
  GET_MOD_CASE_TOOL_DESCRIPTION,
  GET_MOD_CASE_TOOL_NAME,
  GET_SERVER_OVERVIEW_TOOL_DESCRIPTION,
  GET_SERVER_OVERVIEW_TOOL_NAME,
  getModCaseParams,
  getModCaseText,
  getServerOverviewParams,
  getServerOverviewText,
  LIST_AUDIT_EVENTS_TOOL_DESCRIPTION,
  LIST_AUDIT_EVENTS_TOOL_NAME,
  LIST_MOD_CASES_TOOL_DESCRIPTION,
  LIST_MOD_CASES_TOOL_NAME,
  listAuditEventsParams,
  listAuditEventsText,
  listModCasesParams,
  listModCasesText,
  type McpRecordsPort,
} from './tools/records.js';
import {
  OVERVIEW_RESOURCE_DESCRIPTION,
  OVERVIEW_RESOURCE_NAME,
  OVERVIEW_RESOURCE_URI_TEMPLATE,
  readOverviewResource,
} from './resources/overview.js';
import {
  SEND_MESSAGE_TOOL_DESCRIPTION,
  SEND_MESSAGE_TOOL_NAME,
  sendMessageParams,
  sendMessageText,
  type McpSendPort,
} from './tools/send.js';
import {
  ADD_THREAD_MEMBERS_TOOL_DESCRIPTION,
  ADD_THREAD_MEMBERS_TOOL_NAME,
  ARCHIVE_THREAD_TOOL_DESCRIPTION,
  ARCHIVE_THREAD_TOOL_NAME,
  CREATE_FORUM_POST_TOOL_DESCRIPTION,
  CREATE_FORUM_POST_TOOL_NAME,
  CREATE_THREAD_TOOL_DESCRIPTION,
  CREATE_THREAD_TOOL_NAME,
  LOCK_THREAD_TOOL_DESCRIPTION,
  LOCK_THREAD_TOOL_NAME,
  REMOVE_THREAD_MEMBERS_TOOL_DESCRIPTION,
  REMOVE_THREAD_MEMBERS_TOOL_NAME,
  addThreadMembersParams,
  addThreadMembersText,
  archiveThreadParams,
  archiveThreadText,
  createForumPostParams,
  createForumPostText,
  createThreadParams,
  createThreadText,
  lockThreadParams,
  lockThreadText,
  removeThreadMembersParams,
  removeThreadMembersText,
  type McpThreadWritesPort,
} from './tools/thread-writes.js';
import {
  ADD_REACTION_TOOL_DESCRIPTION,
  ADD_REACTION_TOOL_NAME,
  DELETE_MESSAGE_TOOL_DESCRIPTION,
  DELETE_MESSAGE_TOOL_NAME,
  EDIT_MESSAGE_TOOL_DESCRIPTION,
  EDIT_MESSAGE_TOOL_NAME,
  PIN_MESSAGE_TOOL_DESCRIPTION,
  PIN_MESSAGE_TOOL_NAME,
  REMOVE_REACTION_TOOL_DESCRIPTION,
  REMOVE_REACTION_TOOL_NAME,
  UNPIN_MESSAGE_TOOL_DESCRIPTION,
  UNPIN_MESSAGE_TOOL_NAME,
  addReactionParams,
  addReactionText,
  deleteMessageParams,
  deleteMessageText,
  editMessageParams,
  editMessageText,
  pinMessageParams,
  pinMessageText,
  removeReactionParams,
  removeReactionText,
  unpinMessageParams,
  unpinMessageText,
  type McpMessageWritesPort,
} from './tools/message-writes.js';
import { registerJobTools, type McpJobsPort } from './tools/jobs.js';
import { registerMemberTools, type McpMembersPort } from './tools/members.js';
import { registerContextTools, type McpContextPort } from './tools/context.js';
import { registerResourceTools, type McpResourcesPort } from './tools/resources.js';
import { registerThreadTools, type McpThreadsPort } from './tools/threads.js';
import { registerDigestTools } from './tools/digest.js';
import { MCP_SERVER_INSTRUCTIONS } from './instructions.js';
import {
  GET_TASK_DETAILS_TOOL_DESCRIPTION,
  GET_TASK_DETAILS_TOOL_NAME,
  getTaskDetailsParams,
  getTaskDetailsText,
  LIST_TASK_REMINDERS_TOOL_DESCRIPTION,
  LIST_TASK_REMINDERS_TOOL_NAME,
  LIST_TASK_TEAMS_TOOL_DESCRIPTION,
  LIST_TASK_TEAMS_TOOL_NAME,
  LIST_TASKS_TOOL_NAME,
  LIST_TASKS_TOOL_DESCRIPTION,
  listTaskRemindersParams,
  listTaskRemindersText,
  listTaskTeamsParams,
  listTaskTeamsText,
  listTasksParams,
  listTasksText,
  type McpTaskPort,
  type McpTaskDetailPort,
} from './tools/tasks.js';
import { taskAdminTools, runTaskAdmin, type TaskAdminPort } from './tools/task-admin.js';
import { performReadRecord, type McpReadAuditPort, type McpReadRecord } from './read-audit.js';
import { GUILD_REFUSAL_MESSAGE, hasReadScope, hasSendScope, type McpPrincipal } from './scope.js';

/**
 * The MCP server Task 3 mounts at `/mcp`.
 *
 * The factory takes an already-authenticated principal — authentication
 * (`requireBearer`) is the composition root's job (ruling M4-D7), and the
 * eslint boundary forbids this package from importing `@bananasaurs/http` to
 * do it itself. The daemon therefore builds one server per request, closing
 * over that request's principal and health snapshot. A server built this way
 * holds no cross-request state, which is what makes per-request construction
 * safe and what the stateless transport choice in
 * `apps/daemon/src/mcp/wiring.ts` relies on.
 */

export const MCP_SERVER_NAME = 'bananasaurs';
export const MCP_SERVER_VERSION = '0.0.0';

export interface McpServerDeps {
  /** The caller `requireBearer` already authenticated for this request. */
  readonly principal: McpPrincipal;
  /** The daemon's per-request projection of `OpsInstance`/`OpsPorts`. */
  readonly health: McpHealthPort;
  /**
   * The daemon's per-request archive port (Task 4b). Required so a caller
   * that forgets it fails at construction time rather than silently serving
   * fewer tools: the archive tools are always registered, and there is no
   * other way to obtain them. The daemon always provides it (see
   * `archivePortFor` in `apps/daemon/src/mcp/wiring.ts`).
   */
  readonly archive: McpArchivePort;
  /**
   * The daemon's per-request guild port (Task 5). Required for the same
   * reason `archive` is: the three Discord-cache tools are always
   * registered, and a missing port must fail at construction, not serve
   * refusals dressed as a working toolset.
   */
  readonly guild: McpGuildPort;
  /**
   * The daemon's per-request records port (Task 6): cases, audit, panels and
   * rules. Required for the same reason `archive` is: the four records tools
   * and the overview resource are always registered, and a missing port must
   * fail at construction, not serve refusals dressed as a working toolset.
   */
  readonly records: McpRecordsPort;
  /**
   * The daemon's per-request send port (slice M5, Task 4). Required like the
   * four ports above: the daemon always provides it (see `sendPortFor` in
   * `apps/daemon/src/mcp/wiring.ts`), and a missing port must fail at
   * construction, not serve a `send_message` that always refuses (ruling
   * M5-D11 — the M4-D12 defect with a new name). Required means the port is
   * always present, not that the tool is always advertised: `send_message`
   * still registers only when the principal carries the send scope.
   */
  readonly send: McpSendPort;
  /**
   * The daemon's per-request thread-writes port (slice 3, Task 5): thread
   * creation, membership, forum posts and thread state behind the six write
   * tools. Required like `send`: a missing port must fail at construction,
   * not serve thread tools that always refuse. The tools still register only
   * when the principal carries the send scope.
   */
  readonly threadWrites: McpThreadWritesPort;
  /**
   * The daemon's per-request message-write port (slice 3, Task 6): editing
   * and deleting the bot's own messages, pinning, and the bot's own
   * reactions. Required like `send`: the daemon always provides it, and a
   * missing port must fail at construction, not serve tools that always
   * refuse. Required means the port is always present, not that the tools
   * are always advertised: the six tools still register only when the
   * principal carries the send scope.
   */
  readonly messageWrites: McpMessageWritesPort;
  readonly tasks?: McpTaskPort | undefined;
  readonly taskDetail?: McpTaskDetailPort | undefined;
  readonly taskAdmin?: TaskAdminPort | undefined;
  /**
   * The daemon's per-request read-logging port (ADR 0050). Required like
   * the five ports above: a server without it would serve unaudited reads,
   * which is the gap ADR 0050 exists to close — so a missing port fails at
   * construction, not silently at the first call.
   */
  readonly readAudit: McpReadAuditPort;
  /**
   * The daemon's per-request jobs port (the owner's "14 failed jobs" answer).
   * Required like the ports above: a missing port must fail at construction,
   * not serve refusals dressed as a working toolset.
   */
  readonly jobs: McpJobsPort;
  /**
   * The daemon's per-request members port (`get_member` / `search_members`):
   * role names and last-active times in one call. Required like the ports
   * above: a missing port must fail at construction, not serve refusals
   * dressed as a working toolset.
   */
  readonly members: McpMembersPort;
  /**
   * The daemon's per-request context port (slice 2, Task 1): the
   * owner-written server card, the club time zone, the clock and the
   * guild's enabled skills behind `get_server_context`. Required like the
   * ports above: a missing port must fail at construction, not serve a
   * context tool that always refuses.
   */
  readonly context: McpContextPort;
  /**
   * The daemon's per-request threads port (slice 2, Task 4): the archive
   * read of a public thread and the live read of a private thread the owner
   * shares, behind `read_thread`. Required like the ports above: a missing
   * port must fail at construction, not serve a thread tool that always
   * refuses. Private-thread content is never written to storage — the port
   * has no write member.
   */
  readonly threads: McpThreadsPort;
  /**
   * The daemon's per-request resources port (slice 2, Task 2): the enabled
   * club resources and their cached chunks behind `search_resources` and
   * `open_resource`. Required like the ports above: a missing port must fail
   * at construction, not serve resource tools that always refuse. Cache
   * only — the port has no refresh member, so MCP can never trigger a fetch.
   */
  readonly resources: McpResourcesPort;
}

/** The ok-outcome shape every read tool returns (ADR 0050). */
type ReadToolOk = { readonly ok: true; readonly text: string; readonly read: McpReadRecord };

/**
 * Every successful read passes its record through the port BEFORE the text
 * is returned, inside the caller's try/catch: a read whose audit row or log
 * line cannot be written ends as the shared refusal, never as an
 * unrecorded answer (ADR 0050 — fail closed).
 */
const okReadResult = (
  readAudit: McpReadAuditPort,
  outcome: ReadToolOk,
): { content: { type: 'text'; text: string }[] } => {
  performReadRecord(readAudit, outcome.read);
  return { content: [{ type: 'text' as const, text: outcome.text }] };
};

export const createMcpServer = (deps: McpServerDeps): McpServer => {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );
  // Ruling M4-D17: the scope check happens at registration, not at call
  // time. A token without `bananasaurs:read` gets a server without any of the
  // read tools or the resource — it cannot see them in `tools/list`
  // at all — and a token without `bananasaurs:send` likewise never sees
  // `send_message`. M5 adds the second half: `send_message` registers only
  // under the send scope, independently of the read-scope block, so a token
  // with both scopes gets the read tools plus `send_message`.
  if (hasSendScope(deps.principal)) {
    const send = deps.send;
    server.tool(
      SEND_MESSAGE_TOOL_NAME,
      SEND_MESSAGE_TOOL_DESCRIPTION,
      sendMessageParams,
      async (args) => {
        try {
          const outcome = await sendMessageText(deps.principal, send, args);
          if (!outcome.ok) {
            return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
          }
          return { content: [{ type: 'text' as const, text: outcome.text }] };
        } catch {
          return {
            content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
            isError: true,
          };
        }
      },
    );
    // The six thread/forum write tools (slice 3, Task 5): same scope, same
    // handler shape — the text function answers every outcome and the
    // try/catch only fires on something it did not foresee.
    const threadWrites = deps.threadWrites;
    const writeTools = [
      [
        CREATE_THREAD_TOOL_NAME,
        CREATE_THREAD_TOOL_DESCRIPTION,
        createThreadParams,
        createThreadText,
      ],
      [
        ADD_THREAD_MEMBERS_TOOL_NAME,
        ADD_THREAD_MEMBERS_TOOL_DESCRIPTION,
        addThreadMembersParams,
        addThreadMembersText,
      ],
      [
        REMOVE_THREAD_MEMBERS_TOOL_NAME,
        REMOVE_THREAD_MEMBERS_TOOL_DESCRIPTION,
        removeThreadMembersParams,
        removeThreadMembersText,
      ],
      [
        CREATE_FORUM_POST_TOOL_NAME,
        CREATE_FORUM_POST_TOOL_DESCRIPTION,
        createForumPostParams,
        createForumPostText,
      ],
      [
        ARCHIVE_THREAD_TOOL_NAME,
        ARCHIVE_THREAD_TOOL_DESCRIPTION,
        archiveThreadParams,
        archiveThreadText,
      ],
      [LOCK_THREAD_TOOL_NAME, LOCK_THREAD_TOOL_DESCRIPTION, lockThreadParams, lockThreadText],
    ] as const;
    for (const [name, description, params, text] of writeTools) {
      server.tool(name, description, params, async (args: unknown) => {
        try {
          const outcome = await text(deps.principal, threadWrites, args);
          if (!outcome.ok) {
            return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
          }
          return { content: [{ type: 'text' as const, text: outcome.text }] };
        } catch {
          return {
            content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
            isError: true,
          };
        }
      });
    }
    // Task 6: the six message-write tools, same handler shape as
    // `send_message` above — each text function already answers every
    // malformed argument and every port fault, so the try/catch here only
    // fires on something the tool layer did not foresee.
    const writes = deps.messageWrites;
    const messageWriteTools = [
      [EDIT_MESSAGE_TOOL_NAME, EDIT_MESSAGE_TOOL_DESCRIPTION, editMessageParams, editMessageText],
      [
        DELETE_MESSAGE_TOOL_NAME,
        DELETE_MESSAGE_TOOL_DESCRIPTION,
        deleteMessageParams,
        deleteMessageText,
      ],
      [PIN_MESSAGE_TOOL_NAME, PIN_MESSAGE_TOOL_DESCRIPTION, pinMessageParams, pinMessageText],
      [
        UNPIN_MESSAGE_TOOL_NAME,
        UNPIN_MESSAGE_TOOL_DESCRIPTION,
        unpinMessageParams,
        unpinMessageText,
      ],
      [ADD_REACTION_TOOL_NAME, ADD_REACTION_TOOL_DESCRIPTION, addReactionParams, addReactionText],
      [
        REMOVE_REACTION_TOOL_NAME,
        REMOVE_REACTION_TOOL_DESCRIPTION,
        removeReactionParams,
        removeReactionText,
      ],
    ] as const;
    for (const [name, description, params, text] of messageWriteTools) {
      server.tool(name, description, params, async (args: unknown) => {
        try {
          const outcome = await text(deps.principal, writes, args);
          if (!outcome.ok) {
            return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
          }
          return { content: [{ type: 'text' as const, text: outcome.text }] };
        } catch {
          return {
            content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
            isError: true,
          };
        }
      });
    }
  }
  if (hasSendScope(deps.principal) && deps.taskAdmin) {
    const taskAdmin = deps.taskAdmin;
    for (const [name, spec] of Object.entries(taskAdminTools)) {
      server.tool(name, spec.description, spec.params, async (args: unknown) => {
        const outcome = await runTaskAdmin(
          deps.principal,
          taskAdmin,
          name as keyof typeof taskAdminTools,
          args,
        );
        return outcome.ok
          ? { content: [{ type: 'text' as const, text: outcome.text }] }
          : { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
      });
    }
  }
  if (!hasReadScope(deps.principal)) return server;
  const readAudit = deps.readAudit;
  // Task tracking remains a staged, owner-scoped surface. The port is absent in
  // isolated legacy clients and no tool is advertised when daemon wiring omits it.
  const taskPort = deps.tasks;
  if (taskPort)
    server.tool(LIST_TASKS_TOOL_NAME, LIST_TASKS_TOOL_DESCRIPTION, listTasksParams, (args) => {
      try {
        const outcome = listTasksText(deps.principal, taskPort, args);
        if (!outcome.ok)
          return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
        return okReadResult(readAudit, {
          ok: true,
          text: outcome.text,
          read: {
            kind: 'content',
            action: 'mcp.read.list_tasks',
            guildId: outcome.guildId,
            subjectType: 'guild',
            subjectId: undefined,
            resultCount: outcome.itemCount,
          },
        });
      } catch {
        return { content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }], isError: true };
      }
    });
  if (deps.taskDetail) {
    const detailPort = deps.taskDetail;
    server.tool(
      GET_TASK_DETAILS_TOOL_NAME,
      GET_TASK_DETAILS_TOOL_DESCRIPTION,
      getTaskDetailsParams,
      (args) => {
        try {
          const outcome = getTaskDetailsText(deps.principal, detailPort, args);
          if (!outcome.ok)
            return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
          return okReadResult(readAudit, {
            ok: true,
            text: outcome.text,
            read: {
              kind: 'content',
              action: 'mcp.read.get_task_details',
              guildId: outcome.guildId,
              subjectType: 'club_task',
              subjectId: outcome.taskId,
              resultCount: 1,
            },
          });
        } catch {
          return {
            content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
            isError: true,
          };
        }
      },
    );
  }
  if (taskPort)
    server.tool(
      LIST_TASK_TEAMS_TOOL_NAME,
      LIST_TASK_TEAMS_TOOL_DESCRIPTION,
      listTaskTeamsParams,
      (args) => {
        try {
          const outcome = listTaskTeamsText(deps.principal, taskPort, args);
          if (!outcome.ok)
            return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
          return okReadResult(readAudit, {
            ok: true,
            text: outcome.text,
            read: {
              kind: 'content',
              action: 'mcp.read.list_task_teams',
              guildId: outcome.guildId,
              subjectType: 'guild',
              subjectId: undefined,
              resultCount: outcome.itemCount,
            },
          });
        } catch {
          return {
            content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
            isError: true,
          };
        }
      },
    );
  if (deps.taskDetail) {
    const detailPort = deps.taskDetail;
    server.tool(
      LIST_TASK_REMINDERS_TOOL_NAME,
      LIST_TASK_REMINDERS_TOOL_DESCRIPTION,
      listTaskRemindersParams,
      (args) => {
        try {
          const outcome = listTaskRemindersText(deps.principal, detailPort, args);
          if (!outcome.ok)
            return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
          return okReadResult(readAudit, {
            ok: true,
            text: outcome.text,
            read: {
              kind: 'content',
              action: 'mcp.read.list_task_reminders',
              guildId: outcome.guildId,
              subjectType: 'club_task',
              subjectId: outcome.taskId,
              resultCount: outcome.itemCount,
            },
          });
        } catch {
          return {
            content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
            isError: true,
          };
        }
      },
    );
  }
  server.tool(GET_HEALTH_TOOL_NAME, GET_HEALTH_TOOL_DESCRIPTION, () => {
    try {
      const outcome = getHealthText(deps.principal, deps.health);
      if (!outcome.ok) {
        return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
      }
      return okReadResult(readAudit, outcome);
    } catch {
      return {
        content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
        isError: true,
      };
    }
  });
  // The `try/catch` in each handler is belt over braces: the text functions
  // already answer every malformed argument as the shared refusal and never
  // throw, so this only fires on something the tool layer did not foresee —
  // which still answers as a refusal rather than faulting the request.
  const archive = deps.archive;
  server.tool(
    SEARCH_MESSAGES_TOOL_NAME,
    SEARCH_MESSAGES_TOOL_DESCRIPTION,
    searchMessagesParams,
    (args) => {
      try {
        const outcome = searchMessagesText(deps.principal, archive, deps.guild, args);
        if (!outcome.ok) {
          return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
        }
        return okReadResult(readAudit, outcome);
      } catch {
        return {
          content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
          isError: true,
        };
      }
    },
  );
  server.tool(
    READ_CHANNEL_HISTORY_TOOL_NAME,
    READ_CHANNEL_HISTORY_TOOL_DESCRIPTION,
    readChannelHistoryParams,
    (args) => {
      try {
        const outcome = readChannelHistoryText(deps.principal, archive, deps.guild, args);
        if (!outcome.ok) {
          return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
        }
        return okReadResult(readAudit, outcome);
      } catch {
        return {
          content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
          isError: true,
        };
      }
    },
  );
  server.tool(
    GET_MESSAGE_TOOL_NAME,
    GET_MESSAGE_TOOL_DESCRIPTION,
    getMessageParams,
    async (args) => {
      try {
        const outcome = await getMessageText(deps.principal, archive, args);
        if (!outcome.ok) {
          return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
        }
        return okReadResult(readAudit, outcome);
      } catch {
        return { content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }], isError: true };
      }
    },
  );
  const guild = deps.guild;
  registerThreadTools({ server, principal: deps.principal, readAudit }, deps.threads);
  registerDigestTools({ server, principal: deps.principal, readAudit }, deps.archive, deps.guild);
  server.tool(
    LIST_CHANNELS_TOOL_NAME,
    LIST_CHANNELS_TOOL_DESCRIPTION,
    listChannelsParams,
    (args) => {
      try {
        const outcome = listChannelsText(deps.principal, guild, args);
        if (!outcome.ok) {
          return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
        }
        return okReadResult(readAudit, outcome);
      } catch {
        return {
          content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
          isError: true,
        };
      }
    },
  );
  server.tool(
    LIST_THREADS_TOOL_NAME,
    LIST_THREADS_TOOL_DESCRIPTION,
    listThreadsParams,
    async (args) => {
      try {
        const outcome = await listThreadsText(deps.principal, guild, args);
        if (!outcome.ok) {
          return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
        }
        return okReadResult(readAudit, outcome);
      } catch {
        return { content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }], isError: true };
      }
    },
  );
  server.tool(LIST_ROLES_TOOL_NAME, LIST_ROLES_TOOL_DESCRIPTION, listRolesParams, (args) => {
    try {
      const outcome = listRolesText(deps.principal, guild, args);
      if (!outcome.ok) {
        return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
      }
      return okReadResult(readAudit, outcome);
    } catch {
      return { content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }], isError: true };
    }
  });
  server.tool(
    LIST_MEMBERS_TOOL_NAME,
    LIST_MEMBERS_TOOL_DESCRIPTION,
    listMembersParams,
    async (args) => {
      try {
        const outcome = await listMembersText(deps.principal, guild, args);
        if (!outcome.ok) {
          return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
        }
        return okReadResult(readAudit, outcome);
      } catch {
        return {
          content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
          isError: true,
        };
      }
    },
  );
  const records = deps.records;
  server.tool(
    LIST_MOD_CASES_TOOL_NAME,
    LIST_MOD_CASES_TOOL_DESCRIPTION,
    listModCasesParams,
    (args) => {
      try {
        const outcome = listModCasesText(deps.principal, records, args);
        if (!outcome.ok) {
          return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
        }
        return okReadResult(readAudit, outcome);
      } catch {
        return {
          content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
          isError: true,
        };
      }
    },
  );
  server.tool(GET_MOD_CASE_TOOL_NAME, GET_MOD_CASE_TOOL_DESCRIPTION, getModCaseParams, (args) => {
    try {
      const outcome = getModCaseText(deps.principal, records, args);
      if (!outcome.ok) {
        return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
      }
      return okReadResult(readAudit, outcome);
    } catch {
      return { content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }], isError: true };
    }
  });
  server.tool(
    LIST_AUDIT_EVENTS_TOOL_NAME,
    LIST_AUDIT_EVENTS_TOOL_DESCRIPTION,
    listAuditEventsParams,
    (args) => {
      try {
        const outcome = listAuditEventsText(deps.principal, records, args);
        if (!outcome.ok) {
          return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
        }
        return okReadResult(readAudit, outcome);
      } catch {
        return {
          content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
          isError: true,
        };
      }
    },
  );
  server.tool(
    GET_SERVER_OVERVIEW_TOOL_NAME,
    GET_SERVER_OVERVIEW_TOOL_DESCRIPTION,
    getServerOverviewParams,
    (args) => {
      try {
        const outcome = getServerOverviewText(deps.principal, guild, records, args);
        if (!outcome.ok) {
          return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
        }
        return okReadResult(readAudit, outcome);
      } catch {
        return {
          content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
          isError: true,
        };
      }
    },
  );
  registerJobTools({ server, principal: deps.principal, readAudit }, deps.jobs);
  registerMemberTools({ server, principal: deps.principal, readAudit }, deps.members, deps.guild);
  registerContextTools({ server, principal: deps.principal, readAudit }, deps.context);
  registerResourceTools({ server, principal: deps.principal, readAudit }, deps.resources);
  // The overview resource (ruling M4-D13): the same card as
  // `get_server_overview` through a second door. The `{guildId}` template
  // variable is untrusted input exactly like a tool argument — it goes
  // through `requireReachableGuild` inside `readOverviewResource`, the
  // resource's own guard — and a refused outcome is thrown so the client
  // sees the shared message, mirroring the tool's `isError` refusal.
  server.registerResource(
    OVERVIEW_RESOURCE_NAME,
    new ResourceTemplate(OVERVIEW_RESOURCE_URI_TEMPLATE, { list: undefined }),
    { description: OVERVIEW_RESOURCE_DESCRIPTION, mimeType: 'text/plain' },
    (uri, variables) => {
      const outcome = readOverviewResource(deps.principal, guild, records, variables.guildId ?? '');
      if (!outcome.ok) throw new Error(outcome.message);
      // ADR 0050: the resource door logs its read exactly like the tool door.
      performReadRecord(deps.readAudit, outcome.read);
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: outcome.text }] };
    },
  );
  return server;
};
