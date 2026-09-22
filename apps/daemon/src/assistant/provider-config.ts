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
export interface ProviderConfigStore {
  status(): {
    provider: string;
    enabled: boolean;
    modelConfigured: boolean;
    keyConfigured: boolean;
  };
  effective(base: Config): Config;
  save(
    input: {
      provider: 'off' | 'gemini' | 'openrouter' | 'nvidia-nim';
      model?: string;
      apiKey?: string;
      enabled: boolean;
    },
    now: number,
  ): void;
}
export const createProviderConfigStore = (
  instance: InstanceScope,
  masterSecret: string,
): ProviderConfigStore => {
  const key = keyFrom(masterSecret);
  return {
    status() {
      const row = assistantProviderRepo.get(instance);
      return row === undefined
        ? { provider: 'off', enabled: false, modelConfigured: false, keyConfigured: false }
        : {
            provider: row.provider,
            enabled: row.enabled,
            modelConfigured: row.model !== undefined,
            keyConfigured: row.apiKeyEnc !== undefined,
          };
    },
    effective(base) {
      const row = assistantProviderRepo.get(instance);
      if (
        row === undefined ||
        !row.enabled ||
        row.provider === 'off' ||
        row.apiKeyEnc === undefined
      )
        return base;
      const apiKey = open(key, row.apiKeyEnc);
      if (apiKey === undefined) return { ...base, AI_PROVIDER: 'off' };
      return {
        ...base,
        AI_PROVIDER: row.provider,
        AI_MODEL: row.model,
        ...(row.provider === 'gemini'
          ? { GEMINI_API_KEY: apiKey }
          : row.provider === 'openrouter'
            ? { OPENROUTER_API_KEY: apiKey }
            : { NVIDIA_NIM_API_KEY: apiKey }),
      };
    },
    save(input, now) {
      const current = assistantProviderRepo.get(instance);
      assistantProviderRepo.put(instance, {
        provider: input.provider,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.apiKey !== undefined
          ? { apiKeyEnc: seal(key, input.apiKey) }
          : current?.apiKeyEnc === undefined
            ? {}
            : { apiKeyEnc: current.apiKeyEnc }),
        enabled: input.enabled,
        updatedAt: now,
      });
    },
  };
};
