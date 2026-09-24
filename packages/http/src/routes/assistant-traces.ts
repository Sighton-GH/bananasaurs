import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authorize } from '@bananasaurs/core';
import { authzStoreFor, traceRepo } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import type { SessionContext } from '../auth.js';
import { requireCapability } from './capability.js';

/**
 * The History endpoints (ADR 0076): the trace list, one trace, and the
 * 14-day usage strip.
 *
 * Read-only, like `cases.ts` — no audit row, no re-auth, every handler goes
 * through `guard.require` plus `audit.read`. The prompt sections are the one
 * exception: their exact text needs `config.read`, checked with the
 * non-replying `authorize` so a viewer without it still gets the run with the
 * text withheld (empty string), never a 403.
 */

const traceListQuerySchema = z.object({
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  outcome: z.enum(['answered', 'refused', 'failed']).optional(),
  behaviourId: z.string().min(1).max(64).optional(),
  userId: z.string().min(1).max(64).optional(),
});

const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
});

const DAY_MS = 24 * 60 * 60 * 1000;

const canReadPromptText = (session: SessionContext): boolean =>
  authorize(
    { store: authzStoreFor(session.scope), guildId: session.guildId, actor: session.actor },
    'config.read',
  ).ok;

export const registerAssistantTraceRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.get('/api/assistant/traces', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;

    const parsed = traceListQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });
    const limit = parsed.data.limit ?? 50;
    const traces = traceRepo.listTraces(session.scope, {
      ...(parsed.data.before === undefined ? {} : { before: parsed.data.before }),
      limit,
      ...(parsed.data.outcome === undefined ? {} : { outcome: parsed.data.outcome }),
      ...(parsed.data.behaviourId === undefined ? {} : { behaviourId: parsed.data.behaviourId }),
      ...(parsed.data.userId === undefined ? {} : { userId: parsed.data.userId }),
    });
    // Resolve who each user id is from live Discord, in one bulk fetch per
    // page; a member Discord no longer knows comes back null and the table
    // shows the bare id rather than a guess.
    const ports = deps.portsFor(session.scope);
    const directory = new Map(
      (await ports.fetchGuildMembers(traces.map((t) => t.userId))).map((m) => [m.memberId, m]),
    );
    const oldest = traces.at(-1);
    return reply.status(200).send({
      traces: traces.map((t) => ({ ...t, member: directory.get(t.userId) ?? null })),
      ...(traces.length === limit && oldest !== undefined ? { nextBefore: oldest.at } : {}),
    });
  });

  app.get<{ Params: { traceId: string } }>(
    '/api/assistant/traces/:traceId',
    async (request, reply) => {
      const session = guard.require(request, reply);
      if (session === undefined) return reply;
      if (!requireCapability(session, 'audit.read', reply)) return reply;

      const trace = traceRepo.getTrace(session.scope, request.params.traceId);
      if (trace === undefined) return reply.status(404).send({ error: 'not-found' });
      const showText = canReadPromptText(session);
      const ports = deps.portsFor(session.scope);
      const [member] = await ports.fetchGuildMembers([trace.userId]);
      return reply.status(200).send({
        trace: {
          ...trace,
          sections: trace.sections.map((s) => ({ ...s, text: showText ? s.text : '' })),
        },
        member: member ?? null,
      });
    },
  );

  app.get('/api/assistant/usage', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;

    const parsed = usageQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });
    // The strip renders one bar per day, so the answer carries the whole
    // window — oldest first, quiet days as zeros — rather than only the days
    // with runs.
    const days = parsed.data.days ?? 14;
    const counts = new Map(
      traceRepo.dailyUsage(session.scope, deps.now() - days * DAY_MS).map((d) => [d.day, d]),
    );
    return reply.status(200).send({
      days: Array.from({ length: days }, (_, i) => {
        const day = new Date(deps.now() - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10);
        return counts.get(day) ?? { day, answers: 0, failures: 0, fallbacks: 0, tokens: 0 };
      }),
    });
  });
};
