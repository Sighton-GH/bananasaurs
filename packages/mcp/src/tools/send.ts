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
 * `send_message` — the message-write tool, registered under the send scope.
 *
 * Every tool follows the same five steps — Zod parse → `requireReachableGuild`
 * → port call → render — so hard rule 3 holds by construction: the model
 * output passes a Zod validator, the content is text the owner asked to post
 * and nothing interprets it as an instruction, and no log line anywhere here
 * carries message content (CLAUDE.md rule 4 — this function does not log at
 * all, and the rendered outcomes below name channels and message ids, never
 * content).
 *
 * This module holds no allowlist handle of any kind: the daemon's target
 * resolution (Task 4) owns the allowlist check, the live permission check,
 * the ping policy, the safety reads and the ledger, and this package's port
 * projects its outcomes field by field — the same reason the other four
 * ports project, and the eslint boundary (ADR 0044 §4) means this package
 * cannot reach into `core`'s effects directory anyway. Task 4 maps the
 * gateway's `McpActionOutcome` onto `McpSendOutcome` one to one, except
 * `guild-unknown` (the guild gate above already answered that) and the
 * `failed` code (a detail for the daemon's logs, not the model).
 *
 * On ruling M5-D6 (a DM channel id refused before the allowlist): **the
 * ruling was retracted, and its retraction was then partly wrong too.** This
 * layer still has no DM branch, and cannot: a DM channel id is a well-formed
 * snowflake, Discord encodes no channel-type bits in an id, and the
 * `McpSendPort` shape below exposes no channel-type lookup.
 *
 * What the retraction claimed — that a DM "can never be in
 * `mcp_send_allowlist`, because rows there are written per guild" — is
 * false, and the M5 whole-branch review proved it by driving the code: rows
 * are written *under* a guild, and nothing made them *of* it. An
 * allowlisted DM id posted to the DM.
 *
 * What actually enforces it, both checked against the guild's own channel
 * cache rather than inferred from an id:
 *
 *   - `bananasaurs mcp allow-channel` refuses anything that is not a
 *     channel of that guild the bot can post text into (`allowSendChannel`,
 *     daemon ops wiring), so the row cannot be written in the first place;
 *   - the send path checks guild membership again before posting, because
 *     the allowlist is data and a row predating that validation must not be
 *     able to reach outside the guild.
 *
 * Do not reconstruct the "written per guild" argument from the schema. It
 * reads convincingly and it is wrong.
 */

/** The 2000-character Discord limit, and ADR 0044 §4's cap. */
export const SEND_CONTENT_MAX = 2000;

/** Discord caps a post at three embeds. */
export const SEND_EMBEDS_MAX = 3;
/** Discord caps an post's embed text at 6000 characters in total. */
export const SEND_EMBED_TOTAL_MAX = 6000;
/** Explicit pings are capped the way ADR 0117 caps them: 10 roles, 25 users. */
export const SEND_PING_ROLES_MAX = 10;
export const SEND_PING_USERS_MAX = 25;

export const SEND_MESSAGE_TOOL_NAME = 'send_message';
export const SEND_MESSAGE_TOOL_DESCRIPTION =
  'Posts one message to a channel the owner has allowlisted for this guild, or into a thread under one. ' +
  'Content is Discord Markdown (bold, italics, lists, `-# subtext`, masked links `[text](url)`; headings `#` to `###`) ' +
  `up to ${String(SEND_CONTENT_MAX)} characters; pass content, embeds, or both. ` +
  'Mentions typed into the content never ping: @everyone, @here, role and user mentions render but notify nobody ' +
  'unless named in pingRoles/pingUsers, which are checked against the guild ping policy. ' +
  'Optional replyTo posts as a reply without pinging the author unless pingReplyAuthor is true; ' +
  'threadId posts into that thread. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call ' +
  '(for example after a timeout): a new key on a retry will post the message twice. ' +
  'Pass dryRun to record without posting. ' +
  'Refuses when the guild is unreachable, the channel is not allowlisted, or the bot lacks the Discord permission.';

/** One embed field, in the tool's vocabulary (the daemon maps it to Discord's shape). */
export interface SendEmbedField {
  readonly name: string;
  readonly value: string;
  readonly inline?: boolean | undefined;
}

/** One embed, in the tool's vocabulary. No url/image/thumbnail fields — strict. */
export interface SendEmbed {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly fields?: readonly SendEmbedField[] | undefined;
  readonly color?: number | undefined;
  /** Footer text; the daemon sends it as Discord's `{ text }` object. */
  readonly footer?: string | undefined;
}

/** What the daemon's send wiring must satisfy (Task 4 implements it). */
export interface McpSendPort {
  readonly send: (
    guildId: GuildId,
    input: {
      readonly channelId: string;
      readonly content: string | undefined;
      readonly embeds: readonly SendEmbed[] | undefined;
      readonly replyTo: string | undefined;
      /** ADR 0117 §5: false unless the caller asked to ping the replied-to author. */
      readonly pingReplyAuthor: boolean;
      /** Posts into this thread; the target becomes the thread. */
      readonly threadId: string | undefined;
      readonly pingRoles: readonly string[];
      readonly pingUsers: readonly string[];
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpSendOutcome>;
}

/** Mirrors the gateway's outcomes, named in this package's own vocabulary. */
export type McpSendOutcome =
  | { readonly status: 'sent'; readonly messageId: string; readonly actionId: string }
  | { readonly status: 'dry-run'; readonly actionId: string }
  | {
      readonly status: 'replayed';
      readonly messageId: string | undefined;
      readonly actionId: string;
    }
  | { readonly status: 'refused'; readonly reason: McpSendRefusal; readonly detail?: string }
  | { readonly status: 'failed' };

export type McpSendRefusal =
  | 'private-thread'
  | 'channel-not-allowlisted'
  | 'channel-not-in-guild'
  | 'bot-lacks-permission'
  | 'role-unknown'
  | 'role-dangerous'
  | 'role-managed-or-everyone'
  | 'role-above-bot'
  | 'role-not-allowlisted'
  | 'user-not-member'
  | 'killswitch'
  | 'breaker-open'
  | 'rate-cap'
  | 'duplicate-key-different-content'
  | 'duplicate-content-recently';

export type SendOutcomeText =
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
  // argument fault instead of burning a ledger row on it.
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
 * Zod schemas are the boundary (hard rule 3). A parse failure — wrong wire
 * type, empty content, over-long content, missing key — is the
 * argument-fault message (ruling M4-D18), never a throw: the parse runs
 * before the guild gate below, so it has consulted nothing about which
 * guilds exist. The guild gate itself, and a throw out of the port, stay
 * the shared refusal. `guildId` is a bare string here on purpose: the gate
 * parses it and refuses malformed and unreachable identically.
 *
 * `idempotencyKey` is required from the caller (ruling M5-D8, layer A) with
 * no maximum: the ledger column is unbounded text, and the description above
 * tells the model to reuse the value on retry, which is the only way that
 * layer works for a client that regenerates its arguments.
 *
 * Content is optional when embeds are present, but at least one of the two
 * is required. The embeds schema is strict: Discord-only extensions like an
 * image, url or thumbnail field are an argument fault, not silently dropped.
 */
const sendArgsSchema = z
  .object({
    guildId: z.string(),
    channelId: z.string(),
    content: z.string().min(1).max(SEND_CONTENT_MAX).optional(),
    embeds: z.array(embedSchema).max(SEND_EMBEDS_MAX).optional(),
    replyTo: z.string().optional(),
    pingReplyAuthor: z.boolean().optional(),
    threadId: z.string().optional(),
    pingRoles: z.array(z.string().min(1)).max(SEND_PING_ROLES_MAX).optional(),
    pingUsers: z.array(z.string().min(1)).max(SEND_PING_USERS_MAX).optional(),
    dryRun: z.boolean().optional(),
    idempotencyKey: z.string().min(1),
  })
  .refine(
    (args) => args.content !== undefined || (args.embeds !== undefined && args.embeds.length > 0),
    { message: 'content or embeds required' },
  )
  .refine(
    (args) =>
      (args.embeds ?? []).reduce((sum, embed) => sum + embedTotalLength(embed), 0) <=
      SEND_EMBED_TOTAL_MAX,
    {
      message: 'embeds exceed 6000 characters in total',
    },
  );

/**
 * The loose wire shape registered with the MCP server. Deliberately without
 * refinements: this documents the wire types for clients while the strict
 * schema above stays the single boundary — everything the transport accepts
 * but the boundary rejects still ends as the argument-fault message from the
 * handler (a guild the caller cannot reach ends as the shared refusal),
 * which also try/catches so no input can throw out of the tool.
 */
export const sendMessageParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  channelId: z
    .string()
    .describe('Channel to post into; the owner must have allowlisted it for this guild.'),
  content: z
    .string()
    .optional()
    .describe(
      `Message text in Discord Markdown (bold, italics, lists, masked links), 1 to ${String(SEND_CONTENT_MAX)} characters. Optional when embeds are present. Mentions never ping unless named in pingRoles/pingUsers.`,
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
    .describe('Up to 3 rich embeds; at least one of content or embeds is required.'),
  replyTo: z.string().optional().describe('Message id in the same channel or thread to reply to.'),
  pingReplyAuthor: z
    .boolean()
    .optional()
    .describe('Ping the replied-to author. Defaults to false: a reply notifies nobody by itself.'),
  threadId: z.string().optional().describe('Thread to post into; the target becomes the thread.'),
  pingRoles: z
    .array(z.string())
    .optional()
    .describe(
      'Up to 10 roles to ping, as names or ids; each is checked against the guild ping policy.',
    ),
  pingUsers: z
    .array(z.string())
    .optional()
    .describe('Up to 25 guild members to ping, as ids; each must be a current member.'),
  dryRun: z.boolean().optional().describe('Record without posting: nothing reaches Discord.'),
  idempotencyKey: z
    .string()
    .describe('Caller-supplied key for this send; reuse the same value if you retry this call.'),
};

const refuse = (): SendOutcomeText => ({ ok: false, message: GUILD_REFUSAL_MESSAGE });

const refuseInvalidArgs = (): SendOutcomeText => ({
  ok: false,
  message: INVALID_ARGUMENTS_MESSAGE,
});

/**
 * Every refusal renders distinctly and actionably: the operator reading it
 * knows what stopped the send and what to do next. No two reasons share a
 * string (pinned by test), and none echoes message content — ids only.
 */
const refusalText = (
  guildId: GuildId,
  channelId: string,
  reason: McpSendRefusal,
  detail?: string,
): string => {
  switch (reason) {
    case 'private-thread':
      return `Channel ${channelId} in guild ${guildId} is a private thread, so nothing was posted. Private threads never inherit send authorization.`;
    case 'channel-not-allowlisted':
      return (
        `Channel ${channelId} in guild ${guildId} is not on the send allowlist, ` +
        'so nothing was posted. The owner can allow it with ' +
        `\`bananasaurs mcp allow-channel ${channelId} --guild ${guildId} --confirm\`, then retry this call.`
      );
    case 'channel-not-in-guild':
      // Its own text, not the allowlist text (N3): this channel is absent
      // from the guild's channel cache, so `mcp allow-channel` would refuse
      // the same id — pointing the model at that command sends the operator
      // round a circle, most likely in the seconds after a restart before
      // READY. Allowlisting will not help; waiting (or checking the id) will.
      return (
        `Channel ${channelId} in guild ${guildId} is not a channel this guild's bot can see, ` +
        'so nothing was posted. Allowlisting it will not help: ' +
        `\`bananasaurs mcp allow-channel ${channelId} --guild ${guildId} --confirm\` would refuse the same id. ` +
        'If the channel was already allowlisted, the bot may not see it yet ' +
        '(for example right after a restart) — wait a moment and retry this call.'
      );
    case 'bot-lacks-permission':
      return (
        `The bot lacks the ${detail ?? 'needed'} Discord permission in channel ${channelId} ` +
        `in guild ${guildId}, so nothing was posted. An operator who can edit the channel's ` +
        'permission overwrites can grant it, then retry this call.'
      );
    case 'role-unknown':
      return (
        `No role matching "${detail ?? '?'}" in guild ${guildId}, ` +
        'so nothing was posted. List roles with `list_roles` and retry with an id or exact name.'
      );
    case 'role-dangerous':
      return (
        `Role ${detail ?? '?'} in guild ${guildId} holds a permission the ping policy never allows, ` +
        'so nothing was posted and nobody was pinged.'
      );
    case 'role-managed-or-everyone':
      return (
        `Role ${detail ?? '?'} in guild ${guildId} is managed or @everyone, which can never be pinged, ` +
        'so nothing was posted.'
      );
    case 'role-above-bot':
      return (
        `Role ${detail ?? '?'} in guild ${guildId} sits at or above the bot's highest role, ` +
        'so nothing was posted and nobody was pinged.'
      );
    case 'role-not-allowlisted':
      return (
        `Role ${detail ?? '?'} is not on the ping allowlist for guild ${guildId}, ` +
        'so nothing was posted and nobody was pinged.'
      );
    case 'user-not-member':
      return (
        `User ${detail ?? '?'} is not a member of guild ${guildId}, ` +
        'so nothing was posted and nobody was pinged.'
      );
    case 'killswitch':
      return (
        `The kill switch is on for guild ${guildId}, so nothing was posted. ` +
        'Sending stays paused until an operator turns it off; do not retry in a loop.'
      );
    case 'breaker-open':
      return (
        `The circuit breaker is open for guild ${guildId} after repeated Discord faults, ` +
        'so nothing was posted. Wait for an operator to clear it; do not retry in a loop.'
      );
    case 'rate-cap':
      // The rolling-hour message budget per guild is the owner-tunable
      // setting mcp.cap.message (ADR 0116 §6, ADR 0119 §4), so the text names
      // the setting rather than a number that could drift from it.
      return (
        `Guild ${guildId} has used its rolling-hour message budget (setting mcp.cap.message), ` +
        'so nothing was posted. Wait for the window to pass before retrying' +
        `${detail !== undefined ? ` (resets at ${detail})` : ''}; ` +
        'answering an already-sent idempotency key still works meanwhile.'
      );
    case 'duplicate-key-different-content':
      return (
        'That idempotency key was already used for a different message, ' +
        'so nothing new was posted. To send this content, retry with a fresh key; ' +
        'the earlier send under the old key is unaffected.'
      );
    case 'duplicate-content-recently':
      return (
        `The same text was already sent to channel ${channelId} within the last minute, ` +
        'so nothing new was posted. Wait a minute or vary the text, then retry with a fresh key.'
      );
  }
};

/** What the dry run would have posted — the shape, never the content. */
const dryRunSummary = (input: {
  readonly threadId: string | undefined;
  readonly replyTo: string | undefined;
  readonly pingReplyAuthor: boolean;
  readonly pingRoles: readonly string[];
  readonly pingUsers: readonly string[];
  readonly embeds: readonly SendEmbed[] | undefined;
  readonly content: string | undefined;
}): string => {
  const parts: string[] = [];
  if (input.threadId !== undefined) parts.push(`into thread ${input.threadId}`);
  if (input.replyTo !== undefined) {
    parts.push(
      input.pingReplyAuthor
        ? `as a reply to ${input.replyTo} pinging the author`
        : `as a reply to ${input.replyTo}`,
    );
  }
  if (input.pingRoles.length > 0) parts.push(`pinging ${String(input.pingRoles.length)} role(s)`);
  if (input.pingUsers.length > 0) parts.push(`pinging ${String(input.pingUsers.length)} member(s)`);
  if (input.embeds !== undefined) parts.push(`with ${String(input.embeds.length)} embed(s)`);
  if (input.content !== undefined)
    parts.push(`with ${String(input.content.length)} characters of text`);
  return parts.length > 0 ? parts.join(', ') : 'an empty post';
};

const sendMessageInner = async (
  principal: McpPrincipal,
  port: McpSendPort,
  rawArgs: unknown,
): Promise<SendOutcomeText> => {
  const parsed = sendArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  const input = parsed.data;
  // M8: trim before anything else. Whitespace-only content would otherwise
  // sail through the length check, claim a ledger row and burn a rate-cap
  // slot, then fail at Discord. Empty-after-trim is an argument fault, so it
  // is refused here — before the guild gate, the port call, and therefore
  // before anything is claimed. The sent content is the trimmed string:
  // leading and trailing whitespace is meaningless to Discord, and the hash,
  // the ledger and the REST call must all agree on what was actually posted.
  // Content may be absent when embeds carry the post — but then embeds must
  // be present, which the schema above already enforced.
  const content = input.content === undefined ? undefined : input.content.trim();
  if (content !== undefined && content === '') return refuseInvalidArgs();
  if (!idsAreWellFormed([input.channelId])) return refuseInvalidArgs();
  if (input.threadId !== undefined && !idsAreWellFormed([input.threadId])) {
    return refuseInvalidArgs();
  }
  if (input.replyTo !== undefined && !idsAreWellFormed([input.replyTo])) {
    return refuseInvalidArgs();
  }
  if (input.pingUsers !== undefined && !idsAreWellFormed(input.pingUsers)) {
    return refuseInvalidArgs();
  }
  // The guild gate. `requireReachableGuild` parses the id itself and refuses
  // malformed and unreachable identically — the membership check below it is
  // the whole guard, so removing this call answers any guild's send path.
  const gate = requireReachableGuild(principal, input.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const outcome = await port.send(gate.guildId, {
    channelId: input.channelId,
    content,
    embeds: input.embeds,
    replyTo: input.replyTo,
    // ADR 0117 §5: a reply pings its author only when asked. Default false,
    // unlike the ADR 0072 assistant default — an operator posting a
    // correction must not notify someone by accident.
    pingReplyAuthor: input.pingReplyAuthor ?? false,
    threadId: input.threadId,
    pingRoles: input.pingRoles ?? [],
    pingUsers: input.pingUsers ?? [],
    dryRun: input.dryRun ?? false,
    idempotencyKey: input.idempotencyKey,
  });
  switch (outcome.status) {
    case 'sent':
      return {
        ok: true,
        text:
          `Sent message ${outcome.messageId} to channel ${input.channelId} in guild ${gate.guildId} ` +
          `(action ${outcome.actionId}).`,
      };
    case 'dry-run':
      return {
        ok: true,
        text:
          `Dry run is on for guild ${gate.guildId}: ` +
          `nothing was posted to channel ${input.channelId}. The send was recorded ` +
          `as action ${outcome.actionId} under its idempotency key but no Discord call was made. ` +
          `It would post ${dryRunSummary({
            threadId: input.threadId,
            replyTo: input.replyTo,
            pingReplyAuthor: input.pingReplyAuthor ?? false,
            pingRoles: input.pingRoles ?? [],
            pingUsers: input.pingUsers ?? [],
            embeds: input.embeds,
            content,
          })}.`,
      };
    case 'replayed':
      // Not a failure (ruling M5-D3): the message is already handled under
      // this key and nothing new was posted — ok:true, no failure language.
      if (outcome.messageId !== undefined) {
        return {
          ok: true,
          text:
            `Already sent under this idempotency key as message ${outcome.messageId} ` +
            `(action ${outcome.actionId}): ` +
            `nothing new was posted to channel ${input.channelId}.`,
        };
      }
      // No message id was stored under this key: either the first attempt's
      // response was lost, or the earlier attempt failed — and a failed row
      // replays exactly this way too. Either way the earlier attempt's
      // outcome is unknown and the message may or may not be in the channel,
      // so report honestly rather than repairing: check the channel, and
      // retry — if at all — with this same key. Never suggest a fresh key
      // here: probe F2 showed a fresh key 61 s later posts again. And never
      // "sent": nothing here knows that it was.
      return {
        ok: true,
        text:
          `Already recorded under this idempotency key as action ${outcome.actionId}, ` +
          'but the earlier attempt stored no message id, so its outcome is unknown ' +
          `and the message may or may not be in channel ${input.channelId}: ` +
          'nothing new was posted by this call. ' +
          `Check channel ${input.channelId} for the message before retrying, ` +
          'and if you retry, reuse this same idempotency key — never a fresh one.',
      };
    case 'refused':
      return {
        ok: false,
        message: refusalText(gate.guildId, input.channelId, outcome.reason, outcome.detail),
      };
    case 'failed':
      // The Discord call failed with an unknown result: Discord may have
      // accepted the POST and the response been lost, so this must not claim
      // nothing was posted — nobody knows that. Check-then-retry with the
      // same key, never a fresh one (a fresh key on a lost response posts
      // twice, which is probe F2's shape from the other direction).
      return {
        ok: false,
        message:
          `The Discord call for channel ${input.channelId} ` +
          `in guild ${gate.guildId} failed with an unknown result: the message ` +
          `may or may not have been posted. Check the channel before retrying, ` +
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
export const sendMessageText = async (
  principal: McpPrincipal,
  port: McpSendPort,
  rawArgs: unknown,
): Promise<SendOutcomeText> => {
  try {
    return await sendMessageInner(principal, port, rawArgs);
  } catch {
    return refuse();
  }
};
