import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { describeRun, type RunEvent } from '@bananasaurs/core';
import { runRepo } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import { canReadConfig, requireCapability } from './capability.js';

/**
 * The live run ledger endpoints (ADR 0129 §6–7): the active and recent run
 * list, one run, and one run's incremental step log.
 *
 * Read-only, like `assistant-traces.ts` — every handler goes through
 * `guard.require` plus `audit.read`. A `model-result` event's
 * `providerMessage` is configuration-shaped text, so it needs `config.read`,
 * checked with the non-replying `authorize` so a viewer without it still gets
 * the events with the text withheld, never a 403.
 */

const runListQuerySchema = z.object({
  active: z.enum(['0', '1']).optional(),
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const runEventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const registerAssistantRunRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.get('/api/assistant/runs', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;

    const parsed = runListQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const limit = parsed.data.limit ?? 20;
    const runs = runRepo.listRuns(session.scope, {
      active: parsed.data.active === '1',
      ...(parsed.data.before === undefined ? {} : { before: parsed.data.before }),
      limit,
    });
    // Queue positions come from one active-list read per request: the queued
    // runs ordered by when they arrived, so "N ahead" is the count of queued
    // runs with an earlier `queuedAt`.
    const activeRuns = runRepo.listRuns(session.scope, { active: true, limit: 100 });
    const now = deps.now();
    const labelled = runs.map((run) => {
      const queueAhead =
        run.state === 'queued'
          ? activeRuns.filter((other) => other.state === 'queued' && other.queuedAt < run.queuedAt)
              .length
          : 0;
      // Only runs doing model or tool work need their step log, and only the
      // newest model-call or tool-call in it. Bounded by the page limit, so
      // one small read per such row; acceptable at this scale.
      let lastEvent: RunEvent | undefined = undefined;
      if (run.stage === 'calling-model' || run.stage === 'running-tool') {
        const events = runRepo.listRunEvents(session.scope, run.runId, 0, 500);
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const candidate = events[i]?.event;
          if (candidate?.kind === 'model-call' || candidate?.kind === 'tool-call') {
            lastEvent = candidate;
            break;
          }
        }
      }
      return {
        run,
        label: describeRun(run, {
          now,
          queueAhead,
          ...(lastEvent === undefined ? {} : { lastEvent }),
        }),
      };
    });
    // Resolve who each user id is from live Discord, in one bulk fetch per
    // page; a member Discord no longer knows comes back null and the table
    // shows the bare id rather than a guess.
    const ports = deps.portsFor(session.scope);
    const directory = new Map(
      (await ports.fetchGuildMembers([...new Set(runs.map((r) => r.userId))])).map((m) => [
        m.memberId,
        m,
      ]),
    );
    const oldest = runs.at(-1);
    return reply.status(200).send({
      runs: labelled.map(({ run, label }) => ({
        ...run,
        ...label,
        member: directory.get(run.userId) ?? null,
      })),
      ...(runs.length === limit && oldest !== undefined ? { nextBefore: oldest.updatedAt } : {}),
    });
  });

  app.get<{ Params: { runId: string } }>('/api/assistant/runs/:runId', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;

    const run = runRepo.getRun(session.scope, request.params.runId);
    if (run === undefined) return reply.status(404).send({ error: 'not-found' });
    const now = deps.now();
    let queueAhead = 0;
    if (run.state === 'queued') {
      const activeRuns = runRepo.listRuns(session.scope, { active: true, limit: 100 });
      queueAhead = activeRuns.filter(
        (other) => other.state === 'queued' && other.queuedAt < run.queuedAt,
      ).length;
    }
    let lastEvent: RunEvent | undefined = undefined;
    if (run.stage === 'calling-model' || run.stage === 'running-tool') {
      const events = runRepo.listRunEvents(session.scope, run.runId, 0, 500);
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const candidate = events[i]?.event;
        if (candidate?.kind === 'model-call' || candidate?.kind === 'tool-call') {
          lastEvent = candidate;
          break;
        }
      }
    }
    return reply.status(200).send({
      run: {
        ...run,
        ...describeRun(run, { now, queueAhead, ...(lastEvent === undefined ? {} : { lastEvent }) }),
      },
    });
  });

  app.get<{ Params: { runId: string } }>('/api/assistant/runs/:runId/events', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;

    const parsed = runEventsQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const run = runRepo.getRun(session.scope, request.params.runId);
    if (run === undefined) return reply.status(404).send({ error: 'not-found' });
    const events = runRepo.listRunEvents(
      session.scope,
      request.params.runId,
      parsed.data.after ?? 0,
      parsed.data.limit ?? 200,
    );
    // ADR 0129 §3: the provider's short error message is
    // configuration-shaped text — withheld without config.read.
    const showText = canReadConfig(session);
    if (!showText) {
      for (const row of events) {
        if (row.event.kind === 'model-result' && row.event.providerMessage !== undefined) {
          delete row.event.providerMessage;
        }
      }
    }
    return reply.status(200).send({ events });
  });
};
