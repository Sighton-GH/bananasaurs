import { describe, expect, it, vi } from 'vitest';
import { englishDataset } from 'obscenity';
import { buildMatcher } from './matcher.js';
import { seedDefaultWordList, type SeedPorts } from './seed.js';

/**
 * Collects everything a seeding run would write, and builds the matcher the
 * live subscriber would build from it — the only way to test what the seed
 * actually does to a guild, as opposed to how many rows it inserts.
 */
const seedIntoMatcher = () => {
  const terms: { text: string; categoryId: string }[] = [];
  const allowlist: string[] = [];
  const ports: SeedPorts = {
    addCategory: () => undefined,
    addTerm: (input) => terms.push({ text: input.text, categoryId: input.categoryId }),
    addAllowlistPhrase: (input) => allowlist.push(input.phrase),
  };
  seedDefaultWordList(ports, 'r1');
  return { terms, allowlist, matcher: buildMatcher(terms, allowlist) };
};

describe('seedDefaultWordList', () => {
  it('adds one category and at least one term from the bundled dataset', () => {
    const addCategory = vi.fn();
    const addTerm = vi.fn();
    seedDefaultWordList({ addCategory, addTerm, addAllowlistPhrase: vi.fn() }, 'r1');

    expect(addCategory).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 'r1', defaultAction: 'delete_and_case' }),
    );
    expect(addTerm.mock.calls.length).toBeGreaterThan(0);
  });

  it("carries over obscenity's own whitelisted terms, deduplicated", () => {
    const { allowlist } = seedIntoMatcher();

    // The `ass` phrase alone ships a dozen of these upstream.
    expect(allowlist).toContain('assess');
    expect(allowlist).toContain('asset');
    // 'assi' is the prefix that covers assignment/assistance/assist upstream.
    expect(allowlist).toContain('assi');
    expect(allowlist).toContain('analy');
    // `word_allowlist`'s primary key is (guild_id, rule_id, phrase), and the
    // upstream dataset really does repeat a term ('lan al' appears twice on
    // the `anal` phrase), so an un-deduplicated seed would throw on insert.
    expect(new Set(allowlist).size).toBe(allowlist.length);
  });

  /**
   * The regression this test exists for: the first version of this seed
   * harvested only `metadata.originalWord` and threw away both of the things
   * that make obscenity's own dataset usable — the word-boundary anchors on
   * its patterns and its per-phrase whitelisted terms. The result was an
   * unanchored bare-word substring match that flagged every one of these as
   * profanity in the *shipped default rule*.
   */
  it('does not match ordinary English', () => {
    const { matcher } = seedIntoMatcher();

    const ordinary = [
      'welcome to the class',
      'your assignment is due',
      'I need assistance',
      'the analysis was thorough',
      'documentation',
      'he is from Massachusetts',
      // Same failure class, found while verifying the fix against the real
      // package: all of these matched the old seed too.
      'we should assess the assets',
      'the canal boat',
      'please reset your password',
      'a compass and a passport',
      'the title of the document',
      'cocktails at the reception',
      'circumstances accumulate',
    ];

    for (const text of ordinary) {
      expect(matcher.match(text), `expected no match in: ${text}`).toBeUndefined();
    }
  });

  it('still matches real profanity in a plain sentence', () => {
    const { matcher } = seedIntoMatcher();

    for (const text of [
      'you are an ass',
      'what the fuck is this',
      'go fuck yourself',
      'stop being a dick',
      'that bitch again',
    ]) {
      expect(matcher.match(text), `expected a match in: ${text}`).toBeDefined();
    }
  });

  /**
   * `englishRecommendedTransformers` collapses repeated letters in the input
   * before matching (threshold 1, except b/e/o/l/s/g), which is why
   * obscenity's own patterns are written `|trany` and `bas[s]tard`. A seeded
   * term holding the raw doubled spelling can therefore never match anything
   * — four of the sixty-nine seeded words were dead on arrival.
   */
  it('seeds every dataset word in a form that still matches that word', () => {
    const { terms, matcher } = seedIntoMatcher();
    expect(terms.length).toBeGreaterThan(60);

    const words: string[] = [];
    englishDataset.removePhrasesIf((phrase) => {
      if (phrase.metadata?.originalWord !== undefined) words.push(phrase.metadata.originalWord);
      return false;
    });
    expect(terms).toHaveLength(words.length);

    for (const word of words) {
      expect(matcher.match(word), `seeded word does not match itself: ${word}`).toBeDefined();
    }
  });
});
