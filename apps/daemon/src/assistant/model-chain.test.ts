import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  nextProviderDayStart,
  providerDayStart,
  parseConfig,
  ProviderError,
  type TextProvider,
} from '@bananasaurs/core';
import {
  assistantProvidersRepo,
  assistantKeyCooldownsRepo,
  modelCallsRepo,
  type InstanceScope,
} from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { makeProvider, resolveModelChain, selectPoolKey, type ChainEntry } from './model-chain.js';

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

const addKey = (
  scope: InstanceScope,
  input: Partial<Parameters<typeof assistantProvidersRepo.addKey>[1]> & {
    provider: 'gemini' | 'openrouter' | 'nvidia-nim';
  },
): string =>
  assistantProvidersRepo.addKey(scope, {
    label: 'Test key',
    apiKeyEnc: 'sealed',
    now: 10,
    ...input,
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
  const entries = resolveModelChain({
    instance,
    config: base,
    openKey: () => undefined,
    eligibility: () => undefined,
    makeProvider,
    ...overrides,
  });
  return { entries, makeProvider };
};

describe('resolveModelChain', () => {
  it('forwards idle and ceiling timeouts from resolve readers to makeProvider', () => {
    const seen: unknown[] = [];
    const fake = {
      id: 'gemini',
      capabilities: new Set(['text']),
      generateText: async () => ({ text: 'x', model: 'gemini-3.8-flash' }),
    } as const;
    const entries = resolveModelChain({
      instance: t.scopes.instance(),
      config: {
        AI_PROVIDER: 'gemini',
        AI_MODEL: 'gemini-3.8-flash',
        AI_PROFILE_COST_CLASS: 'free',
        GEMINI_API_KEY: 'k',
      },
      openKey: () => 'k',
      eligibility: () => eligible(),
      makeProvider: (_provider, _apiKey, _costClass, options) => {
        seen.push(options);
        return fake as never;
      },
      providerTimeoutMs: () => 60_000,
      providerIdleTimeoutMs: () => 45_000,
      providerMaxCallMs: () => 300_000,
    });
    expect(entries.length).toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({ timeoutMs: 60_000, idleTimeoutMs: 45_000, maxCallMs: 300_000 });
  });

  it('seeds from env when both tables are empty, all fallback models sharing the synthetic env key', () => {
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
    expect(
      entries.map((e) => ({
        providerId: e.providerId,
        model: e.model,
        keyId: e.keyId,
        keyLabel: e.keyLabel,
        skip: e.skip,
      })),
    ).toEqual([
      {
        providerId: 'gemini',
        model: 'env-model',
        keyId: 'key_env',
        keyLabel: 'From .env',
        skip: undefined,
      },
      {
        providerId: 'gemini',
        model: 'env-lite',
        keyId: 'key_env',
        keyLabel: 'From .env',
        skip: undefined,
      },
      {
        providerId: 'gemini',
        model: 'env-third',
        keyId: 'key_env',
        keyLabel: 'From .env',
        skip: undefined,
      },
    ]);
    expect(entries.every((e) => e.provider?.id === 'gemini')).toBe(true);
    // All three share the synthetic env key, so they share one built instance.
    expect(makeProvider).toHaveBeenCalledTimes(1);
    expect(makeProvider).toHaveBeenCalledWith('gemini', 'env-key', 'free');
    expect(entries[0]?.provider).toBe(entries[1]?.provider);
    expect(entries[1]?.provider).toBe(entries[2]?.provider);
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
    const keyId = addKey(scope, { provider: 'gemini', apiKeyEnc: 'sealed', now: 10 });
    assistantProvidersRepo.setModelChain(scope, [{ keyId, model: 'stored-model' }], 10);
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
    expect(entries[0]?.keyId).toBe(keyId);
  });

  it('marks an entry with no key as no-key', () => {
    const scope = t.scopes.instance();
    // A key row exists with nothing in its own right to test "no key" against
    // the *entry* path is covered separately; here the chain names a key id
    // that was never created, which the foreign key refuses at write time —
    // so the "no-key" candidate case is exercised through a disabled row
    // without opening a key (see the key-unreadable case below for the other
    // half). This case is: a real key row whose apiKeyEnc never seals to
    // anything openable is "key-unreadable", not "no-key"; "no-key" only
    // arises if a chain row's key vanished after the chain was saved, which
    // the schema's FK prevents — so resolveModelChain's own defensive
    // no-key branch is covered directly via a chain row referencing a
    // deleted key underneath the ORM (belt-and-braces, not a normal path).
    const keyId = addKey(scope, { provider: 'gemini', now: 10 });
    assistantProvidersRepo.setModelChain(scope, [{ keyId, model: 'm' }], 10);
    assistantProvidersRepo.removeKey(scope, keyId);
    const { entries, makeProvider } = resolve(scope, { eligibility: () => eligible() });
    // The cascade removed the chain row along with the key, so the chain is
    // simply empty — proving the FK, not a dangling "no-key" entry.
    expect(entries).toEqual([]);
    expect(makeProvider).not.toHaveBeenCalled();
  });

  it('marks an entry whose key does not open as key-unreadable', () => {
    const scope = t.scopes.instance();
    const keyId = addKey(scope, {
      provider: 'gemini',
      apiKeyEnc: 'sealed-with-another-secret',
      now: 10,
    });
    assistantProvidersRepo.setModelChain(scope, [{ keyId, model: 'm' }], 10);
    const { entries } = resolve(scope, { openKey: () => undefined, eligibility: () => eligible() });
    expect(entries).toMatchObject([{ skip: 'key-unreadable', provider: undefined }]);
    // Unreadable remains the reason even without a terms row, preserving env fallback.
    expect(resolve(scope).entries).toMatchObject([{ skip: 'key-unreadable', provider: undefined }]);
  });

  it('marks entries without an eligibility row as unverified, and refused terms as ineligible', () => {
    const scope = t.scopes.instance();
    const keyId = addKey(scope, { provider: 'gemini', apiKeyEnc: 'sealed', now: 10 });
    assistantProvidersRepo.setModelChain(scope, [{ keyId, model: 'm' }], 10);
    const openKey = (): string | undefined => 'raw-key';
    expect(resolve(scope, { openKey, eligibility: () => undefined }).entries).toMatchObject([
      { skip: 'unverified', provider: undefined },
    ]);
    expect(
      resolve(scope, {
        openKey,
        eligibility: () => ({ ...eligible(), productionUseAllowed: false }),
      }).entries,
    ).toMatchObject([{ skip: 'ineligible', provider: undefined }]);
  });

  it.each(['yes', 'unknown'] as const)(
    'keeps a trainsOnInput=%s provider usable but flags mayTrain',
    (trainsOnInput) => {
      const scope = t.scopes.instance();
      const keyId = addKey(scope, { provider: 'gemini', apiKeyEnc: 'sealed', now: 10 });
      assistantProvidersRepo.setModelChain(scope, [{ keyId, model: 'm' }], 10);
      const { entries } = resolve(scope, {
        openKey: () => 'raw-key',
        eligibility: () => eligible(trainsOnInput),
      });
      expect(entries).toMatchObject([{ skip: undefined, mayTrain: true }]);
      expect(entries[0]?.provider?.id).toBe('gemini');
    },
  );

  it('marks a disabled key as disabled even with a good key and terms', () => {
    const scope = t.scopes.instance();
    const keyId = addKey(scope, { provider: 'gemini', apiKeyEnc: 'sealed', now: 10 });
    assistantProvidersRepo.updateKey(scope, keyId, { enabled: false, now: 11 });
    assistantProvidersRepo.setModelChain(scope, [{ keyId, model: 'm' }], 10);
    const { entries } = resolve(scope, { openKey: () => 'raw-key', eligibility: () => eligible() });
    expect(entries).toMatchObject([{ skip: 'disabled', provider: undefined }]);
  });

  it('never surfaces a key outside the constructed provider', () => {
    const scope = t.scopes.instance();
    const keyId = addKey(scope, { provider: 'gemini', apiKeyEnc: 'sealed', now: 10 });
    assistantProvidersRepo.setModelChain(
      scope,
      [
        { keyId, model: 'm-one' },
        { keyId, model: 'm-two' },
      ],
      10,
    );
    const { entries } = resolve(scope, {
      openKey: () => 'raw-secret-value',
      eligibility: () => eligible(),
    });
    expect(entries).toHaveLength(2);
    const withoutProviders = JSON.stringify(
      entries.map((e) => ({
        providerId: e.providerId,
        model: e.model,
        skip: e.skip,
        mayTrain: e.mayTrain,
      })),
    );
    expect(withoutProviders).not.toContain('raw-secret-value');
    expect(withoutProviders).not.toContain('sealed');
  });

  it('two keys for the same provider and the same model both resolve, each with its own label', () => {
    const scope = t.scopes.instance();
    const a = addKey(scope, { provider: 'gemini', label: 'Key A', apiKeyEnc: 'sealed-a', now: 10 });
    const b = addKey(scope, { provider: 'gemini', label: 'Key B', apiKeyEnc: 'sealed-b', now: 10 });
    assistantProvidersRepo.setModelChain(
      scope,
      [
        { keyId: a, model: 'gemini-2.5-flash' },
        { keyId: b, model: 'gemini-2.5-flash' },
      ],
      10,
    );
    const { entries, makeProvider } = resolve(scope, {
      openKey: (sealed) => (sealed === 'sealed-a' ? 'raw-a' : 'raw-b'),
      eligibility: () => eligible(),
    });
    expect(
      entries.map((e) => ({ keyId: e.keyId, keyLabel: e.keyLabel, model: e.model, skip: e.skip })),
    ).toEqual([
      { keyId: a, keyLabel: 'Key A', model: 'gemini-2.5-flash', skip: undefined },
      { keyId: b, keyLabel: 'Key B', model: 'gemini-2.5-flash', skip: undefined },
    ]);
    // Different keys, so two distinct provider instances built.
    expect(makeProvider).toHaveBeenCalledTimes(2);
    expect(entries[0]?.provider).not.toBe(entries[1]?.provider);
  });

  describe('the env fallback when the key-encryption secret is unreadable', () => {
    it('appends the env entry after unreadable stored entries, and it is the first usable one', () => {
      const scope = t.scopes.instance();
      const keyId = addKey(scope, { provider: 'gemini', apiKeyEnc: 'sealed', now: 10 });
      assistantProvidersRepo.setModelChain(scope, [{ keyId, model: 'stored-model' }], 10);
      const config = {
        ...base,
        AI_PROVIDER: 'gemini' as const,
        AI_MODEL: 'env-model',
        GEMINI_API_KEY: 'env-key',
      };
      const { entries } = resolve(scope, {
        config,
        // The daemon's secret cannot open any stored key.
        openKey: () => undefined,
        eligibility: () => eligible(),
      });
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ keyId, skip: 'key-unreadable', provider: undefined });
      expect(entries[1]).toMatchObject({
        keyId: 'key_env',
        keyLabel: 'From .env',
        model: 'env-model',
        skip: undefined,
      });
      const firstUsable = entries.find((e) => e.skip === undefined);
      expect(firstUsable?.model).toBe('env-model');
    });

    it('does not append when the env has no usable key either', () => {
      const scope = t.scopes.instance();
      const keyId = addKey(scope, { provider: 'gemini', apiKeyEnc: 'sealed', now: 10 });
      assistantProvidersRepo.setModelChain(scope, [{ keyId, model: 'stored-model' }], 10);
      const { entries } = resolve(scope, {
        openKey: () => undefined,
        eligibility: () => eligible(),
      });
      expect(entries).toEqual([
        {
          providerId: 'gemini',
          model: 'stored-model',
          keyId,
          keyLabel: 'Test key',
          pool: 'key',
          tier: 'standard',
          selectedKeyId: keyId,
          provider: undefined,
          skip: 'key-unreadable',
          mayTrain: false,
          rpmLimit: null,
          rpdLimit: null,
        },
      ]);
    });

    it('does not append when at least one stored entry is usable', () => {
      const scope = t.scopes.instance();
      const good = addKey(scope, { provider: 'gemini', apiKeyEnc: 'sealed-good', now: 10 });
      const bad = addKey(scope, { provider: 'openrouter', apiKeyEnc: 'sealed-bad', now: 10 });
      assistantProvidersRepo.setModelChain(
        scope,
        [
          { keyId: bad, model: 'bad-model' },
          { keyId: good, model: 'good-model' },
        ],
        10,
      );
      const config = {
        ...base,
        AI_PROVIDER: 'nvidia-nim' as const,
        AI_MODEL: 'env-model',
        NVIDIA_NIM_API_KEY: 'env-key',
      };
      const { entries } = resolve(scope, {
        config,
        openKey: (sealed) => (sealed === 'sealed-good' ? 'raw-good' : undefined),
        eligibility: () => eligible(),
      });
      expect(entries).toHaveLength(2);
      expect(entries.some((e) => e.keyId === 'key_env')).toBe(false);
    });
  });

  describe('makeProvider timeout', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });
    const textRequest = {
      model: 'm',
      messages: [{ role: 'user' as const, text: 'hi' }],
    };
    const stalledFetch = (): { signal: () => AbortSignal | undefined } => {
      let signal: AbortSignal | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: unknown, init: RequestInit): Promise<Response> => {
          signal = init.signal ?? undefined;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          });
        }),
      );
      return { signal: () => signal };
    };

    it.each(['openrouter', 'gemini', 'nvidia-nim'] as const)(
      'makeProvider(%s) enforces timeoutMs 7000 on its real adapter',
      async (providerId) => {
        vi.useFakeTimers();
        const fetch = stalledFetch();
        let settled = false;
        const result = makeProvider(providerId, 'k', 'free', { timeoutMs: 7000 })
          .generateText(textRequest)
          .catch((error: unknown) => {
            settled = true;
            return error;
          });
        await vi.advanceTimersByTimeAsync(6999);
        expect(fetch.signal()?.aborted).toBe(false);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetch.signal()?.aborted).toBe(true);
        expect(await result).toBeInstanceOf(ProviderError);
        expect(await result).toMatchObject({ kind: 'timeout', retryable: true });
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it('defaults to 30000 without options', async () => {
      vi.useFakeTimers();
      const fetch = stalledFetch();
      const result = makeProvider('openrouter', 'k', 'free')
        .generateText(textRequest)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(29999);
      expect(fetch.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch.signal()?.aborted).toBe(true);
      expect(await result).toMatchObject({ kind: 'timeout', retryable: true });
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['openrouter', 'gemini', 'nvidia-nim'] as const)(
      'makeProvider(%s) forwards idle and ceiling timers to the real streaming adapter',
      async (providerId) => {
        for (const [idleTimeoutMs, maxCallMs, expected] of [
          [50, 100, 50],
          [100, 50, 50],
        ] as const) {
          vi.useFakeTimers();
          let signal: AbortSignal | undefined;
          vi.stubGlobal(
            'fetch',
            vi.fn((_url: unknown, init: RequestInit): Promise<Response> => {
              signal = init.signal ?? undefined;
              return Promise.resolve(
                new Response(
                  new ReadableStream<Uint8Array>({
                    start: (controller) => {
                      controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
                    },
                  }),
                  {
                    headers: { 'content-type': 'text/event-stream' },
                  },
                ),
              );
            }),
          );
          let settled = false;
          const result = makeProvider(providerId, 'k', 'free', {
            timeoutMs: 1000,
            idleTimeoutMs,
            maxCallMs,
          })
            .generateText(textRequest)
            .catch((error: unknown) => {
              settled = true;
              return error;
            });
          await vi.advanceTimersByTimeAsync(expected - 1);
          expect(signal?.aborted).toBe(false);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(signal?.aborted).toBe(true);
          expect(await result).toMatchObject({ kind: 'timeout', retryable: true });
          expect(vi.getTimerCount()).toBe(0);
          vi.useRealTimers();
        }
      },
    );
  });
});

const NOW = Date.parse('2026-10-11T16:00:00Z');
const MODEL = 'gemini-3.8-flash';
const bucketOf = assistantProvidersRepo.bucketOf;

const spend = (scope: InstanceScope, keyId: string, count: number, at = NOW - 1000): void => {
  for (let i = 0; i < count; i++) {
    modelCallsRepo.reserveModelCall(scope, {
      keyId,
      model: MODEL,
      guildId: '234567890123456789',
      now: at,
      rpmLimit: null,
      rpdLimit: null,
      dayStart: providerDayStart('gemini', at),
      nextDayStart: nextProviderDayStart('gemini', at),
    });
  }
};

describe('pool resolution (ADR 0143)', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => vi.restoreAllMocks());
  const pool = (scope: InstanceScope) =>
    resolve(scope, {
      openKey: (sealed) => (sealed === 'unreadable' ? undefined : 'AIza-test-one'),
      eligibility: () => eligible(),
    });
  const key = (
    scope: InstanceScope,
    keyId: string,
    extra: Partial<Parameters<typeof assistantProvidersRepo.addKey>[1]> = {},
  ) => addKey(scope, { provider: 'gemini', keyId, ...extra });

  it("pool 'key' behaves exactly as today: one entry, its own key", () => {
    const scope = t.scopes.instance();
    key(scope, 'key_a');
    assistantProvidersRepo.setModelChain(scope, [{ keyId: 'key_a', model: MODEL }], NOW);
    const chain = pool(scope).entries;
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ pool: 'key', tier: 'standard', selectedKeyId: 'key_a' });
  });
  it("pool 'provider' picks the usable key with the most remaining daily requests", () => {
    const scope = t.scopes.instance();
    key(scope, 'key_anchor');
    key(scope, 'key_b');
    assistantProvidersRepo.setModelChain(
      scope,
      [{ keyId: 'key_anchor', model: MODEL, pool: 'provider', rpdLimit: 20 }],
      NOW,
    );
    spend(scope, 'key_anchor', 19);
    spend(scope, 'key_b', 2);
    expect(pool(scope).entries[0]).toMatchObject({ pool: 'provider', selectedKeyId: 'key_b' });
    assistantKeyCooldownsRepo.setCooldown(scope, {
      keyId: 'key_b',
      model: MODEL,
      until: NOW + 3_600_000,
      reason: 'day',
      setAt: NOW,
    });
    expect(pool(scope).entries[0]).toMatchObject({ pool: 'provider', selectedKeyId: 'key_anchor' });
  });
  it('ties break by least-recent use then key id', () => {
    expect(
      selectPoolKey([
        { keyId: 'key_b', remainingDay: 5, lastUsed: 100 },
        { keyId: 'key_a', remainingDay: 5, lastUsed: 100 },
        { keyId: 'key_c', remainingDay: 5, lastUsed: 50 },
      ]),
    ).toMatchObject({ keyId: 'key_c' });
    expect(
      selectPoolKey([
        { keyId: 'key_b', remainingDay: 5, lastUsed: 100 },
        { keyId: 'key_a', remainingDay: 5, lastUsed: 100 },
      ]),
    ).toMatchObject({ keyId: 'key_a' });
    expect(selectPoolKey([])).toBeUndefined();
    const scope = t.scopes.instance();
    key(scope, 'key_a');
    key(scope, 'key_b');
    assistantProvidersRepo.setModelChain(
      scope,
      [{ keyId: 'key_a', model: MODEL, pool: 'provider', rpdLimit: 20 }],
      NOW,
    );
    spend(scope, 'key_a', 1, NOW - 1000);
    spend(scope, 'key_b', 1, NOW - 2000);
    expect(pool(scope).entries[0]?.selectedKeyId).toBe('key_b');
  });
  it('skips disabled, invalid, unreadable, cooling and fully spent keys, including a disabled anchor', () => {
    const scope = t.scopes.instance();
    key(scope, 'key_anchor', { enabled: false });
    key(scope, 'key_invalid');
    key(scope, 'key_bad', { apiKeyEnc: 'unreadable' });
    key(scope, 'key_spent');
    key(scope, 'key_other');
    addKey(scope, { provider: 'openrouter', keyId: 'key_foreign' });
    assistantProvidersRepo.setModelChain(
      scope,
      [{ keyId: 'key_anchor', model: MODEL, pool: 'provider', tier: 'light', rpdLimit: 20 }],
      NOW,
    );
    assistantKeyCooldownsRepo.setCooldown(scope, {
      keyId: 'key_invalid',
      model: MODEL,
      until: Number.MAX_SAFE_INTEGER,
      reason: 'invalid',
      setAt: NOW,
    });
    spend(scope, 'key_spent', 20);
    expect(pool(scope).entries[0]).toMatchObject({
      selectedKeyId: 'key_other',
      tier: 'light',
      skip: undefined,
    });
    assistantKeyCooldownsRepo.setCooldown(scope, {
      keyId: 'key_other',
      model: MODEL,
      until: NOW + 1000,
      reason: 'minute',
      setAt: NOW,
    });
    const result = pool(scope);
    expect(result.entries[0]).toMatchObject({
      pool: 'provider',
      tier: 'light',
      provider: undefined,
      skip: 'disabled',
    });
    expect(result.makeProvider).not.toHaveBeenCalled();
  });
  it('keys sharing a project label share one daily bucket', () => {
    expect(bucketOf({ keyId: 'key_a', project: 'Car Team A' })).toBe('project:Car Team A');
    expect(bucketOf({ keyId: 'key_b', project: 'Car Team A' })).toBe('project:Car Team A');
    expect(bucketOf({ keyId: 'key_c', project: null })).toBe('key:key_c');
    const scope = t.scopes.instance();
    key(scope, 'key_a', { project: 'Car Team A' });
    key(scope, 'key_b', { project: 'Car Team A' });
    key(scope, 'key_c', { project: 'Alex P' });
    assistantProvidersRepo.setModelChain(
      scope,
      [{ keyId: 'key_a', model: MODEL, pool: 'provider', rpdLimit: 20 }],
      NOW,
    );
    spend(scope, 'key_a', 20);
    spend(scope, 'key_c', 2);
    expect(pool(scope).entries[0]?.selectedKeyId).toBe('key_c');
  });
  it('retains learned daily limits after cooldown expiry and resets at Pacific midnight', () => {
    const scope = t.scopes.instance();
    key(scope, 'key_a');
    assistantProvidersRepo.setModelChain(
      scope,
      [{ keyId: 'key_a', model: MODEL, pool: 'provider' }],
      NOW,
    );
    assistantKeyCooldownsRepo.setCooldown(scope, {
      keyId: 'key_a',
      model: MODEL,
      until: NOW - 1,
      reason: 'day',
      setAt: NOW - 2000,
      learnedPerDay: 2,
    });
    spend(scope, 'key_a', 2);
    expect(pool(scope).entries[0]?.skip).toBe('disabled');
    vi.spyOn(Date, 'now').mockReturnValue(nextProviderDayStart('gemini', NOW));
    expect(pool(scope).entries[0]).toMatchObject({ selectedKeyId: 'key_a', skip: undefined });
  });
  it('a row rpdLimit wins over a learned daily limit', () => {
    const scope = t.scopes.instance();
    key(scope, 'key_a');
    assistantProvidersRepo.setModelChain(
      scope,
      [{ keyId: 'key_a', model: MODEL, pool: 'provider', rpdLimit: 5 }],
      NOW,
    );
    assistantKeyCooldownsRepo.setCooldown(scope, {
      keyId: 'key_a',
      model: MODEL,
      until: NOW - 1,
      reason: 'day',
      setAt: NOW - 2000,
      learnedPerDay: 2,
    });
    spend(scope, 'key_a', 3);
    expect(pool(scope).entries[0]).toMatchObject({ selectedKeyId: 'key_a', skip: undefined });
  });
  it('truncates the env chain defensively to six entries', () => {
    const result = resolve(t.scopes.instance(), {
      config: {
        ...base,
        AI_PROVIDER: 'gemini',
        AI_MODEL: 'one',
        GEMINI_API_KEY: 'AIza-test-one',
        AI_FALLBACK_MODELS: ['two', 'three', 'four', 'five', 'six', 'seven'],
      },
      eligibility: () => eligible(),
    });
    expect(result.entries).toHaveLength(6);
  });
});
