import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accountRepo, assistantRepo, type GuildScope } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import { dashboardAuditBase } from './audit-base.js';
import { requireCapability } from './capability.js';

/**
 * The daemon's per-request Try-it runner, built in
 * `apps/daemon/src/http/wiring.ts` around the same assistant service the
 * guild runtime uses. Kept out of `HttpDeps` (`server.ts`) on purpose: this
 * route file owns both the dep shape and the handler, so the core server
 * type never mentions the assistant.
 */
export interface TryAssistantDeps {
  readonly tryAssistant?:
    | ((
        scope: GuildScope,
        input: {
          readonly behaviourId: string;
          readonly question: string;
          readonly conversationId?: string | undefined;
          readonly accountUsername: string;
        },
      ) => Promise<{ answer: string; traceId: string; conversationId: string }>)
    | undefined;
}

const TRY_LIMIT = 20;
const TRY_WINDOW_MS = 3_600_000;

/**
 * Try-it rate limit: 20 tries per account per hour, in memory per process
 * and keyed by account id. It resets on restart — a deliberate trade: the
 * limit is abuse friction on a loopback control plane, not a quota, so it
 * needs no durable row. Tests reset it through `resetTryRateLimits`.
 */
const triedAtByAccount = new Map<string, number[]>();
export const resetTryRateLimits = (): void => {
  triedAtByAccount.clear();
};
const tryAllowed = (accountId: string, now: number): boolean => {
  const recent = (triedAtByAccount.get(accountId) ?? []).filter((at) => now - at < TRY_WINDOW_MS);
  if (recent.length >= TRY_LIMIT) {
    triedAtByAccount.set(accountId, recent);
    return false;
  }
  recent.push(now);
  triedAtByAccount.set(accountId, recent);
  return true;
};

/**
 * `POST /api/assistant/behaviours/:id/try` (Task 20): run one behaviour
 * from the dashboard and get its answer plus the stored trace id. Nothing
 * reaches Discord — the service answers with `source: 'dashboard-test'`.
 * `config.write` already authorised the operator, so no caller-role gate
 * applies. Audited as `assistant_behaviour.tried` without the question
 * text (hard rule 4); the trace itself keeps the question, like any other.
 */
export const registerAssistantTryRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps & TryAssistantDeps,
): void => {
  app.post('/api/assistant/behaviours/:id/try', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'config.write', reply)) return reply;
    const id = (request.params as { id: string }).id;
    const parsed = z
      .object({
        question: z.string().trim().min(1).max(2_000),
        conversationId: z.string().min(1).max(128).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const behaviour = assistantRepo.listBehaviours(session.scope).find((item) => item.id === id);
    if (behaviour === undefined) return reply.status(404).send({ error: 'not-found' });
    if (deps.tryAssistant === undefined)
      return reply.status(503).send({ error: 'assistant-try-unavailable' });
    if (!tryAllowed(session.accountId, deps.now()))
      // The dashboard session layer toasts `body.message` when one is
      // present, so the rate limit carries its sentence here rather than
      // leaving the UI to render the raw code.
      return reply.status(429).send({
        error: 'rate-limited',
        message: 'You have used your 20 tries for this hour. Try again later.',
      });
    const username =
      accountRepo.findAccountById(deps.scopes.instance(), session.accountId)?.username ??
      session.accountId;
    let result: { answer: string; traceId: string; conversationId: string };
    try {
      result = await deps.tryAssistant(session.scope, {
        behaviourId: id,
        question: parsed.data.question,
        ...(parsed.data.conversationId === undefined
          ? {}
          : { conversationId: parsed.data.conversationId }),
        accountUsername: username,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message === 'unknown-behaviour') return reply.status(404).send({ error: 'not-found' });
      if (message === 'behaviour-disabled')
        return reply.status(409).send({ error: 'behaviour-disabled' });
      throw err;
    }
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_behaviour.tried',
      subjectType: 'assistant_behaviour',
      subjectId: id,
      before: undefined,
      after: { traceId: result.traceId, conversationId: result.conversationId },
    });
    return reply.status(200).send(result);
  });
};
