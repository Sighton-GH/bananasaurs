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
 * order change is not a rule change. `inviteAllowlist` and `linkDomains` need
 * the same treatment for the same reason — `hydrate` reads them with a query
 * ordered by `code`/`domain`, which is belt and braces, not a substitute for
 * this: the digest must not depend on the query plan either. Everything else
 * is a scalar (`kind`, `config`) and needs no treatment beyond
 * `JSON.stringify`'s own.
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
  if (key === 'inviteAllowlist' && Array.isArray(value)) {
    return (value as readonly { code: string; label: string }[])
      .map((entry) => [entry.code, entry.label] as const)
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  }
  if (key === 'linkDomains' && Array.isArray(value)) {
    // `listType` is part of the sort key, not just carried along: a domain
    // moving from allow to deny at the same list position must produce a
    // different canonical structure, not the same one in a different order.
    return (value as readonly { domain: string; listType: 'allow' | 'deny' }[])
      .map((entry) => [entry.domain, entry.listType] as const)
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
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
 * **Exclusion-based, not enumerated.** ADR 0040 §3 committed an earlier slice
 * to *relational* allowlist fields for `invite` and `link_domain` —
 * `inviteAllowlist` and `linkDomains`, added to `AutomodRule` in Task 6 — and
 * this is exactly why the digest is built this way rather than hand-listing
 * `{kind, config, terms, allowlist}`: that would not have hashed the two new
 * fields, the compiled artifact would go stale, and the exact silent-
 * non-matching bug this slice exists to kill would come back for those two
 * predicates (obligation 2 of the slices 3-5 handoff, verified by a test that
 * was watched failing with `inviteAllowlist` added to `EXCLUDED_FIELDS` and
 * then restored). So this builds the hashed object by iterating `rule`'s own
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
