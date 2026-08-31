import { RegExpMatcher, englishRecommendedTransformers, parseRawPattern } from 'obscenity';

/**
 * Zero-width and invisible formatting characters, stripped before matching.
 *
 * `obscenity`'s transformers handle leetspeak, homoglyphs, and stretched or
 * spaced-out letters (ADR 0035) — this is the one evasion class Bananasaurs'
 * own code closes. `\p{Cf}` is the Unicode "format" category: zero-width
 * space/non-joiner/joiner, the byte-order mark, and the rest of the class
 * inserted mid-word specifically to break substring matching.
 */
export function stripZeroWidth(text: string): string {
  return text.replace(/\p{Cf}/gu, '');
}

export interface AutomodMatcher {
  /**
   * `undefined` means no configured term matched. `match()` normalizes
   * zero-width characters itself, so pre-stripping is a caller convenience,
   * not a requirement.
   */
  match(content: string): { categoryId: string; snippet: string } | undefined;
}

/**
 * One matcher per guild, built from that guild's own word_terms and
 * word_allowlist — not the obscenity English dataset (ADR 0035: that seeds
 * the initial word list on first migration, via a separate seeding step,
 * but the running matcher only ever reflects what is actually in
 * word_terms/word_categories, so removing a seeded word really removes it).
 *
 * `obscenity`'s `pattern` export is a tagged template (`` pattern`literal` ``)
 * that concatenates its string parts (including any interpolated
 * expressions) and parses the result — it has no call signature that takes a
 * plain string or string array. Guild-configured terms are runtime data, not
 * source-level literals, so this uses `parseRawPattern(text)` instead, which
 * is the same parser exposed as a plain function for exactly this case (see
 * `obscenity`'s own doc comment: "recommended to use the pattern template tag
 * ... for literal patterns [without dynamic content]" — `parseRawPattern` is
 * the non-literal counterpart).
 */
export function buildMatcher(
  terms: readonly { text: string; categoryId: string }[],
  allowlist: readonly string[],
): AutomodMatcher {
  const categoryByTermId = new Map<number, string>();
  const blacklistedTerms = terms.map((term, id) => {
    categoryByTermId.set(id, term.categoryId);
    return { id, pattern: parseRawPattern(term.text) };
  });

  const matcher = new RegExpMatcher({
    blacklistedTerms,
    whitelistedTerms: [...allowlist],
    ...englishRecommendedTransformers,
  });

  return {
    match(content) {
      // Defense in depth: obscenity's recommended transformers do not strip
      // zero-width characters (skipNonAlphabeticTransformer is deliberately
      // excluded from the preset upstream — jo3-l/obscenity#23, #46 — because
      // it produces false negatives on the multi-word English dataset). A
      // caller in the real pipeline (Task 9) is expected to call
      // `stripZeroWidth` before `match()`, but `match()` normalizes again
      // here so its behavior does not depend on the caller remembering to.
      const normalized = stripZeroWidth(content);
      // sorted: true — deterministic, leftmost-first, so the reported
      // snippet is always the earliest match rather than whatever order the
      // underlying regex engine happened to produce.
      const matches = matcher.getAllMatches(normalized, true);
      if (matches.length === 0) return undefined;
      const first = matches[0]!;
      return {
        categoryId: categoryByTermId.get(first.termId) ?? 'unknown',
        snippet: normalized.slice(first.startIndex, first.endIndex + 1),
      };
    },
  };
}
