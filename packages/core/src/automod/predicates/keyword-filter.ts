import { z } from 'zod';
import { buildMatcher } from '../matcher.js';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

/**
 * `keyword_filter` has no scalar configuration, and ADR 0040 says it stays
 * that way: a word list is list-shaped data an operator edits item by item,
 * which is what `word_categories` / `word_terms` / `word_allowlist` are for.
 * The false-positive workflow (Slice 9) allowlists an *individual term*, and
 * rows are the right shape for that where a JSON array is not.
 *
 * `.strict()` rather than a bare object, so a config written against the wrong
 * kind — `{"ratio":0.7}` on a keyword filter — is a validation error the
 * operator sees rather than a field silently ignored.
 */
export const keywordFilterConfig = z.object({}).strict();
export type KeywordFilterConfig = z.infer<typeof keywordFilterConfig>;

/**
 * The first `Predicate` (ADR 0040). Behaviour is unchanged from the subscriber's
 * inline matching — `buildMatcher` moved behind `compile`, `match` behind
 * `evaluate` — and `matcher.test.ts` plus `subscriber.test.ts` staying green,
 * unmodified, is the proof.
 */
export const keywordFilterPredicate: Predicate<KeywordFilterConfig> = {
  kind: 'keyword_filter',
  config: keywordFilterConfig,
  compile(rule: AutomodRule): CompiledPredicate {
    const matcher = buildMatcher(rule.terms, rule.allowlist);
    return {
      evaluate(input) {
        // `match()` strips zero-width characters itself; `input.content` has
        // already been stripped by the subscriber. Both, deliberately — the
        // matcher's own doc comment records that its behaviour must not depend
        // on the caller remembering.
        const hit = matcher.match(input.content);
        if (hit === undefined) return undefined;

        // Recovered rather than returned by `match()`, because `AutomodMatcher`
        // is also used directly by `matcher.test.ts` and widening its return
        // type would churn that. `indexOf` on the already-normalised content
        // is exact here: `snippet` was produced by slicing that same string.
        const start = input.content.indexOf(hit.snippet);
        const span: readonly [number, number] | undefined =
          start === -1 ? undefined : [start, start + hit.snippet.length];

        return {
          categoryId: hit.categoryId,
          snippet: hit.snippet,
          trace: {
            kind: 'keyword_filter',
            matchedOn: hit.snippet,
            span,
            normalisations: [
              'zero-width stripped',
              'confusables resolved',
              'leetspeak resolved',
              'lowercased',
              'duplicate letters collapsed (thresholds from the word list, ADR 0039)',
            ],
            detail: {
              categoryId: hit.categoryId,
              termCount: rule.terms.length,
              allowlistSize: rule.allowlist.length,
            },
          },
        };
      },
    };
  },
};
