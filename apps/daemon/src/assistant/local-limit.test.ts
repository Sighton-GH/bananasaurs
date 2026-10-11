import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextProviderDayStart, providerDayStart } from '@bananasaurs/core';
import { modelCallsRepo, type InstanceScope } from '@bananasaurs/storage';
import { assistantProvidersRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { ENV_KEY_ID } from './model-chain.js';
import { entryUsage, localLimitReply, LocalLimitError, reserveEntryCall } from './local-limit.js';

const NOW = 1_800_000_000_000;
const GUILD_ID = '123456789012345678';
const MODEL = 'gemini-2.5-flash';

describe('localLimitReply', () => {
  it('30 s away reads as about 1 minute', () => {
    expect(localLimitReply(NOW + 30_000, NOW, 'UTC')).toBe(
      'All AI models have reached the limits set for them. The next one frees up in about 1 minute.',
    );
  });

  it('14 min 10 s away reads as about 15 minutes', () => {
    expect(localLimitReply(NOW + (14 * 60 + 10) * 1000, NOW, 'UTC')).toBe(
      'All AI models have reached the limits set for them. The next one frees up in about 15 minutes.',
    );
  });

  it('5 h away names a clock time in the given zone', () => {
    const text = localLimitReply(NOW + 5 * 3_600_000, NOW, 'America/Vancouver');
    expect(text).toContain('frees up at ');
    const time = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Vancouver',
      hour: 'numeric',
      minute: '2-digit',
    }).format(NOW + 5 * 3_600_000);
    expect(text).toBe(
      `All AI models have reached the limits set for them. The next one frees up at ${time}.`,
    );
  });
});

describe('reserveEntryCall and entryUsage', () => {
  let t: MigratedTestDatabase;
  let instance: InstanceScope;
  let keyId: string;

  beforeEach(() => {
    t = openMigratedTestDatabase();
    instance = t.scopes.instance();
    keyId = assistantProvidersRepo.addKey(instance, {
      provider: 'gemini',
      label: 'Key',
      apiKeyEnc: 'sealed',
      now: NOW,
    });
  });

  afterEach(() => t.close());

  it('a pool entry reserves and reports against its selected key, not the anchor (ADR 0143)', () => {
    const other = assistantProvidersRepo.addKey(instance, {
      provider: 'gemini',
      label: 'Other',
      apiKeyEnc: 'sealed2',
      now: NOW,
    });
    const entry = {
      keyId,
      selectedKeyId: other,
      model: MODEL,
      providerId: 'gemini' as const,
      rpmLimit: null,
      rpdLimit: 1,
    };
    expect(reserveEntryCall(instance, entry, GUILD_ID, NOW)).toEqual({ ok: true });
    expect(reserveEntryCall(instance, entry, GUILD_ID, NOW + 1000)).toMatchObject({ ok: false });
    const day = { now: NOW + 1000, dayStart: providerDayStart('gemini', NOW) };
    expect(modelCallsRepo.modelUsage(instance, { keyId: other, model: MODEL, ...day }).today).toBe(
      1,
    );
    expect(modelCallsRepo.modelUsage(instance, { keyId, model: MODEL, ...day }).today).toBe(0);
  });

  it('the .env seed is never limited and never recorded', () => {
    const envEntry = {
      keyId: ENV_KEY_ID,
      model: MODEL,
      providerId: 'gemini' as const,
      rpmLimit: 1,
      rpdLimit: 1,
    };
    expect(reserveEntryCall(instance, envEntry, GUILD_ID, NOW)).toEqual({ ok: true });
    expect(reserveEntryCall(instance, envEntry, GUILD_ID, NOW + 1000)).toEqual({ ok: true });
    expect(entryUsage(instance, envEntry, NOW + 1000)).toBeUndefined();
    const usage = modelCallsRepo.modelUsage(instance, {
      keyId: ENV_KEY_ID,
      model: MODEL,
      now: NOW + 1000,
      dayStart: providerDayStart('gemini', NOW + 1000),
    });
    expect(usage.lastMinute).toBe(0);
    expect(usage.today).toBe(0);
  });

  it('a stored entry at its RPM limit refuses the third call', () => {
    const entry = {
      keyId,
      model: MODEL,
      providerId: 'gemini' as const,
      rpmLimit: 2,
      rpdLimit: null,
    };
    expect(reserveEntryCall(instance, entry, GUILD_ID, NOW)).toEqual({ ok: true });
    expect(reserveEntryCall(instance, entry, GUILD_ID, NOW + 1000)).toEqual({ ok: true });
    expect(reserveEntryCall(instance, entry, GUILD_ID, NOW + 2000)).toEqual({
      ok: false,
      code: 'local-rpm-limit',
      availableAt: NOW + 60_000,
    });
  });

  it('two keys sharing a project bucket share rpd 2 across keys', () => {
    const first = assistantProvidersRepo.addKey(instance, {
      provider: 'gemini',
      label: 'First',
      apiKeyEnc: 'sealed-first',
      now: NOW,
      project: 'site',
    });
    const second = assistantProvidersRepo.addKey(instance, {
      provider: 'gemini',
      label: 'Second',
      apiKeyEnc: 'sealed-second',
      now: NOW,
      project: 'site',
    });
    const firstEntry = {
      keyId: first,
      model: MODEL,
      providerId: 'gemini' as const,
      rpmLimit: null,
      rpdLimit: 2,
    };
    const secondEntry = { ...firstEntry, keyId: second };
    expect(reserveEntryCall(instance, firstEntry, GUILD_ID, NOW)).toEqual({ ok: true });
    expect(reserveEntryCall(instance, secondEntry, GUILD_ID, NOW + 1000)).toEqual({ ok: true });
    expect(reserveEntryCall(instance, firstEntry, GUILD_ID, NOW + 2000)).toMatchObject({
      ok: false,
      code: 'local-rpd-limit',
    });
  });

  it('entryUsage reports the RPM window and omits availableAt without limits', () => {
    const limited = {
      keyId,
      model: MODEL,
      providerId: 'gemini' as const,
      rpmLimit: 2,
      rpdLimit: null,
    };
    expect(reserveEntryCall(instance, limited, GUILD_ID, NOW)).toEqual({ ok: true });
    expect(reserveEntryCall(instance, limited, GUILD_ID, NOW + 1000)).toEqual({ ok: true });
    expect(entryUsage(instance, limited, NOW + 2000)).toEqual({
      lastMinute: 2,
      today: 2,
      availableAt: NOW + 60_000,
    });
    const unlimited = {
      keyId,
      model: 'other-model',
      providerId: 'gemini' as const,
      rpmLimit: null,
      rpdLimit: null,
    };
    expect(reserveEntryCall(instance, unlimited, GUILD_ID, NOW)).toEqual({ ok: true });
    expect(reserveEntryCall(instance, unlimited, GUILD_ID, NOW + 1000)).toEqual({ ok: true });
    const usage = entryUsage(instance, unlimited, NOW + 2000);
    expect(usage?.lastMinute).toBe(2);
    expect(usage?.today).toBe(2);
    expect(usage !== undefined && 'availableAt' in usage).toBe(false);
  });

  it('entryUsage reports the next provider day start at the RPD limit', () => {
    const entry = {
      keyId,
      model: MODEL,
      providerId: 'gemini' as const,
      rpmLimit: null,
      rpdLimit: 2,
    };
    expect(reserveEntryCall(instance, entry, GUILD_ID, NOW)).toEqual({ ok: true });
    expect(reserveEntryCall(instance, entry, GUILD_ID, NOW + 1000)).toEqual({ ok: true });
    const usage = entryUsage(instance, entry, NOW + 2000);
    expect(usage?.lastMinute).toBe(2);
    expect(usage?.today).toBe(2);
    expect(usage?.availableAt).toBe(nextProviderDayStart('gemini', NOW + 2000));
  });

  it('entryUsage with both limits frees up at the later of the RPM window and the next day start', () => {
    const entry = {
      keyId,
      model: MODEL,
      providerId: 'gemini' as const,
      rpmLimit: 2,
      rpdLimit: 2,
    };
    expect(reserveEntryCall(instance, entry, GUILD_ID, NOW)).toEqual({ ok: true });
    expect(reserveEntryCall(instance, entry, GUILD_ID, NOW + 1000)).toEqual({ ok: true });
    const at = NOW + 2000;
    const usage = entryUsage(instance, entry, at);
    const rpmCandidate = NOW + 60_000;
    const rpdCandidate = nextProviderDayStart('gemini', at);
    // NOW is just after the provider-local midnight, so the next day start is
    // almost a full day away and wins over the one-minute RPM window.
    expect(rpdCandidate).toBeGreaterThan(rpmCandidate);
    expect(usage?.lastMinute).toBe(2);
    expect(usage?.today).toBe(2);
    expect(usage?.availableAt).toBe(Math.max(rpmCandidate, rpdCandidate));
    expect(usage?.availableAt).toBe(rpdCandidate);
  });
});

describe('LocalLimitError attempts and detail', () => {
  it('carries the failed attempts and the loop detail', () => {
    const attempts = [{ provider: 'gemini', model: MODEL, outcome: 'skipped' as const, ms: 1 }];
    const err = new LocalLimitError(5000, 'local-rpm-limit', {
      attempts,
      detail: {
        sections: [],
        history: [],
        attempts,
        toolCalls: [],
        usage: {},
        guard: { removed: [] },
      },
    });
    expect(err.attempts).toEqual(attempts);
    expect(err.detail?.toolCalls).toEqual([]);
  });

  it('leaves attempts and detail absent when no options are given', () => {
    const err = new LocalLimitError(5000, 'local-rpd-limit');
    expect(err.attempts).toBeUndefined();
    expect(err.detail).toBeUndefined();
  });
});
