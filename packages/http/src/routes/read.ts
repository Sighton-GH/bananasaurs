import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HttpDeps, RouteGuard } from '../server.js';
import { requireCapability } from './capability.js';

/**
 * The dashboard's read endpoints (`docs/19` §6.10, `docs/reports/
 * WP5-slice-14-sonnet-handoff.md`).
 *
 * Every answer already exists on `OpsPorts` / `OpsInstance` — `bananasaurs
 * status`, `audit tail`, `log routing list` and `panel list` answer the same
 * questions the CLI does, so nothing here is a new query. This module's whole
 * job is authentication (via `guard`), authorization (via
 * `requireCapability`), and mapping a scope-free `OpsPorts` call onto the
 * scope `session.scope` already carries.
 */

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  sinceMs: z.coerce.number().int().nonnegative().optional(),
});

const jobsQuerySchema = z.object({
  failedOnly: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export const registerReadRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.get('/api/health', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    const now = deps.now();
    return reply.status(200).send({
      guildId: session.scope.guildId,
      guildName: ports.guildName() ?? null,
      gateway: deps.instance.gateway(),
      safety: ports.safetyState(),
      jobCounts: ports.jobCounts(),
      oldestDueJobAtMs: ports.oldestDueJobAtMs(now),
    });
  });

  app.get('/api/log-routes', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'logging.manage', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    return reply.status(200).send({
      routes: ports.listRoutes(),
      excludedChannels: ports.listExcludedChannels(),
    });
  });

  app.get('/api/panels', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'panels.manage', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    return reply.status(200).send(ports.listPanels());
  });

  app.get<{ Params: { id: string } }>('/api/panels/:id', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'panels.manage', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    const panel = ports.findPanel(request.params.id);
    if (panel === undefined) return reply.status(404).send({ error: 'not-found' });
    return reply.status(200).send(panel);
  });

  app.get('/api/audit', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;

    const parsed = auditQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    const ports = deps.portsFor(session.scope);
    return reply
      .status(200)
      .send(ports.tailAudit({ limit: parsed.data.limit ?? 50, sinceMs: parsed.data.sinceMs }));
  });

  app.get('/api/jobs', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.read', reply)) return reply;

    const parsed = jobsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    const ports = deps.portsFor(session.scope);
    return reply.status(200).send(
      ports.listJobs({
        failedOnly: parsed.data.failedOnly ?? false,
        limit: parsed.data.limit ?? 50,
      }),
    );
  });
};
