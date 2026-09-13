import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { snowflakeIdSchema } from '@bananasaurs/core';
import type { HttpDeps, RouteGuard } from '../server.js';
import { requireCapability } from './capability.js';

/**
 * The dashboard's case and member-history endpoints (Slice 8): the `/cases`
 * list, the `/cases/:caseId` detail page, and the `/members/:memberId`
 * history page.
 *
 * Read-only, like `read.ts` — no audit row, no re-auth, every handler goes
 * through `guard.require` plus `audit.read`. Every answer already exists on
 * `OpsPorts`; this module only authenticates, authorizes, validates the
 * `limit` query and the two path params, and maps a scope-free port call onto
 * the scope `session.scope` already carries.
 */

const casesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const caseIdParamSchema = z.string().uuid();

export const registerCaseRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.get('/api/mod/cases', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;

    const parsed = casesQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    const ports = deps.portsFor(session.scope);
    return reply
      .status(200)
      .send({ cases: ports.listRecentCases({ limit: parsed.data.limit ?? 50 }) });
  });

  app.get<{ Params: { caseId: string } }>('/api/mod/cases/:caseId', (request, reply) => {
    if (!caseIdParamSchema.safeParse(request.params.caseId).success) {
      return reply.status(400).send({ error: 'bad-request' });
    }
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    const detail = ports.findCaseDetail(request.params.caseId);
    if (detail === undefined) return reply.status(404).send({ error: 'not-found' });
    return reply.status(200).send(detail);
  });

  app.get<{ Params: { memberId: string } }>(
    '/api/mod/members/:memberId/cases',
    (request, reply) => {
      if (!snowflakeIdSchema.safeParse(request.params.memberId).success) {
        return reply.status(400).send({ error: 'bad-request' });
      }
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'audit.read', reply)) return reply;

      const ports = deps.portsFor(session.scope);
      return reply.status(200).send({ cases: ports.listCasesForMember(request.params.memberId) });
    },
  );
};
