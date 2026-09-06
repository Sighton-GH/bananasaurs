import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stripZeroWidth } from '../matcher.js';
import {
  createWindowStore,
  DEFAULT_MAX_EVENTS_PER_MEMBER,
  DEFAULT_MAX_TRACKED_MEMBERS,
} from '../window.js';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

export const duplicateMessageConfig = z
  .object({
    /** Fires when the same normalised text is repeated more than this many times within `windowMs`. */
    maxRepeats: z.number().int().min(1).max(1_000),
    /** Bounded 1 s-10 min, the same reasoning as `rapid_spam`'s `windowMs`. */
    windowMs: z.number().int().min(1_000).max(600_000),
    /**
     * Below this many normalised characters, the rule does not fire at all.
     *
     * **Defaults to 0 — no floor unless the operator sets one.** A non-zero
     * default would be this plan quietly choosing a false-negative rate on the
     * operator's behalf, in the tier whose gate is a false-positive rate (plan
     * ruling, Task 4). With `minLength: 0`, `"ok"` posted three times *does*
     * fire — a floor still matters for a real deployment, and an operator
     * should set one, but the schema itself must not silently suppress a
     * match an operator configured `maxRepeats`/`windowMs` to catch.
     */
    minLength: z.number().int().min(0).max(4_000).default(0),
  })
  .strict();

export type DuplicateMessageConfig = z.infer<typeof duplicateMessageConfig>;

/**
 * `duplicate_message`'s own normalisation — **not** the keyword matcher's.
 *
 * The spec's instruction ("the normalisation is the same code the keyword
 * matcher uses, not a second copy") is not achievable, for two verified
 * reasons (plan ruling PR-20):
 *
 * 1. `matcher.ts`'s `collapseDuplicatesTransformer` stage takes its
 *    thresholds from the *configured word list* (`collapseThresholdsFor`,
 *    ADR 0039) — this predicate has no word list, so that stage has no
 *    defined behaviour for it.
 * 2. `obscenity` never exposes its transformer chain as a function over a
 *    string: `TransformerSet` is internal to `dist/` and not part of the
 *    package's public exports. Reusing the matcher's exact chain would mean a
 *    deep import into `obscenity/dist`, which this project does not do.
 *
 * A third option was examined and rejected: `obscenity` *does* export the
 * transformer factories themselves (`resolveConfusablesTransformer`,
 * `resolveLeetSpeakTransformer`, `toAsciiLowerCaseTransformer`), so one could
 * hand-roll the dispatch loop that runs them over a string. Rejected because
 * the result would be fragile *and* still not faithful: it would depend on an
 * undocumented container discriminant with no compatibility guarantee, and it
 * would still omit `collapseDuplicatesTransformer` (reason 1 above) — a
 * partial, brittle subset of the matcher's behaviour, worse than an honest,
 * simple normaliser that says what it does.
 *
 * So this normalises with `stripZeroWidth` — the one function `matcher.ts`
 * actually exports, imported rather than reimplemented, so the one evasion
 * class this project's own code closes stays shared rather than copied —
 * plus lowercasing and whitespace collapse. Whitespace collapse runs before
 * comparison, not only trimming, so `'buy crypto now'` and
 * `'BUY   Crypto  NOW'` normalise alike.
 *
 * *Cost if this is too narrow:* two members posting the same text with
 * different leetspeak spellings ('n0w' vs 'now') are not treated as
 * duplicates. That is the safe direction for a predicate in the tier the spec
 * says needs the full two-week observation floor — widening it later is
 * additive, narrowing a false-positive rate after the fact is not.
 */
export function normaliseForDuplicateCheck(text: string): string {
  return stripZeroWidth(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Fingerprints the normalised text for storage in the window (IMPORTANT-3,
 * IMPORTANT-4, whole-branch review).
 *
 * `countMatching` only ever tests equality (`e.value === value`), never
 * substring or prefix matching, so a fixed-size digest is behaviourally
 * identical to storing the text itself — two messages normalise to the same
 * hash if and only if they normalise to the same string (collisions aside,
 * and a 16-hex-char slice of sha256 is not a threat model this predicate needs
 * to defend against). Storing the hash instead of the text settles two
 * things at once: memory per event becomes a small constant instead of an
 * uncapped normalised string (IMPORTANT-3's ceiling), and no member-authored
 * message content sits resident in process memory with no time bound at all,
 * which is what age-based pruning's deletion (`6bbc60a`) left open — pruning
 * was correctly deleted on the two grounds argued there (no observable effect
 * on a verdict, and the array was already capped), but a member who posts
 * twice and never posts again used to keep those two strings resident until
 * the process restarts or the rule's fingerprint changes. Record the
 * reasoning here rather than re-adding pruning to solve it.
 */
const hashNormalised = (normalised: string): string =>
  createHash('sha256').update(normalised).digest('hex').slice(0, 16);

/**
 * `duplicate_message` — the same normalised text repeated within a window
 * (Task 4). Consumes Task 1's `createWindowStore` via `countMatching`.
 *
 * The store lives in `compile`'s closure, not module scope (plan ruling
 * PR-21, `window.ts`'s own doc comment): editing this rule's config changes
 * its fingerprint and rebuilds the artifact — and this store — from nothing,
 * resetting the window. That is correct: a repeat count accrued under an old
 * threshold should not be judged against a new one.
 *
 * **The buffer's capacity is `DEFAULT_MAX_EVENTS_PER_MEMBER`, not
 * `maxRepeats + 1`.** An earlier version of this predicate reasoned "for the
 * same reason `rapid_spam`'s is `maxMessages + 1`" — that reasoning does not
 * carry over, and stating it as settled is exactly how the bug it hid
 * survived per-task review (CRITICAL-1, whole-branch review). `rapid_spam`
 * counts *every* event in its buffer (`countWithin`), so a buffer of
 * `maxMessages + 1` can always hold "one too many". This predicate counts
 * only the events whose value matches *this* message's normalised text
 * (`countMatching`), but `record` puts *every* message the member posts —
 * matching or not — into the same buffer. A buffer sized `maxRepeats + 1`
 * therefore holds enough events in total but not enough of one text: a single
 * other message posted between two repeats evicts the earlier repeat before
 * the matching count can ever exceed the threshold, at every configuration —
 * confirmed against the built code before this fix; the evasion was simply
 * typing something else between repeats, which is also the ordinary shape of
 * the spam this predicate exists to catch.
 *
 * So the capacity is `Math.max(DEFAULT_MAX_EVENTS_PER_MEMBER, maxRepeats + 1)`
 * — a **floor** for interleaving headroom, never below what the threshold
 * arithmetically needs. A flat floor *alone* was the first fix for CRITICAL-1
 * and was also wrong: it made every `maxRepeats >= 50` unreachable, which the
 * re-review caught by running 61 consecutive identical messages and watching
 * nothing fire. Both terms are load-bearing.
 *
 * **The residual evasion, stated precisely because an earlier version of this
 * comment overstated it.** A member evades by posting more than
 * `capacity - (maxRepeats + 1)` *distinct* messages between two repeats —
 * measured against the built code, not derived: at `maxRepeats: 1` with a
 * floor of 50, 48 fillers still match and 49 do not. The earlier wording said
 * "more than `DEFAULT_MAX_EVENTS_PER_MEMBER` distinct messages", which is
 * wrong by `maxRepeats + 1` and flattering in the direction that matters.
 *
 * The normalised text is not part of the `WindowKey` either — that would turn
 * the 500-member cap into a 500-distinct-*text* cap and put member-authored
 * content in a cache key.
 */
export const duplicateMessagePredicate: Predicate<DuplicateMessageConfig> = {
  kind: 'duplicate_message',
  config: duplicateMessageConfig,
  compile(rule: AutomodRule, config: DuplicateMessageConfig): CompiledPredicate {
    const store = createWindowStore({
      // A floor, not a replacement for the threshold arithmetic — and the
      // difference is a shipped bug, twice. `countMatching` can never return
      // more than the buffer holds, so a buffer smaller than `maxRepeats + 1`
      // makes `count > config.maxRepeats` unreachable and the rule dead code.
      // The first fix for CRITICAL-1 replaced `maxRepeats + 1` with a flat
      // `DEFAULT_MAX_EVENTS_PER_MEMBER`, which fixed the interleaving defeat
      // and reintroduced the same total failure for every `maxRepeats >= 50` —
      // about 95% of the range `duplicateMessageConfig` permits, silently,
      // with no log line and no `doctor` entry. Both terms are needed: the
      // floor buys headroom so an interleaved message cannot evict a repeat,
      // and `maxRepeats + 1` keeps the threshold reachable at any
      // configuration.
      maxEventsPerMember: Math.max(DEFAULT_MAX_EVENTS_PER_MEMBER, config.maxRepeats + 1),
      maxMembers: DEFAULT_MAX_TRACKED_MEMBERS,
    });

    return {
      evaluate(input) {
        // Only messageCreate counts, the same reasoning rapid_spam's PR-23
        // comment gives: an edited message is not a new post.
        if (input.eventKind !== 'messageCreate') return undefined;

        const normalised = normaliseForDuplicateCheck(input.content);
        // CRITICAL-2: absent content, not short content. An attachment-only,
        // sticker-only or embed-only message has `content === ''`
        // (`events.ts`'s `?? undefined` only ever produces `undefined` for a
        // partial message, never for a real one with no text), so
        // `normalised` is `''` here. `minLength: 0` is deliberate — the
        // schema must not invent a floor the operator did not configure — but
        // that ruling was about short text, not absent text: matching on the
        // *absence* of content would make two captionless image posts a
        // match on the default config, in the one tier that must have zero
        // false positives. Checked before the `minLength` comparison so an
        // operator who explicitly sets `minLength: 0` still gets this.
        if (normalised.length === 0) return undefined;
        if (normalised.length < config.minLength) return undefined;

        const hashed = hashNormalised(normalised);
        const window = store.for({
          // CLAUDE.md rule 2: guildId is named explicitly even though the
          // artifact this store lives inside is already per-guild.
          guildId: input.guildId,
          memberId: input.authorId,
          ruleId: rule.ruleId,
        });
        window.record(input.atMs, hashed);
        const count = window.countMatching(input.atMs, config.windowMs, hashed);
        if (count <= config.maxRepeats) return undefined;

        return {
          categoryId: 'duplicate_message',
          // The whole message is the evidence; there is no span to point at.
          snippet: input.content.slice(0, 200),
          trace: {
            kind: 'duplicate_message',
            // The configured threshold, never message text (ruling R-8).
            matchedOn: `more than ${config.maxRepeats} repeats within ${config.windowMs}ms`,
            span: undefined,
            normalisations: ['zero-width stripped', 'lowercased', 'whitespace collapsed'],
            detail: {
              // The repeat count and the normalised length, never the
              // normalised text itself (Task 4): the content is a
              // member-controlled string, and ADR 0041 §4 keeps whole-message
              // content out of the trace.
              count,
              maxRepeats: config.maxRepeats,
              windowMs: config.windowMs,
              normalisedLength: normalised.length,
            },
          },
        };
      },
    };
  },
};
