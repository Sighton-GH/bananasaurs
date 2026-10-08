import { describe, expect, it, vi } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { GUILD_REFUSAL_MESSAGE, INVALID_ARGUMENTS_MESSAGE } from '../scope.js';
import {
  CREATE_TASK_TOOL_NAME,
  DELETE_TASK_TOOL_NAME,
  GET_TASK_READ_ACTION,
  GET_TASK_TOOL_NAME,
  TASK_PROGRESS_ACTIONS,
  TASK_REMINDERS_ACTIONS,
  TASK_SCOPE_REFUSAL_MESSAGE,
  TASK_SETTINGS_ACTIONS,
  TASK_STEPS_ACTIONS,
  TASK_TEAMS_ACTIONS,
  TASK_TEAMS_TOOL_NAME,
  UPDATE_TASK_ACTIONS,
  getTaskText,
  runCreateTask,
  runDeleteTask,
  runTaskProgress,
  runTaskReminders,
  runTaskSettings,
  runTaskSteps,
  runTaskTeams,
  runUpdateTask,
} from './task-tools.js';
import { getTaskDetailsText, listTaskRemindersText, listTaskTeamsText } from './tasks.js';
import type { TaskAdminPort } from './task-admin.js';

const GUILD = parseGuildId('111111111111111111');
const UUID_A = '00000000-0000-4000-8000-000000000000';
const UUID_B = '00000000-0000-4000-8000-000000000001';
const SNOW = '333333333333333333';
const DUE = 1_800_000_000_000;
const TZ = 'America/Vancouver';

const tasksPrincipal = {
  accountId: 'owner',
  scopes: ['bananasaurs:tasks'],
  reachableGuilds: [GUILD],
};
const readPrincipal = {
  accountId: 'owner',
  scopes: ['bananasaurs:read'],
  reachableGuilds: [GUILD],
};

const adminPort = () => {
  const execute = vi.fn().mockResolvedValue({ ok: true, text: 'stored' });
  return { admin: { execute } as TaskAdminPort, execute };
};

const versioned = { guildId: GUILD, taskId: UUID_A, expectedVersion: 1 };

describe('consolidated task write routing', () => {
  const cases: ReadonlyArray<{
    readonly tool: string;
    readonly run: (
      principal: typeof tasksPrincipal,
      port: TaskAdminPort,
      raw: unknown,
    ) => Promise<{ readonly ok: boolean } & Record<string, unknown>>;
    readonly action: string;
    readonly name: string;
    readonly args: Record<string, unknown>;
  }> = [
    {
      tool: CREATE_TASK_TOOL_NAME,
      run: runCreateTask,
      action: '(none)',
      name: 'create_club_task',
      args: {
        guildId: GUILD,
        teamId: UUID_A,
        title: 'Measure chassis',
        priority: 'normal',
        assignmentKind: 'team',
        dueAt: DUE,
        timezone: TZ,
        destinationId: SNOW,
        requestId: 'create-request-1',
      },
    },
    {
      tool: DELETE_TASK_TOOL_NAME,
      run: runDeleteTask,
      action: '(none)',
      name: 'delete_club_task',
      args: { ...versioned },
    },
    {
      tool: 'update_task/edit',
      run: runUpdateTask,
      action: 'edit',
      name: UPDATE_TASK_ACTIONS.edit,
      args: {
        ...versioned,
        title: 'Measure chassis',
        priority: 'normal',
        assignmentKind: 'team',
        dueAt: DUE,
        timezone: TZ,
        destinationId: SNOW,
      },
    },
    {
      tool: 'update_task/set_status',
      run: runUpdateTask,
      action: 'set_status',
      name: UPDATE_TASK_ACTIONS.set_status,
      args: { ...versioned, status: 'in_progress' },
    },
    {
      tool: 'update_task/request_completion',
      run: runUpdateTask,
      action: 'request_completion',
      name: UPDATE_TASK_ACTIONS.request_completion,
      args: { ...versioned },
    },
    {
      tool: 'update_task/approve_completion',
      run: runUpdateTask,
      action: 'approve_completion',
      name: UPDATE_TASK_ACTIONS.approve_completion,
      args: { ...versioned },
    },
    {
      tool: 'update_task/reject_completion',
      run: runUpdateTask,
      action: 'reject_completion',
      name: UPDATE_TASK_ACTIONS.reject_completion,
      args: { ...versioned },
    },
    {
      tool: 'update_task/archive',
      run: runUpdateTask,
      action: 'archive',
      name: UPDATE_TASK_ACTIONS.archive,
      args: { ...versioned },
    },
    {
      tool: 'update_task/unarchive',
      run: runUpdateTask,
      action: 'unarchive',
      name: UPDATE_TASK_ACTIONS.unarchive,
      args: { ...versioned },
    },
    {
      tool: 'task_steps/add',
      run: runTaskSteps,
      action: 'add',
      name: TASK_STEPS_ACTIONS.add,
      args: { ...versioned, title: 'Step', dueAt: DUE },
    },
    {
      tool: 'task_steps/edit',
      run: runTaskSteps,
      action: 'edit',
      name: TASK_STEPS_ACTIONS.edit,
      args: { ...versioned, childId: UUID_B, title: 'Step', dueAt: DUE },
    },
    {
      tool: 'task_steps/complete',
      run: runTaskSteps,
      action: 'complete',
      name: TASK_STEPS_ACTIONS.complete,
      args: { ...versioned, childId: UUID_B },
    },
    {
      tool: 'task_steps/delete',
      run: runTaskSteps,
      action: 'delete',
      name: TASK_STEPS_ACTIONS.delete,
      args: { ...versioned, childId: UUID_B },
    },
    {
      tool: 'task_reminders/add',
      run: runTaskReminders,
      action: 'add',
      name: TASK_REMINDERS_ACTIONS.add,
      args: { guildId: GUILD, taskId: UUID_A, at: DUE },
    },
    {
      tool: 'task_reminders/cancel',
      run: runTaskReminders,
      action: 'cancel',
      name: TASK_REMINDERS_ACTIONS.cancel,
      args: { guildId: GUILD, taskId: UUID_A, slotId: `custom:${UUID_A}:${DUE}` },
    },
    {
      tool: 'task_progress/record',
      run: runTaskProgress,
      action: 'record',
      name: TASK_PROGRESS_ACTIONS.record,
      args: { guildId: GUILD, taskId: UUID_A, body: 'Measured', requestId: UUID_B },
    },
    {
      tool: 'task_progress/delete_report',
      run: runTaskProgress,
      action: 'delete_report',
      name: TASK_PROGRESS_ACTIONS.delete_report,
      args: { guildId: GUILD, taskId: UUID_A, reportId: 'report-1' },
    },
    {
      tool: 'task_settings/set_president_role',
      run: runTaskSettings,
      action: 'set_president_role',
      name: TASK_SETTINGS_ACTIONS.set_president_role,
      args: { guildId: GUILD, roleId: SNOW },
    },
    {
      tool: 'task_settings/clear_president_role',
      run: runTaskSettings,
      action: 'clear_president_role',
      name: TASK_SETTINGS_ACTIONS.clear_president_role,
      args: { guildId: GUILD },
    },
    {
      tool: 'task_settings/set_quiet_hours',
      run: runTaskSettings,
      action: 'set_quiet_hours',
      name: TASK_SETTINGS_ACTIONS.set_quiet_hours,
      args: { guildId: GUILD, startMinute: 60, endMinute: 480, timezone: TZ },
    },
  ];
  it.each(cases.map((entry) => [entry.tool, entry] as const))(
    '%s routes with the action stripped',
    async (_label, entry) => {
      const { admin, execute } = adminPort();
      const raw = entry.action === '(none)' ? entry.args : { ...entry.args, action: entry.action };
      const outcome = await entry.run(tasksPrincipal, admin, raw);
      expect(outcome).toEqual({ ok: true, text: 'stored' });
      expect(execute).toHaveBeenCalledWith(GUILD, 'owner', entry.name, entry.args);
    },
  );
});

describe('consolidated task write boundaries', () => {
  const crossAction: ReadonlyArray<{
    readonly run: (
      principal: typeof tasksPrincipal,
      port: TaskAdminPort,
      raw: unknown,
    ) => Promise<{ readonly ok: boolean } & Record<string, unknown>>;
    readonly raw: Record<string, unknown>;
  }> = [
    {
      run: runUpdateTask,
      raw: { ...versioned, action: 'archive', status: 'in_progress' },
    },
    {
      run: runTaskSteps,
      raw: { ...versioned, action: 'complete', childId: UUID_B, title: 'Step', dueAt: DUE },
    },
    {
      run: runTaskReminders,
      raw: { guildId: GUILD, taskId: UUID_A, action: 'cancel', at: DUE },
    },
    {
      run: runTaskProgress,
      raw: {
        guildId: GUILD,
        taskId: UUID_A,
        action: 'delete_report',
        body: 'x',
        requestId: UUID_B,
      },
    },
    {
      run: runTaskSettings,
      raw: { guildId: GUILD, action: 'clear_president_role', roleId: SNOW },
    },
  ];
  it.each(crossAction.map((entry, index) => [index, entry] as const))(
    'a parameter from another action is refused (%s)',
    async (_index, entry) => {
      const { admin, execute } = adminPort();
      const outcome = await entry.run(tasksPrincipal, admin, entry.raw);
      expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['update_task', runUpdateTask, { ...versioned }],
    ['task_steps', runTaskSteps, { ...versioned }],
    ['task_reminders', runTaskReminders, { guildId: GUILD, taskId: UUID_A }],
    ['task_progress', runTaskProgress, { guildId: GUILD, taskId: UUID_A }],
    ['task_settings', runTaskSettings, { guildId: GUILD }],
  ] as const)('%s refuses an unknown action', async (_tool, run, base) => {
    const { admin, execute } = adminPort();
    const outcome = await run(tasksPrincipal, admin, { ...base, action: 'explode' });
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('task_teams', () => {
  const view = {
    teams: [
      {
        teamId: 'team',
        name: 'Tech',
        categoryId: SNOW,
        kind: 'subteam',
        announcementChannelId: null,
        leadRoleId: null,
        memberRoleId: null,
        members: [],
      },
    ],
    presidentRoleId: null,
    quietHours: { startMinute: 0, endMinute: 480, timezone: 'America/Los_Angeles' },
  };
  const tasksPort = () => ({
    list: vi.fn().mockReturnValue({ teams: [], tasks: [] }),
    teams: vi.fn().mockReturnValue(view),
  });
  it('list uses the read path and never touches the admin port', async () => {
    const tasks = tasksPort();
    const { admin, execute } = adminPort();
    const outcome = await runTaskTeams(
      readPrincipal,
      { tasks, taskAdmin: admin },
      { guildId: GUILD, action: 'list' },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.text).toBe(
      ((): string => {
        const expected = listTaskTeamsText(readPrincipal, tasks, { guildId: GUILD });
        if (!expected.ok) throw new Error('expected read ok');
        return expected.text;
      })(),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.read).toMatchObject({ guildId: GUILD, itemCount: 1 });
  });
  it.each(Object.entries(TASK_TEAMS_ACTIONS))(
    'create/configure/delete/member action %s routes with the action stripped',
    async (action, name) => {
      const tasks = tasksPort();
      const { admin, execute } = adminPort();
      const perAction: Record<string, Record<string, unknown>> = {
        create: { guildId: GUILD, name: 'Tech', categoryId: SNOW, kind: 'subteam' },
        configure: { guildId: GUILD, teamId: UUID_A },
        delete: { guildId: GUILD, teamId: UUID_A },
        add_member: { guildId: GUILD, teamId: UUID_A, discordUserId: SNOW, kind: 'member' },
        remove_member: { guildId: GUILD, teamId: UUID_A, discordUserId: SNOW },
      };
      const args = perAction[action];
      if (!args) throw new Error(`no args for ${action}`);
      const outcome = await runTaskTeams(
        { ...tasksPrincipal, scopes: ['bananasaurs:read', 'bananasaurs:tasks'] },
        { tasks, taskAdmin: admin },
        { ...args, action },
      );
      expect(outcome).toEqual({ ok: true, text: 'stored' });
      expect(execute).toHaveBeenCalledWith(GUILD, 'owner', name, args);
    },
  );
  it('a parameter from another action is refused', async () => {
    const tasks = tasksPort();
    const { admin, execute } = adminPort();
    const outcome = await runTaskTeams(
      { ...tasksPrincipal, scopes: ['bananasaurs:read', 'bananasaurs:tasks'] },
      { tasks, taskAdmin: admin },
      { guildId: GUILD, teamId: UUID_A, action: 'delete', name: 'Tech' },
    );
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(execute).not.toHaveBeenCalled();
  });
  it('refuses an unknown action', async () => {
    const tasks = tasksPort();
    const { admin, execute } = adminPort();
    const outcome = await runTaskTeams(
      readPrincipal,
      { tasks, taskAdmin: admin },
      { guildId: GUILD, action: 'explode' },
    );
    expect(outcome).toEqual({ ok: false, message: INVALID_ARGUMENTS_MESSAGE });
    expect(execute).not.toHaveBeenCalled();
  });
  it('a write action without the tasks scope answers the reconnect message', async () => {
    const tasks = tasksPort();
    const { admin, execute } = adminPort();
    const outcome = await runTaskTeams(
      readPrincipal,
      { tasks, taskAdmin: admin },
      { guildId: GUILD, teamId: UUID_A, action: 'delete' },
    );
    expect(outcome).toEqual({ ok: false, message: TASK_SCOPE_REFUSAL_MESSAGE });
    expect(execute).not.toHaveBeenCalled();
  });
  it('a write action without the admin port answers the reconnect message', async () => {
    const tasks = tasksPort();
    const outcome = await runTaskTeams(
      { ...tasksPrincipal, scopes: ['bananasaurs:read', 'bananasaurs:tasks'] },
      { tasks, taskAdmin: undefined },
      { guildId: GUILD, teamId: UUID_A, action: 'delete' },
    );
    expect(outcome).toEqual({ ok: false, message: TASK_SCOPE_REFUSAL_MESSAGE });
  });
  it(`is registered as ${TASK_TEAMS_TOOL_NAME}`, () => {
    expect(TASK_TEAMS_TOOL_NAME).toBe('task_teams');
  });
});

describe(GET_TASK_TOOL_NAME, () => {
  const detail = {
    taskId: 'task',
    teamId: 'team',
    title: 'Measure',
    description: 'desc',
    status: 'not_started',
    priority: 'normal',
    assignmentKind: 'individual',
    assigneeId: SNOW,
    assigneeIds: [SNOW],
    dueAt: DUE,
    timezone: TZ,
    destinationId: '444444444444444444',
    version: 2,
    archived: false,
    children: [],
    reports: [],
    reminders: [],
  };
  const slots = [{ slotId: `custom:task:${DUE}`, kind: 'custom', dueAt: DUE, state: 'pending' }];
  const detailPort = () => ({
    detail: vi.fn().mockReturnValue(detail),
    reminders: vi.fn().mockReturnValue(slots),
  });
  it('concatenates the details text and the reminders text', () => {
    const port = detailPort();
    const outcome = getTaskText(readPrincipal, port, { guildId: GUILD, taskId: UUID_A });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok');
    const details = getTaskDetailsText(readPrincipal, port, { guildId: GUILD, taskId: UUID_A });
    const reminders = listTaskRemindersText(readPrincipal, port, {
      guildId: GUILD,
      taskId: UUID_A,
    });
    if (!details.ok || !reminders.ok) throw new Error('expected read oks');
    expect(outcome.text).toBe(`${details.text}\n\n${reminders.text}`);
    expect(outcome.taskId).toBe(UUID_A);
    expect(GET_TASK_READ_ACTION).toBe('mcp.read.get_task');
  });
  it('refuses an unknown task like the details read', () => {
    const port = { detail: vi.fn().mockReturnValue(undefined), reminders: vi.fn() };
    expect(getTaskText(readPrincipal, port, { guildId: GUILD, taskId: UUID_A })).toEqual({
      ok: false,
      message: GUILD_REFUSAL_MESSAGE,
    });
    expect(port.reminders).not.toHaveBeenCalled();
  });
  it('rejects bad task ids before consulting the port', () => {
    const port = detailPort();
    expect(getTaskText(readPrincipal, port, { guildId: GUILD, taskId: 'bad-id' })).toEqual({
      ok: false,
      message: INVALID_ARGUMENTS_MESSAGE,
    });
    expect(port.detail).not.toHaveBeenCalled();
  });
});
