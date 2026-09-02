import { keywordFilterPredicate } from './keyword-filter.js';
import {
  isRuleKind,
  type AnyPredicate,
  type AutomodRule,
  type CompiledPredicate,
  type RuleKind,
} from './types.js';

/**
 * kind → predicate. Slices 3-5 each add an entry and change nothing else —
 * which is what ADR 0035 promised and ADR 0040 actually delivers.
 *
 * Nine of the ten kinds `mod_rules_kind` permits are absent until their slice
 * ships. A rule naming one of them is inert, and `compileRule` reports
 * `'no-predicate'` so `doctor` can say so out loud rather than the rule
 * quietly never firing (ADR 0040 §4 — the ADR 0039 failure mode).
 */
const PREDICATES: Partial<Record<RuleKind, AnyPredicate>> = {
  keyword_filter: keywordFilterPredicate,
};

export const predicateFor = (kind: string): AnyPredicate | undefined =>
  isRuleKind(kind) ? PREDICATES[kind] : undefined;

export type CompileFailure =
  /** A `kind` the CHECK should have rejected — a hand-edited row, or a schema drift. */
  | 'unknown-kind'
  /** A permitted kind whose predicate has not shipped yet. */
  | 'no-predicate'
  /** `config` is not JSON, or fails its kind's Zod schema. */
  | 'invalid-config'
  /** The predicate's own `compile` threw — an invalid regex, an unparseable term. */
  | 'compile-failed'
  /**
   * A `keyword_filter` rule whose word list has no enabled terms.
   *
   * `buildMatcher([], [])` compiles cleanly — an empty blacklist is a valid
   * `RegExpMatcher` — so this is not a `compile-failed`. It is the same shape
   * of failure ADR 0039 spent a slice on: a rule that looks configured and
   * can never match. "Cannot be compiled" is a strict subset of "cannot ever
   * match"; this closes the gap between them (ADR 0040 §4, review IMPORTANT-2).
   */
  | 'no-terms';

export type CompileResult =
  | { readonly ok: true; readonly compiled: CompiledPredicate }
  | { readonly ok: false; readonly reason: CompileFailure; readonly detail: string };

/**
 * Validates a rule's config against its kind's schema and compiles it, or says
 * exactly why it could not.
 *
 * Never throws. A rule that cannot be compiled must not take down the
 * subscriber, because that would stop every *other* rule in the guild from
 * matching — but it must not be silent either. The caller logs it once per
 * fingerprint and `doctor` reports it (ADR 0040 §4).
 */
export const compileRule = (rule: AutomodRule): CompileResult => {
  if (!isRuleKind(rule.kind)) {
    return { ok: false, reason: 'unknown-kind', detail: rule.kind };
  }
  const predicate = PREDICATES[rule.kind];
  if (predicate === undefined) {
    return { ok: false, reason: 'no-predicate', detail: rule.kind };
  }

  let config: unknown;
  try {
    // Parsed and validated on the way *out* of the database, not only on the
    // way in (CLAUDE.md rule 3, ADR 0037's `jobs.payload` precedent): a row
    // written by an older schema version, or by hand in `sqlite3`, is exactly
    // what this catches.
    config = predicate.config.parse(JSON.parse(rule.config));
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid-config',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // A `keyword_filter` rule whose last enabled term (or category) was just
  // removed has valid, empty config and compiles to a matcher that can never
  // fire. Checked here, against the hydrated word list, because it cannot be
  // caught by validating `config` above — the word list is not in `config`
  // (ADR 0040 §3) — and `predicate.compile` below has no reason to throw on
  // an empty term list, which is correct behaviour for `buildMatcher` itself.
  if (rule.kind === 'keyword_filter' && rule.terms.length === 0) {
    return {
      ok: false,
      reason: 'no-terms',
      detail: 'no enabled terms in this rule; it can never match a message',
    };
  }

  try {
    return { ok: true, compiled: predicate.compile(rule, config) };
  } catch (err) {
    return {
      ok: false,
      reason: 'compile-failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
};
