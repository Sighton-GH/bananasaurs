import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { snowflakeIdSchema, LOG_EVENT_KINDS } from '@bananasaurs/core';
import type { HttpDeps, RouteGuard } from '../server.js';
import { dashboardAuditBase } from './audit-base.js';
import { requireCapability } from './capability.js';

/**
 * The dashboard's two write endpoints (`docs/19` §6.10; `docs/decisions/
 * 0031-dashboard-audit-attribution.md` for the audit row shape).
 *
 * Neither goes through `createDispatcher` — it resolves guilds from a
 * CLI-shaped request and hard-codes `actorType: 'operator_cli'` in its own
 * audit row, so an HTTP request routed through it would misattribute itself.
 * Each handler here constructs its own `OpsAuditWrite` and calls
 * `ports.recordAudit` directly.
 */

const killswitchBodySchema = z.object({ on: z.boolean() });

const eventKindSchema = z.string().refine(
  (k) => LOG_EVENT_KINDS.includes(k),
  (k) => ({
    message: `no such log event kind: ${k}`,
  }),
);

const logRouteBodySchema = z.object({
  eventKind: eventKindSchema,
  channelId: snowflakeIdSchema,
  includeContent: z.boolean(),
});

export const registerWriteRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.post('/api/killswitch', (request, reply) => {
    const parsed = killswitchBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

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

    const parsed = logRouteBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });

    const ports = deps.portsFor(session.scope);
    const before = ports.listRoutes().find((r) => r.eventKind === parsed.data.eventKind);
    ports.setRoute(parsed.data);
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'log_route.set',
      subjectType: 'log_route',
      subjectId: parsed.data.eventKind,
      before:
        before === undefined
          ? undefined
          : {
              channelId: before.channelId,
              includeContent: before.includeContent,
              enabled: before.enabled,
            },
      after: {
        channelId: parsed.data.channelId,
        includeContent: parsed.data.includeContent,
        enabled: true,
      },
    });

    return reply.status(200).send({ ok: true });
  });
};
