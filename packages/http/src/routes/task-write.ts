import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { snowflakeIdSchema, timeZoneSchema } from '@bananasaurs/core';
import { taskBindingRepo, taskRepo, taskNudgeRepo } from '@bananasaurs/storage';
import { badRequest } from '../errors/reply.js';
import { canManageTasks } from '../owner.js';
import type { HttpDeps, RouteGuard } from '../server.js';
import { dashboardAuditBase } from './audit-base.js';
import { inspectTaskDestination, inspectTaskTeam } from './task-validation.js';

const teamSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    categoryId: snowflakeIdSchema,
    kind: z.enum(['subteam', 'exec']),
    announcementChannelId: snowflakeIdSchema.optional(),
    leadRoleId: snowflakeIdSchema.optional(),
    memberRoleId: snowflakeIdSchema.optional(),
  })
  .strict();
const teamEditSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    announcementChannelId: snowflakeIdSchema.nullable().optional(),
    leadRoleId: snowflakeIdSchema.nullable().optional(),
    memberRoleId: snowflakeIdSchema.nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'at least one field is required');
const taskSchema = z
  .object({
    teamId: z.string().uuid(),
    title: z.string().trim().min(1).max(180),
    description: z.string().max(5000).optional(),
    priority: z.enum(['normal', 'urgent']).optional(),
    assignmentKind: z.enum(['team', 'individual']),
    assigneeId: snowflakeIdSchema.optional(),
    assigneeIds: z.array(snowflakeIdSchema).min(1).max(25).optional(),
    dueAt: z.number().int().positive(),
    timezone: timeZoneSchema,
    destinationId: snowflakeIdSchema,
    extraReminderAt: z.array(z.number().int().positive()).max(20).optional(),
  })
  .strict();
const taskEditSchema = taskSchema
  .omit({ teamId: true, extraReminderAt: true })
  .extend({ version: z.number().int().positive() });
const membershipSchema = z
  .object({
    teamId: z.string().uuid(),
    discordUserId: snowflakeIdSchema,
    kind: z.enum(['member', 'lead']),
  })
  .strict();
const childSchema = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(180),
    dueAt: z.number().int().positive(),
  })
  .strict();

/** Owner setup is still staged: writes store validated records but never post
 * to Discord. No client-supplied actor or guild is accepted. */
export const registerTaskWriteRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.put('/api/tasks/president-role', (request, reply) => {
    const session = guard.require(request, reply);
    if (!session) return reply;
    if (!canManageTasks(deps, session)) return reply.status(403).send({ error: 'tasks-forbidden' });
    const actor = {
      actorType: 'dashboard' as const,
      actorId: session.accountId,
      via: 'http' as const,
    };
    const parsed = z.object({ roleId: snowflakeIdSchema }).strict().safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    if (
      !deps
        .portsFor(session.scope)
        .listGuildRoles()
        .some((r) => r.roleId === parsed.data.roleId)
    )
      return reply.status(409).send({ error: 'president-role-not-verified' });
    taskBindingRepo.setPresidentRole(session.scope, parsed.data.roleId, actor, deps.now());
    return reply.send({ roleId: parsed.data.roleId });
  });
  app.delete('/api/tasks/president-role', (request, reply) => {
    const session = guard.require(request, reply);
    if (!session) return reply;
    if (!canManageTasks(deps, session)) return reply.status(403).send({ error: 'tasks-forbidden' });
    const actor = {
      actorType: 'dashboard' as const,
      actorId: session.accountId,
      via: 'http' as const,
    };
    taskBindingRepo.clearPresidentRole(session.scope, actor, deps.now());
    return reply.status(204).send();
  });
  app.post('/api/tasks/teams', (request, reply) => {
    const session = guard.require(request, reply);
    if (!session) return reply;
    if (!canManageTasks(deps, session)) return reply.status(403).send({ error: 'tasks-forbidden' });
    const parsed = teamSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const issues = inspectTaskTeam(deps.portsFor(session.scope), parsed.data);
    if (issues.length) return reply.status(409).send({ error: 'team-not-verified', issues });
    const actor = {
      actorType: 'dashboard' as const,
      actorId: session.accountId,
      via: 'http' as const,
    };
    try {
      const teamId = taskRepo.createTeam(session.scope, parsed.data, actor, deps.now());
      return reply.status(201).send({ teamId });
    } catch (err) {
      if (err instanceof Error && err.message === 'category-in-use')
        return reply.status(409).send({ error: 'category-in-use' });
      throw err;
    }
  });
  app.put<{ Params: { teamId: string } }>('/api/tasks/teams/:teamId', (request, reply) => {
    const session = guard.require(request, reply);
    if (!session) return reply;
    if (!canManageTasks(deps, session)) return reply.status(403).send({ error: 'tasks-forbidden' });
    const parsed = teamEditSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const current = taskRepo
      .listTeams(session.scope)
      .find((t) => t.teamId === request.params.teamId);
    if (!current) return reply.status(404).send({ error: 'team-not-found' });
    const resulting = {
      name: parsed.data.name ?? current.name,
      categoryId: current.categoryId,
      kind: current.kind as 'subteam' | 'exec',
      ...(parsed.data.announcementChannelId !== undefined
        ? parsed.data.announcementChannelId === null
          ? {}
          : { announcementChannelId: parsed.data.announcementChannelId }
        : current.announcementChannelId
          ? { announcementChannelId: current.announcementChannelId }
          : {}),
      ...(parsed.data.leadRoleId !== undefined
        ? parsed.data.leadRoleId === null
          ? {}
          : { leadRoleId: parsed.data.leadRoleId }
        : current.leadRoleId
          ? { leadRoleId: current.leadRoleId }
          : {}),
      ...(parsed.data.memberRoleId !== undefined
        ? parsed.data.memberRoleId === null
          ? {}
          : { memberRoleId: parsed.data.memberRoleId }
        : current.memberRoleId
          ? { memberRoleId: current.memberRoleId }
          : {}),
    };
    const issues = inspectTaskTeam(deps.portsFor(session.scope), resulting);
    if (issues.length) return reply.status(409).send({ error: 'team-not-verified', issues });
    const actor = {
      actorType: 'dashboard' as const,
      actorId: session.accountId,
      via: 'http' as const,
    };
    if (!taskRepo.updateTeam(session.scope, current.teamId, parsed.data, actor, deps.now()))
      return reply.status(404).send({ error: 'team-not-found' });
    return reply.send({
      team: taskRepo.listTeams(session.scope).find((t) => t.teamId === current.teamId),
    });
  });
  app.delete<{ Params: { teamId: string } }>('/api/tasks/teams/:teamId', (request, reply) => {
    const session = guard.require(request, reply);
    if (!session) return reply;
    if (!canManageTasks(deps, session)) return reply.status(403).send({ error: 'tasks-forbidden' });
    const actor = {
      actorType: 'dashboard' as const,
      actorId: session.accountId,
      via: 'http' as const,
    };
    const outcome = taskRepo.deleteTeam(session.scope, request.params.teamId, actor, deps.now());
    if (outcome === 'has-tasks') return reply.status(409).send({ error: 'team-has-tasks' });
    if (outcome === 'not-found') return reply.status(404).send({ error: 'team-not-found' });
    return reply.status(204).send();
  });
  app.delete<{ Params: { teamId: string; discordUserId: string } }>(
    '/api/tasks/memberships/:teamId/:discordUserId',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (!session) return reply;
      if (!canManageTasks(deps, session))
        return reply.status(403).send({ error: 'tasks-forbidden' });
      if (
        !z.string().uuid().safeParse(request.params.teamId).success ||
        !snowflakeIdSchema.safeParse(request.params.discordUserId).success
      )
        return reply.status(400).send({ error: 'invalid-membership-id' });
      taskBindingRepo.removeMembership(
        session.scope,
        request.params.teamId,
        request.params.discordUserId,
        { actorType: 'dashboard', actorId: session.accountId, via: 'http' },
        deps.now(),
      );
      return reply.status(204).send();
    },
  );
  app.post('/api/tasks/memberships', async (request, reply) => {
    const session = guard.require(request, reply);
    if (!session) return reply;
    if (!canManageTasks(deps, session)) return reply.status(403).send({ error: 'tasks-forbidden' });
    const parsed = membershipSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const team = taskRepo.listTeams(session.scope).find((t) => t.teamId === parsed.data.teamId);
    if (!team) return reply.status(404).send({ error: 'team-not-found' });
    const [member] = await deps
      .portsFor(session.scope)
      .fetchGuildMembers([parsed.data.discordUserId]);
    if (!member) return reply.status(409).send({ error: 'discord-member-not-verified' });
    if (
      parsed.data.kind === 'lead' &&
      (!team.leadRoleId || !member.roleIds.includes(team.leadRoleId))
    )
      return reply.status(409).send({ error: 'lead-role-not-verified' });
    taskBindingRepo.addMembership(
      session.scope,
      team.teamId,
      member.memberId,
      parsed.data.kind,
      { actorType: 'dashboard', actorId: session.accountId, via: 'http' },
      deps.now(),
    );
    return reply.status(200).send({ ok: true });
  });
  app.post('/api/tasks', async (request, reply) => {
    const session = guard.require(request, reply);
    if (!session) return reply;
    if (!canManageTasks(deps, session)) return reply.status(403).send({ error: 'tasks-forbidden' });
    const parsed = taskSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const team = taskRepo.listTeams(session.scope).find((t) => t.teamId === parsed.data.teamId);
    if (!team) return reply.status(404).send({ error: 'team-not-found' });
    const assigneeIds =
      parsed.data.assigneeIds ?? (parsed.data.assigneeId ? [parsed.data.assigneeId] : []);
    if (
      (parsed.data.assignmentKind === 'team') !== (assigneeIds.length === 0) ||
      new Set(assigneeIds).size !== assigneeIds.length ||
      (parsed.data.assigneeId && parsed.data.assigneeId !== assigneeIds[0])
    )
      return reply.status(400).send({ error: 'assignee-mismatch' });
    if (assigneeIds.some((id) => !taskBindingRepo.isMember(session.scope, team.teamId, id)))
      return reply.status(409).send({ error: 'assignee-not-in-team' });
    if (assigneeIds.length) {
      const live = await deps.portsFor(session.scope).fetchGuildMembers(assigneeIds);
      if (assigneeIds.some((id) => !live.some((member) => member.memberId === id)))
        return reply.status(409).send({ error: 'assignee-not-in-guild' });
    }
    const teamInput = {
      name: team.name,
      categoryId: team.categoryId,
      kind: team.kind as 'subteam' | 'exec',
    };
    const input = { ...parsed.data, assigneeIds, createdBy: session.accountId };
    const teamIssues = inspectTaskTeam(deps.portsFor(session.scope), teamInput);
    if (teamIssues.length)
      return reply.status(409).send({ error: 'team-not-verified', issues: teamIssues });
    const issues = await inspectTaskDestination(deps.portsFor(session.scope), teamInput, input);
    if (issues.length) return reply.status(409).send({ error: 'destination-not-verified', issues });
    const actor = {
      actorType: 'dashboard' as const,
      actorId: session.accountId,
      via: 'http' as const,
    };
    try {
      const taskId = taskRepo.createTask(session.scope, input, actor, deps.now());
      return reply.status(201).send({ taskId });
    } catch (err) {
      if (err instanceof Error && err.message === 'invalid-extra-reminder')
        return reply.status(400).send({ error: 'invalid-extra-reminder' });
      throw err;
    }
  });
  app.put<{ Params: { taskId: string } }>('/api/tasks/:taskId', async (request, reply) => {
    const session = guard.require(request, reply);
    if (!session) return reply;
    if (!canManageTasks(deps, session)) return reply.status(403).send({ error: 'tasks-forbidden' });
    const parsed = taskEditSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const task = taskRepo.getTask(session.scope, request.params.taskId);
    if (!task || task.archivedAt || task.status === 'done')
      return reply.status(404).send({ error: 'task-not-open' });
    if (task.version !== parsed.data.version)
      return reply.status(409).send({ error: 'stale-task-version' });
    const team = taskRepo.listTeams(session.scope).find((t) => t.teamId === task.teamId);
    if (!team) return reply.status(409).send({ error: 'team-not-verified' });
    const ports = deps.portsFor(session.scope);
    const teamInput = {
      name: team.name,
      categoryId: team.categoryId,
      kind: team.kind as 'subteam' | 'exec',
      ...(team.leadRoleId ? { leadRoleId: team.leadRoleId } : {}),
      ...(team.announcementChannelId ? { announcementChannelId: team.announcementChannelId } : {}),
    };
    const teamIssues = inspectTaskTeam(ports, teamInput);
    if (teamIssues.length)
      return reply.status(409).send({ error: 'team-not-verified', issues: teamIssues });
    const { version, ...edit } = parsed.data;
    if (!edit.assigneeIds && taskRepo.listTaskAssignees(session.scope, task.taskId).length > 1)
      return reply.status(409).send({ error: 'assignee-list-required' });
    const assigneeIds = edit.assigneeIds ?? (edit.assigneeId ? [edit.assigneeId] : []);
    if (
      (edit.assignmentKind === 'team') !== (assigneeIds.length === 0) ||
      new Set(assigneeIds).size !== assigneeIds.length ||
      (edit.assigneeId && edit.assigneeId !== assigneeIds[0])
    )
      return reply.status(400).send({ error: 'assignee-mismatch' });
    if (assigneeIds.some((id) => !taskBindingRepo.isMember(session.scope, team.teamId, id)))
      return reply.status(409).send({ error: 'assignee-not-in-team' });
    if (assigneeIds.length) {
      const live = await ports.fetchGuildMembers(assigneeIds);
      if (assigneeIds.some((id) => !live.some((member) => member.memberId === id)))
        return reply.status(409).send({ error: 'assignee-not-in-guild' });
    }
    const issues = await inspectTaskDestination(ports, teamInput, {
      ...edit,
      teamId: team.teamId,
      createdBy: session.accountId,
    });
    if (issues.length) return reply.status(409).send({ error: 'destination-not-verified', issues });
    const outcome = taskRepo.updateTask(
      session.scope,
      task.taskId,
      version,
      { ...edit, assigneeIds },
      { actorType: 'dashboard', actorId: session.accountId, via: 'http' },
      deps.now(),
    );
    if (outcome === 'anchored-destination')
      return reply.status(409).send({ error: 'task-anchored-destination' });
    if (outcome === 'stale') return reply.status(409).send({ error: 'stale-task-version' });
    return reply.send({ task: taskRepo.getTask(session.scope, task.taskId) });
  });
  const childEditSchema = childSchema;
  const versionSchema = z.object({ version: z.number().int().positive() }).strict();
  const lifecycle = (action: 'approve' | 'reject' | 'status' | 'archive' | 'unarchive'): void => {
    const path = action === 'status' ? '/api/tasks/:taskId/status' : `/api/tasks/:taskId/${action}`;
    const schema =
      action === 'status'
        ? z
            .object({
              version: z.number().int().positive(),
              status: z.enum(['not_started', 'in_progress']),
            })
            .strict()
        : versionSchema;
    app.post<{ Params: { taskId: string } }>(path, (request, reply) => {
      const session = guard.require(request, reply);
      if (!session) return reply;
      if (!canManageTasks(deps, session))
        return reply.status(403).send({ error: 'tasks-forbidden' });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      if (!taskRepo.getTask(session.scope, request.params.taskId))
        return reply.status(404).send({ error: 'task-not-found' });
      const actor = {
        actorType: 'dashboard' as const,
        actorId: session.accountId,
        via: 'http' as const,
      };
      const now = deps.now();
      const version = parsed.data.version;
      const status = (parsed.data as { status?: 'not_started' | 'in_progress' }).status;
      const taskId = request.params.taskId;
      const write: Record<typeof action, () => boolean> = {
        approve: () => taskRepo.approveTask(session.scope, taskId, version, actor, now),
        reject: () => taskRepo.rejectTask(session.scope, taskId, version, actor, now),
        archive: () => taskRepo.archiveTask(session.scope, taskId, version, actor, now),
        unarchive: () => taskRepo.unarchiveTask(session.scope, taskId, version, actor, now),
        status: () =>
          status === undefined
            ? false
            : taskRepo.setStatus(session.scope, taskId, version, status, actor, now),
      };
      if (!write[action]()) return reply.status(409).send({ error: 'stale-task-version' });
      return reply.send({ task: taskRepo.getTask(session.scope, request.params.taskId) });
    });
  };
  lifecycle('approve');
  lifecycle('reject');
  lifecycle('status');
  lifecycle('archive');
  lifecycle('unarchive');
  app.post<{ Params: { taskId: string; childId: string } }>(
    '/api/tasks/:taskId/children/:childId/complete',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (!session) return reply;
      if (!canManageTasks(deps, session))
        return reply.status(403).send({ error: 'tasks-forbidden' });
      const parsed = versionSchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      if (!taskRepo.getTask(session.scope, request.params.taskId))
        return reply.status(404).send({ error: 'task-not-found' });
      const result = taskRepo.changeChild(
        session.scope,
        request.params.taskId,
        parsed.data.version,
        { kind: 'complete', childId: request.params.childId },
        { actorType: 'dashboard', actorId: session.accountId, via: 'http' },
        deps.now(),
      );
      if (!result) return reply.status(409).send({ error: 'child-not-current' });
      return reply.send(result);
    },
  );
  app.put<{ Params: { taskId: string; childId: string } }>(
    '/api/tasks/:taskId/children/:childId',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (!session) return reply;
      if (!canManageTasks(deps, session))
        return reply.status(403).send({ error: 'tasks-forbidden' });
      const parsed = childEditSchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const result = taskRepo.changeChild(
        session.scope,
        request.params.taskId,
        parsed.data.version,
        {
          kind: 'edit',
          childId: request.params.childId,
          title: parsed.data.title,
          dueAt: parsed.data.dueAt,
        },
        { actorType: 'dashboard', actorId: session.accountId, via: 'http' },
        deps.now(),
      );
      if (!result) return reply.status(409).send({ error: 'child-not-current' });
      return reply.send(result);
    },
  );
  app.delete<{ Params: { taskId: string; childId: string } }>(
    '/api/tasks/:taskId/children/:childId',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (!session) return reply;
      if (!canManageTasks(deps, session))
        return reply.status(403).send({ error: 'tasks-forbidden' });
      const parsed = z
        .object({ version: z.number().int().positive() })
        .strict()
        .safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const result = taskRepo.changeChild(
        session.scope,
        request.params.taskId,
        parsed.data.version,
        { kind: 'delete', childId: request.params.childId },
        { actorType: 'dashboard', actorId: session.accountId, via: 'http' },
        deps.now(),
      );
      if (!result) return reply.status(409).send({ error: 'child-not-current' });
      return reply.send(result);
    },
  );
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/reminders', (request, reply) => {
    const session = guard.require(request, reply);
    if (!session) return reply;
    if (!canManageTasks(deps, session)) return reply.status(403).send({ error: 'tasks-forbidden' });
    const parsed = z.object({ at: z.number().int().positive() }).strict().safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const task = taskRepo.getTask(session.scope, request.params.taskId);
    if (
      !task ||
      task.archivedAt !== null ||
      task.status === 'done' ||
      task.status === 'awaiting_approval'
    )
      return reply.status(404).send({ error: 'task-not-open' });
    if (parsed.data.at <= deps.now() || parsed.data.at >= task.dueAt)
      return reply.status(400).send({ error: 'invalid-extra-reminder' });
    const actor = {
      actorType: 'dashboard' as const,
      actorId: session.accountId,
      via: 'http' as const,
    };
    // appendCustom writes the 'task.reminder_added' audit row in the same
    // transaction as the slot insert, and writes nothing when the slot exists.
    taskNudgeRepo.appendCustom(session.scope, task.taskId, parsed.data.at, deps.now(), actor);
    return reply.status(201).send({ taskId: task.taskId, at: parsed.data.at });
  });
  app.delete<{ Params: { taskId: string; slotId: string } }>(
    '/api/tasks/:taskId/reminders/:slotId',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (!session) return reply;
      if (!canManageTasks(deps, session))
        return reply.status(403).send({ error: 'tasks-forbidden' });
      const outcome = taskNudgeRepo.cancelCustom(
        session.scope,
        request.params.taskId,
        request.params.slotId,
        deps.now(),
      );
      if (outcome === 'not-pending')
        return reply.status(409).send({ error: 'reminder-not-pending' });
      deps.portsFor(session.scope).recordAudit({
        ...dashboardAuditBase(session, deps.now()),
        action: 'task.reminder_cancelled',
        subjectType: 'club_task',
        subjectId: request.params.taskId,
        before: { slotId: request.params.slotId },
        after: undefined,
      });
      return reply.status(204).send();
    },
  );
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/children', (request, reply) => {
    const session = guard.require(request, reply);
    if (!session) return reply;
    if (!canManageTasks(deps, session)) return reply.status(403).send({ error: 'tasks-forbidden' });
    const parsed = childSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const task = taskRepo.getTask(session.scope, request.params.taskId);
    if (!task || task.archivedAt || task.status === 'done')
      return reply.status(404).send({ error: 'task-not-open' });
    const result = taskRepo.changeChild(
      session.scope,
      task.taskId,
      parsed.data.version,
      { kind: 'add', title: parsed.data.title, dueAt: parsed.data.dueAt },
      { actorType: 'dashboard', actorId: session.accountId, via: 'http' },
      deps.now(),
    );
    if (!result) return reply.status(409).send({ error: 'stale-task-version' });
    return reply.status(201).send(result);
  });
  app.delete<{ Params: { taskId: string } }>('/api/tasks/:taskId', (request, reply) => {
    const session = guard.require(request, reply);
    if (!session) return reply;
    if (!canManageTasks(deps, session)) return reply.status(403).send({ error: 'tasks-forbidden' });
    const parsed = versionSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const actor = {
      actorType: 'dashboard' as const,
      actorId: session.accountId,
      via: 'http' as const,
    };
    const outcome = taskRepo.deleteTask(
      session.scope,
      request.params.taskId,
      parsed.data.version,
      actor,
      deps.now(),
    );
    if (outcome === 'missing') return reply.status(404).send({ error: 'task-not-found' });
    if (outcome === 'stale') return reply.status(409).send({ error: 'stale-task-version' });
    return reply.status(204).send();
  });
  app.delete<{ Params: { taskId: string; reportId: string } }>(
    '/api/tasks/:taskId/reports/:reportId',
    (request, reply) => {
      const session = guard.require(request, reply);
      if (!session) return reply;
      if (!canManageTasks(deps, session))
        return reply.status(403).send({ error: 'tasks-forbidden' });
      const actor = {
        actorType: 'dashboard' as const,
        actorId: session.accountId,
        via: 'http' as const,
      };
      const outcome = taskRepo.deleteReport(
        session.scope,
        request.params.taskId,
        request.params.reportId,
        actor,
        deps.now(),
      );
      if (outcome === 'missing') return reply.status(404).send({ error: 'task-report-not-found' });
      return reply.status(204).send();
    },
  );
};
