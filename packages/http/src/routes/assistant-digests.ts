import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { digestRepo } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import { requireCapability } from './capability.js';

/**
 * The Daily digest endpoints (ADR 0150 decision 4): the digest list under
 * Conversations and one digest. Reads go through `audit.read`, like
 * transcripts — a digest summarises member conversations.
 */

const dayParamSchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export const registerAssistantDigests = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  void deps;
  app.get('/api/assistant/digests', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;
    return reply.status(200).send({ digests: digestRepo.listDigests(session.scope, 100) });
  });

  app.get<{ Params: { day: string } }>('/api/assistant/digests/:day', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;
    const parsed = dayParamSchema.safeParse(request.params);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const digest = digestRepo.getDigest(session.scope, parsed.data.day);
    if (digest === undefined) return reply.status(404).send({ error: 'not-found' });
    return reply.status(200).send({
      digest: {
        day: digest.day,
        daySummary: digest.summary.daySummary,
        proposals: digest.summary.memoryProposals,
        conversations: digest.conversations,
        createdAt: digest.createdAt,
        updatedAt: digest.updatedAt,
      },
    });
  });
};
