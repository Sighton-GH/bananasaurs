import { asc, eq } from 'drizzle-orm';
import type { InstanceScope } from '../scope.js';
import { readInstance } from '../write.js';
import { providerEligibility } from '../schema.js';

/**
 * Training-eligibility records (ADR 0044 §7, ADR 0010 §1).
 *
 * Instance-level throughout (ADR 0027): a provider is a fact about the
 * daemon, not a guild. The `InstanceScope` first parameter is what says so —
 * these functions cannot accept a `GuildScope`.
 *
 * There is deliberately no writer: the row is seeded by the migration
 * (ruling M4-D16), and changing it later is a new migration, not an edit.
 */

export interface EligibilityRow {
  readonly provider: string;
  readonly trainsOnInput: 'no' | 'yes' | 'unknown';
  readonly evidenceUrl: string;
  readonly productionUseAllowed: boolean;
  readonly reviewedAt: number;
}

/**
 * How old a review may be before `doctor` warns (Task 7b).
 *
 * 90 days, ruling M4-D15 — not the six months of ADR 0010 §1. The six-month
 * figure was written for a provider's published terms of service, which
 * change with notice; a consumer-plan **setting** can be flipped in a
 * dashboard by anyone with the password and has no changelog, so it is
 * re-verified more often. Do not "align" this back to six months: the cost
 * of being wrong here is one extra `doctor` warning per quarter.
 */
export const ELIGIBILITY_REVIEW_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const toRow = (r: {
  provider: string;
  trainsOnInput: string;
  evidenceUrl: string;
  productionUseAllowed: number;
  reviewedAt: number;
}): EligibilityRow => {
  if (r.trainsOnInput !== 'no' && r.trainsOnInput !== 'yes' && r.trainsOnInput !== 'unknown') {
    throw new Error(
      `provider_eligibility ${r.provider}: trains_on_input is ${JSON.stringify(r.trainsOnInput)}, ` +
        `expected 'no', 'yes' or 'unknown'.`,
    );
  }
  return {
    provider: r.provider,
    trainsOnInput: r.trainsOnInput,
    evidenceUrl: r.evidenceUrl,
    productionUseAllowed: r.productionUseAllowed === 1,
    reviewedAt: r.reviewedAt,
  };
};

const SELECT = {
  provider: providerEligibility.provider,
  trainsOnInput: providerEligibility.trainsOnInput,
  evidenceUrl: providerEligibility.evidenceUrl,
  productionUseAllowed: providerEligibility.productionUseAllowed,
  reviewedAt: providerEligibility.reviewedAt,
};

export const findEligibility = (
  scope: InstanceScope,
  provider: string,
): EligibilityRow | undefined => {
  const row = readInstance(scope, (db) =>
    db
      .select(SELECT)
      .from(providerEligibility)
      .where(eq(providerEligibility.provider, provider))
      .get(),
  );
  return row === undefined ? undefined : toRow(row);
};

export const listEligibility = (scope: InstanceScope): readonly EligibilityRow[] =>
  readInstance(scope, (db) =>
    db
      .select(SELECT)
      .from(providerEligibility)
      .orderBy(asc(providerEligibility.provider))
      .all()
      .map(toRow),
  );

/** `'no'` only — `'unknown'` is treated as `'yes'` (hard rule 5, ADR 0010 §1). */
export const isEligible = (row: EligibilityRow): boolean => row.trainsOnInput === 'no';

/** Rows whose `reviewedAt` is older than `maxAgeMs` before `now`, for `doctor` (Task 7b). */
export const listStaleEligibility = (
  scope: InstanceScope,
  now: number,
  maxAgeMs: number,
): readonly EligibilityRow[] => listEligibility(scope).filter((r) => now - r.reviewedAt > maxAgeMs);
