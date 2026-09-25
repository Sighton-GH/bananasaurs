import {
  assertProviderEligible,
  createNvidiaNimProvider,
  createOpenRouterProvider,
  GeminiProvider,
  providerMayTrain,
  SafeProvider,
  type Config,
  type ProviderCostClass,
  type TextProvider,
} from '@bananasaurs/core';
import {
  assistantProvidersRepo,
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
  /** The key this entry runs on (`key_env` for the `.env` seed, never persisted). */
  readonly keyId: string;
  readonly keyLabel: string;
  /** Undefined when the entry is skipped; the reason is in `skip`. */
  readonly provider: TextProvider | undefined;
  readonly skip?: ChainSkipReason | undefined;
  /** True when the provider's terms do not rule out training on input (warning, not refusal). */
  readonly mayTrain: boolean;
}

/**
 * Builds one provider behind the spend boundary, exactly as `providerFor`
 * did: every provider runs wrapped, with a zero spend cap, so no caller can
 * bypass the pre-API scan.
 */
export const makeProvider = (
  provider: ProviderId,
  apiKey: string,
  costClass: ProviderCostClass,
): TextProvider => {
  const inner =
    provider === 'gemini'
      ? new GeminiProvider({ apiKey })
      : provider === 'openrouter'
        ? createOpenRouterProvider({ apiKey })
        : createNvidiaNimProvider({ apiKey });
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
    keyId: 'key_env',
    keyLabel: 'From .env',
    apiKey: key,
    keySkip: key === undefined ? 'no-key' : undefined,
    costClass,
    enabled: true,
  }));
};

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
  ) => TextProvider;
}): readonly ChainEntry[] => {
  const storedKeys = assistantProvidersRepo.listKeys(deps.instance);
  const keysById = new Map(storedKeys.map((k) => [k.keyId, k] as const));
  const storedChain = assistantProvidersRepo.getModelChain(deps.instance);

  const storedCandidates = (): readonly Candidate[] =>
    storedChain.map((row): Candidate => {
      const key = keysById.get(row.keyId);
      const costClass = key?.costClass ?? 'unknown';
      const enabled = key?.enabled ?? false;
      const keyLabel = key?.label ?? row.keyId;
      if (key === undefined)
        return {
          provider: row.provider,
          model: row.model,
          keyId: row.keyId,
          keyLabel,
          apiKey: undefined,
          keySkip: 'no-key',
          costClass,
          enabled,
        };
      const apiKey = deps.openKey(key.apiKeyEnc);
      return apiKey === undefined
        ? {
            provider: row.provider,
            model: row.model,
            keyId: row.keyId,
            keyLabel,
            apiKey: undefined,
            keySkip: 'key-unreadable',
            costClass,
            enabled,
          }
        : {
            provider: row.provider,
            model: row.model,
            keyId: row.keyId,
            keyLabel,
            apiKey,
            keySkip: undefined,
            costClass,
            enabled,
          };
    });

  const candidates: readonly Candidate[] =
    storedChain.length > 0 || storedKeys.length > 0
      ? storedCandidates()
      : envCandidates(deps.config);

  // Entries sharing a key share one constructed provider instance.
  const providerCache = new Map<string, TextProvider>();
  const providerFor = (candidate: Candidate, apiKey: string): TextProvider => {
    const existing = providerCache.get(candidate.keyId);
    if (existing !== undefined) return existing;
    const built = deps.makeProvider(candidate.provider, apiKey, candidate.costClass);
    providerCache.set(candidate.keyId, built);
    return built;
  };

  const toEntry = (candidate: Candidate): ChainEntry => {
    if (candidate.keySkip !== undefined)
      return {
        providerId: candidate.provider,
        model: candidate.model,
        keyId: candidate.keyId,
        keyLabel: candidate.keyLabel,
        provider: undefined,
        skip: candidate.keySkip,
        mayTrain: false,
      };
    if (!candidate.enabled)
      return {
        providerId: candidate.provider,
        model: candidate.model,
        keyId: candidate.keyId,
        keyLabel: candidate.keyLabel,
        provider: undefined,
        skip: 'disabled',
        mayTrain: false,
      };
    const row = deps.eligibility(candidate.provider);
    if (row === undefined)
      return {
        providerId: candidate.provider,
        model: candidate.model,
        keyId: candidate.keyId,
        keyLabel: candidate.keyLabel,
        provider: undefined,
        skip: 'unverified',
        mayTrain: false,
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
        keyId: candidate.keyId,
        keyLabel: candidate.keyLabel,
        provider: undefined,
        skip: 'ineligible',
        mayTrain: false,
      };
    }
    return {
      providerId: candidate.provider,
      model: candidate.model,
      keyId: candidate.keyId,
      keyLabel: candidate.keyLabel,
      provider: providerFor(candidate, candidate.apiKey as string),
      skip: undefined,
      mayTrain: providerMayTrain({ trainsOnInput: row.trainsOnInput }),
    };
  };

  const entries = candidates.map(toEntry);

  const envHasUsableKey =
    deps.config.AI_PROVIDER !== 'off' &&
    deps.config.AI_MODEL !== undefined &&
    envKeyOf(deps.config, deps.config.AI_PROVIDER) !== undefined;
  if (entries.length > 0 && entries.every((e) => e.skip === 'key-unreadable') && envHasUsableKey) {
    return [...entries, ...envCandidates(deps.config).map(toEntry)];
  }

  return entries;
};
