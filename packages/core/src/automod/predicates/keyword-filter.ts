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
 * The first `Predicate` (ADR 0040). Matching behaviour is unchanged from the
 * subscriber's inline matching — `buildMatcher` moved behind `compile`,
 * `match` behind `evaluate` — and `subscriber.test.ts` staying green,
 * unmodified, is the proof. `AutomodMatcher.match()`'s *return shape* did
 * widen (fix round 1): it now reports the configured term text and the raw
 * match span alongside the category, so this predicate's trace can name the
 * term Slice 9 suppression needs rather than the possibly-evasive snippet
 * that matched, and can point at the actual matched occurrence rather than
 * the first occurrence of that snippet's text anywhere in the message.
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

        return {
          categoryId: hit.categoryId,
          snippet: hit.snippet,
          trace: {
            kind: 'keyword_filter',
            // The *configured* term, not the matched (possibly evasive)
            // spelling: Slice 9's one-click suppression allowlists this
            // value, and allowlisting `b@dw0rd` while `badword` still
            // matched everything else would be a suppression that looked
            // like it worked and had not.
            matchedOn: hit.termText,
            // `AutomodMatchResult.endIndex` is inclusive (obscenity's own
            // convention); `+ 1` makes this the half-open `[start, end)`
            // `MatchTrace.span` promises.
            span: [hit.startIndex, hit.endIndex + 1],
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
