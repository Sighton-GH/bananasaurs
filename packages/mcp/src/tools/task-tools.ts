import { z } from 'zod';
import type { GuildId } from '@bananasaurs/core';
import { hasTasksScope, INVALID_ARGUMENTS_MESSAGE, type McpPrincipal } from '../scope.js';
import {
  runTaskAdmin,
  taskAdminTools,
  type TaskAdminName,
  type TaskAdminPort,
} from './task-admin.js';
import {
  getTaskDetailsText,
  listTaskRemindersText,
  listTaskTeamsText,
  type McpTaskDetailPort,
  type McpTaskPort,
} from './tasks.js';

/**
 * ADR 0132: the 10 action-based task tools. Each merged write tool takes an
 * `action` enum plus the union of its actions' parameters as optional
 * fields; routing strips `action` and calls `runTaskAdmin` with the old
 * internal name, whose strict per-action parse stays the real argument
 * boundary — an unknown action, or a parameter belonging to a different
 * action, ends as `INVALID_ARGUMENTS_MESSAGE`. The daemon still dispatches
 * on the old names; only the advertised surface is new.
 */

export type TaskAdminOutcome =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

const runTaskAction = async (
  principal: McpPrincipal,
  port: TaskAdminPort,
  routes: Readonly<Record<string, TaskAdminName>>,
  raw: unknown,
): Promise<TaskAdminOutcome> => {
  if (typeof raw !== 'object' || raw === null)
    return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  const { action, ...rest } = raw as Record<string, unknown>;
  // Own keys only: `routes.constructor` is an inherited function, not an action.
  const name =
    typeof action === 'string' && Object.hasOwn(routes, action) ? routes[action] : undefined;
  if (name === undefined) return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  return runTaskAdmin(principal, port, name, rest);
};

export const GET_TASK_TOOL_NAME = 'get_task';
export const GET_TASK_TOOL_DESCRIPTION =
  'Get one task with its version, dated children, progress reports and reminder slots for an authorized guild. Read-only.';
export const getTaskParams = { guildId: z.string(), taskId: z.string().uuid() };
/** The single read-audit row `get_task` writes (ADR 0050). */
export const GET_TASK_READ_ACTION = 'mcp.read.get_task';
/** The details text, then the reminders text for the same task. */
export const getTaskText = (
  principal: McpPrincipal,
  port: McpTaskDetailPort,
  raw: unknown,
):
  { ok: true; text: string; guildId: GuildId; taskId: string } | { ok: false; message: string } => {
  const details = getTaskDetailsText(principal, port, raw);
  if (!details.ok) return details;
  const reminders = listTaskRemindersText(principal, port, raw);
  if (!reminders.ok) return reminders;
  return {
    ok: true,
    text: `${details.text}\n\n${reminders.text}`,
    guildId: details.guildId,
    taskId: details.taskId,
  };
};

export const CREATE_TASK_TOOL_NAME = 'create_task';
export const CREATE_TASK_TOOL_DESCRIPTION =
  'Create a team or individual task in a verified destination, with normal or urgent priority and a due date in milliseconds. Retrying with the same requestId returns the existing task and schedules nothing new.';
export const createTaskParams = taskAdminTools.create_club_task.params;
export const runCreateTask = (
  principal: McpPrincipal,
  port: TaskAdminPort,
  raw: unknown,
): Promise<TaskAdminOutcome> => runTaskAdmin(principal, port, 'create_club_task', raw);

export const UPDATE_TASK_TOOL_NAME = 'update_task';
export const UPDATE_TASK_TOOL_DESCRIPTION = [
  'Change a task: edit its fields, move it between working statuses, run its approval handshake, or archive it.',
  'edit: replace editable task fields, checking the expected version from get_task.',
  'set_status: set an unarchived task back to not_started or in_progress.',
  'request_completion: move an open task to awaiting approval; does not approve.',
  'approve_completion: approve an awaiting task, moving it to done.',
  'reject_completion: send an awaiting task back to in_progress.',
  'archive: archive a task so it leaves the default listing.',
  'unarchive: restore an archived task to the default listing.',
].join('\n');
export const UPDATE_TASK_ACTIONS = {
  edit: 'edit_club_task',
  set_status: 'set_task_status',
  request_completion: 'request_task_completion',
  approve_completion: 'approve_task_completion',
  reject_completion: 'reject_task_completion',
  archive: 'archive_task',
  unarchive: 'unarchive_task',
} as const;
const editTaskParams = taskAdminTools.edit_club_task.params;
const setStatusParams = taskAdminTools.set_task_status.params;
export const updateTaskParams = {
  guildId: z.string(),
  action: z.enum([
    'edit',
    'set_status',
    'request_completion',
    'approve_completion',
    'reject_completion',
    'archive',
    'unarchive',
  ]),
  taskId: editTaskParams.taskId.optional().describe('Every update_task action uses this.'),
  expectedVersion: editTaskParams.expectedVersion
    .optional()
    .describe('Every update_task action uses this.'),
  title: editTaskParams.title.optional().describe('edit uses this.'),
  description: editTaskParams.description.optional().describe('edit uses this.'),
  priority: editTaskParams.priority.optional().describe('edit uses this.'),
  assignmentKind: editTaskParams.assignmentKind.optional().describe('edit uses this.'),
  assigneeId: editTaskParams.assigneeId.optional().describe('edit uses this.'),
  assigneeIds: editTaskParams.assigneeIds.optional().describe('edit uses this.'),
  dueAt: editTaskParams.dueAt.optional().describe('edit uses this.'),
  timezone: editTaskParams.timezone.optional().describe('edit uses this.'),
  destinationId: editTaskParams.destinationId.optional().describe('edit uses this.'),
  links: editTaskParams.links
    .optional()
    .describe('edit uses this. Omit to keep the links; [] clears them.'),
  status: setStatusParams.status.optional().describe('set_status uses this.'),
};
export const runUpdateTask = (
  principal: McpPrincipal,
  port: TaskAdminPort,
  raw: unknown,
): Promise<TaskAdminOutcome> => runTaskAction(principal, port, UPDATE_TASK_ACTIONS, raw);

export const DELETE_TASK_TOOL_NAME = 'delete_task';
export const DELETE_TASK_TOOL_DESCRIPTION =
  'Delete a task and everything that belongs to it (steps, updates, reminders), by hand. Nothing about tasks is deleted automatically; this is the manual path.';
export const deleteTaskParams = taskAdminTools.delete_club_task.params;
export const runDeleteTask = (
  principal: McpPrincipal,
  port: TaskAdminPort,
  raw: unknown,
): Promise<TaskAdminOutcome> => runTaskAdmin(principal, port, 'delete_club_task', raw);

export const TASK_STEPS_TOOL_NAME = 'task_steps';
export const TASK_STEPS_TOOL_DESCRIPTION = [
  'Manage the dated child steps of an open task.',
  'add: append a dated child item to an open task.',
  'edit: rename or reschedule one dated child item of an open task.',
  'complete: mark one dated child item of an open task done.',
  'delete: delete one dated child item of an open task.',
].join('\n');
export const TASK_STEPS_ACTIONS = {
  add: 'append_task_child',
  edit: 'edit_task_child',
  complete: 'complete_task_child',
  delete: 'delete_task_child',
} as const;
const appendChildParams = taskAdminTools.append_task_child.params;
const editChildParams = taskAdminTools.edit_task_child.params;
export const taskStepsParams = {
  guildId: z.string(),
  action: z.enum(['add', 'edit', 'complete', 'delete']),
  taskId: appendChildParams.taskId.optional().describe('Every task_steps action uses this.'),
  expectedVersion: appendChildParams.expectedVersion
    .optional()
    .describe('Every task_steps action uses this.'),
  title: appendChildParams.title.optional().describe('add and edit use this.'),
  dueAt: appendChildParams.dueAt.optional().describe('add and edit use this.'),
  childId: editChildParams.childId.optional().describe('edit, complete and delete use this.'),
};
export const runTaskSteps = (
  principal: McpPrincipal,
  port: TaskAdminPort,
  raw: unknown,
): Promise<TaskAdminOutcome> => runTaskAction(principal, port, TASK_STEPS_ACTIONS, raw);

export const TASK_REMINDERS_TOOL_NAME = 'task_reminders';
export const TASK_REMINDERS_TOOL_DESCRIPTION = [
  'Manage the custom reminders of a task.',
  'add: append a custom reminder at one exact epoch-millisecond time before due. The default 48-hour reminder remains. No Discord message is sent by this call.',
  'cancel: cancel one pending custom reminder of a task.',
].join('\n');
export const TASK_REMINDERS_ACTIONS = {
  add: 'add_task_reminder',
  cancel: 'cancel_task_reminder',
} as const;
const addReminderParams = taskAdminTools.add_task_reminder.params;
const cancelReminderParams = taskAdminTools.cancel_task_reminder.params;
export const taskRemindersParams = {
  guildId: z.string(),
  action: z.enum(['add', 'cancel']),
  taskId: addReminderParams.taskId.optional().describe('Every task_reminders action uses this.'),
  at: addReminderParams.at.optional().describe('add uses this.'),
  slotId: cancelReminderParams.slotId.optional().describe('cancel uses this.'),
};
export const runTaskReminders = (
  principal: McpPrincipal,
  port: TaskAdminPort,
  raw: unknown,
): Promise<TaskAdminOutcome> => runTaskAction(principal, port, TASK_REMINDERS_ACTIONS, raw);

export const TASK_PROGRESS_TOOL_NAME = 'task_progress';
export const TASK_PROGRESS_TOOL_DESCRIPTION = [
  'Manage the progress reports of a task.',
  "record: record a progress report on an open task. When task posts are on, it is posted to the task's channel as an update card within a minute. Retrying with the same requestId is a no-op.",
  'delete_report: delete one progress report from a task, by hand. This is how a member data-deletion request is honoured.',
].join('\n');
export const TASK_PROGRESS_ACTIONS = {
  record: 'record_task_progress',
  delete_report: 'delete_task_report',
} as const;
const recordProgressParams = taskAdminTools.record_task_progress.params;
const deleteReportParams = taskAdminTools.delete_task_report.params;
export const taskProgressParams = {
  guildId: z.string(),
  action: z.enum(['record', 'delete_report']),
  taskId: recordProgressParams.taskId.optional().describe('Every task_progress action uses this.'),
  body: recordProgressParams.body.optional().describe('record uses this.'),
  requestId: recordProgressParams.requestId.optional().describe('record uses this.'),
  reportId: deleteReportParams.reportId.optional().describe('delete_report uses this.'),
};
export const runTaskProgress = (
  principal: McpPrincipal,
  port: TaskAdminPort,
  raw: unknown,
): Promise<TaskAdminOutcome> => runTaskAction(principal, port, TASK_PROGRESS_ACTIONS, raw);

export const TASK_TEAMS_TOOL_NAME = 'task_teams';
export const TASK_TEAMS_TOOL_DESCRIPTION = [
  'Manage task teams, or list them with their category, roles, members, the president role and quiet hours.',
  'list: list task teams for an authorized guild. Read-only.',
  'create: create a task team mapped to a live Discord category. Stores configuration; does not post.',
  'configure: update a task team name, announcement destination, lead role or member role. Use null to clear an optional ID.',
  'delete: delete a task team that has no tasks. A team with tasks cannot be deleted.',
  'add_member: set a live Discord team membership (lead requires the current lead role).',
  'remove_member: revoke one team membership.',
].join('\n');
export const TASK_TEAMS_ACTIONS = {
  create: 'create_task_team',
  configure: 'configure_task_team',
  delete: 'delete_task_team',
  add_member: 'add_task_team_member',
  remove_member: 'remove_task_team_member',
} as const;
const createTeamParams = taskAdminTools.create_task_team.params;
const configureTeamParams = taskAdminTools.configure_task_team.params;
const addMemberParams = taskAdminTools.add_task_team_member.params;
export const taskTeamsParams = {
  guildId: z.string(),
  action: z.enum(['list', 'create', 'configure', 'delete', 'add_member', 'remove_member']),
  teamId: configureTeamParams.teamId
    .optional()
    .describe('configure, delete, add_member and remove_member use this.'),
  name: configureTeamParams.name.optional().describe('create and configure use this.'),
  categoryId: createTeamParams.categoryId.optional().describe('create uses this.'),
  kind: z
    .enum(['subteam', 'exec', 'member', 'lead'])
    .optional()
    .describe('create (subteam, exec) and add_member (member, lead) use this.'),
  announcementChannelId: configureTeamParams.announcementChannelId
    .optional()
    .describe('create and configure use this; configure accepts null to clear.'),
  leadRoleId: configureTeamParams.leadRoleId
    .optional()
    .describe('create and configure use this; configure accepts null to clear.'),
  memberRoleId: configureTeamParams.memberRoleId
    .optional()
    .describe('create and configure use this; configure accepts null to clear.'),
  discordUserId: addMemberParams.discordUserId
    .optional()
    .describe('add_member and remove_member use this.'),
};
/**
 * The answer a `task_teams` write action gets when the connection was never
 * approved for Tasks: without the `bananasaurs:tasks` scope the tool is
 * visible (it registered for its read half) but the write cannot run, and
 * without the admin port there is nothing to run it with — both cases need
 * a reconnect, the same wording ADR 0130 uses for the approval.
 */
export const TASK_SCOPE_REFUSAL_MESSAGE =
  'This connection was not approved for Tasks. Disconnect and reconnect it, and approve Tasks on the Bananasaurs sign-in page.';
export interface TaskTeamsPorts {
  readonly tasks: McpTaskPort;
  readonly taskAdmin?: TaskAdminPort | undefined;
}
export const runTaskTeams = async (
  principal: McpPrincipal,
  ports: TaskTeamsPorts,
  raw: unknown,
): Promise<
  | {
      readonly ok: true;
      readonly text: string;
      readonly read: { readonly guildId: GuildId; readonly itemCount: number } | undefined;
    }
  | { readonly ok: false; readonly message: string }
> => {
  if (typeof raw !== 'object' || raw === null)
    return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  const record = raw as Record<string, unknown>;
  if (record['action'] === 'list') {
    const rest = { ...record };
    delete rest.action;
    const outcome = listTaskTeamsText(principal, ports.tasks, rest);
    if (!outcome.ok) return outcome;
    return {
      ok: true as const,
      text: outcome.text,
      read: { guildId: outcome.guildId, itemCount: outcome.itemCount },
    };
  }
  // The action must name a write before the scope gate answers: an unknown
  // action is an argument fault, not a scope refusal. Own keys only, as in
  // `runTaskAction`.
  const action = record['action'];
  const name =
    typeof action === 'string' && Object.hasOwn(TASK_TEAMS_ACTIONS, action)
      ? (TASK_TEAMS_ACTIONS as Readonly<Record<string, TaskAdminName>>)[action]
      : undefined;
  if (name === undefined) return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  if (!hasTasksScope(principal) || ports.taskAdmin === undefined)
    return { ok: false as const, message: TASK_SCOPE_REFUSAL_MESSAGE };
  const outcome = await runTaskAction(principal, ports.taskAdmin, TASK_TEAMS_ACTIONS, raw);
  if (!outcome.ok) return outcome;
  return { ok: true as const, text: outcome.text, read: undefined };
};

export const TASK_SETTINGS_TOOL_NAME = 'task_settings';
export const TASK_SETTINGS_TOOL_DESCRIPTION = [
  'Manage guild-wide task settings.',
  'set_president_role: set the live Discord role ID that approves executive tasks.',
  'clear_president_role: clear the Discord role ID that approves executive tasks.',
  'set_quiet_hours: configure local quiet hours, in minutes from midnight. Stored only.',
].join('\n');
export const TASK_SETTINGS_ACTIONS = {
  set_president_role: 'set_task_president_role',
  clear_president_role: 'clear_task_president_role',
  set_quiet_hours: 'configure_task_quiet_hours',
} as const;
const setPresidentParams = taskAdminTools.set_task_president_role.params;
const quietHoursParams = taskAdminTools.configure_task_quiet_hours.params;
export const taskSettingsParams = {
  guildId: z.string(),
  action: z.enum(['set_president_role', 'clear_president_role', 'set_quiet_hours']),
  roleId: setPresidentParams.roleId.optional().describe('set_president_role uses this.'),
  startMinute: quietHoursParams.startMinute.optional().describe('set_quiet_hours uses this.'),
  endMinute: quietHoursParams.endMinute.optional().describe('set_quiet_hours uses this.'),
  timezone: quietHoursParams.timezone.optional().describe('set_quiet_hours uses this.'),
};
export const runTaskSettings = (
  principal: McpPrincipal,
  port: TaskAdminPort,
  raw: unknown,
): Promise<TaskAdminOutcome> => runTaskAction(principal, port, TASK_SETTINGS_ACTIONS, raw);
