import { describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../api.js';
import { NAV, visibleNav } from './routes.js';
import { PALETTE_SOURCES, memberItem, rank, staticItems } from './palette-sources.js';

const BASE: SessionInfo = {
  authenticated: true,
  accountId: 'acct-1',
  guildId: '1540816150026518620',
  csrfToken: 'csrf-test',
  expiresAt: 4102444800000,
  reauthFresh: true,
  readonly: false,
};
const info = (extra: Partial<SessionInfo> = {}): SessionInfo => ({ ...BASE, ...extra });
const owner = info({ instanceOwner: true });
const plain = info({ instanceOwner: false, canManageTasks: false });
const taskOnly = info({ instanceOwner: false, canManageTasks: true });
const labels = (items: readonly { label: string }[]) => items.map((i) => i.label);
const source = (section: string) => {
  const s = PALETTE_SOURCES.find((p) => p.section === section);
  if (s === undefined) throw new Error(`no source ${section}`);
  return s;
};

describe('staticItems', () => {
  it('has no task or owner entries for a plain account', () => {
    const items = staticItems(plain);
    expect(labels(items)).not.toContain('New task');
    expect(labels(items)).not.toContain('Tasks');
    expect(labels(items)).not.toContain('Open the UI kit');
    expect(labels(items)).not.toContain('New account');
    expect(items.some((i) => i.href === '/tasks' || i.href === '/kit')).toBe(false);
  });
  it('offers task actions to a task manager but not owner ones', () => {
    const items = staticItems(taskOnly);
    expect(labels(items)).toContain('New task');
    expect(labels(items)).toContain('Tasks');
    expect(labels(items)).not.toContain('New account');
    expect(labels(items)).not.toContain('Open the UI kit');
  });
  it('lists exactly the visible nav pages, with keywords, and no hidden ones', () => {
    for (const who of [owner, plain, taskOnly]) {
      const pages = staticItems(who).filter((i) => i.section === 'Pages');
      const nav = visibleNav(who.instanceOwner === true, who.canManageTasks === true);
      expect(pages.map((p) => p.href)).toEqual(nav.map((n) => n.path));
      expect(pages.map((p) => p.label)).toEqual(nav.map((n) => n.label));
    }
    const safety = staticItems(owner).find((i) => i.href === '/safety' && i.section === 'Pages');
    expect(safety?.keywords).toEqual(NAV.find((n) => n.path === '/safety')?.keywords);
  });
  it('offers the specified actions to the owner, each navigating', () => {
    const actions = staticItems(owner).filter((i) => i.section === 'Actions');
    expect(actions.map((a) => [a.label, a.href])).toEqual([
      ['New task', '/tasks/new'],
      ['New automod rule', '/automod'],
      ['New account', '/accounts/new'],
      ['Kill switch', '/safety'],
      ['Run Doctor', '/doctor'],
      ['Open the UI kit', '/kit'],
    ]);
    expect(actions.find((a) => a.label === 'Kill switch')?.hint).toBe('Opens Safety');
  });
  it('gives every item a stable unique id and an icon', () => {
    const items = staticItems(owner);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    for (const i of items) expect(i.icon).toBeTruthy();
  });
});

describe('memberItem', () => {
  it('ignores short or non-numeric queries', () => {
    expect(memberItem('123')).toBeUndefined();
    expect(memberItem('abc')).toBeUndefined();
    expect(memberItem('1'.repeat(16))).toBeUndefined();
    expect(memberItem('1'.repeat(21))).toBeUndefined();
    expect(memberItem('3333333333333333a')).toBeUndefined();
  });
  it('maps a 17-20 digit id', () => {
    for (const n of [17, 18, 20]) {
      const id = '3'.repeat(n);
      const item = memberItem(` ${id} `);
      expect(item?.href).toBe(`/members/${id}`);
      expect(item?.label).toBe(`Open member ${id}`);
      expect(item?.section).toBe('Members');
    }
  });
});

describe('sources', () => {
  it('only the owner and task managers see the Tasks source', () => {
    expect(source('Tasks').visible(owner)).toBe(true);
    expect(source('Tasks').visible(taskOnly)).toBe(true);
    expect(source('Tasks').visible(plain)).toBe(false);
    expect(source('Cases').visible(plain)).toBe(true);
    expect(source('Automod rules').visible(plain)).toBe(true);
  });
  it('maps tasks with team name and status in words', async () => {
    const read = vi.fn().mockResolvedValue({
      teams: [{ teamId: 't1', name: 'Robotics', kind: 'subteam', categoryId: 'c' }],
      tasks: [
        {
          taskId: 'k1',
          title: 'Order servos',
          teamId: 't1',
          status: 'awaiting_approval',
          archivedAt: null,
        },
        { taskId: 'k2', title: 'Old thing', teamId: 'gone', status: 'done', archivedAt: 5 },
      ],
      presidentRoleId: null,
    });
    const items = await source('Tasks').load(read);
    expect(read).toHaveBeenCalledWith('/api/tasks?include=done,archived');
    expect(items[0]).toMatchObject({
      id: 'task:k1',
      section: 'Tasks',
      label: 'Order servos',
      hint: 'Robotics · Awaiting approval',
      href: '/tasks/k1',
    });
    expect(items[1]?.hint).toBe('Archived');
  });
  it('maps cases to Case <8 of id> with member name or id', async () => {
    const read = vi.fn().mockResolvedValue({
      cases: [
        {
          caseId: 'abcdefgh-1234',
          memberId: '111',
          status: 'open',
          member: { username: 'u', displayName: 'Dana' },
        },
        { caseId: 'zzzzzzzz-9', memberId: '222', status: 'closed', member: null },
      ],
    });
    const items = await source('Cases').load(read);
    expect(read).toHaveBeenCalledWith('/api/mod/cases?limit=50');
    expect(items.map((i) => [i.id, i.label, i.hint, i.href])).toEqual([
      ['case:abcdefgh-1234', 'Case abcdefgh', 'Dana', '/cases/abcdefgh-1234'],
      ['case:zzzzzzzz-9', 'Case zzzzzzzz', '222', '/cases/zzzzzzzz-9'],
    ]);
  });
  it('maps rules to name, kind in words and On/Off', async () => {
    const read = vi.fn().mockResolvedValue({
      rules: [
        { ruleId: 'r1', kind: 'keyword_filter', name: 'No spam', enabled: true },
        { ruleId: 'r2', kind: 'mention_spam', name: 'Mentions', enabled: false },
      ],
    });
    const items = await source('Automod rules').load(read);
    expect(read).toHaveBeenCalledWith('/api/automod/rules');
    expect(items.map((i) => [i.label, i.hint, i.href])).toEqual([
      ['No spam', 'Keyword filter · On', '/automod/r1'],
      ['Mentions', 'Mention spam · Off', '/automod/r2'],
    ]);
  });
  it('propagates a failed read', async () => {
    await expect(source('Cases').load(() => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
  });
});

describe('rank', () => {
  const items = staticItems(owner);
  it('puts the exact page first for a short query despite action matches', () => {
    const extra = [
      ...items,
      {
        id: 'task:1',
        section: 'Tasks' as const,
        label: 'Task budget',
        href: '/tasks/1',
        icon: items[0]!.icon,
      },
    ];
    expect(rank('task', extra)[0]?.href).toBe('/tasks');
  });
  it('caps each section at 8 and breaks ties by section then source order', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `case:${i}`,
      section: 'Cases' as const,
      label: `Case ${i}`,
      href: `/cases/${i}`,
      icon: items[0]!.icon,
    }));
    const out = rank('', many);
    expect(out).toHaveLength(8);
    expect(out.map((i) => i.id)).toEqual(many.slice(0, 8).map((i) => i.id));
  });
  it('scores hint and keywords without beating a label match', () => {
    const base = { section: 'Pages' as const, icon: items[0]!.icon };
    const byHint = { ...base, id: 'a', label: 'Zeta', hint: 'alpha', href: '/a' };
    const byLabel = { ...base, id: 'b', label: 'Alpha', href: '/b' };
    const byKeyword = { ...base, id: 'c', label: 'Other', keywords: ['alpha'], href: '/c' };
    const out = rank('alpha', [byHint, byKeyword, byLabel]);
    expect(out.map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });
  it('keeps long items matched and positive', () => {
    const long = {
      id: 'long',
      section: 'Tasks' as const,
      label: 'q'.repeat(200) + ' roadmap',
      hint: 'h'.repeat(175),
      keywords: ['k'.repeat(300)],
      href: '/tasks/long',
      icon: items[0]!.icon,
    };
    expect(rank('roadmap', [long])).toHaveLength(1);
    expect(rank('hhh', [long])).toHaveLength(1);
    expect(rank('kkk', [long])).toHaveLength(1);
  });
  it('drops non-matches', () => expect(rank('qqqqzz', items)).toEqual([]));
});

describe('href encoding', () => {
  it('encodes interpolated ids and leaves valid ids unchanged', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        teams: [],
        tasks: [
          { taskId: 'a/b c?', title: 'T', teamId: 't', status: 'in_progress', archivedAt: null },
        ],
        presidentRoleId: null,
      })
      .mockResolvedValueOnce({
        cases: [{ caseId: 'c/1#x', memberId: '1', status: 'open', member: null }],
      })
      .mockResolvedValueOnce({
        rules: [{ ruleId: 'r/1 2', kind: 'keyword_filter', name: 'R', enabled: true }],
      });
    expect((await source('Tasks').load(read))[0]?.href).toBe('/tasks/a%2Fb%20c%3F');
    expect((await source('Cases').load(read))[0]?.href).toBe('/cases/c%2F1%23x');
    expect((await source('Automod rules').load(read))[0]?.href).toBe('/automod/r%2F1%202');
    expect(memberItem('1540816150026518620')?.href).toBe('/members/1540816150026518620');
  });
});
