import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope, InstanceScope } from '../scope.js';
import { providerEligibility } from '../schema.js';
import { writeInstance } from '../write.js';
import {
  ELIGIBILITY_REVIEW_MAX_AGE_MS,
  findEligibility,
  isEligible,
  listEligibility,
  listStaleEligibility,
  recordEligibilityClaim,
  recordEligibilityReview,
  type EligibilityRow,
} from './provider-eligibility.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// 2026-09-14T00:00:00Z: the date the owner confirmed training is disabled on
// the account holding the connectors (docs/STATE.md, "Owner decisions —
// 2026-09-14", item 1). The migration seeds exactly this value.
const CONFIRMED_AT = 1_789_344_000_000;
const EVIDENCE_URL = 'https://claude.ai/settings/data-privacy-controls';

let t: MigratedTestDatabase;
let instance: InstanceScope;
let guildScope: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  instance = t.scopes.instance();
  guildScope = t.scopes.forGuild(parseGuildId('111111111111111111'));
});
afterEach(() => {
  t.close();
});

const row = (trainsOnInput: EligibilityRow['trainsOnInput']): EligibilityRow => ({
  provider: 'probe',
  trainsOnInput,
  evidenceUrl: EVIDENCE_URL,
  productionUseAllowed: true,
  reviewedAt: CONFIRMED_AT,
});

describe('isEligible treats unknown as yes (hard rule 5, ADR 0010 §1)', () => {
  it("accepts 'no'", () => {
    expect(isEligible(row('no'))).toBe(true);
  });

  it("refuses 'yes'", () => {
    expect(isEligible(row('yes'))).toBe(false);
  });

  it("refuses 'unknown'", () => {
    expect(isEligible(row('unknown'))).toBe(false);
  });
});

describe('findEligibility / listEligibility (instance-level, ADR 0027)', () => {
  it('round-trips a row', () => {
    writeInstance(instance, ({ db }) => {
      db.insert(providerEligibility)
        .values({
          provider: 'probe-round-trip',
          trainsOnInput: 'no',
          evidenceUrl: EVIDENCE_URL,
          productionUseAllowed: 1,
          reviewedAt: CONFIRMED_AT,
        })
        .run();
    });
    expect(findEligibility(instance, 'probe-round-trip')).toEqual({
      provider: 'probe-round-trip',
      trainsOnInput: 'no',
      evidenceUrl: EVIDENCE_URL,
      productionUseAllowed: true,
      reviewedAt: CONFIRMED_AT,
    });
    expect(listEligibility(instance).map((r) => r.provider)).toContain('probe-round-trip');
  });

  it('returns undefined for an unknown provider', () => {
    expect(findEligibility(instance, 'no-such-provider')).toBeUndefined();
  });

  it('cannot be called with a GuildScope', () => {
    // @ts-expect-error — instance-level table takes InstanceScope, not GuildScope (ADR 0027)
    const viaGuild: unknown = findEligibility(guildScope, 'anthropic-consumer-mcp');
    expect(viaGuild).toBeDefined();
  });
});

describe('the migration-seeded row (ruling M4-D16)', () => {
  it('exists after migration with exactly the confirmed values', () => {
    expect(findEligibility(instance, 'anthropic-consumer-mcp')).toEqual({
      provider: 'anthropic-consumer-mcp',
      trainsOnInput: 'no',
      evidenceUrl: EVIDENCE_URL,
      productionUseAllowed: true,
      reviewedAt: CONFIRMED_AT,
    });
  });
});

describe('recordEligibilityReview (ruling M4-D20)', () => {
  it('moves reviewed_at and leaves every other column untouched', () => {
    const before = findEligibility(instance, 'anthropic-consumer-mcp');
    expect(before).toBeDefined();
    const now = CONFIRMED_AT + 10 * DAY_MS;
    expect(recordEligibilityReview(instance, { provider: 'anthropic-consumer-mcp', now })).toBe(
      true,
    );
    const after = findEligibility(instance, 'anthropic-consumer-mcp');
    expect(after).toBeDefined();
    expect(after?.reviewedAt).toBe(now);
    expect(after?.trainsOnInput).toBe(before?.trainsOnInput);
    expect(after?.evidenceUrl).toBe(before?.evidenceUrl);
    expect(after?.productionUseAllowed).toBe(before?.productionUseAllowed);
    expect(after?.provider).toBe(before?.provider);
  });

  it('returns false and writes nothing for an unknown provider', () => {
    const now = CONFIRMED_AT + 10 * DAY_MS;
    expect(recordEligibilityReview(instance, { provider: 'no-such-provider', now })).toBe(false);
    expect(findEligibility(instance, 'no-such-provider')).toBeUndefined();
    expect(findEligibility(instance, 'anthropic-consumer-mcp')?.reviewedAt).toBe(CONFIRMED_AT);
  });

  it('a row reviewed now is no longer stale at the same clock', () => {
    const now = CONFIRMED_AT + 100 * DAY_MS;
    expect(
      listStaleEligibility(instance, now, ELIGIBILITY_REVIEW_MAX_AGE_MS).map((r) => r.provider),
    ).toContain('anthropic-consumer-mcp');
    expect(recordEligibilityReview(instance, { provider: 'anthropic-consumer-mcp', now })).toBe(
      true,
    );
    expect(
      listStaleEligibility(instance, now, ELIGIBILITY_REVIEW_MAX_AGE_MS).map((r) => r.provider),
    ).not.toContain('anthropic-consumer-mcp');
  });
});

describe('recordEligibilityClaim (ADR 0061 §1)', () => {
  it('inserts a new row with the clause and the review date', () => {
    const now = CONFIRMED_AT + 5 * DAY_MS;
    recordEligibilityClaim(instance, {
      provider: 'gemini',
      trainsOnInput: 'no',
      evidenceUrl: 'https://example.com/terms',
      evidenceClause: 'We do not train on your data.',
      productionUseAllowed: true,
      now,
    });
    expect(findEligibility(instance, 'gemini')).toEqual({
      provider: 'gemini',
      trainsOnInput: 'no',
      evidenceUrl: 'https://example.com/terms',
      evidenceClause: 'We do not train on your data.',
      productionUseAllowed: true,
      reviewedAt: now,
    });
  });

  it('replaces an existing row wholesale, including clause and review date', () => {
    recordEligibilityClaim(instance, {
      provider: 'gemini',
      trainsOnInput: 'yes',
      evidenceUrl: 'https://example.com/old',
      evidenceClause: 'Old clause text here.',
      productionUseAllowed: false,
      now: CONFIRMED_AT,
    });
    const now = CONFIRMED_AT + 7 * DAY_MS;
    recordEligibilityClaim(instance, {
      provider: 'gemini',
      trainsOnInput: 'no',
      evidenceUrl: 'https://example.com/new',
      evidenceClause: 'New clause text here.',
      productionUseAllowed: true,
      now,
    });
    expect(findEligibility(instance, 'gemini')).toEqual({
      provider: 'gemini',
      trainsOnInput: 'no',
      evidenceUrl: 'https://example.com/new',
      evidenceClause: 'New clause text here.',
      productionUseAllowed: true,
      reviewedAt: now,
    });
  });

  it('reads a row without a clause back with evidenceClause undefined', () => {
    expect(findEligibility(instance, 'anthropic-consumer-mcp')?.evidenceClause).toBeUndefined();
  });
});

describe('listStaleEligibility, for doctor (Task 7b)', () => {
  it('is 90 days (ruling M4-D15), not the six months of ADR 0010 §1', () => {
    expect(ELIGIBILITY_REVIEW_MAX_AGE_MS).toBe(90 * DAY_MS);
  });

  it('returns a row reviewed 91 days ago and not one reviewed 89 days ago', () => {
    const now = CONFIRMED_AT + 100 * DAY_MS;
    for (const [provider, ageDays] of [
      ['probe-stale', 91],
      ['probe-fresh', 89],
    ] as const) {
      writeInstance(instance, ({ db }) => {
        db.insert(providerEligibility)
          .values({
            provider,
            trainsOnInput: 'no',
            evidenceUrl: EVIDENCE_URL,
            productionUseAllowed: 1,
            reviewedAt: now - ageDays * DAY_MS,
          })
          .run();
      });
    }
    const stale = listStaleEligibility(instance, now, ELIGIBILITY_REVIEW_MAX_AGE_MS).map(
      (r) => r.provider,
    );
    expect(stale).toContain('probe-stale');
    expect(stale).not.toContain('probe-fresh');
  });
});
