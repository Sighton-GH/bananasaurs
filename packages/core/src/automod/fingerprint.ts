import { createHash } from 'node:crypto';
import type { AutomodRule } from './predicates/types.js';

/**
 * Fields on `AutomodRule` deliberately left out of the digest.
 *
 * `ruleId` is already in the subscriber's cache key
 * (`${guildId}:${ruleId}`), so hashing it too would be redundant, not wrong —
 * excluded anyway so the digest is exactly "what `compile` reads". `mode` is
 * excluded because it decides what the subscriber *does* with a match, not
 * what the predicate matches: a flip-day mode change must not throw away
 * every compiled matcher in the guild at the moment that would be most
 * expensive to rebuild them.
 *
 * Everything else on `AutomodRule` is hashed, by construction (see below) —
 * this set is the only place a field can opt out, and opting out is meant to
 * read as a deliberate act.
 */
const EXCLUDED_FIELDS: ReadonlySet<string> = new Set(['ruleId', 'mode']);

/**
 * Canonicalises one field's value before it is hashed.
 *
 * `terms` and `allowlist` need sorting: `hydrate` queries terms per category,
 * so their order tracks category order, which no caller controls, and an
 * order change is not a rule change. Everything else is a scalar (`kind`,
 * `config`, and any future field ADR 0040 §3 adds in the same shape) and
 * needs no treatment beyond `JSON.stringify`'s own.
 */
const canonicalise = (key: string, value: unknown): unknown => {
  if (key === 'terms' && Array.isArray(value)) {
    return (value as readonly { text: string; categoryId: string }[])
      .map((term) => [term.categoryId, term.text] as const)
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  }
  if (key === 'allowlist' && Array.isArray(value)) {
    return [...(value as readonly string[])].sort((a, b) => a.localeCompare(b));
  }
  return value;
};

/**
 * A digest of everything `Predicate.compile` reads, and nothing else (ADR 0040 §5).
 *
 * The subscriber caches a compiled artifact beside this digest and recompiles
 * when it changes. That is what makes a term edit take effect on the next
 * message instead of on the next daemon restart — the gap `subscriber.ts` has
 * carried since ADR 0035, which ADR 0039 made sharper by deriving the
 * matcher's collapse thresholds from the word list too.
 *
 * **Exclusion-based, not enumerated.** ADR 0040 §3 already commits a later
 * slice to a *relational* allowlist field for `invite` and `link_domain`; a
 * digest that hand-lists `{kind, config, terms, allowlist}` would not hash
 * that field, the compiled artifact would go stale, and the exact
 * silent-non-matching bug this slice exists to kill would come back for those
 * predicates. So this builds the hashed object by iterating `rule`'s own
 * keys, sorted, and skipping only `EXCLUDED_FIELDS` — a field added to
 * `AutomodRule` later is hashed by default, and *omitting* one is the
 * deliberate act, made by adding it to `EXCLUDED_FIELDS` with a reason.
 *
 * **Serialisation.** `JSON.stringify` over a canonical structure, not a
 * delimiter join. A join needs a separator that cannot appear in the data, and
 * no such character exists in a user-supplied term — `docs/22` records a test
 * in this repository that existed to guard a separator and could not detect
 * its own failure. `JSON.stringify` escapes its own delimiters, so
 * `["ab","cd"]` and `["ab cd"]` are different strings by construction,
 * and a test above pins that.
 *
 * Sorting the *keys themselves* (not just `terms`/`allowlist`'s contents)
 * means the digest does not depend on the order `AutomodRule`'s properties
 * happen to be declared or constructed in.
 */
export const ruleFingerprint = (rule: AutomodRule): string => {
  const record = rule as unknown as Record<string, unknown>;
  const hashed: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (EXCLUDED_FIELDS.has(key)) continue;
    hashed[key] = canonicalise(key, record[key]);
  }

  return createHash('sha256').update(JSON.stringify(hashed)).digest('hex');
};
