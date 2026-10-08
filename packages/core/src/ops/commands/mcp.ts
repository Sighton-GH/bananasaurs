import { z } from 'zod';
import {
  defineCommand,
  type OpsCommandResult,
  type OpsContext,
  type OpsWriteResult,
} from '../dispatch.js';
import { mcpScopeLabel } from '../mcp-scopes.js';
import { OPS_AUDIT_ACTIONS } from '../audit-actions.js';

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

/**
 * The response is one socket line capped at `OPS_MAX_LINE_BYTES`; every hourly
 * refresh adds two rows, so the listing is capped (ADR 0130 §7).
 */
const MCP_TOKENS_LIMIT = 100;

const mcpTokensArgs = z.object({ connection: z.string().min(1).max(128).optional() });

export const mcpTokensCommand = defineCommand<z.infer<typeof mcpTokensArgs>>({
  name: 'mcp tokens',
  write: false,
  summary:
    'the newest 100 OAuth token rows (ids only — values are never retrievable); see `mcp connections`',
  flags: [{ name: 'connection', kind: 'string', describe: 'only rows of this connection id' }],
  args: mcpTokensArgs,

  run(ctx: OpsContext, args): OpsCommandResult {
    // Live first, then newest first: the operator revoking a leaked token is
    // looking for what is still usable, not for history.
    const all = [...ctx.instance.mcpTokens()]
      .filter((t) => args.connection === undefined || t.connectionId === args.connection)
      .sort((a, b) => {
        const liveA = a.revokedAt === null ? 0 : 1;
        const liveB = b.revokedAt === null ? 0 : 1;
        if (liveA !== liveB) return liveA - liveB;
        return b.createdAt - a.createdAt;
      });
    if (all.length === 0) {
      return { text: 'no tokens', data: [] };
    }
    const tokens = all.slice(0, MCP_TOKENS_LIMIT);
    const more = all.length - tokens.length;
    return {
      text: [
        ...tokens.map(
          (token) =>
            `${token.tokenId}  ${token.kind}  client ${token.clientId}  ` +
            `account ${token.accountId}  expires ${iso(token.expiresAt)}  ` +
            `last used ${token.lastUsedAt === null ? 'never' : iso(token.lastUsedAt)}  ` +
            `${token.revokedAt === null ? 'live' : `revoked ${iso(token.revokedAt)}`}`,
        ),
        ...(more > 0 ? [`…and ${String(more)} more; filter with --connection`] : []),
      ].join('\n'),
      data: tokens.map((token) => ({
        tokenId: token.tokenId,
        kind: token.kind,
        clientId: token.clientId,
        accountId: token.accountId,
        connectionId: token.connectionId,
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
        action: OPS_AUDIT_ACTIONS.mcpTokenRevoked,
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
        action: OPS_AUDIT_ACTIONS.mcpClientRevoked,
        subjectType: 'instance',
        subjectId: undefined,
        before: { clientId: args.clientId },
        after: { clientId: args.clientId, tokensRevoked },
      },
    };
  },
});

// --- mcp connections (ADR 0130) ------------------------------------------------

export const mcpConnectionsCommand = defineCommand<Record<string, never>>({
  name: 'mcp connections',
  write: false,
  summary: 'every sign-in an app made: account, app, what it may do, status and last use',
  args: z.object({}),

  run(ctx: OpsContext): OpsCommandResult {
    const connections = ctx.instance.mcpConnections();
    if (connections.length === 0) {
      return { text: 'no connections', data: [] };
    }
    return {
      text: connections
        .map(
          (c) =>
            `${c.connectionId}  ${c.status}  account ${c.accountUsername ?? '(deleted)'}  ` +
            `app "${c.clientName ?? '(deleted)'}" (${c.clientId})  ` +
            `can ${c.scopes.map(mcpScopeLabel).join(', ')}  since ${iso(c.createdAt)}  ` +
            `last used ${c.lastUsedAt === null ? 'never' : iso(c.lastUsedAt)}  ` +
            `${String(c.tokenCount)} token rows`,
        )
        .join('\n'),
      data: connections.map((c) => ({ ...c, scopes: [...c.scopes] })),
    };
  },
});

// --- mcp disconnect ------------------------------------------------------------

const connectionArgs = z.object({ connectionId: z.string().min(1).max(128) });
const connectionPositional = [
  { name: 'connectionId', required: true, describe: 'the connection id from `mcp connections`' },
] as const;

export const mcpDisconnectCommand = defineCommand<z.infer<typeof connectionArgs>>({
  name: 'mcp disconnect',
  write: true,
  summary: 'revoke every live token of one connection (rows are kept)',
  positional: connectionPositional,
  args: connectionArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const tokensRevoked = ctx.instance.mcpDisconnect(args.connectionId);
    if (tokensRevoked === undefined) {
      throw new Error(`no such connection ${args.connectionId}`);
    }
    return {
      text: `disconnected ${args.connectionId}: revoked ${String(tokensRevoked)} token(s)`,
      data: { connectionId: args.connectionId, tokensRevoked },
      audit: {
        action: OPS_AUDIT_ACTIONS.mcpConnectionRevoked,
        subjectType: 'instance',
        subjectId: undefined,
        before: { connectionId: args.connectionId },
        after: { connectionId: args.connectionId, tokensRevoked },
      },
    };
  },
});

// --- mcp delete-connection -----------------------------------------------------

export const mcpDeleteConnectionCommand = defineCommand<z.infer<typeof connectionArgs>>({
  name: 'mcp delete-connection',
  write: true,
  summary: 'revoke then delete every token row of one connection',
  positional: connectionPositional,
  args: connectionArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const result = ctx.instance.mcpDeleteConnection(args.connectionId);
    if (result === undefined) {
      throw new Error(`no such connection ${args.connectionId}`);
    }
    return {
      text:
        `deleted connection ${args.connectionId}: ${String(result.deleted)} token row(s), ` +
        `${String(result.revoked)} revoked first`,
      data: {
        connectionId: args.connectionId,
        tokensRevoked: result.revoked,
        tokensDeleted: result.deleted,
      },
      audit: {
        action: OPS_AUDIT_ACTIONS.mcpConnectionDeleted,
        subjectType: 'instance',
        subjectId: undefined,
        before: { connectionId: args.connectionId },
        after: {
          connectionId: args.connectionId,
          tokensRevoked: result.revoked,
          tokensDeleted: result.deleted,
        },
      },
    };
  },
});

// --- mcp delete-token ----------------------------------------------------------

export const mcpDeleteTokenCommand = defineCommand<z.infer<typeof mcpRevokeArgs>>({
  name: 'mcp delete-token',
  write: true,
  summary: 'delete one token row (its connection is disconnected first if still connected)',
  positional: [{ name: 'tokenId', required: true, describe: 'the token id from `mcp tokens`' }],
  args: mcpRevokeArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const result = ctx.instance.mcpDeleteToken(args.tokenId);
    if (result === undefined) {
      throw new Error(`no such token ${args.tokenId}`);
    }
    return {
      text: `deleted token ${args.tokenId} (${String(result.revoked)} revoked first)`,
      data: { tokenId: args.tokenId, tokensRevoked: result.revoked, tokensDeleted: result.deleted },
      audit: {
        action: OPS_AUDIT_ACTIONS.mcpTokenDeleted,
        subjectType: 'instance',
        subjectId: undefined,
        before: { tokenId: args.tokenId },
        after: {
          tokenId: args.tokenId,
          tokensRevoked: result.revoked,
          tokensDeleted: result.deleted,
        },
      },
    };
  },
});

// --- mcp cleanup ---------------------------------------------------------------

export const mcpCleanupCommand = defineCommand<Record<string, never>>({
  name: 'mcp cleanup',
  write: true,
  summary: 'delete every connection that no longer works, and registered apps left with none',
  args: z.object({}),

  run(ctx: OpsContext): OpsWriteResult {
    const result = ctx.instance.mcpCleanup();
    return {
      text:
        `deleted ${String(result.tokens)} expired or revoked token row(s) and ` +
        `${String(result.clients)} unused app(s)`,
      data: { tokensDeleted: result.tokens, clientsDeleted: result.clients },
      audit: {
        action: OPS_AUDIT_ACTIONS.mcpTokensCleaned,
        subjectType: 'instance',
        subjectId: undefined,
        before: undefined,
        after: { tokensDeleted: result.tokens, clientsDeleted: result.clients },
      },
    };
  },
});
