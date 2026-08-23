import { configSchema, isSecretConfigKey, type Config } from './schema.js';

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`configuration is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses configuration from an environment-shaped record.
 *
 * Pure: takes the environment as an argument rather than reading `process.env`,
 * so it is testable without mutating global state, and so nothing in `core`
 * touches the filesystem.
 *
 * On failure it reports every problem at once, naming the field and the rule it
 * broke. It never includes the offending value, because the most likely field to
 * be wrong is the bot token and an error message is a log line.
 */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    const missing = issue.code === 'invalid_type' && issue.received === 'undefined';
    return missing ? `${key}: missing` : `${key}: ${issue.message}`;
  });
  throw new ConfigError([...new Set(problems)].sort());
}

/**
 * The shape safe to print, log, or return from `bananasaurs config get`.
 * Secrets are replaced, never truncated — a prefix is still a disclosure.
 */
export function redactConfig(config: Config): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([k, v]) => [k, isSecretConfigKey(k) ? '<redacted>' : v]),
  );
}
