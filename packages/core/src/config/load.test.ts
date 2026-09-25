import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, redactConfig } from './load.js';

const VALID: Record<string, string> = {
  DISCORD_BOT_TOKEN: 'not-a-real-token-value',
  DISCORD_APPLICATION_ID: '123456789012345678',
  BANANASAURS_GUILD_ALLOWLIST: '234567890123456789',
  BANANASAURS_OWNER_USER_ID: '345678901234567890',
  DASHBOARD_SESSION_SECRET: 'x'.repeat(32),
};

describe('parseConfig', () => {
  it('accepts a minimal valid environment and applies documented defaults', () => {
    const c = parseConfig(VALID);
    expect(c.DISCORD_APPLICATION_ID).toBe('123456789012345678');
    expect(c.BANANASAURS_DRY_RUN).toBe(true);
    expect(c.BANANASAURS_READONLY).toBe(false);
    expect(c.DASHBOARD_BIND).toBe('127.0.0.1');
    expect(c.DASHBOARD_PORT).toBe(8787);
    expect(c.BANANASAURS_ROLE_RATE_LIMIT_PER_MIN).toBe(20);
    expect(c.BANANASAURS_RECONCILE_BUDGET).toBe(25);
    expect(c.BANANASAURS_BACKUP_DIR).toBe('./backups');
    expect(c.BANANASAURS_BACKUP_INTERVAL_MIN).toBe(1440);
    expect(c.BANANASAURS_BACKUP_RETAIN).toBe(14);
  });

  it('parses up to two backup models in order and refuses a third (ADR 0068)', () => {
    expect(
      parseConfig({ ...VALID, AI_FALLBACK_MODELS: ' lite , gemma ' }).AI_FALLBACK_MODELS,
    ).toEqual(['lite', 'gemma']);
    expect(parseConfig(VALID).AI_FALLBACK_MODELS).toBeUndefined();
    expect(() => parseConfig({ ...VALID, AI_FALLBACK_MODELS: 'a,b,c' })).toThrow(ConfigError);
  });

  it('defaults the club time zone and refuses one that is not IANA', () => {
    expect(parseConfig(VALID).BANANASAURS_TIME_ZONE).toBe('America/Vancouver');
    expect(() => parseConfig({ ...VALID, BANANASAURS_TIME_ZONE: 'Mars/Olympus' })).toThrow(
      ConfigError,
    );
  });

  it('defaults dry run ON, so an unconfigured instance performs no side effects', () => {
    expect(parseConfig(VALID).BANANASAURS_DRY_RUN).toBe(true);
  });

  it('treats dry run as off only for the exact string "0"', () => {
    expect(parseConfig({ ...VALID, BANANASAURS_DRY_RUN: '0' }).BANANASAURS_DRY_RUN).toBe(false);
    expect(parseConfig({ ...VALID, BANANASAURS_DRY_RUN: '1' }).BANANASAURS_DRY_RUN).toBe(true);
    // "false", "no", "off" must not silently disable dry run
    expect(() => parseConfig({ ...VALID, BANANASAURS_DRY_RUN: 'false' })).toThrow(ConfigError);
  });

  it('parses the guild allowlist into a trimmed array of snowflakes', () => {
    const c = parseConfig({
      ...VALID,
      BANANASAURS_GUILD_ALLOWLIST: ' 234567890123456789 , 345678901234567890 ',
    });
    expect(c.BANANASAURS_GUILD_ALLOWLIST).toEqual(['234567890123456789', '345678901234567890']);
  });

  it('rejects an allowlist containing a non-snowflake', () => {
    expect(() => parseConfig({ ...VALID, BANANASAURS_GUILD_ALLOWLIST: '123,not-an-id' })).toThrow(
      ConfigError,
    );
  });

  it('rejects an empty allowlist, because an empty backstop is not a backstop', () => {
    expect(() => parseConfig({ ...VALID, BANANASAURS_GUILD_ALLOWLIST: '' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...VALID, BANANASAURS_GUILD_ALLOWLIST: ' , ' })).toThrow(
      ConfigError,
    );
  });

  it('defaults the archive guild list to empty: nothing is archived until listed', () => {
    expect(parseConfig(VALID).BANANASAURS_ARCHIVE_GUILDS).toEqual([]);
  });

  it('parses the archive guild list into a trimmed array of snowflakes', () => {
    const c = parseConfig({
      ...VALID,
      BANANASAURS_ARCHIVE_GUILDS: '123456789012345678, 234567890123456789',
    });
    expect(c.BANANASAURS_ARCHIVE_GUILDS).toEqual(['123456789012345678', '234567890123456789']);
  });

  it('rejects an archive guild list containing a non-snowflake', () => {
    expect(() => parseConfig({ ...VALID, BANANASAURS_ARCHIVE_GUILDS: 'not-a-snowflake' })).toThrow(
      ConfigError,
    );
  });

  it('rejects a session secret under 32 characters', () => {
    expect(() => parseConfig({ ...VALID, DASHBOARD_SESSION_SECRET: 'x'.repeat(31) })).toThrow(
      ConfigError,
    );
    expect(parseConfig({ ...VALID, DASHBOARD_SESSION_SECRET: 'x'.repeat(32) })).toBeTruthy();
  });

  it('rejects an empty bot token', () => {
    expect(() => parseConfig({ ...VALID, DISCORD_BOT_TOKEN: '' })).toThrow(ConfigError);
  });

  it('rejects a snowflake that is too short or non-numeric', () => {
    expect(() => parseConfig({ ...VALID, DISCORD_APPLICATION_ID: '1234' })).toThrow(ConfigError);
    expect(() =>
      parseConfig({ ...VALID, BANANASAURS_OWNER_USER_ID: 'abcdefghijklmnopqr' }),
    ).toThrow(ConfigError);
  });

  it('reports every problem at once rather than one per run', () => {
    try {
      parseConfig({ DISCORD_BOT_TOKEN: '' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const problems = (err as ConfigError).problems;
      expect(problems.length).toBeGreaterThanOrEqual(4);
      expect(problems.join('\n')).toContain('DISCORD_APPLICATION_ID');
      expect(problems.join('\n')).toContain('BANANASAURS_OWNER_USER_ID');
      expect(problems.join('\n')).toContain('BANANASAURS_GUILD_ALLOWLIST');
      // DASHBOARD_SESSION_SECRET is deliberately not here any more. ADR 0029
      // made sessions DB-backed, so there is nothing to sign; a mandatory
      // secret nothing reads implies a control that does not exist.
      expect(problems.join('\n')).not.toContain('DASHBOARD_SESSION_SECRET');
    }
  });

  it('accepts a config with no DASHBOARD_SESSION_SECRET at all (ADR 0029)', () => {
    const withoutSecret: Record<string, string> = { ...VALID };
    delete withoutSecret['DASHBOARD_SESSION_SECRET'];
    expect(parseConfig(withoutSecret)).toBeTruthy();
  });

  it('refuses a dashboard bind that is not loopback', () => {
    // The value someone reaches for when the page will not load from their
    // laptop. `docs/19` §6.10: the fix is `ssh -L`, not a wider bind.
    expect(() => parseConfig({ ...VALID, DASHBOARD_BIND: '0.0.0.0' })).toThrow(ConfigError);
  });

  it('accepts ::1, for an IPv6-only host', () => {
    expect(parseConfig({ ...VALID, DASHBOARD_BIND: '::1' }).DASHBOARD_BIND).toBe('::1');
  });

  it('never puts a rejected value into the error message', () => {
    const leaked = 'MTIzNDU2Nzg5.SUPERSECRET.tokenlike';
    try {
      parseConfig({ ...VALID, DISCORD_APPLICATION_ID: leaked });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ConfigError).message).not.toContain(leaked);
      expect((err as ConfigError).message).not.toContain('SUPERSECRET');
      expect((err as ConfigError).message).toContain('DISCORD_APPLICATION_ID');
    }
  });

  it('accepts an https MCP_PUBLIC_URL (ADR 0045, ruling PR-116)', () => {
    expect(
      parseConfig({ ...VALID, MCP_PUBLIC_URL: 'https://bot.example.test' }).MCP_PUBLIC_URL,
    ).toBe('https://bot.example.test');
  });

  it('refuses a plain-http MCP_PUBLIC_URL', () => {
    expect(() => parseConfig({ ...VALID, MCP_PUBLIC_URL: 'http://bot.example.test' })).toThrow(
      ConfigError,
    );
  });

  it('refuses an MCP_PUBLIC_URL with a path', () => {
    expect(() => parseConfig({ ...VALID, MCP_PUBLIC_URL: 'https://bot.example.test/mcp' })).toThrow(
      ConfigError,
    );
  });

  it('refuses an MCP_PUBLIC_URL with a trailing slash', () => {
    expect(() => parseConfig({ ...VALID, MCP_PUBLIC_URL: 'https://bot.example.test/' })).toThrow(
      ConfigError,
    );
  });

  it('accepts a 127.0.0.1 dev origin over http', () => {
    expect(parseConfig({ ...VALID, MCP_PUBLIC_URL: 'http://127.0.0.1:8787' }).MCP_PUBLIC_URL).toBe(
      'http://127.0.0.1:8787',
    );
  });

  it('leaves MCP_PUBLIC_URL undefined when unset', () => {
    expect(parseConfig(VALID).MCP_PUBLIC_URL).toBeUndefined();
  });
});

describe('redactConfig', () => {
  it('replaces every secret and leaves non-secrets intact', () => {
    const r = redactConfig(parseConfig(VALID));
    expect(r['DISCORD_BOT_TOKEN']).toBe('<redacted>');
    expect(r['DASHBOARD_SESSION_SECRET']).toBe('<redacted>');
    expect(r['DASHBOARD_PORT']).toBe(8787);
    expect(r['BANANASAURS_ENV']).toBe('development');
  });

  it('leaks no fragment of a secret, not even a prefix', () => {
    const token = 'PREFIX123.MIDDLE456.SUFFIX789';
    const r = redactConfig(parseConfig({ ...VALID, DISCORD_BOT_TOKEN: token }));
    expect(JSON.stringify(r)).not.toContain('PREFIX123');
    expect(JSON.stringify(r)).not.toContain('MIDDLE');
    expect(JSON.stringify(r)).not.toContain('SUFFIX');
  });

  it('redacts the provider and account-password master secrets (ADR 0070)', () => {
    const providerSecret = 'p'.repeat(32);
    const redactedProvider = redactConfig(
      parseConfig({ ...VALID, ASSISTANT_PROVIDER_SECRET_KEY: providerSecret }),
    );
    expect(redactedProvider['ASSISTANT_PROVIDER_SECRET_KEY']).toBe('<redacted>');
    expect(JSON.stringify(redactedProvider)).not.toContain(providerSecret);

    const accountSecret = 'q'.repeat(32);
    const redactedAccount = redactConfig(
      parseConfig({ ...VALID, ACCOUNT_PASSWORD_SECRET_KEY: accountSecret }),
    );
    expect(redactedAccount['ACCOUNT_PASSWORD_SECRET_KEY']).toBe('<redacted>');
    expect(JSON.stringify(redactedAccount)).not.toContain(accountSecret);
  });
});
