import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { automodFixtures } from '../schema.js';

/**
 * The automod review corpus (ADR 0041 §1).
 *
 * Every function takes a `GuildScope` first, like every repository here, and
 * every query goes through `scope.only(...)`. There is deliberately no
 * function that can read or delete a fixture without naming a guild.
 */

export type FixtureLabel = 'should_match' | 'should_not_match' | 'unlabelled';
export type FixtureSource = 'observed' | 'handwritten';

export interface AutomodFixture {
  readonly fixtureId: string;
  readonly content: string;
  /** `undefined` for a handwritten fixture, which has no member behind it. */
  readonly authorId: string | undefined;
  readonly label: FixtureLabel;
  readonly source: FixtureSource;
  readonly note: string | undefined;
  readonly createdAt: number;
}

/**
 * `<messageId>:<first 16 hex of sha256(content)>` — plan ruling PR-1.
 *
 * The message id alone would collapse an *edit* into the message's original
 * capture, losing the evidence a reviewer is being asked about; the content
 * hash alone would collapse two different members posting the same text into
 * one row. Together they say "this message, with this text", which is
 * exactly what one piece of evidence is.
 *
 * 16 hex characters (64 bits) is not a security boundary — a collision would
 * need two different texts under the same message id — so a truncated digest
 * keeps the id readable in a terminal without costing anything real.
 */
export const observedFixtureId = (messageId: string, content: string): string =>
  `${messageId}:${createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)}`;

export interface CaptureObservedFixtureInput {
  readonly messageId: string;
  /** Zero-width stripped — what the predicate actually saw. */
  readonly content: string;
  readonly authorId: string;
  readonly createdAt: number;
}

/**
 * Records one matched message as evidence, or does nothing if it is already
 * recorded. Returns the fixture id either way, so the caller can link a case
 * event to it.
 *
 * `onConflictDoNothing` is targeted at the primary key rather than left
 * unqualified: an unqualified `ON CONFLICT DO NOTHING` in SQLite (unlike
 * Postgres) also swallows CHECK violations, which would silently discard a
 * fixture whose `source`/`author_id` pairing is wrong instead of throwing —
 * the same reasoning `recordCaseEvent` records for its own conflict target.
 *
 * The first capture wins, so `created_at` is when the message was first seen
 * rather than when a gateway replay re-delivered it.
 */
export const captureObservedFixture = (
  scope: GuildScope,
  input: CaptureObservedFixtureInput,
): string => {
  const fixtureId = observedFixtureId(input.messageId, input.content);
  write(scope, ({ db }) => {
    db.insert(automodFixtures)
      .values({
        guildId: scope.guildId,
        fixtureId,
        content: input.content,
        authorId: input.authorId,
        label: 'unlabelled',
        source: 'observed',
        note: null,
        createdAt: input.createdAt,
      })
      .onConflictDoNothing({
        target: [automodFixtures.guildId, automodFixtures.fixtureId],
      })
      .run();
  });
  return fixtureId;
};

export interface AddHandwrittenFixtureInput {
  readonly fixtureId: string;
  readonly content: string;
  readonly label: FixtureLabel;
  readonly note?: string;
  readonly createdAt: number;
}

/**
 * Adds an adversarial case the project wrote itself.
 *
 * `author_id` is null by construction — a handwritten fixture is not member
 * data, and `/forgetme` never deletes one (ADR 0041 §1, obligation 3). The
 * schema's `automod_fixtures_observed_has_author` CHECK is what actually
 * enforces that pairing.
 */
export const addHandwrittenFixture = (scope: GuildScope, input: AddHandwrittenFixtureInput): void =>
  write(scope, ({ db }) => {
    db.insert(automodFixtures)
      .values({
        guildId: scope.guildId,
        fixtureId: input.fixtureId,
        content: input.content,
        authorId: null,
        label: input.label,
        source: 'handwritten',
        note: input.note ?? null,
        createdAt: input.createdAt,
      })
      .onConflictDoNothing({
        target: [automodFixtures.guildId, automodFixtures.fixtureId],
      })
      .run();
  });

export interface FixtureFilter {
  readonly source?: FixtureSource;
  readonly label?: FixtureLabel;
}

/**
 * The corpus, oldest first.
 *
 * The order is load-bearing, not cosmetic: the dry run replays fixtures in
 * `created_at` order so the window tier's sliding-window state (Slice 4) sees
 * them in the order they really happened (ADR 0041 §6). `fixture_id` breaks
 * ties — `created_at` can legitimately collide when several messages land in
 * the same millisecond, and without a tiebreaker the replay order would be
 * whatever the planner chose that day, which would make a dry run's result
 * depend on the query plan.
 */
export const listFixtures = (
  scope: GuildScope,
  filter: FixtureFilter = {},
): readonly AutomodFixture[] =>
  read(scope, (db) =>
    db
      .select()
      .from(automodFixtures)
      .where(
        scope.only(
          automodFixtures,
          ...(filter.source === undefined ? [] : [eq(automodFixtures.source, filter.source)]),
          ...(filter.label === undefined ? [] : [eq(automodFixtures.label, filter.label)]),
        ),
      )
      .orderBy(asc(automodFixtures.createdAt), asc(automodFixtures.fixtureId))
      .all()
      .map((row) => ({
        fixtureId: row.fixtureId,
        content: row.content,
        authorId: row.authorId ?? undefined,
        label: row.label as FixtureLabel,
        source: row.source as FixtureSource,
        note: row.note ?? undefined,
        createdAt: row.createdAt,
      })),
  );

/** Returns whether there was a fixture to label. False is a real answer. */
export const setFixtureLabel = (
  scope: GuildScope,
  fixtureId: string,
  label: FixtureLabel,
  note?: string,
): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .update(automodFixtures)
      .set({ label, ...(note === undefined ? {} : { note }) })
      .where(scope.only(automodFixtures, eq(automodFixtures.fixtureId, fixtureId)))
      .run();
    return result.changes > 0;
  });

/**
 * Deletes every `observed` fixture belonging to one member, and returns how
 * many went.
 *
 * Ships in Slice 2 with a test even though `/forgetme` is Release 3 (R3-10),
 * because the owner authorised a corpus that can be un-made and the way to
 * keep that true is to build and test the un-making now — so R3-10 wires up
 * an existing, tested path rather than inventing one under time pressure
 * (ADR 0041 §1, obligation 2).
 *
 * `source = 'observed'` is in the WHERE clause, not left implied by
 * `author_id`: handwritten fixtures are the project's own adversarial cases,
 * not member data, and must survive a member's deletion request (obligation
 * 3). The schema CHECK already makes their `author_id` null, so this
 * predicate is belt and braces — deliberately, because the cost of getting it
 * wrong is silently destroying the regression suite.
 */
export const deleteObservedFixturesForMember = (scope: GuildScope, memberId: string): number =>
  write(scope, ({ db }) => {
    const result = db
      .delete(automodFixtures)
      .where(
        scope.only(
          automodFixtures,
          eq(automodFixtures.authorId, memberId),
          eq(automodFixtures.source, 'observed'),
        ),
      )
      .run();
    return result.changes;
  });
