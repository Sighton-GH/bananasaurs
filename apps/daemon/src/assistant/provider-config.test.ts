import { afterEach, beforeEach, expect, it } from 'vitest';
import { parseConfig } from '@bananasaurs/core';
import { assistantProviderRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createProviderConfigStore } from './provider-config.js';
let t: MigratedTestDatabase;
beforeEach(() => {
  t = openMigratedTestDatabase();
});
afterEach(() => t.close());
const base = parseConfig({
  DISCORD_BOT_TOKEN: 'x',
  DISCORD_APPLICATION_ID: '123456789012345678',
  BANANASAURS_GUILD_ALLOWLIST: '234567890123456789',
  BANANASAURS_OWNER_USER_ID: '345678901234567890',
  AI_PROVIDER: 'off',
});
it('encrypts a write-only key and recovers it only into effective runtime config', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  store.save(
    { provider: 'gemini', model: 'gemini-test', apiKey: 'raw-secret-value', enabled: true },
    10,
  );
  expect(store.status()).toEqual({
    provider: 'gemini',
    model: 'gemini-test',
    enabled: true,
    modelConfigured: true,
    keyConfigured: true,
    keyReadable: true,
    costClass: 'unknown',
    secretSource: 'env',
  });
  const row = assistantProviderRepo.get(t.scopes.instance())!;
  expect(row.apiKeyEnc).not.toContain('raw-secret-value');
  expect(store.effective(base)).toMatchObject({
    AI_PROVIDER: 'gemini',
    AI_MODEL: 'gemini-test',
    GEMINI_API_KEY: 'raw-secret-value',
  });
  const wrongKey = createProviderConfigStore(t.scopes.instance(), 'b'.repeat(32));
  expect(wrongKey.effective(base).AI_PROVIDER).toBe('off');
});
it('retains the encrypted key on settings-only updates and disables without exposing it', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  store.save({ provider: 'openrouter', model: 'one', apiKey: 'secret', enabled: true }, 10);
  const before = assistantProviderRepo.get(t.scopes.instance())!.apiKeyEnc;
  store.save({ provider: 'openrouter', model: 'two', enabled: false }, 11);
  expect(assistantProviderRepo.get(t.scopes.instance())!.apiKeyEnc).toBe(before);
  expect(store.status()).toMatchObject({ enabled: false, keyConfigured: true });
  expect(store.effective(base).AI_PROVIDER).toBe('off');
});
it('reports the saved model, cost class, secret source and whether the key decrypts', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32), 'file');
  expect(store.status()).toEqual({
    provider: 'off',
    enabled: false,
    modelConfigured: false,
    keyConfigured: false,
    keyReadable: false,
    costClass: 'unknown',
    secretSource: 'file',
  });
  store.save(
    {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'k',
      enabled: true,
      costClass: 'free',
    },
    10,
  );
  expect(store.status()).toEqual({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    enabled: true,
    modelConfigured: true,
    keyConfigured: true,
    keyReadable: true,
    costClass: 'free',
    secretSource: 'file',
  });
  const other = createProviderConfigStore(t.scopes.instance(), 'b'.repeat(32), 'env');
  expect(other.status()).toMatchObject({ keyConfigured: true, keyReadable: false });
  expect(JSON.stringify(store.status())).not.toContain('"k"');
});
it('keeps the saved model and cost class when a save omits them', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  store.save(
    { provider: 'gemini', model: 'm1', apiKey: 'k', enabled: true, costClass: 'free' },
    10,
  );
  store.save({ provider: 'gemini', enabled: true }, 11);
  expect(store.status()).toMatchObject({ model: 'm1', costClass: 'free' });
});
it('applies the stored cost class to the effective config', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  store.save({ provider: 'gemini', model: 'm', apiKey: 'k', enabled: true, costClass: 'free' }, 10);
  expect(store.effective(base).AI_PROFILE_COST_CLASS).toBe('free');
  store.save({ provider: 'gemini', enabled: true, costClass: 'paid' }, 11);
  expect(store.effective(base).AI_PROFILE_COST_CLASS).toBe('paid');
});
it('reports the env-configured provider when nothing is saved in the dashboard', () => {
  const envBase = {
    ...base,
    AI_PROVIDER: 'gemini' as const,
    AI_MODEL: 'env-model',
    GEMINI_API_KEY: 'env-key',
    AI_PROFILE_COST_CLASS: 'free' as const,
  };
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32), 'file', envBase);
  expect(store.status()).toEqual({
    provider: 'gemini',
    model: 'env-model',
    enabled: true,
    modelConfigured: true,
    keyConfigured: true,
    keyReadable: true,
    costClass: 'free',
    secretSource: 'file',
  });
  expect(store.effective(envBase).AI_PROVIDER).toBe('gemini');
});
it('a saved dashboard row is authoritative: switched off there means off, even with env set', () => {
  const envBase = {
    ...base,
    AI_PROVIDER: 'gemini' as const,
    AI_MODEL: 'env-model',
    GEMINI_API_KEY: 'env-key',
  };
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32), 'file', envBase);
  store.save({ provider: 'gemini', model: 'm', apiKey: 'k', enabled: false }, 10);
  expect(store.status()).toMatchObject({ provider: 'gemini', enabled: false });
  expect(store.effective(envBase).AI_PROVIDER).toBe('off');
});
