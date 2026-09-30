import type { FastifyInstance } from 'fastify';
import { taskRepo, taskBindingRepo, taskNudgeRepo, type GuildScope } from '@bananasaurs/storage';
import { isInstanceOwner } from '../owner.js';
import { inspectTaskTeam } from './task-validation.js';
import type { HttpDeps, RouteGuard } from '../server.js';

const NO_TEAM_ROLE_WARNING = 'No team role set; whole-team tasks will not ping anyone';

/** Dashboard task reads are owner-only by design. Members use Discord. */
export const registerTaskRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.get('/api/tasks', (request, reply) => {
    const session = guard.require(request, reply);
    if (!session) return reply;
    if (!isInstanceOwner(deps, session)) return reply.status(403).send({ error: 'owner-only' });
    const include = (request.query as { include?: string } | undefined)?.include
      ?.split(',')
      .map((part) => part.trim());
    return reply.send({
      teams: taskRepo.listTeams(session.scope),
      tasks: taskRepo
        .listTasks(session.scope, {
          includeDone: include?.includes('done') ?? false,
          includeArchived: include?.includes('archived') ?? false,
        })
        .map((task) => ({
          ...task,
          assigneeIds: taskRepo.listTaskAssignees(session.scope, task.taskId),
        })),
      presidentRoleId: taskBindingRepo.presidentRoleId(session.scope) ?? null,
    });
  });
  app.get<{ Params: { teamId: string } }>(
    '/api/tasks/teams/:teamId/assignees',
    async (request, reply) => {
      const session = guard.require(request, reply);
      if (!session) return reply;
      if (!isInstanceOwner(deps, session)) return reply.status(403).send({ error: 'owner-only' });
      const team = taskRepo
        .listTeams(session.scope)
        .find((t) => t.teamId === request.params.teamId);
      if (!team) return reply.status(404).send({ error: 'team-not-found' });
      const ports = deps.portsFor(session.scope);
      if (
        inspectTaskTeam(ports, {
          name: team.name,
          categoryId: team.categoryId,
          kind: team.kind as 'subteam' | 'exec',
          ...(team.leadRoleId ? { leadRoleId: team.leadRoleId } : {}),
          ...(team.announcementChannelId
            ? { announcementChannelId: team.announcementChannelId }
            : {}),
        }).length
      )
        return reply.status(409).send({ error: 'team-not-verified' });
      const members = taskBindingRepo.listTeamMemberships(session.scope, team.teamId);
      const live = await ports.fetchGuildMembers(members.map((m) => m.discordUserId));
      return reply.send({
        assignees: live
          .filter((m) => members.some((stored) => stored.discordUserId === m.memberId))
          .map((m) => ({ memberId: m.memberId, displayName: m.displayName })),
      });
    },
  );
  app.get<{ Params: { teamId: string } }>(
    '/api/tasks/teams/:teamId/destinations',
    async (request, reply) => {
      const session = guard.require(request, reply);
      if (!session) return reply;
      if (!isInstanceOwner(deps, session)) return reply.status(403).send({ error: 'owner-only' });
      const team = taskRepo
        .listTeams(session.scope)
        .find((t) => t.teamId === request.params.teamId);
      if (!team) return reply.status(404).send({ error: 'team-not-found' });
      return reply.send({
        destinations: await deps.portsFor(session.scope).listTaskDestinations(team.categoryId),
      });
    },
  );
  app.get<{ Params: { teamId: string } }>(
    '/api/tasks/teams/:teamId/members',
    async (request, reply) => {
      const session = guard.require(request, reply);
      if (!session) return reply;
      if (!isInstanceOwner(deps, session)) return reply.status(403).send({ error: 'owner-only' });
      const team = taskRepo
        .listTeams(session.scope)
        .find((t) => t.teamId === request.params.teamId);
      if (!team) return reply.status(404).send({ error: 'team-not-found' });
      const stored = taskBindingRepo.listTeamMemberships(session.scope, team.teamId);
      const live = await deps
        .portsFor(session.scope)
        .fetchGuildMembers(stored.map((m) => m.discordUserId));
      return reply.send({
        members: stored.map((member) => ({
          discordUserId: member.discordUserId,
          kind: member.kind,
          displayName: live.find((m) => m.memberId === member.discordUserId)?.displayName ?? null,
        })),
      });
    },
  );
  app.get<{ Params: { taskId: string } }>('/api/tasks/:taskId/reminders', (request, reply) => {
    const session = guard.require(request, reply);
    if (!session) return reply;
    if (!isInstanceOwner(deps, session)) return reply.status(403).send({ error: 'owner-only' });
    if (!taskRepo.getTask(session.scope, request.params.taskId))
      return reply.status(404).send({ error: 'task-not-found' });
    return reply.send({ reminders: listReminders(session.scope, request.params.taskId) });
  });
  app.get('/api/tasks/setup', (request, reply) => {
    const session = guard.require(request, reply);
    if (!session) return reply;
    if (!isInstanceOwner(deps, session)) return reply.status(403).send({ error: 'owner-only' });
    const ports = deps.portsFor(session.scope);
    const presidentRoleId = taskBindingRepo.presidentRoleId(session.scope) ?? null;
    const teams = taskRepo.listTeams(session.scope).map((team) => ({
      teamId: team.teamId,
      name: team.name,
      categoryId: team.categoryId,
      issues: [
        ...inspectTaskTeam(ports, {
          name: team.name,
          categoryId: team.categoryId,
          kind: team.kind as 'subteam' | 'exec',
          ...(team.announcementChannelId
            ? { announcementChannelId: team.announcementChannelId }
            : {}),
          ...(team.leadRoleId ? { leadRoleId: team.leadRoleId } : {}),
        }),
        ...(team.memberRoleId ? [] : [NO_TEAM_ROLE_WARNING]),
        ...(team.kind === 'subteam' && !team.leadRoleId && !presidentRoleId
          ? [
              `Nobody can approve ${team.name} tasks in Discord: set a lead role or the president role.`,
            ]
          : []),
        ...(team.kind === 'exec' && !presidentRoleId
          ? [`Nobody can approve ${team.name} tasks in Discord: set the president role.`]
          : []),
      ],
    }));
    const presidentRoles = ports.listGuildRoles();
    return reply.send({
      teams,
      presidentRoleCandidates: presidentRoles.map((r) => ({ roleId: r.roleId, name: r.name })),
      presidentRoleId,
    });
  });
  app.get<{ Params: { taskId: string } }>('/api/tasks/:taskId', (request, reply) => {
    const session = guard.require(request, reply);
    if (!session) return reply;
    // Check authority before looking up even the existence of a task.
    if (!isInstanceOwner(deps, session)) return reply.status(404).send({ error: 'not-found' });
    const task = taskRepo.getTask(session.scope, request.params.taskId);
    if (!task) return reply.status(404).send({ error: 'not-found' });
    const team = taskRepo.listTeams(session.scope).find((t) => t.teamId === task.teamId);
    return reply.send({
      task: { ...task, assigneeIds: taskRepo.listTaskAssignees(session.scope, task.taskId) },
      children: taskRepo.listChildren(session.scope, task.taskId),
      reports: taskRepo.listReports(session.scope, task.taskId),
      reminders: listReminders(session.scope, task.taskId),
      team: team ?? null,
    });
  });
};

const listReminders = (scope: GuildScope, taskId: string) =>
  taskNudgeRepo.reminderSlotsForTask(scope, taskId).map((slot) => ({
    slotId: slot.slotId,
    kind: slot.kind,
    dueAt: slot.dueAt,
    state: slot.state,
  }));
