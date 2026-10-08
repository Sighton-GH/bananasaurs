import { z } from 'zod';
import type { GuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';
import { idsAreWellFormed } from '../ids.js';
import type { SendEmbed } from './send.js';

/**
 * The message-write handlers, registered under the send scope: editing and
 * deleting the bot's own messages directly, pinning and unpinning any
 * in-scope message behind `set_pin`, and the bot's own reactions behind
 * `react` (see `pair-tools.ts` for the two merged tools).
 *
 * The same five steps as `send_message` in `send.ts` — Zod parse →
 * `requireReachableGuild` → port call → render — so hard rule 3 holds by
 * construction, and the same two-message contract (ruling M4-D18): a parse
 * failure is the argument-fault message, a guild the caller cannot reach or
 * a throw out of the port is the shared refusal. No log line anywhere here
 * carries message content (CLAUDE.md rule 4 — this module does not log at
 * all, and the rendered outcomes name channels and message ids, never
 * content).
 *
 * This module holds no allowlist handle of any kind, for the same reason
 * `send.ts` holds none: the daemon's target resolution owns the allowlist
 * check, the live permission check, the protected-message guard and the
 * authorship check, the safety reads and the ledger, and this package's
 * port projects its outcomes field by field.
 *
 * Every write goes through `runMcpAction` on the daemon side (Task 6 wires
 * each method below through it with its kind and cap group): no tool or
 * port calls a Discord write method any other way.
 */

/** The 2000-character Discord limit — the same limit `send.ts` enforces. */
export const EDIT_CONTENT_MAX = 2000;
/** Discord caps an edit at three embeds, like a post. */
export const EDIT_EMBEDS_MAX = 3;
/** Discord caps an edit's embed text at 6000 characters in total, like a post. */
export const EDIT_EMBED_TOTAL_MAX = 6000;
/** A `name:id` custom emoji reference never needs more than this. */
export const REACTION_EMOJI_MAX = 64;

export const EDIT_MESSAGE_TOOL_NAME = 'edit_message';
export const EDIT_MESSAGE_TOOL_DESCRIPTION =
  'Edits a message the bot authored in an allowlisted channel of this guild. ' +
  'Pass content, embeds, or both; the previous text is kept for undo. ' +
  'Role-panel messages, task posts (anchors and nudges) and messages written by anyone else are refused. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without editing.';

export const DELETE_MESSAGE_TOOL_NAME = 'delete_message';
export const DELETE_MESSAGE_TOOL_DESCRIPTION =
  'Deletes a message the bot authored in an allowlisted channel of this guild. ' +
  'Role-panel messages, task posts (anchors and nudges) and messages written by anyone else are refused. ' +
  'A delete cannot be undone. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without deleting.';

/** What the daemon's message-write wiring must satisfy (Task 6 implements it). */
export interface McpMessageWritesPort {
  readonly edit: (
    guildId: GuildId,
    input: {
      readonly channelId: string;
      readonly messageId: string;
      readonly content: string | undefined;
      readonly embeds: readonly SendEmbed[] | undefined;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpMessageWriteOutcome>;
  readonly delete: (
    guildId: GuildId,
    input: {
      readonly channelId: string;
      readonly messageId: string;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpMessageWriteOutcome>;
  readonly pin: (
    guildId: GuildId,
    input: {
      readonly channelId: string;
      readonly messageId: string;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpMessageWriteOutcome>;
  readonly unpin: (
    guildId: GuildId,
    input: {
      readonly channelId: string;
      readonly messageId: string;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpMessageWriteOutcome>;
  readonly addReaction: (
    guildId: GuildId,
    input: {
      readonly channelId: string;
      readonly messageId: string;
      readonly emoji: string;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpMessageWriteOutcome>;
  readonly removeReaction: (
    guildId: GuildId,
    input: {
      readonly channelId: string;
      readonly messageId: string;
      readonly emoji: string;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpMessageWriteOutcome>;
}

/** Mirrors the gateway's outcomes, named in this package's own vocabulary. */
export type McpMessageWriteOutcome =
  | { readonly status: 'done'; readonly actionId: string; readonly messageId?: string }
  | { readonly status: 'dry-run'; readonly actionId: string }
  | {
      readonly status: 'replayed';
      readonly actionId: string;
      readonly messageId?: string;
    }
  | {
      readonly status: 'refused';
      readonly reason: McpMessageWriteRefusal;
      readonly detail?: string;
    }
  | { readonly status: 'failed' };

export type McpMessageWriteRefusal =
  | 'channel-not-allowlisted'
  | 'channel-not-in-guild'
  | 'bot-lacks-permission'
  | 'protected-role-panel'
  | 'protected-task-post'
  | 'not-bot-authored'
  | 'not-found'
  | 'unknown-emoji'
  | 'killswitch'
  | 'breaker-open'
  | 'rate-cap'
  | 'duplicate-key-different-content'
  | 'duplicate-content-recently';

export type MessageWriteOutcomeText =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

const embedFieldSchema = z
  .object({
    name: z.string().min(1).max(256),
    value: z.string().min(1).max(1024),
    inline: z.boolean().optional(),
  })
  .strict();

const embedSchema = z
  .object({
    title: z.string().min(1).max(256).optional(),
    description: z.string().min(1).max(4096).optional(),
    fields: z.array(embedFieldSchema).max(10).optional(),
    color: z.number().int().min(0).max(0xff_ff_ff).optional(),
    footer: z.string().min(1).max(2048).optional(),
  })
  .strict()
  // An embed with no visible part would 400 at Discord: refuse it here as an
  // argument fault instead of burning a ledger row on it — the same rule
  // `send.ts` applies.
  .refine(
    (embed) =>
      embed.title !== undefined ||
      embed.description !== undefined ||
      (embed.fields !== undefined && embed.fields.length > 0) ||
      embed.footer !== undefined,
    { message: 'embed must have a title, description, field or footer' },
  );

const embedTotalLength = (embed: z.infer<typeof embedSchema>): number =>
  (embed.title ?? '').length +
  (embed.description ?? '').length +
  (embed.footer ?? '').length +
  (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);

/**
 * A custom emoji reference is `name:id` — the angle-fenced `<:name:id>`
 * Discord clients render is not accepted, so a pasted reaction string fails
 * here with the argument fault and its shape tells the model the right one.
 * Anything without a colon is passed through as a unicode emoji: there is
 * no local table of every unicode emoji, so Discord itself decides at call
 * time and a non-emoji answers as a failed call, honestly reported.
 */
const CUSTOM_EMOJI_PATTERN = /^[^:<>@#\s]+:\d{17,20}$/;

const reactionEmojiSchema = z
  .string()
  .min(1)
  .max(REACTION_EMOJI_MAX)
  .refine((raw) => !raw.includes(':') || CUSTOM_EMOJI_PATTERN.test(raw), {
    message: 'emoji must be a unicode emoji or name:id',
  });

const baseArgsSchema = z.object({
  guildId: z.string(),
  channelId: z.string(),
  messageId: z.string(),
  dryRun: z.boolean().optional(),
  idempotencyKey: z.string().min(1),
});

/**
 * Zod schemas are the boundary (hard rule 3). A parse failure is the
 * argument-fault message (ruling M4-D18), never a throw: the parse runs
 * before the guild gate, so it has consulted nothing about which guilds
 * exist. `guildId` is a bare string on purpose, like `send.ts`: the gate
 * parses it and refuses malformed and unreachable identically.
 */
const editArgsSchema = baseArgsSchema
  .extend({
    content: z.string().min(1).max(EDIT_CONTENT_MAX).optional(),
    embeds: z.array(embedSchema).max(EDIT_EMBEDS_MAX).optional(),
  })
  .refine(
    (args) => args.content !== undefined || (args.embeds !== undefined && args.embeds.length > 0),
    { message: 'content or embeds required' },
  )
  .refine(
    (args) =>
      (args.embeds ?? []).reduce((sum, embed) => sum + embedTotalLength(embed), 0) <=
      EDIT_EMBED_TOTAL_MAX,
    {
      message: 'embeds exceed 6000 characters in total',
    },
  );

const reactionArgsSchema = baseArgsSchema.extend({
  emoji: reactionEmojiSchema,
});

/**
 * The loose wire shapes registered with the MCP server. Deliberately
 * without refinements, like `sendMessageParams`: these document the wire
 * types for clients while the strict schemas above stay the single
 * boundary.
 */
export const editMessageParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  channelId: z.string().describe('Channel holding the message.'),
  messageId: z.string().describe('Message to edit; must be one the bot authored.'),
  content: z
    .string()
    .optional()
    .describe(
      `Replacement text in Discord Markdown, 1 to ${String(EDIT_CONTENT_MAX)} characters. Optional when embeds are present.`,
    ),
  embeds: z
    .array(
      z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        fields: z
          .array(z.object({ name: z.string(), value: z.string(), inline: z.boolean().optional() }))
          .optional(),
        color: z.number().optional(),
        footer: z.string().optional(),
      }),
    )
    .optional()
    .describe('Up to 3 replacement embeds; at least one of content or embeds is required.'),
  dryRun: z.boolean().optional().describe('Record without editing: nothing reaches Discord.'),
  idempotencyKey: z
    .string()
    .describe('Caller-supplied key for this edit; reuse the same value if you retry this call.'),
};

export const deleteMessageParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  channelId: z.string().describe('Channel holding the message.'),
  messageId: z.string().describe('Message to delete; must be one the bot authored.'),
  dryRun: z.boolean().optional().describe('Record without deleting: nothing reaches Discord.'),
  idempotencyKey: z
    .string()
    .describe('Caller-supplied key for this delete; reuse the same value if you retry this call.'),
};

/** Which tool is rendering, for the verbs and budget words below. */
type MessageWriteKind = 'edit' | 'delete' | 'pin' | 'unpin' | 'add-reaction' | 'remove-reaction';

const refuse = (): MessageWriteOutcomeText => ({ ok: false, message: GUILD_REFUSAL_MESSAGE });

const refuseInvalidArgs = (): MessageWriteOutcomeText => ({
  ok: false,
  message: INVALID_ARGUMENTS_MESSAGE,
});

/**
 * Every refusal renders distinctly and actionably: the operator reading it
 * knows what stopped the write and what to do next. No two reasons share a
 * string (pinned by test), and none echoes message content — ids only.
 */
const refusalText = (
  kind: MessageWriteKind,
  guildId: GuildId,
  channelId: string,
  messageId: string,
  reason: McpMessageWriteRefusal,
  detail?: string,
): string => {
  const noun =
    kind === 'edit'
      ? 'edited'
      : kind === 'delete'
        ? 'deleted'
        : kind === 'pin'
          ? 'pinned'
          : kind === 'unpin'
            ? 'unpinned'
            : kind === 'add-reaction'
              ? 'reacted to'
              : 'had its reaction removed';
  switch (reason) {
    case 'channel-not-allowlisted':
      return (
        `Channel ${channelId} in guild ${guildId} is not on the send allowlist, ` +
        `so nothing was ${noun}. The owner can allow it with ` +
        `\`bananasaurs mcp allow-channel ${channelId} --guild ${guildId} --confirm\`, then retry this call.`
      );
    case 'channel-not-in-guild':
      return (
        `Channel ${channelId} in guild ${guildId} is not a channel this guild's bot can see, ` +
        `so nothing was ${noun}. Allowlisting it will not help: ` +
        `\`bananasaurs mcp allow-channel ${channelId} --guild ${guildId} --confirm\` would refuse the same id. ` +
        'If the channel was already allowlisted, the bot may not see it yet ' +
        '(for example right after a restart) — wait a moment and retry this call.'
      );
    case 'bot-lacks-permission':
      // Pins name both halves of Discord's pin permission (ruling: Discord
      // split pinning across PinMessages and ManageMessages): the daemon
      // reports whichever half it checked, but the operator needs both.
      if (kind === 'pin' || kind === 'unpin') {
        return (
          'The bot lacks the PinMessages or ManageMessages Discord permission in channel ' +
          `${channelId} in guild ${guildId}, so nothing was ${noun}. An operator who can edit ` +
          "the channel's permission overwrites can grant either, then retry this call."
        );
      }
      return (
        `The bot lacks the ${detail ?? 'needed'} Discord permission in channel ${channelId} ` +
        `in guild ${guildId}, so nothing was ${noun}. An operator who can edit the channel's ` +
        'permission overwrites can grant it, then retry this call.'
      );
    case 'protected-role-panel':
      return (
        `Message ${messageId} in guild ${guildId} is a role-panel message, ` +
        `so nothing was ${noun}. Role panels are owned by the panel module — ` +
        'changing one here would break role assignment — so this tool refuses them outright.'
      );
    case 'protected-task-post':
      return (
        `Message ${messageId} in guild ${guildId} is a task post, ` +
        `so nothing was ${noun}. Task posts are owned by the task module, ` +
        'so this tool refuses them outright.'
      );
    case 'not-bot-authored':
      return (
        `Message ${messageId} in channel ${channelId} in guild ${guildId} was written by ` +
        `someone else, so nothing was ${noun}. This tool changes only messages the bot authored.`
      );
    case 'not-found':
      return (
        `Message ${messageId} in channel ${channelId} in guild ${guildId} no longer exists ` +
        `(or the bot cannot see it), so there was nothing to change.`
      );
    case 'unknown-emoji':
      return (
        `Emoji "${detail ?? '?'}" is not usable in guild ${guildId}, ` +
        `so nothing was ${noun}. Pass a unicode emoji, or name:id for a custom emoji of this guild — ` +
        'a custom emoji from another guild is refused.'
      );
    case 'killswitch':
      return (
        `The kill switch is on for guild ${guildId}, so nothing was ${noun}. ` +
        'Writing stays paused until an operator turns it off; do not retry in a loop.'
      );
    case 'breaker-open':
      return (
        `The circuit breaker is open for guild ${guildId} after repeated Discord faults, ` +
        `so nothing was ${noun}. Wait for an operator to clear it; do not retry in a loop.`
      );
    case 'rate-cap':
      // Edits and deletes share the `edit` cap group; pins, unpins and
      // reactions share `pin_react` (ruling). The numbers are owner-tunable
      // settings (ADR 0119 §4), so the text names the setting, not a number.
      return kind === 'edit' || kind === 'delete'
        ? `Guild ${guildId} has used its rolling-hour budget for edits and deletes (setting mcp.cap.edit), ` +
            `so nothing was ${noun}. Wait for the window to pass before retrying` +
            `${detail !== undefined ? ` (resets at ${detail})` : ''}; ` +
            'answering an already-recorded idempotency key still works meanwhile.'
        : `Guild ${guildId} has used its rolling-hour budget for pins and reactions ` +
            `(setting mcp.cap.pin_react), so nothing was ${noun}. Wait for the window to pass before retrying` +
            `${detail !== undefined ? ` (resets at ${detail})` : ''}; ` +
            'answering an already-recorded idempotency key still works meanwhile.';
    case 'duplicate-key-different-content':
      return (
        `That idempotency key was already used for a different write in guild ${guildId}, ` +
        'so nothing new was changed. To write this, retry with a fresh key; ' +
        'the earlier write under the old key is unaffected.'
      );
    case 'duplicate-content-recently':
      return (
        `The same write already reached channel ${channelId} in guild ${guildId} within the last minute, ` +
        'so nothing new was changed. Wait a minute, then retry with a fresh key.'
      );
  }
};

const renderOutcome = (
  kind: MessageWriteKind,
  guildId: GuildId,
  channelId: string,
  messageId: string,
  outcome: McpMessageWriteOutcome,
): MessageWriteOutcomeText => {
  switch (outcome.status) {
    case 'done': {
      const doneText =
        kind === 'edit'
          ? `Edited message ${messageId} in channel ${channelId} in guild ${guildId} ` +
            `(action ${outcome.actionId}). The previous text was kept for undo.`
          : kind === 'delete'
            ? `Deleted message ${messageId} in channel ${channelId} in guild ${guildId} ` +
              `(action ${outcome.actionId}). A delete cannot be undone.`
            : kind === 'pin'
              ? `Pinned message ${messageId} in channel ${channelId} in guild ${guildId} ` +
                `(action ${outcome.actionId}).`
              : kind === 'unpin'
                ? `Unpinned message ${messageId} in channel ${channelId} in guild ${guildId} ` +
                  `(action ${outcome.actionId}).`
                : kind === 'add-reaction'
                  ? `Added reaction to message ${messageId} in channel ${channelId} ` +
                    `in guild ${guildId} (action ${outcome.actionId}).`
                  : `Removed reaction from message ${messageId} in channel ${channelId} ` +
                    `in guild ${guildId} (action ${outcome.actionId}).`;
      return { ok: true, text: doneText };
    }
    case 'dry-run':
      return {
        ok: true,
        text:
          `Dry run is on for guild ${guildId}: ` +
          `nothing was changed on message ${messageId} in channel ${channelId}. The write was recorded ` +
          `as action ${outcome.actionId} under its idempotency key but no Discord call was made.`,
      };
    case 'replayed':
      // Not a failure: the write is already handled under this key and
      // nothing new was changed — ok:true, no failure language.
      return {
        ok: true,
        text:
          `Already recorded under this idempotency key as action ${outcome.actionId}` +
          `${outcome.messageId !== undefined ? ` on message ${outcome.messageId}` : ''}: ` +
          `nothing new was changed on message ${messageId} in channel ${channelId}.`,
      };
    case 'refused':
      return {
        ok: false,
        message: refusalText(kind, guildId, channelId, messageId, outcome.reason, outcome.detail),
      };
    case 'failed':
      // The Discord call failed with an unknown result: Discord may have
      // applied the write and the response been lost, so this must not claim
      // nothing changed — nobody knows that. Check-then-retry with the same
      // key, never a fresh one.
      return {
        ok: false,
        message:
          `The Discord call for message ${messageId} in channel ${channelId} ` +
          `in guild ${guildId} failed with an unknown result: the message ` +
          `may or may not have been changed. Check the channel before retrying, ` +
          'and retry with the same idempotency key — never a fresh one.',
      };
  }
};

/**
 * Never throws and never rejects: a malformed argument is the
 * argument-fault message, and anything unexpected (a port fault, which
 * cannot carry message content outward from here) is the shared refusal
 * rather than an exception out of the handler. The two messages are
 * deliberately different (ruling M4-D18).
 */
export const editMessageText = async (
  principal: McpPrincipal,
  port: McpMessageWritesPort,
  rawArgs: unknown,
): Promise<MessageWriteOutcomeText> => {
  try {
    const parsed = editArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return refuseInvalidArgs();
    const input = parsed.data;
    // M8, like `send.ts`: trim before anything else, so whitespace-only
    // content never claims a ledger row. The edited content is the trimmed
    // string, so the hash, the ledger and the REST call agree.
    const content = input.content === undefined ? undefined : input.content.trim();
    if (content !== undefined && content === '') return refuseInvalidArgs();
    if (!idsAreWellFormed([input.channelId, input.messageId])) return refuseInvalidArgs();
    const gate = requireReachableGuild(principal, input.guildId);
    if (!gate.ok) return { ok: false, message: gate.message };
    const outcome = await port.edit(gate.guildId, {
      channelId: input.channelId,
      messageId: input.messageId,
      content,
      embeds: input.embeds,
      dryRun: input.dryRun ?? false,
      idempotencyKey: input.idempotencyKey,
    });
    return renderOutcome('edit', gate.guildId, input.channelId, input.messageId, outcome);
  } catch {
    return refuse();
  }
};

export const deleteMessageText = async (
  principal: McpPrincipal,
  port: McpMessageWritesPort,
  rawArgs: unknown,
): Promise<MessageWriteOutcomeText> => {
  try {
    const parsed = baseArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return refuseInvalidArgs();
    const input = parsed.data;
    if (!idsAreWellFormed([input.channelId, input.messageId])) return refuseInvalidArgs();
    const gate = requireReachableGuild(principal, input.guildId);
    if (!gate.ok) return { ok: false, message: gate.message };
    const outcome = await port.delete(gate.guildId, {
      channelId: input.channelId,
      messageId: input.messageId,
      dryRun: input.dryRun ?? false,
      idempotencyKey: input.idempotencyKey,
    });
    return renderOutcome('delete', gate.guildId, input.channelId, input.messageId, outcome);
  } catch {
    return refuse();
  }
};

const pinLikeText = async (
  kind: 'pin' | 'unpin',
  principal: McpPrincipal,
  port: McpMessageWritesPort,
  rawArgs: unknown,
): Promise<MessageWriteOutcomeText> => {
  try {
    const parsed = baseArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return refuseInvalidArgs();
    const input = parsed.data;
    if (!idsAreWellFormed([input.channelId, input.messageId])) return refuseInvalidArgs();
    const gate = requireReachableGuild(principal, input.guildId);
    if (!gate.ok) return { ok: false, message: gate.message };
    const call = kind === 'pin' ? port.pin : port.unpin;
    const outcome = await call(gate.guildId, {
      channelId: input.channelId,
      messageId: input.messageId,
      dryRun: input.dryRun ?? false,
      idempotencyKey: input.idempotencyKey,
    });
    return renderOutcome(kind, gate.guildId, input.channelId, input.messageId, outcome);
  } catch {
    return refuse();
  }
};

export const pinMessageText = async (
  principal: McpPrincipal,
  port: McpMessageWritesPort,
  rawArgs: unknown,
): Promise<MessageWriteOutcomeText> => pinLikeText('pin', principal, port, rawArgs);

export const unpinMessageText = async (
  principal: McpPrincipal,
  port: McpMessageWritesPort,
  rawArgs: unknown,
): Promise<MessageWriteOutcomeText> => pinLikeText('unpin', principal, port, rawArgs);

const reactionText = async (
  principal: McpPrincipal,
  port: McpMessageWritesPort,
  rawArgs: unknown,
  method: 'addReaction' | 'removeReaction',
): Promise<MessageWriteOutcomeText> => {
  try {
    const parsed = reactionArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return refuseInvalidArgs();
    const input = parsed.data;
    if (!idsAreWellFormed([input.channelId, input.messageId])) return refuseInvalidArgs();
    const gate = requireReachableGuild(principal, input.guildId);
    if (!gate.ok) return { ok: false, message: gate.message };
    const outcome = await port[method](gate.guildId, {
      channelId: input.channelId,
      messageId: input.messageId,
      emoji: input.emoji,
      dryRun: input.dryRun ?? false,
      idempotencyKey: input.idempotencyKey,
    });
    return renderOutcome(
      method === 'addReaction' ? 'add-reaction' : 'remove-reaction',
      gate.guildId,
      input.channelId,
      input.messageId,
      outcome,
    );
  } catch {
    return refuse();
  }
};

export const addReactionText = async (
  principal: McpPrincipal,
  port: McpMessageWritesPort,
  rawArgs: unknown,
): Promise<MessageWriteOutcomeText> => reactionText(principal, port, rawArgs, 'addReaction');

export const removeReactionText = async (
  principal: McpPrincipal,
  port: McpMessageWritesPort,
  rawArgs: unknown,
): Promise<MessageWriteOutcomeText> => reactionText(principal, port, rawArgs, 'removeReaction');
