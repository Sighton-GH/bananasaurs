import { z } from 'zod';
import { reminderRecurrence, type GuildId, type ReminderRecurrence } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';
import { idsAreWellFormed } from '../ids.js';
import { envelope, type EvidenceItem } from '../envelope.js';
import { MCP_READ_LIST_SCHEDULED, type McpReadRecord } from '../read-audit.js';
import {
  notPingedText,
  SEND_CONTENT_MAX,
  SEND_PING_ROLES_MAX,
  SEND_PING_USERS_MAX,
  type McpNotPinged,
} from './send.js';

/** Scheduled text is checked again at delivery, so the report is "as of now". */
const SCHEDULED_NOT_PINGED_LEAD = 'As of now, these mentions in the text would not ping';

/**
 * The schedule handlers, registered under the send scope: scheduling a
 * fixed-text send, listing the connector's own outbox, and editing or
 * cancelling a scheduled send behind `update_scheduled` (see
 * `pair-tools.ts` for the merged tool). Storage is the existing `assistant_reminders`
 * table with `origin='mcp'` (ADR 0119); the daemon's reminder worker
 * delivers the rows, and this task never touches delivery.
 *
 * The same five steps as `send_message` in `send.ts` — Zod parse →
 * `requireReachableGuild` → port call → render — so hard rule 3 holds by
 * construction, and the same two-message contract (ruling M4-D18): a parse
 * failure is the argument-fault message, a guild the caller cannot reach or
 * a throw out of the port is the shared refusal. No tool here throws, and no
 * log line anywhere here carries scheduled content (CLAUDE.md rule 4 — this
 * module does not log at all, and the rendered outcomes name channels and
 * reminder ids, never content beyond the capped `list_scheduled` preview,
 * which travels inside the evidence envelope like every other stored-text
 * read).
 *
 * This module holds no allowlist handle of any kind, for the same reason
 * `send.ts` holds none: the daemon's target resolution owns the allowlist
 * check, the live permission check and the ledger, and this package's port
 * projects its outcomes field by field.
 *
 * Every write goes through `runMcpAction` on the daemon side: creates with
 * kind `schedule.create` in cap group `message`, edits and cancels with
 * kinds `schedule.edit` / `schedule.cancel` in cap group `edit`. Only edits
 * and cancels record an undo — a fresh send points at `update_scheduled`
 * instead, which is what the create text says.
 */

/** Scheduled text shares the 2000-character Discord limit with `send_message`. */
export const SCHEDULE_CONTENT_MAX = SEND_CONTENT_MAX;
/** The `list_scheduled` content preview is capped at 100 characters. */
export const SCHEDULE_PREVIEW_MAX = 100;
/** `list_scheduled` shows at most this many rows per call. */
export const LIST_SCHEDULED_LIMIT_MAX = 100;
/** `list_scheduled` shows this many rows when the caller passes no limit. */
export const LIST_SCHEDULED_DEFAULT_LIMIT = 20;
/**
 * A past `at` is refused, with a small grace for clock skew between the
 * caller and the daemon: 30 seconds, as the brief allows.
 */
export const SCHEDULE_PAST_GRACE_MS = 30_000;

export const SCHEDULE_MESSAGE_TOOL_NAME = 'schedule_message';
export const SCHEDULE_MESSAGE_TOOL_DESCRIPTION =
  'Schedules one fixed-text message to a channel where Write is on for this guild, ' +
  'or into a thread under one; the existing reminder worker posts it when it falls due. ' +
  'Takes a channel id or name, content up to ' +
  `${String(SCHEDULE_CONTENT_MAX)} characters, and exactly one of at ` +
  '(an ISO-8601 string or epoch milliseconds, must be in the future) or recurrence ' +
  '(a daily, weekdays, weekly or monthly pattern with a time zone). ' +
  'Member (<@USER_ID>) and role (<@&ROLE_ID>) mentions typed into the content ping when it is sent, ' +
  'checked against the guild ping policy then; @everyone and @here never ping. ' +
  'pingRoles/pingUsers add pings strictly: a bad one there refuses the call when scheduled. ' +
  'Scheduling cannot be undone: to remove the send, call update_scheduled with action cancel and its reminder id. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call ' +
  '(for example after a timeout): a new key on a retry will schedule the message twice. ' +
  'Pass dryRun to record without storing. ' +
  'Refuses when the guild is unreachable, the time is in the past, the channel does not have Write on, or the bot lacks the Discord permission.';

export const LIST_SCHEDULED_TOOL_NAME = 'list_scheduled';
export const LIST_SCHEDULED_TOOL_DESCRIPTION =
  "Lists this connector's own scheduled sends in this guild — reminder ids, due times, " +
  'recurrence, status and channel, with the first 100 characters of each text as evidence. ' +
  'Assistant reminders set in chat never appear here. Read-only.';

/** The statuses `list_scheduled` can filter on — the reminder lifecycle. */
export type ScheduleStatusFilter =
  'scheduled' | 'delivering' | 'delivered' | 'cancelled' | 'failed';

/**
 * One outbox row as `list_scheduled` shows it. `recurrence` is the daemon's
 * summary — `'one-shot'`, or the pattern kind with its time zone — and
 * `preview` is the stored text capped at `SCHEDULE_PREVIEW_MAX` characters.
 */
export interface McpScheduledView {
  readonly reminderId: string;
  readonly channelId: string;
  readonly dueAt: number;
  readonly recurrence: string;
  readonly status: string;
  readonly preview: string;
}

/** What the daemon's schedule wiring must satisfy (implemented over `runMcpAction`). */
export interface McpSchedulePort {
  readonly scheduleMessage: (
    guildId: GuildId,
    input: {
      /** Destination channel or thread, as an id or a name; the daemon resolves it. */
      readonly channel: string;
      readonly content: string;
      /** One-shot fire time, exactly one of `at` / `recurrence`. */
      readonly at: string | number | undefined;
      readonly recurrence: ReminderRecurrence | undefined;
      readonly pingRoles: readonly string[];
      readonly pingUsers: readonly string[];
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpScheduleOutcome>;
  readonly listScheduled: (
    guildId: GuildId,
    input: { readonly status: ScheduleStatusFilter | undefined; readonly limit: number },
  ) => readonly McpScheduledView[];
  readonly editScheduled: (
    guildId: GuildId,
    input: {
      readonly reminderId: string;
      readonly content: string | undefined;
      readonly at: string | number | undefined;
      readonly recurrence: ReminderRecurrence | undefined;
      readonly pingRoles: readonly string[] | undefined;
      readonly pingUsers: readonly string[] | undefined;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpScheduleOutcome>;
  readonly cancelScheduled: (
    guildId: GuildId,
    input: {
      readonly reminderId: string;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpScheduleOutcome>;
}

/** Mirrors the gateway's outcomes, named in this package's own vocabulary. */
export type McpScheduleOutcome =
  | {
      readonly status: 'done';
      readonly actionId: string;
      readonly reminderId?: string | undefined;
      /** Text mentions that would not ping as of this call (ADR 0128 §5). */
      readonly notPinged?: readonly McpNotPinged[] | undefined;
    }
  | {
      readonly status: 'dry-run';
      readonly actionId: string;
      readonly notPinged?: readonly McpNotPinged[] | undefined;
    }
  | { readonly status: 'replayed'; readonly actionId: string }
  | { readonly status: 'refused'; readonly reason: McpScheduleRefusal; readonly detail?: string }
  | { readonly status: 'failed' };

export type McpScheduleRefusal =
  | 'channel-not-allowlisted'
  | 'channel-not-in-guild'
  | 'ambiguous-channel'
  | 'bot-lacks-permission'
  | 'role-unknown'
  | 'role-dangerous'
  | 'role-managed-or-everyone'
  | 'role-above-bot'
  | 'role-not-allowlisted'
  | 'user-not-member'
  | 'past-due'
  | 'reminder-not-found'
  | 'reminder-not-editable'
  | 'killswitch'
  | 'breaker-open'
  | 'rate-cap'
  | 'duplicate-key-different-content'
  | 'duplicate-content-recently';

export type ScheduleOutcomeText =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

export type ListScheduledOutcomeText =
  | { readonly ok: true; readonly text: string; readonly read: McpReadRecord }
  | { readonly ok: false; readonly message: string };

/**
 * An `at` to epoch ms, or undefined when it parses to nothing: numbers are
 * epoch ms outright, strings go through `Date.parse`. A numeric string is
 * neither — it is not an ISO string — so it faults rather than guessing.
 * Shared with the daemon, which re-parses authoritatively on its own clock.
 */
export const parseScheduleAt = (at: string | number): number | undefined => {
  if (typeof at === 'number') return Number.isFinite(at) ? Math.floor(at) : undefined;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? undefined : ms;
};

/**
 * Zod schemas are the boundary (hard rule 3). A parse failure is the
 * argument-fault message (ruling M4-D18), never a throw: the parse runs
 * before the guild gate, so it has consulted nothing about which guilds
 * exist. `guildId` is a bare string on purpose, like `send.ts`: the gate
 * parses it and refuses malformed and unreachable identically. `channel`
 * takes an id or a name, like the thread tools' `channel`, so it is never a
 * snowflake check here — the daemon resolves it against the live guild.
 * `reminderId` is opaque ledger vocabulary (a UUID this connector minted),
 * checked only for non-emptiness here — existence is the daemon's answer.
 *
 * `at` and `recurrence` are mutually exclusive, and exactly one is required
 * on creation; an edit needs at least one changed field. Past-ness is the
 * daemon's answer on its own clock, not the schema's: the schema checks only
 * that `at` parses.
 */
const scheduleArgsSchema = z
  .object({
    guildId: z.string(),
    channel: z.string().min(1),
    content: z.string().min(1).max(SCHEDULE_CONTENT_MAX),
    at: z.union([z.string().min(1), z.number()]).optional(),
    recurrence: reminderRecurrence.optional(),
    pingRoles: z.array(z.string().min(1)).max(SEND_PING_ROLES_MAX).optional(),
    pingUsers: z.array(z.string().min(1)).max(SEND_PING_USERS_MAX).optional(),
    dryRun: z.boolean().optional(),
    idempotencyKey: z.string().min(1),
  })
  .superRefine((args, ctx) => {
    if (args.at === undefined && args.recurrence === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'either at or recurrence is required' });
    }
    if (args.at !== undefined && args.recurrence !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at and recurrence are exclusive' });
    }
    if (args.at !== undefined && parseScheduleAt(args.at) === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at must be an ISO-8601 string or epoch milliseconds',
      });
    }
  });

const editScheduledArgsSchema = z
  .object({
    guildId: z.string(),
    reminderId: z.string().min(1).max(128),
    content: z.string().min(1).max(SCHEDULE_CONTENT_MAX).optional(),
    at: z.union([z.string().min(1), z.number()]).optional(),
    recurrence: reminderRecurrence.optional(),
    pingRoles: z.array(z.string().min(1)).max(SEND_PING_ROLES_MAX).optional(),
    pingUsers: z.array(z.string().min(1)).max(SEND_PING_USERS_MAX).optional(),
    dryRun: z.boolean().optional(),
    idempotencyKey: z.string().min(1),
  })
  .superRefine((args, ctx) => {
    if (
      args.content === undefined &&
      args.at === undefined &&
      args.recurrence === undefined &&
      args.pingRoles === undefined &&
      args.pingUsers === undefined
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at least one field to change' });
    }
    if (args.at !== undefined && args.recurrence !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at and recurrence are exclusive' });
    }
    if (args.at !== undefined && parseScheduleAt(args.at) === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at must be an ISO-8601 string or epoch milliseconds',
      });
    }
  });

const cancelScheduledArgsSchema = z.object({
  guildId: z.string(),
  reminderId: z.string().min(1).max(128),
  dryRun: z.boolean().optional(),
  idempotencyKey: z.string().min(1),
});

const listScheduledArgsSchema = z.object({
  guildId: z.string(),
  status: z.enum(['scheduled', 'delivering', 'delivered', 'cancelled', 'failed']).optional(),
  limit: z.number().int().min(1).max(LIST_SCHEDULED_LIMIT_MAX).optional(),
});

/**
 * The loose wire shapes registered with the MCP server. Deliberately
 * without refinements, like `sendMessageParams`: these document the wire
 * types for clients while the strict schemas above stay the single
 * boundary. The recurrence shape is the stored `reminderRecurrence` itself —
 * the conversion drops its refinements, which the strict schema re-checks.
 */
export const scheduleMessageParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  channel: z
    .string()
    .describe(
      'Channel or thread to post into when due, as an id or name; Write must be on for it.',
    ),
  content: z
    .string()
    .describe(
      `Message text in Discord Markdown, 1 to ${String(SCHEDULE_CONTENT_MAX)} characters. <@USER_ID> and <@&ROLE_ID> mentions ping under the guild ping policy; @everyone and @here never do.`,
    ),
  at: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      'One-shot fire time as an ISO-8601 string or epoch milliseconds; must be in the future. Exactly one of at or recurrence is required.',
    ),
  recurrence: reminderRecurrence
    .optional()
    .describe(
      'Recurring pattern (daily, weekdays, weekly or monthly) with a time zone; the first send is the next occurrence. Exactly one of at or recurrence is required.',
    ),
  pingRoles: z
    .array(z.string())
    .optional()
    .describe(
      'Up to 10 roles to ping, as names or ids; each is checked against the guild ping policy when scheduled.',
    ),
  pingUsers: z
    .array(z.string())
    .optional()
    .describe('Up to 25 guild members to ping, as ids; each must be a current member.'),
  dryRun: z.boolean().optional().describe('Record without storing: nothing is scheduled.'),
  idempotencyKey: z
    .string()
    .describe(
      'Caller-supplied key for this scheduling; reuse the same value if you retry this call.',
    ),
};

export const listScheduledParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  status: z
    .enum(['scheduled', 'delivering', 'delivered', 'cancelled', 'failed'])
    .optional()
    .describe('Only rows in this reminder state. Defaults to every state.'),
  limit: z
    .number()
    .optional()
    .describe(
      `Newest rows to show, 1 to ${String(LIST_SCHEDULED_LIMIT_MAX)}. Defaults to ${String(LIST_SCHEDULED_DEFAULT_LIMIT)}.`,
    ),
};

/** Which tool is rendering, for the verbs and budget words below. */
type ScheduleKind = 'schedule' | 'edit' | 'cancel';

const refuse = (): ScheduleOutcomeText => ({ ok: false, message: GUILD_REFUSAL_MESSAGE });

const refuseInvalidArgs = (): ScheduleOutcomeText => ({
  ok: false,
  message: INVALID_ARGUMENTS_MESSAGE,
});

/**
 * Every refusal renders distinctly and actionably: the operator reading it
 * knows what stopped the write and what to do next. No two reasons share a
 * string within one tool (pinned by test), and none echoes scheduled
 * content — ids only. `nothingHappened` names what did not occur, per tool.
 */
const refusalText = (
  kind: ScheduleKind,
  guildId: GuildId,
  target: { readonly channel?: string | undefined; readonly reminderId?: string | undefined },
  reason: McpScheduleRefusal,
  detail: string | undefined,
  nothingHappened: string,
): string => {
  const channel = target.channel ?? 'the scheduled channel';
  switch (reason) {
    case 'channel-not-allowlisted':
      return (
        `Channel ${channel} in guild ${guildId} is not on the send allowlist, ` +
        `so ${nothingHappened}. The owner can allow it with ` +
        `\`bananasaurs mcp allow-channel ${channel} --guild ${guildId} --confirm\`, then retry this call.`
      );
    case 'channel-not-in-guild':
      return (
        `Channel ${channel} in guild ${guildId} is not a channel this guild's bot can see, ` +
        `so ${nothingHappened}. Allowlisting it will not help: ` +
        `\`bananasaurs mcp allow-channel ${channel} --guild ${guildId} --confirm\` would refuse the same id. ` +
        'If the channel was already allowlisted, the bot may not see it yet ' +
        '(for example right after a restart) — wait a moment and retry this call.'
      );
    case 'ambiguous-channel':
      return (
        `"${channel}" matches several channels in guild ${guildId} (${detail ?? 'unlisted'}), ` +
        `so ${nothingHappened}. Pass a channel id instead of a name.`
      );
    case 'bot-lacks-permission':
      return (
        `The bot lacks the ${detail ?? 'needed'} Discord permission in channel ${channel} ` +
        `in guild ${guildId}, so ${nothingHappened}. An operator who can edit the channel's ` +
        'permission overwrites can grant it, then retry this call.'
      );
    case 'role-unknown':
      return (
        `No role matching "${detail ?? '?'}" in guild ${guildId}, ` +
        `so ${nothingHappened}. List roles with \`list_roles\` and retry with an id or exact name.`
      );
    case 'role-dangerous':
      return (
        `Role ${detail ?? '?'} in guild ${guildId} holds a permission the ping policy never allows, ` +
        `so ${nothingHappened} and nobody was pinged.`
      );
    case 'role-managed-or-everyone':
      return (
        `Role ${detail ?? '?'} in guild ${guildId} is managed or @everyone, which can never be pinged, ` +
        `so ${nothingHappened}.`
      );
    case 'role-above-bot':
      return (
        `Role ${detail ?? '?'} in guild ${guildId} sits at or above the bot's highest role, ` +
        `so ${nothingHappened} and nobody was pinged.`
      );
    case 'role-not-allowlisted':
      return (
        `Role ${detail ?? '?'} is not on the ping allowlist for guild ${guildId}, ` +
        `so ${nothingHappened} and nobody was pinged.`
      );
    case 'user-not-member':
      return (
        `User ${detail ?? '?'} is not a member of guild ${guildId}, ` +
        `so ${nothingHappened} and nobody was pinged.`
      );
    case 'past-due':
      if (detail === 'recurrence-ended') {
        return (
          `The recurrence already ended, so nothing was scheduled in guild ${guildId}. ` +
          'Pass a recurrence that still has an occurrence ahead of now.'
        );
      }
      return (
        `The scheduled time is in the past in guild ${guildId}, ` +
        `so ${nothingHappened}. Pass a future time — an ISO-8601 string or epoch milliseconds.`
      );
    case 'reminder-not-found':
      return (
        `No scheduled message ${target.reminderId ?? '?'} in guild ${guildId}, ` +
        `so ${nothingHappened}. Only this connector's own scheduled sends can be changed here: ` +
        'assistant reminders set in chat never appear. ' +
        `Check the id with \`${LIST_SCHEDULED_TOOL_NAME}\`.`
      );
    case 'reminder-not-editable':
      return (
        `Scheduled message ${target.reminderId ?? '?'} in guild ${guildId} is no longer scheduled, ` +
        `so ${nothingHappened}. Only a message still waiting to send can be changed.`
      );
    case 'killswitch':
      return (
        `The kill switch is on for guild ${guildId}, so ${nothingHappened}. ` +
        'Scheduling stays paused until an operator turns it off; do not retry in a loop.'
      );
    case 'breaker-open':
      return (
        `The circuit breaker is open for guild ${guildId} after repeated Discord faults, ` +
        `so ${nothingHappened}. Wait for an operator to clear it; do not retry in a loop.`
      );
    case 'rate-cap':
      // Creates share the message cap group; edits and cancels share the
      // edit group (ADR 0116 §6). Both caps are owner-tunable settings (ADR
      // 0119 §4), so the text names the setting rather than a number.
      return kind === 'schedule'
        ? `Guild ${guildId} has used its rolling-hour message budget (setting mcp.cap.message), ` +
            `so ${nothingHappened}. Wait for the window to pass before retrying` +
            `${detail !== undefined ? ` (resets at ${detail})` : ''}; ` +
            'answering an already-recorded idempotency key still works meanwhile.'
        : `Guild ${guildId} has used its rolling-hour edit budget (setting mcp.cap.edit), ` +
            `so ${nothingHappened}. Wait for the window to pass before retrying` +
            `${detail !== undefined ? ` (resets at ${detail})` : ''}; ` +
            'answering an already-recorded idempotency key still works meanwhile.';
    case 'duplicate-key-different-content':
      return (
        'That idempotency key was already used for a different scheduled write, ' +
        `so ${nothingHappened}. To write this, retry with a fresh key; ` +
        'the earlier write under the old key is unaffected.'
      );
    case 'duplicate-content-recently':
      return (
        `The same write already ran in guild ${guildId} within the last minute, ` +
        `so ${nothingHappened}. Wait a minute or vary the arguments, then retry with a fresh key.`
      );
  }
};

/**
 * Trims caller text the way `send_message` does: blank-after-trim is an
 * argument fault. The blank flag is separate from the text so a message
 * whose whole content is the word "blank" still schedules.
 */
const trimmedText = (
  value: string | undefined,
): { readonly text: string | undefined; readonly blank: boolean } => {
  if (value === undefined) return { text: undefined, blank: false };
  const trimmed = value.trim();
  return trimmed === '' ? { text: undefined, blank: true } : { text: trimmed, blank: false };
};

const NOTHING_HAPPENED: Record<ScheduleKind, string> = {
  schedule: 'nothing was scheduled',
  edit: 'the scheduled message was not edited',
  cancel: 'the scheduled message was not cancelled',
};

/** When the one-shot send fires, from the caller's own `at`. */
const dueDescription = (
  at: string | number | undefined,
  recurrence: ReminderRecurrence | undefined,
): string => {
  if (at !== undefined) {
    const ms = parseScheduleAt(at);
    return ms === undefined ? 'at an unknown time' : `sends at ${new Date(ms).toISOString()}`;
  }
  return `repeats ${recurrence?.pattern.kind ?? 'on its pattern'}`;
};

const renderOutcome = (
  kind: ScheduleKind,
  guildId: GuildId,
  target: { readonly channel?: string | undefined; readonly reminderId?: string | undefined },
  outcome: McpScheduleOutcome,
  timing: string,
): ScheduleOutcomeText => {
  const nothingHappened = NOTHING_HAPPENED[kind];
  switch (outcome.status) {
    case 'done': {
      // The daemon mints the reminder id inside its execute closure, so a
      // `done` without one is an impossible state — the shared refusal, the
      // same answer the sibling tools give their impossible states.
      if (outcome.reminderId === undefined) return refuse();
      switch (kind) {
        case 'schedule':
          return {
            ok: true,
            text:
              `Scheduled message ${outcome.reminderId} to channel ${target.channel ?? '?'} ` +
              `in guild ${guildId} (action ${outcome.actionId}): ${timing}. ` +
              'Scheduling cannot be undone: to remove the send, call ' +
              // ADR 0132 Task 2: the literal new tool name — importing it
              // from `pair-tools.ts` would cycle back into this module.
              '`update_scheduled` with action cancel and reminderId ' +
              `${outcome.reminderId}.` +
              notPingedText(outcome.notPinged, SCHEDULED_NOT_PINGED_LEAD),
          };
        case 'edit':
          return {
            ok: true,
            text:
              `Edited scheduled message ${outcome.reminderId} in guild ${guildId} ` +
              `(action ${outcome.actionId}). The previous values were kept for undo.` +
              notPingedText(outcome.notPinged, SCHEDULED_NOT_PINGED_LEAD),
          };
        case 'cancel':
          return {
            ok: true,
            text:
              `Cancelled scheduled message ${outcome.reminderId} in guild ${guildId} ` +
              `(action ${outcome.actionId}). To restore it while it is still due, ` +
              `call \`undo_action\` with actionId ${outcome.actionId}.`,
          };
      }
      break;
    }
    case 'dry-run':
      return {
        ok: true,
        text:
          `Dry run is on for guild ${guildId}: ` +
          `${nothingHappened}. The write was recorded ` +
          `as action ${outcome.actionId} under its idempotency key but nothing was stored.` +
          notPingedText(outcome.notPinged, SCHEDULED_NOT_PINGED_LEAD),
      };
    case 'replayed':
      // Not a failure: the write is already handled under this key and
      // nothing new changed — ok:true, no failure language. The ledger holds
      // no reminder-id column, so a replay names the action; the model finds
      // the row through `list_scheduled`.
      if (kind === 'schedule') {
        return {
          ok: true,
          text:
            `Already recorded under this idempotency key as action ${outcome.actionId}: ` +
            `${nothingHappened} by this call. ` +
            `Call \`${LIST_SCHEDULED_TOOL_NAME}\` to see the stored send.`,
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
          `The store write in guild ${guildId} ` +
          'failed with an unknown result: the scheduled message ' +
          'may or may not have been stored. ' +
          `Check \`${LIST_SCHEDULED_TOOL_NAME}\` before retrying, ` +
          'and retry with the same idempotency key — never a fresh one.',
      };
  }
};

/**
 * Never throws and never rejects: a malformed argument is the
 * argument-fault message, and anything unexpected (a port fault, which
 * cannot carry scheduled content outward from here) is the shared refusal
 * rather than an exception out of the handler. The two messages are
 * deliberately different (ruling M4-D18).
 */
export const scheduleMessageText = async (
  principal: McpPrincipal,
  port: McpSchedulePort,
  rawArgs: unknown,
): Promise<ScheduleOutcomeText> => {
  try {
    const parsed = scheduleArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return refuseInvalidArgs();
    const input = parsed.data;
    const { text: content, blank } = trimmedText(input.content);
    if (content === undefined || blank) return refuseInvalidArgs();
    if (input.pingUsers !== undefined && !idsAreWellFormed(input.pingUsers)) {
      return refuseInvalidArgs();
    }
    const gate = requireReachableGuild(principal, input.guildId);
    if (!gate.ok) return { ok: false, message: gate.message };
    const outcome = await port.scheduleMessage(gate.guildId, {
      channel: input.channel,
      content,
      at: input.at,
      recurrence: input.recurrence,
      pingRoles: input.pingRoles ?? [],
      pingUsers: input.pingUsers ?? [],
      dryRun: input.dryRun ?? false,
      idempotencyKey: input.idempotencyKey,
    });
    return renderOutcome(
      'schedule',
      gate.guildId,
      { channel: input.channel },
      outcome,
      dueDescription(input.at, input.recurrence),
    );
  } catch {
    return refuse();
  }
};

export const editScheduledText = async (
  principal: McpPrincipal,
  port: McpSchedulePort,
  rawArgs: unknown,
): Promise<ScheduleOutcomeText> => {
  try {
    const parsed = editScheduledArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return refuseInvalidArgs();
    const input = parsed.data;
    const { text: content, blank } = trimmedText(input.content);
    if (blank) return refuseInvalidArgs();
    if (input.pingUsers !== undefined && !idsAreWellFormed(input.pingUsers)) {
      return refuseInvalidArgs();
    }
    const gate = requireReachableGuild(principal, input.guildId);
    if (!gate.ok) return { ok: false, message: gate.message };
    const outcome = await port.editScheduled(gate.guildId, {
      reminderId: input.reminderId,
      content,
      at: input.at,
      recurrence: input.recurrence,
      pingRoles: input.pingRoles,
      pingUsers: input.pingUsers,
      dryRun: input.dryRun ?? false,
      idempotencyKey: input.idempotencyKey,
    });
    return renderOutcome('edit', gate.guildId, { reminderId: input.reminderId }, outcome, '');
  } catch {
    return refuse();
  }
};

export const cancelScheduledText = async (
  principal: McpPrincipal,
  port: McpSchedulePort,
  rawArgs: unknown,
): Promise<ScheduleOutcomeText> => {
  try {
    const parsed = cancelScheduledArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return refuseInvalidArgs();
    const input = parsed.data;
    const gate = requireReachableGuild(principal, input.guildId);
    if (!gate.ok) return { ok: false, message: gate.message };
    const outcome = await port.cancelScheduled(gate.guildId, {
      reminderId: input.reminderId,
      dryRun: input.dryRun ?? false,
      idempotencyKey: input.idempotencyKey,
    });
    return renderOutcome('cancel', gate.guildId, { reminderId: input.reminderId }, outcome, '');
  } catch {
    return refuse();
  }
};

const listScheduledInner = (
  principal: McpPrincipal,
  port: McpSchedulePort,
  rawArgs: unknown,
): ListScheduledOutcomeText => {
  const parsed = listScheduledArgsSchema.safeParse(rawArgs);
  if (parsed.success === false) return { ok: false, message: INVALID_ARGUMENTS_MESSAGE };
  const gate = requireReachableGuild(principal, parsed.data.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const views = port.listScheduled(gate.guildId, {
    status: parsed.data.status,
    limit: parsed.data.limit ?? LIST_SCHEDULED_DEFAULT_LIMIT,
  });
  const read = (resultCount: number): McpReadRecord => ({
    // The owner's own scheduled text is stored content, like the server
    // card: a content read under ADR 0050's split (one audit row).
    kind: 'content',
    action: MCP_READ_LIST_SCHEDULED,
    guildId: gate.guildId,
    subjectType: 'guild',
    subjectId: undefined,
    resultCount,
  });
  if (views.length === 0) {
    return {
      ok: true,
      text: `No scheduled messages in guild ${gate.guildId}.`,
      read: read(0),
    };
  }
  const lines = views.map(
    (view) =>
      `${view.reminderId} | channel ${view.channelId} | ` +
      `sends at ${new Date(view.dueAt).toISOString()} | ${view.recurrence} | ${view.status}`,
  );
  // The preview is the stored text, so it travels inside the evidence
  // envelope — framed as evidence, never as instructions — capped per row
  // here as well as in the port, so an over-supplying port still cannot leak
  // more than the cap into the answer.
  const evidence: readonly EvidenceItem[] = views.map((view) => ({
    authorId: 'owner',
    channelId: view.channelId,
    messageId: view.reminderId,
    timestamp: new Date(view.dueAt).toISOString(),
    content: view.preview.slice(0, SCHEDULE_PREVIEW_MAX),
  }));
  return {
    ok: true,
    text:
      `Scheduled messages in guild ${gate.guildId}: ${String(views.length)} shown (soonest first).\n` +
      `${lines.join('\n')}\n\n${envelope(evidence)}`,
    read: read(views.length),
  };
};

/** Never throws and never rejects: a rejected port call is the shared refusal. */
export const listScheduledText = (
  principal: McpPrincipal,
  port: McpSchedulePort,
  rawArgs: unknown,
): ListScheduledOutcomeText => {
  try {
    return listScheduledInner(principal, port, rawArgs);
  } catch {
    return { ok: false, message: GUILD_REFUSAL_MESSAGE };
  }
};
