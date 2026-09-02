import {
  createPredicateCache,
  evaluateRule,
  predicateInputFrom,
  type EvaluateOutcome,
} from './evaluate.js';
import type { CompileFailure } from './predicates/registry.js';
import type { AutomodRule, FixtureRecord, PredicateMatch } from './predicates/types.js';

/**
 * Replays one rule over the fixture corpus (ADR 0041 §6).
 *
 * The whole point is that it is *not* a second evaluator: it builds its
 * input with `predicateInputFrom` and evaluates with `evaluateRule`, which
 * are the same two functions the live subscriber calls. A parallel
 * implementation would test something other than production, and the entire
 * Release 2 gate rests on this dry run being honest.
 */

export interface DryRunFixtureResult {
  readonly fixtureId: string;
  readonly label: FixtureRecord['label'];
  readonly matched: boolean;
  readonly match: PredicateMatch | undefined;
  /**
   * Whether the rule agreed with the human who labelled this fixture.
   *
   * `'unlabelled'` is a third value rather than a default to `'agreed'`:
   * during the observe window most of the corpus is unlabelled, and counting
   * an unlabelled non-match as a success would make every rule look perfect
   * on the day it shipped.
   */
  readonly agreement: 'agreed' | 'disagreed' | 'unlabelled';
}

export interface DryRunReport {
  readonly ruleId: string;
  readonly kind: string;
  /**
   * False when the rule could not be compiled — the ADR 0040 §4 failure
   * mode, which in a dry run looks exactly like a well-behaved rule that
   * matched nothing. Reported so an operator cannot read "0 matches" as
   * "clean".
   */
  readonly usable: boolean;
  readonly failure: { readonly reason: CompileFailure; readonly detail: string } | undefined;
  readonly total: number;
  readonly matched: number;
  /** `should_not_match` fixtures the rule matched anyway. */
  readonly falsePositives: number;
  /** `should_match` fixtures the rule missed. */
  readonly falseNegatives: number;
  readonly results: readonly DryRunFixtureResult[];
}

export interface RunDryRunInput {
  readonly guildId: string;
  readonly rule: AutomodRule;
  readonly fixtures: readonly FixtureRecord[];
}

export const runDryRun = (input: RunDryRunInput): DryRunReport => {
  // A fresh cache per run, never a shared one: the window tier (Slice 4)
  // carries mutable sliding-window state on its compiled artifact, so a
  // reused artifact would make a run's result depend on what ran before it
  // (ADR 0041 §6).
  const cache = createPredicateCache();

  // Oldest first. The caller is expected to pass them in order, but sorting
  // here means a dry run cannot silently depend on the caller having
  // remembered — the same reasoning `listFixtures` gives for its ORDER BY.
  const ordered = [...input.fixtures].sort(
    (a, b) => a.createdAt - b.createdAt || a.fixtureId.localeCompare(b.fixtureId),
  );

  const results: DryRunFixtureResult[] = [];
  let failure: DryRunReport['failure'];

  for (const fixture of ordered) {
    const predicateInput = predicateInputFrom({
      from: 'fixture',
      guildId: input.guildId,
      fixture,
    });
    // `predicateInputFrom` only returns `undefined` for a message with no
    // author or content; a fixture always produces an input. Handled rather
    // than asserted, because a `!` here would be a cast in the one module
    // whose job is to be trustworthy.
    if (predicateInput === undefined) continue;

    const outcome: EvaluateOutcome = evaluateRule(cache, input.rule, predicateInput);
    if (outcome.kind === 'unusable') {
      failure = { reason: outcome.reason, detail: outcome.detail };
      results.push({
        fixtureId: fixture.fixtureId,
        label: fixture.label,
        matched: false,
        match: undefined,
        agreement: 'unlabelled',
      });
      continue;
    }

    // A predicate that throws on one fixture is recorded as a non-match for
    // that fixture and the replay continues — one malformed message must not
    // end the run, the same way it does not end the live handler.
    const match = outcome.kind === 'match' ? outcome.match : undefined;
    const matched = match !== undefined;
    const agreement =
      fixture.label === 'unlabelled'
        ? ('unlabelled' as const)
        : (fixture.label === 'should_match') === matched
          ? ('agreed' as const)
          : ('disagreed' as const);

    results.push({ fixtureId: fixture.fixtureId, label: fixture.label, matched, match, agreement });
  }

  return {
    ruleId: input.rule.ruleId,
    kind: input.rule.kind,
    usable: failure === undefined,
    failure,
    total: results.length,
    matched: results.filter((r) => r.matched).length,
    falsePositives: results.filter((r) => r.label === 'should_not_match' && r.matched).length,
    falseNegatives: results.filter((r) => r.label === 'should_match' && !r.matched).length,
    results,
  };
};
