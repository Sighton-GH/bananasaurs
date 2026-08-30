import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { REST } from 'discord.js';
import { parseConfig, type Config } from '@bananasaurs/core';
import { REST_OPTIONS } from '@bananasaurs/discord';
import { announceCommands } from './commands.js';

/**
 * The composition root's registration wiring (ADR 0032).
 *
 * `registerGuildCommands` itself is tested in `packages/discord`; what is
 * asserted here is the part only the composition root knows — **which**
 * application id and **which** guilds. That mapping is exactly the kind of
 * wiring that fails silently when it is wrong: registering under the wrong
 * application id succeeds against Discord and produces a command nobody in this
 * guild can see.
 *
 * It lives in its own module rather than in `index.ts` precisely so this test
 * can exist: `index.ts` calls `main()` at import time.
 */

const GUILD = '234567890123456789';
const SECOND_GUILD = '345678901234567890';
const APPLICATION = '123456789012345678';

const logger = pino({ level: 'silent' });

const config = (over: Record<string, string> = {}): Config =>
  parseConfig({
    DISCORD_BOT_TOKEN: 'not.a.real.token',
    DISCORD_APPLICATION_ID: APPLICATION,
    BANANASAURS_GUILD_ALLOWLIST: GUILD,
    BANANASAURS_OWNER_USER_ID: '456789012345678901',
    DASHBOARD_SESSION_SECRET: 'a'.repeat(32),
    ...over,
  });

function harness(status = 200) {
  const paths: string[] = [];
  const rest = new REST({
    ...REST_OPTIONS,
    makeRequest: async (url) => {
      paths.push(new URL(url).pathname);
      return new Response(JSON.stringify(status === 200 ? [] : { code: 50001 }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  rest.setToken('not-a-real-token');
  return { rest, paths };
}

describe('announceCommands', () => {
  it('registers under the configured application id, in the configured guild', async () => {
    const { rest, paths } = harness();
    await announceCommands(config(), rest, logger);

    expect(paths).toEqual([`/api/v10/applications/${APPLICATION}/guilds/${GUILD}/commands`]);
  });

  /**
   * Looped over the allowlist rather than indexed. Release 1 has one guild, and
   * a second one must be configuration rather than a code change (CLAUDE.md
   * rule 2).
   */
  it('registers in every allowlisted guild', async () => {
    const { rest, paths } = harness();
    await announceCommands(
      config({ BANANASAURS_GUILD_ALLOWLIST: `${GUILD},${SECOND_GUILD}` }),
      rest,
      logger,
    );

    expect(paths).toEqual([
      `/api/v10/applications/${APPLICATION}/guilds/${GUILD}/commands`,
      `/api/v10/applications/${APPLICATION}/guilds/${SECOND_GUILD}/commands`,
    ]);
  });

  /**
   * A stale command list is a degraded process, not a broken one. Startup
   * continues, because the bot still connects, moderates, logs and serves the
   * dashboard without it (ADR 0032).
   */
  it('does not throw when Discord refuses', async () => {
    const { rest, paths } = harness(403);
    await expect(announceCommands(config(), rest, logger)).resolves.toBeUndefined();
    expect(paths).toHaveLength(1);
  });
});
