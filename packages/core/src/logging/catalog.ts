export type LogActionGroup =
  'Messages' | 'Members' | 'Roles' | 'Channels' | 'Server' | 'Moderation';
export const LOG_ACTION_GROUPS: readonly LogActionGroup[] = [
  'Messages',
  'Members',
  'Roles',
  'Channels',
  'Server',
  'Moderation',
];

export interface LogActionInfo {
  readonly kind: string;
  readonly group: LogActionGroup;
  readonly label: string;
  /** True when the action happens IN a channel, so a route's excluded channels apply to it. */
  readonly hasSourceChannel: boolean;
}

/** One entry per LOG_EVENT_KINDS value, in display order within each group (ADR 0123). */
export const LOG_ACTION_CATALOG: readonly LogActionInfo[] = [
  { kind: 'message_create', group: 'Messages', label: 'Message sent', hasSourceChannel: true },
  { kind: 'message_edit', group: 'Messages', label: 'Message edited', hasSourceChannel: true },
  { kind: 'message_delete', group: 'Messages', label: 'Message deleted', hasSourceChannel: true },
  {
    kind: 'message_bulk_delete',
    group: 'Messages',
    label: 'Messages bulk-deleted (purge)',
    hasSourceChannel: true,
  },
  { kind: 'member_join', group: 'Members', label: 'Member joined', hasSourceChannel: false },
  { kind: 'member_leave', group: 'Members', label: 'Member left', hasSourceChannel: false },
  {
    kind: 'member_roles_changed',
    group: 'Members',
    label: 'Roles changed',
    hasSourceChannel: false,
  },
  {
    kind: 'member_nickname_changed',
    group: 'Members',
    label: 'Nickname changed',
    hasSourceChannel: false,
  },
  {
    kind: 'member_username_changed',
    group: 'Members',
    label: 'Username or display name changed',
    hasSourceChannel: false,
  },
  {
    kind: 'member_avatar_changed',
    group: 'Members',
    label: 'Avatar changed',
    hasSourceChannel: false,
  },
  { kind: 'role_create', group: 'Roles', label: 'Role created', hasSourceChannel: false },
  { kind: 'role_update', group: 'Roles', label: 'Role changed', hasSourceChannel: false },
  { kind: 'role_delete', group: 'Roles', label: 'Role deleted', hasSourceChannel: false },
  { kind: 'channel_create', group: 'Channels', label: 'Channel created', hasSourceChannel: false },
  { kind: 'channel_update', group: 'Channels', label: 'Channel changed', hasSourceChannel: false },
  { kind: 'channel_delete', group: 'Channels', label: 'Channel deleted', hasSourceChannel: false },
  { kind: 'thread_create', group: 'Channels', label: 'Thread created', hasSourceChannel: false },
  { kind: 'thread_delete', group: 'Channels', label: 'Thread deleted', hasSourceChannel: false },
  {
    kind: 'guild_update',
    group: 'Server',
    label: 'Server settings changed',
    hasSourceChannel: false,
  },
  { kind: 'invite_create', group: 'Server', label: 'Invite created', hasSourceChannel: false },
  { kind: 'invite_delete', group: 'Server', label: 'Invite deleted', hasSourceChannel: false },
  { kind: 'emoji_create', group: 'Server', label: 'Emoji added', hasSourceChannel: false },
  { kind: 'emoji_update', group: 'Server', label: 'Emoji renamed', hasSourceChannel: false },
  { kind: 'emoji_delete', group: 'Server', label: 'Emoji removed', hasSourceChannel: false },
  { kind: 'sticker_create', group: 'Server', label: 'Sticker added', hasSourceChannel: false },
  { kind: 'sticker_update', group: 'Server', label: 'Sticker changed', hasSourceChannel: false },
  { kind: 'sticker_delete', group: 'Server', label: 'Sticker removed', hasSourceChannel: false },
  {
    kind: 'guild_available',
    group: 'Server',
    label: 'Bot connected to the server',
    hasSourceChannel: false,
  },
  {
    kind: 'guild_unavailable',
    group: 'Server',
    label: 'Bot lost the server',
    hasSourceChannel: false,
  },
  {
    kind: 'member_warn',
    group: 'Moderation',
    label: 'Member warned (/mod warn)',
    hasSourceChannel: false,
  },
  {
    kind: 'member_timeout',
    group: 'Moderation',
    label: 'Member timed out',
    hasSourceChannel: false,
  },
  {
    kind: 'member_timeout_removed',
    group: 'Moderation',
    label: 'Timeout removed',
    hasSourceChannel: false,
  },
  { kind: 'member_kick', group: 'Moderation', label: 'Member kicked', hasSourceChannel: false },
  { kind: 'member_ban', group: 'Moderation', label: 'Member banned', hasSourceChannel: false },
  { kind: 'member_unban', group: 'Moderation', label: 'Member unbanned', hasSourceChannel: false },
  {
    kind: 'automod_action',
    group: 'Moderation',
    label: 'Discord AutoMod action',
    hasSourceChannel: false,
  },
];
export const logActionInfo = (kind: string): LogActionInfo | undefined =>
  LOG_ACTION_CATALOG.find((a) => a.kind === kind);
