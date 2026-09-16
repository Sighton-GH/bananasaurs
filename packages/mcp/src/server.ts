import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  GET_HEALTH_TOOL_DESCRIPTION,
  GET_HEALTH_TOOL_NAME,
  getHealthText,
  type McpHealthPort,
} from './tools/health.js';
import type { McpPrincipal } from './scope.js';

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
}

export const createMcpServer = (deps: McpServerDeps): McpServer => {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  server.tool(GET_HEALTH_TOOL_NAME, GET_HEALTH_TOOL_DESCRIPTION, async () => {
    const outcome = getHealthText(deps.principal, deps.health);
    if (!outcome.ok) {
      return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: outcome.text }] };
  });
  return server;
};
