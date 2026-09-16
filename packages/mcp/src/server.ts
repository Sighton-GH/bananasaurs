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
  LIST_ROLES_TOOL_DESCRIPTION,
  LIST_ROLES_TOOL_NAME,
  listChannelsParams,
  listChannelsText,
  listMembersParams,
  listMembersText,
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
import { GUILD_REFUSAL_MESSAGE, type McpPrincipal } from './scope.js';

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
}

export const createMcpServer = (deps: McpServerDeps): McpServer => {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  server.tool(GET_HEALTH_TOOL_NAME, GET_HEALTH_TOOL_DESCRIPTION, () => {
    const outcome = getHealthText(deps.principal, deps.health);
    if (!outcome.ok) {
      return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: outcome.text }] };
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
        const outcome = searchMessagesText(deps.principal, archive, args);
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
  server.tool(
    READ_CHANNEL_HISTORY_TOOL_NAME,
    READ_CHANNEL_HISTORY_TOOL_DESCRIPTION,
    readChannelHistoryParams,
    (args) => {
      try {
        const outcome = readChannelHistoryText(deps.principal, archive, args);
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
  server.tool(GET_MESSAGE_TOOL_NAME, GET_MESSAGE_TOOL_DESCRIPTION, getMessageParams, (args) => {
    try {
      const outcome = getMessageText(deps.principal, archive, args);
      if (!outcome.ok) {
        return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: outcome.text }] };
    } catch {
      return { content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }], isError: true };
    }
  });
  const guild = deps.guild;
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
        return { content: [{ type: 'text' as const, text: outcome.text }] };
      } catch {
        return {
          content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
          isError: true,
        };
      }
    },
  );
  server.tool(LIST_ROLES_TOOL_NAME, LIST_ROLES_TOOL_DESCRIPTION, listRolesParams, (args) => {
    try {
      const outcome = listRolesText(deps.principal, guild, args);
      if (!outcome.ok) {
        return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: outcome.text }] };
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
        return { content: [{ type: 'text' as const, text: outcome.text }] };
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
        return { content: [{ type: 'text' as const, text: outcome.text }] };
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
      return { content: [{ type: 'text' as const, text: outcome.text }] };
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
        return { content: [{ type: 'text' as const, text: outcome.text }] };
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
        return { content: [{ type: 'text' as const, text: outcome.text }] };
      } catch {
        return {
          content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
          isError: true,
        };
      }
    },
  );
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
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: outcome.text }] };
    },
  );
  return server;
};
