import type { TaskAudience, TaskCardView, TaskStatus } from '@bananasaurs/core';
import { taskRepo, type GuildScope } from '@bananasaurs/storage';

/** Who a task is for: its assignees, its team's member role, or the whole team without a ping. */
export const audienceFor = (
  scope: GuildScope,
  task: { taskId: string; assignmentKind: string },
  team: { memberRoleId: string | null } | undefined,
): TaskAudience => {
  if (task.assignmentKind === 'individual')
    return { kind: 'users', userIds: taskRepo.listTaskAssignees(scope, task.taskId) };
  return team?.memberRoleId ? { kind: 'role', roleId: team.memberRoleId } : { kind: 'team' };
};

/** Everything `renderTaskCard` needs, or undefined when the task has no card to show. */
export const taskCardView = (
  scope: GuildScope,
  taskId: string,
  now: number,
  variant: 'announce' | 'refresh',
): TaskCardView | undefined => {
  const task = taskRepo.getTask(scope, taskId);
  if (!task || task.archivedAt !== null) return undefined;
  const team = taskRepo.listTeams(scope).find((t) => t.teamId === task.teamId);
  if (!team) return undefined;
  const reports = taskRepo.listReports(scope, taskId);
  const latest = reports.reduce<(typeof reports)[number] | undefined>(
    (best, r) => (best === undefined || r.createdAt > best.createdAt ? r : best),
    undefined,
  );
  const pickup = taskRepo.lastPickup(scope, taskId);
  return {
    taskId,
    version: task.version,
    title: task.title,
    description: task.description,
    teamName: team.name,
    status: task.status as TaskStatus,
    priority: task.priority === 'urgent' ? 'urgent' : 'normal',
    dueAt: task.dueAt,
    now,
    audience: audienceFor(scope, task, team),
    links: taskRepo.listTaskLinks(scope, taskId),
    ...(pickup === undefined ? {} : { pickedUp: { userId: pickup.actorId, at: pickup.at } }),
    ...(latest === undefined
      ? {}
      : { lastUpdate: { authorId: latest.authorId, at: latest.createdAt, body: latest.body } }),
    updatedAt: task.updatedAt,
    variant,
  };
};
