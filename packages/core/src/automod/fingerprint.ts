import { createHash } from 'node:crypto';
import type { AutomodRule } from './predicates/types.js';

/**
 * A digest of everything `Predicate.compile` reads, and nothing else (ADR 0040 §5).
 *
 * The subscriber caches a compiled artifact beside this digest and recompiles
 * when it changes. That is what makes a term edit take effect on the next
 * message instead of on the next daemon restart — the gap `subscriber.ts` has
 * carried since ADR 0035, which ADR 0039 made sharper by deriving the
 * matcher's collapse thresholds from the word list too.
 *
 * `mode` is deliberately excluded: it decides what the subscriber does with a
 * match, not what the predicate matches.
 *
 * **Serialisation.** `JSON.stringify` over a canonical structure, not a
 * delimiter join. A join needs a separator that cannot appear in the data, and
 * no such character exists in a user-supplied term — `docs/22` records a test
 * in this repository that existed to guard a separator and could not detect
 * its own failure. `JSON.stringify` escapes its own delimiters, so
 * `["ab","cd"]` and `["ab cd"]` are different strings by construction,
 * and a test above pins that.
 *
 * Sorted because `hydrate` queries terms per category: their order tracks
 * category order, which no caller controls, and an order change is not a rule
 * change.
 */
export const ruleFingerprint = (rule: AutomodRule): string => {
  const terms = rule.terms
    .map((term) => [term.categoryId, term.text] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const allowlist = [...rule.allowlist].sort((a, b) => a.localeCompare(b));

  return createHash('sha256')
    .update(JSON.stringify({ kind: rule.kind, config: rule.config, terms, allowlist }))
    .digest('hex');
};
