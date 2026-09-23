import { describe, expect, it } from 'vitest';
import { assertProviderEligible, providerMayTrain } from './eligibility.js';

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

  it.each(['yes', 'unknown'] as const)(
    'allows trainsOnInput=%s in both audiences; training is a warning (ADR 0062)',
    (value) => {
      const mayTrain = { ...eligible, trainsOnInput: value };
      expect(() => assertProviderEligible(mayTrain, 'test')).not.toThrow();
      expect(() => assertProviderEligible(mayTrain, 'club')).not.toThrow();
    },
  );

  it('still refuses a may-train provider in the club audience without production use', () => {
    expect(() =>
      assertProviderEligible(
        { ...eligible, trainsOnInput: 'yes', productionUseAllowed: false },
        'club',
      ),
    ).toThrow(/production use/);
  });

  it('allows a development-only provider only in the test audience', () => {
    const developmentOnly = { ...eligible, productionUseAllowed: false };
    expect(() => assertProviderEligible(developmentOnly, 'test')).not.toThrow();
    expect(() => assertProviderEligible(developmentOnly, 'club')).toThrow(/production use/);
  });
});

describe('providerMayTrain', () => {
  it.each([
    ['yes', true],
    ['unknown', true],
    ['no', false],
  ] as const)('is %s -> %s', (value, expected) => {
    expect(providerMayTrain({ trainsOnInput: value })).toBe(expected);
  });
});
