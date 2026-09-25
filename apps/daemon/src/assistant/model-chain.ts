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

/**
 * Resolves the ordered model chain: the stored chain when one is saved, else
 * the `.env` seed on a fresh install (both tables empty and `AI_PROVIDER`
 * set). Each entry is checked against its own `provider_eligibility` row
 * (hard rule 5); a missing row skips as `unverified`, a refusing row as
 * `ineligible`, and a provider that may train stays usable with
 * `mayTrain: true`. Keys never appear outside the constructed provider.
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
  const storedById = new Map(
    assistantProvidersRepo.listProviders(deps.instance).map((p) => [p.provider, p] as const),
  );
  const storedChain = assistantProvidersRepo.getModelChain(deps.instance);

  let candidates: readonly Candidate[];
  if (storedChain.length > 0 || storedById.size > 0) {
    candidates = storedChain.map((row): Candidate => {
      const stored = storedById.get(row.provider);
      const costClass = stored?.costClass ?? 'unknown';
      const enabled = stored?.enabled ?? false;
      if (stored?.apiKeyEnc == null)
        return {
          provider: row.provider,
          model: row.model,
          apiKey: undefined,
          keySkip: 'no-key',
          costClass,
          enabled,
        };
      const apiKey = deps.openKey(stored.apiKeyEnc);
      return apiKey === undefined
        ? {
            provider: row.provider,
            model: row.model,
            apiKey: undefined,
            keySkip: 'key-unreadable',
            costClass,
            enabled,
          }
        : {
            provider: row.provider,
            model: row.model,
            apiKey,
            keySkip: undefined,
            costClass,
            enabled,
          };
    });
  } else if (deps.config.AI_PROVIDER !== 'off' && deps.config.AI_MODEL !== undefined) {
    const provider: ProviderId = deps.config.AI_PROVIDER;
    const key = envKeyOf(deps.config, provider);
    const costClass = deps.config.AI_PROFILE_COST_CLASS;
    candidates = [deps.config.AI_MODEL, ...(deps.config.AI_FALLBACK_MODELS ?? [])].map(
      (model): Candidate =>
        key === undefined
          ? { provider, model, apiKey: undefined, keySkip: 'no-key', costClass, enabled: true }
          : { provider, model, apiKey: key, keySkip: undefined, costClass, enabled: true },
    );
  } else {
    candidates = [];
  }

  return candidates.map((candidate): ChainEntry => {
    if (candidate.keySkip !== undefined)
      return {
        providerId: candidate.provider,
        model: candidate.model,
        provider: undefined,
        skip: candidate.keySkip,
        mayTrain: false,
      };
    if (!candidate.enabled)
      return {
        providerId: candidate.provider,
        model: candidate.model,
        provider: undefined,
        skip: 'disabled',
        mayTrain: false,
      };
    const row = deps.eligibility(candidate.provider);
    if (row === undefined)
      return {
        providerId: candidate.provider,
        model: candidate.model,
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
        provider: undefined,
        skip: 'ineligible',
        mayTrain: false,
      };
    }
    return {
      providerId: candidate.provider,
      model: candidate.model,
      provider: deps.makeProvider(
        candidate.provider,
        candidate.apiKey as string,
        candidate.costClass,
      ),
      skip: undefined,
      mayTrain: providerMayTrain({ trainsOnInput: row.trainsOnInput }),
    };
  });
};
