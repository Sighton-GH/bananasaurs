import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ChannelType, type Client, type Guild } from 'discord.js';
import { safeLogFields, type GuildId, type Logger } from '@bananasaurs/core';
import { requireBearer, type HttpDeps } from '@bananasaurs/http';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  createMcpServer,
  GUILD_REFUSAL_MESSAGE,
  type McpArchivePort,
  type McpGuildHealth,
  type McpGuildPort,
  type McpHealthPort,
  type McpPrincipal,
  type McpRecordsPort,
} from '@bananasaurs/mcp';
import {
  archiveRepo,
  archiveSearchRepo,
  automodAdminRepo,
  effectRepo,
  modCaseRepo,
  panelRepo,
  roleRepo,
} from '@bananasaurs/storage';

/**
 * The owner's MCP read surface (slice M4), mounted at `/mcp` by the daemon's
 * HTTP wiring — and only when the operator opted in with `MCP_PUBLIC_URL`.
 *
 * Ruling M4-D7: the bearer guard is called here, by the daemon, not by
 * `packages/mcp` (which may not import `@bananasaurs/http` at all). The
 * composition root authenticates with `requireBearer` and hands the resulting
 * principal straight to the server factory — `BearerPrincipal` is
 * structurally compatible with `McpPrincipal`, so no adapter is needed.
 */

export const MCP_ROUTE_PATH = '/mcp';

/**
 * Projects the operator surface down to the narrow port `get_health` needs,
 * field by field. `OpsInstance` itself is never passed: it carries write
 * members (`mcpRevokeToken`, `accountSetDisabled`, …) no MCP tool may reach,
 * and M4 is read-only. One entry per guild in the caller's reachable set, so
 * a guild-independent tool still reports per-guild facts without taking a
 * guild argument — and an emptied reachable set yields an empty list, which
 * is what `get_health` refuses on (ADR 0044 §4 obligation 1).
 */
const healthPortFor = (principal: McpPrincipal, deps: HttpDeps): McpHealthPort => {
  const nowMs = deps.now();
  const gateway = deps.instance.gateway();
  const guilds: McpGuildHealth[] = principal.reachableGuilds.map((guildId) => {
    const ports = deps.portsFor(deps.scopes.forGuild(guildId));
    const safety = ports.safetyState();
    const dueAtMs = ports.oldestDueJobAtMs(nowMs);
    return {
      guildId,
      guildName: ports.guildName(),
      safety:
        safety === undefined
          ? undefined
          : {
              killswitch: safety.killswitch,
              dryRun: safety.dryRun,
              breakerOpen: safety.breakerOpen,
              breakerReason: safety.breakerReason,
            },
      jobCounts: ports.jobCounts(),
      // Clamped at zero so a clock that moved backwards reports "not behind"
      // rather than a negative lag — the same rule `/status` follows.
      schedulerLagMs: dueAtMs === undefined ? 0 : Math.max(0, nowMs - dueAtMs),
    };
  });
  return {
    startedAtMs: deps.instance.startedAtMs,
    readonly: deps.instance.readonly,
    env: deps.instance.env,
    gateway: {
      connected: gateway.connected,
      pingMs: gateway.pingMs,
      guildCount: gateway.guildCount,
    },
    now: deps.now,
    guilds,
  };
};

/**
 * The step-2 trace (ruling M4-D18). Every port method below runs inside one
 * of these wrappers, so a repository or cache fault leaves one error line
 * before the throw reaches the tool layer — which answers the shared refusal
 * and swallows the throw, while the route's `catch` only fires on a
 * transport fault. Without this line the operator has no trace to contradict
 * a "guild unknown or unreachable" report caused by a stale FTS index or a
 * missing intent. Rethrown after logging: the tool layer still refuses.
 *
 * Allowlisted fields only (CLAUDE.md rule 4): `component`, `reason`, `err`.
 * `safeLogFields` (`packages/core/src/obs/logger.ts`) permits no `tool`
 * field, so the port method name goes in `reason`. Never a token, a session
 * id, message content, a member name, a snippet, or an audit payload.
 */
const logPortFailure = (logger: Logger, reason: string, err: unknown): never => {
  logger.error(
    safeLogFields({
      component: 'mcp',
      reason,
      err: err instanceof Error ? err.message : 'mcp port failed',
    }),
    'mcp port failed',
  );
  throw err;
};

const loggedCall = <T>(logger: Logger, reason: string, call: () => T): T => {
  try {
    return call();
  } catch (err) {
    return logPortFailure(logger, reason, err);
  }
};

const loggedCallAsync = async <T>(
  logger: Logger,
  reason: string,
  call: () => Promise<T>,
): Promise<T> => {
  try {
    return await call();
  } catch (err) {
    return logPortFailure(logger, reason, err);
  }
};

/**
 * The `McpArchivePort` behind the three archive tools, field by field like
 * `healthPortFor` above. Each method turns the already-resolved `GuildId`
 * into a `GuildScope` per call and reads through the archive repositories —
 * nothing here writes, and M4 is read-only. The visibility set is built in
 * the tool layer from `listArchiveChannelIds` (every archive-enabled channel
 * in the guild); the caller's `channelIds` only ever narrows within it.
 * A fault leaves one allowlisted-fields error line via `loggedCall` above,
 * never message content (rule 4).
 */
const archivePortFor = (deps: HttpDeps): McpArchivePort => ({
  listArchiveChannelIds: (guildId) =>
    loggedCall(deps.logger, 'listArchiveChannelIds', () =>
      archiveRepo.listChannels(deps.scopes.forGuild(guildId)).map((channel) => channel.channelId),
    ),
  searchMessages: (guildId, input) =>
    loggedCall(deps.logger, 'searchMessages', () => {
      const result = archiveSearchRepo.searchMessages(deps.scopes.forGuild(guildId), {
        query: input.query,
        visibility: input.visibility,
        ...(input.channelIds !== undefined ? { channelIds: input.channelIds } : {}),
        ...(input.authorId !== undefined ? { authorId: input.authorId } : {}),
        ...(input.before !== undefined ? { before: input.before } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      return {
        total: result.total,
        hits: result.hits.map((hit) => ({
          messageId: hit.messageId,
          channelId: hit.channelId,
          authorId: hit.authorId,
          createdAt: hit.createdAt,
          excerpt: hit.excerpt,
        })),
      };
    }),
  findMessage: (guildId, messageId) =>
    loggedCall(deps.logger, 'findMessage', () =>
      archiveRepo.findMessage(deps.scopes.forGuild(guildId), messageId),
    ),
  listChannelHistory: (guildId, input) =>
    loggedCall(deps.logger, 'listChannelHistory', () =>
      archiveRepo.listChannelHistory(deps.scopes.forGuild(guildId), {
        channelId: input.channelId,
        ...(input.beforeMessageId !== undefined ? { beforeMessageId: input.beforeMessageId } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }),
    ),
});

/**
 * The `McpGuildPort` behind the three Discord-cache tools, field by field
 * like `healthPortFor` above. Channels and roles are projected out of the
 * gateway cache (`ChannelManager`/`RoleManager` have no size limit, so the
 * cache is complete once the guild is READY); members are a paginated REST
 * fetch (`guild.members.list`, ruling M4-D10 — the 50-entry
 * `GuildMemberManager` cap in `packages/discord/src/client.ts` makes a cache
 * read silently wrong on any guild over 50 members).
 *
 * This is a READ from Discord, so it does not go through ADR 0014's effect
 * gateway: the gateway governs writes, and a read calling
 * `guild.members.list` directly is the same pattern `doctor` already uses
 * for `guild.members.me`. Do not route it through the gateway later "for
 * consistency" — the gateway would add kill-switch/breaker write semantics
 * to a read that must refuse, never queue.
 *
 * A guild missing from the cache (not READY, or left) throws with the shared
 * refusal message — the tool layer turns every port throw into that same
 * refusal, so absence reads as "not yours", never as an error and never as
 * an empty list. A fault leaves one allowlisted-fields error line via
 * `loggedCall` above, never a member name (rule 4).
 */
export const guildPortFor = (client: Client, deps: HttpDeps): McpGuildPort => {
  const requireGuild = (guildId: GuildId): Guild => {
    const guild = client.guilds.cache.get(guildId);
    if (guild === undefined) throw new Error(GUILD_REFUSAL_MESSAGE);
    return guild;
  };
  return {
    listChannels: (guildId) =>
      loggedCall(deps.logger, 'listChannels', () => {
        const guild = requireGuild(guildId);
        const enabled = new Set(
          archiveRepo
            .listChannels(deps.scopes.forGuild(guildId))
            .map((channel) => channel.channelId),
        );
        const names = new Map(
          [...guild.channels.cache.values()].map((channel) => [channel.id, channel.name] as const),
        );
        return (
          [...guild.channels.cache.values()]
            // Threads are transient conversations, not channels: an operator
            // asking "what channels exist" means the room list, and a thread
            // that archived away would otherwise flicker in and out of answers.
            .filter((channel) => !channel.isThread())
            .map((channel) => {
              const parentId =
                'parentId' in channel && typeof channel.parentId === 'string'
                  ? channel.parentId
                  : undefined;
              const topic =
                'topic' in channel && typeof channel.topic === 'string' ? channel.topic : undefined;
              return {
                id: channel.id,
                name: channel.name,
                type: ChannelType[channel.type] ?? `unknown(${String(channel.type)})`,
                parentId,
                parentName: parentId === undefined ? undefined : names.get(parentId),
                topic,
                archiveEnabled: enabled.has(channel.id),
              };
            })
            .sort((a, b) => {
              const positionOf = (id: string): number => {
                const channel = guild.channels.cache.get(id);
                if (channel === undefined) return 0;
                return 'position' in channel && typeof channel.position === 'number'
                  ? channel.position
                  : 0;
              };
              return positionOf(a.id) - positionOf(b.id) || (a.id < b.id ? -1 : 1);
            })
        );
      }),
    listRoles: (guildId) =>
      loggedCall(deps.logger, 'listRoles', () => {
        const guild = requireGuild(guildId);
        const scope = deps.scopes.forGuild(guildId);
        return (
          [...guild.roles.cache.values()]
            // `@everyone` is the guild itself wearing a role id: every member
            // holds it, so listing it answers nothing and a managed flag on it
            // is meaningless. The port drops it; the tool says so in its header.
            .filter((role) => role.id !== guild.id)
            .map((role) => ({
              id: role.id,
              name: role.name,
              position: role.position,
              color: role.color,
              managedByBananasaurs: roleRepo.isAllowlisted(scope, role.id),
            }))
            .sort((a, b) => b.position - a.position || (a.id < b.id ? -1 : 1))
        );
      }),
    listMembers: async (guildId, input) =>
      loggedCallAsync(deps.logger, 'listMembers', async () => {
        const guild = requireGuild(guildId);
        const page = await guild.members.list({
          limit: input.limit,
          ...(input.after !== undefined ? { after: input.after } : {}),
          // Not a cache read (ruling M4-D10): paginated REST, and `false` so
          // the listing does not churn the 50-entry member cache either.
          cache: false,
        });
        const members = [...page.values()].map((member) => ({
          id: member.id,
          username: member.user.username,
          displayName: member.displayName,
          // `GuildMemberRoleManager.cache` unconditionally inserts the
          // guild-id (@everyone) role before walking `_roles`
          // (`cache.set(this.guild.id, this.guild.roles.everyone)` in
          // `node_modules/discord.js/src/managers/GuildMemberRoleManager.js`),
          // so the raw key set always contains the guild id — which
          // `list_roles` deliberately hides. Dropped here to match that rule,
          // so an operator never sees a role id on a member that appears
          // nowhere in `list_roles` and has no name anywhere in the toolset.
          roleIds: [...member.roles.cache.keys()].filter((id) => id !== guildId).sort(),
          // Projected field by field: no presence, no activity, no status —
          // there is nowhere for such a field to hide because each field is
          // named here rather than spread from the discord.js object.
          joinedAt: member.joinedAt?.getTime(),
        }));
        const last = members[members.length - 1];
        return { members, nextCursor: last === undefined ? undefined : last.id };
      }),
    // The gateway scalar, not the cache size (ruling M4-D10): the 50-entry
    // `GuildMemberManager` cap makes `members.cache.size` silently wrong on
    // any guild over 50 members, while `memberCount` is what the gateway
    // keeps accurate. The overview card reads this; nothing here counts a
    // listing. A guild missing from the cache throws the shared refusal, the
    // same as every other method here.
    memberCount: (guildId) =>
      loggedCall(deps.logger, 'memberCount', () => requireGuild(guildId).memberCount),
  };
};

/**
 * The `McpRecordsPort` behind the four records tools and the overview
 * resource, field by field like `healthPortFor` above. Each method turns the
 * already-resolved `GuildId` into a `GuildScope` per call and reads through
 * the moderation and audit repositories — nothing here writes, and M4 is
 * read-only. Reader calls only: the repositories' state-changing functions
 * are never referenced here, let alone called (ruling M4-D14). A fault
 * leaves one allowlisted-fields error line via `loggedCall` above, never a
 * snippet, a reason or a payload (rule 4).
 */
const recordsPortFor = (deps: HttpDeps): McpRecordsPort => ({
  listRecentCases: (guildId, input) =>
    loggedCall(deps.logger, 'listRecentCases', () =>
      automodAdminRepo
        .listRecentCases(deps.scopes.forGuild(guildId), { limit: input.limit })
        .map((row) => ({
          caseId: row.caseId,
          memberId: row.memberId,
          openedAt: row.openedAt,
          violationCount: row.violationCount,
          escalationTier: row.escalationTier,
          status: row.status,
        })),
    ),
  findCase: (guildId, caseId) =>
    loggedCall(deps.logger, 'findCase', () => {
      const found = automodAdminRepo.findCase(deps.scopes.forGuild(guildId), caseId);
      if (found === undefined) return undefined;
      return {
        caseId: found.caseId,
        memberId: found.memberId,
        openedAt: found.openedAt,
        violationCount: found.violationCount,
        escalationTier: found.escalationTier,
        status: found.status,
      };
    }),
  listCaseEvents: (guildId, caseId) =>
    loggedCall(deps.logger, 'listCaseEvents', () =>
      modCaseRepo.listCaseEvents(deps.scopes.forGuild(guildId), caseId).map((event) => ({
        eventId: event.eventId,
        ruleId: event.ruleId,
        memberId: event.memberId,
        at: event.at,
        matchedCategory: event.matchedCategory,
        matchedSnippet: event.matchedSnippet,
        actionTaken: event.actionTaken,
        escalationAction: event.escalationAction,
        refusalReason: event.refusalReason,
        actorId: event.actorId,
      })),
    ),
  tailAudit: (guildId, input) =>
    loggedCall(deps.logger, 'tailAudit', () =>
      effectRepo
        .tailAudit(deps.scopes.forGuild(guildId), {
          limit: input.limit,
          ...(input.sinceMs !== undefined ? { sinceMs: input.sinceMs } : {}),
        })
        .map((row) => ({
          auditId: row.auditId,
          at: row.at,
          actorType: row.actorType,
          actorId: row.actorId,
          actorUnixUserClaimed: row.actorUnixUserClaimed,
          via: row.via,
          action: row.action,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          batchId: row.batchId,
          before: row.before,
          after: row.after,
          // The columns are SQLite integers; the port speaks booleans, so the
          // conversion happens once here rather than in every renderer.
          dryRun: row.dryRun === 1,
          inferred: row.inferred === 1,
        })),
    ),
  // Reading `mod_rules`, not touching it: the counts the card renders come
  // from this read, and no writer is referenced here (ruling M4-D14).
  listRules: (guildId) =>
    loggedCall(deps.logger, 'listRules', () =>
      automodAdminRepo.listRules(deps.scopes.forGuild(guildId)).map((rule) => ({
        ruleId: rule.ruleId,
        name: rule.name,
        mode: rule.mode,
        enabled: rule.enabled,
      })),
    ),
  listPanels: (guildId) =>
    loggedCall(deps.logger, 'listPanels', () =>
      panelRepo.listPanels(deps.scopes.forGuild(guildId)).map((panel) => ({
        panelId: panel.panelId,
      })),
    ),
});

/** Hop-by-hop headers that must not survive the Fastify → Web conversion. */
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
]);

/**
 * Rebuilds the request as a Web-standard `Request` for the transport's
 * `handleRequest`. Method, path, query and headers pass through; the body is
 * re-serialised from what Fastify already parsed (`createServer` parses JSON
 * before handlers run), and handed to the transport as `parsedBody` as well,
 * so the transport never re-parses bytes that disagree with what the route
 * saw.
 */
const toWebRequest = (request: FastifyRequest): Request => {
  const host = typeof request.headers.host === 'string' ? request.headers.host : 'localhost';
  const url = `${request.protocol}://${host}${request.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }
  const body = request.body;
  if (
    body === undefined ||
    body === null ||
    request.method === 'GET' ||
    request.method === 'HEAD'
  ) {
    return new Request(url, { method: request.method, headers });
  }
  const raw = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request(url, { method: request.method, headers, body: raw });
};

/**
 * Streams the transport's Web-standard `Response` back through the Fastify
 * reply: status, headers, then the body as a stream rather than a buffered
 * whole, so an SSE response starts flowing before the transport is done.
 * `set-cookie` is forwarded via `getSetCookie` because iterating `headers`
 * would join the values with a comma, which cookies do not survive.
 */
const sendWebResponse = (reply: FastifyReply, response: Response): FastifyReply => {
  void reply.status(response.status);
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') void reply.header(key, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) void reply.header('set-cookie', cookies);
  if (response.body === null) return reply.send();
  return reply.send(Readable.fromWeb(response.body));
};

export const registerMcpRoutes = (
  app: FastifyInstance,
  deps: HttpDeps,
  /** Required (ruling M4-D12): an optional client would serve three tools that silently always refuse. */
  client: Client,
): void => {
  app.all(MCP_ROUTE_PATH, async (request, reply) => {
    // The opt-in, in the shape of `registerOAuthRoutes`' early return
    // (ruling PR-116): without a public origin there is nothing truthful to
    // serve, so a daemon that has not opted in answers 404 with no MCP
    // surface at all — no bearer processing, no transport, no tools. The
    // check lives in the handler rather than at registration because the
    // static-asset fallback would otherwise answer the SPA shell with a 200
    // on this path (`/mcp` is not one of its JSON-404 prefixes, and that file
    // is out of scope for this task); the observable behaviour is identical
    // to OAuth's — 404 JSON, nothing served.
    const publicUrl = deps.mcpPublicUrl;
    if (publicUrl === undefined) return reply.status(404).send({ error: 'not-found' });

    const principal = requireBearer(
      {
        scopes: deps.scopes,
        now: deps.now,
        guildIds: deps.guildIds,
        logger: deps.logger,
        mcpPublicUrl: publicUrl,
      },
      request,
      reply,
    );
    if (principal === undefined) return reply;

    /**
     * Session mode: stateless — `sessionIdGenerator` omitted, so the
     * transport mints no session id and keeps no session map. One server and
     * one transport are built per request and closed when the reply finishes;
     * there is nothing shared across requests and therefore nothing whose
     * cleanup could be missed and leak.
     *
     * Stateful was the alternative: one transport per MCP session id held in
     * a map, cleaned up on `onsessionclosed`. That buys resumability and
     * server-initiated notifications across requests — neither of which a
     * single operator polling `get_health` needs — at the price of a map that
     * leaks a transport per abandoned session if any close path is missed.
     * Stateless costs the reverse: no resumability, no cross-request
     * notifications, and one `McpServer` construction (a single tool
     * registration) per request. For one operator and one read tool, that is
     * the right trade.
     */
    const server = createMcpServer({
      principal,
      health: healthPortFor(principal, deps),
      archive: archivePortFor(deps),
      guild: guildPortFor(client, deps),
      records: recordsPortFor(deps),
    });
    const transport = new WebStandardStreamableHTTPServerTransport();
    // `server.close()` closes the transport too (`Protocol.close`), so one
    // hook covers both. `close` on the raw reply fires after the streamed
    // body is done — closing earlier would truncate the SSE stream.
    reply.raw.on('close', () => {
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(
        toWebRequest(request),
        request.body === undefined ? undefined : { parsedBody: request.body },
      );
      return sendWebResponse(reply, response);
    } catch (err) {
      // Allowlisted fields only (CLAUDE.md rule 4): the failure and where it
      // happened. Never a token, a session id, or the request itself.
      deps.logger.error(
        safeLogFields({
          component: 'mcp',
          err: err instanceof Error ? err.message : 'mcp request failed',
        }),
        'mcp request failed',
      );
      return reply.status(500).send({ error: 'internal' });
    }
  });
};
