import { z } from 'zod';
import type { GuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';

export const LIST_TASKS_TOOL_NAME = 'list_tasks';
export const LIST_TASKS_TOOL_DESCRIPTION =
  'List tasks (open by default) in one reachable guild when the bearer account is the instance owner. Approved tasks are archived automatically, so finding them needs includeArchived: true (with includeDone). Read-only.';
export const listTasksParams = {
  guildId: z.string(),
  teamId: z.string().uuid().optional(),
  includeDone: z.boolean().optional(),
  includeArchived: z.boolean().optional(),
};
const schema = z.object(listTasksParams).strict();
export interface McpTaskListFilter {
  readonly teamId?: string | undefined;
  readonly includeDone?: boolean | undefined;
  readonly includeArchived?: boolean | undefined;
}
export interface McpTaskTeamMemberView {
  readonly discordUserId: string;
  readonly kind: string;
}
export interface McpTaskTeamView {
  readonly teamId: string;
  readonly name: string;
  readonly categoryId: string;
  readonly kind: string;
  readonly announcementChannelId: string | null;
  readonly leadRoleId: string | null;
  readonly memberRoleId: string | null;
  readonly members: readonly McpTaskTeamMemberView[];
}
export interface McpTaskTeamsView {
  readonly teams: readonly McpTaskTeamView[];
  readonly presidentRoleId: string | null;
  readonly quietHours: {
    readonly startMinute: number;
    readonly endMinute: number;
    readonly timezone: string;
  };
}
export interface McpTaskPort {
  list(
    guildId: GuildId,
    accountId: string,
    filter: McpTaskListFilter,
  ):
    | {
        readonly teams: readonly { readonly teamId: string; readonly name: string }[];
        readonly tasks: readonly {
          readonly taskId: string;
          readonly teamId: string;
          readonly title: string;
          readonly status: string;
          readonly dueAt: number;
          readonly assigneeIds: readonly string[];
        }[];
      }
    | undefined;
  teams(guildId: GuildId, accountId: string): McpTaskTeamsView | undefined;
}
export const listTasksText = (
  principal: McpPrincipal,
  port: McpTaskPort,
  raw: unknown,
):
  | { ok: true; text: string; guildId: GuildId; itemCount: number }
  | { ok: false; message: string } => {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: INVALID_ARGUMENTS_MESSAGE };
  const scoped = requireReachableGuild(principal, parsed.data.guildId);
  if (!scoped.ok) return scoped;
  const result = port.list(scoped.guildId, principal.accountId, {
    ...(parsed.data.teamId !== undefined ? { teamId: parsed.data.teamId } : {}),
    ...(parsed.data.includeDone !== undefined ? { includeDone: parsed.data.includeDone } : {}),
    ...(parsed.data.includeArchived !== undefined
      ? { includeArchived: parsed.data.includeArchived }
      : {}),
  });
  if (!result) return { ok: false, message: GUILD_REFUSAL_MESSAGE };
  const teams = new Map(result.teams.map((team) => [team.teamId, team.name]));
  const lines = result.tasks.slice(0, 100).map((task) => {
    const title = task.title.replaceAll(/[\r\n`@]/g, ' ').slice(0, 180);
    const team = (teams.get(task.teamId) ?? 'Unknown team')
      .replaceAll(/[\r\n`@]/g, ' ')
      .slice(0, 100);
    const assignees = task.assigneeIds.join(',');
    return `${task.taskId} | ${team} | ${title} | ${task.status} | ${new Date(task.dueAt).toISOString()} | ${assignees}`;
  });
  return {
    ok: true,
    text: lines.length ? lines.join('\n') : 'No open tasks.',
    guildId: scoped.guildId,
    itemCount: result.tasks.length,
  };
};

export interface McpTaskReminderSlot {
  readonly slotId: string;
  readonly kind: string;
  readonly dueAt: number;
  readonly state: string;
}
export const GET_TASK_DETAILS_TOOL_NAME = 'get_task_details';
export const GET_TASK_DETAILS_TOOL_DESCRIPTION =
  'Owner-only: get one task, its version, dated children and progress reports for an authorized guild. Read-only.';
export const getTaskDetailsParams = { guildId: z.string(), taskId: z.string().uuid() };
const detailSchema = z.object(getTaskDetailsParams).strict();
export interface McpTaskDetail {
  readonly taskId: string;
  readonly teamId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly priority: string;
  readonly assignmentKind: string;
  readonly assigneeId: string | null;
  readonly assigneeIds: readonly string[];
  readonly dueAt: number;
  readonly timezone: string;
  readonly destinationId: string;
  readonly version: number;
  readonly archived: boolean;
  readonly children: readonly {
    readonly childId: string;
    readonly title: string;
    readonly dueAt: number;
    readonly status: string;
  }[];
  readonly reports: readonly {
    readonly reportId: string;
    readonly authorId: string;
    readonly body: string;
    readonly createdAt: number;
  }[];
  readonly reminders: readonly McpTaskReminderSlot[];
}
export interface McpTaskDetailPort {
  detail(guildId: GuildId, accountId: string, taskId: string): McpTaskDetail | undefined;
  reminders(
    guildId: GuildId,
    accountId: string,
    taskId: string,
  ): readonly McpTaskReminderSlot[] | undefined;
}
export const getTaskDetailsText = (
  principal: McpPrincipal,
  port: McpTaskDetailPort,
  raw: unknown,
):
  { ok: true; text: string; guildId: GuildId; taskId: string } | { ok: false; message: string } => {
  const parsed = detailSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: INVALID_ARGUMENTS_MESSAGE };
  const scoped = requireReachableGuild(principal, parsed.data.guildId);
  if (!scoped.ok) return scoped;
  const task = port.detail(scoped.guildId, principal.accountId, parsed.data.taskId);
  if (!task) return { ok: false, message: GUILD_REFUSAL_MESSAGE };
  // JSON data, not interpreted as instructions; neutralize Discord pings and cap large fields.
  const clean = (value: string, max: number) => value.replaceAll(/[\r\n`@]/g, ' ').slice(0, max);
  const text = JSON.stringify({
    ...task,
    title: clean(task.title, 180),
    description: clean(task.description, 5000),
    children: task.children
      .slice(0, 20)
      .map((child) => ({ ...child, title: clean(child.title, 180) })),
    reports: task.reports
      .slice(-5)
      .map((report) => ({ ...report, body: clean(report.body, 2000) })),
  });
  return {
    ok: true,
    text,
    guildId: scoped.guildId,
    taskId: parsed.data.taskId,
  };
};

export const LIST_TASK_TEAMS_TOOL_NAME = 'list_task_teams';
export const LIST_TASK_TEAMS_TOOL_DESCRIPTION =
  'Owner-only: list task teams with their category, roles, members, the president role and quiet hours for an authorized guild. Read-only.';
export const listTaskTeamsParams = { guildId: z.string() };
const teamsSchema = z.object(listTaskTeamsParams).strict();
export const listTaskTeamsText = (
  principal: McpPrincipal,
  port: McpTaskPort,
  raw: unknown,
):
  | { ok: true; text: string; guildId: GuildId; itemCount: number }
  | { ok: false; message: string } => {
  const parsed = teamsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: INVALID_ARGUMENTS_MESSAGE };
  const scoped = requireReachableGuild(principal, parsed.data.guildId);
  if (!scoped.ok) return scoped;
  const view = port.teams(scoped.guildId, principal.accountId);
  if (!view) return { ok: false, message: GUILD_REFUSAL_MESSAGE };
  const clean = (value: string, max: number) => value.replaceAll(/[\r\n`@]/g, ' ').slice(0, max);
  const text = JSON.stringify({
    teams: view.teams.map((team) => ({
      ...team,
      name: clean(team.name, 100),
    })),
    presidentRoleId: view.presidentRoleId,
    quietHours: view.quietHours,
  });
  return { ok: true, text, guildId: scoped.guildId, itemCount: view.teams.length };
};

export const LIST_TASK_REMINDERS_TOOL_NAME = 'list_task_reminders';
export const LIST_TASK_REMINDERS_TOOL_DESCRIPTION =
  'Owner-only: list the reminder slots of one task for an authorized guild. Read-only.';
export const listTaskRemindersParams = { guildId: z.string(), taskId: z.string().uuid() };
const remindersSchema = z.object(listTaskRemindersParams).strict();
export const listTaskRemindersText = (
  principal: McpPrincipal,
  port: McpTaskDetailPort,
  raw: unknown,
):
  | { ok: true; text: string; guildId: GuildId; taskId: string; itemCount: number }
  | { ok: false; message: string } => {
  const parsed = remindersSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: INVALID_ARGUMENTS_MESSAGE };
  const scoped = requireReachableGuild(principal, parsed.data.guildId);
  if (!scoped.ok) return scoped;
  const slots = port.reminders(scoped.guildId, principal.accountId, parsed.data.taskId);
  if (!slots) return { ok: false, message: GUILD_REFUSAL_MESSAGE };
  return {
    ok: true,
    text: JSON.stringify(slots),
    guildId: scoped.guildId,
    taskId: parsed.data.taskId,
    itemCount: slots.length,
  };
};
