import { and, eq, ne } from 'drizzle-orm';
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
 *
 * **A fixture's label has no rule dimension (IMPORTANT-1, coordinator
 * ruling).** `captureObservedFixture` dedupes on `<messageId>:<contentHash>`,
 * so one message that matches two rules produces two case events sharing one
 * fixture. A `true_positive` verdict on rule A's event and a `false_positive`
 * verdict on rule B's event are both correct — the message really is a true
 * positive for A and a false positive for B — but the fixture's label means
 * "should a rule match this", with no way to say "for which rule". When a
 * new verdict implies a label that disagrees with one already recorded (by a
 * *different* rule's event on the same fixture), there is no honest single
 * answer, so the label resets to `unlabelled` with a note naming both rules,
 * rather than either verdict silently overwriting the other. Losing a row
 * from the regression corpus is a far better failure than seeding it with a
 * confidently wrong expectation. (A per-rule label table is the eventual
 * fix, and is additive — not Release 2's problem.)
 *
 * A reviewer revising their *own* verdict on the *same* event is not this
 * case: that is one rule's judgement being corrected, not two rules
 * disagreeing, so it overwrites the label normally.
 */
export const recordVerdict = (
  scope: GuildScope,
  input: RecordVerdictInput,
): 'recorded' | 'recorded-with-label-conflict' | 'no-such-event' =>
  write(scope, ({ db }) => {
    const event = db
      .select({ fixtureId: modCaseEvents.fixtureId, ruleId: modCaseEvents.ruleId })
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
    if (label === undefined || event.fixtureId === null) return 'recorded';

    const fixture = db
      .select({ label: automodFixtures.label })
      .from(automodFixtures)
      .where(scope.only(automodFixtures, eq(automodFixtures.fixtureId, event.fixtureId)))
      .get();
    // The fixture may have been forgotten (`/forgetme`) between the match
    // and the review — nothing left to label, and that is not a conflict.
    if (fixture === undefined || fixture.label === 'unlabelled' || fixture.label === label) {
      db.update(automodFixtures)
        .set({ label })
        .where(scope.only(automodFixtures, eq(automodFixtures.fixtureId, event.fixtureId)))
        .run();
      return 'recorded';
    }

    // The fixture already carries a label this verdict disagrees with. That
    // is only a *conflict* — two rules disagreeing — if some other event on
    // this fixture, from a different rule, has a recorded verdict implying
    // the label currently stored. If not, the stored label was set by this
    // same event's own earlier verdict, and a reviewer revising their own
    // judgement is not a rule disagreement: overwrite normally.
    const otherSetters = db
      .select({ ruleId: modCaseEvents.ruleId, verdict: modMatchReviews.verdict })
      .from(modMatchReviews)
      .innerJoin(
        modCaseEvents,
        and(
          eq(modMatchReviews.guildId, modCaseEvents.guildId),
          eq(modMatchReviews.eventId, modCaseEvents.eventId),
        ),
      )
      .where(
        scope.only(
          modCaseEvents,
          eq(modCaseEvents.fixtureId, event.fixtureId),
          ne(modCaseEvents.eventId, input.eventId),
        ),
      )
      .all();
    const otherRuleId = otherSetters.find(
      (row) => LABEL_FOR_VERDICT[row.verdict as MatchVerdict] === fixture.label,
    )?.ruleId;

    if (otherRuleId === undefined) {
      db.update(automodFixtures)
        .set({ label })
        .where(scope.only(automodFixtures, eq(automodFixtures.fixtureId, event.fixtureId)))
        .run();
      return 'recorded';
    }

    // A real conflict: name both rules in the note for a human reading the
    // corpus later, and reset rather than let either verdict silently win.
    db.update(automodFixtures)
      .set({
        label: 'unlabelled',
        note:
          `verdict conflict: rule ${event.ruleId} says this message should be ${label}, ` +
          `but rule ${otherRuleId} previously ruled it ${fixture.label} on the same ` +
          'message — a fixture’s label has no rule dimension, so the label was reset ' +
          'to unlabelled rather than one verdict silently overwriting the other',
      })
      .where(scope.only(automodFixtures, eq(automodFixtures.fixtureId, event.fixtureId)))
      .run();

    return 'recorded-with-label-conflict';
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
