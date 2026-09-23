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
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'NVIDIA_NIM_API_KEY',
  'BRAVE_SEARCH_API_KEY',
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

  /**
   * Guilds that may hold archive channels at all (ADR 0046 D1). Empty by
   * default: nothing is archived until the operator lists a guild here AND
   * enables a channel.
   *
   * The club guild was held off this list until `/mydata` and `/forgetme`
   * shipped. **That precondition was withdrawn by the owner on 2026-09-14**
   * (ADR 0046 Amendment 2): the same messages are already retained by another
   * bot in the server, so Bananasaurs retaining them adds no new category of
   * exposure, and the data-subject route is a request to the owner rather
   * than a command. Retention still applies in full — content is purged at
   * 30 days unless preserved or linked to a case (ADR 0046 D3). Listing a
   * guild here is still not enough on its own; a channel must also be
   * enabled, and an excluded channel is still refused.
   */
  BANANASAURS_ARCHIVE_GUILDS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(snowflake)),

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

  /**
   * Loopback only, and enforced rather than documented.
   *
   * `docs/19` §6.10 and §118 both say `127.0.0.1`, and that reaching the
   * dashboard from anywhere else is `ssh -L 8787:127.0.0.1:8787` or Tailscale.
   * The variable stays configurable because IPv6-only hosts need `::1`, but the
   * value it exists to prevent is the one someone reaches for at 2am when the
   * page will not load from their laptop: `0.0.0.0` puts a password form
   * holding the kill switch on the LAN.
   *
   * An enum rather than a comment, because "the fix is not to change the bind"
   * is a rule, and a rule that only appears in prose is one the daemon does not
   * enforce.
   */
  DASHBOARD_BIND: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),

  /**
   * ADR 0045 (ruling PR-116): the public https origin the MCP server is
   * reached at through the tunnel — the OAuth `issuer`. Optional: when unset
   * the OAuth routes are not mounted at all, so a daemon that has not opted
   * in exposes no authorization endpoints.
   */
  MCP_PUBLIC_URL: z
    .string()
    .url()
    .refine((u) => {
      const url = new URL(u);
      return url.protocol === 'https:' || url.hostname === '127.0.0.1';
    }, 'MCP_PUBLIC_URL must be https:// or a 127.0.0.1 dev origin')
    .refine((u) => {
      const url = new URL(u);
      return url.pathname === '/' && url.search === '' && url.hash === '' && !u.endsWith('/');
    }, 'MCP_PUBLIC_URL must be a bare origin: no path, query, fragment or trailing slash')
    .optional(),

  /**
   * Unused, and optional since ADR 0029.
   *
   * It was specified when dashboard sessions were going to be signed cookies.
   * ADR 0012 and `docs/19` §6.10 made them DB-backed instead — specifically so
   * revocation is immediate — and a DB-backed session has nothing to sign. The
   * CSRF token is derived from the session token itself, deliberately so that
   * it needs no secret to manage and survives a restart exactly as long as the
   * session does.
   *
   * Kept in `SECRET_CONFIG_KEYS` even though nothing reads it: an operator who
   * already put a value here must not have it appear in a log line or a
   * diagnostics bundle merely because the code stopped using it.
   *
   * **Not required.** A mandatory secret that nothing reads is worse than no
   * secret at all: it implies a control that does not exist, and invites
   * someone to believe that rotating it invalidates sessions. It does not.
   */
  DASHBOARD_SESSION_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),

  BANANASAURS_ROLE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
  BANANASAURS_ERROR_BREAKER_THRESHOLD: z.coerce.number().int().positive().default(5),
  BANANASAURS_RECONCILE_BUDGET: z.coerce.number().int().positive().default(25),

  /**
   * Backup (ADR 0034, `docs/19` §6.12). A sibling of `BANANASAURS_DATA_DIR`
   * rather than nested inside it, matching `deploy/bananasaurs.service`'s
   * `ReadWritePaths=/opt/bananasaurs/data /opt/bananasaurs/backups`.
   */
  BANANASAURS_BACKUP_DIR: z.string().min(1).default('./backups'),
  /** Daily by default — see ADR 0034 for why this database's size doesn't argue for more often. */
  BANANASAURS_BACKUP_INTERVAL_MIN: z.coerce.number().int().positive().default(1440),
  BANANASAURS_BACKUP_RETAIN: z.coerce.number().int().positive().default(14),
  AI_PROVIDER: z.enum(['off', 'gemini', 'openrouter', 'nvidia-nim']).default('off'),
  AI_MODEL: z.string().min(1).optional(),
  AI_PROFILE_COST_CLASS: z.enum(['free', 'paid', 'unknown']).default('unknown'),
  GEMINI_API_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  NVIDIA_NIM_API_KEY: z.string().min(1).optional(),
  /** Tried once when `AI_MODEL` is overloaded; same service and key. Overridden by AI setup. */
  AI_FALLBACK_MODEL: z.string().min(1).optional(),
  /** ADR 0066: web search is on only while this key is set. Overridden by AI setup. */
  BRAVE_SEARCH_API_KEY: z.string().min(1).optional(),
  /** The club's IANA time zone, for the assistant's `current_time` tool. */
  BANANASAURS_TIME_ZONE: z
    .string()
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat('en-CA', { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }, 'must be an IANA time zone such as America/Vancouver')
    .default('America/Vancouver'),
  /** AES-GCM master secret for write-only provider keys stored through the dashboard. */
  ASSISTANT_PROVIDER_SECRET_KEY: z.string().min(32).optional(),
});

export type Config = z.infer<typeof configSchema>;
