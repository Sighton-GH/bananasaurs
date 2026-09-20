/** Navigation remains data so access, labelling and future states stay consistent across layouts. */
export type NavStatus = 'built' | 'stub';
export type NavGroup = 'Workspace' | 'Operations' | 'Governance' | 'Release 3';

export interface NavEntry {
  readonly path: string;
  readonly label: string;
  readonly status: NavStatus;
  readonly group: NavGroup;
}

export const NAV: readonly NavEntry[] = [
  { path: '/', label: 'Overview', status: 'built', group: 'Workspace' },
  { path: '/safety', label: 'Safety', status: 'built', group: 'Workspace' },
  { path: '/logging', label: 'Logging', status: 'built', group: 'Operations' },
  { path: '/panels', label: 'Role panels', status: 'built', group: 'Operations' },
  { path: '/automod', label: 'Automod', status: 'built', group: 'Operations' },
  { path: '/review', label: 'Review', status: 'built', group: 'Operations' },
  { path: '/cases', label: 'Cases', status: 'built', group: 'Operations' },
  { path: '/audit', label: 'Audit', status: 'built', group: 'Governance' },
  { path: '/cutover', label: 'Cutover', status: 'built', group: 'Governance' },
  { path: '/archive', label: 'Archive', status: 'stub', group: 'Release 3' },
  { path: '/search', label: 'Search', status: 'stub', group: 'Release 3' },
  { path: '/resources', label: 'Resources', status: 'stub', group: 'Release 3' },
  { path: '/providers', label: 'Providers', status: 'stub', group: 'Release 3' },
  { path: '/memory', label: 'Memory', status: 'stub', group: 'Release 3' },
  { path: '/ai', label: 'AI workspace', status: 'stub', group: 'Release 3' },
  { path: '/proposals', label: 'Proposals', status: 'stub', group: 'Release 3' },
];
