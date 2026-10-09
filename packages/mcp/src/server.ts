import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  GET_HEALTH_TOOL_DESCRIPTION,
  GET_HEALTH_TOOL_NAME,
  getHealthText,
  type McpHealthPort,
} from './tools/health.js';
import { registerGuideTool, type McpAccessPort } from './tools/guide.js';
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
  CREATE_FORUM_POST_TOOL_DESCRIPTION,
  CREATE_FORUM_POST_TOOL_NAME,
  CREATE_THREAD_TOOL_DESCRIPTION,
  CREATE_THREAD_TOOL_NAME,
  createForumPostParams,
  createForumPostText,
  createThreadParams,
  createThreadText,
  type McpThreadWritesPort,
} from './tools/thread-writes.js';
import {
  DELETE_MESSAGE_TOOL_DESCRIPTION,
  DELETE_MESSAGE_TOOL_NAME,
  EDIT_MESSAGE_TOOL_DESCRIPTION,
  EDIT_MESSAGE_TOOL_NAME,
  deleteMessageParams,
  deleteMessageText,
  editMessageParams,
  editMessageText,
  type McpMessageWritesPort,
} from './tools/message-writes.js';
import {
  REACT_TOOL_DESCRIPTION,
  REACT_TOOL_NAME,
  reactParams,
  runReact,
  runSetPin,
  runSetThreadState,
  runThreadMembers,
  runUpdateScheduled,
  SET_PIN_TOOL_DESCRIPTION,
  SET_PIN_TOOL_NAME,
  SET_THREAD_STATE_TOOL_DESCRIPTION,
  SET_THREAD_STATE_TOOL_NAME,
  setPinParams,
  setThreadStateParams,
  THREAD_MEMBERS_TOOL_DESCRIPTION,
  THREAD_MEMBERS_TOOL_NAME,
  threadMembersParams,
  UPDATE_SCHEDULED_TOOL_DESCRIPTION,
  UPDATE_SCHEDULED_TOOL_NAME,
  updateScheduledParams,
} from './tools/pair-tools.js';
import {
  CANCEL_EVENT_TOOL_DESCRIPTION,
  CANCEL_EVENT_TOOL_NAME,
  CREATE_EVENT_TOOL_DESCRIPTION,
  CREATE_EVENT_TOOL_NAME,
  CREATE_POLL_TOOL_DESCRIPTION,
  CREATE_POLL_TOOL_NAME,
  EDIT_EVENT_TOOL_DESCRIPTION,
  EDIT_EVENT_TOOL_NAME,
  cancelEventParams,
  cancelEventText,
  createEventParams,
  createEventText,
  createPollParams,
  createPollText,
  editEventParams,
  editEventText,
  type McpEventWritesPort,
} from './tools/event-writes.js';
import {
  LIST_SCHEDULED_TOOL_DESCRIPTION,
  LIST_SCHEDULED_TOOL_NAME,
  SCHEDULE_MESSAGE_TOOL_DESCRIPTION,
  SCHEDULE_MESSAGE_TOOL_NAME,
  listScheduledParams,
  listScheduledText,
  scheduleMessageParams,
  scheduleMessageText,
  type McpSchedulePort,
} from './tools/schedule.js';
import {
  GRANT_ROLE_TOOL_DESCRIPTION,
  GRANT_ROLE_TOOL_NAME,
  REMOVE_ROLE_TOOL_DESCRIPTION,
  REMOVE_ROLE_TOOL_NAME,
  grantRoleParams,
  grantRoleText,
  removeRoleParams,
  removeRoleText,
  type McpRoleWritesPort,
} from './tools/role-writes.js';
import {
  CREATE_ROLE_TOOL_DESCRIPTION,
  CREATE_ROLE_TOOL_NAME,
  createRoleParams,
  createRoleText,
  EDIT_ROLE_TOOL_DESCRIPTION,
  EDIT_ROLE_TOOL_NAME,
  editRoleParams,
  editRoleText,
  type McpRoleAdminPort,
} from './tools/role-admin.js';
import {
  BULK_ROLE_CHANGE_TOOL_DESCRIPTION,
  BULK_ROLE_CHANGE_TOOL_NAME,
  bulkRoleChangeParams,
  bulkRoleChangeText,
  type McpBulkRolesPort,
} from './tools/bulk-roles.js';
import {
  CREATE_PANEL_TOOL_DESCRIPTION,
  CREATE_PANEL_TOOL_NAME,
  createPanelParams,
  createPanelText,
  DELETE_PANEL_TOOL_DESCRIPTION,
  DELETE_PANEL_TOOL_NAME,
  deletePanelParams,
  deletePanelText,
  EDIT_PANEL_TOOL_DESCRIPTION,
  EDIT_PANEL_TOOL_NAME,
  editPanelParams,
  editPanelText,
  GET_PANEL_TOOL_DESCRIPTION,
  GET_PANEL_TOOL_NAME,
  getPanelParams,
  getPanelText,
  LIST_PANELS_TOOL_DESCRIPTION,
  LIST_PANELS_TOOL_NAME,
  listPanelsParams,
  listPanelsText,
  type McpPanelsPort,
} from './tools/panels.js';
import {
  LIST_ACTIONS_TOOL_DESCRIPTION,
  LIST_ACTIONS_TOOL_NAME,
  UNDO_ACTION_TOOL_DESCRIPTION,
  UNDO_ACTION_TOOL_NAME,
  listActionsParams,
  listActionsText,
  undoActionParams,
  undoActionText,
  type McpActionsPort,
} from './tools/actions.js';
import { registerJobTools, type McpJobsPort } from './tools/jobs.js';
import { registerMemberTools, type McpMembersPort } from './tools/members.js';
import { registerContextTools, type McpContextPort } from './tools/context.js';
import { registerResourceTools, type McpResourcesPort } from './tools/resources.js';
import { registerThreadTools, type McpThreadsPort } from './tools/threads.js';
import { registerDigestTools } from './tools/digest.js';
import { MCP_SERVER_INSTRUCTIONS } from './instructions.js';
import {
  LIST_TASKS_TOOL_NAME,
  LIST_TASKS_TOOL_DESCRIPTION,
  listTasksParams,
  listTasksText,
  type McpTaskPort,
  type McpTaskDetailPort,
} from './tools/tasks.js';
import {
  CREATE_TASK_TOOL_DESCRIPTION,
  CREATE_TASK_TOOL_NAME,
  createTaskParams,
  DELETE_TASK_TOOL_DESCRIPTION,
  DELETE_TASK_TOOL_NAME,
  deleteTaskParams,
  GET_TASK_READ_ACTION,
  GET_TASK_TOOL_DESCRIPTION,
  GET_TASK_TOOL_NAME,
  getTaskParams,
  getTaskText,
  runCreateTask,
  runDeleteTask,
  runTaskProgress,
  runTaskReminders,
  runTaskSettings,
  runTaskSteps,
  runTaskTeams,
  runUpdateTask,
  TASK_PROGRESS_TOOL_DESCRIPTION,
  TASK_PROGRESS_TOOL_NAME,
  TASK_REMINDERS_TOOL_DESCRIPTION,
  TASK_REMINDERS_TOOL_NAME,
  TASK_SETTINGS_TOOL_DESCRIPTION,
  TASK_SETTINGS_TOOL_NAME,
  TASK_STEPS_TOOL_DESCRIPTION,
  TASK_STEPS_TOOL_NAME,
  TASK_TEAMS_TOOL_DESCRIPTION,
  TASK_TEAMS_TOOL_NAME,
  taskProgressParams,
  taskRemindersParams,
  taskSettingsParams,
  taskStepsParams,
  taskTeamsParams,
  UPDATE_TASK_TOOL_DESCRIPTION,
  UPDATE_TASK_TOOL_NAME,
  updateTaskParams,
} from './tools/task-tools.js';
import type { TaskAdminPort } from './tools/task-admin.js';
import { performReadRecord, type McpReadAuditPort, type McpReadRecord } from './read-audit.js';
import {
  GUILD_REFUSAL_MESSAGE,
  hasReadScope,
  hasRolesScope,
  hasSendScope,
  hasTasksScope,
  type McpPrincipal,
} from './scope.js';

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
   * The daemon's per-request access port (ADR 0133, Task 4): one account's
   * username, owner flag and permissions in one guild, read by the live block
   * of `bananasaurs_guide`. Optional: without it that block says the account
   * part is unavailable rather than failing the call. The daemon always
   * provides it (see `accessPortFor` in `apps/daemon/src/mcp/access-port.ts`).
   */
  readonly access?: McpAccessPort | undefined;
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
   * creation, membership, forum posts and thread state behind the four write
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
   * are always advertised: the four tools still register only when the
   * principal carries the send scope.
   */
  readonly messageWrites: McpMessageWritesPort;
  /**
   * The daemon's per-request event-writes port: scheduled-event creation,
   * editing and cancellation plus native polls behind the four event tools.
   * Required like `send`: the daemon always provides it, and a missing port
   * must fail at construction, not serve tools that always refuse. Required
   * means the port is always present, not that the tools are always
   * advertised: the four tools still register only when the principal
   * carries the send scope.
   */
  readonly eventWrites: McpEventWritesPort;
  /**
   * The daemon's per-request schedule port (slice 5, Task 3): fixed-text
   * scheduled sends behind `schedule_message`, `list_scheduled` and
   * `update_scheduled`, stored as `origin='mcp'`
   * reminder rows. Required like `send`: the daemon always provides it, and
   * a missing port must fail at construction, not serve tools that always
   * refuse. Required means the port is always present, not that the tools
   * are always advertised: the three tools still register only when the
   * principal carries the send scope — including `list_scheduled`, which is
   * a read of the connector's own outbox under the send scope, audited like
   * the other reads.
   */
  readonly schedule: McpSchedulePort;
  /**
   * The daemon's per-request role-writes port (slice 4, Task 3): role grants
   * and removals behind the two role tools. Required like `send`: a missing
   * port must fail at construction, not serve role tools that always refuse.
   * Required means the port is always present, not that the tools are always
   * advertised: the two tools still register only when the principal carries
   * the roles scope.
   */
  readonly roleWrites: McpRoleWritesPort;
  /**
   * The daemon's per-request role-admin port (slice 4, Task 5): role creation
   * and role edits behind `create_role` and `edit_role`. Optional like the
   * actions port: a server without it simply does not advertise either tool,
   * and the daemon always provides it. The tools still register only when the
   * principal carries the roles scope.
   */
  readonly roleAdmin?: McpRoleAdminPort | undefined;
  /**
   * The daemon's per-request bulk-roles port (slice 4, Task 4): the
   * preview → confirm handshake behind `bulk_role_change`. Optional like
   * the role-admin port: a server without it simply does not advertise the
   * tool, and the daemon always provides it. Registers only when the
   * principal carries the roles scope.
   */
  readonly bulkRoles?: McpBulkRolesPort | undefined;
  /**
   * The daemon's per-request panels port (slice 4, Task 6b): panel listing
   * and detail behind `list_panels` / `get_panel`, and panel creation,
   * editing and deletion behind `create_panel` / `edit_panel` /
   * `delete_panel`. Optional like the actions port: a server without it
   * simply does not advertise any of the five tools, and the daemon always
   * provides it. The reads still register only when the principal carries
   * the read scope, the writes only under the roles scope.
   */
  readonly panels?: McpPanelsPort | undefined;
  /**
   * The daemon's per-request actions port (slice 3, Task 7): the `mcp_actions`
   * ledger behind `undo_action` and `list_actions`. Optional like the task
   * ports: a server without it (an isolated legacy client in a test, or a
   * composition that omits it) simply does not advertise either tool, and the
   * daemon always provides it. The tools still register only under their own
   * scopes — `undo_action` under send, `list_actions` under read.
   */
  readonly actions?: McpActionsPort | undefined;
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
    // The thread/forum write tools (slice 3, Task 5, consolidated by ADR
    // 0132 Task 2): same scope, same handler shape — the text function
    // answers every outcome and the try/catch only fires on something it
    // did not foresee.
    const threadWrites = deps.threadWrites;
    const writeTools = [
      [
        CREATE_THREAD_TOOL_NAME,
        CREATE_THREAD_TOOL_DESCRIPTION,
        createThreadParams,
        createThreadText,
      ],
      [
        THREAD_MEMBERS_TOOL_NAME,
        THREAD_MEMBERS_TOOL_DESCRIPTION,
        threadMembersParams,
        runThreadMembers,
      ],
      [
        CREATE_FORUM_POST_TOOL_NAME,
        CREATE_FORUM_POST_TOOL_DESCRIPTION,
        createForumPostParams,
        createForumPostText,
      ],
      [
        SET_THREAD_STATE_TOOL_NAME,
        SET_THREAD_STATE_TOOL_DESCRIPTION,
        setThreadStateParams,
        runSetThreadState,
      ],
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
    // Task 6 (consolidated by ADR 0132 Task 2): the message-write tools,
    // same handler shape as `send_message` above — each text function
    // already answers every malformed argument and every port fault, so the
    // try/catch here only fires on something the tool layer did not foresee.
    const writes = deps.messageWrites;
    const messageWriteTools = [
      [EDIT_MESSAGE_TOOL_NAME, EDIT_MESSAGE_TOOL_DESCRIPTION, editMessageParams, editMessageText],
      [
        DELETE_MESSAGE_TOOL_NAME,
        DELETE_MESSAGE_TOOL_DESCRIPTION,
        deleteMessageParams,
        deleteMessageText,
      ],
      [SET_PIN_TOOL_NAME, SET_PIN_TOOL_DESCRIPTION, setPinParams, runSetPin],
      [REACT_TOOL_NAME, REACT_TOOL_DESCRIPTION, reactParams, runReact],
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
    // The four event/poll write tools, same handler shape as
    // `send_message` above — each text function already answers every
    // malformed argument and every port fault, so the try/catch here only
    // fires on something the tool layer did not foresee.
    const eventWrites = deps.eventWrites;
    const eventWriteTools = [
      [CREATE_EVENT_TOOL_NAME, CREATE_EVENT_TOOL_DESCRIPTION, createEventParams, createEventText],
      [EDIT_EVENT_TOOL_NAME, EDIT_EVENT_TOOL_DESCRIPTION, editEventParams, editEventText],
      [CANCEL_EVENT_TOOL_NAME, CANCEL_EVENT_TOOL_DESCRIPTION, cancelEventParams, cancelEventText],
      [CREATE_POLL_TOOL_NAME, CREATE_POLL_TOOL_DESCRIPTION, createPollParams, createPollText],
    ] as const;
    for (const [name, description, params, text] of eventWriteTools) {
      server.tool(name, description, params, async (args: unknown) => {
        try {
          const outcome = await text(deps.principal, eventWrites, args);
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
    // The schedule tools (slice 5, Task 3, consolidated by ADR 0132 Task
    // 2), same handler shape as `send_message` above — each text function
    // already answers every malformed argument and every port fault, so the
    // try/catch here only fires on something the tool layer did not
    // foresee. The write renders its outcome directly; `list_scheduled` is
    // a read of the connector's own outbox under this same send scope, so
    // it passes its record through the read-audit port like every other
    // read.
    const schedule = deps.schedule;
    const scheduleWriteTools = [
      [
        SCHEDULE_MESSAGE_TOOL_NAME,
        SCHEDULE_MESSAGE_TOOL_DESCRIPTION,
        scheduleMessageParams,
        scheduleMessageText,
      ],
      [
        UPDATE_SCHEDULED_TOOL_NAME,
        UPDATE_SCHEDULED_TOOL_DESCRIPTION,
        updateScheduledParams,
        runUpdateScheduled,
      ],
    ] as const;
    for (const [name, description, params, text] of scheduleWriteTools) {
      server.tool(name, description, params, async (args: unknown) => {
        try {
          const outcome = await text(deps.principal, schedule, args);
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
    server.tool(
      LIST_SCHEDULED_TOOL_NAME,
      LIST_SCHEDULED_TOOL_DESCRIPTION,
      listScheduledParams,
      (args: unknown) => {
        try {
          const outcome = listScheduledText(deps.principal, schedule, args);
          if (!outcome.ok) {
            return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
          }
          return okReadResult(deps.readAudit, outcome);
        } catch {
          return {
            content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
            isError: true,
          };
        }
      },
    );
  }
  // Slice 4, Task 5: `undo_action`, same handler shape — the text function
  // answers every outcome and the try/catch only fires on something it did
  // not foresee. Registers under send or roles, whichever the principal
  // carries (slice 4 extends it with the role-kind inverses under the roles
  // scope); the read half, `list_actions`, lives in the read block below.
  // Registered once: a token with both scopes must not see it twice.
  if (
    (hasSendScope(deps.principal) || hasRolesScope(deps.principal)) &&
    deps.actions !== undefined
  ) {
    const actions = deps.actions;
    server.tool(
      UNDO_ACTION_TOOL_NAME,
      UNDO_ACTION_TOOL_DESCRIPTION,
      undoActionParams,
      async (args: unknown) => {
        try {
          const outcome = await undoActionText(deps.principal, actions, args);
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
  }
  // Slice 4, Task 5: `create_role` and `edit_role` under the roles scope
  // (ADR 0114) — the same handler shape as `send_message` above. Each text
  // function already answers every malformed argument and every port fault,
  // so the try/catch here only fires on something the tool layer did not
  // foresee.
  if (hasRolesScope(deps.principal) && deps.roleAdmin !== undefined) {
    const roleAdmin = deps.roleAdmin;
    const roleAdminTools = [
      [CREATE_ROLE_TOOL_NAME, CREATE_ROLE_TOOL_DESCRIPTION, createRoleParams, createRoleText],
      [EDIT_ROLE_TOOL_NAME, EDIT_ROLE_TOOL_DESCRIPTION, editRoleParams, editRoleText],
    ] as const;
    for (const [name, description, params, text] of roleAdminTools) {
      server.tool(name, description, params, async (args: unknown) => {
        try {
          const outcome = await text(deps.principal, roleAdmin, args);
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
  // Slice 4, Task 6b: `create_panel`, `edit_panel` and `delete_panel`
  // under the roles scope (ADR 0114) — the same handler shape as
  // `send_message` above. Each text function already answers every malformed
  // argument and every port fault, so the try/catch here only fires on
  // something the tool layer did not foresee.
  if (hasRolesScope(deps.principal) && deps.panels !== undefined) {
    const panels = deps.panels;
    const panelWriteTools = [
      [CREATE_PANEL_TOOL_NAME, CREATE_PANEL_TOOL_DESCRIPTION, createPanelParams, createPanelText],
      [EDIT_PANEL_TOOL_NAME, EDIT_PANEL_TOOL_DESCRIPTION, editPanelParams, editPanelText],
    ] as const;
    for (const [name, description, params, text] of panelWriteTools) {
      server.tool(name, description, params, async (args: unknown) => {
        try {
          const outcome = await text(deps.principal, panels, deps.guild, args);
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
    // `delete_panel` takes no refs to resolve, so its text function needs no
    // guild port — registered beside the other two panel writes.
    server.tool(
      DELETE_PANEL_TOOL_NAME,
      DELETE_PANEL_TOOL_DESCRIPTION,
      deletePanelParams,
      async (args: unknown) => {
        try {
          const outcome = await deletePanelText(deps.principal, panels, args);
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
  }
  // ADR 0114: the role-change tools register under the roles scope, never
  // send. A token carrying only `bananasaurs:send` can post messages but
  // never touch roles; a roles-scope token sees exactly the two role tools.
  if (hasRolesScope(deps.principal)) {
    const roleWrites = deps.roleWrites;
    const roleWriteTools = [
      [GRANT_ROLE_TOOL_NAME, GRANT_ROLE_TOOL_DESCRIPTION, grantRoleParams, grantRoleText],
      [REMOVE_ROLE_TOOL_NAME, REMOVE_ROLE_TOOL_DESCRIPTION, removeRoleParams, removeRoleText],
    ] as const;
    for (const [name, description, params, text] of roleWriteTools) {
      server.tool(name, description, params, async (args: unknown) => {
        try {
          const outcome = await text(deps.principal, roleWrites, deps.guild, deps.members, args);
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
    // Slice 4, Task 4: `bulk_role_change` under the same roles scope — the
    // same handler shape. The text function already answers every malformed
    // argument and every port fault, so the try/catch here only fires on
    // something the tool layer did not foresee.
    if (deps.bulkRoles !== undefined) {
      const bulkRoles = deps.bulkRoles;
      server.tool(
        BULK_ROLE_CHANGE_TOOL_NAME,
        BULK_ROLE_CHANGE_TOOL_DESCRIPTION,
        bulkRoleChangeParams,
        async (args: unknown) => {
          try {
            const outcome = await bulkRoleChangeText(
              deps.principal,
              bulkRoles,
              deps.guild,
              deps.members,
              args,
            );
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
    }
  }
  // ADR 0114 (ADR 0101's follow-up), ADR 0132: the task-tracking write tools
  // register under the tasks scope, not send — as seven action-based tools
  // over the same daemon dispatch. A token carrying only `bananasaurs:send`
  // can post messages but never touch tasks; read-only task tools stay under
  // read below.
  if (hasTasksScope(deps.principal) && deps.taskAdmin) {
    const taskAdmin = deps.taskAdmin;
    const taskWriteTools = [
      [CREATE_TASK_TOOL_NAME, CREATE_TASK_TOOL_DESCRIPTION, createTaskParams, runCreateTask],
      [UPDATE_TASK_TOOL_NAME, UPDATE_TASK_TOOL_DESCRIPTION, updateTaskParams, runUpdateTask],
      [DELETE_TASK_TOOL_NAME, DELETE_TASK_TOOL_DESCRIPTION, deleteTaskParams, runDeleteTask],
      [TASK_STEPS_TOOL_NAME, TASK_STEPS_TOOL_DESCRIPTION, taskStepsParams, runTaskSteps],
      [
        TASK_REMINDERS_TOOL_NAME,
        TASK_REMINDERS_TOOL_DESCRIPTION,
        taskRemindersParams,
        runTaskReminders,
      ],
      [
        TASK_PROGRESS_TOOL_NAME,
        TASK_PROGRESS_TOOL_DESCRIPTION,
        taskProgressParams,
        runTaskProgress,
      ],
      [
        TASK_SETTINGS_TOOL_NAME,
        TASK_SETTINGS_TOOL_DESCRIPTION,
        taskSettingsParams,
        runTaskSettings,
      ],
    ] as const;
    for (const [name, description, params, run] of taskWriteTools) {
      server.tool(name, description, params, async (args: unknown) => {
        const outcome = await run(deps.principal, taskAdmin, args);
        return outcome.ok
          ? { content: [{ type: 'text' as const, text: outcome.text }] }
          : { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
      });
    }
  }
  if (!hasReadScope(deps.principal)) return server;
  const readAudit = deps.readAudit;
  // Task tools follow the Manage club tasks permission (ADR 0130); the ports are absent when the daemon omits them. The port is absent in
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
    server.tool(GET_TASK_TOOL_NAME, GET_TASK_TOOL_DESCRIPTION, getTaskParams, (args) => {
      try {
        const outcome = getTaskText(deps.principal, detailPort, args);
        if (!outcome.ok)
          return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
        return okReadResult(readAudit, {
          ok: true,
          text: outcome.text,
          read: {
            kind: 'content',
            action: GET_TASK_READ_ACTION,
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
    });
  }
  // ADR 0132: `task_teams` registers with the read tools when the daemon
  // threads the tasks port. Its `list` action reads through the port like
  // every other read; the write actions answer the reconnect message without
  // the tasks scope or the admin port.
  if (taskPort)
    server.tool(
      TASK_TEAMS_TOOL_NAME,
      TASK_TEAMS_TOOL_DESCRIPTION,
      taskTeamsParams,
      async (args) => {
        try {
          const outcome = await runTaskTeams(
            deps.principal,
            { tasks: taskPort, taskAdmin: deps.taskAdmin },
            args,
          );
          if (!outcome.ok)
            return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
          if (outcome.read !== undefined)
            return okReadResult(readAudit, {
              ok: true,
              text: outcome.text,
              read: {
                kind: 'content',
                action: 'mcp.read.list_task_teams',
                guildId: outcome.read.guildId,
                subjectType: 'guild',
                subjectId: undefined,
                resultCount: outcome.read.itemCount,
              },
            });
          return { content: [{ type: 'text' as const, text: outcome.text }] };
        } catch {
          return {
            content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
            isError: true,
          };
        }
      },
    );
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
  // ADR 0133, Task 4: `bananasaurs_guide`, a read tool. Its live block reads the
  // health and access ports; a missing one reads as unavailable, never a failed call.
  registerGuideTool(
    { server, principal: deps.principal, readAudit },
    { health: deps.health, access: deps.access },
  );
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
  // Slice 4, Task 6b: `list_panels` / `get_panel`, the `panel list` /
  // `panel show` reads. Structural reads like `list_roles` (ADR 0050): ids,
  // titles and labels in the text, one log line through `okReadResult`,
  // never an audit row — and the record itself carries no title or label.
  if (deps.panels !== undefined) {
    const panels = deps.panels;
    server.tool(LIST_PANELS_TOOL_NAME, LIST_PANELS_TOOL_DESCRIPTION, listPanelsParams, (args) => {
      try {
        const outcome = listPanelsText(deps.principal, panels, args);
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
    server.tool(GET_PANEL_TOOL_NAME, GET_PANEL_TOOL_DESCRIPTION, getPanelParams, (args) => {
      try {
        const outcome = getPanelText(deps.principal, panels, args);
        if (!outcome.ok) {
          return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
        }
        return okReadResult(readAudit, outcome);
      } catch {
        return { content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }], isError: true };
      }
    });
  }
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
  // Task 7: `list_actions`, the ledger read. A structural read like
  // `list_channels` (ADR 0050): one log line per successful call through
  // `okReadResult`, never an audit row, and the view carries ids only.
  if (deps.actions !== undefined) {
    const actions = deps.actions;
    server.tool(
      LIST_ACTIONS_TOOL_NAME,
      LIST_ACTIONS_TOOL_DESCRIPTION,
      listActionsParams,
      async (args) => {
        try {
          const outcome = await listActionsText(deps.principal, actions, args);
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
  }
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
