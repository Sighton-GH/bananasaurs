import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseDuration, snowflakeIdSchema } from '@bananasaurs/core';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import { requireCapability } from './capability.js';

/**
 * The dashboard's second read surface: the operator-observability answers
 * the CLI gives through `doctor`, `backup list`, `provider status`,
 * `archive status|search`, `config show`, `account list`, `mcp clients` and
 * `mcp tokens` (ADR 0051 D1–D3). Every answer already exists on `OpsPorts`
 * / `OpsInstance` — nothing here is a new query. The module's whole job is
 * the same as `read.ts`'s: authentication (via `guard`), authorization
 * (via `requireCapability`), and mapping a scope-free call onto
 * `session.scope`.
 *
 * `GET /api/archive/status` deliberately omits
 * `listUnreadableArchiveChannels`: that check needs the live Discord
 * client and already renders through `doctor`, so the dashboard reads it
 * from the Doctor page rather than duplicating the probe here.
 *
 * Capability mapping: everything below reads under `config.read` — the
 * same grant the existing `/api/health` and `/api/jobs` reads use — with
 * one exception. `GET /api/archive/search` returns archived message
 * content, so it sits under `audit.read`, the grant that already gates
 * the dashboard's other content-bearing history (`/api/audit`). `doctor`,
 * backups, providers, MCP client/token listings and the redacted config
 * are instance facts, not guild facts, so they come from `deps.instance`
 * rather than `portsFor(scope)` — the same split `OpsInstance`'s own
 * comments make.
 */

const archiveSearchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  channelId: z.string().min(1).optional(),
  authorId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export const registerOpsReadRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.get<{ Params: { id: string } }>('/api/jobs/:id', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    const jobId = Number(request.params.id);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return reply.status(400).send({ error: 'bad-request' });
    }
    const ports = deps.portsFor(session.scope);
    const job = ports.findJob(jobId);
    if (job === undefined) return reply.status(404).send({ error: 'not-found' });
    return reply.status(200).send(job);
  });

  app.get('/api/guild/channels', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    return reply.status(200).send({ channels: ports.listGuildChannels() });
  });

  // The self-granted roles builder's message check (Bryan's roles lane): a
  // reaction role attaches to an existing Discord message by id, and the
  // form validates the target before anything is written. Same answer the
  // submit makes, so a "found" here cannot 400 there.
  app.get<{ Params: { channelId: string; messageId: string } }>(
    '/api/guild/channels/:channelId/messages/:messageId',
    async (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'panels.manage', reply)) return reply;

      const ports = deps.portsFor(session.scope);
      const lookup = await ports.findGuildMessage(
        request.params.channelId,
        request.params.messageId,
      );
      // The preview rides along so the form can show the message it is
      // about to attach to; a miss on the preview alone is not an error.
      const message =
        lookup === 'ok'
          ? await ports.previewGuildMessage(request.params.channelId, request.params.messageId)
          : undefined;
      return reply.status(200).send({ lookup, ...(message !== undefined ? { message } : {}) });
    },
  );

  // The emoji picker's custom emoji: part of the panel builder, so the same
  // capability as the message check beside it.
  app.get('/api/guild/emojis', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'panels.manage', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    return reply.status(200).send({ emojis: await ports.listGuildEmojis() });
  });

  // The MCP `read_channel_history` / `get_message` answers as routes
  // (ADR 0051): archived content, so `audit.read` like archive search. The
  // visibility set lives in the repository — a channel outside the guild's
  // archive-enabled set answers empty, never an existence leak.
  app.get<{ Params: { channelId: string } }>(
    '/api/archive/channels/:channelId/messages',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'audit.read', reply)) return reply;

      const query = z
        .object({
          before: snowflakeIdSchema.optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .safeParse(request.query);
      if (!query.success || !snowflakeIdSchema.safeParse(request.params.channelId).success) {
        return reply.status(400).send({ error: 'invalid-query' });
      }

      const ports = deps.portsFor(session.scope);
      return reply.status(200).send({
        messages: ports.archiveChannelHistory({
          channelId: request.params.channelId,
          before: query.data.before,
          limit: query.data.limit,
        }),
      });
    },
  );

  app.get<{ Params: { messageId: string } }>(
    '/api/archive/messages/:messageId',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'audit.read', reply)) return reply;

      if (!snowflakeIdSchema.safeParse(request.params.messageId).success) {
        return reply.status(400).send({ error: 'invalid-query' });
      }
      const ports = deps.portsFor(session.scope);
      const message = ports.archiveFindMessage(request.params.messageId);
      if (message === undefined) return reply.status(404).send({ error: 'not-found' });
      return reply.status(200).send(message);
    },
  );

  app.get('/api/guild/members', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;

    // Default page of 25, capped at 100 — the MCP `list_members` tool's own
    // bounds, so the directory and the tool page through the same way.
    const query = z
      .object({
        after: snowflakeIdSchema.optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .safeParse(request.query);
    if (!query.success) return badRequest(reply, query.error, 'invalid-query');

    const ports = deps.portsFor(session.scope);
    const page = await ports.listGuildMembers({
      after: query.data.after,
      limit: query.data.limit,
    });
    return reply.status(200).send(page);
  });

  app.get('/api/guild/roles', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    const botPosition = ports.botHighestRolePosition();
    return reply.status(200).send({
      roles: ports.listGuildRoles().map((role) => {
        // Manageability is Discord's live hierarchy, not a remembered flag:
        // below the bot's own highest role and not integration-owned. The
        // owner can reorder roles in Discord at any time and the picker must
        // reflect that on the next load.
        const manageable =
          !role.managed && botPosition !== undefined && role.position < botPosition;
        return {
          ...role,
          manageable,
          allowlisted: ports.isManagedRole(role.roleId),
          // Selectable in the panel builder. A Discord-managed role can never
          // be granted by a bot; anything else below the bot can, and saving
          // the panel allowlists it.
          optionable: manageable,
        };
      }),
    });
  });

  app.get('/api/archive/status', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    return reply.status(200).send({
      channels: ports.archiveStatus(),
      index: ports.archiveIndexHealth(),
    });
  });

  app.get('/api/archive/search', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;

    const parsed = archiveSearchQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const ports = deps.portsFor(session.scope);
    const input: {
      query: string;
      channelId?: string;
      authorId?: string;
      limit?: number;
    } = { query: parsed.data.q, limit: parsed.data.limit ?? 50 };
    if (parsed.data.channelId !== undefined) input.channelId = parsed.data.channelId;
    if (parsed.data.authorId !== undefined) input.authorId = parsed.data.authorId;
    return reply.status(200).send(ports.archiveSearch(input));
  });

  app.get('/api/send-allowlist', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    return reply.status(200).send({ entries: ports.listSendAllowlist() });
  });

  app.get('/api/read-scope', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    return reply.status(200).send({ entries: ports.readScopeList() });
  });

  // Slice 5 task 6 (ADR 0117 §2): the role-policy modes and the role
  // allowlist, the read half of `mcp role-policy`. Ids and purposes only —
  // the dashboard resolves names from its live role list.
  app.get('/api/role-policy', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    const policy = ports.readRolePolicy();
    return reply.status(200).send({
      grantMode: policy.grantMode,
      pingMode: policy.pingMode,
      entries: ports.listRoleAllowlist(),
    });
  });

  app.get('/api/doctor', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    return reply.status(200).send(deps.instance.doctor());
  });

  app.get('/api/doctor/public-surface', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    return reply.status(200).send(await deps.instance.probePublicSurface());
  });

  app.get('/api/backups', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    return reply.status(200).send({ backups: deps.instance.backupList() });
  });

  app.get('/api/config', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    return reply.status(200).send(deps.instance.redactedConfig());
  });

  app.get('/api/accounts', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    // The accounts are instance-level; the capabilities are this guild's.
    // `account list` + `account grant` in one read, so the web page shows
    // everything the CLI shows.
    const accounts = deps.instance.accountList();
    const ports = deps.portsFor(session.scope);
    const capabilities: Record<string, readonly string[]> = {};
    for (const account of accounts) {
      capabilities[account.accountId] = ports.listAccountCapabilities(account.accountId);
    }
    return reply.status(200).send({ accounts, capabilities });
  });

  app.get('/api/mcp/clients', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    return reply.status(200).send({ clients: deps.instance.mcpClients() });
  });

  // ADR 0130: one entry per sign-in, with the account username, app name,
  // scopes and status joined in by the port.
  app.get('/api/mcp/connections', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    return reply.status(200).send({ connections: deps.instance.mcpConnections() });
  });

  app.get('/api/mcp/tokens', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    return reply.status(200).send({ tokens: deps.instance.mcpTokens() });
  });

  app.get<{ Querystring: { since?: string; limit?: string } }>(
    '/api/mcp/sends',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'audit.read', reply)) return reply;

      let sinceMs: number | undefined;
      if (request.query.since !== undefined && request.query.since !== '') {
        const window = parseDuration(request.query.since);
        if (window === undefined) {
          return reply.status(400).send({
            error: 'bad-since',
            message: `since expects a duration like 2h, 45m or 7d, not "${request.query.since}"`,
          });
        }
        sinceMs = deps.now() - window;
      }
      // Bounded like the sibling reads (members, archive history): default
      // page of 25, capped at 200, so the page never ships the guild's
      // whole-lifetime ledger on every visit.
      const limitQuery = z.coerce.number().int().min(1).max(200).optional();
      const parsedLimit = limitQuery.safeParse(
        request.query.limit === '' ? undefined : request.query.limit,
      );
      if (!parsedLimit.success) return badRequest(reply, parsedLimit.error, 'invalid-query');
      const rows = deps
        .portsFor(session.scope)
        .listSends({ sinceMs, limit: parsedLimit.data ?? 25 });
      // The ledger never carries message content, only ids and outcomes (M5).
      return reply.status(200).send({
        sends: rows.map((row) => ({
          channelId: row.channelId,
          messageId: row.messageId ?? null,
          tokenId: row.tokenId,
          sentAt: row.sentAt,
          outcome: row.outcome,
        })),
      });
    },
  );

  app.get('/api/providers/eligibility', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    return reply
      .status(200)
      .send({ warnings: deps.instance.providerEligibilityWarnings(deps.now()) });
  });
};
