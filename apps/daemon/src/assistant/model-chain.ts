import {
  assertProviderEligible,
  createNvidiaNimProvider,
  createOpenRouterProvider,
  GeminiProvider,
  providerMayTrain,
  providerDayStart,
  SafeProvider,
  type Config,
  type ProviderCostClass,
  type TextProvider,
} from '@bananasaurs/core';
import {
  assistantProvidersRepo,
  assistantKeyCooldownsRepo,
  modelCallsRepo,
  type eligibilityRepo,
  type InstanceScope,
} from '@bananasaurs/storage';

export type ProviderId = 'gemini' | 'openrouter' | 'nvidia-nim';

export type ChainSkipReason =
  'no-key' | 'key-unreadable' | 'disabled' | 'ineligible' | 'unverified';

/**
 * Only the fields the env seed reads. A full `Config` satisfies this
 * structurally, so every real caller still passes one; this exists so
 * `provider-config.ts`'s `chain()` can seed with an off-only literal when no
 * process config was given to it, without constructing a fake `Config`.
 */
export interface ModelChainConfig {
  readonly AI_PROVIDER: Config['AI_PROVIDER'];
  readonly AI_MODEL?: Config['AI_MODEL'];
  readonly AI_FALLBACK_MODELS?: Config['AI_FALLBACK_MODELS'];
  readonly AI_PROFILE_COST_CLASS: Config['AI_PROFILE_COST_CLASS'];
  readonly GEMINI_API_KEY?: Config['GEMINI_API_KEY'];
  readonly OPENROUTER_API_KEY?: Config['OPENROUTER_API_KEY'];
  readonly NVIDIA_NIM_API_KEY?: Config['NVIDIA_NIM_API_KEY'];
}

export interface ChainEntry {
  readonly providerId: ProviderId;
  readonly model: string;
  /** The configured key (the anchor key for a `pool: 'provider'` entry; see `selectedKeyId`). `key_env` for the `.env` seed, never persisted. */
  readonly keyId: string;
  readonly keyLabel: string;
  /** Undefined when the entry is skipped; the reason is in `skip`. */
  readonly provider: TextProvider | undefined;
  readonly skip?: ChainSkipReason | undefined;
  /** True when the provider's terms do not rule out training on input (warning, not refusal). */
  readonly mayTrain: boolean;
  readonly rpmLimit: number | null;
  readonly rpdLimit: number | null;
  /** ADR 0143: own key or every enabled key of this provider. */
  readonly pool: 'key' | 'provider';
  /** ADR 0144: which runs try this entry first. */
  readonly tier: 'standard' | 'light';
  /** The key actually constructed, equal to keyId for a one-key entry. */
  readonly selectedKeyId: string;
}

export const ENV_KEY_ID = 'key_env';

/**
 * Builds one provider behind the spend boundary, exactly as `providerFor`
 * did: every provider runs wrapped, with a zero spend cap, so no caller can
 * bypass the pre-API scan.
 */
export const makeProvider = (
  provider: ProviderId,
  apiKey: string,
  costClass: ProviderCostClass,
  options?: { readonly timeoutMs?: number },
): TextProvider => {
  const timeoutMs = options?.timeoutMs;
  const inner =
    provider === 'gemini'
      ? new GeminiProvider({ apiKey, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
      : provider === 'openrouter'
        ? createOpenRouterProvider({ apiKey, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
        : createNvidiaNimProvider({ apiKey, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  return new SafeProvider(inner, costClass, { monthlyCapUsdMicros: 0 });
};

interface Candidate {
  readonly provider: ProviderId;
  readonly model: string;
  readonly keyId: string;
  readonly keyLabel: string;
  readonly apiKey: string | undefined;
  readonly keySkip: 'no-key' | 'key-unreadable' | undefined;
  readonly costClass: ProviderCostClass;
  readonly enabled: boolean;
  readonly rpmLimit: number | null;
  readonly rpdLimit: number | null;
  readonly pool: 'key' | 'provider';
  readonly tier: 'standard' | 'light';
  readonly sealedKey?: string;
}

const envKeyOf = (config: ModelChainConfig, provider: ProviderId): string | undefined =>
  provider === 'gemini'
    ? config.GEMINI_API_KEY
    : provider === 'openrouter'
      ? config.OPENROUTER_API_KEY
      : config.NVIDIA_NIM_API_KEY;

/** The `.env` seed: one candidate per model (the primary plus its fallbacks), under the synthetic `key_env`. */
const envCandidates = (config: ModelChainConfig): readonly Candidate[] => {
  if (config.AI_PROVIDER === 'off' || config.AI_MODEL === undefined) return [];
  const provider: ProviderId = config.AI_PROVIDER;
  const key = envKeyOf(config, provider);
  const costClass = config.AI_PROFILE_COST_CLASS;
  return [config.AI_MODEL, ...(config.AI_FALLBACK_MODELS ?? [])].map((model): Candidate => ({
    provider,
    model,
    keyId: ENV_KEY_ID,
    keyLabel: 'From .env',
    apiKey: key,
    keySkip: key === undefined ? 'no-key' : undefined,
    costClass,
    enabled: true,
    rpmLimit: null,
    rpdLimit: null,
    pool: 'key',
    tier: 'standard',
  }));
};

export interface PoolCandidate {
  readonly keyId: string;
  readonly remainingDay: number;
  readonly lastUsed: number;
}

/** Most remaining daily requests, least recently used, then key id. */
export function selectPoolKey(candidates: readonly PoolCandidate[]): PoolCandidate | undefined {
  return [...candidates].sort(
    (a, b) =>
      b.remainingDay - a.remainingDay ||
      a.lastUsed - b.lastUsed ||
      (a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0),
  )[0];
}

/**
 * Resolves the ordered model chain: the stored chain when one is saved, else
 * the `.env` seed on a fresh install (both tables empty and `AI_PROVIDER`
 * set). Each entry is checked against its own `provider_eligibility` row
 * (hard rule 5, per *provider* — keys share their provider's terms record); a
 * missing row skips as `unverified`, a refusing row as `ineligible`, and a
 * provider that may train stays usable with `mayTrain: true`. Keys never
 * appear outside the constructed provider.
 *
 * Carried from Task 6's review: when the key-encryption secret is missing or
 * unreadable, every stored entry comes back `key-unreadable` and the chain
 * would otherwise go silent even though `.env` still names a usable provider
 * — the env seed is appended after the stored entries in that case, so the
 * assistant keeps working from `.env` exactly as it did before this table
 * existed.
 */
export const resolveModelChain = (deps: {
  instance: InstanceScope;
  config: ModelChainConfig;
  openKey: (sealed: string) => string | undefined;
  eligibility: (provider: ProviderId) => eligibilityRepo.EligibilityRow | undefined;
  makeProvider: (
    provider: ProviderId,
    apiKey: string,
    costClass: ProviderCostClass,
    options?: { readonly timeoutMs?: number },
  ) => TextProvider;
  /** Read once per resolve and passed to `makeProvider`. Absent means the provider default. */
  readonly providerTimeoutMs?: () => number;
}): readonly ChainEntry[] => {
  const storedKeys = assistantProvidersRepo.listKeys(deps.instance);
  const keysById = new Map(storedKeys.map((k) => [k.keyId, k] as const));
  const storedChain = assistantProvidersRepo.getModelChain(deps.instance);

  const storedCandidates = (): readonly Candidate[] =>
    storedChain.map((row): Candidate => {
      const key = keysById.get(row.keyId);
      return {
        provider: row.provider,
        model: row.model,
        keyId: row.keyId,
        keyLabel: key?.label ?? row.keyId,
        apiKey: undefined,
        ...(key === undefined ? {} : { sealedKey: key.apiKeyEnc }),
        keySkip: key === undefined ? 'no-key' : undefined,
        costClass: key?.costClass ?? 'unknown',
        enabled: key?.enabled ?? false,
        rpmLimit: row.rpmLimit,
        rpdLimit: row.rpdLimit,
        pool: row.pool ?? 'key',
        tier: row.tier ?? 'standard',
      };
    });

  const candidates: readonly Candidate[] =
    storedChain.length > 0 || storedKeys.length > 0
      ? storedCandidates()
      : envCandidates(deps.config);

  // Entries sharing a key share one constructed provider instance.
  const providerCache = new Map<string, TextProvider | undefined>();
  const timeoutMs = deps.providerTimeoutMs?.();
  const providerFor = (candidate: Candidate): TextProvider | undefined => {
    if (providerCache.has(candidate.keyId)) return providerCache.get(candidate.keyId);
    // The only stored-secret opening boundary. Nothing opened is carried on a candidate or entry.
    const apiKey =
      candidate.sealedKey === undefined ? candidate.apiKey : deps.openKey(candidate.sealedKey);
    if (apiKey === undefined) {
      providerCache.set(candidate.keyId, undefined);
      return undefined;
    }
    const built =
      timeoutMs === undefined
        ? deps.makeProvider(candidate.provider, apiKey, candidate.costClass)
        : deps.makeProvider(candidate.provider, apiKey, candidate.costClass, { timeoutMs });
    providerCache.set(candidate.keyId, built);
    return built;
  };

  const now = Date.now();
  const learnedCooldowns = assistantKeyCooldownsRepo.listCooldowns(deps.instance);
  const toEntry = (anchor: Candidate): ChainEntry => {
    let candidate = anchor;
    let selectedProvider: TextProvider | undefined;
    if (anchor.pool === 'provider') {
      const enabledKeys = storedKeys.filter(
        (key) => key.provider === anchor.provider && key.enabled,
      );
      const ranked = enabledKeys.flatMap((key): PoolCandidate[] => {
        if (
          assistantKeyCooldownsRepo.getCooldown(deps.instance, key.keyId, anchor.model, now) !==
          undefined
        )
          return [];
        const bucket = assistantProvidersRepo.bucketOf(key);
        const bucketKeyIds = enabledKeys
          .filter((k) => assistantProvidersRepo.bucketOf(k) === bucket)
          .map((k) => k.keyId);
        const learned = learnedCooldowns.find(
          (row) => row.keyId === key.keyId && row.model === anchor.model,
        )?.learnedPerDay;
        const limit = anchor.rpdLimit ?? learned;
        const remainingDay =
          limit === undefined
            ? Infinity
            : limit -
              modelCallsRepo.callsTodayForKeys(deps.instance, {
                keyIds: bucketKeyIds,
                model: anchor.model,
                dayStart: providerDayStart(anchor.provider, now),
              });
        return remainingDay > 0
          ? [
              {
                keyId: key.keyId,
                remainingDay,
                lastUsed: modelCallsRepo.lastUsedAt(deps.instance, {
                  keyId: key.keyId,
                  model: anchor.model,
                }),
              },
            ]
          : [];
      });
      let chosen = selectPoolKey(ranked);
      while (chosen !== undefined) {
        const key = keysById.get(chosen.keyId)!;
        candidate = {
          ...anchor,
          keyId: key.keyId,
          keyLabel: key.label,
          sealedKey: key.apiKeyEnc,
          costClass: key.costClass,
          enabled: true,
          keySkip: undefined,
        };
        selectedProvider = providerFor(candidate);
        if (selectedProvider !== undefined) break;
        ranked.splice(
          ranked.findIndex((k) => k.keyId === chosen?.keyId),
          1,
        );
        chosen = selectPoolKey(ranked);
      }
      if (selectedProvider === undefined)
        candidate = { ...anchor, enabled: false, keySkip: undefined };
    }
    if (anchor.pool === 'key' && candidate.keySkip === undefined) {
      selectedProvider = providerFor(candidate);
      if (selectedProvider === undefined) candidate = { ...candidate, keySkip: 'key-unreadable' };
    }
    const metadata = { pool: anchor.pool, tier: anchor.tier, selectedKeyId: candidate.keyId };
    if (candidate.keySkip !== undefined)
      return {
        providerId: candidate.provider,
        model: candidate.model,
        keyId: anchor.keyId,
        keyLabel: candidate.keyLabel,
        provider: undefined,
        skip: candidate.keySkip,
        mayTrain: false,
        rpmLimit: candidate.rpmLimit,
        rpdLimit: candidate.rpdLimit,
        ...metadata,
      };
    if (!candidate.enabled)
      return {
        providerId: candidate.provider,
        model: candidate.model,
        keyId: anchor.keyId,
        keyLabel: candidate.keyLabel,
        provider: undefined,
        skip: 'disabled',
        mayTrain: false,
        rpmLimit: candidate.rpmLimit,
        rpdLimit: candidate.rpdLimit,
        ...metadata,
      };
    const row = deps.eligibility(candidate.provider);
    if (row === undefined)
      return {
        providerId: candidate.provider,
        model: candidate.model,
        keyId: anchor.keyId,
        keyLabel: candidate.keyLabel,
        provider: undefined,
        skip: 'unverified',
        mayTrain: false,
        rpmLimit: candidate.rpmLimit,
        rpdLimit: candidate.rpdLimit,
        ...metadata,
      };
    try {
      assertProviderEligible(
        {
          trainsOnInput: row.trainsOnInput,
          productionUseAllowed: row.productionUseAllowed,
          evidenceUrl: row.evidenceUrl,
          reviewedAt: new Date(row.reviewedAt).toISOString(),
        },
        'club',
      );
    } catch {
      return {
        providerId: candidate.provider,
        model: candidate.model,
        keyId: anchor.keyId,
        keyLabel: candidate.keyLabel,
        provider: undefined,
        skip: 'ineligible',
        mayTrain: false,
        rpmLimit: candidate.rpmLimit,
        rpdLimit: candidate.rpdLimit,
        ...metadata,
      };
    }
    const provider = selectedProvider ?? providerFor(candidate);
    return {
      providerId: candidate.provider,
      model: candidate.model,
      keyId: anchor.keyId,
      keyLabel: candidate.keyLabel,
      provider,
      skip: provider === undefined ? 'key-unreadable' : undefined,
      mayTrain: providerMayTrain({ trainsOnInput: row.trainsOnInput }),
      rpmLimit: candidate.rpmLimit,
      rpdLimit: candidate.rpdLimit,
      ...metadata,
    };
  };

  const entries = candidates.slice(0, 6).map(toEntry);

  const envHasUsableKey =
    deps.config.AI_PROVIDER !== 'off' &&
    deps.config.AI_MODEL !== undefined &&
    envKeyOf(deps.config, deps.config.AI_PROVIDER) !== undefined;
  if (entries.length > 0 && entries.every((e) => e.skip === 'key-unreadable') && envHasUsableKey) {
    return [...entries, ...envCandidates(deps.config).map(toEntry)];
  }

  return entries;
};
