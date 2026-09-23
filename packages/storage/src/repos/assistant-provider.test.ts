import { afterEach, beforeEach, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { get, put } from './assistant-provider.js';

let t: MigratedTestDatabase;
beforeEach(() => {
  t = openMigratedTestDatabase();
});
afterEach(() => t.close());

it('round-trips the fallback model and the web search settings', () => {
  const scope = t.scopes.instance();
  put(scope, {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    fallbackModel: 'gemini-2.5-flash-lite',
    apiKeyEnc: 'sealed-provider-key',
    enabled: true,
    costClass: 'free',
    searchApiKeyEnc: 'sealed-search-key',
    searchEnabled: true,
    updatedAt: 1,
  });
  expect(get(scope)).toEqual({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    fallbackModel: 'gemini-2.5-flash-lite',
    apiKeyEnc: 'sealed-provider-key',
    enabled: true,
    costClass: 'free',
    searchApiKeyEnc: 'sealed-search-key',
    searchEnabled: true,
    updatedAt: 1,
  });
});

it('reads absent optional settings as absent and search as off', () => {
  const scope = t.scopes.instance();
  put(scope, { provider: 'off', enabled: false, costClass: 'unknown', updatedAt: 1 });
  expect(get(scope)).toEqual({
    provider: 'off',
    enabled: false,
    costClass: 'unknown',
    searchEnabled: false,
    updatedAt: 1,
  });
});
