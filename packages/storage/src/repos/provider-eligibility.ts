import { asc, eq } from 'drizzle-orm';
import type { InstanceScope } from '../scope.js';
import { readInstance, writeInstance } from '../write.js';
import { providerEligibility } from '../schema.js';

/**
 * Training-eligibility records (ADR 0044 §7, ADR 0010 §1).
 *
 * Instance-level throughout (ADR 0027): a provider is a fact about the
 * daemon, not a guild. The `InstanceScope` first parameter is what says so —
 * these functions cannot accept a `GuildScope`.
 *
 * The row's *claims* — `trains_on_input`, `evidence_url`,
 * `production_use_allowed` — are seeded by the migration (ruling M4-D16),
 * and changing one is still a new migration, not an edit, so the deployed
 * schema and `PRIVACY.md` move together. The *review date* is different: a
 * promise whose only remedy is editing SQL is the wrong shape to leave in a
 * privacy policy, so `bananasaurs provider review` writes `reviewed_at` via
 * `recordEligibilityReview` below (ruling M4-D20) — and nothing else.
 *
 * Dashboard rows the instance owner writes (ADR 0061) are as authoritative
 * as migration-seeded rows: the same principal who can enable the provider
 * and enter its key records what the provider's terms say, and
 * `recordEligibilityClaim` below writes the whole row.
 */

export interface EligibilityRow {
  readonly provider: string;
  readonly trainsOnInput: 'no' | 'yes' | 'unknown';
  readonly evidenceUrl: string;
  /** Present on rows the dashboard wrote (ADR 0061); migration-seeded rows cite theirs in the migration. */
  readonly evidenceClause?: string;
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
  evidenceClause: string | null;
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
    ...(r.evidenceClause === null ? {} : { evidenceClause: r.evidenceClause }),
    productionUseAllowed: r.productionUseAllowed === 1,
    reviewedAt: r.reviewedAt,
  };
};

const SELECT = {
  provider: providerEligibility.provider,
  trainsOnInput: providerEligibility.trainsOnInput,
  evidenceUrl: providerEligibility.evidenceUrl,
  evidenceClause: providerEligibility.evidenceClause,
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

/**
 * Records that a human re-checked this provider's row and found it still
 * accurate: writes `reviewed_at` and nothing else (ruling M4-D20). The row's
 * claims — `trains_on_input`, `evidence_url`, `production_use_allowed` — are
 * statements about the outside world and are still changed by a migration,
 * so the deployed schema and `PRIVACY.md` move together.
 *
 * Returns `false` when there is no such provider.
 */
export const recordEligibilityReview = (
  scope: InstanceScope,
  input: { provider: string; now: number },
): boolean =>
  writeInstance(scope, ({ db }) => {
    const result = db
      .update(providerEligibility)
      .set({ reviewedAt: input.now })
      .where(eq(providerEligibility.provider, input.provider))
      .run();
    return result.changes === 1;
  });

/**
 * Owner-recorded claim (ADR 0061 §1): inserts or replaces the whole row,
 * reviewedAt = now.
 */
export const recordEligibilityClaim = (
  scope: InstanceScope,
  input: {
    provider: string;
    trainsOnInput: 'no' | 'yes' | 'unknown';
    evidenceUrl: string;
    evidenceClause: string;
    productionUseAllowed: boolean;
    now: number;
  },
): void =>
  writeInstance(scope, ({ db }) => {
    db.insert(providerEligibility)
      .values({
        provider: input.provider,
        trainsOnInput: input.trainsOnInput,
        evidenceUrl: input.evidenceUrl,
        evidenceClause: input.evidenceClause,
        productionUseAllowed: input.productionUseAllowed ? 1 : 0,
        reviewedAt: input.now,
      })
      .onConflictDoUpdate({
        target: providerEligibility.provider,
        set: {
          trainsOnInput: input.trainsOnInput,
          evidenceUrl: input.evidenceUrl,
          evidenceClause: input.evidenceClause,
          productionUseAllowed: input.productionUseAllowed ? 1 : 0,
          reviewedAt: input.now,
        },
      })
      .run();
  });

/** Rows whose `reviewedAt` is older than `maxAgeMs` before `now`, for `doctor` (Task 7b). */
export const listStaleEligibility = (
  scope: InstanceScope,
  now: number,
  maxAgeMs: number,
): readonly EligibilityRow[] => listEligibility(scope).filter((r) => now - r.reviewedAt > maxAgeMs);
