import { createHash } from 'node:crypto';
import type { DiscordPort } from '../discord/port.js';
import type { GuildId, SnowflakeId } from '../ids.js';
import { safeLogFields, type Logger } from '../obs/logger.js';

/**
 * The one function in the system that can post a message on the owner's behalf.
 *
 * A sibling of `gateway.ts`'s role chokepoint, not a kind inside it (ruling
 * M5-D1): that file's layers — panel status, role allowlist, protected
 * target, hierarchy — have no meaning for a message, and widening it would
 * put the moderation chokepoint at risk while two guilds are being observed.
 * Same layered shape, message-specific layers:
 *
 *   1. allowlist                     -> refuse
 *   2. kill switch                   -> refuse
 *   3. circuit breaker               -> refuse
 *   4. idempotency read              -> replay, or refuse on collision (M5-D3)
 *   5. identical-content window      -> refuse (M5-D8 layer B)
 *   6. rate cap                      -> refuse   [new sends only]
 *   7. idempotency claim             -> INSERT OR IGNORE
 *   8. dry run                       -> record, no REST call
 *   9. execute                       -> the single REST call
 *  10. record                        -> outcome, message id, audit row
 *
 * The order is not arbitrary. Cheap local refusals come before anything that
 * costs a REST call; and the idempotency read comes before the rate cap
 * because a replay is not a send (ruling M5-D9). A replay costs no Discord
 * call and consumes no capacity — it is an answer about something that
 * already happened, so it must not depend on present conditions. With the cap
 * ahead of the ledger read, a client retrying an already-succeeded send would
 * be told `rate-cap` once the hour filled: told its message failed while the
 * message sat in the channel, which is M5-D3's trap from the other direction.
 * The cap still binds every genuinely new send, because a replay returns the
 * stored result and sends nothing — so do not "tidy" the cheap check back to
 * the front. The claim stays immediately before the dry run and the call,
 * which is the property that makes a crash between claim and call safe;
 * moving it earlier would be a different mistake.
 *
 * NOTE (M5-D1): the three safety reads above — kill switch, breaker, dry-run
 * — are deliberately duplicated from `gateway.ts` rather than extracted into
 * a shared helper. Extraction would mean editing the moderation chokepoint to
 * call it, which is the one thing that ruling exists to avoid. Once the
 * observe window closes, extracting them is the cleanup to do.
 *
 * NOTE (M5-D12): this gateway respects the circuit breaker but must never
 * trip it — deliberately asymmetric with `gateway.ts`, where a rate-cap
 * overflow trips the breaker (`gateway.ts:280`). The breaker is guild-wide
 * and shared with the moderation effect path: if an MCP send hitting its
 * ten-per-hour cap opened it, the owner's Claude client — or anything
 * driving that client — would hold a lever that pauses moderation effects
 * for the entire guild. That is the MCP surface reaching into moderation,
 * which this design says it must never be, and the lever would stay
 * available for the whole of an observe window. So this module refuses when
 * the breaker is open and calls nothing that opens it. Do not "fix" the
 * asymmetry by adding a trip on the rate-cap path.
 */

export interface MessageIntent {
  readonly channelId: SnowflakeId;
  readonly content: string;
  /** Layer A (M5-D8). Caller-supplied; the tool requires it. */
  readonly idempotencyKey: string;
  /** The `tok_…` row id that authorised this send. Never a token value. */
  readonly tokenId: string;
}

export type MessageRefusalReason =
  | 'guild-unknown'
  | 'channel-not-allowlisted'
  | 'channel-not-in-guild'
  | 'killswitch'
  | 'breaker-open'
  | 'rate-cap'
  | 'duplicate-key-different-content'
  | 'duplicate-content-recently';

export type MessageOutcome =
  | { readonly status: 'sent'; readonly messageId: string }
  | { readonly status: 'dry-run' }
  | { readonly status: 'replayed'; readonly messageId: string | undefined }
  | { readonly status: 'refused'; readonly reason: MessageRefusalReason }
  | { readonly status: 'failed'; readonly code: string };

/**
 * What this module needs from safety state. Declared here rather than
 * imported from `gateway.ts` so this module has no dependency on that file
 * at all (M5-D1).
 */
export interface SafetyStateForSend {
  readonly killswitch: boolean;
  readonly dryRun: boolean;
  readonly breakerOpen: boolean;
}

/** One claimed row of the `mcp_sends` ledger, as the gateway sees it. */
export interface SendLedgerRow {
  readonly idempotencyKey: string;
  readonly channelId: string;
  readonly contentHash: string;
  readonly messageId: string | undefined;
  readonly tokenId: string;
  readonly sentAt: number;
  readonly outcome: 'sent' | 'dry_run';
}

/**
 * What the gateway reports per accepted send. Carries the channel, never the
 * content — content lives in `mcp_sends` and in Discord (plan constraint 5).
 */
export interface MessageAuditInput {
  readonly channelId: SnowflakeId;
  readonly tokenId: string;
  readonly outcome: 'sent' | 'dry-run' | 'failed';
  readonly messageId: string | undefined;
  readonly dryRun: boolean;
  readonly atMs: number;
}

/**
 * Everything the gateway needs, as ports.
 *
 * `core` holds the ordering and the decisions; the guild scope, the database
 * handle and the concrete Discord client all stay on the other side of these
 * interfaces — the same split `EffectGatewayDeps` uses.
 */
export interface MessageGatewayDeps {
  readonly guildId: GuildId;
  readonly discord: DiscordPort;
  readonly logger: Logger;
  now(): number;

  readonly state: {
    read(): SafetyStateForSend | undefined;
    isChannelAllowed(channelId: SnowflakeId): boolean;
    /**
     * Whether the channel is a text-capable channel of this guild (C2
     * send-time defence in depth). The allowlist is data: a row written
     * before allow-time validation existed, or by a future path, must not be
     * able to post outside the guild. Checked alongside the allowlist, with
     * its own refusal reason.
     */
    isChannelInGuild(channelId: SnowflakeId): boolean;
  };

  readonly sends: {
    find(idempotencyKey: string): SendLedgerRow | undefined;
    claim(input: {
      idempotencyKey: string;
      channelId: string;
      contentHash: string;
      tokenId: string;
      now: number;
      outcome: 'sent' | 'dry_run';
    }): { readonly claimed: boolean };
    recordMessageId(input: { idempotencyKey: string; messageId: string }): void;
    countSince(sinceMs: number): number;
    /** M5-D8 layer B: identical content to this channel within the window. */
    findRecentByContent(contentHash: string, channelId: string, sinceMs: number): boolean;
  };

  readonly audit: { record(input: MessageAuditInput): void };
}

/**
 * Ten accepted sends per guild per rolling hour (ruling M5-D4).
 *
 * Mirrors `SEND_RATE_LIMIT` / `SEND_RATE_WINDOW_MS` in
 * `packages/storage/src/repos/mcp-send.ts`. Duplicated rather than imported:
 * `core` cannot depend on `storage` (the dependency runs the other way), so
 * the Task 4 wiring passes repository-backed ports and this module owns the
 * numbers it enforces. If the cap ever changes, both places change together.
 */
export const MESSAGE_SEND_RATE_LIMIT = 10;
export const MESSAGE_SEND_RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * M5-D8 layer B: identical content to the same channel within sixty seconds
 * is a refusal, whatever the key says — a model client that retries a
 * timed-out call regenerates its arguments, including a random key, so layer
 * A cannot see that retry. Sixty seconds, not the cap's hour, so the same
 * text is still sendable tomorrow.
 */
export const DUPLICATE_CONTENT_WINDOW_MS = 60 * 1000;

/**
 * The content hash (ruling M5-D3). `sha256(channel_id ‖ content)` — the
 * channel is in the hash so the same text to two channels is not the same
 * message.
 *
 * A pure function rather than a port, like `dedupeKeyFor`: getting it wrong
 * silently breaks idempotency, and a port would let each caller get it wrong
 * differently.
 */
export const contentHashFor = (channelId: string, content: string): string =>
  createHash('sha256').update([channelId, content].join('\u0000')).digest('hex');

export const sendMessageEffect = async (
  deps: MessageGatewayDeps,
  intent: MessageIntent,
): Promise<MessageOutcome> => {
  const now = deps.now();
  const contentHash = contentHashFor(intent.channelId, intent.content);
  const refuse = (reason: MessageRefusalReason): MessageOutcome => {
    deps.logger.warn(
      safeLogFields({
        component: 'message-effects',
        guildId: deps.guildId,
        channelId: intent.channelId,
        oauthTokenId: intent.tokenId,
        dedupeKey: intent.idempotencyKey,
        outcome: 'refused',
        reason,
      }),
      'message send refused',
    );
    return { status: 'refused', reason };
  };

  // --- 1. allowlist -------------------------------------------------------
  // The readable refusal; the guild-scoped table is the guarantee. Checked
  // first so nothing else — not even a safety-state read — runs for a
  // channel the owner never allowed.
  if (!deps.state.isChannelAllowed(intent.channelId)) return refuse('channel-not-allowlisted');

  // --- 1b. guild membership (C2 send-time defence in depth) -----------------
  // The allowlist is data, and a row written before allow-time validation
  // existed must not be able to post outside the guild. A DM-shaped id that
  // somehow holds a row lands here, never at the REST call.
  if (!deps.state.isChannelInGuild(intent.channelId)) return refuse('channel-not-in-guild');

  // --- 2, 3. kill switch and breaker --------------------------------------
  const state = deps.state.read();
  if (!state) return refuse('guild-unknown');
  if (state.killswitch) return refuse('killswitch');
  if (state.breakerOpen) return refuse('breaker-open');

  // --- 4, 5. idempotency read + identical-content window ------------------
  // Layer A (M5-D8): the explicit key, read before anything that depends on
  // present conditions (M5-D9). Three outcomes (M5-D3) — key absent means
  // continue toward a send; key present with a matching hash means replay the
  // first result and send nothing; key present with a different hash means
  // refuse, because a client told its message was sent when it never was is
  // the failure this design is against.
  const existing = deps.sends.find(intent.idempotencyKey);
  if (existing !== undefined) {
    if (existing.contentHash === contentHash) {
      return { status: 'replayed', messageId: existing.messageId };
    }
    return refuse('duplicate-key-different-content');
  }
  // Layer B (M5-D8): identical content to this channel inside sixty seconds
  // is a refusal whatever the key says. Checked before the cap and the claim
  // so it costs no capacity, no key and no row.
  if (
    deps.sends.findRecentByContent(contentHash, intent.channelId, now - DUPLICATE_CONTENT_WINDOW_MS)
  ) {
    return refuse('duplicate-content-recently');
  }

  // --- 6. rate cap ---------------------------------------------------------
  // Durable (ruling M5-D4): counted from `mcp_sends` rows, never an
  // in-memory bucket, so a restart does not hand out ten more. Counted:
  // accepted sends (`sent` and `dry_run` rows). Not counted: refusals —
  // otherwise a client hammering a non-allowlisted channel would lock the
  // owner out of the channels they can post to. And not consulted for
  // replays at all: those returned above, because a replay is not a send
  // (M5-D9) — only genuinely new sends reach this line.
  if (deps.sends.countSince(now - MESSAGE_SEND_RATE_WINDOW_MS) >= MESSAGE_SEND_RATE_LIMIT) {
    return refuse('rate-cap');
  }

  // --- 7. idempotency claim -------------------------------------------------
  // Before the REST call, deliberately (hard rule 6). If the
  // process dies between the claim and the call, the row is already there
  // and a retry replays it — the failure direction that does not
  // double-send. A lost race on one key re-reads to decide replay (hash
  // matches) from collision (hash differs) rather than guessing.
  const claim = deps.sends.claim({
    idempotencyKey: intent.idempotencyKey,
    channelId: intent.channelId,
    contentHash,
    tokenId: intent.tokenId,
    now,
    outcome: state.dryRun ? 'dry_run' : 'sent',
  });
  if (!claim.claimed) {
    const raced = deps.sends.find(intent.idempotencyKey);
    if (raced !== undefined && raced.contentHash === contentHash) {
      return { status: 'replayed', messageId: raced.messageId };
    }
    return refuse('duplicate-key-different-content');
  }

  // --- 8. dry run ----------------------------------------------------------
  // Recorded, not sent: the ledger row already exists (claimed above with
  // `dry_run`), so a dry-run send still costs rate-cap room — letting it be
  // free would make the cap depend on a safety toggle (M5-D4).
  if (state.dryRun) {
    deps.audit.record({
      channelId: intent.channelId,
      tokenId: intent.tokenId,
      outcome: 'dry-run',
      messageId: undefined,
      dryRun: true,
      atMs: now,
    });
    deps.logger.info(
      safeLogFields({
        component: 'message-effects',
        guildId: deps.guildId,
        channelId: intent.channelId,
        oauthTokenId: intent.tokenId,
        dedupeKey: intent.idempotencyKey,
        dryRun: true,
        outcome: 'dry-run',
      }),
      'dry run: no Discord call was made',
    );
    return { status: 'dry-run' };
  }

  // --- 9. execute -----------------------------------------------------------
  // The single REST call in the system that posts on the owner's behalf.
  // `allowedMentions` is forced empty here (M5-D2): nothing else in the tree
  // sets it, so absent would mean Discord's default — parse everything,
  // including @everyone.
  let messageId: string;
  try {
    const ref = await deps.discord.sendMessage(deps.guildId, intent.channelId, {
      content: intent.content,
      allowedMentions: { parse: [] },
    });
    messageId = ref.messageId;
  } catch (err) {
    // The ledger still holds the claim (outcome `sent`, no message id), so a
    // retry with the same key replays instead of double-sending. The failure
    // that matters here is not a rejected POST but a lost response: Discord
    // may have accepted the POST, so the audit row records the attempt as
    // `failed` without claiming nothing was posted — nobody knows that.
    const code = err instanceof Error ? err.name : 'UnknownError';
    deps.audit.record({
      channelId: intent.channelId,
      tokenId: intent.tokenId,
      outcome: 'failed',
      messageId: undefined,
      dryRun: false,
      atMs: deps.now(),
    });
    deps.logger.error(
      safeLogFields({
        component: 'message-effects',
        guildId: deps.guildId,
        channelId: intent.channelId,
        oauthTokenId: intent.tokenId,
        dedupeKey: intent.idempotencyKey,
        outcome: 'failed',
        code,
        err,
      }),
      'the Discord call failed',
    );
    return { status: 'failed', code };
  }

  // --- 10. record ------------------------------------------------------------
  deps.sends.recordMessageId({ idempotencyKey: intent.idempotencyKey, messageId });
  deps.audit.record({
    channelId: intent.channelId,
    tokenId: intent.tokenId,
    outcome: 'sent',
    messageId,
    dryRun: false,
    atMs: deps.now(),
  });

  return { status: 'sent', messageId };
};
