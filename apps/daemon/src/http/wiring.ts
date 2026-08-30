import process from 'node:process';
import type { FastifyInstance } from 'fastify';
import {
  safeLogFields,
  type Config,
  type Logger,
  type OpsInstance,
  type OpsPorts,
} from '@bananasaurs/core';
import type { GuildScope, ScopeFactory } from '@bananasaurs/storage';
import {
  createServer,
  issueBootstrapTokenIfNeeded,
  registerReadRoutes,
  registerWriteRoutes,
  type HttpDeps,
} from '@bananasaurs/http';

/**
 * The dashboard API, in the daemon's process (ADR 0006 — one process).
 *
 * It shares the database handle the daemon already holds, which is the whole
 * reason it is not a second service: two processes would be two writers, and
 * single-writer discipline is what the `O_EXCL` lockfile and the socket bind
 * exist to guarantee.
 */

export interface DashboardApiDeps {
  readonly config: Config;
  readonly scopes: ScopeFactory;
  readonly logger: Logger;
  readonly now: () => number;
  /** The daemon's seam into per-guild ports (`apps/daemon/src/runtime/daemon.ts`). */
  readonly portsFor: (scope: GuildScope) => OpsPorts;
  readonly instance: OpsInstance;
}

export interface DashboardApi {
  readonly app: FastifyInstance;
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Prints the first-run setup banner, exactly as `docs/19` §6.10 step 1 spells it.
 *
 * **To stdout, not to the logger.** systemd captures stdout into the journal
 * either way, and this is the one line in the system a human has to read and
 * copy from a terminal — putting it through pino would wrap it in JSON at the
 * moment it most needs to be legible. It is also the one place a token is
 * deliberately printed, which is easier to audit when it is a single
 * `process.stdout.write` rather than a log call among hundreds.
 */
const printBootstrapBanner = (token: string, port: number, ttlMinutes: number): void => {
  process.stdout.write(
    `\n══ Bananasaurs first-run setup ══\n` +
      `Open http://127.0.0.1:${String(port)}/bootstrap?token=${token}\n` +
      `Expires in ${String(ttlMinutes)} minutes. Not shown again; restart to reissue.\n` +
      `\n` +
      `Not on the box? ssh -L ${String(port)}:127.0.0.1:${String(port)} <host>\n\n`,
  );
};

/**
 * Builds and starts the API.
 *
 * The order matters: the bootstrap token is issued **before** `createServer`,
 * because `/bootstrap` is registered at construction and only when a live token
 * exists (`docs/19` §6.10 step 2). Issuing afterwards would arm the token for a
 * server that had already decided the route did not exist — which is precisely
 * the confusion `bootstrap reissue` warns about and tells the operator to fix
 * with a restart.
 */
export async function startDashboardApi(deps: DashboardApiDeps): Promise<DashboardApi> {
  const httpDeps: HttpDeps = {
    scopes: deps.scopes,
    now: deps.now,
    guildIds: deps.config.BANANASAURS_GUILD_ALLOWLIST,
    logger: deps.logger,
    readonly: deps.config.BANANASAURS_READONLY,
    portsFor: deps.portsFor,
    instance: deps.instance,
  };

  // Under BANANASAURS_READONLY this returns undefined rather than throwing.
  // Slice 13d found the daemon could not start read-only; a token generator
  // that writes on boot is the same class of bug, so the refusal is a value
  // here and not an exception the caller has to remember to catch.
  const issued = issueBootstrapTokenIfNeeded(httpDeps, {
    readonly: deps.config.BANANASAURS_READONLY,
  });
  if (issued !== undefined) {
    printBootstrapBanner(
      issued.token,
      deps.config.DASHBOARD_PORT,
      Math.round((issued.expiresAt - deps.now()) / 60_000),
    );
  } else if (deps.config.BANANASAURS_READONLY) {
    deps.logger.warn(
      safeLogFields({ component: 'http' }),
      'read-only mode: no first-run setup token was issued, and dashboard login is unavailable',
    );
  }

  const app = createServer({
    deps: httpDeps,
    // One hook, two registrations — `createServer`'s own doc comment on
    // `registerRoutes` says a route module cannot be written without the
    // guard it is handed, so both calls go through the same parameter rather
    // than either becoming a second hook.
    registerRoutes: (instance, guard, routeDeps) => {
      registerReadRoutes(instance, guard, routeDeps);
      registerWriteRoutes(instance, guard, routeDeps);
    },
  });
  const host = deps.config.DASHBOARD_BIND;
  await app.listen({ host, port: deps.config.DASHBOARD_PORT });

  const url = `http://${host}:${String(deps.config.DASHBOARD_PORT)}`;
  deps.logger.info(
    safeLogFields({ component: 'http', reason: url }),
    'dashboard API listening on loopback',
  );

  return { app, url, close: () => app.close() };
}
