import { z } from 'zod';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

/** `<:name:id>` and the animated `<a:name:id>`. Ordinary text to a grapheme counter. */
const CUSTOM_EMOJI = /<a?:[A-Za-z0-9_]{2,32}:\d{17,20}>/g;

/**
 * What counts as one emoji, given a single grapheme.
 *
 * `\p{Extended_Pictographic}` alone is not enough, and this is measured, not
 * cautious: on this Node a regional-indicator flag (`🇬🇧`), a keycap (`1️⃣`)
 * and `#️⃣` are each exactly one grapheme and each score **zero**
 * pictographic characters. A pictographic-only counter silently under-counts
 * every flag and every keycap in the message.
 */
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;
const KEYCAP = /⃣/u;

/**
 * Created once at module load rather than per evaluation: constructing a
 * segmenter is not free and it holds no per-call state.
 */
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

export const emojiConfig = z
  .object({
    /** Fires when the message carries more than this many emoji. */
    maxCount: z.number().int().min(1).max(200),
  })
  .strict();

export type EmojiConfig = z.infer<typeof emojiConfig>;

export const emojiPredicate: Predicate<EmojiConfig> = {
  kind: 'emoji',
  config: emojiConfig,
  compile(_rule: AutomodRule, config: EmojiConfig): CompiledPredicate {
    return {
      evaluate(input) {
        // Counted by pattern and then *removed*, so the 26 ordinary
        // characters of '<:party:123456789012345678>' are not also counted
        // as themselves by the grapheme pass below.
        const custom = input.content.match(CUSTOM_EMOJI)?.length ?? 0;
        const withoutCustom = input.content.replace(CUSTOM_EMOJI, ' ');

        // Graphemes, not code points: a ZWJ family is four code points and
        // one emoji, and Intl.Segmenter is what knows the difference.
        let unicode = 0;
        for (const { segment } of GRAPHEMES.segment(withoutCustom)) {
          if (
            PICTOGRAPHIC.test(segment) ||
            REGIONAL_INDICATOR.test(segment) ||
            KEYCAP.test(segment)
          ) {
            unicode += 1;
          }
        }

        const total = custom + unicode;
        if (total <= config.maxCount) return undefined;

        return {
          categoryId: 'emoji',
          snippet: input.content.slice(0, 200),
          trace: {
            kind: 'emoji',
            matchedOn: `more than ${config.maxCount} emoji`,
            span: undefined,
            normalisations: ['zero-width stripped', 'grapheme segmented'],
            detail: { total, custom, unicode, maxCount: config.maxCount },
          },
        };
      },
    };
  },
};
