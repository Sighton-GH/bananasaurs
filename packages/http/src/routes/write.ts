import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logRouteIdSchema, logRouteInputSchema } from '@bananasaurs/core';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import { dashboardAuditBase } from './audit-base.js';
import { requireCapability } from './capability.js';

/**
 * The dashboard's logging write endpoints (`docs/19` §6.10; `docs/decisions/
 * 0031-dashboard-audit-attribution.md` for the audit row shape) — create,
 * update and delete for the named routes (ADR 0123), beside the killswitch.
 *
 * None goes through `createDispatcher` — it resolves guilds from a
 * CLI-shaped request and hard-codes `actorType: 'operator_cli'` in its own
 * audit row, so an HTTP request routed through it would misattribute itself.
 * Each handler here constructs its own `OpsAuditWrite` and calls
 * `ports.recordAudit` directly. The enabled toggle lives in `ops-write.ts`
 * beside the other operator-command mirrors.
 */

const killswitchBodySchema = z.object({ on: z.boolean() });

/**
 * The audited shape of a route: the same projection the operator CLI writes
 * into its `before`/`after`, so the two trails read the same.
 */
const routeAuditShape = (route: {
  readonly name: string;
  readonly channelId: string;
  readonly includeContent: boolean;
  readonly enabled: boolean;
  readonly eventKinds: readonly string[];
  readonly excludedChannelIds: readonly string[];
}): Record<string, unknown> => ({
  name: route.name,
  channelId: route.channelId,
  includeContent: route.includeContent,
  enabled: route.enabled,
  eventKinds: [...route.eventKinds],
  excludedChannelIds: [...route.excludedChannelIds],
});

export const registerWriteRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.post('/api/killswitch', (request, reply) => {
    const parsed = killswitchBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    // The asymmetry is ADR 0029, not an oversight: the control that stops the
    // bot must never be harder to reach than the one that starts it, so only
    // *disabling* needs a fresh password.
    const session = parsed.data.on
      ? guard.require(request, reply)
      : guard.requireFresh(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'killswitch.toggle', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    const before = ports.safetyState();
    ports.setKillswitch(parsed.data.on);
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: parsed.data.on ? 'killswitch.enabled' : 'killswitch.disabled',
      subjectType: 'guild',
      subjectId: session.guildId,
      before: before === undefined ? undefined : { killswitch: before.killswitch },
      after: { killswitch: parsed.data.on },
    });

    return reply.status(200).send({ ok: true, killswitch: parsed.data.on });
  });

  app.post('/api/log-routes', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'logging.manage', reply)) return reply;

    const parsed = logRouteInputSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const ports = deps.portsFor(session.scope);
    const route = ports.createRoute({ ...parsed.data, enabled: parsed.data.enabled ?? true });
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'log_route.created',
      subjectType: 'log_route',
      subjectId: route.routeId,
      before: undefined,
      after: routeAuditShape(route),
    });

    return reply.status(201).send({ ok: true, route });
  });

  app.put<{ Params: { routeId: string } }>('/api/log-routes/:routeId', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'logging.manage', reply)) return reply;

    const id = logRouteIdSchema.safeParse(request.params.routeId);
    if (!id.success) return badRequest(reply, id.error);
    const parsed = logRouteInputSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);

    const ports = deps.portsFor(session.scope);
    const before = ports.getRoute(id.data);
    if (before === undefined) return reply.status(404).send({ error: 'not-found' });
    const route = ports.updateRoute(id.data, {
      ...parsed.data,
      enabled: parsed.data.enabled ?? before.enabled,
    });
    if (route === undefined) return reply.status(404).send({ error: 'not-found' });
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'log_route.updated',
      subjectType: 'log_route',
      subjectId: route.routeId,
      before: routeAuditShape(before),
      after: routeAuditShape(route),
    });

    return reply.status(200).send({ ok: true, route });
  });

  app.delete<{ Params: { routeId: string } }>('/api/log-routes/:routeId', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'logging.manage', reply)) return reply;

    const id = logRouteIdSchema.safeParse(request.params.routeId);
    if (!id.success) return badRequest(reply, id.error);

    const ports = deps.portsFor(session.scope);
    const before = ports.getRoute(id.data);
    if (before === undefined) return reply.status(404).send({ error: 'not-found' });
    ports.deleteRoute(id.data);
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'log_route.deleted',
      subjectType: 'log_route',
      subjectId: id.data,
      before: routeAuditShape(before),
      after: undefined,
    });

    return reply.status(200).send({ ok: true });
  });
};
