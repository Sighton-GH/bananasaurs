/**
 * The dashboard's guild-wide automod switch (ADR 0121).
 *
 * One three-position switch, not a per-rule machine: `GET` reports the
 * position beside the enabled rules the On confirmation names, `PUT` moves
 * it. More action needs a fresh password; less action and re-sending the
 * current position do not.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OpsAutomodState } from '@bananasaurs/core';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import { dashboardAuditBase } from './audit-base.js';
import { requireCapability } from './capability.js';

const automodStateBodySchema = z.object({ state: z.enum(['off', 'watch', 'on']) });

const RANK: Record<OpsAutomodState, number> = { off: 0, watch: 1, on: 2 };

export const registerAutomodStateRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.get('/api/automod/state', (request, reply) => {
    const signedIn = guard.require(request, reply);
    if (signedIn === undefined) return reply;
    if (!requireCapability(signedIn, 'config.read', reply)) return reply;

    const ports = deps.portsFor(signedIn.scope);
    const before = ports.safetyState();
    if (before === undefined) return reply.status(404).send({ error: 'not-found' });
    const enabledRules = ports.listEnabledAutomodRuleNames();
    return reply.status(200).send({
      ok: true,
      state: before.automodState,
      enabledRules: enabledRules.map((rule) => ({ ruleId: rule.ruleId, name: rule.name })),
    });
  });

  app.put('/api/automod/state', (request, reply) => {
    const parsed = automodStateBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const next = parsed.data.state;

    const signedIn = guard.require(request, reply);
    if (signedIn === undefined) return reply;

    const before = deps.portsFor(signedIn.scope).safetyState();
    if (before === undefined) return reply.status(404).send({ error: 'not-found' });
    // Re-sending the current position changes nothing, so it is not audited.
    if (before.automodState === next) return reply.status(200).send({ ok: true, state: next });

    const session =
      RANK[next] > (RANK[before.automodState] ?? 0) ? guard.requireFresh(request, reply) : signedIn;
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;

    const ports = deps.portsFor(session.scope);
    ports.setAutomodState(next);
    ports.recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'automod.state_set',
      subjectType: 'guild',
      subjectId: session.guildId,
      before: { state: before.automodState },
      after: { state: next },
    });
    return reply.status(200).send({ ok: true, state: next });
  });
};
