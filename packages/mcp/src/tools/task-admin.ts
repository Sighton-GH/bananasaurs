import { z } from 'zod';
import { snowflakeIdSchema, timeZoneSchema, type GuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';

const guildId = z.string();
const taskId = z.string().uuid();
const teamId = z.string().uuid();
const childId = z.string().uuid();
const requestId = z.string().uuid();
const title = z.string().trim().min(1).max(180);
const dueAt = z.number().int().positive();
const version = z.number().int().positive();
const assigneeIds = z
  .array(snowflakeIdSchema)
  .min(1)
  .max(25)
  .refine((ids) => new Set(ids).size === ids.length)
  .optional();
const extraReminderAt = z.array(z.number().int().positive()).max(20).optional();
const taskFields = {
  title,
  description: z.string().max(5000).optional(),
  priority: z.enum(['normal', 'urgent']).default('normal'),
  assignmentKind: z.enum(['team', 'individual']),
  assigneeId: snowflakeIdSchema.optional(),
  assigneeIds,
  dueAt,
  timezone: timeZoneSchema,
  destinationId: snowflakeIdSchema,
};
const createTaskFields = { ...taskFields, extraReminderAt };
const editTaskFields = taskFields;
const withGuild = { guildId };
/** Schema validation is repeated here even though the SDK validates its declared shape. */
export const taskAdminTools = {
  create_task_team: {
    description:
      'Owner-only: create a task team mapped to a live Discord category. Stores configuration; does not post.',
    params: {
      ...withGuild,
      name: z.string().trim().min(1).max(100),
      categoryId: snowflakeIdSchema,
      kind: z.enum(['subteam', 'exec']),
      announcementChannelId: snowflakeIdSchema.optional(),
      leadRoleId: snowflakeIdSchema.optional(),
      memberRoleId: snowflakeIdSchema.optional(),
    },
  },
  configure_task_team: {
    description:
      'Owner-only: update a task team name, announcement destination, lead role or member role. Use null to clear an optional ID.',
    params: {
      ...withGuild,
      teamId,
      name: z.string().trim().min(1).max(100).optional(),
      announcementChannelId: snowflakeIdSchema.nullable().optional(),
      leadRoleId: snowflakeIdSchema.nullable().optional(),
      memberRoleId: snowflakeIdSchema.nullable().optional(),
    },
  },
  delete_task_team: {
    description:
      'Owner-only: delete a task team that has no tasks. A team with tasks cannot be deleted.',
    params: { ...withGuild, teamId },
  },
  set_task_president_role: {
    description: 'Owner-only: set the live Discord role ID that approves executive tasks.',
    params: { ...withGuild, roleId: snowflakeIdSchema },
  },
  clear_task_president_role: {
    description: 'Owner-only: clear the Discord role ID that approves executive tasks.',
    params: { ...withGuild },
  },
  add_task_team_member: {
    description:
      'Owner-only: set a live Discord team membership (lead requires the current lead role).',
    params: {
      ...withGuild,
      teamId,
      discordUserId: snowflakeIdSchema,
      kind: z.enum(['member', 'lead']),
    },
  },
  remove_task_team_member: {
    description: 'Owner-only: revoke one team membership.',
    params: { ...withGuild, teamId, discordUserId: snowflakeIdSchema },
  },
  create_club_task: {
    description:
      'Owner-only: create a team or individual task in a verified destination, with normal or urgent priority and a due date in milliseconds. Retrying with the same requestId returns the existing task and schedules nothing new.',
    params: {
      ...withGuild,
      teamId,
      ...createTaskFields,
      requestId: z.string().min(8).max(100),
    },
  },
  edit_club_task: {
    description:
      'Owner-only: replace editable task fields, checking the expected version from get_task. Multi-assignee edits supply the full assignee list.',
    params: { ...withGuild, taskId, expectedVersion: version, ...editTaskFields },
  },
  append_task_child: {
    description: 'Owner-only: append a dated child item to an open task.',
    params: { ...withGuild, taskId, expectedVersion: version, title, dueAt },
  },
  edit_task_child: {
    description: 'Owner-only: rename or reschedule one dated child item of an open task.',
    params: { ...withGuild, taskId, expectedVersion: version, childId, title, dueAt },
  },
  complete_task_child: {
    description: 'Owner-only: mark one dated child item of an open task done.',
    params: { ...withGuild, taskId, expectedVersion: version, childId },
  },
  delete_task_child: {
    description: 'Owner-only: delete one dated child item of an open task.',
    params: { ...withGuild, taskId, expectedVersion: version, childId },
  },
  record_task_progress: {
    description:
      'Owner-only: record a progress report on an open task; does not post it. Retrying with the same requestId is a no-op.',
    params: { ...withGuild, taskId, body: z.string().trim().min(1).max(5000), requestId },
  },
  delete_task_report: {
    description:
      'Owner-only: delete one progress report from a task, by hand. This is how a member data-deletion request is honoured.',
    params: { ...withGuild, taskId, reportId: z.string().min(1).max(200) },
  },
  request_task_completion: {
    description:
      'Owner-only: request completion by moving an open task to awaiting approval using expected version; does not approve.',
    params: { ...withGuild, taskId, expectedVersion: version },
  },
  approve_task_completion: {
    description:
      'Owner-only: approve an awaiting task, moving it to done using the expected version from get_task.',
    params: { ...withGuild, taskId, expectedVersion: version },
  },
  reject_task_completion: {
    description:
      'Owner-only: send an awaiting task back to in progress using the expected version from get_task.',
    params: { ...withGuild, taskId, expectedVersion: version },
  },
  set_task_status: {
    description:
      'Owner-only: set an unarchived task back to a working status using the expected version from get_task.',
    params: {
      ...withGuild,
      taskId,
      expectedVersion: version,
      status: z.enum(['not_started', 'in_progress']),
    },
  },
  archive_task: {
    description:
      'Owner-only: archive a task so it leaves the default listing, using the expected version from get_task.',
    params: { ...withGuild, taskId, expectedVersion: version },
  },
  unarchive_task: {
    description:
      'Owner-only: restore an archived task to the default listing, using the expected version from get_task.',
    params: { ...withGuild, taskId, expectedVersion: version },
  },
  delete_club_task: {
    description:
      'Owner-only: delete a task and everything that belongs to it (steps, updates, reminders), by hand. Nothing about tasks is deleted automatically; this is the manual path.',
    params: { ...withGuild, taskId, expectedVersion: version },
  },
  add_task_reminder: {
    description:
      'Owner-only: append a custom reminder at one exact epoch-millisecond time before due. The default 48-hour reminder remains. No Discord message is sent by this call.',
    params: {
      ...withGuild,
      taskId,
      at: z.number().int().positive(),
    },
  },
  cancel_task_reminder: {
    description: 'Owner-only: cancel one pending custom reminder of a task.',
    params: {
      ...withGuild,
      taskId,
      slotId: z.string().min(1).max(200),
    },
  },
  configure_task_quiet_hours: {
    description:
      'Owner-only: configure local quiet hours, in minutes from midnight. Default is midnight-8am America/Los_Angeles. Stored only.',
    params: {
      ...withGuild,
      startMinute: z.number().int().min(0).max(1439),
      endMinute: z.number().int().min(0).max(1439),
      timezone: timeZoneSchema,
    },
  },
} as const;
export type TaskAdminName = keyof typeof taskAdminTools;
export interface TaskAdminPort {
  execute(
    guildId: GuildId,
    accountId: string,
    name: TaskAdminName,
    args: Record<string, unknown>,
  ): Promise<
    { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string }
  >;
}
export const runTaskAdmin = async (
  principal: McpPrincipal,
  port: TaskAdminPort,
  name: TaskAdminName,
  raw: unknown,
) => {
  const parsed = z.object(taskAdminTools[name].params).strict().safeParse(raw);
  if (!parsed.success) return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  if (
    name === 'configure_task_quiet_hours' &&
    'startMinute' in parsed.data &&
    parsed.data.startMinute === parsed.data.endMinute
  )
    return { ok: false as const, message: INVALID_ARGUMENTS_MESSAGE };
  const scoped = requireReachableGuild(principal, parsed.data.guildId);
  if (!scoped.ok) return scoped;
  try {
    return await port.execute(scoped.guildId, principal.accountId, name, parsed.data);
  } catch {
    return { ok: false as const, message: GUILD_REFUSAL_MESSAGE };
  }
};
