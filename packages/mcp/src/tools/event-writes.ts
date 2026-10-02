import { z } from 'zod';
import type { GuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';
import { idsAreWellFormed } from '../ids.js';

/**
 * The four schedule write tools, registered under the send scope: creating,
 * editing and cancelling Discord scheduled events, and posting native polls.
 *
 * The same five steps as `send_message` in `send.ts` — Zod parse →
 * `requireReachableGuild` → port call → render — so hard rule 3 holds by
 * construction, and the same two-message contract (ruling M4-D18): a parse
 * failure is the argument-fault message, a guild the caller cannot reach or
 * a throw out of the port is the shared refusal. No log line anywhere here
 * carries event or poll content (CLAUDE.md rule 4 — this module does not log
 * at all, and the rendered outcomes name channels, events and message ids,
 * never names, descriptions, questions or answers).
 *
 * This module holds no allowlist handle of any kind, for the same reason
 * `send.ts` holds none: the daemon's target resolution owns the allowlist
 * check, the live permission check and the ledger, and this package's port
 * projects its outcomes field by field.
 *
 * Every write goes through `runMcpAction` on the daemon side: events with
 * kinds `event.create` / `event.edit` / `event.cancel` in cap group
 * `structure`, and polls with kind `message.send` in cap group `message`
 * through the same send path as `send_message`. Only `event.edit` is
 * undoable — Discord cannot un-cancel an event, and a fresh event points at
 * `cancel_event` instead.
 */

/** A Discord event name is capped at 100 characters. */
export const EVENT_NAME_MAX = 100;
/** A Discord event description is capped at 1000 characters. */
export const EVENT_DESCRIPTION_MAX = 1000;
/** A Discord poll question is capped at 300 characters. */
export const POLL_QUESTION_MAX = 300;
/** A Discord poll takes 2 to 10 answers. */
export const POLL_ANSWERS_MIN = 2;
export const POLL_ANSWERS_MAX = 10;
/** A Discord poll answer is capped at 55 characters. */
export const POLL_ANSWER_MAX = 55;
/** A Discord poll stays open 1 to 168 hours. */
export const POLL_DURATION_MIN_HOURS = 1;
export const POLL_DURATION_MAX_HOURS = 168;

export const CREATE_EVENT_TOOL_NAME = 'create_event';
export const CREATE_EVENT_TOOL_DESCRIPTION =
  'Creates a Discord scheduled event (voice, stage or external) in this guild. ' +
  'A voice or stage event needs an allowlisted voice or stage channel where the bot holds ' +
  'the ManageEvents Discord permission; an external event needs a place, an end time, and ' +
  'the guild-level ManageEvents permission. ' +
  'Event creation cannot be undone: to remove the event, call cancel_event with its event id. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without creating.';

export const EDIT_EVENT_TOOL_NAME = 'edit_event';
export const EDIT_EVENT_TOOL_DESCRIPTION =
  'Edits a scheduled event of this guild. ' +
  'Any event the guild lists can be edited; an unknown event id is refused. ' +
  'A voice or stage event keeps the same target check as creation; an external event needs ' +
  'the guild-level ManageEvents permission. ' +
  'The previous values are kept for undo. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without editing.';

export const CANCEL_EVENT_TOOL_NAME = 'cancel_event';
export const CANCEL_EVENT_TOOL_DESCRIPTION =
  'Cancels a scheduled event of this guild. ' +
  'Any event the guild lists can be cancelled; an unknown event id is refused. ' +
  'A cancelled event cannot be un-cancelled in Discord. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without cancelling.';

export const CREATE_POLL_TOOL_NAME = 'create_poll';
export const CREATE_POLL_TOOL_DESCRIPTION =
  'Posts a message carrying a native poll to an allowlisted channel of this guild, ' +
  'through the same send path as send_message: the same target, ping (polls never ping) ' +
  'and idempotency rules hold. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without posting.';

/** Where the event lives, in the daemon port's vocabulary (epoch ms for times). */
export type EventLocationInput =
  | { readonly kind: 'voice' | 'stage'; readonly channelId: string }
  | { readonly kind: 'external'; readonly place: string };

/** What the daemon's event wiring must satisfy (the daemon implements it over `runMcpAction`). */
export interface McpEventWritesPort {
  readonly createEvent: (
    guildId: GuildId,
    input: {
      readonly name: string;
      readonly description: string | undefined;
      readonly startAt: number;
      readonly endAt: number | undefined;
      readonly location: EventLocationInput;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpEventWriteOutcome>;
  readonly editEvent: (
    guildId: GuildId,
    input: {
      readonly eventId: string;
      readonly name: string | undefined;
      readonly description: string | undefined;
      readonly startAt: number | undefined;
      readonly endAt: number | undefined;
      /**
       * A move, without a kind: the tool names only the channel or the
       * venue, and the daemon resolves voice-vs-stage from the channel's
       * live type. Absent, the event stays where it is.
       */
      readonly location: { readonly channelId: string } | { readonly place: string } | undefined;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpEventWriteOutcome>;
  readonly cancelEvent: (
    guildId: GuildId,
    input: {
      readonly eventId: string;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpEventWriteOutcome>;
  readonly createPoll: (
    guildId: GuildId,
    input: {
      readonly channelId: string;
      readonly question: string;
      readonly answers: readonly string[];
      readonly durationHours: number;
      readonly allowMultiselect: boolean;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpEventWriteOutcome>;
}

/** Mirrors the gateway's outcomes, named in this package's own vocabulary. */
export type McpEventWriteOutcome =
  | {
      readonly status: 'done';
      readonly actionId: string;
      readonly eventId?: string | undefined;
      readonly messageId?: string | undefined;
      /**
       * Set by the daemon's edit wiring when the edit moved the end time of
       * an event that had none: Discord's PATCH `scheduled_end_time` is not
       * nullable, so undo cannot restore the absence. The only consumer is
       * the edit-event outcome text below, which must name the field undo
       * does not cover.
       */
      readonly endTimeNotCovered?: boolean | undefined;
    }
  | { readonly status: 'dry-run'; readonly actionId: string }
  | {
      readonly status: 'replayed';
      readonly actionId: string;
      readonly eventId?: string | undefined;
      readonly messageId?: string | undefined;
    }
  | {
      readonly status: 'refused';
      readonly reason: McpEventWriteRefusal;
      readonly detail?: string;
    }
  | { readonly status: 'failed' };

export type McpEventWriteRefusal =
  | 'channel-not-allowlisted'
  | 'channel-not-in-guild'
  | 'private-thread'
  | 'bot-lacks-permission'
  | 'event-not-found'
  | 'not-voice-or-stage'
  | 'killswitch'
  | 'breaker-open'
  | 'rate-cap'
  | 'duplicate-key-different-content'
  | 'duplicate-content-recently';

export type EventWriteOutcomeText =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

/** An ISO-8601 string to epoch ms, or undefined when it parses to nothing. */
const parseIsoMs = (raw: string): number | undefined => {
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
};

/**
 * Zod schemas are the boundary (hard rule 3). A parse failure is the
 * argument-fault message (ruling M4-D18), never a throw: the parse runs
 * before the guild gate, so it has consulted nothing about which guilds
 * exist. `guildId` is a bare string on purpose, like `send.ts`: the gate
 * parses it and refuses malformed and unreachable identically.
 *
 * Times arrive as ISO-8601 strings and leave as epoch ms: `startAt` must
 * parse and lie in the future, and `endAt` must parse and lie after
 * `startAt`. An external event without `endAt` is an argument fault here —
 * the port would otherwise throw a TypeError before any call.
 */
const createEventArgsSchema = z
  .object({
    guildId: z.string(),
    name: z.string().min(1).max(EVENT_NAME_MAX),
    description: z.string().min(1).max(EVENT_DESCRIPTION_MAX).optional(),
    startAt: z.string().min(1),
    endAt: z.string().min(1).optional(),
    location: z.enum(['voice', 'stage', 'external']),
    channel: z.string().optional(),
    place: z.string().optional(),
    dryRun: z.boolean().optional(),
    idempotencyKey: z.string().min(1),
  })
  .superRefine((args, ctx) => {
    if (args.location === 'external') {
      if (args.channel !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'channel is voice-or-stage-only' });
      }
      if (args.place === undefined || args.place.trim() === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'external events need a place' });
      }
      if (args.endAt === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'external events need endAt' });
      }
    } else {
      if (args.channel === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'voice and stage events need a channel',
        });
      }
      if (args.place !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'place is external-only' });
      }
    }
    const startMs = parseIsoMs(args.startAt);
    if (startMs === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'startAt must be an ISO-8601 string' });
    } else if (startMs <= Date.now()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'startAt must be in the future' });
    }
    if (args.endAt !== undefined) {
      const endMs = parseIsoMs(args.endAt);
      if (endMs === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'endAt must be an ISO-8601 string' });
      } else if (startMs !== undefined && endMs <= startMs) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'endAt must be after startAt' });
      }
    }
  });

const editEventArgsSchema = z
  .object({
    guildId: z.string(),
    eventId: z.string(),
    name: z.string().min(1).max(EVENT_NAME_MAX).optional(),
    description: z.string().min(1).max(EVENT_DESCRIPTION_MAX).optional(),
    startAt: z.string().min(1).optional(),
    endAt: z.string().min(1).optional(),
    channel: z.string().optional(),
    place: z.string().optional(),
    dryRun: z.boolean().optional(),
    idempotencyKey: z.string().min(1),
  })
  .superRefine((args, ctx) => {
    if (
      args.name === undefined &&
      args.description === undefined &&
      args.startAt === undefined &&
      args.endAt === undefined &&
      args.channel === undefined &&
      args.place === undefined
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at least one field to change' });
    }
    if (args.channel !== undefined && args.place !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'channel and place are exclusive' });
    }
    if (args.startAt !== undefined) {
      const startMs = parseIsoMs(args.startAt);
      if (startMs === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'startAt must be an ISO-8601 string',
        });
      } else if (startMs <= Date.now()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'startAt must be in the future' });
      }
    }
    if (args.endAt !== undefined) {
      const endMs = parseIsoMs(args.endAt);
      if (endMs === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'endAt must be an ISO-8601 string' });
      } else if (args.startAt !== undefined) {
        const startMs = parseIsoMs(args.startAt);
        if (startMs !== undefined && endMs <= startMs) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'endAt must be after startAt' });
        }
      }
    }
  });

const cancelEventArgsSchema = z.object({
  guildId: z.string(),
  eventId: z.string(),
  dryRun: z.boolean().optional(),
  idempotencyKey: z.string().min(1),
});

const createPollArgsSchema = z.object({
  guildId: z.string(),
  channelId: z.string(),
  question: z.string().min(1).max(POLL_QUESTION_MAX),
  answers: z
    .array(z.string().min(1).max(POLL_ANSWER_MAX))
    .min(POLL_ANSWERS_MIN)
    .max(POLL_ANSWERS_MAX),
  durationHours: z.number().int().min(POLL_DURATION_MIN_HOURS).max(POLL_DURATION_MAX_HOURS),
  allowMultiselect: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  idempotencyKey: z.string().min(1),
});

/**
 * The loose wire shapes registered with the MCP server. Deliberately
 * without refinements, like `sendMessageParams`: these document the wire
 * types for clients while the strict schemas above stay the single
 * boundary.
 */
export const createEventParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  name: z.string().describe(`Event name, 1 to ${String(EVENT_NAME_MAX)} characters.`),
  description: z.string().optional().describe('Event description, up to 1000 characters.'),
  startAt: z.string().describe('Event start as an ISO-8601 string; must be in the future.'),
  endAt: z
    .string()
    .optional()
    .describe('Event end as an ISO-8601 string; required for external events, after the start.'),
  location: z
    .enum(['voice', 'stage', 'external'])
    .describe('Where the event is hosted: a voice channel, a stage channel, or external.'),
  channel: z
    .string()
    .optional()
    .describe(
      'Voice or stage channel id; required for voice and stage events, forbidden for external.',
    ),
  place: z
    .string()
    .optional()
    .describe('External venue text; required for external events, forbidden otherwise.'),
  dryRun: z.boolean().optional().describe('Record without creating: nothing reaches Discord.'),
  idempotencyKey: z
    .string()
    .describe(
      'Caller-supplied key for this creation; reuse the same value if you retry this call.',
    ),
};

export const editEventParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  eventId: z.string().describe('Event to edit; any scheduled event of this guild.'),
  name: z
    .string()
    .optional()
    .describe(`New event name, 1 to ${String(EVENT_NAME_MAX)} characters.`),
  description: z.string().optional().describe('New event description, up to 1000 characters.'),
  startAt: z
    .string()
    .optional()
    .describe('New start as an ISO-8601 string; must be in the future.'),
  endAt: z.string().optional().describe('New end as an ISO-8601 string; after the start.'),
  channel: z
    .string()
    .optional()
    .describe('Move the event to this voice or stage channel; exclusive with place.'),
  place: z
    .string()
    .optional()
    .describe('Move the event outside Discord to this venue text; exclusive with channel.'),
  dryRun: z.boolean().optional().describe('Record without editing: nothing reaches Discord.'),
  idempotencyKey: z
    .string()
    .describe('Caller-supplied key for this edit; reuse the same value if you retry this call.'),
};

export const cancelEventParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  eventId: z.string().describe('Event to cancel; any scheduled event of this guild.'),
  dryRun: z.boolean().optional().describe('Record without cancelling: nothing reaches Discord.'),
  idempotencyKey: z
    .string()
    .describe(
      'Caller-supplied key for this cancellation; reuse the same value if you retry this call.',
    ),
};

export const createPollParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  channelId: z
    .string()
    .describe('Channel to post the poll into; the owner must have allowlisted it for this guild.'),
  question: z
    .string()
    .describe(`Poll question, 1 to ${String(POLL_QUESTION_MAX)} characters. Polls never ping.`),
  answers: z
    .array(z.string())
    .describe(
      `2 to ${String(POLL_ANSWERS_MAX)} answers, each 1 to ${String(POLL_ANSWER_MAX)} characters.`,
    ),
  durationHours: z
    .number()
    .describe(
      `Hours the poll stays open, ${String(POLL_DURATION_MIN_HOURS)} to ${String(POLL_DURATION_MAX_HOURS)}.`,
    ),
  allowMultiselect: z
    .boolean()
    .optional()
    .describe('Whether voters may pick several answers. Defaults to false.'),
  dryRun: z.boolean().optional().describe('Record without posting: nothing reaches Discord.'),
  idempotencyKey: z
    .string()
    .describe('Caller-supplied key for this poll; reuse the same value if you retry this call.'),
};

/** Which tool is rendering, for the verbs and budget words below. */
type EventWriteKind = 'create-event' | 'edit-event' | 'cancel-event' | 'create-poll';

const refuse = (): EventWriteOutcomeText => ({ ok: false, message: GUILD_REFUSAL_MESSAGE });

const refuseInvalidArgs = (): EventWriteOutcomeText => ({
  ok: false,
  message: INVALID_ARGUMENTS_MESSAGE,
});

/**
 * Every refusal renders distinctly and actionably: the operator reading it
 * knows what stopped the write and what to do next. No two reasons share a
 * string (pinned by test), and none echoes event or poll content — ids only.
 * `nothingHappened` names what did not occur, per tool.
 */
const refusalText = (
  kind: EventWriteKind,
  guildId: GuildId,
  target: { readonly channelId?: string | undefined; readonly eventId?: string | undefined },
  reason: McpEventWriteRefusal,
  detail: string | undefined,
  nothingHappened: string,
): string => {
  const channelId = target.channelId ?? 'the event channel';
  switch (reason) {
    case 'channel-not-allowlisted':
      return (
        `Channel ${channelId} in guild ${guildId} is not on the send allowlist, ` +
        `so ${nothingHappened}. The owner can allow it with ` +
        `\`bananasaurs mcp allow-channel ${channelId} --guild ${guildId} --confirm\`, then retry this call.`
      );
    case 'channel-not-in-guild':
      return (
        `Channel ${channelId} in guild ${guildId} is not a channel this guild's bot can see, ` +
        `so ${nothingHappened}. Allowlisting it will not help: ` +
        `\`bananasaurs mcp allow-channel ${channelId} --guild ${guildId} --confirm\` would refuse the same id. ` +
        'If the channel was already allowlisted, the bot may not see it yet ' +
        '(for example right after a restart) — wait a moment and retry this call.'
      );
    case 'private-thread':
      return (
        `Channel ${channelId} in guild ${guildId} is a private thread, so ${nothingHappened}. ` +
        'Private threads never inherit send authorization.'
      );
    case 'bot-lacks-permission':
      // External events carry no channel: the missing permission is the
      // guild-level ManageEvents grant, named on the guild rather than a
      // channel. Voice and stage events name the channel instead.
      if (target.channelId === undefined) {
        return (
          `The bot lacks the ${detail ?? 'ManageEvents'} Discord permission ` +
          `in guild ${guildId}, so ${nothingHappened}. An operator who can edit ` +
          "the guild's roles can grant it, then retry this call."
        );
      }
      return (
        `The bot lacks the ${detail ?? 'needed'} Discord permission in channel ${channelId} ` +
        `in guild ${guildId}, so ${nothingHappened}. An operator who can edit the channel's ` +
        'permission overwrites can grant it, then retry this call.'
      );
    case 'event-not-found':
      return (
        `Event ${target.eventId ?? '?'} in guild ${guildId} was not found, ` +
        `so ${nothingHappened}. Only events of this guild can be changed: ` +
        'check the event id and retry this call.'
      );
    case 'not-voice-or-stage':
      return (
        `Channel ${channelId} in guild ${guildId} is not a voice or stage channel, ` +
        `so ${nothingHappened}. Pass a voice or stage channel, ` +
        'or leave the channel out and pass a place for an external event.'
      );
    case 'killswitch':
      return (
        `The kill switch is on for guild ${guildId}, so ${nothingHappened}. ` +
        'Event and poll writes stay paused until an operator turns it off; do not retry in a loop.'
      );
    case 'breaker-open':
      return (
        `The circuit breaker is open for guild ${guildId} after repeated Discord faults, ` +
        `so ${nothingHappened}. Wait for an operator to clear it; do not retry in a loop.`
      );
    case 'rate-cap':
      // Events share the 100-per-hour structure group; polls share the
      // 300-per-hour message group (cap groups, ADR 0116 §6).
      return kind === 'create-poll'
        ? `Guild ${guildId} has used its message budget of 300 sends per rolling hour, ` +
            `so ${nothingHappened}. Wait for the window to pass before retrying` +
            `${detail !== undefined ? ` (resets at ${detail})` : ''}; ` +
            'answering an already-recorded idempotency key still works meanwhile.'
        : `Guild ${guildId} has used its structure budget of 100 event changes per rolling hour, ` +
            `so ${nothingHappened}. Wait for the window to pass before retrying` +
            `${detail !== undefined ? ` (resets at ${detail})` : ''}; ` +
            'answering an already-recorded idempotency key still works meanwhile.';
    case 'duplicate-key-different-content':
      return (
        `That idempotency key was already used for a different write in guild ${guildId}, ` +
        'so nothing new was created or changed. To write this, retry with a fresh key; ' +
        'the earlier write under the old key is unaffected.'
      );
    case 'duplicate-content-recently':
      return (
        `The same write already ran in guild ${guildId} within the last minute, ` +
        'so nothing new was created or changed. Wait a minute or vary the arguments, then retry with a fresh key.'
      );
  }
};

/**
 * Trims caller text the way `send_message` does: blank-after-trim is an
 * argument fault. The blank flag is separate from the text so an event
 * whose whole name is the word "blank" still posts.
 */
const trimmedText = (
  value: string | undefined,
): { readonly text: string | undefined; readonly blank: boolean } => {
  if (value === undefined) return { text: undefined, blank: false };
  const trimmed = value.trim();
  return trimmed === '' ? { text: undefined, blank: true } : { text: trimmed, blank: false };
};

const NOTHING_HAPPENED: Record<EventWriteKind, string> = {
  'create-event': 'no event was created',
  'edit-event': 'the event is unchanged',
  'cancel-event': 'the event was not cancelled',
  'create-poll': 'nothing was posted',
};

const renderOutcome = (
  kind: EventWriteKind,
  guildId: GuildId,
  target: { readonly channelId?: string | undefined; readonly eventId?: string | undefined },
  outcome: McpEventWriteOutcome,
): EventWriteOutcomeText => {
  const nothingHappened = NOTHING_HAPPENED[kind];
  switch (outcome.status) {
    case 'done': {
      switch (kind) {
        case 'create-event': {
          if (outcome.eventId === undefined) return refuse();
          return {
            ok: true,
            text:
              `Created event ${outcome.eventId} in guild ${guildId} ` +
              `(action ${outcome.actionId}). Event creation cannot be undone: ` +
              `to remove the event, call \`${CANCEL_EVENT_TOOL_NAME}\` with eventId ${outcome.eventId}.`,
          };
        }
        case 'edit-event':
          return {
            ok: true,
            text:
              `Edited event ${target.eventId ?? '?'} in guild ${guildId} ` +
              `(action ${outcome.actionId}). The previous values were kept for undo.` +
              (outcome.endTimeNotCovered === true
                ? ' The end time is not covered by undo: the event had no end time ' +
                  'before this edit, and Discord does not allow clearing an end time.'
                : ''),
          };
        case 'cancel-event':
          return {
            ok: true,
            text:
              `Cancelled event ${target.eventId ?? '?'} in guild ${guildId} ` +
              `(action ${outcome.actionId}). A cancelled event cannot be un-cancelled in Discord.`,
          };
        case 'create-poll': {
          if (outcome.messageId === undefined) return refuse();
          return {
            ok: true,
            text:
              `Sent poll message ${outcome.messageId} to channel ${target.channelId ?? '?'} ` +
              `in guild ${guildId} (action ${outcome.actionId}).`,
          };
        }
      }
      break;
    }
    case 'dry-run':
      return {
        ok: true,
        text:
          `Dry run is on for guild ${guildId}: ` +
          `${nothingHappened}. The write was recorded ` +
          `as action ${outcome.actionId} under its idempotency key but no Discord call was made.`,
      };
    case 'replayed':
      // Not a failure: the write is already handled under this key and
      // nothing new changed — ok:true, no failure language. Event ids are
      // never stored (the ledger has no event-id column), so a replay names
      // the action, while a poll replay names the message like any send.
      if (outcome.messageId !== undefined) {
        return {
          ok: true,
          text:
            `Already sent under this idempotency key as message ${outcome.messageId} ` +
            `(action ${outcome.actionId}): ${nothingHappened} by this call.`,
        };
      }
      return {
        ok: true,
        text:
          `Already recorded under this idempotency key as action ${outcome.actionId}: ` +
          `${nothingHappened} by this call.`,
      };
    case 'refused':
      return {
        ok: false,
        message: refusalText(
          kind,
          guildId,
          target,
          outcome.reason,
          outcome.detail,
          nothingHappened,
        ),
      };
    case 'failed':
      return {
        ok: false,
        message:
          `The Discord call in guild ${guildId} ` +
          'failed with an unknown result: the event or poll ' +
          'may or may not have been changed. Check before retrying, ' +
          'and retry with the same idempotency key — never a fresh one.',
      };
  }
};

/**
 * Never throws and never rejects: a malformed argument is the
 * argument-fault message, and anything unexpected (a port fault, which
 * cannot carry event or poll content outward from here) is the shared
 * refusal rather than an exception out of the handler. The two messages are
 * deliberately different (ruling M4-D18).
 */
export const createEventText = async (
  principal: McpPrincipal,
  port: McpEventWritesPort,
  rawArgs: unknown,
): Promise<EventWriteOutcomeText> => {
  try {
    const parsed = createEventArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return refuseInvalidArgs();
    const input = parsed.data;
    const { text: name, blank: nameBlank } = trimmedText(input.name);
    if (name === undefined || nameBlank) return refuseInvalidArgs();
    const { text: description, blank: descriptionBlank } = trimmedText(input.description);
    if (descriptionBlank) return refuseInvalidArgs();
    const { text: place, blank: placeBlank } = trimmedText(input.place);
    if (placeBlank) return refuseInvalidArgs();
    if (input.channel !== undefined && !idsAreWellFormed([input.channel])) {
      return refuseInvalidArgs();
    }
    // The schema's refinements already parsed the times and placed them in
    // the future in the right order; re-parse without a throw.
    const startAt = parseIsoMs(input.startAt);
    const endAt = input.endAt === undefined ? undefined : parseIsoMs(input.endAt);
    if (startAt === undefined || (input.endAt !== undefined && endAt === undefined)) {
      return refuseInvalidArgs();
    }
    const gate = requireReachableGuild(principal, input.guildId);
    if (!gate.ok) return { ok: false, message: gate.message };
    const location: EventLocationInput =
      input.location === 'external'
        ? { kind: 'external', place: place ?? '' }
        : { kind: input.location, channelId: input.channel ?? '' };
    const outcome = await port.createEvent(gate.guildId, {
      name,
      description,
      startAt,
      endAt,
      location,
      dryRun: input.dryRun ?? false,
      idempotencyKey: input.idempotencyKey,
    });
    return renderOutcome(
      'create-event',
      gate.guildId,
      input.channel === undefined ? {} : { channelId: input.channel },
      outcome,
    );
  } catch {
    return refuse();
  }
};

export const editEventText = async (
  principal: McpPrincipal,
  port: McpEventWritesPort,
  rawArgs: unknown,
): Promise<EventWriteOutcomeText> => {
  try {
    const parsed = editEventArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return refuseInvalidArgs();
    const input = parsed.data;
    if (!idsAreWellFormed([input.eventId])) return refuseInvalidArgs();
    if (input.channel !== undefined && !idsAreWellFormed([input.channel])) {
      return refuseInvalidArgs();
    }
    const { text: name, blank: nameBlank } = trimmedText(input.name);
    if (nameBlank) return refuseInvalidArgs();
    const { text: description, blank: descriptionBlank } = trimmedText(input.description);
    if (descriptionBlank) return refuseInvalidArgs();
    const { text: place, blank: placeBlank } = trimmedText(input.place);
    if (placeBlank) return refuseInvalidArgs();
    const startAt = input.startAt === undefined ? undefined : parseIsoMs(input.startAt);
    if (input.startAt !== undefined && startAt === undefined) return refuseInvalidArgs();
    const endAt = input.endAt === undefined ? undefined : parseIsoMs(input.endAt);
    if (input.endAt !== undefined && endAt === undefined) return refuseInvalidArgs();
    const gate = requireReachableGuild(principal, input.guildId);
    if (!gate.ok) return { ok: false, message: gate.message };
    // A move names only the channel or the venue: the daemon resolves
    // voice-vs-stage from the channel's live type.
    const location: { readonly channelId: string } | { readonly place: string } | undefined =
      input.channel !== undefined
        ? { channelId: input.channel }
        : input.place !== undefined && place !== undefined
          ? { place }
          : undefined;
    // A present-but-blank place already refused above; a present channel
    // with a blank place is impossible (the schema forbids both together).
    if (input.place !== undefined && place === undefined) return refuseInvalidArgs();
    const outcome = await port.editEvent(gate.guildId, {
      eventId: input.eventId,
      name,
      description,
      startAt,
      endAt,
      location,
      dryRun: input.dryRun ?? false,
      idempotencyKey: input.idempotencyKey,
    });
    return renderOutcome('edit-event', gate.guildId, { eventId: input.eventId }, outcome);
  } catch {
    return refuse();
  }
};

export const cancelEventText = async (
  principal: McpPrincipal,
  port: McpEventWritesPort,
  rawArgs: unknown,
): Promise<EventWriteOutcomeText> => {
  try {
    const parsed = cancelEventArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return refuseInvalidArgs();
    const input = parsed.data;
    if (!idsAreWellFormed([input.eventId])) return refuseInvalidArgs();
    const gate = requireReachableGuild(principal, input.guildId);
    if (!gate.ok) return { ok: false, message: gate.message };
    const outcome = await port.cancelEvent(gate.guildId, {
      eventId: input.eventId,
      dryRun: input.dryRun ?? false,
      idempotencyKey: input.idempotencyKey,
    });
    return renderOutcome('cancel-event', gate.guildId, { eventId: input.eventId }, outcome);
  } catch {
    return refuse();
  }
};

export const createPollText = async (
  principal: McpPrincipal,
  port: McpEventWritesPort,
  rawArgs: unknown,
): Promise<EventWriteOutcomeText> => {
  try {
    const parsed = createPollArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return refuseInvalidArgs();
    const input = parsed.data;
    const { text: question, blank: questionBlank } = trimmedText(input.question);
    if (question === undefined || questionBlank) return refuseInvalidArgs();
    const answers: string[] = [];
    for (const answer of input.answers) {
      const { text, blank } = trimmedText(answer);
      if (text === undefined || blank) return refuseInvalidArgs();
      answers.push(text);
    }
    if (!idsAreWellFormed([input.channelId])) return refuseInvalidArgs();
    const gate = requireReachableGuild(principal, input.guildId);
    if (!gate.ok) return { ok: false, message: gate.message };
    const outcome = await port.createPoll(gate.guildId, {
      channelId: input.channelId,
      question,
      answers,
      durationHours: input.durationHours,
      allowMultiselect: input.allowMultiselect ?? false,
      dryRun: input.dryRun ?? false,
      idempotencyKey: input.idempotencyKey,
    });
    return renderOutcome('create-poll', gate.guildId, { channelId: input.channelId }, outcome);
  } catch {
    return refuse();
  }
};
