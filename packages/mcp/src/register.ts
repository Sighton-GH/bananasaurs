import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodTypeAny } from 'zod';
import { GUILD_REFUSAL_MESSAGE, type McpPrincipal } from './scope.js';
import { performReadRecord, type McpReadAuditPort, type McpReadRecord } from './read-audit.js';

/**
 * The context a read tool registers with: the server under construction,
 * the request's already-authenticated principal, and the per-request
 * read-logging port (ADR 0050).
 */
export interface RegisterContext {
  readonly server: McpServer;
  readonly principal: McpPrincipal;
  readonly readAudit: McpReadAuditPort;
}

/**
 * What a read tool's text function returns: either the answer text with
 * the record ADR 0050 says the server must perform, or a refusal message.
 */
export type ReadOutcome =
  | { readonly ok: true; readonly text: string; readonly read: McpReadRecord }
  | { readonly ok: false; readonly message: string };

/**
 * Registers one read tool with the handler shape every read tool in
 * server.ts uses: refusal → isError text; success → perform the ADR 0050
 * record, then return the text (a record that cannot be written refuses);
 * any throw → the shared refusal. New tool modules register through this so
 * server.ts gains one call line per module (spec §8.3).
 */
export const registerReadTool = (
  ctx: RegisterContext,
  name: string,
  description: string,
  params: Record<string, ZodTypeAny>,
  run: (args: unknown) => ReadOutcome | Promise<ReadOutcome>,
): void => {
  ctx.server.tool(name, description, params, async (args) => {
    try {
      const outcome = await run(args);
      if (!outcome.ok) {
        return { content: [{ type: 'text' as const, text: outcome.message }], isError: true };
      }
      performReadRecord(ctx.readAudit, outcome.read);
      return { content: [{ type: 'text' as const, text: outcome.text }] };
    } catch {
      return {
        content: [{ type: 'text' as const, text: GUILD_REFUSAL_MESSAGE }],
        isError: true,
      };
    }
  });
};
