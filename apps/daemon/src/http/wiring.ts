import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Client } from 'discord.js';
import {
  JOB_KINDS,
  resourceRefreshDedupeKey,
  safeLogFields,
  SafeProvider,
  type Config,
  type DiscordPort,
  type Logger,
  type OpsInstance,
  type OpsPorts,
} from '@bananasaurs/core';
import { jobRepo, type GuildScope, type ScopeFactory } from '@bananasaurs/storage';
import {
  createServer,
  issueBootstrapTokenIfNeeded,
  registerAssistantProviderRoutes,
  registerAssistantSearchKeyRoutes,
  registerAssistantTuningRoutes,
  registerAssistantGithubRoutes,
  registerAssistantRoutes,
  registerAssistantTryRoutes,
  registerAssistantResourceCacheRoutes,
  registerAssistantTraceRoutes,
  registerAssistantConversationRoutes,
  registerAutomodRoutes,
  registerCaseRoutes,
  registerOAuthRoutes,
  registerOpsReadRoutes,
  registerOpsWriteRoutes,
  registerTaskRoutes,
  registerTaskWriteRoutes,
  registerReadRoutes,
  registerWriteRoutes,
  type HttpDeps,
  type TryAssistantDeps,
  type AssistantProviderStatus,
} from '@bananasaurs/http';
import { envProviderStatus } from '../assistant/provider-config.js';
import type { QuotaLedger } from '../assistant/quota-ledger.js';
import type { WebSearchRun } from '../assistant/web-search.js';
import type { ChainEntry } from '../assistant/model-chain.js';
import { createAssistantService } from '../assistant/service.js';
import { memberChannels } from '../assistant/member-channels.js';
import { createGitHubClient } from '../assistant/github-client.js';
import { createGithubFetch, githubGuard } from '../assistant/github-fetch.js';
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
  /** The gateway client, for the MCP guild tools (ruling M4-D12). */
  readonly client: Client;
  /**
   * The Discord REST port, for the MCP send tool (ruling M5-D11).
   *
   * Required for the same reason `client` is: the message gateway behind
   * `send_message` needs the port, not the client, and an optional port
   * would serve a `send_message` that registers and always fails.
   */
  readonly discord: DiscordPort;
  readonly assistantProviderConfig?: HttpDeps['assistantProviderConfig'];
  /** Why there is no provider store, when there is none (ADR 0061 §3). */
  readonly assistantSecretProblem?: AssistantProviderStatus['secretProblem'];
  /** ADR 0080: the owner-edited instance settings (AI tuning). Absent in isolated uses. */
  readonly instanceSettings?: HttpDeps['instanceSettings'];
  /**
   * Task 8: the one process-wide QuotaLedger (`runtime/daemon.ts`), read by
   * the dashboard's allowance pill. Absent in isolated uses, and then no
   * allowance reset is shown.
   */
  readonly assistantQuotaLedger?: QuotaLedger | undefined;
  /** ADR 0120: the web search run for the Try-it panel. Absent in isolated uses. */
  readonly assistantWebSearch?: ((guildId: string) => WebSearchRun | undefined) | undefined;
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
  /**
   * Optional (rather than `string | undefined` required), matching
   * `HttpDeps.mcpPublicUrl`: the same test-literal rationale applies, and the
   * same modifier on both sides is what lets `startDashboardApi` spread its
   * `httpDeps` into `buildDashboardApp` instead of rebuilding the fields.
   */
  readonly mcpPublicUrl?: string | undefined;
  readonly portsFor: (scope: GuildScope) => OpsPorts;
  readonly instance: OpsInstance;
  readonly distDir: string;
  readonly assistantProviderConfig?: HttpDeps['assistantProviderConfig'];
  readonly assistantAiStatus?: HttpDeps['assistantAiStatus'];
  /** ADR 0080: the owner-edited instance settings (AI tuning). Absent in isolated uses. */
  readonly instanceSettings?: HttpDeps['instanceSettings'];
  /**
   * Task 8: the one process-wide QuotaLedger (`runtime/daemon.ts`), read by
   * the dashboard's allowance pill. Absent in isolated uses, and then no
   * allowance reset is shown.
   */
  readonly assistantQuotaLedger?: QuotaLedger | undefined;
  /** ADR 0120: the web search run for the Try-it panel. Absent in isolated uses. */
  readonly assistantWebSearch?: ((guildId: string) => WebSearchRun | undefined) | undefined;
  /** The gateway client, for the MCP guild tools (ruling M4-D12). */
  readonly client: Client;
  /**
   * Task 20: dashboard Try-it, built by `startDashboardApi` around the same
   * assistant service the guild runtime uses. Absent in isolated uses (and
   * in env-only provider mode, which has no key store to run on), and then
   * the try route answers 503.
   */
  readonly tryAssistant?: TryAssistantDeps['tryAssistant'] | undefined;
  /**
   * The Discord REST port, for the MCP send tool (ruling M5-D11).
   *
   * Required for the same reason `client` is: the message gateway behind
   * `send_message` needs the port, not the client, and an optional port
   * would serve a `send_message` that registers and always fails.
   */
  readonly discord: DiscordPort;
}

/**
 * Builds the dashboard Fastify app without listening: the same `createServer`
 * call, the same `registerRoutes` callback and the same static-asset
 * registration production serves. Exported so the MCP wiring test goes
 * through the real composition rather than a copy of it.
 */

interface AssistantDirectoryMember {
  readonly id: string;
  readonly name: string;
}

const ASSISTANT_DIRECTORY_TTL_MS = 5 * 60_000;
const assistantMemberCache = new Map<
  string,
  { readonly expiresAt: number; readonly members: readonly AssistantDirectoryMember[] }
>();

export const listAllAssistantMembers = async (
  guildId: string,
  now: () => number,
  listPage: (after: string | undefined) => Promise<readonly AssistantDirectoryMember[]>,
): Promise<readonly AssistantDirectoryMember[]> => {
  const cached = assistantMemberCache.get(guildId);
  if (cached !== undefined && cached.expiresAt > now()) return cached.members;
  const members: AssistantDirectoryMember[] = [];
  let after: string | undefined;
  do {
    const page = await listPage(after);
    members.push(...page);
    after = page.length === 1_000 ? page[page.length - 1]?.id : undefined;
  } while (after !== undefined);
  assistantMemberCache.set(guildId, {
    expiresAt: now() + ASSISTANT_DIRECTORY_TTL_MS,
    members,
  });
  return members;
};

const assistantDirectoriesFor = async (client: Client, guildId: string, now: () => number) => {
  const guild = client.guilds.cache.get(guildId);
  if (guild === undefined) throw new Error('guild directory unavailable');
  const members = await listAllAssistantMembers(guildId, now, async (after) => {
    const page = await guild.members.list({
      limit: 1_000,
      ...(after === undefined ? {} : { after }),
      cache: false,
    });
    return [...page.values()].map((member) => ({ id: member.id, name: member.displayName }));
  });
  return {
    roles: [...guild.roles.cache.values()]
      .filter((role) => role.id !== guild.id)
      .map((role) => ({ id: role.id, name: role.name, position: role.position })),
    members,
    channels: [...guild.channels.cache.values()]
      .filter((channel) => channel.isTextBased())
      .map((channel) => ({ id: channel.id, name: channel.name })),
  };
};

export const buildDashboardApp = (deps: DashboardAppDeps): FastifyInstance => {
  const quotaLedger = deps.assistantQuotaLedger;
  const httpDeps: HttpDeps & TryAssistantDeps = {
    scopes: deps.scopes,
    now: deps.now,
    guildIds: deps.guildIds,
    logger: deps.logger,
    readonly: deps.readonly,
    portsFor: deps.portsFor,
    instance: deps.instance,
    assistantDirectories: (guildId) => assistantDirectoriesFor(deps.client, guildId, deps.now),
    mcpPublicUrl: deps.mcpPublicUrl,
    // Task 20: the Try-it runner rides along when the composition root
    // built one; the route answers 503 without it.
    ...(deps.tryAssistant === undefined ? {} : { tryAssistant: deps.tryAssistant }),
    // ADR 0073: the enqueue behind the resource save route — the one
    // production implementation of `HttpDeps.enqueueResourceRefresh`, so the
    // route's injected seam and the job's dedupe key cannot disagree.
    enqueueResourceRefresh: (scope, resourceId, reason) => {
      const now = deps.now();
      jobRepo.enqueue(scope, {
        kind: JOB_KINDS.resourceRefresh,
        payload: JSON.stringify({ resourceId, reason }),
        dedupeKey: resourceRefreshDedupeKey({ reason, resourceId }),
        now,
      });
    },
    // Carried through, never rebuilt: the 2026-09-23 audit found this literal
    // hard-coding an 'unknown' status and dropping the store, so every
    // dashboard provider save answered 503 (wiring.provider.test.ts).
    ...(deps.assistantProviderConfig === undefined
      ? {}
      : { assistantProviderConfig: deps.assistantProviderConfig }),
    ...(deps.assistantAiStatus === undefined ? {} : { assistantAiStatus: deps.assistantAiStatus }),
    // ADR 0080: carried through, never rebuilt — the same store the daemon
    // built, so the tuning routes read what the daemon serves.
    ...(deps.instanceSettings === undefined ? {} : { instanceSettings: deps.instanceSettings }),
    // Task 8: the allowance pill reads the single process-wide ledger the
    // composition root handed in — an arrow over the captured instance, never
    // a detached method, so the loop and the pill cannot disagree.
    ...(quotaLedger === undefined
      ? {}
      : {
          assistantAllowanceResetsAt: (keyId: string) =>
            quotaLedger.exhaustedUntil(keyId, deps.now()),
        }),
    // Task 17: the "Add from GitHub" client — pinned to api.github.com (never
    // global `fetch`), reading the sealed token per request for the
    // `Authorization` header only. Absent when there is no provider store to
    // read a token from, and then the GitHub routes answer 503.
    ...(deps.assistantProviderConfig?.githubToken === undefined
      ? {}
      : {
          githubClient: () =>
            createGitHubClient({
              token: () => deps.assistantProviderConfig?.githubToken?.(),
              fetch: createGithubFetch(),
              guard: githubGuard,
            }),
        }),
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
      registerAssistantRoutes(instance, guard, routeDeps);
      // Task 20: `httpDeps`, not `routeDeps` — only the outer literal
      // carries the Try-it runner, which `HttpDeps` itself never mentions.
      registerAssistantTryRoutes(instance, guard, httpDeps);
      registerAssistantProviderRoutes(instance, guard, routeDeps);
      registerAssistantSearchKeyRoutes(instance, guard, routeDeps);
      registerAssistantTuningRoutes(instance, guard, routeDeps);
      registerAssistantGithubRoutes(instance, guard, routeDeps);
      registerAssistantResourceCacheRoutes(instance, guard, routeDeps);
      registerAssistantTraceRoutes(instance, guard, routeDeps);
      registerAssistantConversationRoutes(instance, guard, routeDeps);
      registerOpsReadRoutes(instance, guard, routeDeps);
      registerTaskRoutes(instance, guard, routeDeps);
      registerTaskWriteRoutes(instance, guard, routeDeps);
      registerOpsWriteRoutes(instance, guard, routeDeps);
      registerWriteRoutes(instance, guard, routeDeps);
      registerAutomodRoutes(instance, guard, routeDeps);
      registerCaseRoutes(instance, guard, routeDeps);
      registerOAuthRoutes(instance, guard, routeDeps);
      registerMcpRoutes(instance, routeDeps, deps.client, deps.discord);
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
    assistantDirectories: (guildId) => assistantDirectoriesFor(deps.client, guildId, deps.now),
    mcpPublicUrl: deps.config.MCP_PUBLIC_URL,
    ...(deps.assistantProviderConfig === undefined
      ? {}
      : { assistantProviderConfig: deps.assistantProviderConfig }),
    // ADR 0080: the tuning routes ride along when the composition root
    // handed in a settings store; they answer 503 without it.
    ...(deps.instanceSettings === undefined ? {} : { instanceSettings: deps.instanceSettings }),
    // Only read when there is no store: the env-configured provider, with the
    // reason the dashboard cannot save keys itself.
    assistantAiStatus: {
      ...envProviderStatus(deps.config, 'missing'),
      ...(deps.assistantSecretProblem === undefined
        ? {}
        : { secretProblem: deps.assistantSecretProblem }),
    },
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

  // The eight config-derived fields are the `httpDeps` literal above — spread,
  // not rebuilt — so a ninth field added to one reaches the other: two
  // independent literals with the same values would diverge silently.
  // Task 8: the single process-wide ledger rides along explicitly, so
  // `buildDashboardApp` derives the allowance pill's reset from it.
  // Task 20: dashboard Try-it runs the same assistant pipeline in-process,
  // one service per request over the request's guild scope. The chain comes
  // from the dashboard key store, whose HTTP-declared row type is lossier
  // than what `chain()` really returns — so each row is re-checked here and
  // only a spend-wrapped provider runs; anything else fails closed to a
  // skipped entry. No key store (env-only mode) means no Try-it runner.
  const tryAssistant: TryAssistantDeps['tryAssistant'] =
    deps.assistantProviderConfig === undefined
      ? undefined
      : async (scope, input) => {
          const chain: ChainEntry[] = [];
          for (const row of deps.assistantProviderConfig?.chain?.() ?? []) {
            const providerId = (['gemini', 'openrouter', 'nvidia-nim'] as const).find(
              (id) => id === row.providerId,
            );
            if (providerId === undefined) continue;
            if (row.provider === undefined) {
              const skip = (
                ['no-key', 'key-unreadable', 'disabled', 'ineligible', 'unverified'] as const
              ).find((reason) => reason === row.skip);
              chain.push({
                providerId,
                model: row.model,
                keyId: row.keyId,
                keyLabel: row.keyLabel,
                provider: undefined,
                ...(skip === undefined ? {} : { skip }),
                mayTrain: row.mayTrain,
                rpmLimit: row.rpmLimit,
                rpdLimit: row.rpdLimit,
              });
              continue;
            }
            if (!(row.provider instanceof SafeProvider)) continue;
            chain.push({
              providerId,
              model: row.model,
              keyId: row.keyId,
              keyLabel: row.keyLabel,
              provider: row.provider,
              mayTrain: row.mayTrain,
              rpmLimit: row.rpmLimit,
              rpdLimit: row.rpdLimit,
            });
          }
          const service = createAssistantService(
            scope,
            deps.scopes.instance(),
            deps.config,
            deps.now,
            {},
            () => deps.config,
            deps.logger,
            {
              memberChannels: (userId) => {
                const guild = deps.client.guilds.cache.get(scope.guildId);
                return memberChannels(
                  guild === undefined
                    ? undefined
                    : {
                        channels: guild.channels,
                        members: {
                          fetch: async (id: string) => {
                            const member = await guild.members.fetch(id);
                            return {
                              permissionsIn: (channel: { readonly id: string }) =>
                                member.permissionsIn(channel.id),
                            };
                          },
                        },
                      },
                  userId,
                );
              },
            },
            () => chain,
            deps.assistantQuotaLedger,
            undefined,
            undefined,
            deps.assistantWebSearch,
          );
          return service.tryIt(input);
        };
  const app = buildDashboardApp({
    ...httpDeps,
    distDir: DASHBOARD_DIST,
    client: deps.client,
    discord: deps.discord,
    ...(deps.assistantQuotaLedger === undefined
      ? {}
      : { assistantQuotaLedger: deps.assistantQuotaLedger }),
    ...(deps.assistantWebSearch === undefined
      ? {}
      : { assistantWebSearch: deps.assistantWebSearch }),
    ...(tryAssistant === undefined ? {} : { tryAssistant }),
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
