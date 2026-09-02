import { eq } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { automodFixtures, modCaseEvents, modMatchReviews } from '../schema.js';

/**
 * A human's verdict on one recorded match (ADR 0041 §5).
 *
 * Separate from `mod-cases.ts` because it holds a different kind of fact: a
 * case event says what the bot did and is never rewritten (ADR 0036); a
 * verdict is a later judgement about that record, by a named person, at a
 * known time, and revisable.
 */

export type MatchVerdict = 'false_positive' | 'true_positive' | 'unclear';

/**
 * What a verdict means for the regression corpus (plan ruling PR-5).
 *
 * `unclear` deliberately maps to nothing: it is a real verdict for the Slice
 * 6 gate (the spec's decision 16 counts it as a false positive there), but a
 * reviewer who could not decide has not told us what the right answer is, and
 * writing a label from a non-decision would put a wrong expectation into the
 * regression suite.
 */
const LABEL_FOR_VERDICT: Readonly<
  Record<MatchVerdict, 'should_match' | 'should_not_match' | undefined>
> = {
  true_positive: 'should_match',
  false_positive: 'should_not_match',
  unclear: undefined,
};

export interface RecordVerdictInput {
  readonly eventId: string;
  readonly verdict: MatchVerdict;
  readonly reviewedBy: string;
  readonly reviewedAt: number;
  readonly note?: string;
}

/**
 * Records a verdict and, when the verdict says what the right answer was,
 * labels the fixture captured from the same message.
 *
 * One transaction, so a verdict and the label it implies cannot disagree.
 *
 * The fixture update is best-effort (plan ruling PR-8): a member may have
 * used `/forgetme` between the match and the review, and the verdict — the
 * fact Slice 6's gate counts — must not be lost because the evidence behind
 * it was withdrawn.
 *
 * `'no-such-event'` rather than a thrown error: an operator typing an event
 * id at a terminal will mistype one, and that is a usage answer, not a fault.
 */
export const recordVerdict = (
  scope: GuildScope,
  input: RecordVerdictInput,
): 'recorded' | 'no-such-event' =>
  write(scope, ({ db }) => {
    const event = db
      .select({ fixtureId: modCaseEvents.fixtureId })
      .from(modCaseEvents)
      .where(scope.only(modCaseEvents, eq(modCaseEvents.eventId, input.eventId)))
      .get();
    if (event === undefined) return 'no-such-event';

    db.insert(modMatchReviews)
      .values({
        guildId: scope.guildId,
        eventId: input.eventId,
        verdict: input.verdict,
        reviewedBy: input.reviewedBy,
        reviewedAt: input.reviewedAt,
        note: input.note ?? null,
      })
      // A reviewer who changes their mind updates the verdict rather than
      // appending a second one (plan ruling PR-4). Targeted at the primary
      // key so it names the collision it expects — an unrelated unique
      // constraint added later then errors here rather than being silently
      // absorbed. (Not, as an earlier version of this comment claimed, to
      // keep the verdict CHECK throwing: `ON CONFLICT DO NOTHING` never
      // suppressed CHECK violations. See `recordCaseEvent`'s correction.)
      .onConflictDoUpdate({
        target: [modMatchReviews.guildId, modMatchReviews.eventId],
        set: {
          verdict: input.verdict,
          reviewedBy: input.reviewedBy,
          reviewedAt: input.reviewedAt,
          note: input.note ?? null,
        },
      })
      .run();

    const label = LABEL_FOR_VERDICT[input.verdict];
    if (label !== undefined && event.fixtureId !== null) {
      db.update(automodFixtures)
        .set({ label })
        .where(scope.only(automodFixtures, eq(automodFixtures.fixtureId, event.fixtureId)))
        .run();
    }

    return 'recorded';
  });

export interface StoredVerdict {
  readonly verdict: MatchVerdict;
  readonly reviewedBy: string;
  readonly reviewedAt: number;
  readonly note: string | undefined;
}

export const findVerdict = (scope: GuildScope, eventId: string): StoredVerdict | undefined =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(modMatchReviews)
      .where(scope.only(modMatchReviews, eq(modMatchReviews.eventId, eventId)))
      .get();
    return row === undefined
      ? undefined
      : {
          verdict: row.verdict as MatchVerdict,
          reviewedBy: row.reviewedBy,
          reviewedAt: row.reviewedAt,
          note: row.note ?? undefined,
        };
  });
