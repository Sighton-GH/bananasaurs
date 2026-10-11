import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '@bananasaurs/core';
import {
  assistantKeyCooldownsRepo,
  assistantProviderRepo,
  assistantProvidersRepo,
  searchKeysRepo,
} from '@bananasaurs/storage';
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
it('stores project and fingerprint, and persists and clears cooldowns (ADR 0143)', () => {
  const instance = t.scopes.instance();
  const store = createProviderConfigStore(instance, 'a'.repeat(32));
  const keyId = store.addKey(
    {
      provider: 'gemini',
      label: 'Gemini 1',
      apiKey: 'AIza-test-one',
      project: 'Car Team A',
      fingerprint: assistantProvidersRepo.fingerprintOf('AIza-test-one'),
    },
    10,
  );
  expect(assistantProvidersRepo.listKeys(instance)[0]).toMatchObject({
    project: 'Car Team A',
    fingerprint: assistantProvidersRepo.fingerprintOf('AIza-test-one'),
  });
  store.setCooldown({ keyId, model: 'm', until: 5000, reason: 'day', setAt: 1000 });
  expect(assistantKeyCooldownsRepo.getCooldown(instance, keyId, 'm', 2000)).toBeDefined();
  store.clearCooldowns(keyId);
  expect(assistantKeyCooldownsRepo.getCooldown(instance, keyId, 'm', 2000)).toBeUndefined();
});
it('reserveTestEntry counts against the given selected key (ADR 0143)', () => {
  const instance = t.scopes.instance();
  const store = createProviderConfigStore(instance, 'a'.repeat(32));
  const first = store.addKey({ provider: 'gemini', label: 'One', apiKey: 'AIza-test-one' }, 10);
  const second = store.addKey({ provider: 'gemini', label: 'Two', apiKey: 'AIza-test-two' }, 10);
  const entry = {
    keyId: first,
    selectedKeyId: second,
    model: 'm',
    providerId: 'gemini' as const,
    rpmLimit: null,
    rpdLimit: 1,
  };
  expect(store.reserveTestEntry(entry, '123456789012345678')).toEqual({ ok: true });
  expect(store.reserveTestEntry(entry, '123456789012345678')).toMatchObject({ ok: false });
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

const GUILD = '123456789012345678';

/**
 * Web search keys (ADR 0120): several sealed keys per source with their own
 * limits, tried in the owner's order. Replaces the ADR 0066 single-key test:
 * `save()` no longer takes `searchApiKey`, and `effective()` never carries a
 * search key — search runs through `webSearch()`.
 */
describe('web search keys (ADR 0120)', () => {
  it('addSearchKey seals; the plaintext never appears in searchKeys() or status()', () => {
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
    const keyId = store.addSearchKey(
      { source: 'brave', label: 'Brave key', apiKey: 'brave-raw-key' },
      10,
    );
    expect('apiKeyEnc' in store.searchKeys()[0]!).toBe(false);
    const sealed = searchKeysRepo.listSearchKeys(t.scopes.instance())[0]?.apiKeyEnc;
    expect(sealed).not.toContain('brave-raw-key');
    expect(JSON.stringify(store.searchKeys())).not.toContain('brave-raw-key');
    expect(JSON.stringify(store.status())).not.toContain('brave-raw-key');
    expect(store.isSearchKeyReadable(keyId)).toBe(true);
    expect(store.isSearchKeyReadable('skey_does-not-exist')).toBe(false);
    const other = createProviderConfigStore(t.scopes.instance(), 'b'.repeat(32));
    expect(other.isSearchKeyReadable(keyId)).toBe(false);
  });

  it('webSearch() is undefined while search is off, with no keys, or with only the other source keys', () => {
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
    expect(store.webSearch(GUILD)).toBeUndefined();
    store.addSearchKey({ source: 'brave', label: 'B', apiKey: 'brave-raw' }, 10);
    // No saved row yet, and no env seed: still off.
    expect(store.webSearch(GUILD)).toBeUndefined();
    store.save({ provider: 'gemini', enabled: true, searchEnabled: true }, 11);
    expect(store.webSearch(GUILD)).not.toBeUndefined();
    // Only the other source's keys: nothing usable for the current source.
    store.save(
      { provider: 'gemini', enabled: true, searchEnabled: true, searchSource: 'tavily' },
      12,
    );
    expect(store.webSearch(GUILD)).toBeUndefined();
    // Back off: undefined even with keys stored.
    store.save({ provider: 'gemini', enabled: true, searchEnabled: false }, 13);
    expect(store.webSearch(GUILD)).toBeUndefined();
  });

  it('webSearch() uses only enabled keys of the current source, in position order', async () => {
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
    store.save(
      { provider: 'gemini', enabled: true, searchEnabled: true, searchSource: 'tavily' },
      10,
    );
    const first = store.addSearchKey({ source: 'tavily', label: 'T1', apiKey: 'tavily-one' }, 11);
    store.addSearchKey({ source: 'tavily', label: 'T2', apiKey: 'tavily-two' }, 12);
    store.addSearchKey({ source: 'brave', label: 'B1', apiKey: 'brave-one' }, 13);
    const braveSeen: string[] = [];
    const tavilySeen: string[] = [];
    const clients = {
      brave: vi.fn(async (apiKey: string, _q: string) => {
        braveSeen.push(apiKey);
        return [];
      }),
      tavily: vi.fn(async (apiKey: string, _q: string) => {
        tavilySeen.push(apiKey);
        return [];
      }),
    };
    await store.webSearch(GUILD, clients)!('q');
    expect(tavilySeen).toEqual(['tavily-one']);
    expect(braveSeen).toEqual([]);
    expect(JSON.stringify(tavilySeen)).not.toContain('brave-one');
    store.updateSearchKey(first, { enabled: false }, 14);
    await store.webSearch(GUILD, clients)!('q');
    expect(tavilySeen).toEqual(['tavily-one', 'tavily-two']);
  });

  it('webSearch() ignores the .env Brave seed once a key store exists', async () => {
    const envBase = { ...base, BRAVE_SEARCH_API_KEY: 'env-key' };
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32), 'env', envBase);
    // No row and an env key: still undefined — the seed is dead here.
    expect(store.webSearch(GUILD)).toBeUndefined();
    store.save({ provider: 'gemini', enabled: true, searchEnabled: false }, 10);
    expect(store.webSearch(GUILD)).toBeUndefined();
  });

  it('status().webSearch reports the stored source even while search is off with no keys', () => {
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
    store.save(
      { provider: 'gemini', enabled: true, searchEnabled: false, searchSource: 'tavily' },
      10,
    );
    expect(store.status().webSearch).toEqual({
      keyConfigured: false,
      enabled: false,
      source: 'tavily',
    });
  });

  it('status().webSearch carries keyConfigured/enabled/source, absent when unused', () => {
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
    expect(store.status().webSearch).toBeUndefined();
    store.save({ provider: 'gemini', enabled: true, searchEnabled: true }, 10);
    expect(store.status().webSearch).toEqual({
      keyConfigured: false,
      enabled: true,
      source: 'brave',
    });
    store.addSearchKey({ source: 'brave', label: 'B', apiKey: 'brave-raw' }, 11);
    expect(store.status().webSearch).toEqual({
      keyConfigured: true,
      enabled: true,
      source: 'brave',
    });
    store.save(
      { provider: 'gemini', enabled: true, searchEnabled: true, searchSource: 'tavily' },
      12,
    );
    // The stored key belongs to the other source now.
    expect(store.status().webSearch).toEqual({
      keyConfigured: false,
      enabled: true,
      source: 'tavily',
    });
  });

  it('save() without searchSource keeps the saved source', () => {
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
    store.save(
      { provider: 'gemini', enabled: true, searchEnabled: true, searchSource: 'tavily' },
      10,
    );
    expect(assistantProviderRepo.get(t.scopes.instance())?.searchSource).toBe('tavily');
    store.save({ provider: 'gemini', enabled: true, searchEnabled: true }, 11);
    expect(assistantProviderRepo.get(t.scopes.instance())?.searchSource).toBe('tavily');
    expect(store.status().webSearch?.source).toBe('tavily');
  });

  it('effective() never returns BRAVE_SEARCH_API_KEY once a row exists', () => {
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
    store.save({ provider: 'gemini', enabled: true }, 10);
    expect(
      store.effective({ ...base, BRAVE_SEARCH_API_KEY: 'env-key' }).BRAVE_SEARCH_API_KEY,
    ).toBeUndefined();
    store.save(
      { provider: 'gemini', enabled: true, searchEnabled: true, searchSource: 'tavily' },
      11,
    );
    store.addSearchKey({ source: 'tavily', label: 'T', apiKey: 'tavily-raw' }, 12);
    const effective = store.effective({ ...base, BRAVE_SEARCH_API_KEY: 'env-key' });
    expect(effective.BRAVE_SEARCH_API_KEY).toBeUndefined();
    expect(JSON.stringify(effective)).not.toContain('tavily-raw');
  });

  it('updateSearchKey re-seals only with a new apiKey; usage is undefined for unknown keys', () => {
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
    const keyId = store.addSearchKey({ source: 'brave', label: 'B', apiKey: 'alpha-secret' }, 10);
    const sealedOf = (): string | undefined =>
      searchKeysRepo.listSearchKeys(t.scopes.instance()).find((k) => k.keyId === keyId)?.apiKeyEnc;
    const before = sealedOf();
    expect(store.updateSearchKey(keyId, { label: 'B renamed' }, 11)).toBe(true);
    expect(sealedOf()).toBe(before);
    expect(store.updateSearchKey(keyId, { apiKey: 'beta-secret' }, 12)).toBe(true);
    const after = sealedOf();
    expect(after).not.toBe(before);
    expect(after).not.toContain('beta-secret');
    expect(store.updateSearchKey('skey_does-not-exist', { label: 'x' }, 13)).toBe(false);
    expect(store.searchKeyUsage('skey_does-not-exist')).toBeUndefined();
    expect(store.searchKeyUsage(keyId)).toMatchObject({ last24h: 0, last31d: 0 });
  });
});

/**
 * Task 6b fix round 1 (controller finding): `save()` is the only dashboard
 * write path that exists until Task 8 replaces it with the multi-key UI, and
 * it used to write only the legacy `assistant_provider_config` row — which
 * `status()`/`effective()`/`chain()` stopped reading in Task 6b. So every
 * dashboard save silently did nothing. `save()` now also maps its AI fields
 * onto a `key_<provider>` key and a one-key chain.
 */
describe('save() also writes the keys + chain tables it now reads (Task 6b fix round 1)', () => {
  it('save with a key makes status() report the provider, model, key and cost class', () => {
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32), 'file');
    store.save(
      {
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        apiKey: 'raw-key',
        enabled: true,
        costClass: 'free',
      },
      10,
    );
    expect(store.status()).toMatchObject({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      enabled: true,
      keyConfigured: true,
      keyReadable: true,
      costClass: 'free',
    });
    const [key] = assistantProvidersRepo.listKeys(t.scopes.instance());
    expect(key).toMatchObject({ keyId: 'key_gemini', provider: 'gemini', label: 'Gemini' });
    expect(key?.apiKeyEnc).not.toContain('raw-key');
  });

  it('save without an apiKey keeps the existing sealed key', () => {
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
    store.save({ provider: 'gemini', model: 'm', apiKey: 'raw-key', enabled: true }, 10);
    const before = assistantProvidersRepo.listKeys(t.scopes.instance())[0]!.apiKeyEnc;
    store.save({ provider: 'gemini', model: 'm2', enabled: true }, 11);
    const after = assistantProvidersRepo.listKeys(t.scopes.instance());
    expect(after).toHaveLength(1);
    expect(after[0]?.apiKeyEnc).toBe(before);
    expect(store.status()).toMatchObject({ model: 'm2', keyReadable: true });
  });

  it('switching provider moves chain entry 0 to the other provider key, without losing the first key', () => {
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
    store.save({ provider: 'gemini', model: 'g-model', apiKey: 'gemini-raw', enabled: true }, 10);
    store.save({ provider: 'openrouter', model: 'or-model', apiKey: 'or-raw', enabled: true }, 11);
    expect(store.status()).toMatchObject({ provider: 'openrouter', model: 'or-model' });
    expect(store.effective(base)).toMatchObject({
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'or-raw',
    });
    // The gemini key row survives the switch (it just left the chain).
    expect(
      assistantProvidersRepo
        .listKeys(t.scopes.instance())
        .map((k) => k.provider)
        .sort(),
    ).toEqual(['gemini', 'openrouter']);
  });

  it("provider 'off' empties the chain", () => {
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
    store.save({ provider: 'gemini', model: 'm', apiKey: 'raw', enabled: true }, 10);
    expect(assistantProvidersRepo.getModelChain(t.scopes.instance())).toHaveLength(1);
    store.save({ provider: 'off', enabled: false }, 11);
    expect(assistantProvidersRepo.getModelChain(t.scopes.instance())).toEqual([]);
    expect(store.status().provider).toBe('off');
  });

  it('a fresh save with enabled: false stores a disabled key (Task 6b fix round 2)', () => {
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
    store.save({ provider: 'gemini', model: 'm', apiKey: 'raw-key', enabled: false }, 10);
    const [key] = assistantProvidersRepo.listKeys(t.scopes.instance());
    expect(key).toMatchObject({ keyId: 'key_gemini', enabled: false });
    expect(store.status()).toMatchObject({ enabled: false });
  });

  it('a key is never present in status(), effective() or the raw stored row', () => {
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
    store.save(
      { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'must-never-leak', enabled: true },
      10,
    );
    expect(JSON.stringify(store.status())).not.toContain('must-never-leak');
    expect(JSON.stringify(store.effective(base))).toContain('must-never-leak'); // effective() opens it, by design, for the provider client
    const [key] = assistantProvidersRepo.listKeys(t.scopes.instance());
    expect(key?.apiKeyEnc).not.toContain('must-never-leak');
  });
});

describe('githubToken() (Task 17)', () => {
  it('opens the sealed GitHub token, undefined once cleared or unreadable', () => {
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
    expect(store.githubToken()).toBeUndefined();
    store.saveGithubToken('ghp_open-me');
    expect(store.githubToken()).toBe('ghp_open-me');
    expect(JSON.stringify(store.status())).not.toContain('ghp_open-me');
    store.saveGithubToken(null);
    expect(store.githubToken()).toBeUndefined();
  });

  it('returns undefined under the wrong master secret instead of throwing', () => {
    const store = createProviderConfigStore(t.scopes.instance(), 'a'.repeat(32));
    store.saveGithubToken('ghp_open-me');
    const wrongKey = createProviderConfigStore(t.scopes.instance(), 'b'.repeat(32));
    expect(wrongKey.githubToken()).toBeUndefined();
  });
});

describe('per-entry RPM/RPD limits (ADR 0081)', () => {
  const GUILD_ID = '123456789012345678';

  it('saveChain stores the limits and chain() carries them; absent limits read as null', () => {
    let now = 1_800_000_000_000;
    const store = createProviderConfigStore(
      t.scopes.instance(),
      'a'.repeat(32),
      'env',
      undefined,
      undefined,
      { now: () => now },
    );
    const keyId = store.addKey({ provider: 'gemini', label: 'Gemini', apiKey: 'k' }, now);
    now += 1;
    store.saveChain(
      [
        { keyId, model: 'm-limited', rpmLimit: 15, rpdLimit: 1000 },
        { keyId, model: 'm-plain' },
      ],
      now,
    );
    const chain = store.chain();
    expect(chain[0]).toMatchObject({ rpmLimit: 15, rpdLimit: 1000 });
    expect(chain[1]).toMatchObject({ rpmLimit: null, rpdLimit: null });
    expect(assistantProvidersRepo.getModelChain(t.scopes.instance())[0]).toMatchObject({
      rpmLimit: 15,
      rpdLimit: 1000,
    });
  });

  it('reserveTestCall counts against the limits and modelUsage reports the call', () => {
    let now = 1_800_000_000_000;
    const store = createProviderConfigStore(
      t.scopes.instance(),
      'a'.repeat(32),
      'env',
      undefined,
      undefined,
      { now: () => now },
    );
    const keyId = store.addKey({ provider: 'gemini', label: 'Gemini', apiKey: 'k' }, now);
    now += 1;
    store.saveChain([{ keyId, model: 'm', rpmLimit: 1 }], now);
    expect(store.reserveTestCall(0, GUILD_ID)).toEqual({ ok: true });
    now += 1000;
    expect(store.reserveTestCall(0, GUILD_ID)).toEqual({
      ok: false,
      code: 'local-rpm-limit',
      availableAt: 1_800_000_000_001 + 60_000,
    });
    expect(store.modelUsage(store.chain()[0]!)).toMatchObject({ lastMinute: 1 });
    expect(store.reserveTestCall(9, GUILD_ID)).toEqual({ ok: true });
  });
});

describe('chain pool and tier settings (ADR 0143)', () => {
  it('saves pool and tier, defaults old rows, and preserves resolved fields', () => {
    const scope = t.scopes.instance();
    const store = createProviderConfigStore(scope, 'a'.repeat(32));
    const keyId = store.addKey({ provider: 'gemini', label: 'Sam L', apiKey: 'AIza-test-one' }, 10);
    store.saveChain(
      [
        { keyId, model: 'one', pool: 'provider', tier: 'light' },
        { keyId, model: 'two' },
      ],
      10,
    );
    expect(assistantProvidersRepo.getModelChain(scope)).toMatchObject([
      { pool: 'provider', tier: 'light' },
      { pool: 'key', tier: 'standard' },
    ]);
    expect(store.chain()).toMatchObject([
      { pool: 'provider', tier: 'light', selectedKeyId: keyId },
      { pool: 'key', tier: 'standard', selectedKeyId: keyId },
    ]);
  });
  it('rejects invalid pool and tier without replacing the saved chain', () => {
    const scope = t.scopes.instance();
    const store = createProviderConfigStore(scope, 'a'.repeat(32));
    const keyId = store.addKey({ provider: 'gemini', label: 'Sam L', apiKey: 'AIza-test-one' }, 10);
    store.saveChain([{ keyId, model: 'one' }], 10);
    // Runtime inputs can arrive without TypeScript's literal validation.
    // @ts-expect-error invalid pool exercises the runtime boundary
    expect(() => store.saveChain([{ keyId, model: 'two', pool: 'invalid' }], 11)).toThrow('pool');
    // @ts-expect-error invalid tier exercises the runtime boundary
    expect(() => store.saveChain([{ keyId, model: 'two', tier: 'invalid' }], 11)).toThrow('tier');
    expect(assistantProvidersRepo.getModelChain(scope)[0]?.model).toBe('one');
  });
});
