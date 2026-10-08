import { createHash } from 'node:crypto';
import { ChannelType, type Client } from 'discord.js';
import { safeLogFields, type DiscordPort, type GuildId } from '@bananasaurs/core';
import type { HttpDeps } from '@bananasaurs/http';
import { effectRepo, taskBindingRepo, taskNudgeRepo, taskRepo } from '@bananasaurs/storage';
import type { TaskAdminPort, TaskAdminName } from '@bananasaurs/mcp';
import { channelAccessFor } from '../channels/access.js';
import { canManageTasks } from './task-access.js';

const refused = (message: string): { ok: false; message: string } => ({ ok: false, message });
const success = (text: string): { ok: true; text: string } => ({ ok: true, text });
const NOT_AVAILABLE =
  'Task or team is unavailable or has changed. Read its current state and retry.';
const POSTS_GATE = 'Discord posts go out only when the operator has enabled task posts.';

/** Deterministic task id for one `create_club_task` request: the sha256 of
 * `task:<guildId>:<requestId>` rendered as a version-5-variant UUID, so a
 * retried call names the same row and `createTask` returns the existing task
 * instead of scheduling anything new. */
export const taskIdForCreateRequest = (guildId: string, requestId: string): string => {
  const hex = createHash('sha256')
    .update(`task:${guildId}:${requestId}`, 'utf8')
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const id = hex.join('');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
};

type Args = {
  guildId: string;
  teamId: string;
  taskId: string;
  childId: string;
  requestId: string;
  slotId: string;
  status: 'not_started' | 'in_progress';
  name: string;
  categoryId: string;
  kind: 'subteam' | 'exec';
  announcementChannelId?: string | null;
  leadRoleId?: string | null;
  memberRoleId?: string | null;
  roleId: string;
  discordUserId: string;
  title: string;
  description?: string;
  priority: 'normal' | 'urgent';
  assignmentKind: 'team' | 'individual';
  assigneeId?: string;
  assigneeIds?: string[];
  extraReminderAt?: number[];
  dueAt: number;
  timezone: string;
  destinationId: string;
  expectedVersion: number;
  body: string;
  reportId: string;
  at: number;
  startMinute: number;
  endMinute: number;
};

/** Each tool call rechecks owner-or-`tasks.manage` in the call's guild; model-supplied actor IDs are ignored. */
export const taskAdminPortFor = (
  deps: HttpDeps,
  client: Client,
  discord: DiscordPort,
): TaskAdminPort => ({
  async execute(
    guildId: GuildId,
    accountId: string,
    name: TaskAdminName,
    raw: Record<string, unknown>,
  ) {
    if (!canManageTasks(deps, accountId, guildId)) return refused('Unknown or unreachable guild.');
    // The MCP layer has already Zod-validated the tool-specific shape.
    const a = raw as Args;
    const scope = deps.scopes.forGuild(guildId);
    const now = deps.now();
    const actor = { actorType: 'mcp_operator' as const, actorId: accountId, via: 'http' as const };
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return refused(NOT_AVAILABLE);
    const categoryExists = async (categoryId: string): Promise<boolean> => {
      const channel = await guild.channels.fetch(categoryId).catch(() => null);
      return channel?.type === ChannelType.GuildCategory;
    };
    const roleExists = async (roleId: string): Promise<boolean> =>
      (await discord.fetchRoles(guildId)).some((r) => r.id === roleId);
    const teamFor = (teamId: string) => taskRepo.listTeams(scope).find((t) => t.teamId === teamId);
    const verifyTeam = async (team: {
      categoryId: string;
      leadRoleId: string | null;
      memberRoleId?: string | null;
      announcementChannelId: string | null;
    }): Promise<boolean> => {
      if (!(await categoryExists(team.categoryId))) return false;
      if (team.leadRoleId && !(await roleExists(team.leadRoleId))) return false;
      if (team.memberRoleId && !(await roleExists(team.memberRoleId))) return false;
      if (team.announcementChannelId) {
        const channel = await guild.channels.fetch(team.announcementChannelId).catch(() => null);
        if (
          !channel ||
          channel.parentId !== team.categoryId ||
          (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
        )
          return false;
        // Channel permissions: the digest posts only where Write is allowed.
        if (
          !(await channelAccessFor(client, scope).check('write', team.announcementChannelId))
            .allowed
        )
          return false;
      }
      return true;
    };
    /** Every individual assignee must be a stored team member and a live guild member. */
    const verifyAssignees = async (
      teamId: string,
      assignmentKind: string,
      assigneeId: string | undefined,
      assigneeIds: string[] | undefined,
    ): Promise<string[] | undefined> => {
      const ids = assigneeIds ?? (assigneeId ? [assigneeId] : []);
      if ((assignmentKind === 'team') !== (ids.length === 0)) return undefined;
      if (new Set(ids).size !== ids.length) return undefined;
      if (assigneeId !== undefined && assigneeId !== ids[0]) return undefined;
      if (ids.some((id) => !taskBindingRepo.isMember(scope, teamId, id))) return undefined;
      if (ids.length > 0) {
        const live = await Promise.all(
          ids.map((id) => discord.fetchMember(guildId, id).catch(() => undefined)),
        );
        if (ids.some((id, index) => live[index]?.userId !== id)) return undefined;
      }
      return ids;
    };
    const verifyTaskDestination = async (teamId: string, dest: string): Promise<boolean> => {
      const team = teamFor(teamId);
      if (!team || !(await verifyTeam(team))) return false;
      const channel = await deps.portsFor(scope).inspectTaskChannel(dest);
      if (!channel || channel.categoryId !== team.categoryId) return false;
      // Channel permissions: a task posts only where Write is allowed.
      if (!(await channelAccessFor(client, scope).check('write', dest)).allowed) return false;
      return true;
    };
    /** The task's team still resolves live: a deleted category refuses child writes. */
    const verifyTaskTeam = async (taskId: string): Promise<boolean> => {
      const task = taskRepo.getTask(scope, taskId);
      if (!task) return false;
      return verifyTeam(
        teamFor(task.teamId) ?? {
          categoryId: '',
          leadRoleId: null,
          announcementChannelId: null,
        },
      );
    };
    try {
      switch (name) {
        case 'create_task_team': {
          const input = {
            name: a.name,
            categoryId: a.categoryId,
            kind: a.kind,
            ...(a.announcementChannelId ? { announcementChannelId: a.announcementChannelId } : {}),
            ...(a.leadRoleId ? { leadRoleId: a.leadRoleId } : {}),
            ...(a.memberRoleId ? { memberRoleId: a.memberRoleId } : {}),
          };
          if (
            !(await verifyTeam({
              categoryId: a.categoryId,
              announcementChannelId: a.announcementChannelId ?? null,
              leadRoleId: a.leadRoleId ?? null,
              memberRoleId: a.memberRoleId ?? null,
            }))
          )
            return refused(NOT_AVAILABLE);
          try {
            const id = taskRepo.createTeam(scope, input, actor, now);
            return success(`Created team ${id}. No Discord message was sent.`);
          } catch (err) {
            if (err instanceof Error && err.message === 'category-in-use')
              return refused('That category already has a team.');
            throw err;
          }
        }
        case 'configure_task_team': {
          const team = teamFor(a.teamId);
          if (!team) return refused(NOT_AVAILABLE);
          const next = {
            categoryId: team.categoryId,
            announcementChannelId:
              a.announcementChannelId === undefined
                ? team.announcementChannelId
                : a.announcementChannelId,
            leadRoleId: a.leadRoleId === undefined ? team.leadRoleId : a.leadRoleId,
            memberRoleId: a.memberRoleId === undefined ? team.memberRoleId : a.memberRoleId,
          };
          if (!(await verifyTeam(next))) return refused(NOT_AVAILABLE);
          const patch = {
            ...(a.name === undefined ? {} : { name: a.name }),
            ...(a.announcementChannelId === undefined
              ? {}
              : { announcementChannelId: a.announcementChannelId }),
            ...(a.leadRoleId === undefined ? {} : { leadRoleId: a.leadRoleId }),
            ...(a.memberRoleId === undefined ? {} : { memberRoleId: a.memberRoleId }),
          };
          if (!taskRepo.updateTeam(scope, a.teamId, patch, actor, now))
            return refused(NOT_AVAILABLE);
          return success(`Configured team ${a.teamId}.`);
        }
        case 'delete_task_team': {
          const outcome = taskRepo.deleteTeam(scope, a.teamId, actor, now);
          if (outcome === 'has-tasks')
            return refused('Archive or move its tasks first; a team with tasks cannot be deleted.');
          if (outcome === 'not-found') return refused(NOT_AVAILABLE);
          return success(`Deleted team ${a.teamId}.`);
        }
        case 'set_task_president_role': {
          if (!(await roleExists(a.roleId))) return refused(NOT_AVAILABLE);
          taskBindingRepo.setPresidentRole(scope, a.roleId, actor, now);
          return success(`Set president role ${a.roleId}.`);
        }
        case 'clear_task_president_role': {
          taskBindingRepo.clearPresidentRole(scope, actor, now);
          return success('Cleared president role.');
        }
        case 'add_task_team_member': {
          const team = teamFor(a.teamId);
          if (!team || !(await verifyTeam(team))) return refused(NOT_AVAILABLE);
          const member = await discord.fetchMember(guildId, a.discordUserId).catch(() => undefined);
          if (member?.userId !== a.discordUserId) return refused(NOT_AVAILABLE);
          const kind = raw['kind'];
          if (kind !== 'member' && kind !== 'lead') return refused(NOT_AVAILABLE);
          if (kind === 'lead' && (!team.leadRoleId || !member.roleIds.includes(team.leadRoleId)))
            return refused(NOT_AVAILABLE);
          taskBindingRepo.addMembership(scope, team.teamId, a.discordUserId, kind, actor, now);
          return success(`Set ${kind} membership for ${a.discordUserId} in team ${team.teamId}.`);
        }
        case 'remove_task_team_member': {
          taskBindingRepo.removeMembership(scope, a.teamId, a.discordUserId, actor, now);
          return success(`Removed membership if it existed.`);
        }
        case 'create_club_task': {
          const assigneeIds = await verifyAssignees(
            a.teamId,
            a.assignmentKind,
            a.assigneeId,
            a.assigneeIds,
          );
          if (!assigneeIds || !(await verifyTaskDestination(a.teamId, a.destinationId)))
            return refused(NOT_AVAILABLE);
          // Idempotent on the client's request id: a retry names the same row.
          const taskId = taskIdForCreateRequest(guildId, a.requestId);
          const existing = taskRepo.getTask(scope, taskId);
          if (existing)
            return success(
              `Task ${taskId} already exists (version ${existing.version}); nothing new was scheduled.`,
            );
          try {
            const id = taskRepo.createTask(
              scope,
              {
                teamId: a.teamId,
                title: a.title,
                description: a.description,
                priority: a.priority,
                assignmentKind: a.assignmentKind,
                ...(a.assigneeId !== undefined ? { assigneeId: a.assigneeId } : {}),
                assigneeIds,
                dueAt: a.dueAt,
                timezone: a.timezone,
                destinationId: a.destinationId,
                createdBy: accountId,
                ...(a.extraReminderAt !== undefined ? { extraReminderAt: a.extraReminderAt } : {}),
              },
              actor,
              now,
              taskId,
            );
            return success(`Created task ${id} (version 1). ${POSTS_GATE}`);
          } catch (err) {
            if (
              err instanceof Error &&
              (err.message === 'invalid-task-assignees' ||
                err.message === 'invalid-extra-reminder' ||
                err.message === 'unknown-team')
            )
              return refused(NOT_AVAILABLE);
            throw err;
          }
        }
        case 'edit_club_task': {
          const task = taskRepo.getTask(scope, a.taskId);
          if (
            !task ||
            task.archivedAt ||
            task.status === 'done' ||
            task.version !== a.expectedVersion
          )
            return refused(NOT_AVAILABLE);
          const assigneeIds = await verifyAssignees(
            task.teamId,
            a.assignmentKind,
            a.assigneeId,
            a.assigneeIds,
          );
          if (!assigneeIds || !(await verifyTaskDestination(task.teamId, a.destinationId)))
            return refused(NOT_AVAILABLE);
          let outcome: 'ok' | 'stale' | 'anchored-destination';
          try {
            outcome = taskRepo.updateTask(
              scope,
              a.taskId,
              a.expectedVersion,
              {
                title: a.title,
                description: a.description,
                priority: a.priority,
                assignmentKind: a.assignmentKind,
                ...(a.assigneeId !== undefined ? { assigneeId: a.assigneeId } : {}),
                assigneeIds,
                dueAt: a.dueAt,
                timezone: a.timezone,
                destinationId: a.destinationId,
              },
              actor,
              now,
            );
          } catch (err) {
            if (err instanceof Error && err.message === 'invalid-task-assignees')
              return refused(NOT_AVAILABLE);
            throw err;
          }
          if (outcome === 'anchored-destination')
            return refused('This task was announced in its channel; its channel cannot change.');
          if (outcome !== 'ok') return refused(NOT_AVAILABLE);
          return success(`Edited task ${a.taskId} (version ${a.expectedVersion + 1}).`);
        }
        case 'append_task_child': {
          const task = taskRepo.getTask(scope, a.taskId);
          if (
            !task ||
            task.archivedAt ||
            task.status === 'done' ||
            !(await verifyTaskTeam(a.taskId))
          )
            return refused(NOT_AVAILABLE);
          const child = taskRepo.changeChild(
            scope,
            a.taskId,
            a.expectedVersion,
            { kind: 'add', title: a.title, dueAt: a.dueAt },
            actor,
            now,
          );
          if (!child) return refused(NOT_AVAILABLE);
          return success(
            `Appended dated child ${child.childId} to task ${a.taskId} (version ${child.version}).`,
          );
        }
        case 'edit_task_child': {
          if (!(await verifyTaskTeam(a.taskId))) return refused(NOT_AVAILABLE);
          const child = taskRepo.changeChild(
            scope,
            a.taskId,
            a.expectedVersion,
            { kind: 'edit', childId: a.childId, title: a.title, dueAt: a.dueAt },
            actor,
            now,
          );
          if (!child) return refused(NOT_AVAILABLE);
          return success(
            `Edited child ${child.childId} on task ${a.taskId} (version ${child.version}).`,
          );
        }
        case 'complete_task_child': {
          if (!(await verifyTaskTeam(a.taskId))) return refused(NOT_AVAILABLE);
          const child = taskRepo.changeChild(
            scope,
            a.taskId,
            a.expectedVersion,
            { kind: 'complete', childId: a.childId },
            actor,
            now,
          );
          if (!child) return refused(NOT_AVAILABLE);
          return success(
            `Completed child ${child.childId} on task ${a.taskId} (version ${child.version}).`,
          );
        }
        case 'delete_task_child': {
          if (!(await verifyTaskTeam(a.taskId))) return refused(NOT_AVAILABLE);
          const child = taskRepo.changeChild(
            scope,
            a.taskId,
            a.expectedVersion,
            { kind: 'delete', childId: a.childId },
            actor,
            now,
          );
          if (!child) return refused(NOT_AVAILABLE);
          return success(
            `Deleted child ${child.childId} from task ${a.taskId} (version ${child.version}).`,
          );
        }
        case 'record_task_progress': {
          const outcome = taskRepo.recordReport(
            scope,
            a.taskId,
            `mcp:${a.requestId}`,
            accountId,
            a.body,
            actor,
            now,
          );
          if (outcome === 'not-open') return refused(NOT_AVAILABLE);
          if (outcome === 'duplicate') return success('Already recorded.');
          return success(`Recorded progress on task ${a.taskId}. No message was sent.`);
        }
        case 'request_task_completion': {
          const task = taskRepo.getTask(scope, a.taskId);
          if (!task || task.archivedAt || !(await verifyTaskTeam(a.taskId)))
            return refused(NOT_AVAILABLE);
          if (!taskRepo.requestCompletion(scope, a.taskId, a.expectedVersion, actor, now))
            return refused(NOT_AVAILABLE);
          return success(
            `Task ${a.taskId} is awaiting approval (version ${a.expectedVersion + 1}). ${POSTS_GATE}`,
          );
        }
        case 'approve_task_completion': {
          if (!taskRepo.approveTask(scope, a.taskId, a.expectedVersion, actor, now))
            return refused(NOT_AVAILABLE);
          return success(`Approved task ${a.taskId} (version ${a.expectedVersion + 1}).`);
        }
        case 'reject_task_completion': {
          if (!taskRepo.rejectTask(scope, a.taskId, a.expectedVersion, actor, now))
            return refused(NOT_AVAILABLE);
          return success(
            `Sent task ${a.taskId} back to in_progress (version ${a.expectedVersion + 1}).`,
          );
        }
        case 'set_task_status': {
          if (!taskRepo.setStatus(scope, a.taskId, a.expectedVersion, a.status, actor, now))
            return refused(NOT_AVAILABLE);
          return success(
            `Set task ${a.taskId} status to ${a.status} (version ${a.expectedVersion + 1}).`,
          );
        }
        case 'archive_task': {
          if (!taskRepo.archiveTask(scope, a.taskId, a.expectedVersion, actor, now))
            return refused(NOT_AVAILABLE);
          return success(`Archived task ${a.taskId} (version ${a.expectedVersion + 1}).`);
        }
        case 'unarchive_task': {
          if (!taskRepo.unarchiveTask(scope, a.taskId, a.expectedVersion, actor, now))
            return refused(NOT_AVAILABLE);
          return success(`Unarchived task ${a.taskId} (version ${a.expectedVersion + 1}).`);
        }
        case 'delete_club_task': {
          const outcome = taskRepo.deleteTask(scope, a.taskId, a.expectedVersion, actor, now);
          if (outcome !== 'ok') return refused(NOT_AVAILABLE);
          return success(`Deleted task ${a.taskId} and everything that belonged to it.`);
        }
        case 'delete_task_report': {
          if (taskRepo.deleteReport(scope, a.taskId, a.reportId, actor, now) !== 'ok')
            return refused(NOT_AVAILABLE);
          return success(`Deleted progress report ${a.reportId} on task ${a.taskId}.`);
        }
        case 'add_task_reminder': {
          if (a.at <= now) return refused(NOT_AVAILABLE);
          const task = taskRepo.getTask(scope, a.taskId);
          if (
            !task ||
            task.archivedAt !== null ||
            task.status === 'done' ||
            task.status === 'awaiting_approval' ||
            a.at >= task.dueAt
          )
            return refused(NOT_AVAILABLE);
          try {
            // appendCustom writes the 'task.reminder_added' audit row in the same
            // transaction as the slot insert, and writes nothing when the slot exists.
            taskNudgeRepo.appendCustom(scope, a.taskId, a.at, now, actor);
          } catch {
            return refused(NOT_AVAILABLE);
          }
          return success(
            `Custom reminder for task ${a.taskId} scheduled at ${new Date(a.at).toISOString()}. Delivery remains gated by the reminder worker.`,
          );
        }
        case 'cancel_task_reminder': {
          const outcome = taskNudgeRepo.cancelCustom(scope, a.taskId, a.slotId, now);
          if (outcome === 'not-pending')
            return refused('Only a pending custom reminder can be cancelled.');
          effectRepo.recordAudit(scope, {
            at: now,
            actorType: 'mcp_operator',
            actorId: accountId,
            via: 'http',
            action: 'task.reminder_cancelled',
            subjectType: 'club_task',
            subjectId: a.taskId,
            before: { slotId: a.slotId },
            after: undefined,
            dryRun: false,
          });
          return success(`Cancelled custom reminder ${a.slotId} on task ${a.taskId}.`);
        }
        case 'configure_task_quiet_hours': {
          if (a.startMinute === a.endMinute) return refused(NOT_AVAILABLE);
          taskRepo.setQuietHours(
            scope,
            { startMinute: a.startMinute, endMinute: a.endMinute, timezone: a.timezone },
            actor,
            now,
          );
          return success('Quiet hours stored. Delivery remains gated by the reminder send flag.');
        }
      }
    } catch (err) {
      deps.logger.warn(
        safeLogFields({
          component: 'mcp-task',
          guildId,
          tool: name,
          error: err instanceof Error ? err.message.slice(0, 80) : 'unknown',
        }),
        'mcp task admin failed',
      );
      return refused(NOT_AVAILABLE);
    }
  },
});
