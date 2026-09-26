import { describe, expect, it } from 'vitest';
import { ChainFailedError, summarizeAttempts } from './chain-failed-error.js';

describe('summarizeAttempts', () => {
  it('joins each failed attempt as provider/model: code', () => {
    expect(
      summarizeAttempts([
        {
          provider: 'openrouter',
          model: 'm-a',
          outcome: 'busy',
          reason: 'outage',
          code: 'provider-connect-timeout',
          ms: 5,
        },
        {
          provider: 'gemini',
          model: 'm-b',
          outcome: 'rate-limit',
          reason: 'rate-limit',
          code: 'provider-rate-limit',
          ms: 7,
        },
      ]),
    ).toBe('openrouter/m-a: provider-connect-timeout; gemini/m-b: provider-rate-limit');
  });

  it('skips ok attempts and falls back to reason then outcome', () => {
    expect(
      summarizeAttempts([
        { provider: 'gemini', model: 'm', outcome: 'ok', ms: 1 },
        { provider: 'gemini', model: 'n', outcome: 'error', reason: 'empty-answer', ms: 2 },
        { provider: 'gemini', model: 'o', outcome: 'skipped', ms: 3 },
      ]),
    ).toBe('gemini/n: empty-answer; gemini/o: skipped');
  });
});

describe('ChainFailedError', () => {
  it('carries its attempts with a stable code', () => {
    const attempts = [
      {
        provider: 'openrouter',
        model: 'm',
        outcome: 'busy' as const,
        reason: 'outage',
        code: 'provider-connect-timeout',
        ms: 5,
      },
    ];
    const err = new ChainFailedError('outage', 'Every assistant model failed — x', true, attempts);
    expect(err.code).toBe('chain-failed');
    expect(err.summary).toContain('Every assistant model failed');
    expect(err.attempts).toEqual(attempts);
    expect(err).toBeInstanceOf(Error);
  });
});
