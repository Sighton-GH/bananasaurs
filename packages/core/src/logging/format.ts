import type { MemberEvent, MessageEvent, RoleEvent } from '../discord/events.js';

/**
 * Pure text formatting for the logging module (ADR 0022).
 *
 * Plain content strings, not embeds: `OutgoingMessage.embeds` is opaque
 * (`unknown[]`) and nothing else in Release 1 constructs one, so a plain
 * string is the boring choice and the one this module's own tests can assert
 * on directly.
 *
 * Message-delete formatting is not here — it needs the inferred actor, which
 * only exists after the audit-log correlation job runs (slice 12c).
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
