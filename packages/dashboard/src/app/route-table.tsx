/**
 * The pages lane's route-table fragment (ADR 0051 W3/W4a), for the
 * integration owner that wires `app/Shell.tsx` and `app/routes.ts` NAV.
 * Every entry is a page this lane built or rewrote, keyed by the path the
 * operator catalogue gives it. The four Release 3 placeholders carry their
 * stub copy here too so the rebuilt rail and routes keep D6b's wording
 * without re-deriving it.
 *
 * Status semantics match `NavStatus` in `app/routes.ts`: `built` entries are
 * live pages, `stub` entries render `StubPage` and make no API call.
 */
import type { ComponentType } from 'react';
import { AccountsPage } from '../pages/accounts.js';
import { ArchivePage } from '../pages/archive.js';
import { AuditPage } from '../pages/audit.js';
import { BackupsPage } from '../pages/backups.js';
import { ConfigPage } from '../pages/config.js';
import { DoctorPage } from '../pages/doctor.js';
import { JobsPage } from '../pages/jobs.js';
import { LoggingPage } from '../pages/logging.js';
import { McpPage } from '../pages/mcp.js';
import { OverviewPage } from '../pages/overview.js';
import { PanelsPage } from '../pages/panels.js';
import { ProvidersPage } from '../pages/providers.js';
import { SafetyPage } from '../pages/safety.js';
import { SearchPage } from '../pages/search.js';
import type { StubPageProps } from '../pages/stub.js';

export interface BuiltRoute {
  readonly path: string;
  readonly label: string;
  readonly status: 'built';
  readonly component: ComponentType;
}

export interface StubRouteEntry {
  readonly path: string;
  readonly label: string;
  readonly status: 'stub';
  readonly stub: Omit<StubPageProps, 'title'>;
}

/** The nine new operator pages plus the five rewritten Release 1 pages. */
export const BUILT_PAGE_ROUTES: readonly BuiltRoute[] = [
  { path: '/', label: 'Overview', status: 'built', component: OverviewPage },
  { path: '/safety', label: 'Safety', status: 'built', component: SafetyPage },
  { path: '/logging', label: 'Logging', status: 'built', component: LoggingPage },
  { path: '/panels', label: 'Role panels', status: 'built', component: PanelsPage },
  { path: '/audit', label: 'Audit', status: 'built', component: AuditPage },
  { path: '/jobs', label: 'Jobs', status: 'built', component: JobsPage },
  { path: '/doctor', label: 'Doctor', status: 'built', component: DoctorPage },
  { path: '/backups', label: 'Backups', status: 'built', component: BackupsPage },
  { path: '/config', label: 'Configuration', status: 'built', component: ConfigPage },
  { path: '/accounts', label: 'Accounts', status: 'built', component: AccountsPage },
  { path: '/mcp', label: 'MCP connector', status: 'built', component: McpPage },
  { path: '/archive', label: 'Archive', status: 'built', component: ArchivePage },
  { path: '/search', label: 'Search', status: 'built', component: SearchPage },
  { path: '/providers', label: 'Providers', status: 'built', component: ProvidersPage },
];

/** The four Release 3 placeholders (D6b): visible on the rail, plainly not built. */
export const STUB_PAGE_ROUTES: readonly StubRouteEntry[] = [
  {
    path: '/resources',
    label: 'Resources',
    status: 'stub',
    stub: { purpose: 'Files, links and notes the club keeps, findable from Discord.' },
  },
  {
    path: '/memory',
    label: 'Memory',
    status: 'stub',
    stub: { purpose: 'What the assistant remembers about the server, and how to correct it.' },
  },
  {
    path: '/ai',
    label: 'AI workspace',
    status: 'stub',
    stub: { purpose: 'Where the owner drafts and reviews AI-assisted actions before they run.' },
  },
  {
    path: '/proposals',
    label: 'Proposals',
    status: 'stub',
    stub: { purpose: 'Changes the assistant proposes, waiting for a person to approve.' },
  },
];
