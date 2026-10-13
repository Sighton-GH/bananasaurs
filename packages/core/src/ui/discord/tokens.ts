/** The six tones (docs/28 §4). Each means one thing on Discord and in the dashboard. */
export type Tone = 'neutral' | 'accent' | 'progress' | 'hold' | 'ok' | 'danger';

export const TONE_ACCENT: Readonly<Record<Tone, number>> = {
  neutral: 0x64748b,
  accent: 0x2f5bd3,
  progress: 0x3b82f6,
  hold: 0xe0a526,
  ok: 0x2e9a62,
  danger: 0xd64545,
};

/** The emoji vocabulary (docs/28 §5.1). Add a concept here, never inline in a renderer. */
export const ICON = {
  task: '📋',
  due: '⏰',
  overdue: '⚠️',
  inProgress: '🔧',
  review: '👀',
  done: '✅',
  sentBack: '↩️',
  update: '📝',
  link: '🔗',
  digest: '🗓️',
  joined: '👋',
  left: '🚪',
  edited: '✏️',
  deleted: '🗑️',
  roles: '🏷️',
  automod: '🛡️',
  warned: '📣',
  timeout: '⏸️',
  ban: '🔨',
  kick: '👢',
  error: '❌',
  hint: '💡',
  stop: '✋',
  checkin: '👋',
} as const;
export type IconName = keyof typeof ICON;
