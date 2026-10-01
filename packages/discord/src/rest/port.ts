import {
  AuditLogEvent,
  ChannelType,
  InteractionResponseType,
  MessageFlags,
  Routes,
  makeURLSearchParams,
  type APIAuditLog,
  type APIAuditLogEntry,
  type APIChannel,
  type APIGuild,
  type APIGuildMember,
  type APIGuildScheduledEvent,
  type APIMessage,
  type APIThreadList,
  type APIRole,
  type APIUser,
  type REST,
} from 'discord.js';
import { DiscordApiError, unicodeEmojiChars } from '@bananasaurs/core';
import type {
  AuditLogEntry,
  DiscordMember,
  DiscordMessageRef,
  DiscordPort,
  DiscordRole,
  EmojiKey,
  InteractionRef,
  OutgoingMessage,
  ReactionUserPage,
  RecentMessage,
  Snowflake,
} from '@bananasaurs/core';
import { mapErrors } from './errors.js';

/**
 * `DiscordPort` over discord.js's REST client.
 *
 * Raw routes, not discord.js structures. The structure API resolves through the
 * client cache, which slice 6a deliberately made tiny, so a structure call can
 * silently become an extra fetch that no rate cap authorised and no guild scope
 * covers. Raw routes keep every request explicit, put the guild id in the URL
 * wherever Discord's route has one, and make `DiscordAPIError` the single error
 * shape to map (ADR 0018).
 */

export interface RestPortDeps {
  /**
   * **The client's own REST instance**, not one of ours. Two REST instances keep
   * separate rate-limit buckets and would race each other past Discord's global
   * cap, so the composition root passes `client.rest`.
   */
  rest: REST;
  /** Needed to address interaction follow-ups; the interaction does not carry it. */
  applicationId: Snowflake;
  /** A thunk: `client.user` does not exist until READY. */
  botUserId: () => string | undefined;
  /**
   * Guild ownership, from the gateway cache when the composition root has one.
   *
   * `GUILD_CREATE` carries `owner_id` and `GUILD_UPDATE` keeps it current, so
   * this is free and already correct. Without it every `fetchMember` costs a
   * second request — and reconciliation fetches one member per drifted member,
   * against the same rate cap. Returning `undefined` falls back to fetching.
   */
  guildOwnerId?: (guildId: Snowflake) => string | undefined;
}

/** How long an interaction token can be followed up. Bounds the defer map. */
const FOLLOWUP_WINDOW_MS = 15 * 60_000;

/** Discord's epoch, which every snowflake timestamp is an offset from. */
const DISCORD_EPOCH_MS = 1_420_070_400_000;

/** Discord caps a reaction page at 100 regardless of what you ask for. */
const MAX_REACTION_PAGE = 100;

/**
 * Our four audit actions, as Discord's numbers.
 *
 * `role_update` is `MemberRoleUpdate`, **not** `RoleUpdate`. The other three are
 * moderation actions targeting a member or a message, and `MemberRoleUpdate`
 * targets a user id the same way — "who changed this member's roles", which is
 * what amendment 5's drift detection and WP4's role logging need. `RoleUpdate`
 * targets a *role* and describes its own settings changing, which nothing in
 * Release 1 logs. Nothing consumed `role_update` before this slice, so this is
 * the choice being made rather than one being followed.
 */
const AUDIT_ACTION_TYPES = {
  message_delete: AuditLogEvent.MessageDelete,
  member_kick: AuditLogEvent.MemberKick,
  member_ban: AuditLogEvent.MemberBanAdd,
  role_update: AuditLogEvent.MemberRoleUpdate,
} as const satisfies Record<AuditLogEntry['actionType'], AuditLogEvent>;

interface DeferredInteraction {
  ephemeral: boolean;
  atMs: number;
}

/**
 * `GET /channels/{channelId}/messages/{messageId}` includes `member` — a
 * partial guild member of the message's author — when the message was
 * posted in a guild, which is what `fetchMessageContent` reads for a
 * nickname. `discord-api-types`'s `APIMessage` does not declare it (its own
 * comment marks the field gateway-only), so it is extended locally rather
 * than widened in the library's own type.
 */
type APIMessageWithMember = APIMessage & { member?: { nick?: string | null } };

export function createDiscordRestPort(deps: RestPortDeps): DiscordPort {
  const { rest, applicationId } = deps;

  /**
   * Whether each deferred interaction asked for an ephemeral reply.
   *
   * Discord does not infer it: a follow-up to an ephemeral defer is **public**
   * unless the flag is repeated, which would announce a member's role changes to
   * the whole channel. `DiscordPort.respondToInteraction` deliberately does not
   * carry the flag — the decision was made at defer time — so the adapter
   * remembers it. Pruned on write, so it cannot grow: an entry is useless once
   * the fifteen-minute follow-up window has passed.
   */
  const deferred = new Map<Snowflake, DeferredInteraction>();

  const rememberDefer = (interactionId: Snowflake, ephemeral: boolean): void => {
    const now = Date.now();
    for (const [id, state] of deferred) {
      if (now - state.atMs > FOLLOWUP_WINDOW_MS) deferred.delete(id);
    }
    deferred.set(interactionId, { ephemeral, atMs: now });
  };

  return {
    // --- roles -----------------------------------------------------------
    async addRole(guildId, userId, roleId, reason) {
      await mapErrors(() => rest.put(Routes.guildMemberRole(guildId, userId, roleId), { reason }));
    },

    async removeRole(guildId, userId, roleId, reason) {
      await mapErrors(() =>
        rest.delete(Routes.guildMemberRole(guildId, userId, roleId), { reason }),
      );
    },

    async fetchRoles(guildId) {
      const roles = (await mapErrors(() => rest.get(Routes.guildRoles(guildId)))) as APIRole[];
      return roles.map(toDiscordRole);
    },

    async fetchBotHighestRolePosition(guildId) {
      const botUserId = deps.botUserId();
      if (botUserId === undefined) {
        // Before READY there is no "our own member" to ask about, and answering
        // with a number would make every role look assignable.
        throw new Error('the bot user id is not known yet; the client has not reached READY');
      }
      const member = (await mapErrors(() =>
        rest.get(Routes.guildMember(guildId, botUserId)),
      )) as APIGuildMember;
      const roles = (await mapErrors(() => rest.get(Routes.guildRoles(guildId)))) as APIRole[];

      const held = new Set(member.roles);
      let highest = 0; // @everyone, which is where a bot with no roles sits.
      for (const role of roles) {
        if (held.has(role.id) && role.position > highest) highest = role.position;
      }
      return highest;
    },

    // --- members ---------------------------------------------------------
    async fetchMember(guildId, userId) {
      const member = (await mapErrors(() =>
        rest.get(Routes.guildMember(guildId, userId)),
      )) as APIGuildMember;

      let ownerId = deps.guildOwnerId?.(guildId);
      if (ownerId === undefined) {
        const guild = (await mapErrors(() => rest.get(Routes.guild(guildId)))) as APIGuild;
        ownerId = guild.owner_id;
      }

      const resolved: DiscordMember = {
        userId: member.user?.id ?? userId,
        roleIds: member.roles,
        isGuildOwner: (member.user?.id ?? userId) === ownerId,
      };
      return resolved;
    },

    // --- messages and reactions ------------------------------------------
    //
    // `_guildId` on the next seven methods is not an oversight. Discord's
    // channel, message and interaction routes are addressed by channel or by
    // interaction, with **no guild id in the URL** — so the adapter has nothing
    // to put it in. Guild scope is still mandatory and still enforced: it is on
    // the port signature, which is where CLAUDE.md rule 2 says to enforce it, so
    // no caller can reach these without having named a guild.
    //
    // What this does mean is that real Discord will happily act on a channel in
    // another guild if a caller passes a mismatched pair, where `FakeDiscord`
    // refuses. See the session log — the fake is stricter than Discord here, and
    // that strictness is worth keeping precisely because Discord has none.
    async fetchMessage(_guildId, ref) {
      await mapErrors(() => rest.get(Routes.channelMessage(ref.channelId, ref.messageId)));
      return { exists: true };
    },

    /**
     * Live pin state and reaction counts (slice 2, Task 6): the same
     * `GET channelMessage` route `fetchMessage` already reads, projected to
     * `pinned` and `reactions[].{emoji, count}`. A custom emoji renders as
     * `<:name:id>` — the name Discord reports on the reaction, which is
     * display text, not identity — and a unicode one as its characters.
     * `undefined` on 404 (gone) or 403 (no access), so the caller answers
     * without the metadata instead of failing; anything else still throws.
     */
    async fetchMessageMeta(_guildId, ref) {
      let message: APIMessage;
      try {
        message = (await mapErrors(() =>
          rest.get(Routes.channelMessage(ref.channelId, ref.messageId)),
        )) as APIMessage;
      } catch (err) {
        if (err instanceof DiscordApiError && (err.status === 404 || err.status === 403)) {
          return undefined;
        }
        throw err;
      }
      return {
        pinned: message.pinned,
        reactions: (message.reactions ?? []).map((reaction) => ({
          emoji:
            reaction.emoji.id != null
              ? `<:${reaction.emoji.name ?? 'unknown'}:${reaction.emoji.id}>`
              : (reaction.emoji.name ?? ''),
          count: reaction.count,
        })),
      };
    },

    async createReaction(_guildId, ref, emoji) {
      await mapErrors(() =>
        rest.put(Routes.channelMessageOwnReaction(ref.channelId, ref.messageId, restEmoji(emoji))),
      );
    },

    async fetchReactionUsers(_guildId, ref, emoji, options = {}) {
      const limit = Math.min(options.limit ?? MAX_REACTION_PAGE, MAX_REACTION_PAGE);
      const users = (await mapErrors(() =>
        rest.get(Routes.channelMessageReaction(ref.channelId, ref.messageId, restEmoji(emoji)), {
          query: makeURLSearchParams({ limit, after: options.after }),
        }),
      )) as APIUser[];

      const userIds = users.map((user) => user.id);
      /**
       * Discord cannot say "that was the last page" — it returns users and
       * nothing else. So a full page always yields a cursor, even when it
       * happens to have exhausted the reactors, and the caller learns the truth
       * by getting an empty page next. `pageReactors` already loops that way.
       */
      const page: ReactionUserPage = {
        userIds,
        nextAfter: userIds.length === limit ? userIds[userIds.length - 1] : undefined,
      };
      return page;
    },

    async sendMessage(_guildId, channelId, message) {
      const posted = (await mapErrors(() =>
        rest.post(Routes.channelMessages(channelId), { body: toRestMessage(message) }),
      )) as APIMessage;
      return { channelId, messageId: posted.id };
    },

    async editMessage(_guildId, ref, message) {
      await mapErrors(() =>
        rest.patch(Routes.channelMessage(ref.channelId, ref.messageId), {
          body: toRestMessage(message),
        }),
      );
    },

    async fetchMessageContent(_guildId, channelId, messageId) {
      try {
        const message = (await mapErrors(() =>
          rest.get(Routes.channelMessage(channelId, messageId)),
        )) as APIMessageWithMember;
        return {
          authorId: message.author.id,
          authorName: message.member?.nick ?? message.author.global_name ?? message.author.username,
          content: message.content,
        };
      } catch (err) {
        // Gone or no access is routine here — a member quoting an old or
        // now-hidden message — and is reported as "no quote available"
        // rather than failing the whole turn.
        if (err instanceof DiscordApiError && (err.status === 404 || err.status === 403)) {
          return undefined;
        }
        throw err;
      }
    },

    async fetchChannelMessages(
      _guildId,
      channelId,
      opts,
    ): Promise<readonly RecentMessage[] | undefined> {
      // Discord caps a channel page at 100; the assistant's window setting
      // caps lower still. Clamped, never defaulted: the caller names N.
      const limit = Math.min(Math.max(opts.limit, 1), 50);
      try {
        const messages = (await mapErrors(() =>
          rest.get(Routes.channelMessages(channelId), {
            query: new URLSearchParams({ before: opts.before, limit: String(limit) }),
          }),
        )) as APIMessageWithMember[];
        // Discord returns newest first; channel context reads oldest first.
        return messages
          .map((message) => {
            const referenced = message.referenced_message as
              APIMessageWithMember | null | undefined;
            const referencedAuthor = referenced?.author;
            return {
              messageId: message.id,
              authorId: message.author.id,
              authorName:
                message.member?.nick ?? message.author.global_name ?? message.author.username,
              authorIsBot: message.author.bot ?? false,
              content: message.content,
              at: Date.parse(message.timestamp),
              ...(referencedAuthor === undefined
                ? {}
                : {
                    referencedAuthorName:
                      (referenced as APIMessageWithMember).member?.nick ??
                      referencedAuthor.global_name ??
                      referencedAuthor.username,
                  }),
              hasAttachments: (message.attachments?.length ?? 0) > 0,
            } satisfies RecentMessage;
          })
          .reverse();
      } catch (err) {
        // Gone or no access is routine here — a mention in a channel whose
        // history the bot cannot read — and is reported as "no context"
        // rather than failing the whole turn.
        if (err instanceof DiscordApiError && (err.status === 404 || err.status === 403)) {
          return undefined;
        }
        throw err;
      }
    },

    async sendTyping(_guildId, channelId) {
      await mapErrors(() => rest.post(Routes.channelTyping(channelId)));
    },

    async deleteMessage(_guildId, ref, reason) {
      await mapErrors(() =>
        rest.delete(Routes.channelMessage(ref.channelId, ref.messageId), { reason }),
      );
    },

    // --- moderation --------------------------------------------------------
    async timeoutMember(guildId, userId, durationMs, reason) {
      await mapErrors(() =>
        rest.patch(Routes.guildMember(guildId, userId), {
          body: { communication_disabled_until: new Date(Date.now() + durationMs).toISOString() },
          reason,
        }),
      );
    },

    async untimeoutMember(guildId, userId, reason) {
      // Discord removes a timeout by setting the field to null; there is no
      // dedicated "remove timeout" route or verb.
      await mapErrors(() =>
        rest.patch(Routes.guildMember(guildId, userId), {
          body: { communication_disabled_until: null },
          reason,
        }),
      );
    },

    async kickMember(guildId, userId, reason) {
      await mapErrors(() => rest.delete(Routes.guildMember(guildId, userId), { reason }));
    },

    async banMember(guildId, userId, reason) {
      // No body: message deletion is purge's explicit job (ADR 0037), and
      // `delete_message_days`/`delete_message_seconds` are deprecated.
      await mapErrors(() => rest.put(Routes.guildBan(guildId, userId), { reason }));
    },

    async unbanMember(guildId, userId, reason) {
      await mapErrors(() => rest.delete(Routes.guildBan(guildId, userId), { reason }));
    },

    async bulkDeleteMessages(_guildId, channelId, messageIds, reason) {
      await mapErrors(() =>
        rest.post(Routes.channelBulkDelete(channelId), {
          body: { messages: messageIds },
          reason,
        }),
      );
    },

    async fetchRecentMessages(_guildId, channelId, options) {
      const limit = Math.min(options.limit ?? 50, 100);
      const messages = (await mapErrors(() =>
        rest.get(Routes.channelMessages(channelId), {
          query: makeURLSearchParams({ limit, before: options.before }),
        }),
      )) as APIMessage[];

      const page = messages.map((message) => ({
        messageId: message.id,
        authorId: message.author?.id ?? undefined,
        createdAtMs: snowflakeToMs(message.id),
        content: message.content === '' ? undefined : message.content,
        editedTimestampMs: message.edited_timestamp
          ? Date.parse(message.edited_timestamp)
          : undefined,
        attachments: (message.attachments ?? []).map((a) => ({
          attachmentId: a.id,
          fileName: a.filename,
          contentType: a.content_type ?? undefined,
          sizeBytes: a.size,
        })),
      }));

      const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
      return {
        messages: page,
        // Same convention as fetchReactionUsers: a full page yields a cursor
        // even when it happens to have exhausted the channel; the caller
        // learns the truth by getting a short page next.
        nextBefore: messages.length === limit && last !== undefined ? last.id : undefined,
      };
    },

    async listPublicThreads(guildId, channelId) {
      const active = (await mapErrors(() =>
        rest.get(Routes.guildActiveThreads(guildId)),
      )) as APIThreadList;
      const found = new Map<
        string,
        { id: string; name: string; isPrivate: boolean; archived: boolean }
      >();
      for (const thread of active.threads) {
        if (
          'parent_id' in thread &&
          thread.parent_id === channelId &&
          thread.type !== ChannelType.PrivateThread
        ) {
          found.set(thread.id, {
            id: thread.id,
            name: thread.name,
            isPrivate: false,
            archived: false,
          });
        }
      }
      // Review S3: the archived endpoint paginates by
      // `thread_metadata.archive_timestamp` (ISO8601), not by thread
      // snowflake — discord.js does the same in ThreadManager.js. A
      // snowflake `before` silently re-fetches or skips pages. The walk is
      // bounded: a channel with more archived threads than the cap is a
      // visible refusal, not an unbounded loop.
      const MAX_ARCHIVED_THREAD_PAGES = 50;
      let before: string | undefined;
      for (let page = 0; ; page += 1) {
        if (page >= MAX_ARCHIVED_THREAD_PAGES) {
          throw new Error(
            `archive: archived-thread listing for channel ${channelId} hit the ` +
              `${String(MAX_ARCHIVED_THREAD_PAGES)}-page cap; refusing to page without bound`,
          );
        }
        const archived = (await mapErrors(() =>
          rest.get(Routes.channelThreads(channelId, 'public'), {
            query: makeURLSearchParams({ limit: 100, before }),
          }),
        )) as APIThreadList & { has_more?: boolean };
        for (const thread of archived.threads)
          found.set(thread.id, {
            id: thread.id,
            // A thread always has a title in practice; the API type allows
            // null, so name it rather than letting `null` reach the caller.
            name: thread.name ?? '(unnamed thread)',
            isPrivate: false,
            archived: true,
          });
        const last = archived.threads.at(-1);
        if (!archived.has_more || last === undefined) break;
        const metadata = 'thread_metadata' in last ? last.thread_metadata : undefined;
        if (metadata?.archive_timestamp === undefined) break;
        before = metadata.archive_timestamp;
      }
      return [...found.values()];
    },

    /**
     * Thread membership for ADR 0112's private-thread reads: 200 answers
     * true, 404 answers false; anything else still throws. `_guildId` is
     * the mandatory scope key with nothing to address — the thread-member
     * route carries no guild id, like the other channel routes above.
     */
    async isThreadMember(_guildId, threadId, userId) {
      try {
        await mapErrors(() => rest.get(Routes.threadMembers(threadId, userId)));
        return true;
      } catch (err) {
        if (err instanceof DiscordApiError && err.status === 404) return false;
        throw err;
      }
    },

    /**
     * Thread facts over REST for threads the gateway cache has swept
     * (ADR 0112): `GET /channels/{thread}`. `undefined` on 404 (gone) or 403
     * (no access), on a channel outside this guild, on a non-thread, or on a
     * thread with no parent — all routine here, reported the same way rather
     * than thrown, so the caller answers "no thread" instead of failing.
     * Anything else still throws.
     */
    async fetchThreadInfo(guildId, threadId) {
      let channel: APIChannel;
      try {
        channel = (await mapErrors(() => rest.get(Routes.channel(threadId)))) as APIChannel;
      } catch (err) {
        if (err instanceof DiscordApiError && (err.status === 404 || err.status === 403)) {
          return undefined;
        }
        throw err;
      }
      if (
        channel.type !== ChannelType.PublicThread &&
        channel.type !== ChannelType.PrivateThread &&
        channel.type !== ChannelType.AnnouncementThread
      ) {
        return undefined;
      }
      if (channel.guild_id !== guildId || channel.parent_id == null) return undefined;
      return {
        id: channel.id,
        // A thread always has a title in practice; the API type allows
        // null, so name it rather than letting `null` reach the caller.
        name: channel.name ?? '(unnamed thread)',
        parentId: channel.parent_id,
        isPrivate: channel.type === ChannelType.PrivateThread,
      };
    },

    /**
     * Guild scheduled events for the assistant (ADR 0092 decision 1): no
     * gateway intent is needed for the REST read. A 403 (the bot may not
     * see them) answers `[]` rather than failing the turn; anything else
     * still throws.
     */
    async listScheduledEvents(guildId) {
      try {
        const events = (await mapErrors(() =>
          rest.get(Routes.guildScheduledEvents(guildId)),
        )) as APIGuildScheduledEvent[];
        return events.map((event) => ({
          id: event.id,
          name: event.name,
          ...(event.description == null ? {} : { description: event.description }),
          scheduledStartAt: Date.parse(event.scheduled_start_time),
          ...(event.channel_id == null ? {} : { channelId: event.channel_id }),
          ...(event.entity_metadata?.location == null
            ? {}
            : { location: event.entity_metadata.location }),
        }));
      } catch (err) {
        if (err instanceof DiscordApiError && err.status === 403) return [];
        throw err;
      }
    },

    // --- interactions ----------------------------------------------------
    async deferInteraction(_guildId, ref, options) {
      await mapErrors(() =>
        rest.post(Routes.interactionCallback(ref.interactionId, ref.token), {
          body: {
            type: InteractionResponseType.DeferredChannelMessageWithSource,
            ...(options.ephemeral ? { data: { flags: MessageFlags.Ephemeral } } : {}),
          },
          // The token is the credential here; sending our bot token as well
          // would be a second credential on the wire for no reason.
          auth: false,
        }),
      );
      rememberDefer(ref.interactionId, options.ephemeral);
    },

    async respondToInteraction(_guildId, ref, message) {
      const ephemeral = deferred.get(ref.interactionId)?.ephemeral ?? false;
      // The interaction follow-up route behaves as though `?wait=true` were
      // always set — Discord returns the created message, unlike a plain
      // webhook execute — so the ref comes straight from the response rather
      // than a second request.
      const posted = (await mapErrors(() =>
        rest.post(Routes.webhook(applicationId, ref.token), {
          body: {
            ...toRestMessage(message),
            ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
          },
          auth: false,
        }),
      )) as Partial<APIMessage> | undefined;
      deferred.delete(ref.interactionId);
      // A 204 (no `wait`, or nothing to report) comes back as `undefined` or
      // `{}` depending on the transport — either way there is no id to
      // report, and fabricating one would be worse than reporting none.
      return posted?.id === undefined || posted.channel_id === undefined
        ? undefined
        : { channelId: posted.channel_id, messageId: posted.id };
    },

    // --- audit log -------------------------------------------------------
    async fetchAuditLog(guildId, options) {
      const log = (await mapErrors(() =>
        rest.get(Routes.guildAuditLog(guildId), {
          query: makeURLSearchParams({
            action_type: AUDIT_ACTION_TYPES[options.actionType],
            limit: options.limit,
          }),
        }),
      )) as APIAuditLog;

      return log.audit_log_entries.map((entry) => toAuditLogEntry(entry, options.actionType));
    },

    // --- guild lifecycle -------------------------------------------------
    async leaveGuild(guildId) {
      await mapErrors(() => rest.delete(Routes.userGuild(guildId)));
    },
  };
}

// ── translation ───────────────────────────────────────────────────────────

function toDiscordRole(role: APIRole): DiscordRole {
  return {
    id: role.id,
    name: role.name,
    position: role.position,
    // Integration-managed roles cannot be assigned at any position, which is a
    // separate refusal from hierarchy and must not be confused with it.
    managed: role.managed,
  };
}

function toAuditLogEntry(
  entry: APIAuditLogEntry,
  actionType: AuditLogEntry['actionType'],
): AuditLogEntry {
  // `options` is present only for the action types that have it. Reported as
  // undefined rather than defaulted: ADR 0019 turns on a count *changing*, and
  // an invented zero would read as "nothing has been deleted yet".
  const options = entry.options as { count?: string; channel_id?: string } | undefined;
  const count = options?.count === undefined ? undefined : Number(options.count);

  return {
    // Absent when Discord recorded no actor — a self-deletion produces no entry
    // at all, and some entries carry none. Never guessed.
    actorUserId: entry.user_id ?? undefined,
    // For message_delete this is the message AUTHOR. There is no message id in
    // the entry at all, which is why ADR 0019 exists.
    targetId: entry.target_id ?? undefined,
    actionType,
    createdAtMs: snowflakeToMs(entry.id),
    reason: entry.reason ?? undefined,
    count: Number.isFinite(count) ? count : undefined,
    channelId: options?.channel_id,
  };
}

/**
 * An audit entry carries no timestamp of its own; the id is the timestamp.
 * Correlating a delete event with an entry depends on this, so it is derived
 * rather than approximated with the time of the fetch.
 */
function snowflakeToMs(id: string): number {
  return Number((BigInt(id) >> 22n) + BigInt(DISCORD_EPOCH_MS));
}

/**
 * `EmojiKey` -> what Discord's reaction routes expect.
 *
 * Unicode is the raw characters, url-encoded — restored through
 * `unicodeEmojiChars`, which reinstates U+FE0F for the codepoints whose
 * canonical, reaction-matching form requires it (`docs/reports/WP5-slice-6-live-test.md`
 * finding 1; a bare codepoint silently matched nothing for 🅰️/🅱️). Custom is
 * documented as `name:id` — and `EmojiKey` deliberately carries only the id,
 * because the name is not part of an emoji's identity and changes without the
 * reaction changing. `_` is the placeholder name; Discord is understood to key
 * off the id alone, but that cannot be verified without a connection and is on
 * the smoke-test list.
 */
function restEmoji(key: EmojiKey): string {
  if (key.startsWith('c:')) return `_:${key.slice(2)}`;
  return encodeURIComponent(unicodeEmojiChars(key));
}

/** `OutgoingMessage` is already the Discord shape, minus what we never send. */
function toRestMessage(message: OutgoingMessage): Record<string, unknown> {
  const allowedMentions =
    message.allowedMentions === undefined
      ? undefined
      : {
          parse: [...message.allowedMentions.parse],
          ...(message.allowedMentions.roles === undefined
            ? {}
            : { roles: [...message.allowedMentions.roles] }),
          ...(message.allowedMentions.users === undefined
            ? {}
            : { users: [...message.allowedMentions.users] }),
        };

  return {
    ...(message.content === undefined ? {} : { content: message.content }),
    ...(message.embeds === undefined ? {} : { embeds: message.embeds }),
    ...(message.components === undefined ? {} : { components: message.components }),
    // camelCase on the port, snake_case on the wire: a spread of
    // `allowedMentions` would still be broken. Opt-in only — the MCP send path
    // is the sole caller that sets it, and a default here would change what
    // panel posts and log messages send. `replyTo` (ADR 0072) forces
    // `replied_user: true` in on top of whatever `allowedMentions` already
    // says, without disturbing `parse`, so replying still pings the member
    // being replied to even when nothing else set `allowedMentions` at all.
    ...(allowedMentions === undefined && message.replyTo === undefined
      ? {}
      : {
          allowed_mentions: {
            parse: allowedMentions?.parse ?? [],
            ...(allowedMentions?.roles === undefined ? {} : { roles: allowedMentions.roles }),
            ...(allowedMentions?.users === undefined ? {} : { users: allowedMentions.users }),
            ...(message.replyTo === undefined ? {} : { replied_user: true }),
          },
        }),
    ...(message.replyTo === undefined
      ? {}
      : { message_reference: { message_id: message.replyTo, fail_if_not_exists: false } }),
  };
}

export type { DiscordMessageRef, InteractionRef };
