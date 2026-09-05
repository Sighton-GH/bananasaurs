import { beforeEach, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { parseGuildId } from '@bananasaurs/core';
import type { GuildScope } from '../scope.js';
import { upsertGuild } from './guilds.js';
import { createRule, setRuleMode, type CutoverState } from './automod-rules.js';
import { openOrResolveCase, recordCaseEvent } from './mod-cases.js';
import { recordVerdict, type MatchVerdict } from './mod-match-reviews.js';
import { enforcementEligibility, makeRuleEnforceableForTest } from './enforcement-gate.js';

const GUILD = parseGuildId('111111111111111111');
const MEMBER = '800000000000000001';
const REVIEWER = '700000000000000001';
const NOW = 10_000;

let t: MigratedTestDatabase;
let scope: GuildScope;
let nextEvent: number;

// `mod_rules.guild_id` and `mod_cases.guild_id` both carry real foreign keys
// to `guilds` — the guild must exist before either can be written.
beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  upsertGuild(scope, { name: 'guild', now: 0 });
  nextEvent = 0;
});

/**
 * Sets `mod_rules.cutover_state` directly. No repo writer reaches every
 * state — Task 6's `automod ready` only ever writes `ready`, and this
 * task's own `makeRuleEnforceableForTest` writes `ready` plus a sign-off —
 * so a raw write is the only way to plant a rule in `not_started`,
 * `observing`, `cutover` or `rolled_back` for a test. Mirrors
 * `automod-rules.test.ts`'s own `insertRawRule` pattern for probing a
 * column with no writer yet.
 */
const setCutoverState = (ruleId: string, state: CutoverState): void => {
  t.raw
    .prepare(`UPDATE mod_rules SET cutover_state = ? WHERE guild_id = ? AND rule_id = ?`)
    .run(state, GUILD, ruleId);
};

/**
 * Sets `mod_rules.counts_as_violation` directly. Task 2+3 ships the column's
 * read shape (Task 1) and the gate that reads it; the CLI surface that lets
 * an owner narrow a rule to delete-only (Task 4/6) is not part of this
 * dispatch, so a raw write is the only way to test the delete-only tier here.
 */
const setCountsAsViolation = (ruleId: string, counts: boolean): void => {
  t.raw
    .prepare(`UPDATE mod_rules SET counts_as_violation = ? WHERE guild_id = ? AND rule_id = ?`)
    .run(counts ? 1 : 0, GUILD, ruleId);
};

const createTestRule = (ruleId: string): void => {
  createRule(scope, { ruleId, kind: 'caps', name: ruleId, config: '{}', now: NOW });
};

/**
 * Seeds one case event for `ruleId` and a reviewer's verdict on it — the
 * join `enforcementEligibility` reads (PR-28). Mirrors
 * `mod-match-reviews.test.ts`'s `seedMatchEvent`, minus the fixture wiring
 * this gate never reads.
 */
const seedReviewedMatch = (ruleId: string, verdict: MatchVerdict): void => {
  nextEvent += 1;
  const eventId = `${ruleId}-e${String(nextEvent)}`;
  const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: NOW });
  recordCaseEvent(scope, {
    eventId,
    caseId,
    ruleId,
    memberId: MEMBER,
    at: NOW,
    matchedCategory: 'x',
    matchedSnippet: 'x',
    actionTaken: 'would_delete',
  });
  recordVerdict(scope, { eventId, verdict, reviewedBy: REVIEWER, reviewedAt: NOW });
};

const seedReviewedMatches = (ruleId: string, verdicts: readonly MatchVerdict[]): void => {
  for (const verdict of verdicts) seedReviewedMatch(ruleId, verdict);
};

/**
 * ADR 0042 §4 / PR-27, 28, 29, 30 — the release gate. These are the spec's
 * own named tests (Task 2+3, "these are the spec's own words"), plus the
 * check-order and boundary tests Global Constraint 7 requires and the plan
 * review already caught being applied to only one of the two thresholds.
 */
describe('enforcementEligibility', () => {
  it('refuses for every cutover_state that does not permit enforcement, given a clean review history', () => {
    // Every non-permitting state, not just `observing` — and `rolled_back`
    // matters most, because it must not be undoable by retrying the same
    // command without ever revisiting `observing` (PR-27).
    for (const state of ['not_started', 'observing', 'rolled_back'] as const) {
      const ruleId = `clean-${state}`;
      createTestRule(ruleId);
      setCutoverState(ruleId, state);
      seedReviewedMatches(ruleId, Array<MatchVerdict>(25).fill('true_positive'));

      const result = enforcementEligibility(scope, ruleId);
      expect(result.ok, state).toBe(false);
      if (!result.ok) expect(result.refusal.reason).toBe('cutover-state');
    }
  });

  it('refuses for cutover_state even when the false-positive rate is also bad — state is checked first', () => {
    // The order-of-checks contract: an operator watching a terrible rate in
    // `observing` needs to act on the *state* first, because enforcement is
    // not on offer at all yet, whatever the numbers say. A gate that checked
    // the rate before the state would refuse this rule too, but for the
    // wrong reason — which is exactly what Step 5's first mutation exercises.
    const ruleId = 'observing-bad-rate';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'observing');
    seedReviewedMatches(ruleId, [
      'false_positive',
      'false_positive',
      'false_positive',
      ...Array<MatchVerdict>(22).fill('true_positive'),
    ]);

    const result = enforcementEligibility(scope, ruleId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe('cutover-state');
  });

  it('permits enforcement only from ready and cutover, refusing every other state', () => {
    for (const state of ['not_started', 'observing', 'ready', 'cutover', 'rolled_back'] as const) {
      const ruleId = `permits-${state}`;
      createTestRule(ruleId);
      setCutoverState(ruleId, state);
      seedReviewedMatches(ruleId, Array<MatchVerdict>(25).fill('true_positive'));

      const result = enforcementEligibility(scope, ruleId);
      const shouldPermit = state === 'ready' || state === 'cutover';
      expect(result.ok, state).toBe(shouldPermit);
    }
  });

  it('refuses a counter-feeding rule with a single false_positive verdict, at a rate the delete-only tier would allow', () => {
    // 1/25 = 4%, which would PASS the delete-only 5% tier — the contrast is
    // the point: `counts_as_violation` rules are held to zero, not 5%.
    const ruleId = 'counter-fp';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'ready');
    seedReviewedMatches(ruleId, [
      'false_positive',
      ...Array<MatchVerdict>(24).fill('true_positive'),
    ]);

    const result = enforcementEligibility(scope, ruleId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toEqual({
        reason: 'false-positive',
        falsePositives: 1,
        reviewed: 25,
      });
    }
  });

  it('refuses a counter-feeding rule with a single unclear verdict — unclear counts as a false positive', () => {
    // A separate test from the one above, deliberately: an implementation
    // that counts only `false_positive` passes that test and fails this one.
    const ruleId = 'counter-unclear';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'ready');
    seedReviewedMatches(ruleId, ['unclear', ...Array<MatchVerdict>(24).fill('true_positive')]);

    const result = enforcementEligibility(scope, ruleId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toEqual({
        reason: 'false-positive',
        falsePositives: 1,
        reviewed: 25,
      });
    }
  });

  it('refuses a delete-only rule at 6% and allows it at 4%', () => {
    // Both halves in one test: a single-sided test passes under a comparison
    // with the wrong strictness or an off-by-one denominator.
    const highRuleId = 'delete-only-6pct';
    createTestRule(highRuleId);
    setCutoverState(highRuleId, 'ready');
    setCountsAsViolation(highRuleId, false);
    seedReviewedMatches(highRuleId, [
      'false_positive',
      'false_positive',
      'false_positive',
      ...Array<MatchVerdict>(47).fill('true_positive'),
    ]);
    const high = enforcementEligibility(scope, highRuleId);
    expect(high.ok).toBe(false);
    if (!high.ok) {
      expect(high.refusal.reason).toBe('rate-too-high');
      if (high.refusal.reason === 'rate-too-high') {
        expect(high.refusal.rate).toBeCloseTo(0.06, 6);
        expect(high.refusal.threshold).toBe(0.05);
      }
    }

    const lowRuleId = 'delete-only-4pct';
    createTestRule(lowRuleId);
    setCutoverState(lowRuleId, 'ready');
    setCountsAsViolation(lowRuleId, false);
    seedReviewedMatches(lowRuleId, [
      'false_positive',
      'false_positive',
      ...Array<MatchVerdict>(48).fill('true_positive'),
    ]);
    expect(enforcementEligibility(scope, lowRuleId)).toEqual({ ok: true });
  });

  it('allows a delete-only rule sitting exactly at its 5% boundary', () => {
    // Global Constraint 7, both directions: "at most 5%" means exactly 5% is
    // allowed and just above it is refused (covered by the 6% case above).
    const ruleId = 'delete-only-exact-5pct';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'ready');
    setCountsAsViolation(ruleId, false);
    seedReviewedMatches(ruleId, [
      'false_positive',
      ...Array<MatchVerdict>(19).fill('true_positive'),
    ]);
    expect(enforcementEligibility(scope, ruleId)).toEqual({ ok: true });
  });

  it('falls to the low-volume path at 19 reviewed matches rather than passing on a flattering ratio', () => {
    // 19 reviewed, all true_positive — a 0% false-positive rate, exactly the
    // flattering number the minimum exists to reject.
    const ruleId = 'low-volume-19';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'ready');
    seedReviewedMatches(ruleId, Array<MatchVerdict>(19).fill('true_positive'));

    const unsigned = enforcementEligibility(scope, ruleId);
    expect(unsigned.ok).toBe(false);
    if (!unsigned.ok) {
      expect(unsigned.refusal).toEqual({
        reason: 'low-volume-unsigned',
        reviewed: 19,
        required: 20,
      });
    }

    makeRuleEnforceableForTest(scope, ruleId, NOW);
    expect(enforcementEligibility(scope, ruleId)).toEqual({ ok: true });
  });

  it('does NOT fall to the low-volume path at exactly 20 reviewed matches', () => {
    // The other side of the same boundary: `min_reviewed_matches` is 20 and
    // the rule is "minimum 20 reviewed matches", so 20 is *enough* — an
    // implementation using `<=` refuses a rule sitting exactly on its bar
    // and passes the 19 test above, so only this test distinguishes them.
    const ruleId = 'low-volume-20';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'ready');
    seedReviewedMatches(ruleId, Array<MatchVerdict>(20).fill('true_positive'));

    // No sign-off — the sample is sufficient on its own.
    expect(enforcementEligibility(scope, ruleId)).toEqual({ ok: true });
  });
});

describe('setRuleMode(mode: "enforce")', () => {
  it('advances cutover_state from ready to cutover on a successful enforce', () => {
    // The reason this is asserted at all: a gate that permits enforcement
    // but does not record that it happened leaves `doctor` unable to tell an
    // enforced rule from one merely eligible.
    const ruleId = 'advances';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'ready');
    seedReviewedMatches(ruleId, Array<MatchVerdict>(20).fill('true_positive'));

    const result = setRuleMode(scope, { ruleId, mode: 'enforce', now: NOW });
    expect(result).toEqual({ ok: true });

    const row = t.raw
      .prepare(`SELECT cutover_state, mode FROM mod_rules WHERE guild_id = ? AND rule_id = ?`)
      .get(GUILD, ruleId) as { cutover_state: string; mode: string };
    expect(row.cutover_state).toBe('cutover');
    expect(row.mode).toBe('enforce');
  });

  it('refuses and writes nothing when the gate is not satisfied', () => {
    const ruleId = 'refused-write';
    createTestRule(ruleId);
    // cutover_state stays at its default, 'not_started'.

    const result = setRuleMode(scope, { ruleId, mode: 'enforce', now: NOW });
    expect(result.ok).toBe(false);

    const row = t.raw
      .prepare(`SELECT cutover_state, mode FROM mod_rules WHERE guild_id = ? AND rule_id = ?`)
      .get(GUILD, ruleId) as { cutover_state: string; mode: string };
    // Neither the mode nor the state moved — a refusal is not a partial write.
    expect(row.mode).toBe('test');
    expect(row.cutover_state).toBe('not_started');
  });
});
