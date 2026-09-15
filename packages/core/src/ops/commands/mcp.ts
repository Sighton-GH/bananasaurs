import { z } from 'zod';
import {
  defineCommand,
  type OpsCommandResult,
  type OpsContext,
  type OpsWriteResult,
} from '../dispatch.js';

/**
 * The `mcp …` operator surface (ADR 0045).
 *
 * Four commands over the four `OpsInstance` MCP members: listing the
 * registered clients, listing every token row, revoking one token, and
 * removing a client together with everything issued to it. Instance-level
 * throughout — a client is registered against the daemon and a token carries
 * no guild — so these read `ctx.instance`, not `ctx.ports`.
 *
 * **No token value anywhere here.** The repository stores only hashes and the
 * one response that mints a token is the only place a value ever appears, so
 * there is nothing to print: `mcp tokens` renders ids, and the tests assert
 * no 43-character base64url run reaches the text.
 */

const iso = (ms: number): string => new Date(ms).toISOString();

// --- mcp clients -------------------------------------------------------------

export const mcpClientsCommand = defineCommand<Record<string, never>>({
  name: 'mcp clients',
  write: false,
  summary: 'every registered OAuth client (ids and names only — clients hold no secret)',
  args: z.object({}),

  run(ctx: OpsContext): OpsCommandResult {
    const clients = ctx.instance.mcpClients();
    if (clients.length === 0) {
      return { text: 'no OAuth clients are registered', data: [] };
    }
    return {
      text: clients
        .map(
          (client) =>
            `${client.clientId}  ${client.clientName}  ${client.registrationSource}  ` +
            `registered ${iso(client.createdAt)}  ${String(client.redirectUriCount)} redirect uri(s)`,
        )
        .join('\n'),
      data: clients.map((client) => ({
        clientId: client.clientId,
        clientName: client.clientName,
        registrationSource: client.registrationSource,
        createdAt: client.createdAt,
        redirectUriCount: client.redirectUriCount,
      })),
    };
  },
});

// --- mcp tokens --------------------------------------------------------------

export const mcpTokensCommand = defineCommand<Record<string, never>>({
  name: 'mcp tokens',
  write: false,
  summary: 'every OAuth token row, live or revoked (ids only — values are never retrievable)',
  args: z.object({}),

  run(ctx: OpsContext): OpsCommandResult {
    // Live first, then newest first: the operator revoking a leaked token is
    // looking for what is still usable, not for history.
    const tokens = [...ctx.instance.mcpTokens()].sort((a, b) => {
      const liveA = a.revokedAt === null ? 0 : 1;
      const liveB = b.revokedAt === null ? 0 : 1;
      if (liveA !== liveB) return liveA - liveB;
      return b.createdAt - a.createdAt;
    });
    if (tokens.length === 0) {
      return { text: 'no tokens', data: [] };
    }
    return {
      text: tokens
        .map(
          (token) =>
            `${token.tokenId}  ${token.kind}  client ${token.clientId}  ` +
            `account ${token.accountId}  expires ${iso(token.expiresAt)}  ` +
            `last used ${token.lastUsedAt === null ? 'never' : iso(token.lastUsedAt)}  ` +
            `${token.revokedAt === null ? 'live' : `revoked ${iso(token.revokedAt)}`}`,
        )
        .join('\n'),
      data: tokens.map((token) => ({
        tokenId: token.tokenId,
        kind: token.kind,
        clientId: token.clientId,
        accountId: token.accountId,
        createdAt: token.createdAt,
        expiresAt: token.expiresAt,
        revokedAt: token.revokedAt,
        lastUsedAt: token.lastUsedAt,
      })),
    };
  },
});

// --- mcp revoke --------------------------------------------------------------

const mcpRevokeArgs = z.object({
  tokenId: z.string().min(1).max(128),
});

export const mcpRevokeCommand = defineCommand<z.infer<typeof mcpRevokeArgs>>({
  name: 'mcp revoke',
  write: true,
  summary: 'revoke one OAuth token by id',
  positional: [{ name: 'tokenId', required: true, describe: 'the token id from `mcp tokens`' }],
  args: mcpRevokeArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    // A throw is the existing convention for a write that changed nothing
    // (`backup now` throws when the backup itself failed): an unknown id is a
    // usage mistake, not an answer, and a throw produces no audit row for a
    // state that did not change.
    const tokensRevoked = ctx.instance.mcpRevokeToken(args.tokenId);
    if (tokensRevoked === undefined) {
      throw new Error(`no such token ${args.tokenId}`);
    }
    return {
      text: `revoked token ${args.tokenId} and ${String(tokensRevoked)} token(s) in its lineage`,
      data: { tokenId: args.tokenId, tokensRevoked },
      audit: {
        action: 'mcp.token.revoked',
        subjectType: 'instance',
        subjectId: undefined,
        before: { tokenId: args.tokenId, live: true },
        after: { tokenId: args.tokenId, live: false, tokensRevoked },
      },
    };
  },
});

// --- mcp revoke-client --------------------------------------------------------

const mcpRevokeClientArgs = z.object({
  clientId: z.string().min(1).max(128),
});

export const mcpRevokeClientCommand = defineCommand<z.infer<typeof mcpRevokeClientArgs>>({
  name: 'mcp revoke-client',
  write: true,
  summary: 'remove an OAuth client and revoke everything issued to it',
  positional: [{ name: 'clientId', required: true, describe: 'the client id from `mcp clients`' }],
  args: mcpRevokeClientArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const tokensRevoked = ctx.instance.mcpRevokeClient(args.clientId);
    if (tokensRevoked === undefined) {
      throw new Error(`no such client ${args.clientId}`);
    }
    return {
      text: `removed client ${args.clientId} and revoked ${String(tokensRevoked)} token(s)`,
      data: { clientId: args.clientId, tokensRevoked },
      audit: {
        action: 'mcp.client.revoked',
        subjectType: 'instance',
        subjectId: undefined,
        before: { clientId: args.clientId },
        after: { clientId: args.clientId, tokensRevoked },
      },
    };
  },
});
