import { describe, expect, it } from 'vitest';
import {
  modelHealth,
  PERSISTENT_CODES,
  PERSISTENT_RUN,
  type ModelResult,
} from './model-health.js';

/** ADR 0129 §8: per-model health from the run ledger's model-result steps. */
const result = (over: Partial<ModelResult> & { readonly at: number }): ModelResult => ({
  model: 'model-a',
  keyId: 'key-1',
  ok: true,
  ms: 100,
  ...over,
});

describe('modelHealth', () => {
  it('computes successRate, p50Ms and p95Ms over known inputs', () => {
    const results = [100, 200, 300, 400, 1000].map((ms, i) =>
      result({ at: 1_000 + i, ms, ok: i % 2 === 0 }),
    );
    const [health] = modelHealth(results);
    // 3 ok of 5.
    expect(health?.successRate).toBeCloseTo(0.6);
    expect(health?.p50Ms).toBe(300);
    expect(health?.p95Ms).toBe(1000);
    expect(health?.calls).toBe(5);
    expect(health?.ok).toBe(3);
  });

  it('reports null successRate and percentiles with no calls in a group', () => {
    expect(modelHealth([])).toEqual([]);
    const [health] = modelHealth([result({ at: 1_000, ok: false, code: 'provider-timeout' })]);
    expect(health?.successRate).toBe(0);
    expect(health?.p50Ms).toBe(100);
  });

  it('raises persistent after three trailing failures with one persistent code', () => {
    const results = [1, 2, 3].map((i) =>
      result({ at: 1_000 + i, ok: false, ms: 50, code: 'provider-bad-model' }),
    );
    const [health] = modelHealth(results);
    expect(health?.persistent).toEqual({ code: 'provider-bad-model', count: 3, since: 1_001 });
    expect(health?.failuresByCode).toEqual({ 'provider-bad-model': 3 });
    expect(health?.lastError).toMatchObject({ at: 1_003, code: 'provider-bad-model' });
  });

  it('raises no persistent when an ok breaks the trailing run', () => {
    const results = [
      result({ at: 1_001, ok: false, code: 'provider-bad-model' }),
      result({ at: 1_002, ok: false, code: 'provider-bad-model' }),
      result({ at: 1_003, ok: true }),
    ];
    const [health] = modelHealth(results);
    expect(health?.persistent).toBeUndefined();
  });

  it('raises no persistent for three trailing transient failures', () => {
    const results = [1, 2, 3].map((i) =>
      result({ at: 1_000 + i, ok: false, code: 'provider-connect-timeout' }),
    );
    const [health] = modelHealth(results);
    expect(health?.persistent).toBeUndefined();
    expect(health?.failuresByCode).toEqual({ 'provider-connect-timeout': 3 });
  });

  it('counts only the trailing run of the newest code', () => {
    const results = [
      result({ at: 1_001, ok: false, code: 'provider-bad-model' }),
      result({ at: 1_002, ok: false, code: 'provider-auth' }),
      result({ at: 1_003, ok: false, code: 'provider-auth' }),
      result({ at: 1_004, ok: false, code: 'provider-auth' }),
    ];
    const [health] = modelHealth(results);
    expect(health?.persistent).toEqual({ code: 'provider-auth', count: 3, since: 1_002 });
  });

  it('groups by keyId then model, summing tokens and cost', () => {
    const results = [
      result({ at: 1_001, model: 'same-model', keyId: 'key-b', tokens: 10, costUsd: 0.001 }),
      result({
        at: 1_002,
        model: 'same-model',
        keyId: 'key-a',
        tokens: 20,
        costUsd: 0.002,
        ok: false,
        code: 'provider-auth',
      }),
      result({ at: 1_003, model: 'same-model', keyId: 'key-b', tokens: 30 }),
    ];
    const health = modelHealth(results);
    expect(health.map((h) => h.keyId)).toEqual(['key-a', 'key-b']);
    expect(health[1]).toMatchObject({ calls: 2, tokens: 40, costUsd: 0.001 });
    expect(PERSISTENT_CODES).toContain('provider-auth');
    expect(PERSISTENT_RUN).toBe(3);
  });
});
