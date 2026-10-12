import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROVIDER_FAILURE_CODES, PROVIDER_FAILURE_TEXT } from '@bananasaurs/core';
import { runRepo, traceRepo } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import { canReadConfig, requireCapability } from './capability.js';

/**
 * The History endpoints (ADR 0076): the trace list, one trace, and the
 * 14-day usage strip.
 *
 * Read-only, like `cases.ts` — no audit row, no re-auth, every handler goes
 * through `guard.require` plus `audit.read`. Prompt sections and saved
 * reasoning also need `config.read`, checked with `canReadConfig` so a
 * viewer without it still gets the run with section text withheld (empty
 * string) and reasoning omitted, never a 403.
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
    if (!parsed.success) return badRequest(reply, parsed.error);
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
      const showText = canReadConfig(session);
      const ports = deps.portsFor(session.scope);
      const [member] = await ports.fetchGuildMembers([trace.userId]);
      return reply.status(200).send({
        trace: {
          traceId: trace.traceId,
          runId: trace.runId,
          at: trace.at,
          userId: trace.userId,
          channelId: trace.channelId,
          behaviourId: trace.behaviourId,
          command: trace.command,
          source: trace.source,
          conversationId: trace.conversationId,
          turnId: trace.turnId,
          question: trace.question,
          answer: trace.answer,
          outcome: trace.outcome,
          durationMs: trace.durationMs,
          finishReason: trace.finishReason,
          usage: trace.usage,
          toolCalls: trace.toolCalls,
          // Undefined is omitted from the serialized body, including the key.
          reasoning: showText ? trace.reasoning : undefined,
          guard: trace.guard,
          included: trace.included,
          timeline: trace.timeline,
          error: trace.error,
          discordMessageIds: trace.discordMessageIds,
          sources: trace.sources,
          flags: trace.flags,
          sections: trace.sections.map((s) => ({ ...s, text: showText ? s.text : '' })),
          attempts: trace.attempts.map((a) => {
            // ADR 0129 §3: the provider's short error message is
            // configuration-shaped text — withheld without config.read.
            const attempt = { ...a };
            if (!showText) delete attempt.providerMessage;
            return {
              ...attempt,
              ...(a.code !== undefined &&
              (PROVIDER_FAILURE_CODES as readonly string[]).includes(a.code)
                ? {
                    explain:
                      PROVIDER_FAILURE_TEXT[a.code as (typeof PROVIDER_FAILURE_CODES)[number]],
                  }
                : {}),
            };
          }),
        },
        member: member ?? null,
        // ADR 0129 §5: the journal window around the run, so the trace
        // page can print a copyable journalctl command.
        journal: {
          since: new Date(trace.at - trace.durationMs - 5000).toISOString(),
          until: new Date(trace.at + 5000).toISOString(),
        },
      });
    },
  );

  app.get('/api/assistant/usage', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;

    const parsed = usageQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    // The strip renders one bar per day, so the answer carries the whole
    // window — oldest first, quiet days as zeros — rather than only the days
    // with runs.
    const days = parsed.data.days ?? 14;
    const counts = new Map(
      traceRepo.dailyUsage(session.scope, deps.now() - days * DAY_MS).map((d) => [d.day, d]),
    );
    // ADR 0129 §8: per-day ledger stats from the model-result steps — a failed
    // result counts in its code bucket, every result adds its tokens to its
    // model bucket. Grouped by UTC day, like the usage strip itself.
    const failuresByDay = new Map<string, Record<string, number>>();
    const tokensByDay = new Map<string, Record<string, number>>();
    for (const r of runRepo.modelResultsSince(session.scope, deps.now() - days * DAY_MS)) {
      const day = new Date(r.at).toISOString().slice(0, 10);
      if (!r.ok) {
        const failures = failuresByDay.get(day) ?? {};
        const code = r.code ?? 'unknown';
        failures[code] = (failures[code] ?? 0) + 1;
        failuresByDay.set(day, failures);
      }
      const tokens = tokensByDay.get(day) ?? {};
      tokens[r.model] = (tokens[r.model] ?? 0) + (r.tokens ?? 0);
      tokensByDay.set(day, tokens);
    }
    return reply.status(200).send({
      days: Array.from({ length: days }, (_, i) => {
        const day = new Date(deps.now() - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10);
        return {
          ...(counts.get(day) ?? { day, answers: 0, failures: 0, fallbacks: 0, tokens: 0 }),
          failuresByCode: failuresByDay.get(day) ?? {},
          tokensByModel: tokensByDay.get(day) ?? {},
        };
      }),
    });
  });
};
