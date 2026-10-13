import { describe, expect, it } from 'vitest';
import * as icons from '../ui/icons.js';
import { activeNavPath, GROUPS, NAV, pageTitle, visibleNav } from './routes.js';

/**
 * P4 Task 1: the rail is regrouped by what people do (plan Decision 1). This
 * table is the machine-checkable copy of that decision: exact group order,
 * labels, icons and flags, checked against the real NAV in one assertion.
 */
const EXPECTED: readonly (readonly [
  path: string,
  label: string,
  group: string,
  iconRole: keyof typeof icons,
])[] = [
  ['/', 'Overview', 'Club', 'IconOverview'],
  ['/tasks', 'Tasks', 'Club', 'IconTasks'],
  ['/panels', 'Role panels', 'Club', 'IconPanels'],
  ['/assistant/schedules', 'Schedules', 'Club', 'IconSchedules'],
  ['/docs', 'Guide', 'Club', 'IconGuide'],
  ['/automod', 'Automod', 'Moderation', 'IconAutomod'],
  ['/review', 'Review queue', 'Moderation', 'IconReview'],
  ['/cases', 'Cases', 'Moderation', 'IconCases'],
  ['/members', 'Members', 'Moderation', 'IconMembers'],
  ['/logging', 'Logging', 'Moderation', 'IconLogging'],
  ['/safety', 'Safety', 'Moderation', 'IconSafety'],
  ['/permissions', 'Permissions', 'Moderation', 'IconPermissions'],
  ['/assistant/setup', 'AI setup', 'Assistant', 'IconAiSetup'],
  ['/assistant/tuning', 'AI tuning', 'Assistant', 'IconTuning'],
  ['/assistant', 'Behaviours', 'Assistant', 'IconBehaviours'],
  ['/assistant/conversations', 'Conversations', 'Assistant', 'IconConversations'],
  ['/assistant/history', 'History', 'Assistant', 'IconHistory'],
  ['/assistant/skills', 'Skills', 'Assistant', 'IconSkills'],
  ['/assistant/resources', 'Resources', 'Assistant', 'IconResources'],
  ['/memory', 'Memory', 'Assistant', 'IconMemory'],
  ['/archive', 'Archive', 'Messages', 'IconArchive'],
  ['/search', 'Search', 'Messages', 'IconSearchPage'],
  ['/jobs', 'Background tasks', 'System', 'IconJobs'],
  ['/audit', 'Audit log', 'System', 'IconAudit'],
  ['/doctor', 'Doctor', 'System', 'IconDoctor'],
  ['/backups', 'Backups', 'System', 'IconBackups'],
  ['/config', 'Configuration', 'System', 'IconConfig'],
  ['/accounts', 'Accounts', 'System', 'IconAccounts'],
  ['/mcp', 'Connected apps', 'System', 'IconConnectedApps'],
];

describe('NAV (P4 Task 1 Decision 1)', () => {
  it('lists the five groups in the plan order', () => {
    expect(GROUPS).toEqual(['Club', 'Moderation', 'Assistant', 'Messages', 'System']);
  });

  it('matches the plan table exactly: path, label, group and icon, in order', () => {
    expect(NAV.map((entry) => [entry.path, entry.label, entry.group])).toEqual(
      EXPECTED.map(([path, label, group]) => [path, label, group]),
    );
    for (const [i, [, , , iconRole]] of EXPECTED.entries()) {
      expect(NAV[i]!.icon, `${NAV[i]!.path} icon`).toBe(icons[iconRole]);
    }
  });

  it('has each path exactly once, an icon on every entry and no empty group', () => {
    expect(new Set(NAV.map((entry) => entry.path)).size).toBe(NAV.length);
    // lucide-react components are exotic (memo) objects, so identity with
    // the role alias in the table above is the icon check; this guards a
    // missing/undefined icon.
    for (const entry of NAV) expect(entry.icon, entry.path).toBeTruthy();
    for (const group of GROUPS) {
      expect(
        NAV.some((entry) => entry.group === group),
        group,
      ).toBe(true);
    }
  });

  it('keeps the flags exactly: Tasks ownerOnly + taskAccess, AI tuning ownerOnly, nothing else', () => {
    const flagged = NAV.filter((entry) => entry.ownerOnly === true || entry.taskAccess === true);
    expect(flagged.map((entry) => entry.path)).toEqual(['/tasks', '/assistant/tuning']);
    const tasks = NAV.find((entry) => entry.path === '/tasks')!;
    expect(tasks.ownerOnly).toBe(true);
    expect(tasks.taskAccess).toBe(true);
    const tuning = NAV.find((entry) => entry.path === '/assistant/tuning')!;
    expect(tuning.ownerOnly).toBe(true);
    expect(tuning.taskAccess).toBeUndefined();
  });

  it('carries palette keywords on Safety only', () => {
    expect(NAV.find((entry) => entry.path === '/safety')?.keywords).toEqual([
      'kill switch',
      'dry run',
      'breaker',
    ]);
    for (const entry of NAV) {
      if (entry.path !== '/safety') expect(entry.keywords, entry.path).toBeUndefined();
    }
  });

  it('drops the stub status field entirely', () => {
    for (const entry of NAV) expect('status' in entry, entry.path).toBe(false);
  });
});

describe('activeNavPath', () => {
  it.each([
    ['/', '/'],
    ['/tasks', '/tasks'],
    ['/tasks/abc', '/tasks'],
    ['/automod/rule-1', '/automod'],
    ['/assistant/history/trace-1', '/assistant/history'],
    ['/assistant/conversations/9', '/assistant/conversations'],
    ['/assistant', '/assistant'],
    ['/cases/42', '/cases'],
  ])('maps %s to %s', (location, expected) => {
    expect(activeNavPath(location)).toBe(expected);
  });

  it('matches the longest path on a slash boundary, never a bare prefix', () => {
    // /assistant/history/id must not resolve to plain /assistant.
    expect(activeNavPath('/assistant/history/x')).toBe('/assistant/history');
    expect(activeNavPath('/tasksXYZ')).toBeUndefined();
    expect(activeNavPath('/archivex')).toBeUndefined();
    expect(activeNavPath('/nope')).toBeUndefined();
  });

  it('treats the root as exact only, so unknown roots are not Overview', () => {
    expect(activeNavPath('/')).toBe('/');
    expect(activeNavPath('/nope')).toBeUndefined();
  });
});

describe('pageTitle', () => {
  it('consumes activeNavPath: the same longest-prefix rule names the tab', () => {
    expect(pageTitle('/')).toBe('Overview');
    expect(pageTitle('/tasks/abc')).toBe('Tasks');
    expect(pageTitle('/assistant/history/x')).toBe('History');
    expect(pageTitle('/assistant')).toBe('Behaviours');
    expect(pageTitle('/nope')).toBeUndefined();
    expect(pageTitle('/tasksXYZ')).toBeUndefined();
  });
});

describe('visibleNav', () => {
  it('shows the owner all 29 entries', () => {
    expect(visibleNav(true)).toHaveLength(29);
    expect(visibleNav(true, true)).toHaveLength(29);
  });

  it('hides Tasks and AI tuning from a non-owner without task access', () => {
    const entries = visibleNav(false);
    expect(entries).toHaveLength(27);
    expect(entries.some((entry) => entry.path === '/tasks')).toBe(false);
    expect(entries.some((entry) => entry.path === '/assistant/tuning')).toBe(false);
  });

  it('shows Tasks, and only Tasks of the flagged entries, with task access (ADR 0130)', () => {
    const entries = visibleNav(false, true);
    expect(entries).toHaveLength(28);
    expect(entries.some((entry) => entry.path === '/tasks')).toBe(true);
    expect(entries.some((entry) => entry.path === '/assistant/tuning')).toBe(false);
  });
});
