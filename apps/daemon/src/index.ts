import process from 'node:process';
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
import { createDaemon } from './runtime/daemon.js';

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
  if (table !== undefined) return;

  opened.close();
  fail(
    `The database at ${dbPath} has no schema.\n\n  Run: npm run build && npm run db:migrate`,
    EXIT_CONFIG,
  );
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

  let shuttingDown = false;
  const daemon = createDaemon({
    config,
    scopes: opened.scopes,
    discord,
    client,
    logger: log,
    now: () => Date.now(),
    onFatal: (reason) => {
      log.fatal(safeLogFields({ component: 'startup', reason }), 'stopping');
      void shutdown('fatal', EXIT_UNAVAILABLE);
    },
  });

  async function shutdown(reason: string, code = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(safeLogFields({ component: 'shutdown', reason }), 'shutting down');
    try {
      // Order matters: stop taking new events, let the ones in flight finish,
      // then close the database. Closing first would fail them mid-write.
      await client.destroy();
      await daemon.stop();
    } finally {
      opened.close();
    }
    process.exit(code);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  daemon.start();

  try {
    await client.login(config.DISCORD_BOT_TOKEN);
  } catch (err) {
    // The token is a credential and never reaches a log line; the reason a
    // login failed does not need it, and pino redacts `token` besides.
    log.error(safeLogFields({ component: 'startup', err }), 'could not connect to Discord');
    await shutdown('login-failed', EXIT_UNAVAILABLE);
  }
}

void main();
