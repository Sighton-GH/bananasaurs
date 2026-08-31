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
});
