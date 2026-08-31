import { englishDataset } from 'obscenity';

export interface SeedPorts {
  addCategory(input: {
    categoryId: string;
    ruleId: string;
    name: string;
    defaultAction: 'log_only' | 'delete' | 'delete_and_case';
  }): void;
  addTerm(input: { termId: string; categoryId: string; text: string }): void;
}

/**
 * ADR 0035: seeds from `obscenity`'s own bundled `englishDataset` — same MIT
 * license as the matcher (Task 4), attributed in `docs/PROVENANCE.md`.
 *
 * `englishDataset`'s type is `DataSet<{ originalWord: EnglishProfaneWord }>`
 * (`node_modules/obscenity/dist/preset/english.d.ts`): every one of its ~69
 * bundled phrases carries `metadata.originalWord` set to the literal
 * readable word (confirmed against the compiled
 * `node_modules/obscenity/dist/preset/english.js`, which calls
 * `.setMetadata({ originalWord: '<word>' })` per phrase). `DataSet` exposes
 * no public getter/iterator for its phrases, but it does expose
 * `removePhrasesIf(predicate)` (`node_modules/obscenity/dist/dataset/DataSet.d.ts`),
 * which visits every phrase and removes it only if the predicate returns
 * `true`. Returning `false` for every phrase makes this a read-only walk in
 * effect — nothing is actually removed from the shared `englishDataset`
 * singleton — while still handing this function each phrase's metadata, the
 * only way to read a literal word back out of the dataset.
 *
 * The result: `word_terms.text` for every seeded row holds the actual
 * readable word (e.g. `'ass'`, `'bitch'`, `'cunt'`), not a placeholder
 * identifier — so a seeded word is, per the design spec (§3), genuinely "no
 * different from adding a new one": readable, searchable, and editable like
 * any guild-added term.
 */
export function seedDefaultWordList(ports: SeedPorts, ruleId: string): void {
  const categoryId = `${ruleId}-default`;
  ports.addCategory({
    categoryId,
    ruleId,
    name: 'default (obscenity englishDataset)',
    defaultAction: 'delete_and_case',
  });

  const words: string[] = [];
  englishDataset.removePhrasesIf((phrase) => {
    if (phrase.metadata?.originalWord !== undefined) {
      words.push(phrase.metadata.originalWord);
    }
    return false; // read-only: never actually remove a phrase
  });

  words.forEach((word, index) => {
    ports.addTerm({ termId: `${categoryId}-${index}`, categoryId, text: word });
  });
}
