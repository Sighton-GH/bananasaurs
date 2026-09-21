import { describe, expect, it } from 'vitest';
import { assertSpendAllowed } from './spend-policy.js';

describe('assertSpendAllowed', () => {
  it('permits an explicitly free profile at a zero cap', () => {
    expect(() => assertSpendAllowed({ monthlyCapUsdMicros: 0 }, 'free')).not.toThrow();
  });
  it.each(['paid', 'unknown'] as const)('refuses %s cost at a zero cap', (costClass) => {
    expect(() => assertSpendAllowed({ monthlyCapUsdMicros: 0 }, costClass)).toThrow(
      /monthly spend cap is \$0/,
    );
  });
  it('refuses invalid caps', () => {
    expect(() => assertSpendAllowed({ monthlyCapUsdMicros: -1 }, 'free')).toThrow(/non-negative/);
  });
});
