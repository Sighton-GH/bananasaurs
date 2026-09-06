import { z } from 'zod';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

/**
 * Fenced blocks first, then inline spans (plan ruling PR-17).
 *
 * Order matters: an inline-span pattern run first would eat the ``` fences
 * from the inside out and leave the block's contents behind, which is the
 * opposite of the intent.
 */
const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;

export const capsConfig = z
  .object({
    /**
     * Below this many characters the rule does not fire at all. The spec
     * requires a floor: 'OK' is 100% capitals and is not shouting.
     */
    minLength: z.number().int().min(1).max(4_000),
    /** Fires when the ratio of upper-case letters to letters exceeds this. */
    maxRatio: z.number().gt(0).lte(1),
  })
  .strict();

export type CapsConfig = z.infer<typeof capsConfig>;

export const capsPredicate: Predicate<CapsConfig> = {
  kind: 'caps',
  config: capsConfig,
  compile(_rule: AutomodRule, config: CapsConfig): CompiledPredicate {
    return {
      evaluate(input) {
        // Code is not shouting (plan ruling PR-17) — one of the three
        // false-positive sources the spec names for this predicate.
        const prose = input.content.replace(FENCED_CODE, ' ').replace(INLINE_CODE, ' ');
        if (prose.length < config.minLength) return undefined;

        // Measured against letters, not against every character: otherwise
        // punctuation and digits dilute the ratio and a longer shout scores
        // lower than a short one.
        const letters = [...prose].filter((c) => /\p{L}/u.test(c));
        if (letters.length === 0) return undefined;
        const upper = letters.filter((c) => /\p{Lu}/u.test(c)).length;
        const ratio = upper / letters.length;
        if (ratio <= config.maxRatio) return undefined;

        return {
          categoryId: 'caps',
          // The whole message is the evidence; there is no span to point at.
          snippet: input.content.slice(0, 200),
          trace: {
            kind: 'caps',
            matchedOn: `ratio > ${config.maxRatio}`,
            // A property of the whole message, not a span of it — the case
            // `MatchTrace.span` documents as `undefined`.
            span: undefined,
            normalisations: ['zero-width stripped', 'code spans removed'],
            detail: {
              ratio: Number(ratio.toFixed(3)),
              letters: letters.length,
              upper,
              minLength: config.minLength,
              maxRatio: config.maxRatio,
            },
          },
        };
      },
    };
  },
};
