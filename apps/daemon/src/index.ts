import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Events } from 'discord.js';
import {
  ConfigError,
  createLogger,
  parseConfig,
  redactConfig,
  safeLogFields,
  type Config,
  type Logger,
} from '@bananasaurs/core';
import { createDiscordClient } from '@bananasaurs/discord';
import { createDiscordRestPort } from '@bananasaurs/discord/rest';
import { DatabaseLockedError, openDatabase, type OpenedDatabase } from '@bananasaurs/storage';
import { bindOpsSocket, SocketInUseError, type OpsSocketServer } from './ops/socket.js';
import { announceCommands } from './runtime/commands.js';
import { startDashboardApi, type DashboardApi } from './http/wiring.js';
import { resolveProviderSecret } from './assistant/provider-secret.js';
import { createPasswordVault } from './ops/password-vault.js';
import { createDaemon } from './runtime/daemon.js';
import { buildDoctorReport, formatDoctorReport } from './runtime/doctor.js';
import {
  formatPublicSurface,
  probePublicSurface as runPublicSurfaceProbe,
} from './runtime/public-surface.js';

/**
 * The process.
 *
 * Everything that decides anything is elsewhere; this constructs the three
 * things `createDaemon` cannot construct for itself — the database, the client
 * and the REST port — connects, and shuts down cleanly. Keeping it this thin is
 * what makes the composition root testable (ADR 0020).
 */

/** EX_CONFIG. systemd shows it, and it means "do not restart me into this". */
const EXIT_CONFIG = 78;
/** EX_UNAVAILABLE: something the operator has to look at, not a config typo. */
const EXIT_UNAVAILABLE = 69;

function fail(message: string, code: number): never {
  // Deliberately not the logger: a failure before the logger exists must still
  // be legible, and one after it must not be lost in JSON on a first run.
  process.stderr.write(`\nBananasaurs cannot start.\n\n${message}\n\n`);
  process.exit(code);
}

function loadConfig(): Config {
  try {
    return parseConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) fail(`${err.message}\n\nSee .env.example.`, EXIT_CONFIG);
    throw err;
  }
}

/**
 * Refuses an unmigrated database rather than migrating it.
 *
 * A process that migrates on start is a process that can migrate the *wrong*
 * database on start, and `BANANASAURS_DB_PATH` pointing somewhere unintended is
 * exactly the failure the single-writer guards exist for (ADR 0020).
 */
function assertMigrated(opened: OpenedDatabase, dbPath: string): void {
  const table = opened.raw
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'guilds'`)
    .get();
  if (table === undefined) {
    opened.close();
    fail(
      `The database at ${dbPath} has no schema.\n\n  Run: npm run build && npm run db:migrate`,
      EXIT_CONFIG,
    );
    return;
  }

  // A database that is merely *behind* its code used to start successfully and
  // then die at whatever query first touched a table it did not have. That is
  // how a missing `archive_channels` became a 15,000-restart crash loop on the
  // archive expiry timer instead of one legible line at startup, with the bot
  // off Discord for a day. Checking `guilds` proved the database had *a*
  // schema; it never proved the schema matched this build.
  const expected = expectedMigrationCount();
  if (expected === undefined) return;
  const applied = appliedMigrationCount(opened);
  if (applied >= expected) return;

  opened.close();
  fail(
    `The database at ${dbPath} is ${String(expected - applied)} migration(s) behind this build ` +
      `(${String(applied)} applied, ${String(expected)} expected).\n\n` +
      `  Stop the daemon, then run: npm run build && npm run db:migrate`,
    EXIT_CONFIG,
  );
}

/**
 * `drizzle/meta/_journal.json` is the authoritative list of migrations for
 * this build — drizzle-kit writes it, and `runMigrations` applies exactly what
 * it names. Resolved from this module's own URL rather than `process.cwd()`,
 * the convention `DASHBOARD_DIST` already uses, so it works whether the daemon
 * is running from `src/` under `npm run dev` or from `dist/` under systemd:
 * both sit at the same depth under the repo root.
 *
 * `undefined` when the folder is not there to read. A packaging arrangement
 * that ships no migrations folder is not something to refuse to boot over —
 * this check exists to catch a database behind its code, not to require a
 * particular layout.
 */
function expectedMigrationCount(): number | undefined {
  try {
    const journalPath = fileURLToPath(
      new URL('../../../drizzle/meta/_journal.json', import.meta.url),
    );
    const parsed: unknown = JSON.parse(readFileSync(journalPath, 'utf8'));
    const entries = (parsed as { entries?: unknown }).entries;
    return Array.isArray(entries) ? entries.length : undefined;
  } catch {
    return undefined;
  }
}

/** Zero when drizzle's bookkeeping table does not exist yet, which is itself "behind". */
function appliedMigrationCount(opened: OpenedDatabase): number {
  try {
    const row = opened.raw.prepare(`SELECT COUNT(*) AS n FROM __drizzle_migrations`).get() as
      { n?: number } | undefined;
    return typeof row?.n === 'number' ? row.n : 0;
  } catch {
    return 0;
  }
}

function openOrFail(config: Config, log: Logger): OpenedDatabase {
  try {
    const opened = openDatabase({
      dbPath: config.BANANASAURS_DB_PATH,
      socketPath: config.BANANASAURS_SOCKET_PATH,
      readonly: config.BANANASAURS_READONLY,
      onStaleReclaim: (reason) =>
        log.warn(
          safeLogFields({ component: 'startup', reason }),
          'reclaimed a stale database lock',
        ),
    });
    assertMigrated(opened, config.BANANASAURS_DB_PATH);
    return opened;
  } catch (err) {
    if (err instanceof DatabaseLockedError) fail(err.message, EXIT_UNAVAILABLE);
    throw err;
  }
}

/**
 * Binds the admin socket, or refuses to start.
 *
 * `SocketInUseError` is `EXIT_UNAVAILABLE` rather than `EXIT_CONFIG`, matching
 * `DatabaseLockedError`: another instance holding the resource is something an
 * operator has to look at, not a typo systemd should stop restarting into.
 */
async function bindSocketOrFail(config: Config, log: Logger): Promise<OpsSocketServer> {
  try {
    return await bindOpsSocket({ socketPath: config.BANANASAURS_SOCKET_PATH, logger: log });
  } catch (err) {
    if (err instanceof SocketInUseError) fail(err.message, EXIT_UNAVAILABLE);
    throw err;
  }
}

/**
 * `doctor` as a mode: connect, report, exit.
 *
 * `docs/21` exercise 1 step 3 says "Run `doctor`", and the operator CLI that
 * would host it is slice 13. A flag costs nothing, reuses the same asserted
 * client construction, and — crucially — **does not open the database**, so it
 * can be run against a guild while the daemon is running.
 *
 * It has to connect. The whole point of the check is that a privileged intent
 * being *granted* is only observable from a session Discord accepted.
 */
async function runDoctor(config: Config, log: Logger): Promise<never> {
  const client = createDiscordClient(() => client.user?.id);
  client.once(Events.ClientReady, () => {
    void (async () => {
      const report = buildDoctorReport(client, config);
      // Ruling M6-D1, the same probe the `doctor` command runs: the public
      // hostname in both directions, behind `MCP_PUBLIC_URL` and with the
      // global fetch. An exposed dashboard fails the exit code on its own.
      const surface = await runPublicSurfaceProbe({
        publicUrl: config.MCP_PUBLIC_URL,
        fetch: globalThis.fetch,
      });
      process.stdout.write(`${formatDoctorReport(report)}\n${formatPublicSurface(surface)}\n`);
      const ok = report.ok && surface.ok;
      await client.destroy();
      process.exit(ok ? 0 : 1);
    })();
  });

  try {
    await client.login(config.DISCORD_BOT_TOKEN);
  } catch (err) {
    log.error(safeLogFields({ component: 'doctor', err }), 'could not connect to Discord');
    process.exit(EXIT_UNAVAILABLE);
  }
  // The ready handler exits; this keeps the type honest.
  return await new Promise<never>(() => undefined);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({ level: config.BANANASAURS_LOG_LEVEL, env: config.BANANASAURS_ENV });

  log.info(
    safeLogFields({
      env: config.BANANASAURS_ENV,
      dryRun: config.BANANASAURS_DRY_RUN,
      readonly: config.BANANASAURS_READONLY,
      nodeVersion: process.version,
      pid: process.pid,
      count: config.BANANASAURS_GUILD_ALLOWLIST.length,
    }),
    'bananasaurs starting',
  );

  if (config.BANANASAURS_DRY_RUN) {
    log.warn('DRY RUN: every Discord side effect will be logged, not performed');
  }

  // Deliberately NOT through safeLogFields. That allowlist covers camelCase
  // domain fields; config keys are SCREAMING_CASE, so filtering twice drops
  // every key and logs nothing. redactConfig is the right allowlist here: the
  // key set is exactly the Zod schema and the secret ones are already replaced.
  log.debug({ config: redactConfig(config) }, 'effective configuration');

  if (process.argv.includes('--doctor')) await runDoctor(config, log);

  // **Before the database, deliberately.** `docs/19` amendment 1 specifies the
  // single-writer guard as "socket bind plus an O_EXCL PID lockfile", in that
  // order: the bind is what refuses a second daemon on this socket path, and it
  // has to happen before this process opens the database it would be a second
  // writer to. The handler is attached further down, once there is a daemon to
  // handle anything — a request arriving in that window is refused, not queued.
  const opsSocket = await bindSocketOrFail(config, log);

  const opened = openOrFail(config, log);

  // A thunk because `client.user` does not exist until READY, and the port is
  // built before the connection by construction.
  const client = createDiscordClient(() => client.user?.id);
  const discord = createDiscordRestPort({
    // The client's own REST instance. Two would keep separate rate-limit
    // buckets and race each other past Discord's global cap.
    rest: client.rest,
    applicationId: config.DISCORD_APPLICATION_ID,
    botUserId: () => client.user?.id,
    // Free and already correct: GUILD_CREATE carries owner_id and GUILD_UPDATE
    // keeps it current, which saves a fetch per member lookup.
    guildOwnerId: (guildId) => client.guilds.cache.get(guildId)?.ownerId,
  });

  // After the database opens (so the data dir exists) and before the daemon is
  // built. ADR 0061 §3: env wins, else the 0600 key file, created on first run.
  const providerSecret = resolveProviderSecret({
    envSecret: config.ASSISTANT_PROVIDER_SECRET_KEY,
    dataDir: config.BANANASAURS_DATA_DIR,
    readonly: config.BANANASAURS_READONLY,
  });
  if (providerSecret.source === 'missing')
    log.warn(
      safeLogFields({ component: 'assistant', reason: providerSecret.reason }),
      'dashboard provider keys are unavailable: no usable key-encryption secret',
    );

  // ADR 0070: the account password vault, resolved the same way and right
  // beside the provider secret above — env wins, else its own 0600 key file
  // (`account-password.key`, distinct from the provider secret's file),
  // created on first run. Unavailable here just means new passwords are
  // stored as a hash only (no sealed copy) and reveal answers 409 — never a
  // reason to refuse startup.
  const passwordVault = createPasswordVault({
    envSecret: config.ACCOUNT_PASSWORD_SECRET_KEY,
    dataDir: config.BANANASAURS_DATA_DIR,
    readonly: config.BANANASAURS_READONLY,
  });
  if (!passwordVault.available)
    log.warn(
      safeLogFields({ component: 'accounts' }),
      'the account password vault is unavailable: new account passwords will not be revealable',
    );

  let shuttingDown = false;
  const daemon = createDaemon({
    config,
    scopes: opened.scopes,
    discord,
    client,
    logger: log,
    raw: opened.raw,
    now: () => Date.now(),
    providerSecret,
    passwordVault,
    onFatal: (reason) => {
      log.fatal(safeLogFields({ component: 'startup', reason }), 'stopping');
      void shutdown('fatal', EXIT_UNAVAILABLE);
    },
  });

  // ADR 0080: every owner-edited instance setting, so a restart states what
  // it is running with. Secret settings log `configured` only (hard rule 4).
  for (const view of daemon.instanceSettings.list()) {
    if (view.isDefault === false) {
      log.info(
        safeLogFields({ component: 'config', settingKey: view.key }),
        `setting ${view.key} = ${view.display === 'secret' ? 'configured' : JSON.stringify(view.value)}`,
      );
    }
  }

  // Started after `createDaemon` and before the gateway login, so the dashboard
  // is answering by the time anything can happen in Discord. It shares the
  // handle the daemon already holds; a second process would be a second writer.
  let dashboard: DashboardApi | undefined;
  try {
    dashboard = await startDashboardApi({
      config,
      scopes: opened.scopes,
      logger: log,
      now: () => Date.now(),
      portsFor: daemon.portsFor,
      instance: daemon.instance,
      client,
      discord,
      ...(daemon.providerStore === undefined
        ? {}
        : { assistantProviderConfig: daemon.providerStore }),
      ...(daemon.providerSecretProblem === undefined
        ? {}
        : { assistantSecretProblem: daemon.providerSecretProblem }),
      // Task 8: the one process-wide ledger — the same instance every
      // guild's assistant loop shares — so the allowance pill agrees.
      assistantQuotaLedger: daemon.quotaLedger,
      assistantWebSearch: daemon.webSearch,
      // ADR 0080: the owner-edited instance settings (AI tuning).
      instanceSettings: daemon.instanceSettings,
    });
  } catch (err) {
    // A port already in use is the operator's to look at, like the socket and
    // the database lock, and it must not leave a half-started daemon running
    // without its control plane.
    opened.close();
    fail(
      `The dashboard API could not listen on ${config.DASHBOARD_BIND}:${String(config.DASHBOARD_PORT)}.\n\n` +
        `  ${err instanceof Error ? err.message : String(err)}\n\n` +
        `  Another instance may already be running, or DASHBOARD_PORT may be taken.`,
      EXIT_UNAVAILABLE,
    );
  }

  async function shutdown(reason: string, code = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(safeLogFields({ component: 'shutdown', reason }), 'shutting down');
    try {
      // Order matters: stop taking new events, let the in-flight jobs finish
      // while the client can still deliver their answers, then destroy the
      // client, handle events that arrived meanwhile, and close the database.
      // Closing first would fail them mid-write. The operator socket goes
      // first of all, so a `bananasaurs` invocation
      // during shutdown is refused at connect rather than half-served. The
      // dashboard goes with it, and for the same reason: an HTTP request
      // arriving mid-shutdown is refused at connect rather than half-served.
      await opsSocket.close();
      await dashboard?.close();
      // ADR 0135: jobs first, while the client can still deliver their answers.
      await daemon.stop();
      await client.destroy();
      // Events that arrived while jobs finished are handled before the database closes.
      await daemon.settle();
    } finally {
      opened.close();
    }
    process.exit(code);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  opsSocket.serve((raw) => daemon.ops.dispatch(raw));

  daemon.start();

  try {
    await client.login(config.DISCORD_BOT_TOKEN);
  } catch (err) {
    // The token is a credential and never reaches a log line; the reason a
    // login failed does not need it, and pino redacts `token` besides.
    log.error(safeLogFields({ component: 'startup', err }), 'could not connect to Discord');
    await shutdown('login-failed', EXIT_UNAVAILABLE);
    return;
  }

  // Registration is a REST call and needs no gateway, so it runs as soon as
  // login has resolved rather than waiting on READY (ADR 0032).
  await announceCommands(config, client.rest, log);
}

void main();
