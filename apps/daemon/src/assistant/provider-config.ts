import { createHash } from 'node:crypto';
import { listGeminiModels, type Config, type GeminiModelInfo } from '@bananasaurs/core';
import {
  assistantProviderRepo,
  assistantProvidersRepo,
  eligibilityRepo,
  type InstanceScope,
} from '@bananasaurs/storage';
import {
  makeProvider,
  resolveModelChain,
  type ChainEntry,
  type ProviderId,
} from './model-chain.js';
import { openWithKey as open, sealWithKey as seal } from '../crypto/seal.js';

const keyFrom = (secret: string): Buffer =>
  createHash('sha256').update(`bananasaurs:assistant-provider:${secret}`, 'utf8').digest();
export type ProviderSecretSource = 'env' | 'file' | 'missing';
export type ProviderCostClass = 'free' | 'paid' | 'unknown';
export interface ProviderConfigStatus {
  readonly provider: string;
  /** The model name is configuration, not a secret; the key never appears here. */
  readonly model?: string;
  readonly enabled: boolean;
  readonly modelConfigured: boolean;
  readonly keyConfigured: boolean;
  /** Whether the stored ciphertext opens under this daemon's secret (ADR 0061 §3). */
  readonly keyReadable: boolean;
  readonly costClass: ProviderCostClass;
  readonly secretSource: ProviderSecretSource;
  /** ADR 0068: up to two more models, tried in order when the one before is busy. */
  readonly fallbackModels?: readonly string[];
  /** ADR 0066. Absent while no Brave key is saved and search is off. */
  readonly webSearch?: { readonly keyConfigured: boolean; readonly enabled: boolean };
}
export interface ProviderConfigStore {
  status(): ProviderConfigStatus;
  effective(base: Config): Config;
  save(
    input: {
      provider: 'off' | 'gemini' | 'openrouter' | 'nvidia-nim';
      model?: string | undefined;
      apiKey?: string | undefined;
      enabled: boolean;
      costClass?: ProviderCostClass | undefined;
      /** ADR 0068: the backups in order; `[]` clears them, omitted keeps them. */
      fallbackModels?: readonly string[] | undefined;
      /** Write-only; omitted keeps the saved key. */
      searchApiKey?: string | undefined;
      searchEnabled?: boolean | undefined;
    },
    now: number,
  ): void;
  /**
   * ADR 0068: the models a key can use for text answers. Uses `apiKey` when
   * given (just pasted, not yet saved), else the saved key for that service.
   * Throws `no-key` or `unsupported`; the key is never in the result.
   */
  listModels(provider: string, apiKey?: string): Promise<readonly GeminiModelInfo[]>;
  /** ADR 0075: the stored providers, sealed keys never opened. */
  providers(): readonly assistantProvidersRepo.StoredProvider[];
  /**
   * ADR 0075: the resolved, ordered model chain — each entry's key opened and
   * its own eligibility checked, ready for the service to pick the first
   * usable one.
   */
  chain(): readonly ChainEntry[];
  saveProvider(
    p: {
      provider: ProviderId;
      apiKey?: string | undefined;
      costClass?: ProviderCostClass | undefined;
      enabled?: boolean | undefined;
    },
    now: number,
  ): void;
  /** Replaces the whole chain; empty clears it. */
  saveChain(rows: readonly { provider: ProviderId; model: string }[], now: number): void;
  saveGithubToken(token: string | null): void;
}
/**
 * The provider as `.env` configures it: what runs when nothing is saved in
 * the dashboard, and the whole story when no key store exists.
 */
export const envProviderStatus = (
  config: Config,
  secretSource: ProviderSecretSource,
): ProviderConfigStatus => {
  const envKey =
    config.AI_PROVIDER === 'gemini'
      ? config.GEMINI_API_KEY
      : config.AI_PROVIDER === 'openrouter'
        ? config.OPENROUTER_API_KEY
        : config.AI_PROVIDER === 'nvidia-nim'
          ? config.NVIDIA_NIM_API_KEY
          : undefined;
  return {
    provider: config.AI_PROVIDER,
    ...(config.AI_MODEL === undefined ? {} : { model: config.AI_MODEL }),
    enabled: config.AI_PROVIDER !== 'off' && config.AI_MODEL !== undefined,
    modelConfigured: config.AI_MODEL !== undefined,
    keyConfigured: envKey !== undefined,
    keyReadable: envKey !== undefined,
    costClass: config.AI_PROFILE_COST_CLASS,
    secretSource,
  };
};

/**
 * `envBase` is the process config. With nothing saved, both the several-
 * providers table and the model chain are empty (ADR 0075) and the env
 * provider runs as `.env` configured it; once the dashboard saves a provider
 * and a chain, they are authoritative, and an empty or disabled chain there
 * means off — env is never silently resurrected under a saved-but-empty
 * configuration.
 */
export const createProviderConfigStore = (
  instance: InstanceScope,
  masterSecret: string,
  secretSource: Exclude<ProviderSecretSource, 'missing'> = 'env',
  envBase?: Config,
  geminiModels: (apiKey: string) => Promise<readonly GeminiModelInfo[]> = (apiKey) =>
    listGeminiModels({ apiKey }),
): ProviderConfigStore => {
  const key = keyFrom(masterSecret);
  return {
    status() {
      const provs = assistantProvidersRepo.listProviders(instance);
      const chainRows = assistantProvidersRepo.getModelChain(instance);
      const searchRow = assistantProviderRepo.get(instance);
      const webSearch =
        searchRow?.searchApiKeyEnc === undefined && searchRow?.searchEnabled !== true
          ? {}
          : {
              webSearch: {
                keyConfigured: searchRow.searchApiKeyEnc !== undefined,
                enabled: searchRow.searchEnabled === true,
              },
            };
      if (provs.length === 0 && chainRows.length === 0) {
        if (envBase !== undefined && envBase.AI_PROVIDER !== 'off')
          return { ...envProviderStatus(envBase, secretSource), ...webSearch };
        return {
          provider: 'off',
          enabled: false,
          modelConfigured: false,
          keyConfigured: false,
          keyReadable: false,
          costClass: 'unknown',
          secretSource,
          ...webSearch,
        };
      }
      const entry0 = chainRows[0];
      if (entry0 === undefined)
        return {
          provider: 'off',
          enabled: false,
          modelConfigured: false,
          keyConfigured: false,
          keyReadable: false,
          costClass: 'unknown',
          secretSource,
          ...webSearch,
        };
      const stored = provs.find((p) => p.provider === entry0.provider);
      const keyConfigured = stored?.apiKeyEnc != null;
      // Opened and dropped: the plaintext never leaves this expression.
      const keyReadable =
        keyConfigured && stored?.apiKeyEnc != null && open(key, stored.apiKeyEnc) !== undefined;
      const fallbackModels = chainRows
        .slice(1)
        .filter((row) => row.provider === entry0.provider)
        .map((row) => row.model);
      return {
        provider: entry0.provider,
        model: entry0.model,
        enabled: stored?.enabled ?? false,
        modelConfigured: true,
        keyConfigured,
        keyReadable,
        costClass: stored?.costClass ?? 'unknown',
        secretSource,
        ...(fallbackModels.length === 0 ? {} : { fallbackModels }),
        ...webSearch,
      };
    },
    effective(envConfig) {
      const provs = assistantProvidersRepo.listProviders(instance);
      const chainRows = assistantProvidersRepo.getModelChain(instance);
      const searchRow = assistantProviderRepo.get(instance);
      // A saved row is authoritative for web search too: off there means off.
      const rest: Config = { ...envConfig };
      delete rest.BRAVE_SEARCH_API_KEY;
      delete rest.AI_FALLBACK_MODELS;
      const searchKey =
        searchRow?.searchEnabled === true && searchRow.searchApiKeyEnc !== undefined
          ? open(key, searchRow.searchApiKeyEnc)
          : undefined;
      const base: Config = {
        ...rest,
        ...(searchKey === undefined ? {} : { BRAVE_SEARCH_API_KEY: searchKey }),
      };
      if (provs.length === 0 && chainRows.length === 0) return base;
      const entry0 = chainRows[0];
      if (entry0 === undefined) return { ...base, AI_PROVIDER: 'off' };
      const stored = provs.find((p) => p.provider === entry0.provider);
      if (stored === undefined || !stored.enabled || stored.apiKeyEnc == null)
        return { ...base, AI_PROVIDER: 'off' };
      const apiKey = open(key, stored.apiKeyEnc);
      if (apiKey === undefined) return { ...base, AI_PROVIDER: 'off' };
      const fallbackModels = chainRows
        .slice(1)
        .filter((row) => row.provider === entry0.provider)
        .map((row) => row.model);
      return {
        ...base,
        ...(fallbackModels.length === 0 ? {} : { AI_FALLBACK_MODELS: fallbackModels }),
        AI_PROVIDER: entry0.provider,
        AI_MODEL: entry0.model,
        AI_PROFILE_COST_CLASS: stored.costClass,
        ...(entry0.provider === 'gemini'
          ? { GEMINI_API_KEY: apiKey }
          : entry0.provider === 'openrouter'
            ? { OPENROUTER_API_KEY: apiKey }
            : { NVIDIA_NIM_API_KEY: apiKey }),
      };
    },
    save(input, now) {
      // ADR 0075: the AI provider, model and key columns on this row are no
      // longer read (several providers and the chain live in their own
      // tables now) — only the web-search fields below still take effect.
      // The columns stay written for the no-destructive-migration guarantee
      // and because `save`'s shape has to keep accepting the same input for
      // every existing caller until Task 8 replaces the dashboard route.
      const current = assistantProviderRepo.get(instance);
      const same = current?.provider === input.provider ? current : undefined;
      const model = input.model ?? same?.model;
      const apiKeyEnc = input.apiKey !== undefined ? seal(key, input.apiKey) : same?.apiKeyEnc;
      const fallbackModels = input.fallbackModels ?? same?.fallbackModels ?? [];
      const sameOrder = fallbackModels.join('\n') === (same?.fallbackModels ?? []).join('\n');
      const costClass =
        input.costClass ??
        (same !== undefined && model === same.model && sameOrder ? same.costClass : 'unknown');
      // Web search is its own service (ADR 0066): its key survives an AI
      // service switch.
      const searchApiKeyEnc =
        input.searchApiKey !== undefined ? seal(key, input.searchApiKey) : current?.searchApiKeyEnc;
      assistantProviderRepo.put(instance, {
        provider: input.provider,
        ...(model === undefined ? {} : { model }),
        ...(apiKeyEnc === undefined ? {} : { apiKeyEnc }),
        enabled: input.enabled,
        costClass,
        ...(fallbackModels.length === 0 ? {} : { fallbackModels }),
        ...(searchApiKeyEnc === undefined ? {} : { searchApiKeyEnc }),
        searchEnabled: input.searchEnabled ?? current?.searchEnabled ?? false,
        updatedAt: now,
      });
    },
    async listModels(provider, apiKey) {
      if (provider !== 'gemini') throw new Error('unsupported');
      let listKey = apiKey;
      if (listKey === undefined) {
        const stored = assistantProvidersRepo
          .listProviders(instance)
          .find((p) => p.provider === 'gemini');
        listKey = stored?.apiKeyEnc != null ? open(key, stored.apiKeyEnc) : undefined;
      }
      if (listKey === undefined) throw new Error('no-key');
      return await geminiModels(listKey);
    },
    providers() {
      return assistantProvidersRepo.listProviders(instance);
    },
    chain() {
      return resolveModelChain({
        instance,
        config: envBase ?? { AI_PROVIDER: 'off', AI_PROFILE_COST_CLASS: 'unknown' },
        openKey: (sealed) => open(key, sealed),
        eligibility: (providerId) => eligibilityRepo.findEligibility(instance, providerId),
        makeProvider,
      });
    },
    saveProvider(p, now) {
      const current = assistantProvidersRepo
        .listProviders(instance)
        .find((x) => x.provider === p.provider);
      const apiKeyEnc = p.apiKey !== undefined ? seal(key, p.apiKey) : (current?.apiKeyEnc ?? null);
      assistantProvidersRepo.upsertProvider(instance, {
        provider: p.provider,
        apiKeyEnc,
        costClass: p.costClass ?? current?.costClass ?? 'unknown',
        enabled: p.enabled ?? current?.enabled ?? false,
        now,
      });
    },
    saveChain(rows, now) {
      assistantProvidersRepo.setModelChain(instance, rows, now);
    },
    saveGithubToken(token) {
      assistantProvidersRepo.setGithubTokenEnc(instance, token === null ? null : seal(key, token));
    },
  };
};
