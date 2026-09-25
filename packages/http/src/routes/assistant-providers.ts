import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ProviderError } from '@bananasaurs/core';
import { eligibilityRepo } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import type { SessionContext } from '../auth.js';
import { dashboardAuditBase } from './audit-base.js';
import { isInstanceOwner } from './assistant.js';

const PROVIDERS = ['gemini', 'openrouter', 'nvidia-nim'] as const;
type ProviderId = (typeof PROVIDERS)[number];

const isProviderId = (value: string): value is ProviderId =>
  (PROVIDERS as readonly string[]).includes(value);

const keyBody = z
  .object({
    provider: z.enum(PROVIDERS),
    label: z.string().min(1).max(60),
    apiKey: z.string().min(1).max(1000),
    costClass: z.enum(['free', 'paid', 'unknown']).optional(),
  })
  .strict();

const keyPatch = z
  .object({
    label: z.string().min(1).max(60).optional(),
    apiKey: z.string().min(1).max(1000).optional(),
    costClass: z.enum(['free', 'paid', 'unknown']).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const chainBody = z
  .object({
    entries: z.array(
      z.object({ keyId: z.string().min(1).max(200), model: z.string().min(1).max(200) }).strict(),
    ),
  })
  .strict();

const testBody = z.object({ position: z.number().int().min(0) }).strict();

const githubBody = z.object({ token: z.string().min(1).max(5000).nullable() }).strict();

type Eligibility = 'eligible' | 'may-train' | 'ineligible' | 'unverified';

const eligibilityOf = (
  deps: HttpDeps,
  provider: string,
): { eligibility: Eligibility; mayTrain: boolean } => {
  const row = eligibilityRepo.findEligibility(deps.scopes.instance(), provider);
  if (row === undefined) return { eligibility: 'unverified', mayTrain: false };
  if (!row.productionUseAllowed) return { eligibility: 'ineligible', mayTrain: false };
  if (row.trainsOnInput !== 'no') return { eligibility: 'may-train', mayTrain: true };
  return { eligibility: 'eligible', mayTrain: false };
};

const TERMS_REFUSAL =
  "The AI provider's terms are not recorded or don't allow this use, so no content was sent outside the server.";

const statusOf = (err: unknown): number | undefined => {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
};

/**
 * What a chain test answers when the provider call fails (hard rule 4).
 *
 * The provider's error text is never repeated — it can echo request
 * details, so every failure becomes one of four fixed sentences chosen
 * from the error's kind or status only.
 */
const chainTestFailure = (err: unknown): string => {
  const kind = err instanceof ProviderError ? err.kind : undefined;
  const status = statusOf(err);
  if (kind === 'authentication' || status === 401 || status === 403)
    return 'The provider refused the key.';
  if (kind === 'timeout' || status === 408 || status === 504)
    return 'The provider did not answer in time.';
  if (kind === 'invalid-request' || kind === 'capability-mismatch' || status === 404)
    return 'The model is not available on this key.';
  return 'The test request failed.';
};

/**
 * Task 8: several labelled keys across several providers, ordered into one
 * model chain with fallbacks. Instance owner only; every change is audited
 * as `assistant_provider.*` with ids, labels and counts — a key, sealed or
 * plain, never appears in any response, audit row, log or error.
 */
export const registerAssistantProviderRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  const store = () => deps.assistantProviderConfig;
  const resetsAt = (keyId: string): number | undefined => deps.assistantAllowanceResetsAt?.(keyId);

  const requireOwner = (session: SessionContext, reply: FastifyReply): boolean => {
    if (!isInstanceOwner(deps, session)) {
      void reply.status(403).send({ error: 'owner-only' });
      return false;
    }
    return true;
  };

  app.get('/api/assistant/providers', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const configured = store();
    if (
      configured?.keys === undefined ||
      configured.chain === undefined ||
      configured.isKeyReadable === undefined ||
      configured.githubTokenConfigured === undefined
    ) {
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    }
    const keys = configured.keys().map((key) => ({
      keyId: key.keyId,
      provider: key.provider,
      label: key.label,
      costClass: key.costClass,
      enabled: key.enabled,
      readable: configured.isKeyReadable?.(key.keyId) ?? false,
      ...(resetsAt(key.keyId) === undefined ? {} : { allowanceResetsAt: resetsAt(key.keyId) }),
    }));
    const chainEntries = configured.chain();
    const chain = chainEntries.map((entry, position) => {
      const reset = resetsAt(entry.keyId);
      const status = reset !== undefined ? 'allowance-used' : (entry.skip ?? 'ready');
      return {
        position,
        keyId: entry.keyId,
        keyLabel: entry.keyLabel,
        provider: entry.providerId,
        model: entry.model,
        status,
        ...(reset === undefined ? {} : { allowanceResetsAt: reset }),
      };
    });
    const providers = PROVIDERS.map((provider) => ({
      provider,
      eligibility: eligibilityOf(deps, provider).eligibility,
      supportsTools: true,
      keyCount: keys.filter((key) => key.provider === provider).length,
    }));
    const webSearch = configured.status().webSearch;
    return reply.status(200).send({
      providers,
      keys,
      chain,
      webSearch: {
        keyConfigured: webSearch?.keyConfigured ?? false,
        enabled: webSearch?.enabled ?? false,
      },
      github: { tokenConfigured: configured.githubTokenConfigured() },
    });
  });

  app.post('/api/assistant/keys', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const configured = store();
    if (configured?.addKey === undefined)
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    const parsed = keyBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });
    const keyId = configured.addKey(
      {
        provider: parsed.data.provider,
        label: parsed.data.label,
        apiKey: parsed.data.apiKey,
        ...(parsed.data.costClass === undefined ? {} : { costClass: parsed.data.costClass }),
      },
      deps.now(),
    );
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_provider.key_added',
      subjectType: 'assistant_provider_key',
      subjectId: keyId,
      before: undefined,
      after: {
        provider: parsed.data.provider,
        label: parsed.data.label,
        costClass: parsed.data.costClass ?? 'unknown',
      },
    });
    return reply.status(200).send({ keyId });
  });

  app.patch('/api/assistant/keys/:keyId', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const configured = store();
    if (configured?.keys === undefined || configured.updateKey === undefined)
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    const keyId = (request.params as { keyId: string }).keyId;
    const before = configured.keys().find((key) => key.keyId === keyId);
    if (before === undefined) return reply.status(404).send({ error: 'not-found' });
    const parsed = keyPatch.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });
    if (
      parsed.data.label === undefined &&
      parsed.data.apiKey === undefined &&
      parsed.data.costClass === undefined &&
      parsed.data.enabled === undefined
    ) {
      return reply.status(400).send({ error: 'bad-request' });
    }
    configured.updateKey(keyId, { ...parsed.data }, deps.now());
    const after = configured.keys().find((key) => key.keyId === keyId);
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_provider.key_updated',
      subjectType: 'assistant_provider_key',
      subjectId: keyId,
      before: {
        provider: before.provider,
        label: before.label,
        costClass: before.costClass,
        enabled: before.enabled,
      },
      after: {
        provider: after?.provider ?? before.provider,
        label: after?.label ?? before.label,
        costClass: after?.costClass ?? before.costClass,
        enabled: after?.enabled ?? before.enabled,
        keyReplaced: parsed.data.apiKey !== undefined,
      },
    });
    return reply.status(200).send({ ok: true });
  });

  app.delete('/api/assistant/keys/:keyId', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const configured = store();
    if (configured?.keys === undefined || configured.removeKey === undefined)
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    const keyId = (request.params as { keyId: string }).keyId;
    const before = configured.keys().find((key) => key.keyId === keyId);
    if (before === undefined) return reply.status(404).send({ error: 'not-found' });
    configured.removeKey(keyId);
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_provider.key_deleted',
      subjectType: 'assistant_provider_key',
      subjectId: keyId,
      before: { provider: before.provider, label: before.label },
      after: undefined,
    });
    return reply.status(200).send({ ok: true });
  });

  app.put('/api/assistant/model-chain', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const configured = store();
    if (configured?.keys === undefined || configured.saveChain === undefined)
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    const parsed = chainBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });
    if (parsed.data.entries.length > 6) return reply.status(400).send({ error: 'too-many' });
    const known = new Set(configured.keys().map((key) => key.keyId));
    if (parsed.data.entries.some((entry) => !known.has(entry.keyId)))
      return reply.status(400).send({ error: 'unknown-key' });
    const seen = new Set<string>();
    for (const entry of parsed.data.entries) {
      const pair = `${entry.keyId} ${entry.model}`;
      if (seen.has(pair)) return reply.status(400).send({ error: 'duplicate-entry' });
      seen.add(pair);
    }
    try {
      configured.saveChain(
        parsed.data.entries.map((entry) => ({ keyId: entry.keyId, model: entry.model })),
        deps.now(),
      );
    } catch {
      return reply.status(400).send({ error: 'duplicate-entry' });
    }
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_provider.chain_saved',
      subjectType: 'assistant_provider_chain',
      subjectId: 'active',
      before: undefined,
      after: {
        count: parsed.data.entries.length,
        entries: parsed.data.entries.map((entry, position) => ({
          position,
          keyId: entry.keyId,
          model: entry.model,
        })),
      },
    });
    return reply.status(200).send({ ok: true, count: parsed.data.entries.length });
  });

  app.post('/api/assistant/model-chain/test', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const configured = store();
    if (configured?.chain === undefined)
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    const parsed = testBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });
    const entries = configured.chain();
    const entry = entries[parsed.data.position];
    if (entry === undefined) return reply.status(404).send({ error: 'not-found' });
    const started = deps.now();
    const latencyOf = (): number => Math.max(0, deps.now() - started);
    if (
      entry.provider === undefined ||
      entry.skip === 'ineligible' ||
      entry.skip === 'unverified'
    ) {
      return reply.status(200).send({ ok: false, latencyMs: latencyOf(), error: TERMS_REFUSAL });
    }
    if (entry.provider === undefined || entry.skip !== undefined) {
      return reply
        .status(200)
        .send({ ok: false, latencyMs: latencyOf(), error: 'That entry has no usable key.' });
    }
    if (isProviderId(entry.providerId)) {
      const { eligibility } = eligibilityOf(deps, entry.providerId);
      if (eligibility === 'ineligible' || eligibility === 'unverified') {
        return reply.status(200).send({ ok: false, latencyMs: latencyOf(), error: TERMS_REFUSAL });
      }
    }
    try {
      const result = await entry.provider.generateText({
        model: entry.model,
        messages: [{ role: 'user', text: 'Reply with the single word: ready' }],
      });
      return reply.status(200).send({ ok: true, latencyMs: latencyOf(), reply: result.text });
    } catch (err) {
      return reply
        .status(200)
        .send({ ok: false, latencyMs: latencyOf(), error: chainTestFailure(err) });
    }
  });

  app.put('/api/assistant/github-token', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const configured = store();
    if (configured?.saveGithubToken === undefined)
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    const parsed = githubBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad-request' });
    configured.saveGithubToken(parsed.data.token);
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_provider.github_token_saved',
      subjectType: 'assistant_provider',
      subjectId: 'active',
      before: undefined,
      after: { configured: parsed.data.token !== null },
    });
    return reply.status(200).send({ ok: true, tokenConfigured: parsed.data.token !== null });
  });
};
