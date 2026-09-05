import { beforeEach, describe, expect, it } from 'vitest';
import {
  makeRuleEnforceableForTest,
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '../test-support.js';
import { parseGuildId } from '@bananasaurs/core';
import type { GuildScope } from '../scope.js';
import { upsertGuild } from './guilds.js';
import { createRule, setRuleMode, type CutoverState } from './automod-rules.js';
import { openOrResolveCase, recordCaseEvent } from './mod-cases.js';
import { recordVerdict, type MatchVerdict } from './mod-match-reviews.js';
import {
  enforcementEligibility,
  listEnforceRulesWithBadCutoverState,
  listObservingRulesPastWindowWithBacklog,
  OBSERVE_WINDOW_FLOOR_MS,
} from './enforcement-gate.js';

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
 * Sets `mod_rules.mode` directly. `setRuleMode` refuses `'enforce'` unless the
 * gate already permits it (that is the whole point of Tasks 2+3), so the only
 * way to plant the "hand-edited or pre-slice" row `listEnforceRulesWithBadCutoverState`
 * exists to catch — `mode = 'enforce'` paired with a `cutover_state` no writer
 * would leave it in — is a raw write, same reasoning as `setCutoverState` above.
 */
const setMode = (ruleId: string, mode: 'test' | 'observe' | 'enforce'): void => {
  t.raw
    .prepare(`UPDATE mod_rules SET mode = ? WHERE guild_id = ? AND rule_id = ?`)
    .run(mode, GUILD, ruleId);
};

/** Sets `mod_rules.observe_started_at` directly, including back to NULL. */
const setObserveStartedAt = (ruleId: string, at: number | null): void => {
  t.raw
    .prepare(`UPDATE mod_rules SET observe_started_at = ? WHERE guild_id = ? AND rule_id = ?`)
    .run(at, GUILD, ruleId);
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

  it('does not let a sign-off excuse recorded false-positive verdicts', () => {
    // The sign-off clears the low-volume *floor*, not the evidence. It attests
    // that a dry run over the fixture corpus was clean (PR-29, machine-checked
    // in `automod signoff`); it says nothing about the `mod_match_reviews` rows
    // this gate tallies. A short-circuit to `ok` here let five verdict rows,
    // every one of them `false_positive`, through the gate on the strength of a
    // corpus that had never seen those matches — ADR 0039's shape exactly, a
    // number that reads reassuring when it is not.
    //
    // The verdicts below are seeded fixtures, as every verdict in this file is;
    // what is under test is how the gate weighs rows of this shape, not that
    // anyone reviewed anything. In production `mod_match_reviews` has no writer
    // but a review path — `automod review`, and Slice 9's dashboard — which is
    // what makes the shape worth weighing at all.
    //
    // So: signed off, under the floor, and every verdict a false positive must
    // still be refused, and refused for the *false positives* rather than for
    // the volume, because that is the fact the operator has to act on.
    const ruleId = 'signed-off-all-false-positive';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'ready');
    seedReviewedMatches(ruleId, Array<MatchVerdict>(5).fill('false_positive'));
    makeRuleEnforceableForTest(scope, ruleId, NOW);

    const result = enforcementEligibility(scope, ruleId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toEqual({ reason: 'false-positive', falsePositives: 5, reviewed: 5 });
    }
  });

  it('holds a signed-off low-volume delete-only rule to its rate as well', () => {
    // The same fall-through, one tier down. `counts_as_violation = 0` skips
    // the zero bar above, so the rate check is what has to catch this: 1 of 4
    // is 25%, far above the 5% default, and a sign-off does not buy an
    // exemption from it either.
    const ruleId = 'signed-off-delete-only-bad-rate';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'ready');
    setCountsAsViolation(ruleId, false);
    seedReviewedMatches(ruleId, [
      'false_positive',
      ...Array<MatchVerdict>(3).fill('true_positive'),
    ]);
    makeRuleEnforceableForTest(scope, ruleId, NOW);

    const result = enforcementEligibility(scope, ruleId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe('rate-too-high');
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

/**
 * PR-27's other three transitions. The enforce-side gate above is only two of
 * the five arrows in the ruling's table, and the other three all live in this
 * same `setRuleMode` — a fact the Task 2+3 brief omitted, pointing at the
 * plan's "Interfaces" block rather than at PR-27's table.
 *
 * Leaving them out is not a cosmetic gap. `automod ready` (Task 6) refuses
 * unless the rule is currently `observing`, and nothing else writes
 * `observing`, so without these the only command that can reach `ready` could
 * never succeed and `rolled_back` would be unreachable — exactly the "all three
 * states were unreachable and the property was false" defect the plan review
 * already caught once in PR-27's own first draft.
 */
describe('setRuleMode: the rest of the PR-27 state machine', () => {
  const stateOf = (ruleId: string): { cutover_state: string; observe_started_at: number | null } =>
    t.raw
      .prepare(
        `SELECT cutover_state, observe_started_at FROM mod_rules WHERE guild_id = ? AND rule_id = ?`,
      )
      .get(GUILD, ruleId) as { cutover_state: string; observe_started_at: number | null };

  it('starts the clock: not_started plus observe becomes observing and stamps observe_started_at', () => {
    const ruleId = 'starts-clock';
    createTestRule(ruleId);

    expect(setRuleMode(scope, { ruleId, mode: 'observe', now: NOW })).toEqual({ ok: true });
    expect(stateOf(ruleId)).toEqual({ cutover_state: 'observing', observe_started_at: NOW });
  });

  it('does not restart the clock when a rule already observing is set to observe again', () => {
    // The failure this forbids is ADR 0039's shape: a window that silently
    // never elapses. `doctor` reports rules in `observe` past their floor by
    // comparing `observe_started_at` to now, so a stamp refreshed on every call
    // would keep every rule permanently just-started, and that check would read
    // as reassuring while never once firing.
    const ruleId = 'no-clock-restart';
    createTestRule(ruleId);
    setRuleMode(scope, { ruleId, mode: 'observe', now: NOW });

    setRuleMode(scope, { ruleId, mode: 'observe', now: NOW + 999_999 });
    expect(stateOf(ruleId)).toEqual({ cutover_state: 'observing', observe_started_at: NOW });
  });

  it('records the rollback: a cutover rule moved off enforce becomes rolled_back, not observing', () => {
    // Deliberately NOT straight to `observing`. Going there in one step would
    // skip `rolled_back` entirely, and `rolled_back` is the state carrying the
    // whole safety property — `automod ready` refuses from it, which is what
    // stops a rollback being undone by retrying. Re-observing is a separate,
    // deliberate second act, tested below.
    const ruleId = 'records-rollback';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'cutover');

    expect(setRuleMode(scope, { ruleId, mode: 'observe', now: NOW })).toEqual({ ok: true });
    const state = stateOf(ruleId);
    expect(state.cutover_state).toBe('rolled_back');
    // The clock is not started here either: earning a fresh window is what the
    // *next* call does.
    expect(state.observe_started_at).toBeNull();
  });

  it('a rollback withdraws the sign-off, closing the low-volume hatch behind it', () => {
    // Without this, `rolled_back` only blocks the *direct* route back. The
    // indirect one stayed open: rolled_back -> observing -> ready -> enforce,
    // and because a sign-off is the one thing that clears the low-volume floor,
    // a stale one from before the rollback let the rule re-enforce on **fewer
    // than `min_reviewed_matches`** — the fresh window it was made to serve
    // counting for nothing.
    //
    // A sign-off attests "I replayed this rule against the corpus and it was
    // clean". Pulling the rule out of enforcement is a statement that it was
    // not, in fact, safe, so the attestation that supported it cannot survive.
    // The owner signs off again, against the evidence the new window produced.
    const ruleId = 'rollback-withdraws-signoff';
    createTestRule(ruleId);
    makeRuleEnforceableForTest(scope, ruleId, NOW);
    setCutoverState(ruleId, 'cutover');

    setRuleMode(scope, { ruleId, mode: 'observe', now: NOW });

    const row = t.raw
      .prepare(
        `SELECT cutover_state, enforce_signed_off_by, enforce_signed_off_at
         FROM mod_rules WHERE guild_id = ? AND rule_id = ?`,
      )
      .get(GUILD, ruleId) as {
      cutover_state: string;
      enforce_signed_off_by: string | null;
      enforce_signed_off_at: number | null;
    };
    expect(row).toEqual({
      cutover_state: 'rolled_back',
      enforce_signed_off_by: null,
      enforce_signed_off_at: null,
    });

    // And the hatch is really shut: back to observing, on to ready, and the
    // gate still refuses because the evidence is thin and unsigned.
    setRuleMode(scope, { ruleId, mode: 'observe', now: NOW + 1 });
    setCutoverState(ruleId, 'ready');
    seedReviewedMatches(ruleId, Array<MatchVerdict>(3).fill('true_positive'));

    const result = enforcementEligibility(scope, ruleId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe('low-volume-unsigned');
  });

  it('re-observing a rolled_back rule returns it to observing and resets the clock', () => {
    // The carried-forward obligation from this run's kickoff: a rule pulled
    // back from enforcement has to earn a fresh window, because its old
    // `observe_started_at` would let `doctor` think the floor had elapsed.
    const ruleId = 'reobserve-resets';
    createTestRule(ruleId);
    setRuleMode(scope, { ruleId, mode: 'observe', now: NOW });
    setCutoverState(ruleId, 'cutover');
    setRuleMode(scope, { ruleId, mode: 'observe', now: NOW + 1 });
    expect(stateOf(ruleId).cutover_state).toBe('rolled_back');

    const later = NOW + 500_000;
    expect(setRuleMode(scope, { ruleId, mode: 'observe', now: later })).toEqual({ ok: true });
    expect(stateOf(ruleId)).toEqual({ cutover_state: 'observing', observe_started_at: later });
  });

  it('disabling a cutover rule is not a rollback and leaves its state alone', () => {
    // `setRuleMode({ enabled: false })` is the daemon's real panic path, and it
    // requests no mode change at all. `cutover` means "this rule has been
    // enforced", which stays true across a pause, and the evidence behind it
    // does not expire — so a disable must not consume the rollback arrow.
    const ruleId = 'disable-not-rollback';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'cutover');

    expect(setRuleMode(scope, { ruleId, enabled: false, now: NOW })).toEqual({ ok: true });
    expect(stateOf(ruleId).cutover_state).toBe('cutover');
  });
});

/**
 * `doctor`'s first ADR 0042 §3 check (Task 6): a rule already enforcing whose
 * `cutover_state` is not one that permits it.
 */
describe('listEnforceRulesWithBadCutoverState', () => {
  it('reports a rule in mode enforce whose cutover_state does not permit it', () => {
    // `setRuleMode` cannot produce this combination itself — that is the
    // point — so the only way to plant it is the raw write a hand edit or a
    // pre-slice row would also produce.
    const ruleId = 'hand-edited-enforce';
    createTestRule(ruleId);
    setMode(ruleId, 'enforce');
    setCutoverState(ruleId, 'observing');

    expect(listEnforceRulesWithBadCutoverState(scope)).toEqual([
      { ruleId, cutoverState: 'observing' },
    ]);
  });

  it('does not report an enforce-mode rule whose cutover_state is ready or cutover', () => {
    // Reached through the real production path, unlike the case above:
    // `makeRuleEnforceableForTest` plus a legitimate `setRuleMode(mode:
    // 'enforce')` is exactly what a rule that followed the rules looks like.
    const ruleId = 'legitimately-enforcing';
    createTestRule(ruleId);
    makeRuleEnforceableForTest(scope, ruleId, NOW);
    expect(setRuleMode(scope, { ruleId, mode: 'enforce', now: NOW })).toEqual({ ok: true });

    expect(listEnforceRulesWithBadCutoverState(scope)).toEqual([]);
  });

  it('does not report a rule in mode observe, whatever its cutover_state', () => {
    // The check is about `mode = 'enforce'` specifically — a rule merely
    // observing is not enforcing anything yet, whatever its state says.
    const ruleId = 'not-enforcing';
    createTestRule(ruleId);
    setMode(ruleId, 'observe');
    setCutoverState(ruleId, 'not_started');

    expect(listEnforceRulesWithBadCutoverState(scope)).toEqual([]);
  });
});

/**
 * `doctor`'s second ADR 0042 §3 check (Task 6): a rule sitting in `observing`
 * past `docs/08`'s two-week floor with an unreviewed match backlog.
 */
describe('listObservingRulesPastWindowWithBacklog', () => {
  it('reports an observing rule past its window with unreviewed matches', () => {
    const ruleId = 'overdue-with-backlog';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'observing');
    setObserveStartedAt(ruleId, NOW - OBSERVE_WINDOW_FLOOR_MS - 1);
    seedReviewedMatches(ruleId, ['true_positive']); // one reviewed
    // Two genuinely unreviewed events on top of the one reviewed one.
    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: NOW });
    recordCaseEvent(scope, {
      eventId: `${ruleId}-unreviewed-1`,
      caseId,
      ruleId,
      memberId: MEMBER,
      at: NOW,
      matchedCategory: 'x',
      matchedSnippet: 'x',
      actionTaken: 'would_delete',
    });
    recordCaseEvent(scope, {
      eventId: `${ruleId}-unreviewed-2`,
      caseId,
      ruleId,
      memberId: MEMBER,
      at: NOW,
      matchedCategory: 'x',
      matchedSnippet: 'x',
      actionTaken: 'would_delete',
    });

    const result = listObservingRulesPastWindowWithBacklog(scope, NOW);
    expect(result).toEqual([
      {
        ruleId,
        observeStartedAt: NOW - OBSERVE_WINDOW_FLOOR_MS - 1,
        unreviewedCount: 2,
      },
    ]);
  });

  it('does not report a rule whose observe_started_at is null — a window that has not started is not overdue', () => {
    // The trap the brief names explicitly: without this, every fresh rule
    // (which has never started its clock) would be reported forever.
    const ruleId = 'never-started';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'observing');
    setObserveStartedAt(ruleId, null);
    seedReviewedMatch(ruleId, 'true_positive');
    // Even an unreviewed event should not surface a null-clock rule.
    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: NOW });
    recordCaseEvent(scope, {
      eventId: `${ruleId}-unreviewed`,
      caseId,
      ruleId,
      memberId: MEMBER,
      at: NOW,
      matchedCategory: 'x',
      matchedSnippet: 'x',
      actionTaken: 'would_delete',
    });

    expect(listObservingRulesPastWindowWithBacklog(scope, NOW)).toEqual([]);
  });

  it('does not report a disabled rule, however old its clock and however deep its backlog', () => {
    // Unlike `listEnforceRulesWithBadCutoverState`, which deliberately ignores
    // `enabled` because a disabled `mode = 'enforce'` row is a latent hazard —
    // `setRuleMode({ enabled: true })` passes no mode, so it never consults the
    // gate and the rule resumes enforcing on a state no writer would have left
    // it in — this check is a *workflow prompt*: "your window is up, go review
    // the backlog so you can decide about enforcement". For a rule an owner has
    // turned off there is no decision waiting, the backlog stops growing, and
    // the only thing that clears the line is reviewing matches for a rule
    // nobody uses. It would therefore sit in `doctor` forever.
    //
    // That matters more than the tidiness: `doctor` is what an operator runs to
    // find out whether anything needs them. A permanent line nothing can clear
    // teaches them to skim past it, and then the check that fires for a real
    // reason is skimmed past too. A check that cries wolf is worse than no
    // check, which is the same reasoning ADR 0039 applies to reassuring
    // numbers, pointed the other way.
    const ruleId = 'disabled-with-backlog';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'observing');
    setObserveStartedAt(ruleId, NOW - OBSERVE_WINDOW_FLOOR_MS - 1);
    setRuleMode(scope, { ruleId, enabled: false, now: NOW });

    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: NOW });
    recordCaseEvent(scope, {
      eventId: `${ruleId}-unreviewed`,
      caseId,
      ruleId,
      memberId: MEMBER,
      at: NOW,
      matchedCategory: 'x',
      matchedSnippet: 'x',
      actionTaken: 'would_delete',
    });

    expect(listObservingRulesPastWindowWithBacklog(scope, NOW)).toEqual([]);
  });

  it('does not report a rule whose window has not yet reached the two-week floor', () => {
    const ruleId = 'still-within-window';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'observing');
    // One millisecond short of the floor.
    setObserveStartedAt(ruleId, NOW - OBSERVE_WINDOW_FLOOR_MS + 1);
    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: NOW });
    recordCaseEvent(scope, {
      eventId: `${ruleId}-unreviewed`,
      caseId,
      ruleId,
      memberId: MEMBER,
      at: NOW,
      matchedCategory: 'x',
      matchedSnippet: 'x',
      actionTaken: 'would_delete',
    });

    expect(listObservingRulesPastWindowWithBacklog(scope, NOW)).toEqual([]);
  });

  it('reports a rule sitting exactly at the two-week floor', () => {
    // Global Constraint 7, the other direction: exactly at the boundary counts
    // as overdue, not just strictly past it.
    const ruleId = 'exactly-at-floor';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'observing');
    setObserveStartedAt(ruleId, NOW - OBSERVE_WINDOW_FLOOR_MS);
    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: NOW });
    recordCaseEvent(scope, {
      eventId: `${ruleId}-unreviewed`,
      caseId,
      ruleId,
      memberId: MEMBER,
      at: NOW,
      matchedCategory: 'x',
      matchedSnippet: 'x',
      actionTaken: 'would_delete',
    });

    expect(listObservingRulesPastWindowWithBacklog(scope, NOW)).toEqual([
      {
        ruleId,
        observeStartedAt: NOW - OBSERVE_WINDOW_FLOOR_MS,
        unreviewedCount: 1,
      },
    ]);
  });

  it('does not report a rule past its window with zero unreviewed backlog', () => {
    // Overdue and fully reviewed is not a problem `doctor` needs to raise —
    // "backlog" is the operative word, not merely "old".
    const ruleId = 'overdue-clean';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'observing');
    setObserveStartedAt(ruleId, NOW - OBSERVE_WINDOW_FLOOR_MS - 1);
    seedReviewedMatches(ruleId, ['true_positive', 'true_positive']);

    expect(listObservingRulesPastWindowWithBacklog(scope, NOW)).toEqual([]);
  });

  it('does not report a rule not in cutover_state observing', () => {
    const ruleId = 'wrong-state';
    createTestRule(ruleId);
    setCutoverState(ruleId, 'ready');
    setObserveStartedAt(ruleId, NOW - OBSERVE_WINDOW_FLOOR_MS - 1);
    const { caseId } = openOrResolveCase(scope, { memberId: MEMBER, now: NOW });
    recordCaseEvent(scope, {
      eventId: `${ruleId}-unreviewed`,
      caseId,
      ruleId,
      memberId: MEMBER,
      at: NOW,
      matchedCategory: 'x',
      matchedSnippet: 'x',
      actionTaken: 'would_delete',
    });

    expect(listObservingRulesPastWindowWithBacklog(scope, NOW)).toEqual([]);
  });
});
