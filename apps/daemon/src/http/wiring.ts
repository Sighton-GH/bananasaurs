import process from 'node:process';
import { fileURLToPath } from 'node:url';
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
  registerAutomodRoutes,
  registerCaseRoutes,
  registerOAuthRoutes,
  registerReadRoutes,
  registerWriteRoutes,
  type HttpDeps,
} from '@bananasaurs/http';
import { registerMcpRoutes } from '../mcp/wiring.js';
import { registerStaticAssets } from './static.js';

/**
 * `packages/dashboard/dist`, resolved relative to this module's own URL
 * rather than `process.cwd()` — the same convention `packages/storage/src/
 * test-support.ts` uses for the migrations folder — so it resolves correctly
 * whether this file is running from `src/` (`npm run dev`) or from
 * `dist/` after `tsc --build` (`npm start`); both sit at the same depth
 * under the repo root.
 */
const DASHBOARD_DIST = fileURLToPath(
  new URL('../../../../packages/dashboard/dist', import.meta.url),
);

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
 * Everything `buildDashboardApp` needs: the `HttpDeps` fields plus the
 * dashboard `dist` directory. A separate interface rather than
 * `DashboardApiDeps` so tests can build the app without a full `Config` —
 * and so the `distDir` under test is a fixture directory, which is what lets
 * the MCP opt-in test prove the SPA fallback was registered (ruling PR-130).
 */
export interface DashboardAppDeps {
  readonly scopes: ScopeFactory;
  readonly logger: Logger;
  readonly now: () => number;
  readonly guildIds: readonly string[];
  readonly readonly: boolean;
  readonly mcpPublicUrl: string | undefined;
  readonly portsFor: (scope: GuildScope) => OpsPorts;
  readonly instance: OpsInstance;
  readonly distDir: string;
}

/**
 * Builds the dashboard Fastify app without listening: the same `createServer`
 * call, the same `registerRoutes` callback and the same static-asset
 * registration production serves. Exported so the MCP wiring test goes
 * through the real composition rather than a copy of it.
 */
export const buildDashboardApp = (deps: DashboardAppDeps): FastifyInstance => {
  const httpDeps: HttpDeps = {
    scopes: deps.scopes,
    now: deps.now,
    guildIds: deps.guildIds,
    logger: deps.logger,
    readonly: deps.readonly,
    portsFor: deps.portsFor,
    instance: deps.instance,
    mcpPublicUrl: deps.mcpPublicUrl,
  };
  const app = createServer({
    deps: httpDeps,
    // One hook, two registrations — `createServer`'s own doc comment on
    // `registerRoutes` says a route module cannot be written without the
    // guard it is handed, so every session-guarded route goes through the
    // same parameter rather than any becoming a second hook. The MCP route
    // below is the exception that proves it: bearer-authenticated, so it
    // takes the deps and not the guard.
    registerRoutes: (instance, guard, routeDeps) => {
      registerReadRoutes(instance, guard, routeDeps);
      registerWriteRoutes(instance, guard, routeDeps);
      registerAutomodRoutes(instance, guard, routeDeps);
      registerCaseRoutes(instance, guard, routeDeps);
      registerOAuthRoutes(instance, guard, routeDeps);
      registerMcpRoutes(instance, routeDeps);
    },
  });
  registerStaticAssets(app, deps.distDir);
  return app;
};

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
    mcpPublicUrl: deps.config.MCP_PUBLIC_URL,
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

  const app = buildDashboardApp({
    scopes: deps.scopes,
    logger: deps.logger,
    now: deps.now,
    guildIds: deps.config.BANANASAURS_GUILD_ALLOWLIST,
    readonly: deps.config.BANANASAURS_READONLY,
    mcpPublicUrl: deps.config.MCP_PUBLIC_URL,
    portsFor: deps.portsFor,
    instance: deps.instance,
    distDir: DASHBOARD_DIST,
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
