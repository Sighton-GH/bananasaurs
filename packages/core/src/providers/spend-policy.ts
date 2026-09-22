import { ProviderError } from './errors.js';

export type ProviderCostClass = 'free' | 'paid' | 'unknown';

export interface SpendPolicy {
  readonly monthlyCapUsdMicros: number;
}

/** A zero cap permits only profiles explicitly verified as free. */
export function assertSpendAllowed(policy: SpendPolicy, costClass: ProviderCostClass): void {
  if (policy.monthlyCapUsdMicros < 0 || !Number.isSafeInteger(policy.monthlyCapUsdMicros)) {
    throw new Error('monthly cap must be a non-negative integer number of USD micros');
  }
  if (policy.monthlyCapUsdMicros === 0 && costClass !== 'free') {
    throw new ProviderError(
      'quota',
      `provider profile cost is ${costClass}; the monthly spend cap is $0`,
      false,
    );
  }
}
