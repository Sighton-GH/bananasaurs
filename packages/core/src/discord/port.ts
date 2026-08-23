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

export interface AuditLogEntry {
  /** Best-effort and frequently absent; never presented as established fact. */
  actorUserId: Snowflake | undefined;
  targetId: Snowflake | undefined;
  actionType: 'message_delete' | 'member_kick' | 'member_ban' | 'role_update';
  createdAtMs: number;
  reason: string | undefined;
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
