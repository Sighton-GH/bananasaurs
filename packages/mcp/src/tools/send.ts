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
 * `send_message` — the one write tool (slice M5, Task 3), and the first tool
 * registered under the send scope rather than the read scope.
 *
 * Every tool follows the same five steps — Zod parse → `requireReachableGuild`
 * → port call → render — so hard rule 3 holds by construction: the model
 * output passes a Zod validator, the content is text the owner asked to post
 * and nothing interprets it as an instruction, and no log line anywhere here
 * carries message content (CLAUDE.md rule 4 — this function does not log at
 * all, and the rendered outcomes below name channels and message ids, never
 * content).
 *
 * This module holds no allowlist handle of any kind: the daemon's gateway
 * wiring (Task 4) owns the allowlist check, the safety reads and the ledger,
 * and this package's port projects its outcomes field by field — the same
 * reason the other four ports project, and the eslint boundary (ADR 0044 §4)
 * means this package cannot reach into `core`'s effects directory anyway.
 * Task 4 maps the gateway's `MessageOutcome` onto `McpSendOutcome` one to
 * one, except `guild-unknown` (the guild gate above already answered that)
 * and the `failed` code (a detail for the daemon's logs, not the model).
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

export const SEND_MESSAGE_TOOL_NAME = 'send_message';
export const SEND_MESSAGE_TOOL_DESCRIPTION =
  'Posts one text message to a channel the owner has allowlisted for this guild. ' +
  'Mentions in the content never ping: @everyone, @here, role and user mentions are all suppressed. ' +
  `Content is plain text up to ${String(SEND_CONTENT_MAX)} characters; no embeds, no attachments. ` +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call ' +
  '(for example after a timeout): a new key on a retry will post the message twice. ' +
  'Refuses when the guild is unreachable or the channel is not allowlisted.';

/** What the daemon's gateway wiring must satisfy (Task 4 implements it). */
export interface McpSendPort {
  readonly send: (
    guildId: GuildId,
    input: {
      readonly channelId: string;
      readonly content: string;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpSendOutcome>;
}

/** Mirrors the gateway's outcomes, named in this package's own vocabulary. */
export type McpSendOutcome =
  | { readonly status: 'sent'; readonly messageId: string }
  | { readonly status: 'dry-run' }
  | { readonly status: 'replayed'; readonly messageId: string | undefined }
  | { readonly status: 'refused'; readonly reason: McpSendRefusal }
  | { readonly status: 'failed' };

export type McpSendRefusal =
  | 'private-thread'
  | 'channel-not-allowlisted'
  | 'channel-not-in-guild'
  | 'killswitch'
  | 'breaker-open'
  | 'rate-cap'
  | 'duplicate-key-different-content'
  | 'duplicate-content-recently';

export type SendOutcomeText =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

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
 */
const sendArgsSchema = z.object({
  guildId: z.string(),
  channelId: z.string(),
  content: z.string().min(1).max(SEND_CONTENT_MAX),
  idempotencyKey: z.string().min(1),
});

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
    .describe(`Message text, 1 to ${String(SEND_CONTENT_MAX)} characters. Mentions never ping.`),
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
const refusalText = (guildId: GuildId, channelId: string, reason: McpSendRefusal): string => {
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
      // Two hundred per guild per rolling hour, mirroring
      // MESSAGE_SEND_RATE_LIMIT / MESSAGE_SEND_RATE_WINDOW_MS in `core`'s
      // message gateway (ruling M5-D4); duplicated, not imported, for the
      // same reason that module duplicates the storage numbers.
      return (
        `Guild ${guildId} has used its send budget of 200 sends per rolling hour, ` +
        'so nothing was posted. Wait for the window to pass before retrying; ' +
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
  const content = input.content.trim();
  if (content === '') return refuseInvalidArgs();
  if (!idsAreWellFormed([input.channelId])) return refuseInvalidArgs();
  // The guild gate. `requireReachableGuild` parses the id itself and refuses
  // malformed and unreachable identically — the membership check below it is
  // the whole guard, so removing this call answers any guild's send path.
  const gate = requireReachableGuild(principal, input.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const outcome = await port.send(gate.guildId, {
    channelId: input.channelId,
    content,
    idempotencyKey: input.idempotencyKey,
  });
  switch (outcome.status) {
    case 'sent':
      return {
        ok: true,
        text: `Sent message ${outcome.messageId} to channel ${input.channelId} in guild ${gate.guildId}.`,
      };
    case 'dry-run':
      return {
        ok: true,
        text:
          `Dry run is on for guild ${gate.guildId}: ` +
          `nothing was posted to channel ${input.channelId}. The send was recorded ` +
          'under its idempotency key but no Discord call was made.',
      };
    case 'replayed':
      // Not a failure (ruling M5-D3): the message is already handled under
      // this key and nothing new was posted — ok:true, no failure language.
      if (outcome.messageId !== undefined) {
        return {
          ok: true,
          text:
            `Already sent under this idempotency key as message ${outcome.messageId}: ` +
            `nothing new was posted to channel ${input.channelId}.`,
        };
      }
      // No message id was stored under this key: either the first attempt's
      // response was lost, or a concurrent duplicate call re-read before
      // `recordMessageId` ran. Either way the message may or may not have
      // been posted, so report honestly rather than repairing: check the
      // channel, and retry — if at all — with this same key. Never suggest a
      // fresh key here: probe F2 showed a fresh key 61 s later posts again.
      return {
        ok: true,
        text:
          'Already recorded under this idempotency key, but the first attempt stored no message id, ' +
          `so the message may or may not have been posted to channel ${input.channelId}: ` +
          'nothing new was posted by this call. ' +
          `Check channel ${input.channelId} for the message before retrying, ` +
          'and if you retry, reuse this same idempotency key — never a fresh one.',
      };
    case 'refused':
      return { ok: false, message: refusalText(gate.guildId, input.channelId, outcome.reason) };
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
