import { afterEach, beforeEach, expect, it } from 'vitest';
import { parseConfig } from '@bananasaurs/core';
import { assistantProviderRepo, assistantProvidersRepo } from '@bananasaurs/storage';
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

/**
 * Note on this file (Task 6b, ADR 0075 follow-up): `status()`, `effective()`
 * and `chain()` all now read the provider-keys table and the model chain,
 * not a single provider row — so every test below that checks one of those
 * seeds through `store.addKey` + `store.saveChain` instead of the old
 * `store.saveProvider`. `save` still exists and is still tested (last two
 * tests), but only its web-search fields have an observable effect now; its
 * provider/model/key/cost-class/fallback-model fields still write the old
 * row (no destructive migration) but nothing reads them back.
 */

it('encrypts a write-only key and recovers it only into the resolved chain and effective config', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  const keyId = store.addKey(
    { provider: 'gemini', label: 'Gemini', apiKey: 'raw-secret-value' },
    10,
  );
  store.saveChain([{ keyId, model: 'gemini-test' }], 10);
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
  const row = assistantProvidersRepo.listKeys(t.scopes.instance())[0]!;
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
  const keyId = store.addKey({ provider: 'openrouter', label: 'OpenRouter', apiKey: 'secret' }, 10);
  store.saveChain([{ keyId, model: 'one' }], 10);
  const before = assistantProvidersRepo.listKeys(t.scopes.instance())[0]!.apiKeyEnc;
  store.updateKey(keyId, { enabled: false }, 11);
  store.saveChain([{ keyId, model: 'two' }], 11);
  expect(assistantProvidersRepo.listKeys(t.scopes.instance())[0]!.apiKeyEnc).toBe(before);
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
  const keyId = store.addKey(
    { provider: 'gemini', label: 'Gemini', apiKey: 'k', costClass: 'free' },
    10,
  );
  store.saveChain([{ keyId, model: 'gemini-2.5-flash' }], 10);
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
it('keeps the saved model and cost class when a key update omits them', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  const keyId = store.addKey(
    { provider: 'gemini', label: 'Gemini', apiKey: 'k', costClass: 'free' },
    10,
  );
  store.saveChain([{ keyId, model: 'm1' }], 10);
  store.updateKey(keyId, { enabled: true }, 11);
  expect(store.status()).toMatchObject({ model: 'm1', costClass: 'free' });
});
it('applies the stored cost class to the effective config', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  const keyId = store.addKey(
    { provider: 'gemini', label: 'Gemini', apiKey: 'k', costClass: 'free' },
    10,
  );
  store.saveChain([{ keyId, model: 'm' }], 10);
  expect(store.effective(base).AI_PROFILE_COST_CLASS).toBe('free');
  store.updateKey(keyId, { costClass: 'paid' }, 11);
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
  const keyId = store.addKey({ provider: 'gemini', label: 'Gemini', apiKey: 'k' }, 10);
  store.updateKey(keyId, { enabled: false }, 10);
  store.saveChain([{ keyId, model: 'm' }], 10);
  expect(store.status()).toMatchObject({ provider: 'gemini', enabled: false });
  expect(store.effective(envBase).AI_PROVIDER).toBe('off');
});
it('never carries one key over to another when the chain switches keys', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  const gemini = store.addKey({ provider: 'gemini', label: 'Gemini', apiKey: 'gemini-key' }, 10);
  store.saveChain([{ keyId: gemini, model: 'm' }], 10);
  expect(store.effective(base)).toMatchObject({
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'gemini-key',
  });
  // Pointing the chain at a different key's model must not leak the old key.
  const openrouter = store.addKey(
    { provider: 'openrouter', label: 'OpenRouter', apiKey: 'or-key' },
    12,
  );
  store.saveChain([{ keyId: openrouter, model: 'x' }], 12);
  const effective = store.effective(base);
  expect(effective).toMatchObject({ AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or-key' });
  expect(JSON.stringify(effective)).not.toContain('gemini-key');
});
it('does not carry a free statement over to a different key', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  const gemini = store.addKey(
    { provider: 'gemini', label: 'Gemini', apiKey: 'k', costClass: 'free' },
    10,
  );
  store.saveChain([{ keyId: gemini, model: 'm' }], 10);
  // A new key with no cost class stated defaults to unknown — the gemini
  // key's "free" statement is about that key, not about whichever key the
  // chain points at.
  const openrouter = store.addKey(
    { provider: 'openrouter', label: 'OpenRouter', apiKey: 'k2' },
    11,
  );
  store.saveChain([{ keyId: openrouter, model: 'x' }], 11);
  expect(store.status()).toMatchObject({
    provider: 'openrouter',
    costClass: 'unknown',
    modelConfigured: true,
  });
});
it('the cost statement belongs to the key, not to a particular chain model (Task 6b)', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  const keyId = store.addKey(
    { provider: 'gemini', label: 'Gemini', apiKey: 'k', costClass: 'free' },
    10,
  );
  store.saveChain([{ keyId, model: 'm1' }], 10);
  // Changing which model the chain points at does not touch the key's cost
  // statement: the chain is decoupled from the key row, so there is nothing
  // to reset here.
  store.saveChain([{ keyId, model: 'm2' }], 11);
  expect(store.status()).toMatchObject({ model: 'm2', costClass: 'free', keyConfigured: true });
});

it('saves up to six ordered chain entries; later same-provider entries are fallback models in status()', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  const keyId = store.addKey(
    { provider: 'gemini', label: 'Gemini', apiKey: 'k', costClass: 'free' },
    10,
  );
  store.saveChain(
    [
      { keyId, model: 'gemini-2.5-flash' },
      { keyId, model: 'gemini-2.5-flash-lite' },
      { keyId, model: 'gemma-3-27b-it' },
    ],
    10,
  );
  expect(store.status()).toMatchObject({
    fallbackModels: ['gemini-2.5-flash-lite', 'gemma-3-27b-it'],
    costClass: 'free',
  });
  expect(store.effective(base).AI_FALLBACK_MODELS).toEqual([
    'gemini-2.5-flash-lite',
    'gemma-3-27b-it',
  ]);
  // Replacing the chain with a single entry drops the fallback models.
  store.saveChain([{ keyId, model: 'gemini-2.5-flash' }], 12);
  expect(store.status().fallbackModels).toBeUndefined();
  expect(store.effective(base).AI_FALLBACK_MODELS).toBeUndefined();
  // More than six entries is rejected by the repo (see
  // `assistant-providers.test.ts`); this store does not re-check that limit
  // itself, it delegates.
  expect(() =>
    store.saveChain(
      Array.from({ length: 7 }, (_, i) => ({ keyId, model: `m${i}` })),
      13,
    ),
  ).toThrow();
});

it('chain() resolves the stored chain into eligibility-checked, constructed providers', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  expect(store.chain()).toEqual([]);
  const keyId = store.addKey(
    { provider: 'gemini', label: 'Gemini', apiKey: 'raw-chain-key', costClass: 'free' },
    10,
  );
  store.saveChain([{ keyId, model: 'm' }], 10);
  // No `provider_eligibility` row yet: the entry is unverified, not
  // constructed, and the key never appears in the result.
  const [unverified] = store.chain();
  expect(unverified).toMatchObject({ providerId: 'gemini', model: 'm', skip: 'unverified' });
  expect(JSON.stringify(store.chain())).not.toContain('raw-chain-key');
});

it('keys() lists the stored keys without opening them', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  expect(store.keys()).toEqual([]);
  store.addKey({ provider: 'gemini', label: 'Gemini', apiKey: 'raw-key', costClass: 'free' }, 10);
  const [row] = store.keys();
  expect(row).toMatchObject({
    provider: 'gemini',
    label: 'Gemini',
    costClass: 'free',
    enabled: true,
  });
  expect(row?.apiKeyEnc).not.toContain('raw-key');
});

it('several keys for the same provider are all listed and independently editable', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  const a = store.addKey({ provider: 'gemini', label: 'Key A', apiKey: 'raw-a' }, 10);
  const b = store.addKey({ provider: 'gemini', label: 'Key B', apiKey: 'raw-b' }, 10);
  expect(a).not.toBe(b);
  expect(
    store
      .keys()
      .map((k) => k.label)
      .sort(),
  ).toEqual(['Key A', 'Key B']);
  store.updateKey(a, { label: 'Key A renamed' }, 11);
  expect(store.keys().find((k) => k.keyId === a)?.label).toBe('Key A renamed');
  expect(store.keys().find((k) => k.keyId === b)?.label).toBe('Key B');
  store.removeKey(a);
  expect(store.keys().map((k) => k.keyId)).toEqual([b]);
});

it('saveGithubToken seals the token and never exposes it in status()', () => {
  const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
  store.saveGithubToken('ghp_raw-token');
  const sealed = assistantProvidersRepo.getGithubTokenEnc(t.scopes.instance());
  expect(sealed).not.toBeNull();
  expect(sealed).not.toContain('ghp_raw-token');
  expect(JSON.stringify(store.status())).not.toContain('ghp_raw-token');
  store.saveGithubToken(null);
  expect(assistantProvidersRepo.getGithubTokenEnc(t.scopes.instance())).toBeNull();
});

it('lists Gemini models with a pasted key, or the first saved gemini key, never returning the key', async () => {
  const seen: string[] = [];
  const store = createProviderConfigStore(
    t.scopes.instance(),
    'a'.repeat(32),
    'env',
    undefined,
    async (apiKey) => {
      seen.push(apiKey);
      return [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }];
    },
  );
  await expect(store.listModels('gemini', 'pasted-key')).resolves.toEqual([
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  ]);
  await expect(store.listModels('gemini')).rejects.toThrow('no-key');
  store.addKey({ provider: 'gemini', label: 'Gemini', apiKey: 'saved-key' }, 10);
  await store.listModels('gemini');
  expect(seen).toEqual(['pasted-key', 'saved-key']);
  // A saved key belongs to its service: never used to list another's models.
  await expect(store.listModels('openrouter')).rejects.toThrow('unsupported');
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
