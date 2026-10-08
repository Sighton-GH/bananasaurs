import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { modelHealth } from '@bananasaurs/core';
import { runRepo } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import { canReadConfig, requireCapability } from './capability.js';

/**
 * Per-model health from the run ledger (ADR 0129 §8).
 *
 * Read-only, like `assistant-runs.ts` — through `guard.require` plus
 * `audit.read`. Advisory only (CLAUDE.md rule 1): nothing here changes the
 * model chain. A `model-result` event's `providerMessage` is
 * configuration-shaped text, so it needs `config.read`, checked with the
 * non-replying `authorize` so a viewer without it still gets the health with
 * the text withheld, never a 403. `keyId` is returned but never key labels —
 * the dashboard already knows labels from the chain setup data.
 */

const modelHealthQuerySchema = z.object({
  window: z.enum(['24h', '7d']).optional(),
});

const WINDOW_MS = { '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000 } as const;

export const registerAssistantModelHealthRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.get('/api/assistant/model-health', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireCapability(session, 'audit.read', reply)) return reply;

    const parsed = modelHealthQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const window = parsed.data.window ?? '24h';
    const models = modelHealth(
      runRepo.modelResultsSince(session.scope, deps.now() - WINDOW_MS[window]),
    );
    // ADR 0129 §3: the provider's short error message is
    // configuration-shaped text — withheld without config.read.
    const showText = canReadConfig(session);
    return reply.status(200).send({
      window,
      models: showText
        ? models
        : models.map((m) =>
            m.lastError?.providerMessage === undefined
              ? m
              : {
                  ...m,
                  lastError: {
                    at: m.lastError.at,
                    code: m.lastError.code,
                  },
                },
          ),
    });
  });
};
