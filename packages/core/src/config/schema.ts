import { z } from 'zod';

/**
 * Discord snowflakes are 64-bit and exceed Number.MAX_SAFE_INTEGER, so they are
 * carried as strings everywhere. Anything that parses one into a number is a bug.
 */
const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake (17-20 digits)');

const bool01 = z.enum(['0', '1']).transform((v) => v === '1');

const port = z.coerce.number().int().min(1).max(65535);

/**
 * Keys whose values must never appear in a log line, an error message, a config
 * export, or a diagnostics bundle. This is the allowlist's complement: the
 * logger permits nothing by default, and this list is what `config get` redacts.
 */
export const SECRET_CONFIG_KEYS = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_PUBLIC_KEY',
  'DASHBOARD_SESSION_SECRET',
] as const;

export type SecretConfigKey = (typeof SECRET_CONFIG_KEYS)[number];

export const isSecretConfigKey = (key: string): key is SecretConfigKey =>
  (SECRET_CONFIG_KEYS as readonly string[]).includes(key);

export const configSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, 'must not be empty'),
  DISCORD_APPLICATION_ID: snowflake,
  DISCORD_PUBLIC_KEY: z.string().min(1).optional(),

  /**
   * The backstop from docs/15: a dev instance that somehow starts with
   * production config still refuses to act on any guild not listed here.
   */
  BANANASAURS_GUILD_ALLOWLIST: z
    .string()
    .min(1, 'must list at least one guild id')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(snowflake).min(1, 'must list at least one guild id')),

  BANANASAURS_OWNER_USER_ID: snowflake,

  BANANASAURS_ENV: z.enum(['development', 'production']).default('development'),
  BANANASAURS_DRY_RUN: bool01.default('1'),
  BANANASAURS_READONLY: bool01.default('0'),
  BANANASAURS_LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  BANANASAURS_DATA_DIR: z.string().min(1).default('./data'),
  BANANASAURS_DB_PATH: z.string().min(1).default('./data/bananasaurs.db'),
  BANANASAURS_SOCKET_PATH: z.string().min(1).default('./run/admin.sock'),

  DASHBOARD_PORT: port.default(8787),
  DASHBOARD_BIND: z.string().min(1).default('127.0.0.1'),
  DASHBOARD_SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),

  BANANASAURS_ROLE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
  BANANASAURS_ERROR_BREAKER_THRESHOLD: z.coerce.number().int().positive().default(5),
  BANANASAURS_RECONCILE_BUDGET: z.coerce.number().int().positive().default(25),
});

export type Config = z.infer<typeof configSchema>;
