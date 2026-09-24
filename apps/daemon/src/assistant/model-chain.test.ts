import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig, type TextProvider } from '@bananasaurs/core';
import { assistantProvidersRepo, type InstanceScope } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { resolveModelChain, type ChainEntry } from './model-chain.js';

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

type Eligibility = Parameters<typeof resolveModelChain>[0]['eligibility'];
type EligibilityRow = NonNullable<ReturnType<Eligibility>>;

const eligible = (trainsOnInput: EligibilityRow['trainsOnInput'] = 'no'): EligibilityRow => ({
  provider: 'gemini',
  trainsOnInput,
  evidenceUrl: 'https://example.com/terms',
  productionUseAllowed: true,
  reviewedAt: 1,
});

const resolve = (
  instance: InstanceScope,
  overrides: Partial<Parameters<typeof resolveModelChain>[0]> = {},
): { entries: readonly ChainEntry[]; makeProvider: ReturnType<typeof vi.fn> } => {
  const makeProvider = vi.fn(
    (
      providerId: 'gemini' | 'openrouter' | 'nvidia-nim',
      _apiKey: string,
      _costClass: 'free' | 'paid' | 'unknown',
    ): TextProvider => ({
      id: providerId,
      capabilities: new Set(['text']),
      generateText: async () => ({ text: 'ok', model: 'm' }),
    }),
  );
  const entries = resolveModelChain({    instance,
    config: base,
    openKey: () => undefined,
    eligibility: () => undefined,
    makeProvider,
    ...overrides,
  });
  return { entries, makeProvider };
};

describe('resolveModelChain', () => {
  it('seeds from env when both tables are empty', () => {
    const config = {
      ...base,
      AI_PROVIDER: 'gemini' as const,
      AI_MODEL: 'env-model',
      GEMINI_API_KEY: 'env-key',
      AI_PROFILE_COST_CLASS: 'free' as const,
      AI_FALLBACK_MODELS: ['env-lite', 'env-third'],
    };
    const { entries, makeProvider } = resolve(t.scopes.instance(), {
      config,
      eligibility: () => eligible(),
    });
    expect(entries.map((e) => ({ providerId: e.providerId, model: e.model, skip: e.skip }))).toEqual([
      { providerId: 'gemini', model: 'env-model', skip: undefined },
      { providerId: 'gemini', model: 'env-lite', skip: undefined },
      { providerId: 'gemini', model: 'env-third', skip: undefined },
    ]);
    expect(entries.every((e) => e.provider?.id === 'gemini')).toBe(true);
    expect(makeProvider).toHaveBeenCalledTimes(3);
    expect(makeProvider).toHaveBeenNthCalledWith(1, 'gemini', 'env-key', 'free');
  });

  it('resolves nothing when the env names no provider or no model', () => {
    expect(resolve(t.scopes.instance(), { eligibility: () => eligible() }).entries).toEqual([]);
    const noModel = { ...base, AI_PROVIDER: 'gemini' as const, GEMINI_API_KEY: 'env-key' };
    expect(
      resolve(t.scopes.instance(), { config: noModel, eligibility: () => eligible() }).entries,
    ).toEqual([]);
  });

  it('a stored chain overrides the env seed', () => {
    const scope = t.scopes.instance();
    assistantProvidersRepo.upsertProvider(scope, {
      provider: 'gemini',
      apiKeyEnc: 'sealed',
      costClass: 'free',
      enabled: true,
      now: 10,
    });
    assistantProvidersRepo.setModelChain(scope, [{ provider: 'gemini', model: 'stored-model' }], 10);
    const config = {
      ...base,
      AI_PROVIDER: 'openrouter' as const,
      AI_MODEL: 'env-model',
      OPENROUTER_API_KEY: 'env-key',
    };
    const { entries } = resolve(scope, {
      config,
      openKey: () => 'stored-key',
      eligibility: () => eligible(),
    });
    expect(entries.map((e) => e.model)).toEqual(['stored-model']);
    expect(entries[0]?.providerId).toBe('gemini');
  });

  it('marks an entry with no key as no-key', () => {
    const scope = t.scopes.instance();
    assistantProvidersRepo.upsertProvider(scope, { provider: 'gemini', enabled: true, now: 10 });
    assistantProvidersRepo.setModelChain(scope, [{ provider: 'gemini', model: 'm' }], 10);
    const { entries, makeProvider } = resolve(scope, { eligibility: () => eligible() });
    expect(entries).toMatchObject([{ providerId: 'gemini', model: 'm', skip: 'no-key', provider: undefined }]);
    expect(makeProvider).not.toHaveBeenCalled();
  });

  it('marks an entry whose key does not open as key-unreadable', () => {
    const scope = t.scopes.instance();
    assistantProvidersRepo.upsertProvider(scope, {
      provider: 'gemini',
      apiKeyEnc: 'sealed-with-another-secret',
      enabled: true,
      now: 10,
    });
    assistantProvidersRepo.setModelChain(scope, [{ provider: 'gemini', model: 'm' }], 10);
    const { entries } = resolve(scope, { openKey: () => undefined, eligibility: () => eligible() });
    expect(entries).toMatchObject([{ skip: 'key-unreadable', provider: undefined }]);
  });

  it('marks entries without an eligibility row as unverified, and refused terms as ineligible', () => {
    const scope = t.scopes.instance();
    assistantProvidersRepo.upsertProvider(scope, {
      provider: 'gemini',
      apiKeyEnc: 'sealed',
      enabled: true,
      now: 10,
    });
    assistantProvidersRepo.setModelChain(scope, [{ provider: 'gemini', model: 'm' }], 10);
    const openKey = (): string | undefined => 'raw-key';
    expect(
      resolve(scope, { openKey, eligibility: () => undefined }).entries,
    ).toMatchObject([{ skip: 'unverified', provider: undefined }]);
    expect(
      resolve(scope, { openKey, eligibility: () => ({ ...eligible(), productionUseAllowed: false }) })
        .entries,
    ).toMatchObject([{ skip: 'ineligible', provider: undefined }]);
  });

  it.each(['yes', 'unknown'] as const)(
    'keeps a trainsOnInput=%s provider usable but flags mayTrain',
    (trainsOnInput) => {
      const scope = t.scopes.instance();
      assistantProvidersRepo.upsertProvider(scope, {
        provider: 'gemini',
        apiKeyEnc: 'sealed',
        enabled: true,
        now: 10,
      });
      assistantProvidersRepo.setModelChain(scope, [{ provider: 'gemini', model: 'm' }], 10);
      const { entries } = resolve(scope, {
        openKey: () => 'raw-key',
        eligibility: () => eligible(trainsOnInput),
      });
      expect(entries).toMatchObject([{ skip: undefined, mayTrain: true }]);
      expect(entries[0]?.provider?.id).toBe('gemini');
    },
  );

  it('marks a disabled provider as disabled even with a good key and terms', () => {
    const scope = t.scopes.instance();
    assistantProvidersRepo.upsertProvider(scope, {
      provider: 'gemini',
      apiKeyEnc: 'sealed',
      enabled: false,
      now: 10,
    });
    assistantProvidersRepo.setModelChain(scope, [{ provider: 'gemini', model: 'm' }], 10);
    const { entries } = resolve(scope, { openKey: () => 'raw-key', eligibility: () => eligible() });
    expect(entries).toMatchObject([{ skip: 'disabled', provider: undefined }]);
  });

  it('never surfaces a key outside the constructed provider', () => {
    const scope = t.scopes.instance();
    assistantProvidersRepo.upsertProvider(scope, {
      provider: 'gemini',
      apiKeyEnc: 'sealed',
      costClass: 'free',
      enabled: true,
      now: 10,
    });
    assistantProvidersRepo.setModelChain(
      scope,
      [
        { provider: 'gemini', model: 'm-one' },
        { provider: 'gemini', model: 'm-two' },
      ],
      10,
    );
    const { entries } = resolve(scope, { openKey: () => 'raw-secret-value', eligibility: () => eligible() });
    expect(entries).toHaveLength(2);
    const withoutProviders = JSON.stringify(
      entries.map((e) => ({ providerId: e.providerId, model: e.model, skip: e.skip, mayTrain: e.mayTrain })),
    );
    expect(withoutProviders).not.toContain('raw-secret-value');
    expect(withoutProviders).not.toContain('sealed');
  });
});
