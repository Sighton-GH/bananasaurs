import type { AuditChangeValue, AuditLogEntryEvent } from '../discord/events.js';
import { escapeInline } from '../ui/discord/text.js';
import type { LogCardView } from './cards.js';

// Numeric AuditLogEvent values, see node_modules/discord-api-types/payloads/v10/auditLog.d.ts
export const AUDIT_ACTION_GUILD_UPDATE = 1;
export const AUDIT_ACTION_CHANNEL_CREATE = 10;
export const AUDIT_ACTION_CHANNEL_UPDATE = 11;
export const AUDIT_ACTION_CHANNEL_DELETE = 12;
export const AUDIT_ACTION_MEMBER_KICK = 20;
export const AUDIT_ACTION_MEMBER_BAN_ADD = 22;
export const AUDIT_ACTION_MEMBER_BAN_REMOVE = 23;
export const AUDIT_ACTION_MEMBER_UPDATE = 24;
export const AUDIT_ACTION_INVITE_CREATE = 40;
export const AUDIT_ACTION_INVITE_DELETE = 42;
export const AUDIT_ACTION_EMOJI_CREATE = 60;
export const AUDIT_ACTION_EMOJI_UPDATE = 61;
export const AUDIT_ACTION_EMOJI_DELETE = 62;
export const AUDIT_ACTION_STICKER_CREATE = 90;
export const AUDIT_ACTION_STICKER_UPDATE = 91;
export const AUDIT_ACTION_STICKER_DELETE = 92;
export const AUDIT_ACTION_THREAD_CREATE = 110;
export const AUDIT_ACTION_THREAD_DELETE = 112;

export const AUDIT_EVENT_KINDS: readonly string[] = [
  'member_kick',
  'member_ban',
  'member_unban',
  'member_timeout',
  'member_timeout_removed',
  'channel_create',
  'channel_update',
  'channel_delete',
  'thread_create',
  'thread_delete',
  'guild_update',
  'invite_create',
  'invite_delete',
  'emoji_create',
  'emoji_update',
  'emoji_delete',
  'sticker_create',
  'sticker_update',
  'sticker_delete',
];

export interface AuditItem {
  eventKind: string;
  view(at: number): LogCardView;
}

const MAX_VALUE_CHARS = 100;
const MAX_REASON_CHARS = 300;
const MAX_CHANGE_LINES = 10;

export function formatAuditValue(value: AuditChangeValue | undefined): string {
  let raw: string;
  if (value === null || value === undefined) {
    raw = '(none)';
  } else if (typeof value === 'string') {
    raw = JSON.stringify(value);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    raw = String(value);
  } else {
    raw = JSON.stringify(value) ?? '(none)';
  }
  if (raw.length > MAX_VALUE_CHARS) {
    return `${raw.slice(0, MAX_VALUE_CHARS - 1)}…`;
  }
  return raw;
}

function actorSuffix(event: AuditLogEntryEvent): string {
  return event.actorId === undefined ? ' by an unknown member' : ` by <@${event.actorId}>`;
}

function memberTarget(event: AuditLogEntryEvent): string {
  return event.targetId === undefined ? 'an unknown member' : `<@${event.targetId}>`;
}

function channelTarget(event: AuditLogEntryEvent): string {
  const id = event.targetId ?? event.channelId;
  return id === undefined ? '(unknown channel)' : `<#${id}>`;
}

function findChange(event: AuditLogEntryEvent, key: string) {
  return event.changes.find((c) => c.key === key);
}

function changeString(value: AuditChangeValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function changeNumber(value: AuditChangeValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function changeLinesFor(changes: AuditLogEntryEvent['changes']): string[] {
  const visible = changes.filter((c) => c.key !== 'permission_overwrites');
  const shown = visible.slice(0, MAX_CHANGE_LINES);
  const lines = shown.map(
    (c) => `  ${c.key}: ${formatAuditValue(c.old)} → ${formatAuditValue(c.new)}`,
  );
  if (visible.length > MAX_CHANGE_LINES) {
    lines.push(`  …and ${visible.length - MAX_CHANGE_LINES} more`);
  }
  return lines;
}

function truncateReason(reason: string): string {
  if (reason.length > MAX_REASON_CHARS) {
    return `${reason.slice(0, MAX_REASON_CHARS - 1)}…`;
  }
  return reason;
}

/**
 * Raw channel/thread/emoji/sticker names and invite codes are interpolated
 * into the line without quoting, so they bypass `formatAuditValue` — cap
 * them at the same 100 characters. Values from Discord are untrusted.
 */
function truncateInline(value: string): string {
  if (value.length > MAX_VALUE_CHARS) {
    return `${value.slice(0, MAX_VALUE_CHARS - 1)}…`;
  }
  return value;
}

/**
 * A member-controlled name or code bound for a headline: capped raw first,
 * then escaped, so escaping never pushes the text back over the cap and a
 * hostile name renders literally.
 */
function safeName(value: string): string {
  return escapeInline(truncateInline(value));
}

function makeItem(
  event: AuditLogEntryEvent,
  eventKind: string,
  firstLineBase: string,
  extraLines: readonly string[],
): AuditItem {
  return {
    eventKind,
    view(at: number): LogCardView {
      return {
        kind: eventKind,
        headline: `${firstLineBase}${actorSuffix(event)}`,
        ...(extraLines.length === 0 ? {} : { changes: extraLines.map((l) => l.trim()) }),
        ...(event.reason !== undefined && event.reason !== ''
          ? { quote: { label: 'Reason', text: truncateReason(event.reason) } }
          : {}),
        at,
        ...(eventKind.startsWith('member_') && event.targetId !== undefined
          ? { memberId: event.targetId }
          : {}),
      };
    },
  };
}

function memberTimeoutItems(event: AuditLogEntryEvent): AuditItem[] {
  const change = findChange(event, 'communication_disabled_until');
  if (change === undefined) {
    return [];
  }
  const target = memberTarget(event);
  if (typeof change.new === 'string') {
    const parsed = Date.parse(change.new);
    const until =
      Number.isNaN(parsed) === true
        ? formatAuditValue(change.new)
        : `<t:${Math.floor(parsed / 1000)}:f>`;
    return [makeItem(event, 'member_timeout', `Timed out: ${target} until ${until}`, [])];
  }
  if (
    (change.new === null || change.new === undefined) &&
    change.old !== null &&
    change.old !== undefined
  ) {
    return [makeItem(event, 'member_timeout_removed', `Timeout removed: ${target}`, [])];
  }
  return [];
}

function inviteCreateItem(event: AuditLogEntryEvent): AuditItem {
  const codeChange = findChange(event, 'code');
  const code = changeString(codeChange?.new) ?? changeString(codeChange?.old) ?? 'unknown';
  const channelChange = findChange(event, 'channel_id');
  const channelId = changeString(channelChange?.new) ?? changeString(channelChange?.old);
  const channelPart = channelId === undefined ? '(unknown channel)' : `<#${channelId}>`;
  const maxAge = changeNumber(findChange(event, 'max_age')?.new);
  const expiry =
    maxAge === undefined
      ? 'unknown'
      : maxAge === 0
        ? 'never'
        : `in ${Math.round(maxAge / 3600)} hours`;
  const maxUses = changeNumber(findChange(event, 'max_uses')?.new);
  const uses = maxUses === undefined ? 'unknown' : maxUses === 0 ? 'unlimited' : String(maxUses);
  return makeItem(
    event,
    'invite_create',
    `Invite created: discord.gg/${safeName(code)} for ${channelPart} (expires: ${expiry}, uses: ${uses})`,
    [],
  );
}

export function auditItemsFor(event: AuditLogEntryEvent): AuditItem[] {
  switch (event.action) {
    case AUDIT_ACTION_MEMBER_KICK:
      return [makeItem(event, 'member_kick', `Kicked: ${memberTarget(event)}`, [])];
    case AUDIT_ACTION_MEMBER_BAN_ADD:
      return [makeItem(event, 'member_ban', `Banned: ${memberTarget(event)}`, [])];
    case AUDIT_ACTION_MEMBER_BAN_REMOVE:
      return [makeItem(event, 'member_unban', `Unbanned: ${memberTarget(event)}`, [])];
    case AUDIT_ACTION_MEMBER_UPDATE:
      return memberTimeoutItems(event);
    case AUDIT_ACTION_CHANNEL_CREATE: {
      const name = changeString(findChange(event, 'name')?.new) ?? 'unknown';
      return [
        makeItem(
          event,
          'channel_create',
          `Channel created: ${channelTarget(event)} (${safeName(name)})`,
          [],
        ),
      ];
    }
    case AUDIT_ACTION_CHANNEL_UPDATE:
      return [
        makeItem(
          event,
          'channel_update',
          `Channel changed: ${channelTarget(event)}`,
          changeLinesFor(event.changes),
        ),
      ];
    case AUDIT_ACTION_CHANNEL_DELETE: {
      const name =
        changeString(findChange(event, 'name')?.old) ??
        changeString(findChange(event, 'name')?.new) ??
        'unknown';
      return [makeItem(event, 'channel_delete', `Channel deleted: #${safeName(name)}`, [])];
    }
    case AUDIT_ACTION_THREAD_CREATE: {
      const name = changeString(findChange(event, 'name')?.new) ?? 'unknown';
      return [
        makeItem(
          event,
          'thread_create',
          `Thread created: ${channelTarget(event)} (${safeName(name)})`,
          [],
        ),
      ];
    }
    case AUDIT_ACTION_THREAD_DELETE: {
      const name =
        changeString(findChange(event, 'name')?.old) ??
        changeString(findChange(event, 'name')?.new) ??
        'unknown';
      return [makeItem(event, 'thread_delete', `Thread deleted: ${safeName(name)}`, [])];
    }
    case AUDIT_ACTION_GUILD_UPDATE:
      return [
        makeItem(event, 'guild_update', 'Server settings changed', changeLinesFor(event.changes)),
      ];
    case AUDIT_ACTION_INVITE_CREATE:
      return [inviteCreateItem(event)];
    case AUDIT_ACTION_INVITE_DELETE: {
      const codeChange = findChange(event, 'code');
      const code = changeString(codeChange?.old) ?? changeString(codeChange?.new) ?? 'unknown';
      return [makeItem(event, 'invite_delete', `Invite deleted: discord.gg/${safeName(code)}`, [])];
    }
    case AUDIT_ACTION_EMOJI_CREATE: {
      const name = changeString(findChange(event, 'name')?.new) ?? 'unknown';
      return [makeItem(event, 'emoji_create', `Emoji added: :${safeName(name)}:`, [])];
    }
    case AUDIT_ACTION_EMOJI_UPDATE: {
      const oldName = changeString(findChange(event, 'name')?.old) ?? 'unknown';
      const newName = changeString(findChange(event, 'name')?.new) ?? 'unknown';
      return [
        makeItem(
          event,
          'emoji_update',
          `Emoji renamed: :${safeName(oldName)}: → :${safeName(newName)}:`,
          [],
        ),
      ];
    }
    case AUDIT_ACTION_EMOJI_DELETE: {
      const oldName =
        changeString(findChange(event, 'name')?.old) ??
        changeString(findChange(event, 'name')?.new) ??
        'unknown';
      return [makeItem(event, 'emoji_delete', `Emoji removed: :${safeName(oldName)}:`, [])];
    }
    case AUDIT_ACTION_STICKER_CREATE: {
      const name =
        changeString(findChange(event, 'name')?.new) ??
        changeString(findChange(event, 'name')?.old) ??
        'unknown';
      return [makeItem(event, 'sticker_create', `Sticker added: ${safeName(name)}`, [])];
    }
    case AUDIT_ACTION_STICKER_UPDATE: {
      const name =
        changeString(findChange(event, 'name')?.new) ??
        changeString(findChange(event, 'name')?.old) ??
        'unknown';
      return [
        makeItem(
          event,
          'sticker_update',
          `Sticker changed: ${safeName(name)}`,
          changeLinesFor(event.changes),
        ),
      ];
    }
    case AUDIT_ACTION_STICKER_DELETE: {
      const name =
        changeString(findChange(event, 'name')?.old) ??
        changeString(findChange(event, 'name')?.new) ??
        'unknown';
      return [makeItem(event, 'sticker_delete', `Sticker removed: ${safeName(name)}`, [])];
    }
    default:
      return [];
  }
}
