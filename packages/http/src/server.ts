import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from '@bananasaurs/core';
import {
  authenticate,
  bootstrap,
  bootstrapIsArmed,
  login,
  logout,
  reauthenticate,
  reauthIsFresh,
  type AuthDeps,
  type SessionContext,
} from './auth.js';
import { bootstrapBodySchema, loginBodySchema, reauthBodySchema, POLICY } from './policy.js';
import { secretsMatch } from './secrets.js';

/**
 * The dashboard API.
 *
 * Bound to `127.0.0.1` and served by the daemon that already holds the database
 * (ADR 0006 — one process, no second service). This file moves bytes and maps
 * outcomes onto status codes; every decision it makes about identity comes from
 * `auth.ts`, which knows nothing about Fastify.
 *
 * **The bind address is not configurable, and that is deliberate.** `docs/19`
 * §6.10: reaching this from anywhere but the box is `ssh -L 8787:127.0.0.1:8787`
 * or Tailscale, and "the dashboard doesn't load" has a fix that is not changing
 * the bind. A `BANANASAURS_HTTP_BIND` variable would exist mainly so that
 * someone could set it to `0.0.0.0` at 2am, which puts a password form holding
 * the kill switch on the LAN.
 */

/** The cookie name. Short, and not obviously ours in a screenshot. */
export const SESSION_COOKIE = 'bs_session';
export const CSRF_HEADER = 'x-bananasaurs-csrf';

export interface HttpDeps extends AuthDeps {
  readonly logger: Logger;
  /** `BANANASAURS_READONLY`. Decides whether `/bootstrap` is even armed. */
  readonly readonly: boolean;
}

/**
 * Recognises storage's readonly refusal.
 *
 * Matches on `name` rather than with `instanceof`, the same way
 * `ops/dispatch.ts` does. `packages/http` *may* import `@bananasaurs/storage`,
 * so `instanceof` would compile here — but a second way of recognising the same
 * error is a second thing to keep in step, and `ReadonlyError` sets
 * `override readonly name` precisely so one match works everywhere.
 */
const isReadonlyRefusal = (err: unknown): boolean =>
  err instanceof Error && err.name === 'ReadonlyError';

/**
 * The status a readonly refusal becomes (ADR 0029).
 *
 * `503`, not `403`: the request was well-formed and the caller was not denied
 * permission — the server is in a mode where it cannot do this. A `403` would
 * send an operator looking for a missing capability grant that is not missing.
 */
const READONLY_STATUS = 503;
const READONLY_BODY = {
  error: 'read-only',
  message:
    'This instance is running with BANANASAURS_READONLY set, so it cannot write. ' +
    'Logging in creates a session row and counts failed attempts, so it is ' +
    'unavailable in this mode. Use the operator CLI over SSH, which is read-only ' +
    'clean, or restart without BANANASAURS_READONLY.',
} as const;

const setSessionCookie = (reply: FastifyReply, token: string, expiresAt: number, now: number) => {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt - now) / 1000));
  // `Secure` is deliberately absent (ADR 0029): the server is loopback-bound and
  // both documented remote paths deliver it as plain http on localhost, so a
  // Secure cookie would never be stored and the login would appear to succeed
  // and then bounce.
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${String(maxAgeSeconds)}`,
  );
};

const clearSessionCookie = (reply: FastifyReply) => {
  reply.header('set-cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
};

/**
 * Reads one cookie without a cookie-parsing dependency.
 *
 * The dashboard sets exactly one cookie and it is base64url, so the general
 * case — quoted values, attributes, encoding — does not arise. A parser would
 * be a dependency to justify for a `split(';')`.
 */
const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
};

/** The client address, for the session row. Never used for authorization. */
const ipOf = (request: FastifyRequest): string | null => request.ip || null;

/**
 * Third layer of the CSRF defence (ADR 0029): when a request declares an
 * `Origin`, its host must be the host the request was addressed to.
 *
 * An equality check rather than an allowlist, so it works unchanged for
 * `127.0.0.1`, `localhost`, and a Tailscale name, none of which is known at
 * build time. A request with no `Origin` is not rejected — non-browser clients
 * omit it entirely, and the token check below is the control that does not
 * depend on the browser's cooperation.
 */
const originMatchesHost = (request: FastifyRequest): boolean => {
  const origin = request.headers.origin;
  if (origin === undefined || origin === 'null') return true;
  const host = request.headers.host;
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
};

export interface AuthenticatedRequest {
  readonly session: SessionContext;
}

export interface CreateServerOptions {
  readonly deps: HttpDeps;
  /**
   * Registers the read and write endpoints the dashboard page needs.
   *
   * A parameter rather than a call inside this file, so that everything in
   * *this* module is the security core and can be reviewed as one thing. The
   * hook hands over the guard the routes must go through; a route that reaches
   * `request` directly instead has no session and no CSRF check, which is
   * visible in its signature.
   */
  readonly registerRoutes?: (app: FastifyInstance, guard: RouteGuard) => void;
}

/**
 * What a route needs in order to be reached safely.
 *
 * Passed to `registerRoutes` rather than exported as free functions, so a route
 * module cannot be written without one — the thing it needs to do its job is
 * the thing that performs the checks.
 */
export interface RouteGuard {
  /**
   * Authenticates, and for a state-changing method also enforces CSRF.
   *
   * Returns `undefined` when it has already answered the request, so a handler
   * that forgets to return early produces no body rather than an unauthorized
   * one — and a handler that uses the result at all has been through both
   * checks.
   */
  require(request: FastifyRequest, reply: FastifyReply): SessionContext | undefined;
  /**
   * The same, plus a recent password entry (ADR 0029).
   *
   * For **disabling** the kill switch, changing a password, and deleting an
   * account. Not for enabling the kill switch: the control that stops the bot
   * must never be harder to reach than the one that starts it.
   */
  requireFresh(request: FastifyRequest, reply: FastifyReply): SessionContext | undefined;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createServer(options: CreateServerOptions): FastifyInstance {
  const { deps } = options;
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  // No CORS headers are sent, ever, and that is a security property rather than
  // an omission: it is what stops a cross-origin page reading the body of
  // `GET /api/session` and learning the CSRF token.

  app.setErrorHandler((err, _request, reply) => {
    if (isReadonlyRefusal(err)) {
      void reply.status(READONLY_STATUS).send(READONLY_BODY);
      return;
    }
    // The message only, never the error object: a thrown value could carry a
    // bound parameter or a row, and pino's redaction is an allowlist over
    // known field names rather than a filter over arbitrary nesting.
    const message = err instanceof Error ? err.message : 'a non-Error was thrown';
    deps.logger.error({ component: 'http', err: message }, 'request failed');
    void reply.status(500).send({ error: 'internal' });
  });

  const sessionFor = (request: FastifyRequest): SessionContext | undefined => {
    const raw = readCookie(request.headers.cookie, SESSION_COOKIE);
    const result = authenticate(deps, raw);
    return result.ok ? result.session : undefined;
  };

  const csrfOk = (request: FastifyRequest, session: SessionContext): boolean => {
    if (!originMatchesHost(request)) return false;
    const header = request.headers[CSRF_HEADER];
    if (typeof header !== 'string') return false;
    return secretsMatch(header, session.csrfToken);
  };

  const guard: RouteGuard = {
    require(request, reply) {
      const session = sessionFor(request);
      if (session === undefined) {
        // The cookie is cleared on every rejection, so a revoked or expired
        // session stops being re-sent on every subsequent request.
        clearSessionCookie(reply);
        void reply.status(401).send({ error: 'unauthenticated' });
        return undefined;
      }
      // Keyed on the method rather than on each route remembering. A route
      // added later that POSTs is CSRF-checked because it POSTs, not because
      // its author thought about it.
      if (WRITE_METHODS.has(request.method) && !csrfOk(request, session)) {
        void reply.status(403).send({ error: 'csrf' });
        return undefined;
      }
      return session;
    },
    requireFresh(request, reply) {
      const session = guard.require(request, reply);
      if (session === undefined) return undefined;
      if (!reauthIsFresh(session, deps.now())) {
        void reply.status(401).send({ error: 'reauth-required' });
        return undefined;
      }
      return session;
    },
  };

  // --- unauthenticated -------------------------------------------------------

  /**
   * Whether anyone is logged in, and the CSRF token if so.
   *
   * The only route that hands out a CSRF token, and it can only hand out the
   * one belonging to the caller's own session — it is derived from the cookie
   * the caller already sent. A cross-origin page can cause this request but
   * cannot read the answer.
   */
  app.get('/api/session', (request, reply) => {
    const raw = readCookie(request.headers.cookie, SESSION_COOKIE);
    const result = authenticate(deps, raw);
    if (!result.ok) {
      return reply.status(200).send({ authenticated: false, reason: result.reason });
    }
    return reply.status(200).send({
      authenticated: true,
      accountId: result.session.accountId,
      guildId: result.session.guildId,
      csrfToken: result.session.csrfToken,
      expiresAt: result.session.expiresAt,
      reauthFresh: reauthIsFresh(result.session, deps.now()),
      readonly: deps.readonly,
    });
  });

  app.post('/api/login', async (request, reply) => {
    if (deps.readonly) return reply.status(READONLY_STATUS).send(READONLY_BODY);

    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    const result = await login(deps, { ...parsed.data, ip: ipOf(request) });
    if (!result.ok) {
      // One status and one body for every credential failure. `locked-out` is
      // named because telling someone their account is locked is useful and
      // reveals nothing they could not learn by waiting; the wrong-username and
      // wrong-password cases stay indistinguishable.
      const status = result.reason === 'locked-out' ? 429 : 401;
      return reply.status(status).send({ error: result.reason });
    }

    setSessionCookie(reply, result.token, result.expiresAt, deps.now());
    return reply.status(200).send({
      accountId: result.accountId,
      guildId: result.guildId,
      csrfToken: result.csrfToken,
      expiresAt: result.expiresAt,
    });
  });

  // --- authenticated ---------------------------------------------------------

  app.post('/api/logout', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    logout(deps, session);
    clearSessionCookie(reply);
    return reply.status(200).send({ ok: true });
  });

  app.post('/api/reauth', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;

    const parsed = reauthBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    const ok = await reauthenticate(deps, session, parsed.data.password);
    if (!ok) return reply.status(401).send({ error: 'invalid-credentials' });
    return reply.status(200).send({ ok: true, windowMs: POLICY.reauthWindowMs });
  });

  // --- the first-account bootstrap (docs/19 §6.10 step 2) --------------------

  /**
   * **Registered only when the account table is empty and an unconsumed token
   * exists.** Otherwise the route does not exist, so the answer is a 404 from
   * Fastify's own router rather than a 403 from a handler — its absence leaks
   * nothing about whether this instance has been set up.
   *
   * A registration-time decision, not a guard inside a handler, because a
   * handler that returns 404 still exists, still parses a body, and is one
   * refactor away from someone deciding the check is redundant.
   *
   * This is read once, at construction. Re-arming after `bananasaurs bootstrap
   * reissue` requires a restart, which the command says.
   */
  if (bootstrapIsArmed(deps)) {
    app.post('/api/bootstrap', async (request, reply) => {
      const parsed = bootstrapBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'bad-request', issues: parsed.error.issues.map((i) => i.message) });
      }

      const result = await bootstrap(deps, { ...parsed.data, ip: ipOf(request) });
      if (!result.ok) return reply.status(400).send({ error: result.reason });

      setSessionCookie(reply, result.token, result.expiresAt, deps.now());
      return reply.status(200).send({
        accountId: result.accountId,
        guildId: result.guildId,
        csrfToken: result.csrfToken,
      });
    });
  }

  options.registerRoutes?.(app, guard);

  return app;
}
