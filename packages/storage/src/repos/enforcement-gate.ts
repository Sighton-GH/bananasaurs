import { and, eq, sql } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read } from '../write.js';
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
    //
    // **A sign-off clears this floor and nothing else.** It falls *through* to
    // the two checks below rather than returning `ok` — the four checks are an
    // ordered list where each one refuses or defers, not a chain of exits. What
    // the sign-off attests is that a dry run over the *fixture corpus* was
    // clean. That is a different body of evidence from the `mod_match_reviews`
    // rows tallied above, and the weaker one: a corpus is authored, while a
    // verdict row is a judgement recorded against traffic the rule actually
    // matched. Short-circuiting here admitted a rule carrying five verdict
    // rows, every one of them `false_positive`, on the strength of a corpus
    // that had never seen those matches — ADR 0039's shape, a number that
    // reads reassuring when it is not. Both directions are pinned by test, at
    // the zero bar and at the rate.
    if (reviewed < row.minReviewedMatches && row.enforceSignedOffBy === null) {
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
    //
    // `reviewed` can legitimately be 0 here — a rule signed off before any
    // match was reviewed, or one whose `min_reviewed_matches` an operator set
    // to 0. There is no rate to hold such a rule to, and `0 / 0` is `NaN`,
    // whose every comparison is false; computing it and relying on that would
    // be passing the gate by accident. Say so instead: check 3 above has
    // already established there are no false positives to weigh.
    if (reviewed === 0) return { ok: true };

    const rate = falsePositives / reviewed;
    if (rate > row.maxFalsePositiveRate) {
      return {
        ok: false,
        refusal: { reason: 'rate-too-high', rate, threshold: row.maxFalsePositiveRate },
      };
    }

    return { ok: true };
  });

/** One `mod_rules` row already in `mode = 'enforce'` whose `cutover_state` does not permit it. */
export interface EnforceModeBadCutoverStateRow {
  readonly ruleId: string;
  readonly cutoverState: string;
}

/**
 * `doctor`'s first ADR 0042 §3 check (Task 6): rules already enforcing whose
 * `cutover_state` is not `ready` or `cutover`.
 *
 * `setRuleMode` (this file) can no longer *create* such a row — the eligibility
 * gate above refuses `mode: 'enforce'` outside those two states, and every other
 * `mode` write leaves `cutover_state` alone or moves it off `cutover`/`ready`
 * deliberately. So a row here is either older than this slice (`mode` reached
 * `'enforce'` before ADR 0042 existed) or was hand-edited straight into the
 * database — `doctor` reports it because nothing at the write path can.
 */
export const listEnforceRulesWithBadCutoverState = (
  scope: GuildScope,
): readonly EnforceModeBadCutoverStateRow[] =>
  read(scope, (db) =>
    db
      .select({ ruleId: modRules.ruleId, cutoverState: modRules.cutoverState })
      .from(modRules)
      .where(
        scope.only(
          modRules,
          and(
            eq(modRules.mode, 'enforce'),
            sql`${modRules.cutoverState} NOT IN ('ready','cutover')`,
          ),
        ),
      )
      .all(),
  );

/**
 * `docs/08`'s floor: an observe window has to run at least this long before
 * `doctor` will call it overdue. **Not** `BULK_DELETE_CEILING_MS`
 * (`packages/core/src/mod/purge.ts`) — that constant is the same fourteen days
 * for a wholly different reason (Discord's bulk-delete API limit) and importing
 * it here would tie two unrelated facts together by coincidence of value.
 */
export const OBSERVE_WINDOW_FLOOR_MS = 14 * 24 * 60 * 60 * 1000;

/** One `observing` rule past its window, with how many of its matches nobody has reviewed. */
export interface ObservingPastWindowBacklogRow {
  readonly ruleId: string;
  readonly observeStartedAt: number;
  readonly unreviewedCount: number;
}

/**
 * `doctor`'s second ADR 0042 §3 check (Task 6): rules sitting in
 * `cutover_state = 'observing'` whose window started at least
 * `OBSERVE_WINDOW_FLOOR_MS` ago and still carry an unreviewed match backlog.
 *
 * `observe_started_at IS NULL` is excluded, not defaulted to "overdue": a rule
 * that has not started its window is not late for one, and a rule with every
 * match reviewed is not backlogged even if the calendar says it could enforce —
 * both are the ordinary, unremarkable case `doctor` must stay silent about.
 *
 * The backlog count is the same LEFT JOIN `enforcementEligibility` runs
 * (PR-28), just without the `rule_id` filter baked into a single query: a
 * `mod_case_events` row for this rule with no matching `mod_match_reviews` row.
 * Guild-scoped on both the rule lookup and the join, as `enforcementEligibility`
 * is.
 */
export const listObservingRulesPastWindowWithBacklog = (
  scope: GuildScope,
  nowMs: number,
): readonly ObservingPastWindowBacklogRow[] => {
  const cutoffMs = nowMs - OBSERVE_WINDOW_FLOOR_MS;
  const candidates = read(scope, (db) =>
    db
      .select({ ruleId: modRules.ruleId, observeStartedAt: modRules.observeStartedAt })
      .from(modRules)
      .where(
        scope.only(
          modRules,
          and(
            eq(modRules.cutoverState, 'observing'),
            // Enabled only. Deliberately unlike `listEnforceRulesWithBadCutoverState`
            // above, which ignores `enabled` because a disabled `mode = 'enforce'`
            // row is a latent hazard — `setRuleMode({ enabled: true })` passes no
            // mode, so it never consults the gate and the rule resumes enforcing
            // on a state no writer would have left it in. This check is instead a
            // workflow prompt: "your window is up, go review the backlog". A rule
            // an owner turned off has no decision waiting and a backlog that has
            // stopped growing, so it would sit in `doctor` forever with nothing
            // able to clear it — and a line nothing can clear teaches an operator
            // to skim past the ones that matter.
            eq(modRules.enabled, 1),
            // Explicit, even though SQLite's own `NULL <= x` already evaluates
            // to NULL (falsy in a WHERE) and would exclude these rows anyway —
            // watched by removing this line, which changed no test's result.
            // Kept as documentation of intent rather than relying on that NULL
            // comparison behaviour silently doing the right thing.
            sql`${modRules.observeStartedAt} IS NOT NULL`,
            sql`${modRules.observeStartedAt} <= ${cutoffMs}`,
          ),
        ),
      )
      .all(),
  );

  return candidates
    .map((rule) => {
      const backlog = read(
        scope,
        (db) =>
          db
            .select({ unreviewed: sql<number>`count(*)` })
            .from(modCaseEvents)
            .leftJoin(
              modMatchReviews,
              and(
                eq(modCaseEvents.guildId, modMatchReviews.guildId),
                eq(modCaseEvents.eventId, modMatchReviews.eventId),
              ),
            )
            .where(
              scope.only(
                modCaseEvents,
                and(eq(modCaseEvents.ruleId, rule.ruleId), sql`${modMatchReviews.eventId} IS NULL`),
              ),
            )
            .get() ?? { unreviewed: 0 },
      );
      return {
        ruleId: rule.ruleId,
        // Non-null: the query above filtered on `IS NOT NULL`.
        observeStartedAt: rule.observeStartedAt as number,
        unreviewedCount: Number(backlog.unreviewed),
      };
    })
    .filter((row) => row.unreviewedCount > 0);
};
