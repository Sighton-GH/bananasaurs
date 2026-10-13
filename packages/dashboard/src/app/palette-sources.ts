/**
 * What the command palette can jump to. Every item navigates; nothing here writes.
 *
 * This is a `.ts` file, so `tsconfig.all.json` (a Node program without `--jsx`)
 * type-checks it and it cannot import a `.tsx` module, even for a type. The
 * response shapes it reads are therefore narrow structural copies of the
 * fields used. `CommandPalette.tsx` holds compile-time checks that the real
 * `Snapshot` (pages/tasks/index.tsx), `ModCase` (pages/cases.tsx) and `Session['read']`
 * (app/session.tsx) still satisfy them, so drift fails the build.
 */
import { mayManageTasks, type SessionInfo } from '../api.js';
import { RULE_KIND_LABEL, type RuleSummary } from '../api/automod.js';
import { score } from '../lib/fuzzy.js';
import {
  IconAdd,
  IconAutomod,
  IconCases,
  IconCommand,
  IconDoctor,
  IconMembers,
  IconSafety,
  IconTasks,
  type LucideIcon,
} from '../ui/icons.js';
import { visibleNav } from './routes.js';

export type PaletteSection = 'Pages' | 'Actions' | 'Tasks' | 'Cases' | 'Automod rules' | 'Members';

export interface PaletteItem {
  /** Stable key, e.g. `page:/tasks`, `task:<uuid>`. */
  readonly id: string;
  readonly section: PaletteSection;
  readonly label: string;
  /** Right-aligned muted text: team, status, member. */
  readonly hint?: string;
  readonly keywords?: readonly string[];
  readonly href: string;
  readonly icon: LucideIcon;
}

/** `Session['read']`: a GET that throws on failure. */
export type PaletteRead = <T>(url: string) => Promise<T>;

/** The fields of `GET /api/tasks?include=done,archived` the palette reads (pages/tasks/index.tsx `Snapshot`). */
export interface TaskSnapshotShape {
  readonly teams: readonly { readonly teamId: string; readonly name: string }[];
  readonly tasks: readonly {
    readonly taskId: string;
    readonly title: string;
    readonly teamId: string;
    readonly status: 'not_started' | 'in_progress' | 'awaiting_approval' | 'done';
    readonly archivedAt: number | null;
  }[];
}

/** The fields of one `GET /api/mod/cases` row the palette reads (pages/cases.tsx `ModCase`). */
export interface CaseShape {
  readonly caseId: string;
  readonly memberId: string;
  readonly member: { readonly username: string; readonly displayName: string } | null;
}

export interface PaletteSource {
  readonly section: PaletteSection;
  readonly load: (read: PaletteRead) => Promise<readonly PaletteItem[]>;
  readonly visible: (info: SessionInfo) => boolean;
}

/** Display and tie-break order. */
export const SECTION_ORDER: readonly PaletteSection[] = [
  'Pages',
  'Actions',
  'Tasks',
  'Cases',
  'Automod rules',
  'Members',
];

export const MAX_PER_SECTION = 8;

const TASK_STATUS_WORDS: Record<TaskSnapshotShape['tasks'][number]['status'], string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  awaiting_approval: 'Awaiting approval',
  done: 'Done',
};

const isOwner = (info: SessionInfo): boolean => info.instanceOwner === true;

/** Pages (the same `visibleNav` the rail and jump sheet read) and Actions. */
export const staticItems = (info: SessionInfo): readonly PaletteItem[] => {
  const pages: PaletteItem[] = visibleNav(isOwner(info), info.canManageTasks === true).map(
    (entry) => ({
      id: `page:${entry.path}`,
      section: 'Pages',
      label: entry.label,
      ...(entry.keywords === undefined ? {} : { keywords: entry.keywords }),
      href: entry.path,
      icon: entry.icon,
    }),
  );
  const actions: PaletteItem[] = [];
  const action = (
    id: string,
    label: string,
    href: string,
    icon: LucideIcon,
    extra: Partial<PaletteItem> = {},
  ): void => {
    actions.push({ id: `action:${id}`, section: 'Actions', label, href, icon, ...extra });
  };
  if (mayManageTasks(info)) action('new-task', 'New task', '/tasks/new', IconAdd);
  action('new-rule', 'New automod rule', '/automod', IconAdd);
  if (isOwner(info)) action('new-account', 'New account', '/accounts/new', IconAdd);
  // Navigates to Safety only: the guild-wide stop keeps its confirmation there.
  action('kill-switch', 'Kill switch', '/safety', IconSafety, {
    hint: 'Opens Safety',
    keywords: ['killswitch', 'stop', 'emergency'],
  });
  action('doctor', 'Run Doctor', '/doctor', IconDoctor);
  if (isOwner(info)) action('kit', 'Open the UI kit', '/kit', IconCommand);
  return [...pages, ...actions];
};

/** A 17-20 digit id offers "Open member <id>". There is no name search. */
export const memberItem = (query: string): PaletteItem | undefined => {
  const id = query.trim();
  if (!/^\d{17,20}$/.test(id)) return undefined;
  return {
    id: `member:${id}`,
    section: 'Members',
    label: `Open member ${id}`,
    href: `/members/${encodeURIComponent(id)}`,
    icon: IconMembers,
  };
};

export const PALETTE_SOURCES: readonly PaletteSource[] = [
  {
    section: 'Tasks',
    visible: (info) => mayManageTasks(info),
    load: async (read) => {
      const snapshot = await read<TaskSnapshotShape>('/api/tasks?include=done,archived');
      const teams = new Map(snapshot.teams.map((t) => [t.teamId, t.name]));
      return snapshot.tasks.map((task): PaletteItem => {
        const status = task.archivedAt === null ? TASK_STATUS_WORDS[task.status] : 'Archived';
        const team = teams.get(task.teamId);
        return {
          id: `task:${task.taskId}`,
          section: 'Tasks',
          label: task.title,
          hint: team === undefined ? status : `${team} · ${status}`,
          href: `/tasks/${encodeURIComponent(task.taskId)}`,
          icon: IconTasks,
        };
      });
    },
  },
  {
    section: 'Cases',
    visible: () => true,
    load: async (read) => {
      const { cases } = await read<{ cases: readonly CaseShape[] }>('/api/mod/cases?limit=50');
      return cases.map((c): PaletteItem => ({
        id: `case:${c.caseId}`,
        section: 'Cases',
        label: `Case ${c.caseId.slice(0, 8)}`,
        hint: c.member?.displayName || c.member?.username || c.memberId,
        href: `/cases/${encodeURIComponent(c.caseId)}`,
        icon: IconCases,
      }));
    },
  },
  {
    section: 'Automod rules',
    visible: () => true,
    load: async (read) => {
      const { rules } = await read<{ rules: readonly RuleSummary[] }>('/api/automod/rules');
      return rules.map((r): PaletteItem => ({
        id: `rule:${r.ruleId}`,
        section: 'Automod rules',
        label: r.name,
        hint: `${RULE_KIND_LABEL[r.kind]} · ${r.enabled ? 'On' : 'Off'}`,
        href: `/automod/${encodeURIComponent(r.ruleId)}`,
        icon: IconAutomod,
      }));
    },
  },
];

/** Field weights: a label match outranks the same match in a hint or keyword. */
const itemScore = (query: string, item: PaletteItem): number => {
  let best = score(query, item.label);
  if (item.hint !== undefined) best = Math.max(best, score(query, item.hint) * 0.6);
  for (const k of item.keywords ?? []) best = Math.max(best, score(query, k) * 0.75);
  return best;
};

/**
 * Filter and order items for display: sections in `SECTION_ORDER`, best score
 * first inside a section (stable, so source order breaks ties), at most
 * `MAX_PER_SECTION` each. The flat result is also the keyboard order.
 */
export const rank = (query: string, items: readonly PaletteItem[]): readonly PaletteItem[] => {
  const out: PaletteItem[] = [];
  for (const section of SECTION_ORDER) {
    const scored = items
      .filter((i) => i.section === section)
      .map((item, order) => ({ item, order, s: itemScore(query, item) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.order - b.order);
    for (const x of scored.slice(0, MAX_PER_SECTION)) out.push(x.item);
  }
  return out;
};
