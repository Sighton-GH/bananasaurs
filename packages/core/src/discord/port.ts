/**
 * Everything Bananasaurs needs from Discord in Release 1, and nothing else.
 *
 * This is the seam the fake harness implements. It is deliberately narrow: a
 * port that mirrors discord.js would be as hard to fake as discord.js itself,
 * and the point is that every test runs with no network.
 *
 * Guild scope is a parameter on every call that has one, so a caller cannot
 * reach another guild's data by omission.
 */

export type Snowflake = string;

/** Canonical emoji key. `u:<codepoints>` for unicode, `c:<id>` for custom. */
export type EmojiKey = string;

export interface DiscordRole {
  id: Snowflake;
  name: string;
  position: number;
  /** Integration-managed roles cannot be assigned at any position. */
  managed: boolean;
}

export interface DiscordMember {
  userId: Snowflake;
  roleIds: readonly Snowflake[];
  /** Discord never lets a bot act on the guild owner. */
  isGuildOwner: boolean;
}

export interface DiscordMessageRef {
  channelId: Snowflake;
  messageId: Snowflake;
}

export interface ReactionUserPage {
  userIds: readonly Snowflake[];
  /** Pass back as `after` to continue. Undefined when the page is the last. */
  nextAfter: Snowflake | undefined;
}

/**
 * One guild audit log entry. See [ADR 0019](../../../../docs/decisions/0019-audit-log-entries-are-coalesced-and-late.md),
 * which is required reading before writing anything that correlates these with
 * a gateway event: they are coalesced, they arrive late, and a self-deletion
 * produces no entry at all.
 */
export interface AuditLogEntry {
  /** Best-effort and frequently absent; never presented as established fact. */
  actorUserId: Snowflake | undefined;
  /**
   * **What this identifies depends on the action.** For `message_delete` it is
   * the *author of the deleted messages*, not the message — a `MESSAGE_DELETE`
   * entry carries no message id at all, so nothing can correlate on one
   * (ADR 0019). For `member_kick`, `member_ban` and `role_update` it is the
   * member acted on.
   */
  targetId: Snowflake | undefined;
  actionType: 'message_delete' | 'member_kick' | 'member_ban' | 'role_update';
  createdAtMs: number;
  reason: string | undefined;
  /**
   * Running total on a **coalesced** entry.
   *
   * Discord updates one entry's `count` when the same actor deletes several
   * messages by the same author in the same channel, rather than writing an
   * entry each time. So an entry describes a *run* of deletions, and the only
   * evidence that a new one joined the run is that this number went up since
   * the last look. Undefined when Discord sent no `options` for the action.
   */
  count: number | undefined;
  /** The channel a coalesced `message_delete` run belongs to, when Discord says. */
  channelId: Snowflake | undefined;
}

/**
 * How a response to an interaction is addressed.
 *
 * The token is a short-lived credential and travels only between the adapter
 * and this port. It is not in `LOGGABLE_FIELDS`, so it cannot reach a log line
 * through `safeLogFields`.
 */
export interface InteractionRef {
  interactionId: Snowflake;
  token: string;
}

export interface OutgoingMessage {
  content?: string | undefined;
  embeds?: readonly unknown[] | undefined;
  components?: readonly unknown[] | undefined;
}

/** One message as `fetchRecentMessages` reports it. */
export interface FetchedMessage {
  messageId: Snowflake;
  /** Absent for a webhook or system message — never guessed. */
  authorId: Snowflake | undefined;
  /** From the snowflake itself, like every timestamp Discord does not send. */
  createdAtMs: number;
  content: string | undefined;
}

export interface RecentMessagesPage {
  messages: readonly FetchedMessage[];
  /** Pass back as `before` to continue. Undefined when the page is the last. */
  nextBefore: Snowflake | undefined;
}

export interface DiscordPort {
  // --- roles -------------------------------------------------------------
  addRole(guildId: Snowflake, userId: Snowflake, roleId: Snowflake, reason: string): Promise<void>;
  removeRole(
    guildId: Snowflake,
    userId: Snowflake,
    roleId: Snowflake,
    reason: string,
  ): Promise<void>;

  /** Live guild roles with positions. Hierarchy is checked against this. */
  fetchRoles(guildId: Snowflake): Promise<readonly DiscordRole[]>;
  /** The bot's own highest role position, recomputed rather than cached. */
  fetchBotHighestRolePosition(guildId: Snowflake): Promise<number>;

  // --- members -----------------------------------------------------------
  fetchMember(guildId: Snowflake, userId: Snowflake): Promise<DiscordMember>;

  // --- messages and reactions -------------------------------------------
  fetchMessage(guildId: Snowflake, ref: DiscordMessageRef): Promise<{ exists: true }>;
  createReaction(guildId: Snowflake, ref: DiscordMessageRef, emoji: EmojiKey): Promise<void>;
  /**
   * Paginated at 100. An adopted panel with many reactors needs several calls,
   * which is why the adoption pass is a resumable job rather than a request.
   */
  fetchReactionUsers(
    guildId: Snowflake,
    ref: DiscordMessageRef,
    emoji: EmojiKey,
    options?: { after?: Snowflake | undefined; limit?: number | undefined },
  ): Promise<ReactionUserPage>;

  sendMessage(
    guildId: Snowflake,
    channelId: Snowflake,
    message: OutgoingMessage,
  ): Promise<DiscordMessageRef>;
  editMessage(guildId: Snowflake, ref: DiscordMessageRef, message: OutgoingMessage): Promise<void>;

  /** Not hierarchy-gated — works against any member's message, any role. */
  deleteMessage(guildId: Snowflake, ref: DiscordMessageRef, reason: string): Promise<void>;

  // --- moderation ----------------------------------------------------------
  /** `durationMs` is clamped to Discord's 28-day maximum by the caller. */
  timeoutMember(
    guildId: Snowflake,
    userId: Snowflake,
    durationMs: number,
    reason: string,
  ): Promise<void>;
  kickMember(guildId: Snowflake, userId: Snowflake, reason: string): Promise<void>;
  /**
   * Bans a member. No message-deletion parameter (ADR 0037): Discord's
   * `delete_message_days` is deprecated, and message removal is purge's
   * explicit, separately-attributed job.
   */
  banMember(guildId: Snowflake, userId: Snowflake, reason: string): Promise<void>;
  /** Lifts a ban. No member fetch, no hierarchy — the target is not a member. */
  unbanMember(guildId: Snowflake, userId: Snowflake, reason: string): Promise<void>;
  /**
   * Bulk-deletes 2..100 messages in one call. **Discord rejects the entire
   * call if any message is 14 days old or older** — the caller buckets by
   * age, it never sends a mixed batch (ADR 0037).
   */
  bulkDeleteMessages(
    guildId: Snowflake,
    channelId: Snowflake,
    messageIds: readonly Snowflake[],
    reason: string,
  ): Promise<void>;
  /**
   * Recent messages in a channel, newest first, for the purge preview and
   * the purge job's pagination. A full page carries `nextBefore` (the oldest
   * id on the page) to continue from; a short page is the end.
   */
  fetchRecentMessages(
    guildId: Snowflake,
    channelId: Snowflake,
    options: { before?: Snowflake | undefined; limit?: number | undefined },
  ): Promise<RecentMessagesPage>;

  // --- interactions ------------------------------------------------------
  /**
   * Acknowledges an interaction. **Three seconds, and Discord is strict.**
   *
   * Miss it and the token is discarded — not queued, not retried — and the
   * member sees "This interaction failed" no matter what the bot does
   * afterwards. A role change takes a member fetch, a role fetch and a REST
   * call, so the acknowledgement cannot wait for it: defer first, act, then
   * follow up. `ephemeral` makes the eventual reply visible only to the member
   * who clicked, which is what a role confirmation should be.
   */
  deferInteraction(
    guildId: Snowflake,
    ref: InteractionRef,
    options: { ephemeral: boolean },
  ): Promise<void>;

  /** The follow-up, after a defer. Fifteen minutes from the interaction. */
  respondToInteraction(
    guildId: Snowflake,
    ref: InteractionRef,
    message: OutgoingMessage,
  ): Promise<void>;

  // --- audit log ---------------------------------------------------------
  /** Attribution for MESSAGE_DELETE, which carries no actor of its own. */
  fetchAuditLog(
    guildId: Snowflake,
    options: { actionType: AuditLogEntry['actionType']; limit?: number | undefined },
  ): Promise<readonly AuditLogEntry[]>;

  // --- guild lifecycle ---------------------------------------------------
  /** Called when GUILD_CREATE fires for a guild outside the allowlist. */
  leaveGuild(guildId: Snowflake): Promise<void>;
}
