import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGeminiQuotaError } from './gemini-quota.js';

const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/gemini-429-quota.json', import.meta.url), 'utf8'),
) as unknown;

const violation = (quotaId: string, quotaValue: string) => ({
  quotaMetric: 'generativelanguage.googleapis.com/generate_requests',
  quotaId,
  quotaDimensions: { model: 'gemini-3.8-flash' },
  quotaValue,
});

const bodyWith = (details: unknown[]) => ({
  error: {
    code: 429,
    message: 'Resource has been exhausted.',
    status: 'RESOURCE_EXHAUSTED',
    details,
  },
});

describe('parseGeminiQuotaError (ADR 0143)', () => {
  it('parses the documented fixture: daily wins, minute and retry delay kept', () => {
    expect(parseGeminiQuotaError(fixture)).toEqual({
      scope: 'day',
      retryAfterMs: 37_000,
      learnedLimit: { perDay: 20, perMinute: 5 },
    });
  });
  it('maps a minute-only violation to minute scope with its learned limit', () => {
    const body = bodyWith([
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [violation('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '5')],
      },
    ]);
    expect(parseGeminiQuotaError(body)).toEqual({
      scope: 'minute',
      learnedLimit: { perMinute: 5 },
    });
  });
  it('maps a token-per-minute violation to minute scope', () => {
    const body = bodyWith([
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [violation('GenerateTokensPerMinutePerProjectPerModel-FreeTier', '250000')],
      },
    ]);
    expect(parseGeminiQuotaError(body)?.scope).toBe('minute');
    expect(parseGeminiQuotaError(body)?.learnedLimit).toBeUndefined();
  });
  it('returns undefined scope for missing or malformed details', () => {
    expect(parseGeminiQuotaError({ error: { status: 'RESOURCE_EXHAUSTED' } })).toEqual({
      scope: undefined,
    });
    expect(parseGeminiQuotaError({ nope: true })).toEqual({ scope: undefined });
    expect(parseGeminiQuotaError(null)).toEqual({ scope: undefined });
  });
  it('ignores unsafe quota values and caps retry delays', () => {
    const body = bodyWith([
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [violation('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'lots')],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '999999s' },
    ]);
    const parsed = parseGeminiQuotaError(body);
    expect(parsed?.scope).toBe('day');
    expect(parsed?.learnedLimit).toBeUndefined();
    expect(parsed?.retryAfterMs).toBeLessThanOrEqual(3_600_000);
  });
});
