/** Navigation remains data so access, labelling and future states stay consistent across layouts. */
export type NavStatus = 'built' | 'stub';
export type NavGroup = 'Operate' | 'Moderation' | 'Archive' | 'Instance' | 'Release 3';

export interface NavEntry {
  readonly path: string;
  readonly label: string;
  readonly status: NavStatus;
  readonly group: NavGroup;
}

export const NAV: readonly NavEntry[] = [
  { path: '/', label: 'Overview', status: 'built', group: 'Operate' },
  { path: '/safety', label: 'Safety', status: 'built', group: 'Operate' },
  { path: '/logging', label: 'Logging', status: 'built', group: 'Operate' },
  { path: '/panels', label: 'Role panels', status: 'built', group: 'Operate' },
  { path: '/automod', label: 'Automod', status: 'built', group: 'Moderation' },
  { path: '/review', label: 'Review', status: 'built', group: 'Moderation' },
  { path: '/cases', label: 'Cases', status: 'built', group: 'Moderation' },
  { path: '/members', label: 'Members', status: 'built', group: 'Moderation' },
  { path: '/jobs', label: 'Jobs', status: 'built', group: 'Operate' },
  { path: '/audit', label: 'Audit', status: 'built', group: 'Instance' },
  { path: '/cutover', label: 'Cutover', status: 'built', group: 'Moderation' },
  { path: '/archive', label: 'Archive', status: 'built', group: 'Archive' },
  { path: '/search', label: 'Search', status: 'built', group: 'Archive' },
  { path: '/doctor', label: 'Doctor', status: 'built', group: 'Instance' },
  { path: '/backups', label: 'Backups', status: 'built', group: 'Instance' },
  { path: '/config', label: 'Configuration', status: 'built', group: 'Instance' },
  { path: '/accounts', label: 'Accounts', status: 'built', group: 'Instance' },
  { path: '/mcp', label: 'MCP connector', status: 'built', group: 'Instance' },
  { path: '/providers', label: 'Providers', status: 'built', group: 'Instance' },
  { path: '/resources', label: 'Resources', status: 'stub', group: 'Release 3' },
  { path: '/memory', label: 'Memory', status: 'stub', group: 'Release 3' },
  { path: '/ai', label: 'AI workspace', status: 'stub', group: 'Release 3' },
  { path: '/proposals', label: 'Proposals', status: 'stub', group: 'Release 3' },
];
