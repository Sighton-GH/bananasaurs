import type { ProviderEligibility } from './contracts.js';
import { ProviderError } from './errors.js';

export type ProviderAudience = 'test' | 'club';

/**
 * Fail closed before server or member content crosses a provider boundary
 * when the provider is not approved for this audience. Training on input is
 * not a refusal: the owner allows it and the callers raise warnings instead
 * (ADR 0062, see `providerMayTrain`).
 */
export function assertProviderEligible(
  eligibility: ProviderEligibility,
  audience: ProviderAudience,
): void {
  if (audience === 'club' && !eligibility.productionUseAllowed) {
    throw new ProviderError(
      'capability-mismatch',
      'provider is not eligible for production use',
      false,
    );
  }
}

/** True unless the terms record says `no`: `unknown` counts as may-train (ADR 0062). */
export const providerMayTrain = (
  eligibility: Pick<ProviderEligibility, 'trainsOnInput'>,
): boolean => eligibility.trainsOnInput !== 'no';
