export type LogActionGroup = 'Messages' | 'Members' | 'Roles' | 'Channels' | 'Server' | 'Moderation';
export const LOG_ACTION_GROUPS: readonly LogActionGroup[] = ['Messages', 'Members', 'Roles', 'Channels', 'Server', 'Moderation'];

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
  { kind: 'member_join', group: 'Members', label: 'Member joined', hasSourceChannel: false },
  { kind: 'member_leave', group: 'Members', label: 'Member left', hasSourceChannel: false },
  { kind: 'member_update', group: 'Members', label: 'Member updated', hasSourceChannel: false },
  { kind: 'role_create', group: 'Roles', label: 'Role created', hasSourceChannel: false },
  { kind: 'role_update', group: 'Roles', label: 'Role changed', hasSourceChannel: false },
  { kind: 'role_delete', group: 'Roles', label: 'Role deleted', hasSourceChannel: false },
  { kind: 'guild_available', group: 'Server', label: 'Bot connected to the server', hasSourceChannel: false },
  { kind: 'guild_unavailable', group: 'Server', label: 'Bot lost the server', hasSourceChannel: false },
  { kind: 'automod_action', group: 'Moderation', label: 'Discord AutoMod action', hasSourceChannel: false },
];
export const logActionInfo = (kind: string): LogActionInfo | undefined =>
  LOG_ACTION_CATALOG.find((a) => a.kind === kind);
