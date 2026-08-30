import { ApplicationCommandType, Routes, type REST } from 'discord.js';
import type { Snowflake } from '@bananasaurs/core';
import { mapErrors } from './errors.js';

/**
 * Telling Discord which slash commands exist (ADR 0032).
 *
 * A slash command is not a listener you attach — it is a *declaration* the bot
 * `PUT`s to Discord, one guild at a time, before any member can type it. Until
 * that call succeeds the command is not offered, and a bot that handles
 * `/status` perfectly while never registering it looks exactly like a bot that
 * is broken.
 *
 * Deliberately **not** an `EffectGateway` effect. None of the gateway's seven
 * layers describe this: there is no member to protect with a kill switch, no
 * side effect to withhold under dry run, no role budget to spend, and no
 * idempotency to manufacture — Discord's endpoint replaces the whole set, so it
 * is idempotent by construction. It lives behind `@bananasaurs/discord/rest`
 * because it is an authenticated Discord REST call, and `docs/19` §5 layer 5's
 * whole claim is that only the effect gateway and the composition root can make
 * one. ADR 0032 records the full argument.
 */

/**
 * One command as Discord's registration endpoint wants it.
 *
 * Snake-case, because this is the wire payload rather than a discord.js builder.
 * `@discordjs/builders` would add a dependency and a fluent API to describe four
 * fields, and the raw body is what `rest/port.ts` already uses everywhere else
 * for the same reason: keep the request explicit.
 */
export interface GuildCommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly type: ApplicationCommandType.ChatInput;
  /**
   * Discord's own default gate, and it is **not** how `/status` is authorised.
   *
   * `undefined` means every member may invoke it (ADR 0033). A future command
   * that should be moderators-only sets a permission bitfield here as a first
   * filter, but Discord's gate is advisory-by-configuration — a guild admin can
   * override it in Server Settings — so a command with real consequences still
   * checks authorisation in its handler.
   */
  readonly default_member_permissions?: string;
}

/**
 * `/status` — the bot's own health, as `GET /api/health` reports it.
 *
 * Open to every guild member, with no capability check and no
 * `default_member_permissions` (ADR 0033): the data is "is the bot connected,
 * is a safety control silently refusing everything, is the queue moving", and
 * the member watching a panel do nothing is the person best placed to ask.
 */
export const STATUS_COMMAND: GuildCommandDefinition = {
  name: 'status',
  description: 'Show whether the bot is connected, whether it is paused, and how busy it is',
  type: ApplicationCommandType.ChatInput,
};

/**
 * Every command Release 1 registers.
 *
 * The registration endpoint **replaces** a guild's command set rather than
 * merging into it, so this array is the whole truth: removing an entry here and
 * restarting is how a command is deregistered, and there is no second cleanup
 * path that could be forgotten.
 */
export const RELEASE_1_COMMANDS: readonly GuildCommandDefinition[] = [STATUS_COMMAND];

/** What one guild's registration did, so the caller can log it per guild. */
export type GuildRegistration =
  | { readonly guildId: Snowflake; readonly ok: true; readonly count: number }
  | { readonly guildId: Snowflake; readonly ok: false; readonly error: Error };

export interface RegisterCommandsDeps {
  /**
   * **The client's own REST instance**, not one of ours — the same rule as
   * `RestPortDeps.rest`. Two REST instances keep separate rate-limit buckets and
   * would race each other past Discord's global cap.
   */
  readonly rest: REST;
  /**
   * From `DISCORD_APPLICATION_ID`, not from `client.application`, which does not
   * exist until READY. That is what lets this run as soon as `login()` resolves.
   */
  readonly applicationId: Snowflake;
  /** `BANANASAURS_GUILD_ALLOWLIST`, looped rather than indexed (CLAUDE.md rule 2). */
  readonly guildIds: readonly Snowflake[];
  readonly commands?: readonly GuildCommandDefinition[] | undefined;
}

/**
 * Registers the command set in every allowlisted guild.
 *
 * **Guild-scoped, never global.** A guild command is live immediately; a global
 * one is cached by Discord for up to an hour, which makes "registered" and
 * "failed to register" indistinguishable for that hour. The guild id is in the
 * route, which is this project's guild partition key expressed as a URL rather
 * than as a database constraint.
 *
 * **Never throws.** A guild that refuses registration is reported in its own
 * result and the remaining guilds are still attempted: one guild that removed
 * the bot's `applications.commands` scope must not stop the others, and a
 * process that otherwise connects, moderates and logs should not die because a
 * command list is stale (ADR 0032).
 */
export async function registerGuildCommands(
  deps: RegisterCommandsDeps,
): Promise<readonly GuildRegistration[]> {
  const commands = deps.commands ?? RELEASE_1_COMMANDS;
  const results: GuildRegistration[] = [];

  // Sequential, not `Promise.all`: ADR 0018 configures the REST client to
  // *refuse* rather than wait on a rate limit, so firing every guild at once
  // would turn a large allowlist into refusals instead of a slightly slower
  // start.
  for (const guildId of deps.guildIds) {
    try {
      await mapErrors(() =>
        deps.rest.put(Routes.applicationGuildCommands(deps.applicationId, guildId), {
          body: commands,
        }),
      );
      results.push({ guildId, ok: true, count: commands.length });
    } catch (err) {
      results.push({
        guildId,
        ok: false,
        // `mapErrors` has already narrowed this to a `DiscordApiError`; the
        // fallback is for the impossible case rather than an expected one.
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
  return results;
}
