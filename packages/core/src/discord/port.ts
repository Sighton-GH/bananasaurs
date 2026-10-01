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

import type { MessageAttachment } from './events.js';

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
  /**
   * Discord's allowed_mentions. Absent means Discord's default, which parses
   * every mention in the content — so most outputs set `{ parse: [] }`
   * (ruling M5-D2). Not defaulted here: changing what panel
   * posts and log messages do is a behaviour change, and two guilds are
   * being observed. Only reminder delivery may put `'everyone'` in `parse`
   * or set `users`; every other output keeps `{ parse: [] }`.
   */
  allowedMentions?:
    | {
        readonly parse: readonly 'everyone'[];
        readonly roles?: readonly string[] | undefined;
        readonly users?: readonly string[] | undefined;
      }
    | undefined;
  /**
   * The message this one replies to (ADR 0072). When set, the REST adapter
   * emits `message_reference` and forces `allowed_mentions.replied_user:
   * true` so the replied-to member is pinged even though `allowedMentions`
   * itself is otherwise `{ parse: [] }` everywhere. Absent, the wire output
   * is byte-identical to a message with no reply at all.
   */
  replyTo?: string | undefined;
  /**
   * Opt-out of the reply ping (ADR 0072): only `false` suppresses the
   * replied-to member's ping. Undefined keeps today's behaviour —
   * `replied_user: true`.
   */
  pingReplyAuthor?: boolean | undefined;
}

/** One message as `fetchRecentMessages` reports it. */
export interface FetchedMessage {
  messageId: Snowflake;
  /** Absent for a webhook or system message — never guessed. */
  authorId: Snowflake | undefined;
  /** From the snowflake itself, like every timestamp Discord does not send. */
  createdAtMs: number;
  content: string | undefined;
  /**
   * From `edited_timestamp`. Optional (PR-71): `fetchRecentMessages`'s
   * existing callers (purge) predate this field and must not be touched
   * during the observe window. The REST adapter and `FakeDiscord` always
   * populate it.
   */
  editedTimestampMs?: number | undefined;
  /**
   * Metadata only. Optional (PR-71) for the same pre-existing-caller reason
   * as `editedTimestampMs`; the REST adapter and `FakeDiscord` always
   * populate it (possibly empty).
   */
  attachments?: readonly MessageAttachment[] | undefined;
}

export interface DiscordThread {
  readonly id: Snowflake;
  /** The thread's title — for a forum post, the only thing that names it. */
  readonly name: string;
  readonly isPrivate: boolean;
  /** True for threads from the archived listing, false for active ones. */
  readonly archived: boolean;
}

/**
 * One guild scheduled event as `listScheduledEvents` reports it (ADR 0092).
 * `channelId` is absent for external events; `location` comes from the
 * event's entity metadata when Discord carries one.
 */
export interface ScheduledEvent {
  readonly id: Snowflake;
  readonly name: string;
  readonly description?: string | undefined;
  /** From `scheduled_start_time`. */
  readonly scheduledStartAt: number;
  readonly channelId?: Snowflake | undefined;
  readonly location?: string | undefined;
}

export interface RecentMessagesPage {
  messages: readonly FetchedMessage[];
  /** Pass back as `before` to continue. Undefined when the page is the last. */
  nextBefore: Snowflake | undefined;
}

/**
 * One channel message as `fetchChannelMessages` reports it (ADR 0089 channel
 * context).
 *
 * Named `RecentMessage` (not `FetchedMessage`): the purge pager already owns
 * that shape, and this one carries display names, the bot flag and the reply
 * target instead of edit metadata.
 */
export interface RecentMessage {
  readonly messageId: Snowflake;
  readonly authorId: Snowflake;
  /** Nick, then global name, then username — as `fetchMessageContent` reads it. */
  readonly authorName: string;
  readonly authorIsBot: boolean;
  readonly content: string;
  /** From the message's `timestamp`. */
  readonly at: number;
  /** From `referenced_message.author`, when the message is a reply. */
  readonly referencedAuthorName?: string | undefined;
  readonly hasAttachments: boolean;
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
  /**
   * One message's live pin state and reaction counts (slice 2, Task 6): `GET
   * /channels/{channel}/messages/{message}` — the same route `fetchMessage`
   * already reads — projected to `pinned` and `reactions[].{emoji, count}`
   * (`emoji` is `<:name:id>` for custom emoji, the unicode characters
   * otherwise). `undefined` on 404 (gone) or 403 (no access) — both routine
   * here, reported the same way rather than thrown, so the caller answers
   * without the metadata instead of failing. Any other error propagates.
   *
   * The return shape is inline, like `fetchMessage`'s `{ exists: true }`:
   * one method's two fields need no named type.
   */
  fetchMessageMeta(
    guildId: Snowflake,
    ref: DiscordMessageRef,
  ): Promise<
    | {
        readonly pinned: boolean;
        readonly reactions: readonly { readonly emoji: string; readonly count: number }[];
      }
    | undefined
  >;
  createReaction(guildId: Snowflake, ref: DiscordMessageRef, emoji: EmojiKey): Promise<void>;
  /** Removes the bot's own reaction; other members' reactions are untouched. */
  deleteOwnReaction(guildId: Snowflake, ref: DiscordMessageRef, emoji: EmojiKey): Promise<void>;
  /** Pins a channel message. */
  pinMessage(guildId: Snowflake, ref: DiscordMessageRef): Promise<void>;
  /** Unpins a channel message; unpinning an unpinned message is not an error. */
  unpinMessage(guildId: Snowflake, ref: DiscordMessageRef): Promise<void>;
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
  /**
   * One message's author and content, for the assistant's conversation
   * resolver to quote a message a member replied to that it does not
   * already know (ADR 0072). `undefined` on 404 (gone) or 403 (no access) —
   * both are routine here, a normal member reading a normal channel, and are
   * reported the same way rather than thrown, so the resolver can fall back
   * to "no quote available" instead of the whole turn failing.
   */
  fetchMessageContent(
    guildId: Snowflake,
    channelId: Snowflake,
    messageId: Snowflake,
  ): Promise<{ authorId: Snowflake; authorName: string; content: string } | undefined>;
  /** One message's author, content and embeds: edit/delete eligibility and undo (ADR 0116 §4). */
  fetchMessageAuthor(
    guildId: Snowflake,
    ref: DiscordMessageRef,
  ): Promise<{ authorId: string; content: string; embeds: readonly unknown[] } | undefined>;
  /**
   * Channel context for the assistant (ADR 0089): up to `limit` messages sent
   * before `before` in one channel, oldest first — or, when `before` is
   * absent, the channel's newest `limit` messages. `undefined` on 404 (gone)
   * or 403 (no access) — both routine, reported the same way rather than
   * thrown, so the caller answers without the block instead of failing.
   *
   * Named `fetchChannelMessages`, not ADR 0089's `fetchRecentMessages`: that
   * name is taken by the purge pager above, whose newest-first page-plus-
   * cursor contract is a different fetch. The job-level closure keeps the
   * spec's `fetchRecentMessages` name; only the port method differs.
   */
  fetchChannelMessages(
    guildId: Snowflake,
    channelId: Snowflake,
    opts: { before?: Snowflake | undefined; limit: number },
  ): Promise<readonly RecentMessage[] | undefined>;
  /** The "is typing…" indicator, shown for about ten seconds or until the next message. */
  sendTyping(guildId: Snowflake, channelId: Snowflake): Promise<void>;

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
  /**
   * Removes a member's timeout by setting `communication_disabled_until` to
   * null. Hierarchy-gated by Discord exactly like `timeoutMember`, so the
   * gateway keeps the full member path for it (ADR 0037).
   */
  untimeoutMember(guildId: Snowflake, userId: Snowflake, reason: string): Promise<void>;
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
  /**
   * Active and archived public threads under a parent. Private threads are
   * never fetched. Required (review S6): an optional port silently served
   * an empty list, which read as "no threads" rather than "not wired".
   */
  listPublicThreads(guildId: Snowflake, channelId: Snowflake): Promise<readonly DiscordThread[]>;
  /**
   * Whether a user is a member of a thread (ADR 0115): `GET
   * /channels/{thread}/thread-members/{user}` — 200 answers true, 404
   * answers false. Checked live on every private-thread read, never cached;
   * any other error propagates.
   */
  isThreadMember(guildId: Snowflake, threadId: Snowflake, userId: Snowflake): Promise<boolean>;
  /**
   * One thread's facts over REST (ADR 0115's sweeper fallback): `GET
   * /channels/{thread}` — `undefined` on 404 (gone) or 403 (no access),
   * when the channel is not in this guild, when it is not a thread, or when
   * it has no parent. Any other error propagates. The MCP daemon calls this
   * only on a gateway-cache miss, so a swept archived thread still resolves
   * and its archive rows still read.
   *
   * The return shape is inline, like `fetchMessage`'s `{ exists: true }`:
   * the package index names no thread-info type, and none is needed for one
   * method's four fields.
   */
  fetchThreadInfo(
    guildId: Snowflake,
    threadId: Snowflake,
  ): Promise<
    | {
        readonly id: Snowflake;
        readonly name: string;
        readonly parentId: Snowflake;
        readonly isPrivate: boolean;
      }
    | undefined
  >;
  /**
   * Guild scheduled events for the assistant's `upcoming_events` tool
   * (ADR 0092 decision 1): `GET /guilds/{id}/scheduled-events`, no gateway
   * intent needed. An empty list when there are none — or when the bot may
   * not see them (403).
   */
  listScheduledEvents(guildId: Snowflake): Promise<readonly ScheduledEvent[]>;

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

  /**
   * The follow-up, after a defer. Fifteen minutes from the interaction.
   *
   * Returns the posted message's ref when Discord reports one (a real
   * interaction follow-up always does), so a caller can link the answer into
   * a conversation the same way `sendMessage` does. `undefined` only when
   * the adapter genuinely was not told one — never fabricated.
   */
  respondToInteraction(
    guildId: Snowflake,
    ref: InteractionRef,
    message: OutgoingMessage,
  ): Promise<DiscordMessageRef | undefined>;

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
