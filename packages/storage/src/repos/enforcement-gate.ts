import { and, eq, sql } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { modCaseEvents, modMatchReviews, modRules } from '../schema.js';
import type { CutoverState } from './automod-rules.js';

/**
 * ADR 0042's release gate: the one function that decides whether a rule may
 * be moved to `mode = 'enforce'`. Lives in `packages/storage`, not `core`
 * (ADR 0042 §3): every fact it reads — `cutover_state`, `counts_as_violation`,
 * the verdict tally — is already SQL, and placing the check at the write path
 * (`setRuleMode`) means every future caller inherits it rather than having to
 * remember to call it.
 */

export type EnforcementRefusal =
  /** `cutover_state` does not permit it (PR-27): anything but `ready`/`cutover`. */
  | { readonly reason: 'cutover-state'; readonly state: string }
  /** A counter-feeding rule (`counts_as_violation`) with any `false_positive` or `unclear` verdict. */
  | {
      readonly reason: 'false-positive';
      readonly falsePositives: number;
      readonly reviewed: number;
    }
  /** A delete-only rule above its own `max_false_positive_rate`. */
  | { readonly reason: 'rate-too-high'; readonly rate: number; readonly threshold: number }
  /** Fewer than `min_reviewed_matches` reviewed, and no sign-off (PR-29). */
  | {
      readonly reason: 'low-volume-unsigned';
      readonly reviewed: number;
      readonly required: number;
    };

export type EnforcementEligibility =
  { readonly ok: true } | { readonly ok: false; readonly refusal: EnforcementRefusal };

/**
 * Whether `ruleId` may be moved to `mode = 'enforce'` right now.
 *
 * **Check order is part of the contract, not an implementation detail**: state
 * first, then the low-volume path, then the false-positive count, then the
 * rate. A rule sitting in `observing` with a terrible false-positive rate is
 * refused for its *state* — that is the fact an operator has to act on first,
 * and reporting a rate to someone who has not even started the clock would be
 * answering a question nobody asked yet.
 *
 * The reviewed-match tally is a join (PR-28), not a column: `mod_match_reviews`
 * has no `rule_id` of its own, so a verdict is attributed to a rule by way of
 * the `mod_case_events` row its `event_id` names. `unclear` counts as a false
 * positive (spec decision 16) — a queue of parked `unclear` verdicts must not
 * be a way to pass the gate.
 *
 * A rule with no such id (a stale reference, a typo) reads back as
 * `cutover_state: 'not_started'`: it has no evidence and no state at all,
 * which is the same refusal a real `not_started` row gets, and it keeps this
 * function total rather than throwing from what is, for every other caller
 * here, a read.
 */
export const enforcementEligibility = (scope: GuildScope, ruleId: string): EnforcementEligibility =>
  read(scope, (db) => {
    const rule = db
      .select({
        cutoverState: modRules.cutoverState,
        countsAsViolation: modRules.countsAsViolation,
        maxFalsePositiveRate: modRules.maxFalsePositiveRate,
        minReviewedMatches: modRules.minReviewedMatches,
        enforceSignedOffBy: modRules.enforceSignedOffBy,
      })
      .from(modRules)
      .where(scope.only(modRules, eq(modRules.ruleId, ruleId)))
      .get();

    const cutoverState = (rule?.cutoverState ?? 'not_started') as CutoverState;

    // 1. State first (see the doc comment above for why).
    if (cutoverState !== 'ready' && cutoverState !== 'cutover') {
      return { ok: false, refusal: { reason: 'cutover-state', state: cutoverState } };
    }
    // `rule` is defined past this point: the only way `cutoverState` reaches
    // `'ready'`/`'cutover'` is a real row carrying one of those values.
    const row = rule!;

    const tally = db
      .select({
        reviewed: sql<number>`count(*)`,
        falsePositives: sql<number>`coalesce(sum(case when ${modMatchReviews.verdict} in ('false_positive','unclear') then 1 else 0 end), 0)`,
      })
      .from(modMatchReviews)
      .innerJoin(
        modCaseEvents,
        and(
          eq(modMatchReviews.guildId, modCaseEvents.guildId),
          eq(modMatchReviews.eventId, modCaseEvents.eventId),
        ),
      )
      .where(scope.only(modCaseEvents, eq(modCaseEvents.ruleId, ruleId)))
      .get() ?? { reviewed: 0, falsePositives: 0 };

    const reviewed = Number(tally.reviewed);
    const falsePositives = Number(tally.falsePositives);

    // 2. The low-volume path (PR-29): fewer than the minimum is not a score
    // at all — not even a flattering one — unless an owner has signed off.
    // The sign-off's own precondition (a clean dry run against the fixture
    // corpus) is machine-checked where it is recorded, `automod signoff`
    // (Task 6), because storage may not import `core` to run one (ADR 0014).
    if (reviewed < row.minReviewedMatches) {
      if (row.enforceSignedOffBy !== null) return { ok: true };
      return {
        ok: false,
        refusal: { reason: 'low-volume-unsigned', reviewed, required: row.minReviewedMatches },
      };
    }

    // 3. Counter-feeding rules are held to a zero bar: any reviewed false
    // positive (or `unclear`) refuses, however small the measured rate is —
    // a rate that would pass the delete-only tier below still refuses here.
    if (row.countsAsViolation === 1 && falsePositives > 0) {
      return { ok: false, refusal: { reason: 'false-positive', falsePositives, reviewed } };
    }

    // 4. Delete-only rules are held to a rate instead, inclusive at the
    // boundary: "at most 5%" means exactly 5% passes and only strictly above
    // it refuses.
    const rate = falsePositives / reviewed;
    if (rate > row.maxFalsePositiveRate) {
      return {
        ok: false,
        refusal: { reason: 'rate-too-high', rate, threshold: row.maxFalsePositiveRate },
      };
    }

    return { ok: true };
  });

/**
 * Test-only shortcut for PR-31 (plan ruling): moves a rule straight to
 * `cutover_state = 'ready'` with a canned sign-off, so a test whose subject
 * is something *downstream* of enforcement — the subscriber, the mode-flip
 * mechanics, `listEnforceModeKeywordFilterRules` — can reach
 * `setRuleMode(mode: 'enforce')` without first building a 20-match review
 * corpus that test has nothing to do with.
 *
 * **Not a production path, and not a second way to reach `mode = 'enforce'`.**
 * It writes eligibility facts, not the mode itself; `setRuleMode` still runs
 * the real gate afterwards. `automod ready` (Task 6, refused outside
 * `observing`) and `automod signoff` (Task 6, refused unless a dry run over
 * the fixture corpus is clean, PR-29) are the production writers for these
 * two facts, and each carries its own precondition. This writes both at once
 * with no precondition at all, which is only defensible because its only
 * caller is a test harness that already trusts its own fixture setup.
 */
export const makeRuleEnforceableForTest = (scope: GuildScope, ruleId: string, now: number): void =>
  write(scope, ({ db }) => {
    db.update(modRules)
      .set({
        cutoverState: 'ready',
        enforceSignedOffBy: 'test-harness',
        enforceSignedOffAt: now,
      })
      .where(scope.only(modRules, eq(modRules.ruleId, ruleId)))
      .run();
  });
