import { z } from 'zod';
import { createWindowStore, DEFAULT_MAX_TRACKED_MEMBERS } from '../window.js';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

export const rapidSpamConfig = z
  .object({
    /** Fires when a member's `messageCreate` count inside `windowMs` exceeds this. */
    maxMessages: z.number().int().min(1).max(1_000),
    /**
     * How far back to count messages, in milliseconds. Bounded 1 s-10 min so
     * a config cannot ask the window store to hold an unbounded span — the
     * per-member ring buffer this predicate builds is sized from
     * `maxMessages`, not from `windowMs`, but an unbounded window would still
     * mean "everything this member has ever posted" is one config edit away.
     */
    windowMs: z.number().int().min(1_000).max(600_000),
  })
  .strict();

export type RapidSpamConfig = z.infer<typeof rapidSpamConfig>;

/**
 * `rapid_spam` — messages per member per window (Task 3, plan ruling PR-22).
 *
 * The window store is built here, in `compile`, not at module scope: it lives
 * in the closure of the returned `CompiledPredicate`, which is what gives it
 * the right lifetime (plan ruling PR-21, `window.ts`'s own doc comment). **A
 * config edit resets this rule's window** — editing `maxMessages` or
 * `windowMs` changes the rule's content fingerprint, which rebuilds the
 * artifact (and this store) from nothing. That is correct: a member's count
 * accrued under an old threshold should not be judged against a new one. It
 * reads as a bug only without this comment, which is why PR-21 insists on one.
 *
 * The ring buffer's capacity is `maxMessages + 1`, not `maxMessages`: this
 * predicate must be able to *observe* one message more than the threshold
 * allows (the "one too many" message is what fires it), and a buffer capped
 * at exactly `maxMessages` could never hold that many at once — it would
 * evict the oldest before the count ever read above the threshold.
 */
export const rapidSpamPredicate: Predicate<RapidSpamConfig> = {
  kind: 'rapid_spam',
  config: rapidSpamConfig,
  compile(rule: AutomodRule, config: RapidSpamConfig): CompiledPredicate {
    const store = createWindowStore({
      maxEventsPerMember: config.maxMessages + 1,
      maxMembers: DEFAULT_MAX_TRACKED_MEMBERS,
    });

    return {
      evaluate(input) {
        // PR-23: only `messageCreate` counts toward the rate. A member fixing
        // a typo three times must not read as three messages — the content
        // predicates still see the edit; this predicate alone must not.
        if (input.eventKind !== 'messageCreate') return undefined;

        const window = store.for({
          // CLAUDE.md rule 2: guildId is named explicitly even though the
          // artifact this store lives inside is already per-guild.
          guildId: input.guildId,
          memberId: input.authorId,
          ruleId: rule.ruleId,
        });
        window.record(input.atMs);
        const count = window.countWithin(input.atMs, config.windowMs);
        if (count <= config.maxMessages) return undefined;

        return {
          categoryId: 'rapid_spam',
          // The whole message is the evidence; there is no span to point at.
          snippet: input.content.slice(0, 200),
          trace: {
            kind: 'rapid_spam',
            // The configured threshold, never message text (ruling R-8).
            matchedOn: `more than ${config.maxMessages} messages within ${config.windowMs}ms`,
            // A property of a sequence of messages, not a span of this one.
            span: undefined,
            normalisations: [],
            detail: {
              count,
              maxMessages: config.maxMessages,
              windowMs: config.windowMs,
            },
          },
        };
      },
    };
  },
};
