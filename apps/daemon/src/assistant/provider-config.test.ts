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
it('never carries one service key over to another service', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  store.save({ provider: 'gemini', model: 'm', apiKey: 'gemini-key', enabled: true }, 10);
  store.save({ provider: 'openrouter', model: 'x', enabled: true }, 11);
  expect(store.status()).toMatchObject({ provider: 'openrouter', keyConfigured: false });
  const effective = store.effective(base);
  expect(effective.AI_PROVIDER).toBe('off');
  expect(JSON.stringify(effective)).not.toContain('gemini-key');
  // The same service keeps its key when the field is left blank.
  store.save({ provider: 'openrouter', model: 'x', apiKey: 'or-key', enabled: true }, 12);
  store.save({ provider: 'openrouter', model: 'y', enabled: true }, 13);
  expect(store.effective(base)).toMatchObject({
    AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'or-key',
  });
});
it('does not carry a model or a free statement over to a different service', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  store.save({ provider: 'gemini', model: 'm', apiKey: 'k', enabled: true, costClass: 'free' }, 10);
  store.save({ provider: 'openrouter', apiKey: 'k2', enabled: true }, 11);
  expect(store.status()).toMatchObject({
    provider: 'openrouter',
    costClass: 'unknown',
    modelConfigured: false,
  });
});
it('asks for the cost again when the model changes', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  store.save(
    { provider: 'gemini', model: 'm1', apiKey: 'k', enabled: true, costClass: 'free' },
    10,
  );
  store.save({ provider: 'gemini', model: 'm2', enabled: true }, 11);
  expect(store.status()).toMatchObject({ model: 'm2', costClass: 'unknown', keyConfigured: true });
});

it('saves a fallback model for the same service and drops it on a service switch', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  store.save(
    {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      fallbackModel: 'gemini-2.5-flash-lite',
      apiKey: 'k',
      enabled: true,
    },
    10,
  );
  expect(store.status().fallbackModel).toBe('gemini-2.5-flash-lite');
  expect(store.effective(base).AI_FALLBACK_MODEL).toBe('gemini-2.5-flash-lite');
  store.save({ provider: 'gemini', enabled: true }, 11);
  expect(store.status().fallbackModel).toBe('gemini-2.5-flash-lite');
  store.save({ provider: 'gemini', fallbackModel: null, enabled: true }, 12);
  expect(store.status().fallbackModel).toBeUndefined();
  store.save({ provider: 'gemini', fallbackModel: 'x', enabled: true }, 13);
  store.save({ provider: 'openrouter', model: 'm', apiKey: 'k2', enabled: true }, 14);
  expect(store.status().fallbackModel).toBeUndefined();
});

it('keeps the Brave key write-only and applies it only while web search is on (ADR 0066)', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  store.save({ provider: 'gemini', model: 'm', apiKey: 'k', enabled: true }, 10);
  expect(store.status().webSearch).toBeUndefined();
  expect(store.effective(base).BRAVE_SEARCH_API_KEY).toBeUndefined();

  store.save({ provider: 'gemini', enabled: true, searchApiKey: 'brave-raw-key' }, 11);
  expect(store.status().webSearch).toEqual({ keyConfigured: true, enabled: false });
  expect(assistantProviderRepo.get(t.scopes.instance())?.searchApiKeyEnc).not.toContain(
    'brave-raw-key',
  );
  expect(store.effective(base).BRAVE_SEARCH_API_KEY).toBeUndefined();

  store.save({ provider: 'gemini', enabled: true, searchEnabled: true }, 12);
  expect(store.status().webSearch).toEqual({ keyConfigured: true, enabled: true });
  expect(store.effective(base).BRAVE_SEARCH_API_KEY).toBe('brave-raw-key');
  expect(JSON.stringify(store.status())).not.toContain('brave-raw-key');

  // The search key is not tied to the AI service.
  store.save({ provider: 'openrouter', model: 'm', apiKey: 'k2', enabled: true }, 13);
  expect(store.effective(base).BRAVE_SEARCH_API_KEY).toBe('brave-raw-key');

  // A saved row is authoritative: switched off there means off, even with env set.
  store.save({ provider: 'openrouter', enabled: true, searchEnabled: false }, 14);
  expect(
    store.effective({ ...base, BRAVE_SEARCH_API_KEY: 'env-key' }).BRAVE_SEARCH_API_KEY,
  ).toBeUndefined();
});
