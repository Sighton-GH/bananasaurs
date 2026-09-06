import { createHash } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { automodFixtureAttachments, automodFixtures } from '../schema.js';

/**
 * The automod review corpus (ADR 0041 §1).
 *
 * Every function takes a `GuildScope` first, like every repository here, and
 * every query goes through `scope.only(...)`. There is deliberately no
 * function that can read or delete a fixture without naming a guild.
 */

export type FixtureLabel = 'should_match' | 'should_not_match' | 'unlabelled';
export type FixtureSource = 'observed' | 'handwritten';

/** One attachment on a corpus message: filename, declared content type, size (OD-3). */
export interface FixtureAttachment {
  readonly fileName: string;
  /** `undefined` when Discord declared no content type. */
  readonly contentType: string | undefined;
  readonly sizeBytes: number;
}

export interface AutomodFixture {
  readonly fixtureId: string;
  readonly content: string;
  /** `undefined` for a handwritten fixture, which has no member behind it. */
  readonly authorId: string | undefined;
  readonly label: FixtureLabel;
  readonly source: FixtureSource;
  readonly note: string | undefined;
  readonly createdAt: number;
  /** Empty for a handwritten fixture that names no files (OD-3). */
  readonly attachments: readonly FixtureAttachment[];
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
  /** Filename, declared content type and size for each file (OD-3). */
  readonly attachments: readonly FixtureAttachment[];
}

/**
 * Records one matched message as evidence, or does nothing if it is already
 * recorded. Returns the fixture id either way, so the caller can link a case
 * event to it.
 *
 * `onConflictDoNothing` is targeted at the primary key rather than left
 * unqualified, so this suppresses only the collision it expects — a replayed
 * capture of the same message — and a *new* unique constraint added to this
 * table later surfaces as an error instead of being silently absorbed.
 *
 * It is **not** targeted to keep the `source`/`author_id` CHECK throwing:
 * `ON CONFLICT DO NOTHING` never suppressed CHECK violations in the first
 * place (only the `INSERT OR IGNORE` prefix does, which drizzle does not
 * emit). An earlier version of this comment said otherwise, copied from
 * `recordCaseEvent`, which has since been corrected.
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

    // Inserted inside the same write() as the parent so a capture is one
    // transaction: a fixture row whose attachments failed to write would be
    // evidence that lies by omission, and `attachment_type`'s dry run would
    // read it as a message with no files.
    //
    // `onConflictDoNothing` on the parent means a replayed capture of the same
    // message is a no-op (PR-1). The children use the same target so a replay
    // does not duplicate them either; the first capture wins for both, which
    // keeps parent and children consistent about which capture they describe.
    input.attachments.forEach((attachment, ordinal) => {
      db.insert(automodFixtureAttachments)
        .values({
          guildId: scope.guildId,
          fixtureId,
          ordinal,
          fileName: attachment.fileName,
          contentType: attachment.contentType ?? null,
          sizeBytes: attachment.sizeBytes,
        })
        .onConflictDoNothing({
          target: [
            automodFixtureAttachments.guildId,
            automodFixtureAttachments.fixtureId,
            automodFixtureAttachments.ordinal,
          ],
        })
        .run();
    });
  });
  return fixtureId;
};

export interface AddHandwrittenFixtureInput {
  readonly fixtureId: string;
  readonly content: string;
  readonly label: FixtureLabel;
  readonly note?: string;
  readonly createdAt: number;
  /**
   * An adversarial case for `attachment_type` is exactly the thing this
   * function exists for, so it can name files too. Defaults to `[]` — most
   * handwritten fixtures are plain text.
   */
  readonly attachments?: readonly FixtureAttachment[];
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

    (input.attachments ?? []).forEach((attachment, ordinal) => {
      db.insert(automodFixtureAttachments)
        .values({
          guildId: scope.guildId,
          fixtureId: input.fixtureId,
          ordinal,
          fileName: attachment.fileName,
          contentType: attachment.contentType ?? null,
          sizeBytes: attachment.sizeBytes,
        })
        .onConflictDoNothing({
          target: [
            automodFixtureAttachments.guildId,
            automodFixtureAttachments.fixtureId,
            automodFixtureAttachments.ordinal,
          ],
        })
        .run();
    });
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
  read(scope, (db) => {
    const rows = db
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
      .all();

    if (rows.length === 0) return [];

    // One query for every attachment in scope, grouped in code, rather than
    // one query per fixture: `listFixtures` is what the dry run replays, and
    // a per-row query would make a 300-fixture corpus 301 queries. Ordered by
    // (fixture_id, ordinal) so a replay sees a message's files in the order
    // they were posted, deterministically.
    const attachmentRows = db
      .select()
      .from(automodFixtureAttachments)
      .where(
        scope.only(
          automodFixtureAttachments,
          inArray(
            automodFixtureAttachments.fixtureId,
            rows.map((row) => row.fixtureId),
          ),
        ),
      )
      .orderBy(asc(automodFixtureAttachments.fixtureId), asc(automodFixtureAttachments.ordinal))
      .all();

    const attachmentsByFixtureId = new Map<string, FixtureAttachment[]>();
    for (const row of attachmentRows) {
      const list = attachmentsByFixtureId.get(row.fixtureId) ?? [];
      list.push({
        fileName: row.fileName,
        contentType: row.contentType ?? undefined,
        sizeBytes: row.sizeBytes,
      });
      attachmentsByFixtureId.set(row.fixtureId, list);
    }

    return rows.map((row) => ({
      fixtureId: row.fixtureId,
      content: row.content,
      authorId: row.authorId ?? undefined,
      label: row.label as FixtureLabel,
      source: row.source as FixtureSource,
      note: row.note ?? undefined,
      createdAt: row.createdAt,
      attachments: attachmentsByFixtureId.get(row.fixtureId) ?? [],
    }));
  });

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
 * 3).
 *
 * **That predicate is currently unreachable, and is kept anyway.** The
 * `automod_fixtures_observed_has_author` CHECK makes a non-null `author_id`
 * imply `source = 'observed'`, so no handwritten row can be selected by the
 * author predicate to begin with — removing this filter would not change what
 * gets deleted, and no test over this function can prove otherwise. It stays
 * as defence against the CHECK being relaxed later, when the implication
 * would quietly stop holding and this deletion would start eating the
 * regression suite.
 *
 * The invariant that actually protects handwritten fixtures is therefore the
 * CHECK, and the CHECK is what is tested — see "the automod_fixtures CHECK
 * that makes /forgetme safe" in `automod-fixtures.test.ts`, which inserts the
 * forbidden pairings with raw SQL and watches them throw. A test that seeded a
 * handwritten row here and watched it survive would pass with this filter
 * deleted, which is the definition of a decorative guard.
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
