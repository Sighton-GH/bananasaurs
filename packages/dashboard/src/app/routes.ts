/**
 * Navigation is data (ADR 0043 D3). Slice 8 adds rows; Slice 10 adds `stub`
 * rows for the Release 3 areas so the roadmap is visible without the UI
 * pretending anything exists. Nothing else about the rail changes.
 */
export type NavStatus = 'built' | 'stub';

export interface NavEntry {
  readonly path: string;
  readonly label: string;
  readonly status: NavStatus;
}

export const NAV: readonly NavEntry[] = [
  { path: '/', label: 'Overview', status: 'built' },
  { path: '/safety', label: 'Safety', status: 'built' },
  { path: '/logging', label: 'Logging', status: 'built' },
  { path: '/panels', label: 'Role panels', status: 'built' },
  { path: '/audit', label: 'Audit', status: 'built' },
];
