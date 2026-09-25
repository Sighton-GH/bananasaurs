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

/** Same display labels the 0039 migration gave a provider's copied key. */
const PROVIDER_LABEL: Record<ProviderId, string> = {
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  'nvidia-nim': 'NVIDIA NIM',
};

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
   * given (just pasted, not yet saved), else the first saved key for that
   * provider. Throws `no-key` or `unsupported`; the key is never in the
   * result.
   */
  listModels(provider: string, apiKey?: string): Promise<readonly GeminiModelInfo[]>;
  /** Task 6b: the stored keys, sealed values never opened. */
  keys(): readonly assistantProvidersRepo.StoredKey[];
  /** Seals `apiKey` and stores a new labelled key for `provider`. Returns its id. */
  addKey(
    input: {
      provider: ProviderId;
      label: string;
      apiKey: string;
      costClass?: ProviderCostClass | undefined;
      enabled?: boolean | undefined;
    },
    now: number,
  ): string;
  /** Write-only; an omitted `apiKey` keeps the saved one. */
  updateKey(
    keyId: string,
    input: {
      label?: string | undefined;
      apiKey?: string | undefined;
      costClass?: ProviderCostClass | undefined;
      enabled?: boolean | undefined;
    },
    now: number,
  ): void;
  /** Cascades: every chain entry on this key goes with it. */
  removeKey(keyId: string): void;
  /**
   * ADR 0075 / Task 6b: the resolved, ordered model chain — each entry's key
   * opened and its own provider's eligibility checked, ready for the service
   * to pick the first usable one.
   */
  chain(): readonly ChainEntry[];
  /** Replaces the whole chain; empty clears it. */
  saveChain(rows: readonly { keyId: string; model: string }[], now: number): void;
  saveGithubToken(token: string | null): void;
  /** Whether the stored key opens under this daemon's secret; false when unknown. */
  isKeyReadable(keyId: string): boolean;
  /** Whether a GitHub token is saved; the token itself is never returned. */
  githubTokenConfigured(): boolean;
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
 * `envBase` is the process config. With nothing saved, both the keys table
 * and the model chain are empty (Task 6b, ADR 0075) and the env provider
 * runs as `.env` configured it; once the dashboard saves a key and a chain,
 * they are authoritative, and an empty or disabled chain there means off —
 * env is never silently resurrected under a saved-but-empty configuration.
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
      const storedKeys = assistantProvidersRepo.listKeys(instance);
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
      if (storedKeys.length === 0 && chainRows.length === 0) {
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
      const storedKey = storedKeys.find((k) => k.keyId === entry0.keyId);
      const keyConfigured = storedKey !== undefined;
      // Opened and dropped: the plaintext never leaves this expression.
      const keyReadable = keyConfigured && open(key, storedKey.apiKeyEnc) !== undefined;
      const fallbackModels = chainRows
        .slice(1)
        .filter((row) => row.provider === entry0.provider)
        .map((row) => row.model);
      return {
        provider: entry0.provider,
        model: entry0.model,
        enabled: storedKey?.enabled ?? false,
        modelConfigured: true,
        keyConfigured,
        keyReadable,
        costClass: storedKey?.costClass ?? 'unknown',
        secretSource,
        ...(fallbackModels.length === 0 ? {} : { fallbackModels }),
        ...webSearch,
      };
    },
    effective(envConfig) {
      const storedKeys = assistantProvidersRepo.listKeys(instance);
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
      if (storedKeys.length === 0 && chainRows.length === 0) return base;
      const entry0 = chainRows[0];
      if (entry0 === undefined) return { ...base, AI_PROVIDER: 'off' };
      const storedKey = storedKeys.find((k) => k.keyId === entry0.keyId);
      if (storedKey === undefined || !storedKey.enabled) return { ...base, AI_PROVIDER: 'off' };
      const apiKey = open(key, storedKey.apiKeyEnc);
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
        AI_PROFILE_COST_CLASS: storedKey.costClass,
        ...(entry0.provider === 'gemini'
          ? { GEMINI_API_KEY: apiKey }
          : entry0.provider === 'openrouter'
            ? { OPENROUTER_API_KEY: apiKey }
            : { NVIDIA_NIM_API_KEY: apiKey }),
      };
    },
    save(input, now) {
      // ADR 0075 / Task 6b: the AI provider, model and key columns on this
      // row are no longer read (several keys and the chain live in their own
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
      // Task 6b fix round 1: `status()`/`effective()`/`chain()` read the keys
      // and chain tables, not the row above — so this legacy single-provider
      // route has to write there too, or every dashboard save silently does
      // nothing (the controller-caught regression). This replaces the whole
      // chain with (at most) this one provider's models, which is correct
      // for this route's single-provider view; it stops being the only save
      // path once Task 8 ships the multi-key dashboard.
      if (input.provider === 'off') {
        assistantProvidersRepo.setModelChain(instance, [], now);
        return;
      }
      const keyId = `key_${input.provider}`;
      const existingKey = assistantProvidersRepo.listKeys(instance).find((k) => k.keyId === keyId);
      if (existingKey === undefined && input.apiKey === undefined) {
        // Nothing to seal into a key row (api_key_enc is NOT NULL) and none
        // saved yet: leave the chain empty so status() reports this provider
        // as configured with no key, the closest match to today's
        // keyConfigured: false under the new schema.
        assistantProvidersRepo.setModelChain(instance, [], now);
        return;
      }
      if (existingKey === undefined) {
        assistantProvidersRepo.addKey(instance, {
          keyId,
          provider: input.provider,
          label: PROVIDER_LABEL[input.provider],
          apiKeyEnc: seal(key, input.apiKey as string),
          costClass,
          enabled: input.enabled,
          now,
        });
      } else {
        assistantProvidersRepo.updateKey(instance, keyId, {
          ...(input.apiKey === undefined ? {} : { apiKeyEnc: seal(key, input.apiKey) }),
          costClass,
          enabled: input.enabled,
          now,
        });
      }
      if (model === undefined) {
        // No model named yet, by this save or an earlier one on this
        // provider: nothing to chain, even though the key now exists.
        assistantProvidersRepo.setModelChain(instance, [], now);
        return;
      }
      const models = [...new Set([model, ...fallbackModels])].slice(0, 6);
      assistantProvidersRepo.setModelChain(
        instance,
        models.map((m) => ({ keyId, model: m })),
        now,
      );
    },
    async listModels(provider, apiKey) {
      if (provider !== 'gemini') throw new Error('unsupported');
      let listKey = apiKey;
      if (listKey === undefined) {
        // With several Gemini keys and no pasted key, this uses the first stored Gemini key (by key id).
        const storedKey = assistantProvidersRepo
          .listKeys(instance)
          .find((k) => k.provider === 'gemini');
        listKey = storedKey !== undefined ? open(key, storedKey.apiKeyEnc) : undefined;
      }
      if (listKey === undefined) throw new Error('no-key');
      return await geminiModels(listKey);
    },
    keys() {
      return assistantProvidersRepo.listKeys(instance);
    },
    addKey(input, now) {
      return assistantProvidersRepo.addKey(instance, {
        provider: input.provider,
        label: input.label,
        apiKeyEnc: seal(key, input.apiKey),
        costClass: input.costClass ?? 'unknown',
        enabled: input.enabled ?? true,
        now,
      });
    },
    updateKey(keyId, input, now) {
      assistantProvidersRepo.updateKey(instance, keyId, {
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.apiKey === undefined ? {} : { apiKeyEnc: seal(key, input.apiKey) }),
        ...(input.costClass === undefined ? {} : { costClass: input.costClass }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        now,
      });
    },
    removeKey(keyId) {
      assistantProvidersRepo.removeKey(instance, keyId);
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
    saveChain(rows, now) {
      assistantProvidersRepo.setModelChain(instance, rows, now);
    },
    saveGithubToken(token) {
      assistantProvidersRepo.setGithubTokenEnc(instance, token === null ? null : seal(key, token));
    },
    isKeyReadable(keyId) {
      const stored = assistantProvidersRepo.listKeys(instance).find((k) => k.keyId === keyId);
      if (stored === undefined) return false;
      // Opened and dropped: the plaintext never leaves this expression.
      return open(key, stored.apiKeyEnc) !== undefined;
    },
    githubTokenConfigured() {
      return assistantProvidersRepo.getGithubTokenEnc(instance) !== null;
    },
  };
};
