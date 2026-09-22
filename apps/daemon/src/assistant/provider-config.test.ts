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
    enabled: true,
    modelConfigured: true,
    keyConfigured: true,
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
