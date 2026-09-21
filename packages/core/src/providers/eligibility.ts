import type { ProviderEligibility } from './contracts.js';
import { ProviderError } from './errors.js';

export type ProviderAudience = 'test' | 'club';

/** Fail closed before server or member content crosses a provider boundary. */
export function assertProviderEligible(
  eligibility: ProviderEligibility,
  audience: ProviderAudience,
): void {
  if (eligibility.trainsOnInput !== 'no') {
    throw new ProviderError(
      'capability-mismatch',
      'provider is not eligible for server content because no-training status is not verified',
      false,
    );
  }
  if (audience === 'club' && !eligibility.productionUseAllowed) {
    throw new ProviderError(
      'capability-mismatch',
      'provider is not eligible for production use',
      false,
    );
  }
}
