import process from 'node:process';
import {
  ConfigError,
  createLogger,
  parseConfig,
  redactConfig,
  safeLogFields,
} from '@bananasaurs/core';

function main(): void {
  let config;
  try {
    config = parseConfig(process.env);
  } catch (err) {
    // Deliberately not the logger: the logger needs config, and a config failure
    // must be legible before anything is wired up.
    if (err instanceof ConfigError) {
      process.stderr.write(
        `\nBananasaurs cannot start.\n\n${err.message}\n\nSee .env.example.\n\n`,
      );
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

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
  log.info('no modules are wired up yet; this is the WP1 skeleton');
}

main();
