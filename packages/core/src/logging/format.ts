import type { MemberEvent, MessageEvent, RoleEvent } from '../discord/events.js';

/**
 * Pure text formatting for the logging module (ADR 0022).
 *
 * Plain content strings, not embeds: `OutgoingMessage.embeds` is opaque
 * (`unknown[]`) and nothing else in Release 1 constructs one, so a plain
 * string is the boring choice and the one this module's own tests can assert
 * on directly.
 */

const authorMention = (authorId: string | undefined): string =>
  authorId === undefined ? 'an unknown member' : `<@${authorId}>`;

export function formatMessageEdit(event: MessageEvent, includeContent: boolean): string {
  const lines = [`Message edited in <#${event.channelId}> by ${authorMention(event.authorId)}`];
  if (includeContent) {
    lines.push(
      event.content === undefined ? 'Content: not available' : `Content: ${event.content}`,
    );
  }
  return lines.join('\n');
}

/**
 * The one line that has to render "(inferred)" and never plain attribution
 * (`docs/20`'s gate). `actorUserId` is `undefined` when correlation found no
 * safe answer — a self-deletion, the audit log not caught up yet, or an
 * ambiguity between two candidates (ADR 0022 decision 3) — and renders as
 * "unknown", never a guess.
 *
 * `content` is whatever the enqueueing subscriber decided to carry — already
 * `undefined` both when the message was uncached and when the route's
 * `include_content` was off, which is why there is no "not available" line
 * here the way `formatMessageEdit` has one: this function cannot tell those
 * two cases apart, and guessing which one it is would be its own small
 * dishonesty.
 */
export function formatMessageDelete(
  payload: { channelId: string; authorId?: string | undefined; content?: string | undefined },
  actorUserId: string | undefined,
): string {
  const actorPart = actorUserId === undefined ? 'unknown' : `<@${actorUserId}> (inferred)`;
  const lines = [
    `Message deleted in <#${payload.channelId}>, author ${authorMention(payload.authorId)}, deleted by ${actorPart}`,
  ];
  if (payload.content !== undefined) {
    lines.push(`Content: ${payload.content}`);
  }
  return lines.join('\n');
}

export function formatMemberJoin(event: MemberEvent): string {
  return `Member joined: <@${event.userId}>`;
}

/**
 * Never says why. Distinguishing a voluntary leave from a kick or a ban
 * needs the same audit-log correlation ADR 0019 built for message deletion,
 * and ADR 0022 puts that out of scope: `REVIEW.md` Release 2 owns "kick,
 * ban/unban... mod log".
 */
export function formatMemberLeave(event: MemberEvent): string {
  return `Member left: <@${event.userId}>`;
}

export function formatRoleCreate(event: RoleEvent): string {
  return `Role created: **${event.name}** (${event.roleId})`;
}

export function formatRoleUpdate(event: RoleEvent): string {
  return `Role updated: **${event.name}** (${event.roleId})`;
}

export function formatRoleDelete(event: RoleEvent): string {
  return `Role deleted: **${event.name}** (${event.roleId})`;
}

/**
 * `docs/19` §6.7's restated gate: a gap must be a visible marker, never a
 * silent hole. `<t:unix:t>` is Discord's own timestamp markup — it renders in
 * each reader's local time, so the channel never has to guess whose
 * timezone to print in. Every WP4 event kind is a gateway dispatch with no
 * "what happened while I was away" API (ADR 0022 decision 5), so the marker
 * names all three, not only messages.
 */
export function formatGapMarker(disconnectedAtMs: number, reconnectedAtMs: number): string {
  const from = Math.floor(disconnectedAtMs / 1000);
  const to = Math.floor(reconnectedAtMs / 1000);
  return `⚠️ Bananasaurs was disconnected from <t:${from}:t> to <t:${to}:t>. Message, member, and role events in that window were not captured.`;
}
