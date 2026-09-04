import { z } from 'zod';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

export const mentionSpamConfig = z
  .object({
    /** Fires when the mention count (see below) exceeds this. */
    maxMentions: z.number().int().min(0).max(1_000),
    /**
     * How many "mentions" one `@everyone`/`@here` counts as.
     *
     * They reach far more people than a single user or role mention, so they
     * are worth more than one by default — but the weight is a config field,
     * not a hard-coded constant, because an operator running a small guild
     * where `@everyone` is used routinely may want it weighted differently.
     */
    countEveryoneAs: z.number().int().min(1).max(1_000).default(5),
  })
  .strict();

export type MentionSpamConfig = z.infer<typeof mentionSpamConfig>;

/**
 * `mention_spam` — **stateless**, despite the spec grouping it with the
 * window tier (plan ruling PR-24).
 *
 * `rapid_spam` and `duplicate_message` (Tasks 3-4) need `window.ts` because
 * they judge a *rate* — something true only across several messages. This
 * predicate judges a property of **one message**: how many people it
 * mentions. Nothing about that needs memory of earlier messages, so this file
 * does not import `window.ts`, and it should not gain that import later
 * without a new requirement (a mentions-*per-minute* config field) driving it
 * — see PR-24 for the reasoning recorded when this was decided.
 */
export const mentionSpamPredicate: Predicate<MentionSpamConfig> = {
  kind: 'mention_spam',
  config: mentionSpamConfig,
  compile(_rule: AutomodRule, config: MentionSpamConfig): CompiledPredicate {
    return {
      evaluate(input) {
        // User and role mentions count equally; @everyone/@here counts as
        // `countEveryoneAs` (PR-3: `mentionsEveryone` is Discord's own gateway
        // flag on a live message, not a text scan — `evaluate.ts`'s
        // `EVERYONE_MENTION` reconstructs it only for a fixture replay).
        const mentionCount = input.mentionedUserIds.length + input.mentionedRoleIds.length;
        const everyoneCount = input.mentionsEveryone ? config.countEveryoneAs : 0;
        const total = mentionCount + everyoneCount;

        if (total <= config.maxMentions) return undefined;

        return {
          categoryId: 'mention_spam',
          // The whole message is the evidence; there is no span to point at.
          snippet: input.content.slice(0, 200),
          trace: {
            kind: 'mention_spam',
            // The configured threshold, never message text (ruling R-8):
            // `matchedOn` is unbounded by schema, so each producer is
            // responsible for putting only configured values there
            // (trace.ts's comment).
            matchedOn: `more than ${config.maxMentions} mentions`,
            // A property of the whole message, not a span of it.
            span: undefined,
            normalisations: [],
            detail: {
              userMentions: input.mentionedUserIds.length,
              roleMentions: input.mentionedRoleIds.length,
              mentionsEveryone: input.mentionsEveryone,
              countEveryoneAs: config.countEveryoneAs,
              total,
              maxMentions: config.maxMentions,
            },
          },
        };
      },
    };
  },
};
