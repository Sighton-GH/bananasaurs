import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

/**
 * CLAUDE.md rule 4: redaction is an allowlist, not a denylist.
 *
 * A denylist fails the moment someone logs a field nobody thought to ban, which
 * is exactly how tokens reach log files. This list is every field that may
 * appear in a structured log line. Anything absent is dropped, including fields
 * that do not exist yet.
 *
 * Message content is deliberately absent. So is anything resembling a
 * credential. Discord snowflakes are present because a role grant is
 * undiagnosable without knowing who and which role, and PRIVACY.md already
 * tells members that bot role changes are recorded.
 */
export const LOGGABLE_FIELDS = new Set([
  // identity and scope
  'guildId',
  'userId',
  'roleId',
  'channelId',
  'messageId',
  'panelId',
  'optionId',
  'accountId',
  'sessionId',
  'principalId',
  'principalType',
  'capability',
  // work identity
  'effectId',
  'batchId',
  'jobId',
  'jobKind',
  'eventKind',
  'fingerprint',
  'dedupeKey',
  'cursor',
  'attempt',
  'maxAttempts',
  // outcome and shape
  'action',
  'state',
  'outcome',
  'reason',
  'code',
  'status',
  'count',
  'total',
  'skipped',
  'applied',
  'failed',
  'durationMs',
  'lagMs',
  'budget',
  'limit',
  'dryRun',
  'inferred',
  'readonly',
  'breakerState',
  'killswitch',
  // process
  'component',
  'version',
  'nodeVersion',
  'pid',
  'env',
  'path',
  'bind',
  'port',
  'err',
  'error',
  'msg',
]);

/**
 * Projects an arbitrary object down to the allowlist.
 *
 * Returns the permitted fields plus a count of what was dropped, so a log line
 * shows that something was withheld rather than silently losing it. Nested
 * objects are not walked: a nested value cannot be vetted field by field, so it
 * is dropped whole unless its key is itself allowlisted and its value primitive.
 */
export function safeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let dropped = 0;

  for (const [key, value] of Object.entries(fields)) {
    if (!LOGGABLE_FIELDS.has(key)) {
      dropped += 1;
      continue;
    }
    if (key === 'err' || key === 'error') {
      out[key] =
        value instanceof Error ? { name: value.name, message: value.message } : '<non-error>';
      continue;
    }
    const t = typeof value;
    if (value === null || t === 'string' || t === 'number' || t === 'boolean') {
      out[key] = value;
    } else {
      dropped += 1;
    }
  }

  if (dropped > 0) out['droppedFields'] = dropped;
  return out;
}

export interface LoggerOptions {
  level: string;
  env: 'development' | 'production';
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    base: { component: 'bananasaurs' },
    // Defence in depth only. The allowlist above is the control; these paths are
    // the ones whose appearance in a log would be worst if it somehow got past it.
    redact: {
      paths: [
        'token',
        '*.token',
        'DISCORD_BOT_TOKEN',
        '*.DISCORD_BOT_TOKEN',
        'secret',
        '*.secret',
        'DASHBOARD_SESSION_SECRET',
        '*.DASHBOARD_SESSION_SECRET',
        'password',
        '*.password',
        'passwordHash',
        '*.passwordHash',
        'authorization',
        '*.authorization',
        'cookie',
        '*.cookie',
      ],
      censor: '<redacted>',
    },
    ...(options.env === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss' },
          },
        }
      : {}),
  });
}
