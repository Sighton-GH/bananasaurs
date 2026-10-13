/**
 * The only file that imports lucide-react (ADR 0142 decision 4; ESLint
 * enforces it). Add an icon here, by its role, before using it on a page.
 * 16 px in dense UI, 20 px in headers, stroke 1.75, currentColor.
 */
import { createElement } from 'react';
import type { LucideIcon } from 'lucide-react';
export type { LucideIcon };
export {
  AlertTriangle as IconWarning,
  Ban as IconForbidden,
  Check as IconCheck,
  ChevronDown as IconChevronDown,
  ChevronLeft as IconChevronLeft,
  ChevronRight as IconChevronRight,
  CircleAlert as IconError,
  CircleCheck as IconSuccess,
  Clipboard as IconCopy,
  ExternalLink as IconExternal,
  Info as IconInfo,
  Loader2 as IconSpinner,
  Moon as IconMoon,
  MoreHorizontal as IconMore,
  RefreshCw as IconRefresh,
  Search as IconSearch,
  Sun as IconSun,
  X as IconClose,
  FileQuestion as IconNotFound,
  CloudOff as IconUnavailable,
  Inbox as IconEmpty,
  // P4 Task 1 rail icons, aliased by role. `Inbox` and `Search` already have
  // aliases above (IconEmpty, IconSearch); they are aliased a second time
  // under their rail role names, as the plan allows.
  LayoutDashboard as IconOverview,
  ListChecks as IconTasks,
  ToggleRight as IconPanels,
  CalendarClock as IconSchedules,
  BookOpen as IconGuide,
  Shield as IconAutomod,
  Inbox as IconReview,
  FolderOpen as IconCases,
  Users as IconMembers,
  ScrollText as IconLogging,
  ShieldAlert as IconSafety,
  KeyRound as IconPermissions,
  Bot as IconAiSetup,
  SlidersHorizontal as IconTuning,
  Sparkles as IconBehaviours,
  MessagesSquare as IconConversations,
  History as IconHistory,
  Wrench as IconSkills,
  Library as IconResources,
  Brain as IconMemory,
  Archive as IconArchive,
  Search as IconSearchPage,
  Cog as IconJobs,
  FileClock as IconAudit,
  Stethoscope as IconDoctor,
  DatabaseBackup as IconBackups,
  Settings as IconConfig,
  UserCog as IconAccounts,
  Plug as IconConnectedApps,
  Plus as IconAdd,
  Command as IconCommand,
} from 'lucide-react';

const SIZE = { sm: 16, md: 20 } as const;

export function Icon({
  icon,
  size = 'sm',
  label,
  className,
}: {
  readonly icon: LucideIcon;
  readonly size?: 'sm' | 'md';
  readonly label?: string;
  readonly className?: string;
}) {
  return createElement(icon, {
    size: SIZE[size],
    strokeWidth: 1.75,
    className,
    ...(label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label }),
  });
}
