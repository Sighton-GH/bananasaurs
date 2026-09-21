import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CLUB_ASSISTANT_SKILLS, validateResourceUrl } from '@bananasaurs/core';
import { assistantRepo } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import { dashboardAuditBase } from './audit-base.js';
import { requireCapability } from './capability.js';

const snowflake = z.string().regex(/^\d{17,20}$/);
const behaviour = z.object({
  id: z.string().min(1).max(64),
  surface: z.enum(['bananasaurs', 'it-services', 'help', 'direct-command']),
  mentionRoleId: snowflake.optional(),
  name: z.string().min(1).max(100),
  systemPrompt: z.string().min(1).max(4000),
  promptVersion: z.number().int().min(0),
  allowedSkillIds: z
    .array(z.enum(CLUB_ASSISTANT_SKILLS.map((skill) => skill.id) as [string, ...string[]]))
    .max(CLUB_ASSISTANT_SKILLS.length),
  callerRoleIds: z.array(snowflake).max(100),
  ticket: z
    .object({
      channelId: snowflake.optional(),
      reviewerRoleIds: z.array(snowflake).max(100).optional(),
    })
    .optional(),
  resourceIds: z.array(z.string()).max(100),
  enabled: z.boolean(),
});
const resource = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  url: z.string().url(),
  kind: z.enum(['website', 'document', 'discord-channel', 'repository', 'note']),
  enabled: z.boolean(),
  reviewedAt: z.string().datetime(),
});
export const registerAssistantRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.get('/api/assistant', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;
    const directories =
      deps.assistantDirectories === undefined
        ? undefined
        : await deps.assistantDirectories(session.guildId).catch(() => undefined);
    return reply.status(200).send({
      behaviours: assistantRepo.listBehaviours(session.scope).map((item) => ({
        ...item,
        ticket: {
          ...(item.ticketChannelId === undefined ? {} : { channelId: item.ticketChannelId }),
          reviewerRoleIds: item.reviewerRoleIds,
        },
      })),
      resources: assistantRepo.listResources(session.scope),
      reminders: assistantRepo.listReminders(session.scope),
      skills: CLUB_ASSISTANT_SKILLS,
      activity: assistantRepo.listSkillActivity(session.scope, 100),
      skillGrants: assistantRepo.listSkillGrants(session.scope),
      tickets: assistantRepo.listTickets(session.scope),
      decisions: assistantRepo.listDecisions(session.scope),
      ...(directories ?? {}),
    });
  });
  app.put('/api/assistant/behaviours/:id', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const parsed = behaviour.safeParse(request.body);
    if (!parsed.success || parsed.data.id !== (request.params as { id: string }).id)
      return reply.status(400).send({ error: 'bad-request' });
    const existing = assistantRepo
      .listBehaviours(session.scope)
      .find((item) => item.id === parsed.data.id);
    if (existing !== undefined && existing.promptVersion !== parsed.data.promptVersion)
      return reply
        .status(409)
        .send({ error: 'prompt-version-conflict', currentVersion: existing.promptVersion });
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: existing === undefined ? 'assistant_behaviour.created' : 'assistant_behaviour.saved',
      subjectType: 'assistant_behaviour',
      subjectId: parsed.data.id,
      before:
        existing === undefined
          ? undefined
          : { promptVersion: existing.promptVersion, enabled: existing.enabled },
      after: {
        name: parsed.data.name,
        surface: parsed.data.surface,
        enabled: parsed.data.enabled,
        allowedSkillIds: parsed.data.allowedSkillIds,
        callerRoleIds: parsed.data.callerRoleIds,
        resourceIds: parsed.data.resourceIds,
        mentionRoleId: parsed.data.mentionRoleId ?? null,
        ticketChannelId: parsed.data.ticket?.channelId ?? null,
        reviewerRoleIds: parsed.data.ticket?.reviewerRoleIds ?? [],
        systemPrompt: parsed.data.systemPrompt,
      },
    });
    assistantRepo.putBehaviour(
      session.scope,
      {
        id: parsed.data.id,
        guildId: session.guildId,
        surface: parsed.data.surface,
        ...(parsed.data.mentionRoleId === undefined
          ? {}
          : { mentionRoleId: parsed.data.mentionRoleId }),
        name: parsed.data.name,
        systemPrompt: parsed.data.systemPrompt,
        promptVersion: (existing?.promptVersion ?? 0) + 1,
        allowedSkillIds: parsed.data.allowedSkillIds,
        callerRoleIds: parsed.data.callerRoleIds,
        ...(parsed.data.ticket?.channelId === undefined
          ? {}
          : { ticketChannelId: parsed.data.ticket.channelId }),
        reviewerRoleIds: parsed.data.ticket?.reviewerRoleIds ?? [],
        resourceIds: parsed.data.resourceIds,
        enabled: parsed.data.enabled,
      },
      deps.now(),
    );
    return reply.status(200).send({ ok: true });
  });
  app.put('/api/assistant/skill-grants/:id', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const id = (request.params as { id: string }).id;
    const parsed = z
      .object({ roleIds: z.array(snowflake).max(100), userIds: z.array(snowflake).max(100) })
      .safeParse(request.body);
    const skill = CLUB_ASSISTANT_SKILLS.find((item) => item.id === id);
    if (!parsed.success || skill === undefined || skill.ownerOnly === true)
      return reply.status(400).send({ error: 'bad-request' });
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_skill_grant.saved',
      subjectType: 'assistant_skill_grant',
      subjectId: id,
      before: (() => {
        const grant = assistantRepo
          .listSkillGrants(session.scope)
          .find((item) => item.skillId === id);
        return grant === undefined ? undefined : { roleIds: grant.roleIds, userIds: grant.userIds };
      })(),
      after: { roleIds: parsed.data.roleIds, userIds: parsed.data.userIds },
    });
    assistantRepo.putSkillGrant(session.scope, { skillId: id, ...parsed.data }, deps.now());
    return reply.status(200).send({ ok: true });
  });
  app.post('/api/assistant/reminders/:id/cancel', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const id = (request.params as { id: string }).id;
    const reminder = assistantRepo.listReminders(session.scope).find((item) => item.id === id);
    if (!assistantRepo.cancelReminder(session.scope, id))
      return reply.status(409).send({ error: 'invalid-transition' });
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_reminder.cancelled',
      subjectType: 'assistant_reminder',
      subjectId: id,
      before:
        reminder === undefined
          ? undefined
          : { text: reminder.text, dueAt: reminder.dueAt, status: reminder.status },
      after: { status: 'cancelled' },
    });
    return reply.status(200).send({ ok: true });
  });
  app.post('/api/assistant/decisions/:id/review', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const id = (request.params as { id: string }).id;
    if (!assistantRepo.transitionDecision(session.scope, id, 'draft', 'reviewed'))
      return reply.status(409).send({ error: 'invalid-transition' });
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_decision.reviewed',
      subjectType: 'assistant_decision',
      subjectId: id,
      before: { status: 'draft' },
      after: { status: 'reviewed' },
    });
    return reply.status(200).send({ ok: true });
  });
  app.post('/api/assistant/decisions/:id/save', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const id = (request.params as { id: string }).id;
    if (!assistantRepo.transitionDecision(session.scope, id, 'reviewed', 'saved'))
      return reply.status(409).send({ error: 'invalid-transition' });
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_decision.saved',
      subjectType: 'assistant_decision',
      subjectId: id,
      before: { status: 'reviewed' },
      after: { status: 'saved' },
    });
    return reply.status(200).send({ ok: true });
  });
  app.put('/api/assistant/resources/:id', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const parsed = resource.safeParse(request.body);
    if (!parsed.success || parsed.data.id !== (request.params as { id: string }).id)
      return reply.status(400).send({ error: 'bad-request' });
    try {
      validateResourceUrl(parsed.data.url);
    } catch {
      return reply.status(400).send({ error: 'unsafe-resource-url' });
    }
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_resource.saved',
      subjectType: 'assistant_resource',
      subjectId: parsed.data.id,
      before: (() => {
        const existing = assistantRepo
          .listResources(session.scope)
          .find((item) => item.id === parsed.data.id);
        return existing === undefined
          ? undefined
          : {
              title: existing.title,
              url: existing.url,
              kind: existing.kind,
              enabled: existing.enabled,
            };
      })(),
      after: {
        title: parsed.data.title,
        url: parsed.data.url,
        kind: parsed.data.kind,
        enabled: parsed.data.enabled,
      },
    });
    assistantRepo.putResource(session.scope, { ...parsed.data, guildId: session.guildId });
    return reply.status(200).send({ ok: true });
  });
};
