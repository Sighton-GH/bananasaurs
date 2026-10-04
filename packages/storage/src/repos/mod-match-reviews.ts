import { eq } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { modCaseEvents, modMatchReviews } from '../schema.js';

/**
 * A human's verdict on one recorded match (ADR 0041 §5).
 *
 * Separate from `mod-cases.ts` because it holds a different kind of fact: a
 * case event says what the bot did and is never rewritten (ADR 0036); a
 * verdict is a later judgement about that record, by a named person, at a
 * known time, and revisable.
 */

export type MatchVerdict = 'false_positive' | 'true_positive' | 'unclear';

export interface RecordVerdictInput {
  readonly eventId: string;
  readonly verdict: MatchVerdict;
  readonly reviewedBy: string;
  readonly reviewedAt: number;
  readonly note?: string;
}

/**
 * Records a flag on one match: whether the rule was right (ADR 0121 keeps
 * these for tuning a rule). A reviewer who changes their mind updates the
 * flag rather than appending a second one.
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
      .select({ eventId: modCaseEvents.eventId })
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
      // Targeted at the primary key so it names the collision it expects —
      // an unrelated unique constraint added later then errors here rather
      // than being silently absorbed. (`ON CONFLICT DO NOTHING` never
      // suppressed CHECK violations; see `recordCaseEvent`'s correction.)
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
