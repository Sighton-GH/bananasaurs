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
   *
   * A `'threw'` outcome (below) is always `'unlabelled'` here, never
   * `'agreed'` or `'disagreed'` — a throw is not evidence the rule behaved
   * correctly (or incorrectly) on this fixture, it is evidence the rule did
   * not run on it at all (CRITICAL-1).
   */
  readonly agreement: 'agreed' | 'disagreed' | 'unlabelled';
  /**
   * `'threw'` when `evaluateRule` returned `{ kind: 'threw' }` for this
   * fixture, rather than a match or a non-match (CRITICAL-1). Kept as its own
   * field rather than folded into `matched: false`, which is what let a rule
   * that timed out on every fixture in the corpus report as a clean rule.
   */
  readonly outcome: 'ok' | 'threw';
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
  /**
   * How many fixtures the predicate threw on instead of matching or not
   * (CRITICAL-1). Every dry run over a corpus a pathological pattern reaches
   * used to report as clean, because the throw was folded into a plain
   * non-match and `DryRunReport` had no field to say otherwise.
   */
  readonly threw: number;
  /**
   * How many fixtures exist in the corpus this run was asked to replay —
   * independent of `total`, the number actually evaluated. They differ only
   * when the run was abandoned after `MAX_THROWS_BEFORE_ABANDON` throws
   * (IMPORTANT-5): a pathological predicate would otherwise pay 25ms per
   * fixture, synchronously, with nothing else in this one process (ADR 0006)
   * able to run — a corpus of ~1,700 fixtures is enough to pass Discord's
   * gateway heartbeat interval and force a reconnect.
   */
  readonly corpusSize: number;
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

/**
 * Abandon the replay after this many throws (IMPORTANT-5).
 *
 * The live subscriber pays 25ms per timing-out rule per *message*, bounded
 * by rule count — survivable. The dry run is fully synchronous, one process
 * (ADR 0006), and replays the *whole* corpus: 300 fixtures x 25ms is 7.5s of
 * completely blocked event loop, and the corpus has no cap. Five throws
 * bounds the stall at ~125ms and is also what fixes CRITICAL-1's reporting —
 * an operator sees that the run stopped early rather than a report that
 * looks clean because most of the corpus was never reached.
 */
const MAX_THROWS_BEFORE_ABANDON = 5;

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
  let threw = 0;

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
        outcome: 'ok',
      });
      continue;
    }

    // A predicate that throws on one fixture does not end the run — one
    // malformed message must not end the replay, the same way it does not
    // end the live handler (`subscriber.ts`) — but it also does not read as
    // an ordinary non-match. The live handler logs `'the predicate threw;
    // message left unmatched for this rule'` naming the rule; this replay
    // has no logger by design (`evaluate.ts`'s header), so `threw` and each
    // fixture's `outcome: 'threw'` are the only record that anything went
    // wrong, and abandoning after `MAX_THROWS_BEFORE_ABANDON` throws is what
    // keeps a pathological rule from blocking this one process (ADR 0006)
    // for the whole corpus (IMPORTANT-5).
    if (outcome.kind === 'threw') {
      threw += 1;
      results.push({
        fixtureId: fixture.fixtureId,
        label: fixture.label,
        matched: false,
        match: undefined,
        // Never 'agreed': a throw is not the rule behaving correctly, it is
        // the rule not having run at all.
        agreement: 'unlabelled',
        outcome: 'threw',
      });
      if (threw >= MAX_THROWS_BEFORE_ABANDON) break;
      continue;
    }

    const match = outcome.kind === 'match' ? outcome.match : undefined;
    const matched = match !== undefined;
    const agreement =
      fixture.label === 'unlabelled'
        ? ('unlabelled' as const)
        : (fixture.label === 'should_match') === matched
          ? ('agreed' as const)
          : ('disagreed' as const);

    results.push({
      fixtureId: fixture.fixtureId,
      label: fixture.label,
      matched,
      match,
      agreement,
      outcome: 'ok',
    });
  }

  return {
    ruleId: input.rule.ruleId,
    kind: input.rule.kind,
    usable: failure === undefined,
    failure,
    threw,
    corpusSize: ordered.length,
    total: results.length,
    matched: results.filter((r) => r.matched).length,
    // Both tallies exclude fixtures the predicate threw on, for the same
    // reason `agreement` is `'unlabelled'` for them: a throw is not a verdict.
    // `matched` is `false` for a throw, so without this a `should_match`
    // fixture that threw would be counted as a miss it never actually took —
    // and `falseNegatives` reaches `data`, which Slice 6's false-positive
    // gate reads as a *machine*. The CLI text is already protected (it
    // returns on `threw > 0` before printing a summary), which is exactly
    // what would have let a wrong number survive here unnoticed.
    falsePositives: results.filter(
      (r) => r.outcome === 'ok' && r.label === 'should_not_match' && r.matched,
    ).length,
    falseNegatives: results.filter(
      (r) => r.outcome === 'ok' && r.label === 'should_match' && !r.matched,
    ).length,
    results,
  };
};
