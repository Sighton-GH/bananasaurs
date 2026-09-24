import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Config } from '@bananasaurs/core';
import { assistantProviderRepo, type InstanceScope } from '@bananasaurs/storage';

const keyFrom = (secret: string): Buffer =>
  createHash('sha256').update(`bananasaurs:assistant-provider:${secret}`, 'utf8').digest();
const seal = (key: Buffer, value: string): string => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
};
const open = (key: Buffer, value: string): string | undefined => {
  try {
    const raw = Buffer.from(value, 'base64');
    if (raw.length < 29) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
};
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
  /** Tried once when the main model is overloaded. */
  readonly fallbackModel?: string;
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
      /** `null` clears it; omitted keeps it. */
      fallbackModel?: string | null | undefined;
      /** Write-only; omitted keeps the saved key. */
      searchApiKey?: string | undefined;
      searchEnabled?: boolean | undefined;
    },
    now: number,
  ): void;
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
 * `envBase` is the process config. With no saved row the env provider runs
 * and `status()` reports it; once the dashboard saves a row, the row is
 * authoritative, and switched off there means off.
 */
export const createProviderConfigStore = (
  instance: InstanceScope,
  masterSecret: string,
  secretSource: Exclude<ProviderSecretSource, 'missing'> = 'env',
  envBase?: Config,
): ProviderConfigStore => {
  const key = keyFrom(masterSecret);
  return {
    status() {
      const row = assistantProviderRepo.get(instance);
      if (row === undefined && envBase !== undefined && envBase.AI_PROVIDER !== 'off')
        return envProviderStatus(envBase, secretSource);
      if (row === undefined)
        return {
          provider: 'off',
          enabled: false,
          modelConfigured: false,
          keyConfigured: false,
          keyReadable: false,
          costClass: 'unknown',
          secretSource,
        };
      return {
        provider: row.provider,
        ...(row.model === undefined ? {} : { model: row.model }),
        enabled: row.enabled,
        modelConfigured: row.model !== undefined,
        keyConfigured: row.apiKeyEnc !== undefined,
        // Opened and dropped: the plaintext never leaves this expression.
        keyReadable: row.apiKeyEnc !== undefined && open(key, row.apiKeyEnc) !== undefined,
        costClass: row.costClass,
        secretSource,
        ...(row.fallbackModel === undefined ? {} : { fallbackModel: row.fallbackModel }),
        ...(row.searchApiKeyEnc === undefined && row.searchEnabled !== true
          ? {}
          : {
              webSearch: {
                keyConfigured: row.searchApiKeyEnc !== undefined,
                enabled: row.searchEnabled === true,
              },
            }),
      };
    },
    effective(envConfig) {
      const row = assistantProviderRepo.get(instance);
      if (row === undefined) return envConfig;
      // A saved row is authoritative for web search too: off there means off.
      const rest: Config = { ...envConfig };
      delete rest.BRAVE_SEARCH_API_KEY;
      delete rest.AI_FALLBACK_MODEL;
      const searchKey =
        row.searchEnabled === true && row.searchApiKeyEnc !== undefined
          ? open(key, row.searchApiKeyEnc)
          : undefined;
      const base: Config = {
        ...rest,
        ...(searchKey === undefined ? {} : { BRAVE_SEARCH_API_KEY: searchKey }),
      };
      if (!row.enabled || row.provider === 'off' || row.apiKeyEnc === undefined)
        return { ...base, AI_PROVIDER: 'off' };
      const apiKey = open(key, row.apiKeyEnc);
      if (apiKey === undefined) return { ...base, AI_PROVIDER: 'off' };
      return {
        ...base,
        ...(row.fallbackModel === undefined ? {} : { AI_FALLBACK_MODEL: row.fallbackModel }),
        AI_PROVIDER: row.provider,
        AI_MODEL: row.model,
        AI_PROFILE_COST_CLASS: row.costClass,
        ...(row.provider === 'gemini'
          ? { GEMINI_API_KEY: apiKey }
          : row.provider === 'openrouter'
            ? { OPENROUTER_API_KEY: apiKey }
            : { NVIDIA_NIM_API_KEY: apiKey }),
      };
    },
    save(input, now) {
      const current = assistantProviderRepo.get(instance);
      // Omitted fields keep what is saved, so re-saving to flip `enabled` does
      // not drop anything. But the key, model and cost statement belong to the
      // service they were entered for: switching service drops them, so one
      // company's key is never sent to another; and a "free" statement is about
      // one model, so a new model needs it stated again (final review, 2026-09-23).
      const same = current?.provider === input.provider ? current : undefined;
      const model = input.model ?? same?.model;
      const apiKeyEnc = input.apiKey !== undefined ? seal(key, input.apiKey) : same?.apiKeyEnc;
      // The fallback model runs on the same service and key, so it follows the
      // same rule; and the cost statement has to cover it too.
      const fallbackModel =
        input.fallbackModel === null ? undefined : (input.fallbackModel ?? same?.fallbackModel);
      const costClass =
        input.costClass ??
        (same !== undefined && model === same.model && fallbackModel === same.fallbackModel
          ? same.costClass
          : 'unknown');
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
        ...(fallbackModel === undefined ? {} : { fallbackModel }),
        ...(searchApiKeyEnc === undefined ? {} : { searchApiKeyEnc }),
        searchEnabled: input.searchEnabled ?? current?.searchEnabled ?? false,
        updatedAt: now,
      });
    },
  };
};
