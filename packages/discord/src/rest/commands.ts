import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  PermissionFlagsBits,
  Routes,
  type REST,
} from 'discord.js';
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
 * One option on a command or subcommand, in Discord's raw wire shape.
 *
 * `type` takes the numeric `ApplicationCommandOptionType` values directly
 * (a subcommand is `1`, a `USER` option `6`, `STRING` `3`, `INTEGER` `4`) —
 * discord.js exports the enum with the right numbers, imported here the same
 * way this file already imports `ApplicationCommandType` for the command's
 * own `type` field, rather than hand-writing the numerals.
 */
export interface GuildCommandOption {
  readonly name: string;
  readonly description: string;
  readonly type: ApplicationCommandOptionType;
  readonly required?: boolean;
  readonly min_value?: number;
  readonly max_value?: number;
  /** A subcommand's own options, nested one level (Discord's own shape). */
  readonly options?: readonly GuildCommandOption[];
}

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
  /** A command's subcommands, top-level only (no subcommand groups needed yet). */
  readonly options?: readonly GuildCommandOption[];
}

/** `target` on every `/mod` subcommand: any Discord user, resolved by id, not just a current guild member (`unban`'s target usually is not one). */
const targetOption: GuildCommandOption = {
  name: 'target',
  description: 'The member (by mention or id)',
  type: ApplicationCommandOptionType.User,
  required: true,
};

const reasonOption: GuildCommandOption = {
  name: 'reason',
  description: 'Why — recorded on the case and in Discord’s own audit log',
  type: ApplicationCommandOptionType.String,
  required: true,
};

/**
 * `/mod` (ADR 0037, Task 6): moderator commands, gated in the handler by
 * `authorize('moderation.act')` against the real invoking member
 * (`packages/core/src/mod/commands.ts`).
 *
 * `default_member_permissions` is Discord's own **advisory** first filter
 * (see the field's docstring above) — combined here from
 * `BanMembers`/`KickMembers`/`ModerateMembers` so the command is hidden from
 * members holding none of them by default, while `authorize()` remains the
 * actual gate.
 *
 * Five subcommands: `timeout`, `untimeout`, `kick`, `unban`, `warn` — the
 * Task 6 brief's ruling on the ambiguous "ten subcommands" in the original
 * plan text. `ban` and `purge` need the confirm-then-execute handshake Task 7
 * builds; `note`/`evidence` are Task 8; `history` is Task 9. Each of those
 * tasks extends this `options` array — the registration endpoint replaces the
 * whole set on every `PUT` (this file's own docstring, ADR 0032), so growing
 * the array and redeploying is the entire mechanism.
 */
export const MOD_COMMAND: GuildCommandDefinition = {
  name: 'mod',
  description: 'Moderator actions: timeout, kick, ban management, and warnings',
  type: ApplicationCommandType.ChatInput,
  default_member_permissions: (
    PermissionFlagsBits.BanMembers |
    PermissionFlagsBits.KickMembers |
    PermissionFlagsBits.ModerateMembers
  ).toString(),
  options: [
    {
      name: 'timeout',
      description: 'Time out a member',
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        targetOption,
        {
          name: 'duration_minutes',
          description: 'How long, in minutes (max 40320 = 28 days; longer requests are clamped)',
          type: ApplicationCommandOptionType.Integer,
          required: true,
          min_value: 1,
          max_value: 40_320,
        },
        reasonOption,
      ],
    },
    {
      name: 'untimeout',
      description: 'Remove an active timeout from a member',
      type: ApplicationCommandOptionType.Subcommand,
      options: [targetOption, reasonOption],
    },
    {
      name: 'kick',
      description: 'Kick a member from the server',
      type: ApplicationCommandOptionType.Subcommand,
      options: [targetOption, reasonOption],
    },
    {
      name: 'unban',
      description: 'Lift a ban',
      type: ApplicationCommandOptionType.Subcommand,
      options: [targetOption, reasonOption],
    },
    {
      name: 'warn',
      description: 'Issue a warning; repeated warnings escalate automatically',
      type: ApplicationCommandOptionType.Subcommand,
      options: [targetOption, reasonOption],
    },
  ],
};

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

/**
 * Every command Release 2 registers — Release 1's set plus `/mod`
 * (REVIEW.md §E: "Release 2 — Bananasaurs replaces the automod"). Kept as its
 * own named array, not a mutation of `RELEASE_1_COMMANDS`, for the same
 * reason that array is named for its release rather than called
 * `COMMANDS`: the next release's set gets its own name too, and nothing here
 * has to guess which array today's daemon should register.
 */
export const RELEASE_2_COMMANDS: readonly GuildCommandDefinition[] = [
  ...RELEASE_1_COMMANDS,
  MOD_COMMAND,
];

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
