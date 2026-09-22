/** Navigation remains data so access, labelling and future states stay consistent across layouts. */
export type NavStatus = 'built' | 'stub';
export type NavGroup = 'Start here' | 'Moderation' | 'Messages' | 'Assistant' | 'Advanced / System';

export interface NavEntry {
  readonly path: string;
  readonly label: string;
  readonly status: NavStatus;
  readonly group: NavGroup;
}

/**
 * ADR 0051 D6's rail groups, in order. The desktop rail and the mobile jump
 * sheet both render this order; empty groups render nothing rather than a
 * bare heading.
 */
export const GROUPS = [
  'Start here',
  'Moderation',
  'Messages',
  'Assistant',
  'Advanced / System',
] as const;

export const NAV: readonly NavEntry[] = [
  { path: '/', label: 'Overview', status: 'built', group: 'Start here' },
  { path: '/safety', label: 'Safety', status: 'built', group: 'Start here' },
  { path: '/permissions', label: 'Permissions', status: 'built', group: 'Start here' },
  { path: '/logging', label: 'Logging', status: 'built', group: 'Start here' },
  { path: '/panels', label: 'Self-granted roles', status: 'built', group: 'Start here' },
  { path: '/automod', label: 'Automod', status: 'built', group: 'Moderation' },
  { path: '/review', label: 'Review', status: 'built', group: 'Moderation' },
  { path: '/cases', label: 'Cases', status: 'built', group: 'Moderation' },
  { path: '/members', label: 'Members', status: 'built', group: 'Moderation' },
  { path: '/jobs', label: 'Background tasks', status: 'built', group: 'Advanced / System' },
  { path: '/audit', label: 'Audit', status: 'built', group: 'Advanced / System' },
  { path: '/cutover', label: 'Turn on moderation', status: 'built', group: 'Moderation' },
  { path: '/archive', label: 'Archive', status: 'built', group: 'Messages' },
  { path: '/search', label: 'Search', status: 'built', group: 'Messages' },
  { path: '/doctor', label: 'Doctor', status: 'built', group: 'Advanced / System' },
  { path: '/backups', label: 'Backups', status: 'built', group: 'Advanced / System' },
  { path: '/config', label: 'Configuration', status: 'built', group: 'Advanced / System' },
  { path: '/accounts', label: 'Accounts', status: 'built', group: 'Advanced / System' },
  { path: '/mcp', label: 'Connected apps', status: 'built', group: 'Advanced / System' },
  { path: '/assistant', label: 'Assistant', status: 'built', group: 'Assistant' },
  { path: '/assistant/skills', label: 'Skills', status: 'built', group: 'Assistant' },
  { path: '/assistant/schedules', label: 'Schedules', status: 'built', group: 'Assistant' },
  { path: '/assistant/resources', label: 'Resources', status: 'built', group: 'Assistant' },
  { path: '/memory', label: 'Memory', status: 'built', group: 'Assistant' },
  { path: '/providers', label: 'AI setup', status: 'built', group: 'Assistant' },
  {
    path: '/assistant/activity',
    label: 'Assistant history',
    status: 'built',
    group: 'Advanced / System',
  },
];
