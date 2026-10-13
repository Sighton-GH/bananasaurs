/** Navigation remains data so access, labelling and icons stay consistent across layouts. */
import {
  IconAiSetup,
  IconArchive,
  IconAccounts,
  IconAudit,
  IconAutomod,
  IconBackups,
  IconBehaviours,
  IconCases,
  IconConfig,
  IconConnectedApps,
  IconConversations,
  IconDoctor,
  IconGuide,
  IconHistory,
  IconJobs,
  IconLogging,
  IconMembers,
  IconMemory,
  IconOverview,
  IconPanels,
  IconPermissions,
  IconResources,
  IconReview,
  IconSafety,
  IconSchedules,
  IconSearchPage,
  IconSkills,
  IconTasks,
  IconTuning,
  type LucideIcon,
} from '../ui/icons.js';

export type NavGroup = 'Club' | 'Moderation' | 'Assistant' | 'Messages' | 'System';

export interface NavEntry {
  readonly path: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Extra words the command palette matches on (P4 Task 4). */
  readonly keywords?: readonly string[];
  readonly group: NavGroup;
  readonly ownerOnly?: true;
  /** Also shown to an account holding `tasks.manage` in this guild (ADR 0130). */
  readonly taskAccess?: true;
}

/**
 * The P4 rail groups, in order (plan Decision 1: grouped by what people do).
 * The desktop rail and the mobile jump sheet both render this order; empty
 * groups render nothing rather than a bare heading.
 */
export const GROUPS = ['Club', 'Moderation', 'Assistant', 'Messages', 'System'] as const;

export const NAV: readonly NavEntry[] = [
  { path: '/', label: 'Overview', icon: IconOverview, group: 'Club' },
  {
    path: '/tasks',
    label: 'Tasks',
    icon: IconTasks,
    group: 'Club',
    ownerOnly: true,
    taskAccess: true,
  },
  { path: '/panels', label: 'Role panels', icon: IconPanels, group: 'Club' },
  { path: '/assistant/schedules', label: 'Schedules', icon: IconSchedules, group: 'Club' },
  { path: '/docs', label: 'Guide', icon: IconGuide, group: 'Club' },
  { path: '/automod', label: 'Automod', icon: IconAutomod, group: 'Moderation' },
  { path: '/review', label: 'Review queue', icon: IconReview, group: 'Moderation' },
  { path: '/cases', label: 'Cases', icon: IconCases, group: 'Moderation' },
  { path: '/members', label: 'Members', icon: IconMembers, group: 'Moderation' },
  { path: '/logging', label: 'Logging', icon: IconLogging, group: 'Moderation' },
  {
    path: '/safety',
    label: 'Safety',
    icon: IconSafety,
    keywords: ['kill switch', 'dry run', 'breaker'],
    group: 'Moderation',
  },
  { path: '/permissions', label: 'Permissions', icon: IconPermissions, group: 'Moderation' },
  { path: '/assistant/setup', label: 'AI setup', icon: IconAiSetup, group: 'Assistant' },
  {
    path: '/assistant/tuning',
    label: 'AI tuning',
    icon: IconTuning,
    group: 'Assistant',
    ownerOnly: true,
  },
  { path: '/assistant', label: 'Behaviours', icon: IconBehaviours, group: 'Assistant' },
  {
    path: '/assistant/conversations',
    label: 'Conversations',
    icon: IconConversations,
    group: 'Assistant',
  },
  { path: '/assistant/history', label: 'History', icon: IconHistory, group: 'Assistant' },
  { path: '/assistant/skills', label: 'Skills', icon: IconSkills, group: 'Assistant' },
  { path: '/assistant/resources', label: 'Resources', icon: IconResources, group: 'Assistant' },
  { path: '/memory', label: 'Memory', icon: IconMemory, group: 'Assistant' },
  { path: '/archive', label: 'Archive', icon: IconArchive, group: 'Messages' },
  { path: '/search', label: 'Search', icon: IconSearchPage, group: 'Messages' },
  { path: '/jobs', label: 'Background tasks', icon: IconJobs, group: 'System' },
  { path: '/audit', label: 'Audit log', icon: IconAudit, group: 'System' },
  { path: '/doctor', label: 'Doctor', icon: IconDoctor, group: 'System' },
  { path: '/backups', label: 'Backups', icon: IconBackups, group: 'System' },
  { path: '/config', label: 'Configuration', icon: IconConfig, group: 'System' },
  { path: '/accounts', label: 'Accounts', icon: IconAccounts, group: 'System' },
  { path: '/mcp', label: 'Connected apps', icon: IconConnectedApps, group: 'System' },
];

/**
 * NAV without owner-only entries unless the viewer is the instance owner. An
 * entry flagged `taskAccess` also shows for an account that may manage this
 * guild's tasks (ADR 0130); every other owner-only entry stays owner-only.
 */
export const visibleNav = (instanceOwner: boolean, canManageTasks = false): readonly NavEntry[] =>
  instanceOwner
    ? NAV
    : NAV.filter(
        (entry) => entry.ownerOnly !== true || (canManageTasks && entry.taskAccess === true),
      );

/**
 * The NAV path a location belongs to. Detail routes (a task, a rule, a
 * trace) sit under their list page: the longest path matching on a slash
 * boundary wins, so `/assistant/history/t1` resolves to History, not
 * Behaviours. The root matches only itself, and a bare prefix
 * (`/tasksXYZ`) or an unknown path matches nothing. The rail's current
 * marker, the jump sheet's orientation and the tab title all share this
 * rule (P4 Task 1).
 */
export const activeNavPath = (location: string): string | undefined => {
  let best: string | undefined;
  for (const entry of NAV) {
    if (entry.path === '/') {
      if (location === '/' && best === undefined) best = '/';
      continue;
    }
    if (
      (location === entry.path || location.startsWith(`${entry.path}/`)) &&
      (best === undefined || entry.path.length > best.length)
    )
      best = entry.path;
  }
  return best;
};

/** The rail label for a path, for the browser tab (ADR 0142 decision 8). */
export const pageTitle = (path: string): string | undefined => {
  const active = activeNavPath(path);
  return active === undefined ? undefined : NAV.find((n) => n.path === active)?.label;
};
