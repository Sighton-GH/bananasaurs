import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
  return server;
};
