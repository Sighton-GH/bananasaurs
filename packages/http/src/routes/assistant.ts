import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CLUB_ASSISTANT_SKILLS, validateResourceUrl } from '@bananasaurs/core';
import { assistantRepo } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import { requireCapability } from './capability.js';

const snowflake = z.string().regex(/^\d{17,20}$/);
const behaviour = z.object({
  id: z.string().min(1).max(64),
  surface: z.enum(['bananasaurs', 'it-services', 'help', 'direct-command']),
  mentionRoleId: snowflake.optional(),
  name: z.string().min(1).max(100),
  systemPrompt: z.string().min(1).max(4000),
  allowedSkillIds: z.array(z.string()).max(20),
  callerRoleIds: z.array(snowflake).max(100),
  ticketChannelId: snowflake.optional(),
  reviewerRoleIds: z.array(snowflake).max(100),
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
  app.get('/api/assistant', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;
    return reply.status(200).send({
      behaviours: assistantRepo.listBehaviours(session.scope),
      resources: assistantRepo.listResources(session.scope),
      reminders: assistantRepo.listReminders(session.scope),
      skills: CLUB_ASSISTANT_SKILLS,
      activity: assistantRepo.listSkillActivity(session.scope, 100),
    });
  });
  app.put('/api/assistant/behaviours/:id', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const parsed = behaviour.safeParse(request.body);
    if (!parsed.success || parsed.data.id !== (request.params as { id: string }).id)
      return reply.status(400).send({ error: 'bad-request' });
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
        allowedSkillIds: parsed.data.allowedSkillIds,
        callerRoleIds: parsed.data.callerRoleIds,
        ...(parsed.data.ticketChannelId === undefined
          ? {}
          : { ticketChannelId: parsed.data.ticketChannelId }),
        reviewerRoleIds: parsed.data.reviewerRoleIds,
        resourceIds: parsed.data.resourceIds,
        enabled: parsed.data.enabled,
      },
      deps.now(),
    );
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
    assistantRepo.putResource(session.scope, { ...parsed.data, guildId: session.guildId });
    return reply.status(200).send({ ok: true });
  });
};
