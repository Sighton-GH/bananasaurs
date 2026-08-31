import {
  englishDataset,
  englishRecommendedTransformers,
  RegExpMatcher,
  type ParsedPattern,
} from 'obscenity';

export interface SeedPorts {
  addCategory(input: {
    categoryId: string;
    ruleId: string;
    name: string;
    defaultAction: 'log_only' | 'delete' | 'delete_and_case';
  }): void;
  addTerm(input: { termId: string; categoryId: string; text: string }): void;
  /**
   * `word_allowlist`, wired into obscenity's own whitelist at match time
   * (`matcher.ts`). Seeded from the dataset's per-phrase whitelisted terms:
   * without them the seeded list is not obscenity's list, it is a
   * substring-match caricature of it.
   */
  addAllowlistPhrase(input: { ruleId: string; phrase: string }): void;
}

/**
 * `collapseDuplicatesTransformer`'s thresholds from
 * `englishRecommendedBlacklistMatcherTransformers`, read out of the installed
 * package (`node_modules/obscenity/dist/preset/english.js`).
 *
 * The transformer rewrites the *input* before matching, so `'buttplug'`
 * reaches the matcher as `'butplug'` and a pattern spelled `buttplug` can
 * never fire. That is why obscenity's own patterns are written `|trany` and
 * `bas[s]tard` rather than `tranny` and `bastard`. Four of the sixty-nine
 * seeded words (`buttplug`, `jerk off`, `jizz`, `tranny`) were dead on
 * arrival for exactly this reason before `collapseRepeats` below existed.
 */
const COLLAPSE_THRESHOLDS = new Map([
  ['b', 2],
  ['e', 2],
  ['o', 2],
  ['l', 2],
  ['s', 2],
  ['g', 2],
]);

/** The same collapse the matcher will apply to the input, applied to the term. */
function collapseRepeats(word: string): string {
  let out = '';
  let previous = '';
  let run = 0;
  for (const char of word) {
    run = char === previous ? run + 1 : 1;
    previous = char;
    if (run <= (COLLAPSE_THRESHOLDS.get(char) ?? 1)) out += char;
  }
  return out;
}

const ASCII_LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

/**
 * Whether this phrase's own patterns still match `word` when a word character
 * is glued to its start / its end.
 *
 * This is how the seeded term recovers the word-boundary behaviour that
 * `metadata.originalWord` throws away. A phrase's patterns are not the word:
 * `fuck` ships as `f[?]ck`, `|fk`, `|fu|`, `|fuk`, so reading
 * `requireWordBoundaryAtStart` off them says nothing useful about the string
 * `'fuck'`. Asking the real matcher what it does to `'zfuck'` and `'fuckz'`
 * does — and it is verified against the installed package rather than
 * inferred from its grammar.
 *
 * Every ASCII letter is probed, not one, because several phrases enumerate
 * the letters they will accept in front of the word: `anal` ships `|anal`
 * plus `danal`, `eanal`, `fanal`, … deliberately omitting `banal` and
 * `canal`. "Some letters match and some do not" cannot be expressed by a
 * single anchored term, so it resolves to the anchored — lower false
 * positive — side.
 */
function needsBoundaries(
  patterns: readonly ParsedPattern[],
  word: string,
): {
  start: boolean;
  end: boolean;
} {
  const matcher = new RegExpMatcher({
    blacklistedTerms: patterns.map((pattern, id) => ({ id, pattern })),
    whitelistedTerms: [],
    ...englishRecommendedTransformers,
  });
  return {
    start: !ASCII_LETTERS.every((letter) => matcher.hasMatch(letter + word)),
    end: !ASCII_LETTERS.every((letter) => matcher.hasMatch(word + letter)),
  };
}

/**
 * ADR 0035: seeds from `obscenity`'s own bundled `englishDataset` — same MIT
 * license as the matcher (Task 4), attributed in `docs/PROVENANCE.md`.
 *
 * `englishDataset`'s type is `DataSet<{ originalWord: EnglishProfaneWord }>`
 * (`node_modules/obscenity/dist/preset/english.d.ts`): every one of its ~69
 * bundled phrases carries `metadata.originalWord` set to the literal
 * readable word. `DataSet` exposes no public getter/iterator for its phrases,
 * but it does expose `removePhrasesIf(predicate)`
 * (`node_modules/obscenity/dist/dataset/DataSet.d.ts`), which visits every
 * phrase and removes it only if the predicate returns `true`. Returning
 * `false` for every phrase makes this a read-only walk in effect — nothing is
 * actually removed from the shared `englishDataset` singleton — while still
 * handing this function each `PhraseContainer`.
 *
 * **What the first version of this function got wrong.** It read only
 * `metadata.originalWord` off that container and ignored the other two fields
 * sitting right beside it — `patterns` and `whitelistedTerms`. The seeded
 * rule therefore matched a bare, unanchored substring with none of
 * obscenity's own exceptions, and the *shipped default rule* flagged
 * `class`, `assignment`, `assistance`, `analysis`, `documentation` and
 * `Massachusetts` as profanity. Three things fix that, all of them read from
 * the same container:
 *
 *  1. `whitelistedTerms` is seeded into `word_allowlist`, so obscenity's own
 *     ~64 exceptions (`assess`, `asset`, `assi`, `analy`, `cockney`, …)
 *     apply to the seeded list exactly as they do upstream. Deduplicated,
 *     because the dataset repeats one (`'lan al'`) and `word_allowlist`'s
 *     primary key includes the phrase.
 *  2. Word-boundary anchors are restored empirically (`needsBoundaries`) and
 *     written using obscenity's own `|` boundary-assertion syntax, which
 *     `parseRawPattern` — the parser the live matcher uses on
 *     `word_terms.text` — reads as "assert a word boundary here".
 *  3. Repeated letters are collapsed the way the transformer will collapse
 *     the input (`collapseRepeats`).
 *
 * A word that needs a boundary at its end also accepts an optional trailing
 * `s` (`|tit[s]|`), so full anchoring does not silently stop matching the
 * plural of a slur. `[…]` is obscenity's optional-expression syntax, from the
 * same grammar as `|`.
 *
 * **Known limitation.** One readable term per phrase cannot reproduce a
 * phrase that ships several patterns: `nigga` (a pattern of its own upstream)
 * is not matched by the seeded `nigger`, and `cocksucker` is not matched by
 * the fully anchored `|cock[s]|`. Measured against the 74k-word system
 * dictionary the seeded list matches 197 words where obscenity's own dataset
 * matches 223, so it is a *narrower* filter than upstream, not a wider one —
 * which is the correct direction for a default an owner tunes afterwards.
 * `word_terms.text` stays readable and editable (spec §3): a term is a word
 * with at most a leading/trailing `|` and an optional `[s]`.
 */
export function seedDefaultWordList(ports: SeedPorts, ruleId: string): void {
  const categoryId = `${ruleId}-default`;
  ports.addCategory({
    categoryId,
    ruleId,
    name: 'default (obscenity englishDataset)',
    defaultAction: 'delete_and_case',
  });

  const terms: string[] = [];
  const allowlist = new Set<string>();
  englishDataset.removePhrasesIf((phrase) => {
    for (const term of phrase.whitelistedTerms) allowlist.add(term);

    const word = phrase.metadata?.originalWord;
    if (word !== undefined) {
      const { start, end } = needsBoundaries(phrase.patterns, word);
      const plural = end && !word.endsWith('s') ? '[s]' : '';
      terms.push(`${start ? '|' : ''}${collapseRepeats(word)}${plural}${end ? '|' : ''}`);
    }
    return false; // read-only: never actually remove a phrase
  });

  terms.forEach((text, index) => {
    ports.addTerm({ termId: `${categoryId}-${index}`, categoryId, text });
  });
  for (const phrase of allowlist) ports.addAllowlistPhrase({ ruleId, phrase });
}
