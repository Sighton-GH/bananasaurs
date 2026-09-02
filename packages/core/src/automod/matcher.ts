import {
  RegExpMatcher,
  collapseDuplicatesTransformer,
  englishRecommendedWhitelistMatcherTransformers,
  parseRawPattern,
  resolveConfusablesTransformer,
  resolveLeetSpeakTransformer,
  toAsciiLowerCaseTransformer,
} from 'obscenity';

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

/**
 * `obscenity`'s own six hand-tuned exceptions
 * (`node_modules/obscenity/dist/preset/english.js`), each one there because a
 * specific word in `obscenity`'s *bundled* dataset needs it (the source
 * comments name the word: `['s', 2], // a_ss_`, `['g', 2], // ni_gg_er`).
 * Kept as the floor `collapseThresholdsFor` unions with below, so a
 * guild's own terms never lose ground `obscenity` already covered.
 */
const OBSCENITY_BUILTIN_COLLAPSE_THRESHOLDS: ReadonlyMap<string, number> = new Map([
  ['b', 2],
  ['e', 2],
  ['o', 2],
  ['l', 2],
  ['s', 2],
  ['g', 2],
]);

/**
 * ADR 0039. `collapseDuplicatesTransformer` collapses runs of a repeated
 * character in the *matched input* down to `defaultThreshold` (1, i.e. no
 * doubling survives) unless the character has a custom threshold — but the
 * compiled pattern (`parseRawPattern(term.text)`) is never transformed. A
 * configured term with a doubled letter outside
 * `OBSCENITY_BUILTIN_COLLAPSE_THRESHOLDS` therefore could never match, at any
 * stretch, including its own exact literal spelling: `"spammer"` normalizes
 * to `"spamer"` on the input side while the pattern still requires the
 * literal `"spammer"`.
 *
 * The fix: any letter that appears doubled in any configured term also gets
 * threshold 2, unioned with `obscenity`'s six. This is exactly what
 * `obscenity` did by hand for its own dataset, automated for arbitrary
 * user-supplied terms.
 *
 * **Scope: ASCII `a`–`z` only — deliberately, not digits, punctuation, or
 * non-ASCII characters.** Two independent reasons, not an oversight:
 *
 * 1. This threshold map is consumed by `collapseDuplicatesTransformer`
 *    *after* `resolveConfusablesTransformer`, `resolveLeetSpeakTransformer`
 *    and `toAsciiLowerCaseTransformer` have already run on the input stream
 *    (see the transformer order in `buildMatcher` below — it matters). By the
 *    time collapsing happens, non-ASCII confusables and leetspeak digit
 *    substitutions have already been folded into their ASCII-letter
 *    equivalents, so a threshold keyed on a raw non-ASCII character from a
 *    term's source text would never be looked up against anything in the
 *    transformed stream — the character it was keyed on no longer appears
 *    there.
 * 2. The problem this exists to fix — evasion-by-stretching of an ordinary
 *    English word — is a letters-only phenomenon in practice. Extending the
 *    same derivation to digits or punctuation is a real but separate
 *    question (ADR 0039): those characters interact with leetspeak
 *    resolution differently, and handling them speculatively risks quietly
 *    relaxing collapsing for characters no configured term actually needs
 *    relaxed, which is exactly the trade ADR 0039 is trying to keep small.
 *
 * Case-folded before scanning (`toLowerCase()`) because the transformed
 * input stream this feeds is already lowercased by
 * `toAsciiLowerCaseTransformer`.
 */
export function collapseThresholdsFor(terms: readonly string[]): Map<string, number> {
  const thresholds = new Map(OBSCENITY_BUILTIN_COLLAPSE_THRESHOLDS);
  for (const term of terms) {
    const lower = term.toLowerCase();
    for (let i = 1; i < lower.length; i++) {
      const ch = lower[i]!;
      if (ch === lower[i - 1] && ch >= 'a' && ch <= 'z') {
        thresholds.set(ch, 2);
      }
    }
  }
  return thresholds;
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
    // Spelled out explicitly, in the same order
    // `englishRecommendedBlacklistMatcherTransformers` uses, rather than
    // spread from the preset (ADR 0039): the last stage is
    // `collapseThresholdsFor(terms.map((t) => t.text))` instead of the
    // preset's fixed six-entry map. Order matters here — collapsing must run
    // after confusable resolution, leetspeak resolution, and case-folding,
    // on the same character stream those stages produce.
    blacklistMatcherTransformers: [
      resolveConfusablesTransformer(),
      resolveLeetSpeakTransformer(),
      toAsciiLowerCaseTransformer(),
      collapseDuplicatesTransformer({
        defaultThreshold: 1,
        customThresholds: collapseThresholdsFor(terms.map((term) => term.text)),
      }),
    ],
    // Unchanged from the preset (ADR 0039): the whitelist side already uses
    // an infinite default threshold, so no letter is ever collapsed there —
    // an allowlisted term with a doubled letter has no equivalent bug. Uses
    // the concrete array export rather than
    // `englishRecommendedTransformers.whitelistMatcherTransformers` — the
    // latter is typed as `TransformerContainer[] | undefined` (a `Pick` over
    // `RegExpMatcherOptions`'s optional fields), which
    // `exactOptionalPropertyTypes` then rejects here.
    whitelistMatcherTransformers: englishRecommendedWhitelistMatcherTransformers,
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
