import type { MemberEvent, MessageEvent, RoleEvent } from '../discord/events.js';
import { escapeInline } from '../ui/discord/text.js';
import type { LogCardView } from './cards.js';

/**
 * Pure view builders for the logging module (ADR 0023).
 *
 * Each formatter returns a `LogCardView` — already-safe Markdown plus raw
 * untrusted text — and `renderLogCard` turns it into a card. Member- or
 * moderator-controlled names go through `escapeInline` here; message content
 * travels raw in `quote.text` and is escaped at render time.
 */

const authorMention = (authorId: string | undefined): string =>
  authorId === undefined ? 'an unknown member' : `<@${authorId}>`;

/** A new message on a watched route, labelled "Message". */
export function formatMessageCreate(
  event: MessageEvent,
  includeContent: boolean,
  at: number,
): LogCardView {
  return {
    kind: 'message_create',
    headline: `${authorMention(event.authorId)} sent a message in <#${event.channelId}>`,
    ...(includeContent && event.content !== undefined
      ? { quote: { label: 'Message', text: event.content } }
      : {}),
    at,
    ...(event.authorId === undefined ? {} : { memberId: event.authorId }),
    message: { channelId: event.channelId, messageId: event.messageId, exists: true },
  };
}

export function formatMessageEdit(
  event: MessageEvent,
  includeContent: boolean,
  at: number,
): LogCardView {
  if (!includeContent) {
    return {
      kind: 'message_edit',
      headline: `${authorMention(event.authorId)} edited a message in <#${event.channelId}>`,
      details: ['-# Content is not logged on this route.'],
      at,
      ...(event.authorId === undefined ? {} : { memberId: event.authorId }),
      message: { channelId: event.channelId, messageId: event.messageId, exists: true },
    };
  }
  if (event.content === undefined) {
    return {
      kind: 'message_edit',
      headline: `${authorMention(event.authorId)} edited a message in <#${event.channelId}>`,
      details: ['-# The new content was not available.'],
      at,
      ...(event.authorId === undefined ? {} : { memberId: event.authorId }),
      message: { channelId: event.channelId, messageId: event.messageId, exists: true },
    };
  }
  return {
    kind: 'message_edit',
    headline: `${authorMention(event.authorId)} edited a message in <#${event.channelId}>`,
    quote: { label: 'Now reads', text: event.content },
    at,
    ...(event.authorId === undefined ? {} : { memberId: event.authorId }),
    message: { channelId: event.channelId, messageId: event.messageId, exists: true },
  };
}

/**
 * The one view that has to render "(inferred)" and never plain attribution
 * (`docs/20`'s gate). `actorUserId` is `undefined` when correlation found no
 * safe answer — a self-deletion, the audit log not caught up yet, or an
 * ambiguity between two candidates (ADR 0023 decision 3) — and renders as
 * "unknown", never a guess.
 *
 * `content` is whatever the enqueueing subscriber decided to carry — already
 * `undefined` both when the message was uncached and when the route's
 * `include_content` was off, which is why there is no "not available" detail
 * here the way `formatMessageEdit` has one: this function cannot tell those
 * two cases apart, and guessing which one it is would be its own small
 * dishonesty.
 *
 * The message is gone by definition, so `message.exists` is false and the
 * card offers Warn and Timeout but no Delete.
 */
export function formatMessageDelete(
  payload: {
    channelId: string;
    messageId: string;
    authorId?: string | undefined;
    content?: string | undefined;
  },
  actorUserId: string | undefined,
  at: number,
): LogCardView {
  return {
    kind: 'message_delete',
    headline: `Message by ${authorMention(payload.authorId)} deleted in <#${payload.channelId}>`,
    details: [actorUserId === undefined ? 'Deleted by: unknown' : `Deleted by <@${actorUserId}> (inferred)`],
    ...(payload.content === undefined ? {} : { quote: { label: 'It read', text: payload.content } }),
    at,
    ...(payload.authorId === undefined ? {} : { memberId: payload.authorId }),
    message: { channelId: payload.channelId, messageId: payload.messageId, exists: false },
  };
}

export function formatMemberJoin(event: MemberEvent, at: number): LogCardView {
  return {
    kind: 'member_join',
    headline: `<@${event.userId}> joined`,
    at,
  };
}

/**
 * Never says why. Distinguishing a voluntary leave from a kick or a ban
 * needs the same audit-log correlation ADR 0019 built for message deletion,
 * and ADR 0023 puts that out of scope: `REVIEW.md` Release 2 owns "kick,
 * ban/unban... mod log".
 */
export function formatMemberLeave(event: MemberEvent, at: number): LogCardView {
  return {
    kind: 'member_leave',
    headline: `<@${event.userId}> left`,
    at,
  };
}

/**
 * One member-change view for the logging module's last-seen record (ADR 0123
 * decision 9). `added`/`removed` are role ids; an empty side is omitted, so a
 * pure grant names no removal and vice versa.
 */
export function formatMemberRolesChanged(
  userId: string,
  added: readonly string[],
  removed: readonly string[],
  at: number,
): LogCardView {
  const details: string[] = [];
  if (added.length > 0) details.push(`Added ${added.map((id) => `<@&${id}>`).join(' ')}`);
  if (removed.length > 0) details.push(`Removed ${removed.map((id) => `<@&${id}>`).join(' ')}`);
  return {
    kind: 'member_roles_changed',
    headline: `<@${userId}>'s roles changed`,
    details,
    at,
  };
}

const displayNameOrNone = (name: string | undefined): string =>
  name === undefined ? '(none)' : escapeInline(name);

/** Nickname old → new, with `(none)` for an absent nickname on either side. */
export function formatMemberNicknameChanged(
  userId: string,
  oldNickname: string | undefined,
  newNickname: string | undefined,
  at: number,
): LogCardView {
  return {
    kind: 'member_nickname_changed',
    headline: `<@${userId}> changed nickname`,
    details: [`${displayNameOrNone(oldNickname)} → ${displayNameOrNone(newNickname)}`],
    at,
  };
}

/**
 * Username and/or display-name old → new. Both lines when both changed, so one
 * `member_username_changed` change can carry the two together.
 */
export function formatMemberUsernameChanged(
  input: {
    userId: string;
    oldUsername: string | undefined;
    newUsername: string;
    oldGlobalName: string | undefined;
    newGlobalName: string | undefined;
  },
  at: number,
): LogCardView {
  const details: string[] = [];
  if (input.oldUsername !== undefined && input.oldUsername !== input.newUsername) {
    details.push(
      `Username: ${escapeInline(input.oldUsername)} → ${escapeInline(input.newUsername)}`,
    );
  }
  if ((input.oldGlobalName ?? undefined) !== (input.newGlobalName ?? undefined)) {
    details.push(
      `Display name: ${displayNameOrNone(input.oldGlobalName)} → ${displayNameOrNone(input.newGlobalName)}`,
    );
  }
  return {
    kind: 'member_username_changed',
    headline: `<@${input.userId}>'s name changed`,
    details,
    at,
  };
}

const accountAvatarUrl = (userId: string, hash: string): string =>
  `https://cdn.discordapp.com/avatars/${userId}/${hash}.png`;

const guildAvatarUrl = (guildId: string, userId: string, hash: string): string =>
  `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/avatars/${hash}.png`;

/**
 * Account and/or server avatar old → new. A link is text in a Discord message
 * — the bot never fetches it — and a removed avatar names that instead of a
 * URL. Both lines when both changed, so one `member_avatar_changed` change
 * can carry the two together.
 */
export function formatMemberAvatarChanged(
  input: {
    userId: string;
    guildId: string;
    accountChanged: boolean;
    newAvatarHash: string | undefined;
    guildAvatarChanged: boolean;
    newGuildAvatarHash: string | undefined;
  },
  at: number,
): LogCardView {
  const details: string[] = [];
  if (input.accountChanged) {
    details.push(
      input.newAvatarHash === undefined
        ? 'Avatar: removed'
        : `Avatar: ${accountAvatarUrl(input.userId, input.newAvatarHash)}`,
    );
  }
  if (input.guildAvatarChanged) {
    details.push(
      input.newGuildAvatarHash === undefined
        ? 'Server avatar: removed'
        : `Server avatar: ${guildAvatarUrl(input.guildId, input.userId, input.newGuildAvatarHash)}`,
    );
  }
  return {
    kind: 'member_avatar_changed',
    headline: `<@${input.userId}>'s avatar changed`,
    details,
    at,
  };
}

export function formatRoleCreate(event: RoleEvent, at: number): LogCardView {
  return {
    kind: 'role_create',
    headline: `Role **${escapeInline(event.name)}** created`,
    details: [`-# ${event.roleId}`],
    at,
  };
}

export function formatRoleUpdate(event: RoleEvent, at: number): LogCardView {
  return {
    kind: 'role_update',
    headline: `Role **${escapeInline(event.name)}** changed`,
    details: [`-# ${event.roleId}`],
    at,
  };
}

export function formatRoleDelete(event: RoleEvent, at: number): LogCardView {
  return {
    kind: 'role_delete',
    headline: `Role **${escapeInline(event.name)}** deleted`,
    details: [`-# ${event.roleId}`],
    at,
  };
}

/**
 * The logging side of `/mod warn` (ADR 0123): the warning is the bot's own
 * action, so there is no gateway event to format — the daemon posts this
 * through `createLogPoster` with the warn's interaction id as fingerprint.
 * The reason is moderator-written and untrusted, so it is capped at 300
 * characters like an audit-log reason, and escaped at render time.
 */
export function formatWarn(
  input: {
    memberId: string;
    actorId: string;
    reason: string;
    caseId: string;
    violationCount: number;
  },
  at: number,
): LogCardView {
  return {
    kind: 'member_warn',
    headline: `<@${input.memberId}> was warned by <@${input.actorId}>`,
    details: [`Case ${input.caseId.slice(0, 8)} · warning ${input.violationCount}`],
    quote: { label: 'Reason', text: input.reason.slice(0, 300) },
    at,
    memberId: input.memberId,
  };
}

/**
 * `docs/19` §6.7's restated gate: a gap must be a visible marker, never a
 * silent hole. `<t:unix:t>` is Discord's own timestamp markup — it renders in
 * each reader's local time, so the channel never has to guess whose
 * timezone to print in. Every WP4 event kind is a gateway dispatch with no
 * "what happened while I was away" API (ADR 0023 decision 5), so the marker
 * names all three, not only messages.
 */
export function formatGapMarker(
  disconnectedAtMs: number,
  reconnectedAtMs: number,
  at: number,
): LogCardView {
  const from = Math.floor(disconnectedAtMs / 1000);
  const to = Math.floor(reconnectedAtMs / 1000);
  return {
    kind: 'gap',
    headline: `Bananasaurs was disconnected from <t:${from}:t> to <t:${to}:t>.`,
    details: ['Message, member and role events in that window were not captured.'],
    at,
  };
}
