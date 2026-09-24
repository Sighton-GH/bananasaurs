import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger, OpsInstance, OpsPorts } from '@bananasaurs/core';
import { parseGuildId } from '@bananasaurs/core';
import { accountRepo, sessionRepo, type GuildScope } from '@bananasaurs/storage';
import {
  authenticate,
  bootstrap,
  bootstrapIsArmed,
  listGuildChoices,
  login,
  logout,
  reauthenticate,
  reauthIsFresh,
  type AuthDeps,
  type SessionContext,
} from './auth.js';
import {
  bootstrapBodySchema,
  loginBodySchema,
  reauthBodySchema,
  sessionGuildBodySchema,
  POLICY,
} from './policy.js';
import { dashboardAuditBase } from './routes/audit-base.js';
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

/**
 * What the dashboard may know about the AI provider configuration (ADR 0058,
 * ADR 0061). Never the key: only whether one is stored and whether it opens.
 */
export interface AssistantProviderStatus {
  readonly provider: string;
  readonly model?: string;
  readonly enabled: boolean;
  readonly modelConfigured: boolean;
  readonly keyConfigured: boolean;
  readonly keyReadable: boolean;
  readonly costClass: 'free' | 'paid' | 'unknown';
  /** Where the key-encryption secret came from; `missing` means keys cannot be saved here. */
  readonly secretSource: 'env' | 'file' | 'missing';
  readonly secretProblem?: 'key-file-permissions' | 'key-file-invalid' | 'readonly-no-key-file';
  /** ADR 0068: up to two more models, tried in order when the one before is busy. */
  readonly fallbackModels?: readonly string[];
  /** ADR 0066. Absent while no Brave key is saved and search is off. */
  readonly webSearch?: { readonly keyConfigured: boolean; readonly enabled: boolean };
}

export interface HttpDeps extends AuthDeps {
  readonly logger: Logger;
  /** `BANANASAURS_READONLY`. Decides whether `/bootstrap` is even armed. */
  readonly readonly: boolean;
  /**
   * ADR 0045 (ruling PR-116): the public origin the OAuth metadata documents
   * advertise. `undefined` when the operator has not set `MCP_PUBLIC_URL` —
   * the OAuth routes are then not mounted at all. Optional (rather than
   * `string | undefined` required) so the existing dashboard route tests,
   * which build `HttpDeps` literals directly, keep compiling untouched.
   */
  readonly mcpPublicUrl?: string | undefined;
  /**
   * One `OpsPorts` per guild, supplied by the composition root.
   *
   * `packages/http` cannot import `apps/daemon` (ADR 0014), and building an
   * `OpsPorts` needs the daemon's per-guild `GuildOperations` — so the daemon
   * builds the closure and hands over only the function, keyed by the scope a
   * route already has from `session.scope`. A route that reached for a guild id
   * of its own to look one up would have a second, uncontrolled way to select a
   * scope; taking the whole `GuildScope` keeps there being exactly one.
   */
  readonly portsFor: (scope: GuildScope) => OpsPorts;
  readonly instance: OpsInstance;
  /**
   * The provider state when no dashboard key store exists (secret missing):
   * derived from env by the daemon. Absent in isolated route tests.
   */
  readonly assistantAiStatus?: AssistantProviderStatus | undefined;
  readonly assistantProviderConfig?:
    | {
        status(): AssistantProviderStatus;
        save(
          input: {
            provider: 'off' | 'gemini' | 'openrouter' | 'nvidia-nim';
            model?: string | undefined;
            apiKey?: string | undefined;
            enabled: boolean;
            costClass?: 'free' | 'paid' | 'unknown' | undefined;
            fallbackModels?: readonly string[] | undefined;
            searchApiKey?: string | undefined;
            searchEnabled?: boolean | undefined;
          },
          now: number,
        ): void;
        /** ADR 0068: models the pasted or saved key can use. Absent in older wiring. */
        listModels?(
          provider: string,
          apiKey?: string,
        ): Promise<readonly { id: string; name: string; description?: string }[]>;
      }
    | undefined;
  /** Live Discord directory, supplied by the daemon; absent in isolated route tests. */
  readonly assistantDirectories?:
    | ((guildId: string) => Promise<{
        roles: readonly { id: string; name: string; position: number }[];
        members: readonly { id: string; name: string }[];
        channels: readonly { id: string; name: string }[];
      }>)
    | undefined;
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

/**
 * Whether the request arrived over HTTPS, read directly from
 * `X-Forwarded-Proto` (M6-D2).
 *
 * `request.protocol` cannot decide it: `trustProxy` is off and stays off
 * (M6-D3 — `routes/oauth.ts:140` already reasons about the rate limiter on
 * that basis), so it is always `http`. Only this one header is read, and
 * nothing authorises on it — it decides one cookie attribute, in the
 * direction that fails safe (see `setSessionCookie`).
 */
const forwardedProtoIsHttps = (request: FastifyRequest): boolean => {
  const proto = request.headers['x-forwarded-proto'];
  const first = Array.isArray(proto) ? proto[0] : proto;
  return first !== undefined && first.trim().toLowerCase() === 'https';
};

const setSessionCookie = (
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
  expiresAt: number,
  now: number,
) => {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt - now) / 1000));
  // `Secure` iff the request arrived over HTTPS (M6-D2, amending ADR 0029):
  // the dashboard is now also published at an HTTPS origin through the
  // tunnel, and a session cookie on a public HTTPS dashboard without `Secure`
  // is basic hygiene missing. A direct loopback client (`ssh -L`, Tailscale)
  // never sends the header, so those paths keep working exactly as before. A
  // client that spoofs it on plain `http://127.0.0.1` gets a `Secure` cookie
  // the browser drops and a login that bounces — a self-inflicted nuisance
  // that widens nothing, which is the direction to fail in.
  const secure = forwardedProtoIsHttps(request) ? ' Secure;' : '';
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${String(maxAgeSeconds)}`,
  );
};

const clearSessionCookie = (request: FastifyRequest, reply: FastifyReply) => {
  // The same rule as the set, or the clear does not match it: a clear without
  // `Secure` does not remove a `Secure` cookie, so a logout over HTTPS would
  // leave the session cookie sitting in the browser.
  const secure = forwardedProtoIsHttps(request) ? ' Secure;' : '';
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=0`,
  );
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
export const originMatchesHost = (request: FastifyRequest): boolean => {
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
  readonly registerRoutes?: (app: FastifyInstance, guard: RouteGuard, deps: HttpDeps) => void;
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
        clearSessionCookie(request, reply);
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
    // S13-D9: the switcher lists only what the account reaches, from the
    // server — never from a client-side list of the allowlist.
    const reachableGuilds = listGuildChoices(deps, result.session.accountId);
    return reply.status(200).send({
      authenticated: true,
      accountId: result.session.accountId,
      guildId: result.session.guildId,
      guildName: reachableGuilds.find((guild) => guild.guildId === result.session.guildId)?.name,
      reachableGuilds,
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
      // S13-D6: the guild list rides on the refusal the server already
      // computed after the password verified — and only there. Every other
      // failure answers exactly as before, with no `choices` key at all.
      if (result.reason === 'guild-required') {
        return reply.status(401).send({ error: result.reason, choices: result.choices });
      }
      // One status and one body for every credential failure. `locked-out` is
      // named because telling someone their account is locked is useful and
      // reveals nothing they could not learn by waiting; the wrong-username and
      // wrong-password cases stay indistinguishable.
      const status = result.reason === 'locked-out' ? 429 : 401;
      return reply.status(status).send({ error: result.reason });
    }

    setSessionCookie(request, reply, result.token, result.expiresAt, deps.now());
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
    clearSessionCookie(request, reply);
    return reply.status(200).send({ ok: true });
  });

  /**
   * Re-scopes the current session to another guild the account can reach
   * (S13-D7/D8/D9). The session row moves partition; no new session is
   * issued, so the CSRF token and the cookie are unchanged and the page does
   * not re-authenticate to move.
   *
   * `requireFresh`-free but capability-free too, deliberately: this changes
   * which guild the operator is *looking at*, and every subsequent write
   * still runs its own capability and freshness checks in the new scope.
   * Authenticated with CSRF, like every other POST, and audited.
   */
  app.post('/api/session/guild', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;

    const parsed = sessionGuildBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    // The target scope is built from the request body but trusted only after
    // `hasGuildAccess` confirms the account reaches it — this route is the one
    // place a session changes partition, so the check is on the target scope,
    // before the write. A malformed id parses to nothing and is refused the
    // same way as an unreachable one: no oracle.
    let target: GuildScope | undefined;
    try {
      target = deps.scopes.forGuild(parseGuildId(parsed.data.guildId));
    } catch {
      target = undefined;
    }
    if (
      target === undefined ||
      !deps.guildIds.includes(parsed.data.guildId) ||
      !accountRepo.hasGuildAccess(target, session.accountId)
    ) {
      return reply.status(403).send({ error: 'no-guild-access' });
    }

    // Already there: a 200 with no write and no audit row. Moving A to A and
    // auditing "from A to A" would be noise, and there is no state change to
    // protect or record.
    if (target.guildId === session.guildId) {
      return reply.status(200).send({ guildId: target.guildId });
    }

    const moved = sessionRepo.setSessionGuild(session.scope, {
      sessionIdHash: session.sessionIdHash,
      accountId: session.accountId,
      guildId: target.guildId,
      now: deps.now(),
    });
    if (!moved) {
      // The row went away between `authenticate` and this write — a concurrent
      // logout or revocation. The session is over, so say so.
      clearSessionCookie(request, reply);
      return reply.status(401).send({ error: 'unauthenticated' });
    }

    // Audited in the guild the session now lives in, naming both ends.
    deps.portsFor(target).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'session.guild_switched',
      subjectType: 'session',
      subjectId: session.accountId,
      before: { guildId: session.guildId },
      after: { guildId: target.guildId },
    });

    return reply.status(200).send({ guildId: target.guildId });
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

      setSessionCookie(request, reply, result.token, result.expiresAt, deps.now());
      return reply.status(200).send({
        accountId: result.accountId,
        guildId: result.guildId,
        csrfToken: result.csrfToken,
      });
    });
  }

  options.registerRoutes?.(app, guard, deps);

  return app;
}
