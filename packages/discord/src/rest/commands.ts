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
  /**
   * Discord's own ceiling for a STRING option's value (max 6000). Set on
   * `/mod note`'s `text` and `/mod evidence`'s `url` (Task 8) so an
   * unbounded note or URL is rejected before the interaction ever reaches
   * the handler — `mod_case_events.matched_snippet` carries no length CHECK
   * of its own (`packages/storage/src/schema.ts`), so this option-level cap
   * is the only bound either value gets.
   */
  readonly max_length?: number;
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

/** `channel` on `/mod purge`: which channel to clean up. */
const channelOption: GuildCommandOption = {
  name: 'channel',
  description: 'The channel to purge',
  type: ApplicationCommandOptionType.Channel,
  required: true,
};

/** `text` on `/mod note`: the note itself, capped well under Discord's 6000-char STRING ceiling. */
const noteTextOption: GuildCommandOption = {
  name: 'text',
  description: 'The note to add to this member’s case history',
  type: ApplicationCommandOptionType.String,
  required: true,
  max_length: 1000,
};

/** `url` on `/mod evidence`: a link, not free text — capped shorter than `text`. */
const evidenceUrlOption: GuildCommandOption = {
  name: 'url',
  description: 'Link to the evidence (screenshot, message link, etc.)',
  type: ApplicationCommandOptionType.String,
  required: true,
  max_length: 500,
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
 * Ten subcommands now: `timeout`, `untimeout`, `kick`, `unban`, `warn`
 * (Task 6, executing on invocation), `ban` and `purge` (Task 7,
 * confirm-then-execute — `packages/core/src/mod/confirmations.ts` writes a
 * pending intent and renders Confirm/Cancel buttons instead of acting
 * immediately), `note`/`evidence` (Task 8, executing on invocation like
 * Task 6's five — neither calls the moderation gateway at all, so there is
 * nothing to preview or confirm), and `history` (Task 9, read-only — no
 * gateway call, no case-event write, just `target`). The registration
 * endpoint replaces the whole set on every `PUT` (this file's own
 * docstring, ADR 0032), so growing the array and redeploying is the entire
 * mechanism.
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
    {
      name: 'ban',
      description: 'Ban a member — shows a preview with Confirm/Cancel before anything happens',
      type: ApplicationCommandOptionType.Subcommand,
      options: [targetOption, reasonOption],
    },
    {
      name: 'purge',
      description:
        'Delete recent messages in a channel — shows a preview with Confirm/Cancel before anything happens',
      type: ApplicationCommandOptionType.Subcommand,
      options: [channelOption, reasonOption],
    },
    {
      name: 'note',
      description: 'Add a note to a member’s case history (not a violation by itself)',
      type: ApplicationCommandOptionType.Subcommand,
      options: [targetOption, noteTextOption],
    },
    {
      name: 'evidence',
      description: 'Attach an evidence link to a member’s case history',
      type: ApplicationCommandOptionType.Subcommand,
      options: [targetOption, evidenceUrlOption],
    },
    {
      name: 'history',
      description: 'Show a member’s case history — read-only, no side effects',
      type: ApplicationCommandOptionType.Subcommand,
      options: [targetOption],
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

const requiredText = (
  name: string,
  description: string,
  maxLength = 2_000,
): GuildCommandOption => ({
  name,
  description,
  type: ApplicationCommandOptionType.String,
  required: true,
  max_length: maxLength,
});

export const ASK_COMMAND: GuildCommandDefinition = {
  name: 'ask',
  description: 'Ask the club assistant a grounded question',
  type: ApplicationCommandType.ChatInput,
  options: [requiredText('question', 'What you want to know')],
};
export const FIND_COMMAND: GuildCommandDefinition = {
  name: 'find',
  description: 'Find information in club sources you can access',
  type: ApplicationCommandType.ChatInput,
  options: [requiredText('query', 'What to find')],
};
export const REMIND_COMMAND: GuildCommandDefinition = {
  name: 'remind',
  description: 'Schedule a reminder after reviewing its destination',
  type: ApplicationCommandType.ChatInput,
  options: [
    requiredText('when', 'When to send it, including date or time zone'),
    requiredText('text', 'Reminder text'),
  ],
};
export const REMEMBER_COMMAND: GuildCommandDefinition = {
  name: 'remember',
  description: 'Propose a memory entry for owner review',
  type: ApplicationCommandType.ChatInput,
  options: [requiredText('request', 'What the assistant should consider remembering', 2_000)],
};
export const DECISION_COMMAND: GuildCommandDefinition = {
  name: 'decision',
  description: 'Draft a club decision from the evidence you provide',
  type: ApplicationCommandType.ChatInput,
  options: [
    requiredText('topic', 'Decision topic'),
    {
      name: 'context',
      description: 'Optional context or constraints',
      type: ApplicationCommandOptionType.String,
      max_length: 2_000,
    },
  ],
};
export const REVIEW_PLAN_COMMAND: GuildCommandDefinition = {
  name: 'review-plan',
  description: 'Review a club plan without taking action',
  type: ApplicationCommandType.ChatInput,
  options: [requiredText('plan', 'Plan to review', 4_000)],
};

const assistantDraftCommand = (name: string, description: string): GuildCommandDefinition => ({
  name,
  description,
  type: ApplicationCommandType.ChatInput,
  options: [requiredText('request', 'What you need', 4_000)],
});
export const ONBOARD_COMMAND = assistantDraftCommand('onboard', 'Get sourced onboarding guidance');
export const AGENDA_COMMAND = assistantDraftCommand('agenda', 'Draft a meeting agenda');
export const SUMMARISE_COMMAND = assistantDraftCommand(
  'summarise',
  'Summarise supplied meeting notes',
);
export const ANNOUNCE_COMMAND = assistantDraftCommand('announce', 'Draft a club announcement');
export const CHECKLIST_COMMAND = assistantDraftCommand(
  'checklist',
  'Draft an event or project checklist',
);
export const HANDOFF_COMMAND = assistantDraftCommand('handoff', 'Draft a team handoff');

/** Release 3 keeps the privacy controls in the dashboard; it does not register /mydata or /forgetme. */
export const RELEASE_3_COMMANDS: readonly GuildCommandDefinition[] = [
  ...RELEASE_2_COMMANDS,
  ASK_COMMAND,
  FIND_COMMAND,
  REMIND_COMMAND,
  REMEMBER_COMMAND,
  DECISION_COMMAND,
  REVIEW_PLAN_COMMAND,
  ONBOARD_COMMAND,
  AGENDA_COMMAND,
  SUMMARISE_COMMAND,
  ANNOUNCE_COMMAND,
  CHECKLIST_COMMAND,
  HANDOFF_COMMAND,
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
