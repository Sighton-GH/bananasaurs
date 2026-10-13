import { describe, expect, it, vi } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import {
  getTaskDetailsText,
  listTaskRemindersText,
  listTaskTeamsText,
  listTasksText,
} from './tasks.js';
const GUILD = parseGuildId('111111111111111111');
const principal = {
  accountId: 'owner-account',
  scopes: ['bananasaurs:read'],
  reachableGuilds: [GUILD],
};

const taskRow = {
  taskId: 'task',
  teamId: 'team',
  title: '@everyone test',
  status: 'not_started',
  dueAt: 1700000000000,
  assigneeIds: ['666666666666666666'],
};

describe('task MCP read boundary', () => {
  it('returns only the owner-scoped port output and neutralises mentions', () => {
    const list = vi.fn().mockReturnValue({
      teams: [{ teamId: 'team', name: 'Tech' }],
      tasks: [taskRow],
    });
    const teams = vi.fn();
    const result = listTasksText(principal, { list, teams }, { guildId: GUILD });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).not.toContain('@everyone');
    expect(list).toHaveBeenCalledWith(GUILD, principal.accountId, {});
  });
  it('passes team and visibility filters through to the port', () => {
    const list = vi.fn().mockReturnValue({ teams: [], tasks: [] });
    const teams = vi.fn();
    const result = listTasksText(
      principal,
      { list, teams },
      {
        guildId: GUILD,
        teamId: '00000000-0000-4000-8000-000000000000',
        includeDone: true,
        includeArchived: true,
      },
    );
    expect(result.ok).toBe(true);
    expect(list).toHaveBeenCalledWith(GUILD, principal.accountId, {
      teamId: '00000000-0000-4000-8000-000000000000',
      includeDone: true,
      includeArchived: true,
    });
  });
  it('renders assignee ids on each line', () => {
    const list = vi.fn().mockReturnValue({
      teams: [{ teamId: 'team', name: 'Tech' }],
      tasks: [taskRow],
    });
    const teams = vi.fn();
    const result = listTasksText(principal, { list, teams }, { guildId: GUILD });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain('666666666666666666');
  });
  it('rejects unknown keys and bad filter shapes', () => {
    const list = vi.fn();
    const teams = vi.fn();
    expect(
      listTasksText(principal, { list, teams }, { guildId: GUILD, teamId: 'bad-id' }),
    ).toMatchObject({ ok: false });
    expect(
      listTasksText(principal, { list, teams }, { guildId: GUILD, extra: true }),
    ).toMatchObject({ ok: false });
    expect(list).not.toHaveBeenCalled();
  });
  it('refuses an unreachable guild before consulting the port', () => {
    const list = vi.fn();
    const teams = vi.fn();
    expect(
      listTasksText(principal, { list, teams }, { guildId: '222222222222222222' }),
    ).toMatchObject({
      ok: false,
    });
    expect(list).not.toHaveBeenCalled();
  });
  it('does not disclose whether a non-owner has tasks', () => {
    const list = vi.fn().mockReturnValue(undefined);
    const teams = vi.fn();
    expect(listTasksText(principal, { list, teams }, { guildId: GUILD })).toMatchObject({
      ok: false,
    });
  });
});

describe('get_task details with assignees, reminders and archived flag', () => {
  const detail = {
    taskId: 'task',
    teamId: 'team',
    title: 'Measure',
    description: 'desc',
    status: 'not_started',
    priority: 'normal',
    assignmentKind: 'individual',
    assigneeId: '666666666666666666',
    assigneeIds: ['666666666666666666', '777777777777777777'],
    dueAt: 1700000000000,
    timezone: 'America/Vancouver',
    destinationId: '444444444444444444',
    version: 2,
    archived: false,
    children: [],
    reports: [],
    links: [],
    reminders: [
      {
        slotId: 'custom:task:1699999999999',
        kind: 'custom',
        dueAt: 1699999999999,
        state: 'pending',
      },
    ],
  };
  it('returns assignee ids and reminders as JSON', () => {
    const port = { detail: vi.fn().mockReturnValue(detail), reminders: vi.fn() };
    const result = getTaskDetailsText(principal, port, { guildId: GUILD, taskId: UUID() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    expect(parsed['assigneeIds']).toEqual(['666666666666666666', '777777777777777777']);
    expect(parsed['reminders']).toEqual([
      {
        slotId: 'custom:task:1699999999999',
        kind: 'custom',
        dueAt: 1699999999999,
        state: 'pending',
      },
    ]);
    expect(parsed['archived']).toBe(false);
    expect(port.detail).toHaveBeenCalledWith(GUILD, principal.accountId, UUID());
  });
  it('returns links, neutralising mentions in their labels', () => {
    const links = [{ label: '@everyone docs', url: 'https://example.com' }];
    const port = { detail: vi.fn().mockReturnValue({ ...detail, links }), reminders: vi.fn() };
    const result = getTaskDetailsText(principal, port, { guildId: GUILD, taskId: UUID() });
    if (!result.ok) throw new Error('expected ok');
    const parsed = JSON.parse(result.text) as { links: { label: string; url: string }[] };
    expect(parsed.links).toEqual([{ label: ' everyone docs', url: 'https://example.com' }]);
  });
  it('returns archived tasks flagged rather than refusing', () => {
    const port = {
      detail: vi.fn().mockReturnValue({ ...detail, archived: true }),
      reminders: vi.fn(),
    };
    const result = getTaskDetailsText(principal, port, { guildId: GUILD, taskId: UUID() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect((JSON.parse(result.text) as Record<string, unknown>)['archived']).toBe(true);
  });
  it('rejects unknown keys and bad task ids', () => {
    const port = { detail: vi.fn(), reminders: vi.fn() };
    expect(getTaskDetailsText(principal, port, { guildId: GUILD, taskId: 'bad-id' })).toMatchObject(
      { ok: false },
    );
    expect(
      getTaskDetailsText(principal, port, { guildId: GUILD, taskId: UUID(), extra: true }),
    ).toMatchObject({ ok: false });
    expect(port.detail).not.toHaveBeenCalled();
  });
});

describe('task_teams list', () => {
  const view = {
    teams: [
      {
        teamId: 'team',
        name: 'Tech',
        categoryId: '333333333333333333',
        kind: 'subteam',
        announcementChannelId: null,
        leadRoleId: '444444444444444444',
        memberRoleId: '555555555555555555',
        members: [{ discordUserId: '666666666666666666', kind: 'lead' }],
      },
    ],
    presidentRoleId: '777777777777777777',
    quietHours: { startMinute: 0, endMinute: 480, timezone: 'America/Los_Angeles' },
  };
  it('returns teams, members, president role and quiet hours as JSON', () => {
    const teams = vi.fn().mockReturnValue(view);
    const result = listTaskTeamsText(principal, { list: vi.fn(), teams }, { guildId: GUILD });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    expect(parsed['presidentRoleId']).toBe('777777777777777777');
    expect(JSON.stringify(parsed)).toContain('555555555555555555');
    expect(teams).toHaveBeenCalledWith(GUILD, principal.accountId);
    expect(result.itemCount).toBe(1);
  });
  it('refuses unknown keys, unreachable guilds and non-owner ports', () => {
    const teams = vi.fn();
    expect(
      listTaskTeamsText(principal, { list: vi.fn(), teams }, { guildId: GUILD, extra: true }),
    ).toMatchObject({ ok: false });
    expect(
      listTaskTeamsText(principal, { list: vi.fn(), teams }, { guildId: '222222222222222222' }),
    ).toMatchObject({ ok: false });
    const refusing = vi.fn().mockReturnValue(undefined);
    expect(
      listTaskTeamsText(principal, { list: vi.fn(), teams: refusing }, { guildId: GUILD }),
    ).toMatchObject({ ok: false });
    expect(teams).not.toHaveBeenCalled();
  });
});

describe('get_task reminders', () => {
  it('returns the task slots as JSON', () => {
    const reminders = vi.fn().mockReturnValue([
      {
        slotId: 'custom:task:1699999999999',
        kind: 'custom',
        dueAt: 1699999999999,
        state: 'pending',
      },
    ]);
    const result = listTaskRemindersText(
      principal,
      { detail: vi.fn(), reminders },
      { guildId: GUILD, taskId: UUID() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(JSON.parse(result.text)).toEqual([
      {
        slotId: 'custom:task:1699999999999',
        kind: 'custom',
        dueAt: 1699999999999,
        state: 'pending',
      },
    ]);
    expect(reminders).toHaveBeenCalledWith(GUILD, principal.accountId, UUID());
    expect(result.itemCount).toBe(1);
  });
  it('rejects unknown keys, bad task ids and non-owner ports', () => {
    const reminders = vi.fn();
    expect(
      listTaskRemindersText(
        principal,
        { detail: vi.fn(), reminders },
        { guildId: GUILD, taskId: 'bad' },
      ),
    ).toMatchObject({ ok: false });
    expect(
      listTaskRemindersText(
        principal,
        { detail: vi.fn(), reminders },
        { guildId: GUILD, taskId: UUID(), extra: true },
      ),
    ).toMatchObject({ ok: false });
    const refusing = vi.fn().mockReturnValue(undefined);
    expect(
      listTaskRemindersText(
        principal,
        { detail: vi.fn(), reminders: refusing },
        { guildId: GUILD, taskId: UUID() },
      ),
    ).toMatchObject({ ok: false });
    expect(reminders).not.toHaveBeenCalled();
  });
});

const UUID = () => '00000000-0000-4000-8000-000000000000';
