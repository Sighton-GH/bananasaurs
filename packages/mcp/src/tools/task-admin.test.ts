import { describe, expect, it, vi } from 'vitest';
import { INVALID_ARGUMENTS_MESSAGE } from '../scope.js';
import { parseGuildId } from '@bananasaurs/core';
import {
  runTaskAdmin,
  taskAdminTools,
  type TaskAdminName,
  type TaskAdminPort,
} from './task-admin.js';
const GUILD = parseGuildId('111111111111111111');
const OTHER = parseGuildId('222222222222222222');
const principal = { accountId: 'owner', scopes: ['bananasaurs:send'], reachableGuilds: [GUILD] };
const port = () => {
  const execute = vi.fn().mockResolvedValue({ ok: true, text: 'stored' });
  return { admin: { execute } as TaskAdminPort, execute };
};

const UUID_A = '00000000-0000-4000-8000-000000000000';
const UUID_B = '00000000-0000-4000-8000-000000000001';
const SNOW = '333333333333333333';
const DUE = 1_800_000_000_000;
const TZ = 'America/Vancouver';

const validArgs: Record<TaskAdminName, Record<string, unknown>> = {
  create_task_team: { guildId: GUILD, name: 'Tech', categoryId: SNOW, kind: 'subteam' },
  configure_task_team: { guildId: GUILD, teamId: UUID_A },
  delete_task_team: { guildId: GUILD, teamId: UUID_A },
  set_task_president_role: { guildId: GUILD, roleId: SNOW },
  clear_task_president_role: { guildId: GUILD },
  add_task_team_member: { guildId: GUILD, teamId: UUID_A, discordUserId: SNOW, kind: 'member' },
  remove_task_team_member: { guildId: GUILD, teamId: UUID_A, discordUserId: SNOW },
  create_club_task: {
    guildId: GUILD,
    teamId: UUID_A,
    title: 'Measure chassis',
    assignmentKind: 'team',
    dueAt: DUE,
    timezone: TZ,
    destinationId: SNOW,
    requestId: 'create-request-1',
  },
  edit_club_task: {
    guildId: GUILD,
    taskId: UUID_A,
    expectedVersion: 1,
    title: 'Measure chassis',
    assignmentKind: 'team',
    dueAt: DUE,
    timezone: TZ,
    destinationId: SNOW,
  },
  append_task_child: {
    guildId: GUILD,
    taskId: UUID_A,
    expectedVersion: 1,
    title: 'Step',
    dueAt: DUE,
  },
  edit_task_child: {
    guildId: GUILD,
    taskId: UUID_A,
    expectedVersion: 2,
    childId: UUID_B,
    title: 'Step',
    dueAt: DUE,
  },
  complete_task_child: { guildId: GUILD, taskId: UUID_A, expectedVersion: 2, childId: UUID_B },
  delete_task_child: { guildId: GUILD, taskId: UUID_A, expectedVersion: 2, childId: UUID_B },
  record_task_progress: { guildId: GUILD, taskId: UUID_A, body: 'Measured', requestId: UUID_B },
  delete_task_report: { guildId: GUILD, taskId: UUID_A, reportId: 'report-1' },
  request_task_completion: { guildId: GUILD, taskId: UUID_A, expectedVersion: 3 },
  approve_task_completion: { guildId: GUILD, taskId: UUID_A, expectedVersion: 4 },
  reject_task_completion: { guildId: GUILD, taskId: UUID_A, expectedVersion: 4 },
  set_task_status: { guildId: GUILD, taskId: UUID_A, expectedVersion: 4, status: 'in_progress' },
  archive_task: { guildId: GUILD, taskId: UUID_A, expectedVersion: 4 },
  unarchive_task: { guildId: GUILD, taskId: UUID_A, expectedVersion: 5 },
  delete_club_task: { guildId: GUILD, taskId: UUID_A, expectedVersion: 5 },
  add_task_reminder: { guildId: GUILD, taskId: UUID_A, at: DUE },
  cancel_task_reminder: { guildId: GUILD, taskId: UUID_A, slotId: `custom:${UUID_A}:${DUE}` },
  configure_task_quiet_hours: {
    guildId: GUILD,
    startMinute: 60,
    endMinute: 480,
    timezone: TZ,
  },
};

/** First uuid- or snowflake-shaped field of the valid args, for the bad-id probe. */
const badIdField = (name: TaskAdminName): string => {
  const args = validArgs[name];
  for (const key of ['taskId', 'teamId', 'childId', 'requestId']) if (key in args) return key;
  for (const key of [
    'roleId',
    'discordUserId',
    'categoryId',
    'announcementChannelId',
    'leadRoleId',
    'memberRoleId',
    'assigneeId',
    'destinationId',
  ])
    if (key in args) return key;
  return 'guildId';
};

describe('MCP task admin boundary', () => {
  it('refuses an unreachable guild without invoking a write port', async () => {
    const { admin, execute } = port();
    const outcome = await runTaskAdmin(principal, admin, 'set_task_president_role', {
      guildId: OTHER,
      roleId: '333333333333333333',
    });
    expect(outcome.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects malformed, extra and missing arguments before consulting the port', async () => {
    const { admin, execute } = port();
    for (const raw of [
      { guildId: GUILD, roleId: 'bad-id' },
      { guildId: GUILD, roleId: '333333333333333333', actorId: 'attacker' },
      { guildId: GUILD },
    ])
      expect((await runTaskAdmin(principal, admin, 'set_task_president_role', raw)).ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it('passes only the authenticated account ID, scoped guild and validated arguments', async () => {
    const { admin, execute } = port();
    const outcome = await runTaskAdmin(principal, admin, 'request_task_completion', {
      guildId: GUILD,
      taskId: '00000000-0000-4000-8000-000000000000',
      expectedVersion: 3,
    });
    expect(outcome).toEqual({ ok: true, text: 'stored' });
    expect(execute).toHaveBeenCalledWith(GUILD, 'owner', 'request_task_completion', {
      guildId: GUILD,
      taskId: '00000000-0000-4000-8000-000000000000',
      expectedVersion: 3,
    });
  });
  it('rejects equal quiet hours rather than silently setting all-day quiet', async () => {
    const { admin, execute } = port();
    const outcome = await runTaskAdmin(principal, admin, 'configure_task_quiet_hours', {
      guildId: GUILD,
      startMinute: 480,
      endMinute: 480,
      timezone: 'America/Los_Angeles',
    });
    expect(outcome.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('MCP task admin params for every tool', () => {
  const names = Object.keys(taskAdminTools) as TaskAdminName[];
  it('covers the full write surface', () => {
    expect(names).toEqual([
      'create_task_team',
      'configure_task_team',
      'delete_task_team',
      'set_task_president_role',
      'clear_task_president_role',
      'add_task_team_member',
      'remove_task_team_member',
      'create_club_task',
      'edit_club_task',
      'append_task_child',
      'edit_task_child',
      'complete_task_child',
      'delete_task_child',
      'record_task_progress',
      'delete_task_report',
      'request_task_completion',
      'approve_task_completion',
      'reject_task_completion',
      'set_task_status',
      'archive_task',
      'unarchive_task',
      'delete_club_task',
      'add_task_reminder',
      'cancel_task_reminder',
      'configure_task_quiet_hours',
    ]);
  });
  it.each(Object.keys(taskAdminTools) as TaskAdminName[])(
    '%s rejects an unknown key',
    async (name) => {
      const { admin, execute } = port();
      const outcome = await runTaskAdmin(principal, admin, name, {
        ...validArgs[name],
        unknownKey: 'nope',
      });
      expect(outcome.ok).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it.each(Object.keys(taskAdminTools) as TaskAdminName[])('%s rejects a bad id', async (name) => {
    const { admin, execute } = port();
    const outcome = await runTaskAdmin(principal, admin, name, {
      ...validArgs[name],
      [badIdField(name)]: 'bad-id',
    });
    expect(outcome.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(
    (Object.keys(taskAdminTools) as TaskAdminName[]).filter(
      (name) => 'timezone' in validArgs[name],
    ),
  )('%s rejects timezone Pacific Time', async (name) => {
    const { admin, execute } = port();
    const outcome = await runTaskAdmin(principal, admin, name, {
      ...validArgs[name],
      timezone: 'Pacific Time',
    });
    expect(outcome.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it('approve_task_completion passes validation and reaches the port', async () => {
    const { admin, execute } = port();
    const outcome = await runTaskAdmin(principal, admin, 'approve_task_completion', {
      guildId: GUILD,
      taskId: UUID_A,
      expectedVersion: 4,
    });
    expect(outcome).toEqual({ ok: true, text: 'stored' });
    expect(execute).toHaveBeenCalledWith(GUILD, 'owner', 'approve_task_completion', {
      guildId: GUILD,
      taskId: UUID_A,
      expectedVersion: 4,
    });
  });
  it('create_club_task refuses a non-https link and passes https links to the port', async () => {
    const { admin, execute } = port();
    const bad = await runTaskAdmin(principal, admin, 'create_club_task', {
      ...validArgs['create_club_task'],
      links: [{ label: 'Docs', url: 'http://x.example' }],
    });
    expect(bad).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(execute).not.toHaveBeenCalled();
    const links = [{ label: 'Docs', url: 'https://x.example' }];
    const ok = await runTaskAdmin(principal, admin, 'create_club_task', {
      ...validArgs['create_club_task'],
      links,
    });
    expect(ok.ok).toBe(true);
    expect(execute.mock.calls[0]?.[3]).toMatchObject({ links });
  });
  it('create_club_task requires requestId', async () => {
    const { admin, execute } = port();
    const base = { ...validArgs.create_club_task };
    delete base.requestId;
    expect((await runTaskAdmin(principal, admin, 'create_club_task', base)).ok).toBe(false);
    expect(
      (
        await runTaskAdmin(principal, admin, 'create_club_task', {
          ...validArgs.create_club_task,
          requestId: 'short',
        })
      ).ok,
    ).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    const outcome = await runTaskAdmin(
      principal,
      admin,
      'create_club_task',
      validArgs.create_club_task,
    );
    expect(outcome).toEqual({ ok: true, text: 'stored' });
    expect(execute).toHaveBeenCalledWith(GUILD, 'owner', 'create_club_task', {
      ...validArgs.create_club_task,
      priority: 'normal',
    });
  });
  it('record_task_progress requires requestId', async () => {
    const { admin, execute } = port();
    const missing = await runTaskAdmin(principal, admin, 'record_task_progress', {
      guildId: GUILD,
      taskId: UUID_A,
      body: 'Measured',
    });
    expect(missing.ok).toBe(false);
    const bad = await runTaskAdmin(principal, admin, 'record_task_progress', {
      guildId: GUILD,
      taskId: UUID_A,
      body: 'Measured',
      requestId: 'not-a-uuid',
    });
    expect(bad.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    const outcome = await runTaskAdmin(principal, admin, 'record_task_progress', {
      guildId: GUILD,
      taskId: UUID_A,
      body: 'Measured',
      requestId: UUID_B,
    });
    expect(outcome).toEqual({ ok: true, text: 'stored' });
    expect(execute).toHaveBeenCalledWith(GUILD, 'owner', 'record_task_progress', {
      guildId: GUILD,
      taskId: UUID_A,
      body: 'Measured',
      requestId: UUID_B,
    });
  });
});
