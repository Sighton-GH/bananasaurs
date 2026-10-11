import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eligibilityRepo } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import { dashboardAuditBase } from './audit-base.js';
import { isInstanceOwner } from './assistant.js';

const checkBody = z.object({ position: z.number().int().min(0) }).strict();

const TERMS_REFUSAL =
  "The AI provider's terms are not recorded or don't allow this use, so no content was sent outside the server.";

type FirstAction = 'answer-without-tools' | 'call-tool';

/** Fixture id, member-safe message, and the expected first action of the checked entry. */
export const CHECK_FIXTURES: readonly {
  readonly id: string;
  readonly message: string;
  readonly expectedFirstAction: FirstAction;
}[] = [
  { id: 'greeting-light', message: 'hi', expectedFirstAction: 'answer-without-tools' },
  { id: 'reminder-standard', message: 'remind me at 5', expectedFirstAction: 'call-tool' },
  { id: 'attachment-standard', message: 'look at this', expectedFirstAction: 'call-tool' },
];

/**
 * Declarations only. The route offers these so the model can choose a first
 * action, but it never runs a tool: a returned tool call is only recorded.
 */
const STUB_TOOLS = [
  {
    name: 'list_sources',
    description: 'Stub: list the knowledge sources.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'read_chunk',
    description: 'Stub: read one chunk of a source.',
    parameters: { type: 'object', properties: { id: { type: 'string' } } },
  },
] as const;

/** The check calls the provider with tools, which the narrower `HttpDeps` type omits. */
interface CheckProvider {
  generateText(request: {
    readonly model: string;
    readonly messages: readonly { readonly role: 'user'; readonly text: string }[];
    readonly tools: typeof STUB_TOOLS;
  }): Promise<{ readonly text: string; readonly toolCalls?: readonly unknown[] }>;
}

export const registerAssistantModelCheckRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.post('/api/assistant/model-check', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!isInstanceOwner(deps, session)) return reply.status(403).send({ error: 'owner-only' });
    const configured = deps.assistantProviderConfig;
    if (configured?.chain === undefined) {
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    }
    const parsed = checkBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const resolved = configured.chain()[parsed.data.position];
    // Pin the selected key, model and provider before reservations can change pool usage.
    const entry = resolved === undefined ? undefined : { ...resolved };
    if (entry === undefined) return reply.status(404).send({ error: 'not-found' });
    const refuse = () => reply.status(200).send({ ok: false, error: TERMS_REFUSAL });
    if (entry.skip === 'ineligible' || entry.skip === 'unverified') return refuse();
    if (entry.provider === undefined || entry.skip !== undefined) {
      return reply
        .status(200)
        .send({ ok: false, error: 'entry-unusable', skip: entry.skip ?? 'no-key' });
    }
    const terms = eligibilityRepo.findEligibility(deps.scopes.instance(), entry.providerId);
    if (terms === undefined || !terms.productionUseAllowed) return refuse();

    // Budget equals the fixture count and is reserved before the first call.
    const budget = CHECK_FIXTURES.length;
    const budgetRefusal = () =>
      reply.status(200).send({
        ok: false,
        error: 'budget-exhausted',
        budget: { reserved: 0, spent: 0 },
      });
    if (configured.reserveTestEntry === undefined) return budgetRefusal();
    try {
      const reservations: unknown[] = [];
      for (const fixture of CHECK_FIXTURES) {
        void fixture;
        // Promise.resolve keeps a rejecting reserver inside this try.
        reservations.push(
          await Promise.resolve(configured.reserveTestEntry?.(entry, session.guildId)),
        );
      }
      if (
        reservations.some((reserved) => (reserved as { ok?: unknown } | undefined)?.ok !== true)
      ) {
        // No release API exists; any successful reservations remain spent.
        return budgetRefusal();
      }
    } catch {
      // Reserver errors may include secrets. Never forward or log their text.
      return budgetRefusal();
    }

    const provider = entry.provider as unknown as CheckProvider;
    const results: {
      id: string;
      expectedFirstAction: FirstAction;
      firstAction: FirstAction | 'error';
      matches: boolean;
      error?: string;
    }[] = [];
    let spent = 0;
    for (const fixture of CHECK_FIXTURES) {
      spent += 1;
      try {
        const out = await provider.generateText({
          model: entry.model,
          messages: [{ role: 'user', text: fixture.message }],
          tools: STUB_TOOLS,
        });
        const firstAction: FirstAction =
          (out.toolCalls?.length ?? 0) > 0 ? 'call-tool' : 'answer-without-tools';
        results.push({
          id: fixture.id,
          expectedFirstAction: fixture.expectedFirstAction,
          firstAction,
          matches: firstAction === fixture.expectedFirstAction,
        });
      } catch {
        results.push({
          id: fixture.id,
          expectedFirstAction: fixture.expectedFirstAction,
          firstAction: 'error',
          matches: false,
          error: 'The model did not answer this check.',
        });
      }
    }

    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_provider.model_checked',
      subjectType: 'assistant_provider',
      subjectId: 'active',
      before: undefined,
      after: { position: parsed.data.position, fixtureCount: budget },
    });
    return reply.status(200).send({
      ok: true,
      results,
      budget: { reserved: budget, spent },
      ledgerSource: 'dashboard-test',
    });
  });
};
