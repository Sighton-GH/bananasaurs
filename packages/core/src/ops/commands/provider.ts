import { z } from 'zod';
import { defineCommand, type OpsContext, type OpsWriteResult } from '../dispatch.js';

/**
 * `bananasaurs provider review <provider> --confirm` (ruling M4-D20).
 *
 * Records that a human re-checked a provider's training-eligibility row and
 * found it still accurate: it writes `reviewed_at` and an audit row naming
 * the values confirmed, and nothing else. It does NOT change
 * `trains_on_input`, `evidence_url` or `production_use_allowed` — those are
 * claims about the outside world, and changing one is still a migration, so
 * the deployed schema and `PRIVACY.md` move together.
 *
 * Instance-level, like the eligibility warning it clears: a provider is a
 * fact about the daemon, not a guild, so this reads `ctx.instance`, not
 * `ctx.ports`.
 */

/** Mirrors `ELIGIBILITY_REVIEW_MAX_AGE_MS` in storage, which this package may
 * not import (ADR 0014) — the "cleared until" date below must agree with the
 * threshold `doctor` warns against, so if that constant ever changes, this
 * must change with it. */
const ELIGIBILITY_REVIEW_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

const iso = (ms: number): string => new Date(ms).toISOString();

const providerReviewArgs = z.object({
  provider: z.string().min(1).max(128),
});

export const providerReviewCommand = defineCommand<z.infer<typeof providerReviewArgs>>({
  name: 'provider review',
  write: true,
  summary: "record that a provider's training-eligibility row was re-verified today",
  positional: [{ name: 'provider', required: true, describe: 'the provider name in the row' }],
  args: providerReviewArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.instance.providerReview(args.provider);

    // A throw is the existing convention for a write that changed nothing
    // because there was nothing to change: an unknown provider is a usage
    // mistake, not an answer, and a throw produces no audit row for a state
    // that did not change.
    if (outcome === 'no-such-provider') {
      throw new Error(`no provider eligibility row for ${args.provider}`);
    }

    const lines = [
      `reviewed ${outcome.provider}: trains_on_input=${outcome.trainsOnInput}, ` +
        `evidence ${outcome.evidenceUrl}, ` +
        `previously reviewed ${iso(outcome.previouslyReviewedAt)}`,
    ];
    if (outcome.trainsOnInput !== 'no') {
      // Ruling M4-D20, the deliberate consequence: reviewing a row whose
      // `trains_on_input` is not `'no'` does not clear that warning, and the
      // command says so rather than letting the operator think it did.
      lines.push(
        `WARNING: the row still says this provider trains on input — recording a review ` +
          `does not change that. \`doctor\` will keep warning, and no server content may be ` +
          `sent to it until the row itself is changed, which is a migration.`,
      );
    }
    if (!outcome.productionUseAllowed) {
      lines.push(
        `production use is still not allowed for this provider; ` +
          `\`doctor\` will keep warning for that reason.`,
      );
    }
    if (outcome.trainsOnInput === 'no' && outcome.productionUseAllowed) {
      lines.push(
        `\`doctor\`'s staleness warning for this provider is cleared until ` +
          `${iso(outcome.reviewedAt + ELIGIBILITY_REVIEW_WINDOW_MS)}.`,
      );
    }
    return {
      text: lines.join('\n'),
      data: {
        provider: outcome.provider,
        trainsOnInput: outcome.trainsOnInput,
        evidenceUrl: outcome.evidenceUrl,
        productionUseAllowed: outcome.productionUseAllowed,
        reviewedAt: outcome.reviewedAt,
        previouslyReviewedAt: outcome.previouslyReviewedAt,
      },
      audit: {
        action: 'provider.reviewed',
        subjectType: 'provider',
        subjectId: outcome.provider,
        before: { reviewedAt: outcome.previouslyReviewedAt },
        after: {
          reviewedAt: outcome.reviewedAt,
          trainsOnInput: outcome.trainsOnInput,
          productionUseAllowed: outcome.productionUseAllowed,
        },
      },
    };
  },
});
