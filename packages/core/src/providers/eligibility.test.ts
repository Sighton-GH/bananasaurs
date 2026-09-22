import { describe, expect, it } from 'vitest';
import { assertProviderEligible } from './eligibility.js';

const eligible = {
  trainsOnInput: 'no' as const,
  productionUseAllowed: true,
  evidenceUrl: 'https://example.invalid/terms',
  reviewedAt: '2026-09-20',
};

describe('assertProviderEligible', () => {
  it('allows a reviewed no-training provider in production', () => {
    expect(() => assertProviderEligible(eligible, 'club')).not.toThrow();
  });

  it.each(['yes', 'unknown'] as const)('fails closed for trainsOnInput=%s', (value) => {
    expect(() => assertProviderEligible({ ...eligible, trainsOnInput: value }, 'test')).toThrow(
      /no-training status is not verified/,
    );
  });

  it('allows a development-only provider only in the test audience', () => {
    const developmentOnly = { ...eligible, productionUseAllowed: false };
    expect(() => assertProviderEligible(developmentOnly, 'test')).not.toThrow();
    expect(() => assertProviderEligible(developmentOnly, 'club')).toThrow(/production use/);
  });
});
