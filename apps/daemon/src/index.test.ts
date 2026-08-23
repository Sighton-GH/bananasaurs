import { describe, expect, it } from 'vitest';
import { parseConfig, redactConfig } from '@bananasaurs/core';

/**
 * The daemon logs `redactConfig(config)` directly rather than through the
 * logger's allowlist, because the two use different key conventions. That is a
 * deliberate exception, so it gets its own test: the object handed to the
 * logger must carry no secret value.
 */
describe('startup config logging', () => {
  it('hands the logger no secret value', () => {
    const token = 'TOKENPART1.TOKENPART2.TOKENPART3';
    const secret = 'SESSIONSECRETSESSIONSECRETSESSION';
    const logged = JSON.stringify(
      redactConfig(
        parseConfig({
          DISCORD_BOT_TOKEN: token,
          DISCORD_APPLICATION_ID: '123456789012345678',
          BANANASAURS_GUILD_ALLOWLIST: '234567890123456789',
          BANANASAURS_OWNER_USER_ID: '345678901234567890',
          DASHBOARD_SESSION_SECRET: secret,
        }),
      ),
    );
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('TOKENPART1');
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain('SESSIONSECRET');
    // and still carries something useful
    expect(logged).toContain('127.0.0.1');
  });
});
