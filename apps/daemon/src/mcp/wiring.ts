import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { safeLogFields } from '@bananasaurs/core';
import { requireBearer, type HttpDeps } from '@bananasaurs/http';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  createMcpServer,
  type McpGuildHealth,
  type McpHealthPort,
  type McpPrincipal,
} from '@bananasaurs/mcp';

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
    gateway: { connected: gateway.connected, pingMs: gateway.pingMs, guildCount: gateway.guildCount },
    now: deps.now,
    guilds,
  };
};

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
  if (body === undefined || body === null || request.method === 'GET' || request.method === 'HEAD') {
    return new Request(url, { method: request.method, headers });
  }
  const raw =
    typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
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

export const registerMcpRoutes = (app: FastifyInstance, deps: HttpDeps): void => {
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
    const server = createMcpServer({ principal, health: healthPortFor(principal, deps) });
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
