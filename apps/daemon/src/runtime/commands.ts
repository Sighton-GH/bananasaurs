import type { Client } from 'discord.js';
import { safeLogFields, type Config, type Logger } from '@bananasaurs/core';
import { registerGuildCommands } from '@bananasaurs/discord/rest';

/**
 * Telling Discord which slash commands exist (ADR 0032).
 *
 * Inside `apps/daemon`, which is the only place outside the effect gateway
 * permitted to import `@bananasaurs/discord/rest` (`docs/19` §5 layer 5, ADR
 * 0014). Its own module rather than a function in `index.ts` for one practical
 * reason: `index.ts` calls `main()` at import time, so nothing can import it to
 * test it, and the mapping from configuration to registration arguments — which
 * application id, which guilds — is exactly the kind of wiring that fails
 * silently when it is wrong.
 */

/**
 * Registers the command set in every allowlisted guild, and logs the outcome.
 *
 * **Called after `client.login()` resolves, not from `ClientReady`.**
 * `Client.login` calls `rest.setToken` synchronously before it connects the
 * websocket, so REST is authenticated well before the gateway is ready — while
 * `ClientReady` fires again on every reconnect, which would re-`PUT` an
 * unchanged command set against the global rate cap each time. Awaiting
 * `login()` is still the right barrier: a rejected login means Discord refused
 * the token, and there is no point spending a request to be told so again.
 *
 * **Never throws.** A guild that refuses registration does not prevent the
 * bot from connecting, moderating, logging and serving the dashboard (ADR 0032).
 */
export async function announceCommands(
  config: Config,
  rest: Client['rest'],
  log: Logger,
): Promise<void> {
  const results = await registerGuildCommands({
    rest,
    // Configuration, not `client.application`, which does not exist until READY.
    applicationId: config.DISCORD_APPLICATION_ID,
    // The allowlist, looped rather than indexed (CLAUDE.md rule 2).
    guildIds: config.BANANASAURS_GUILD_ALLOWLIST,
    // ADR 0086 leaves only `/mod` registered.
  });

  for (const result of results) {
    if (result.ok) {
      log.info(
        safeLogFields({
          component: 'startup',
          guildId: result.guildId,
          count: result.count,
          outcome: 'commands-registered',
        }),
        'slash commands registered',
      );
    } else {
      log.error(
        safeLogFields({
          component: 'startup',
          guildId: result.guildId,
          outcome: 'commands-not-registered',
          err: result.error,
        }),
        'slash commands could not be registered; /mod will be missing or stale',
      );
    }
  }
}
