import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  classifyProviderFailure,
  GEMINI_MODEL_TABLE,
  PROVIDER_FAILURE_TEXT,
} from '@bananasaurs/core';
import { assistantProvidersRepo, eligibilityRepo } from '@bananasaurs/storage';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
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

/** Most key lines one paste may add; more is refused, nothing saved. */
const MAX_BULK_KEYS = 50;

const bulkBody = z
  .object({
    provider: z.enum(PROVIDERS),
    project: z.string().min(1).max(80).optional(),
    costClass: z.enum(['free', 'paid', 'unknown']).optional(),
    keysText: z.string().min(1).max(20_000),
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
      z
        .object({
          keyId: z.string().min(1).max(200),
          model: z.string().min(1).max(200),
          rpmLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
          rpdLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
          pool: z.enum(['key', 'provider']).optional(),
          tier: z.enum(['standard', 'light']).optional(),
        })
        .strict(),
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

type ChainPool = 'key' | 'provider';
type ChainTier = 'standard' | 'light';

/**
 * ADR 0143: an invalid key (401/403) stays invalid until the owner edits or
 * re-tests it, so its cooldown has no natural expiry.
 */
const INVALID_KEY_UNTIL = Number.MAX_SAFE_INTEGER;

/**
 * Slice 6 view of the provider config store: key fingerprints and project
 * labels, pool/tier on saved chain rows, a runtime-selected key on resolved
 * chain entries, and the cooldown list. The daemon wires these into its
 * store under S6-T10; the `HttpDeps` type in server.ts stays narrower until
 * then, so the routes below cast and every addition degrades to a no-op
 * when the wiring has not landed yet.
 */
interface Slice6Store {
  keys?(): readonly {
    readonly keyId: string;
    readonly provider: string;
    readonly label: string;
    readonly costClass: 'free' | 'paid' | 'unknown';
    readonly enabled: boolean;
    readonly createdAt?: number | undefined;
    readonly project?: string | null | undefined;
    readonly fingerprint?: string | null | undefined;
  }[];
  addKey?(
    input: {
      provider: ProviderId;
      label: string;
      apiKey: string;
      project?: string | undefined;
      costClass?: 'free' | 'paid' | 'unknown' | undefined;
      fingerprint?: string | undefined;
    },
    now: number,
  ): string;
  saveChain?(
    rows: readonly {
      readonly keyId: string;
      readonly model: string;
      readonly rpmLimit?: number | null | undefined;
      readonly rpdLimit?: number | null | undefined;
      readonly pool?: ChainPool | undefined;
      readonly tier?: ChainTier | undefined;
    }[],
    now: number,
  ): void;
  chain?(): readonly {
    readonly providerId: string;
    readonly model: string;
    readonly keyId: string;
    readonly keyLabel: string;
    readonly provider: unknown;
    readonly skip?: string | undefined;
    readonly mayTrain: boolean;
    readonly rpmLimit: number | null;
    readonly rpdLimit: number | null;
    readonly selectedKeyId?: string | undefined;
  }[];
  setCooldown?(input: {
    readonly keyId: string;
    readonly model: string;
    readonly until: number;
    readonly reason: string;
    readonly setAt: number;
  }): void;
  clearCooldowns?(keyId: string, model?: string): void;
}

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
    const keys = configured.keys().map((key) => {
      const allowanceResetsAt = resetsAt(key.keyId);
      return {
        keyId: key.keyId,
        provider: key.provider,
        label: key.label,
        costClass: key.costClass,
        enabled: key.enabled,
        readable: configured.isKeyReadable?.(key.keyId) ?? false,
        ...(allowanceResetsAt === undefined ? {} : { allowanceResetsAt }),
      };
    });
    const chainEntries = configured.chain();
    const chain = chainEntries.map((entry, position) => {
      const reset = resetsAt(entry.keyId);
      const status = reset !== undefined ? 'allowance-used' : (entry.skip ?? 'ready');
      const usage = configured.modelUsage?.(entry);
      const listing = configured.modelListing?.(entry);
      return {
        position,
        keyId: entry.keyId,
        keyLabel: entry.keyLabel,
        provider: entry.providerId,
        model: entry.model,
        status,
        rpmLimit: entry.rpmLimit,
        rpdLimit: entry.rpdLimit,
        ...(reset === undefined ? {} : { allowanceResetsAt: reset }),
        ...(usage === undefined ? {} : { usage }),
        ...(listing === undefined ? {} : { listing }),
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
        source: webSearch?.source ?? 'brave',
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
    if (!parsed.success) return badRequest(reply, parsed.error);
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

  app.post('/api/assistant/keys/bulk', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const configured = store() as Slice6Store | undefined;
    if (configured?.addKey === undefined || configured.keys === undefined)
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    const parsed = bulkBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const lines = parsed.data.keysText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (lines.length === 0) return reply.status(400).send({ error: 'empty-paste' });
    if (lines.length > MAX_BULK_KEYS) return reply.status(400).send({ error: 'too-many-keys' });
    const seen = new Set(
      configured
        .keys()
        .map((key) => key.fingerprint)
        .filter((fingerprint): fingerprint is string => typeof fingerprint === 'string'),
    );
    let added = 0;
    let duplicates = 0;
    // Number after the highest existing "<provider> N" label, so a deletion
    // can never make two keys share a label.
    const labelPrefix = `${parsed.data.provider} `;
    let sequence = configured
      .keys()
      .filter((key) => key.provider === parsed.data.provider)
      .map((key) => key.label)
      .filter((label) => label.startsWith(labelPrefix))
      .map((label) => Number(label.slice(labelPrefix.length)))
      .filter((n) => Number.isSafeInteger(n) && n > 0)
      .reduce((max, n) => Math.max(max, n), 0);
    for (const line of lines) {
      const fingerprint = assistantProvidersRepo.fingerprintOf(line);
      if (seen.has(fingerprint)) {
        duplicates += 1;
        continue;
      }
      seen.add(fingerprint);
      sequence += 1;
      // The label is derived, never the key text; the fingerprint dedupes
      // without the secret reaching storage, a log or a response.
      configured.addKey(
        {
          provider: parsed.data.provider,
          label: `${parsed.data.provider} ${String(sequence)}`,
          apiKey: line,
          ...(parsed.data.project === undefined ? {} : { project: parsed.data.project }),
          ...(parsed.data.costClass === undefined ? {} : { costClass: parsed.data.costClass }),
          fingerprint,
        },
        deps.now(),
      );
      added += 1;
    }
    deps.portsFor(session.scope).recordAudit({
      ...dashboardAuditBase(session, deps.now()),
      action: 'assistant_provider.keys_pasted',
      subjectType: 'assistant_provider_key',
      subjectId: 'bulk',
      before: undefined,
      after: {
        provider: parsed.data.provider,
        project: parsed.data.project ?? null,
        added,
        duplicates,
      },
    });
    return reply.status(200).send({ added, duplicates });
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
    if (!parsed.success) return badRequest(reply, parsed.error);
    if (
      parsed.data.label === undefined &&
      parsed.data.apiKey === undefined &&
      parsed.data.costClass === undefined &&
      parsed.data.enabled === undefined
    ) {
      return reply.status(400).send({ error: 'bad-request' });
    }
    configured.updateKey(keyId, { ...parsed.data }, deps.now());
    if (parsed.data.apiKey !== undefined) {
      (configured as Slice6Store).clearCooldowns?.(keyId);
    }
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
    if (!parsed.success) return badRequest(reply, parsed.error);
    if (parsed.data.entries.length > 6) return reply.status(400).send({ error: 'too-many' });
    const known = new Set(configured.keys().map((key) => key.keyId));
    if (parsed.data.entries.some((entry) => !known.has(entry.keyId)))
      return reply.status(400).send({ error: 'unknown-key' });
    const seen = new Set<string>();
    for (const entry of parsed.data.entries) {
      const pair = `${entry.keyId}\u0000${entry.model}`;
      if (seen.has(pair)) return reply.status(400).send({ error: 'duplicate-entry' });
      seen.add(pair);
    }
    try {
      (configured as Slice6Store).saveChain?.(
        parsed.data.entries.map((entry) => ({
          keyId: entry.keyId,
          model: entry.model,
          rpmLimit: entry.rpmLimit ?? null,
          rpdLimit: entry.rpdLimit ?? null,
          ...(entry.pool === undefined ? {} : { pool: entry.pool }),
          ...(entry.tier === undefined ? {} : { tier: entry.tier }),
        })),
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
          rpmLimit: entry.rpmLimit ?? null,
          rpdLimit: entry.rpdLimit ?? null,
          ...(entry.pool === undefined ? {} : { pool: entry.pool }),
          ...(entry.tier === undefined ? {} : { tier: entry.tier }),
        })),
      },
    });
    return reply.status(200).send({ ok: true, count: parsed.data.entries.length });
  });

  app.post('/api/assistant/model-chain/recommended', (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const configured = store() as Slice6Store | undefined;
    if (
      configured?.keys === undefined ||
      configured.chain === undefined ||
      configured.saveChain === undefined
    )
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    const geminiKeys = configured.keys().filter((key) => key.provider === 'gemini' && key.enabled);
    if (geminiKeys.length === 0) return reply.status(400).send({ error: 'no-gemini-key' });
    // Pool rows anchor to the provider's oldest key id for the foreign key;
    // runtime expansion resolves every enabled key of the provider (S6-T10).
    const anchor = geminiKeys.reduce((oldest, key) =>
      (key.createdAt ?? 0) < (oldest.createdAt ?? 0) ? key : oldest,
    );
    // Keep owner-set tiers: a recommended entry reuses the tier of an
    // existing chain entry with the same provider and model, else the default.
    const existing = configured.chain();
    const tierOf = (providerId: string, model: string): 'standard' | 'light' => {
      const match = existing.find(
        (entry) => entry.providerId === providerId && entry.model === model,
      );
      const tier = (match as { tier?: unknown } | undefined)?.tier;
      return tier === 'light' || tier === 'standard' ? tier : 'standard';
    };
    const geminiEntries = Object.entries(GEMINI_MODEL_TABLE)
      .filter(([, profile]) => profile.freeRpm !== undefined && profile.freeRpd !== undefined)
      .map(([model, profile]) => ({
        keyId: anchor.keyId,
        model,
        rpmLimit: profile.freeRpm ?? null,
        rpdLimit: profile.freeRpd ?? null,
        pool: 'provider' as const,
        tier: tierOf('gemini', model),
      }));
    const ownerEntries = configured
      .chain()
      .filter((entry) => entry.providerId === 'openrouter')
      .map((entry) => ({
        keyId: entry.keyId,
        model: entry.model,
        rpmLimit: entry.rpmLimit,
        rpdLimit: entry.rpdLimit,
        pool: 'key' as const,
        tier: tierOf('openrouter', entry.model),
      }));
    const entries = [...geminiEntries, ...ownerEntries];
    if (entries.length > 6) return reply.status(400).send({ error: 'too-many' });
    try {
      configured.saveChain(entries, deps.now());
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
        count: entries.length,
        entries: entries.map((entry, position) => ({ position, ...entry })),
      },
    });
    return reply.status(200).send({ ok: true, count: entries.length });
  });

  app.post('/api/assistant/model-chain/test', async (request, reply) => {
    const session = guard.require(request, reply);
    if (session === undefined) return reply;
    if (!requireOwner(session, reply)) return reply;
    const configured = store();
    if (configured?.chain === undefined)
      return reply.status(503).send({ error: 'provider-secret-store-not-configured' });
    const parsed = testBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
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
    if (configured.reserveTestCall !== undefined) {
      const reserved = configured.reserveTestCall(parsed.data.position, session.guildId);
      if (!reserved.ok) {
        const text = PROVIDER_FAILURE_TEXT[reserved.code];
        return reply.status(200).send({
          ok: false,
          latencyMs: latencyOf(),
          error: text.title,
          failure: {
            code: reserved.code,
            title: text.title,
            explanation: text.explanation,
            hint: text.hint,
          },
        });
      }
    }
    const selectedKeyId = (entry as { selectedKeyId?: string }).selectedKeyId ?? entry.keyId;
    try {
      const result = await entry.provider.generateText({
        model: entry.model,
        messages: [{ role: 'user', text: 'Reply with the single word: ready' }],
      });
      // A passing test makes a cooled-down key usable again (ADR 0143).
      (configured as Slice6Store).clearCooldowns?.(selectedKeyId, entry.model);
      return reply.status(200).send({ ok: true, latencyMs: latencyOf(), reply: result.text });
    } catch (err) {
      const f = classifyProviderFailure(err, {
        provider: entry.providerId,
        model: entry.model,
      });
      if (f.code === 'provider-auth') {
        (configured as Slice6Store).setCooldown?.({
          keyId: selectedKeyId,
          model: entry.model,
          until: INVALID_KEY_UNTIL,
          reason: 'invalid-key',
          setAt: deps.now(),
        });
      }
      const text = PROVIDER_FAILURE_TEXT[f.code];
      return reply.status(200).send({
        ok: false,
        latencyMs: latencyOf(),
        error: text.title,
        failure: {
          code: f.code,
          title: text.title,
          explanation: text.explanation,
          hint: text.hint,
          ...(f.host === undefined ? {} : { host: f.host }),
          ...(f.httpStatus === undefined ? {} : { httpStatus: f.httpStatus }),
          ...(f.netCode === undefined ? {} : { netCode: f.netCode }),
        },
      });
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
    if (!parsed.success) return badRequest(reply, parsed.error);
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
