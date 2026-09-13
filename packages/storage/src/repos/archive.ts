import { asc, count, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../db.js';
import {
  archiveAttachments,
  archiveChannels,
  archiveMessageEdits,
  archiveMessages,
  modCaseEvents,
  modCases,
} from '../schema.js';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { findCase } from './automod-admin.js';

/**
 * The archive repository (ADR 0046, Slice M1 Task 3).
 *
 * Every function takes a `GuildScope` first and scopes through `scope.only`,
 * like every repository here. This module enforces nothing beyond guild
 * scope: the three ingest vetoes (`BANANASAURS_ARCHIVE_GUILDS`, the channel
 * row here, `log_excluded_channels`) live in the subscriber (Task 4), which
 * is why a channel row is one veto passing rather than permission.
 *
 * `mod_cases` is read through the existing `findCase` in `automod-admin.ts`
 * and `mod_case_events` through the one read below; neither table is ever
 * written here.
 */

export type AttachmentPolicy = 'none' | 'bytes';
export type BackfillState = 'pending' | 'running' | 'done';
export type RetentionClass = 'default' | 'case' | 'preserve';

export interface ArchiveChannel {
  readonly channelId: string;
  readonly attachmentPolicy: AttachmentPolicy;
  readonly enabledAt: number;
  readonly cursorMessageId: string | undefined;
  readonly backfillState: BackfillState;
}

export interface ArchiveAttachmentInput {
  readonly attachmentId: string;
  readonly filename: string;
  readonly contentType: string | undefined;
  readonly size: number;
}

export interface UpsertMessageInput {
  readonly messageId: string;
  readonly channelId: string;
  readonly authorId: string | undefined;
  readonly content: string | undefined;
  readonly createdAt: number;
  readonly editedAt: number | undefined;
  readonly attachments: readonly ArchiveAttachmentInput[];
}

export const ARCHIVE_DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ARCHIVE_CASE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const toArchiveChannel = (row: typeof archiveChannels.$inferSelect): ArchiveChannel => ({
  channelId: row.channelId,
  attachmentPolicy: row.attachmentPolicy as AttachmentPolicy,
  enabledAt: row.enabledAt,
  cursorMessageId: row.cursorMessageId ?? undefined,
  backfillState: row.backfillState as BackfillState,
});

/** Inserts the channel row; a replayed enable is a no-op reported as such. */
export const enableChannel = (
  scope: GuildScope,
  input: { channelId: string; attachmentPolicy: AttachmentPolicy; now: number },
): 'enabled' | 'already-enabled' =>
  write(scope, ({ db }) => {
    const result = db
      .insert(archiveChannels)
      .values({
        guildId: scope.guildId,
        channelId: input.channelId,
        attachmentPolicy: input.attachmentPolicy,
        enabledAt: input.now,
        cursorMessageId: null,
        backfillState: 'pending',
      })
      .onConflictDoNothing({ target: [archiveChannels.guildId, archiveChannels.channelId] })
      .run();
    return result.changes === 1 ? 'enabled' : 'already-enabled';
  });

/** Deletes the channel row; the messages, edits and attachments cascade in the schema. */
export const disableChannel = (scope: GuildScope, channelId: string): 'disabled' | 'not-enabled' =>
  write(scope, ({ db }) => {
    const result = db
      .delete(archiveChannels)
      .where(scope.only(archiveChannels, eq(archiveChannels.channelId, channelId)))
      .run();
    return result.changes === 1 ? 'disabled' : 'not-enabled';
  });

export const isChannelEnabled = (scope: GuildScope, channelId: string): boolean =>
  read(
    scope,
    (db) =>
      db
        .select({ channelId: archiveChannels.channelId })
        .from(archiveChannels)
        .where(scope.only(archiveChannels, eq(archiveChannels.channelId, channelId)))
        .get() !== undefined,
  );

export const listChannels = (scope: GuildScope): ArchiveChannel[] =>
  read(scope, (db) =>
    db
      .select()
      .from(archiveChannels)
      .where(scope.only(archiveChannels))
      .orderBy(asc(archiveChannels.channelId))
      .all()
      .map(toArchiveChannel),
  );

export const findChannel = (scope: GuildScope, channelId: string): ArchiveChannel | undefined =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(archiveChannels)
      .where(scope.only(archiveChannels, eq(archiveChannels.channelId, channelId)))
      .get();
    return row === undefined ? undefined : toArchiveChannel(row);
  });

export const setBackfillCursor = (
  scope: GuildScope,
  input: { channelId: string; cursorMessageId: string | undefined; state: BackfillState },
): void =>
  write(scope, ({ db }) => {
    db.update(archiveChannels)
      .set({ cursorMessageId: input.cursorMessageId ?? null, backfillState: input.state })
      .where(scope.only(archiveChannels, eq(archiveChannels.channelId, input.channelId)))
      .run();
  });

/**
 * Inserts the message row, or nothing when it is already there.
 *
 * `ON CONFLICT(guild_id, message_id) DO NOTHING`, targeted at the primary
 * key so a future unique constraint would surface rather than be absorbed
 * (the `mod-cases.ts` convention). Attachments are inserted the same way, on
 * every call: whether the live event or the backfill page arrived first, the
 * first writer wins and the second is a no-op — live rows and backfill rows
 * never overwrite each other. Returns true when the message row was new.
 */
export const upsertMessage = (scope: GuildScope, input: UpsertMessageInput): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .insert(archiveMessages)
      .values({
        guildId: scope.guildId,
        messageId: input.messageId,
        channelId: input.channelId,
        authorId: input.authorId ?? null,
        content: input.content ?? null,
        createdAt: input.createdAt,
        editedAt: input.editedAt ?? null,
        deletedAt: null,
        retentionClass: 'default',
        caseId: null,
        contentPurgedAt: null,
      })
      .onConflictDoNothing({ target: [archiveMessages.guildId, archiveMessages.messageId] })
      .run();

    for (const attachment of input.attachments) {
      db.insert(archiveAttachments)
        .values({
          guildId: scope.guildId,
          messageId: input.messageId,
          attachmentId: attachment.attachmentId,
          filename: attachment.filename,
          contentType: attachment.contentType ?? null,
          size: attachment.size,
          sha256: null,
          bytesPath: null,
        })
        .onConflictDoNothing({
          target: [
            archiveAttachments.guildId,
            archiveAttachments.messageId,
            archiveAttachments.attachmentId,
          ],
        })
        .run();
    }

    return result.changes === 1;
  });

/**
 * Records an edit: appends a row holding the PREVIOUS content (`edit_seq` =
 * count + 1), then sets the message's content and edited timestamp.
 *
 * 'no-such-message' when the row is absent — an edit to a message created
 * before the channel was enabled. Discord sends full content on update, so
 * the caller may upsert first; this function does not.
 */
export const recordEdit = (
  scope: GuildScope,
  input: { messageId: string; content: string | undefined; editedAt: number },
): 'recorded' | 'no-such-message' =>
  write(scope, ({ db }) => {
    const current = db
      .select({ content: archiveMessages.content })
      .from(archiveMessages)
      .where(scope.only(archiveMessages, eq(archiveMessages.messageId, input.messageId)))
      .get();
    if (current === undefined) return 'no-such-message';

    const existing = db
      .select({ editSeq: archiveMessageEdits.editSeq })
      .from(archiveMessageEdits)
      .where(scope.only(archiveMessageEdits, eq(archiveMessageEdits.messageId, input.messageId)))
      .all();
    db.insert(archiveMessageEdits)
      .values({
        guildId: scope.guildId,
        messageId: input.messageId,
        editSeq: existing.length + 1,
        content: current.content,
        editedAt: input.editedAt,
      })
      .run();
    db.update(archiveMessages)
      .set({ content: input.content ?? null, editedAt: input.editedAt })
      .where(scope.only(archiveMessages, eq(archiveMessages.messageId, input.messageId)))
      .run();
    return 'recorded';
  });

/** Marks the message deleted, once. A replayed delete reports 'already-deleted'. */
export const recordDelete = (
  scope: GuildScope,
  input: { messageId: string; deletedAt: number },
): 'recorded' | 'no-such-message' | 'already-deleted' =>
  write(scope, ({ db }) => {
    const current = db
      .select({ deletedAt: archiveMessages.deletedAt })
      .from(archiveMessages)
      .where(scope.only(archiveMessages, eq(archiveMessages.messageId, input.messageId)))
      .get();
    if (current === undefined) return 'no-such-message';
    if (current.deletedAt !== null) return 'already-deleted';
    db.update(archiveMessages)
      .set({ deletedAt: input.deletedAt })
      .where(scope.only(archiveMessages, eq(archiveMessages.messageId, input.messageId)))
      .run();
    return 'recorded';
  });

/** Marks every still-live row named, and returns how many that was. */
export const recordBulkDelete = (
  scope: GuildScope,
  input: { messageIds: readonly string[]; deletedAt: number },
): number =>
  write(scope, ({ db }) => {
    if (input.messageIds.length === 0) return 0;
    const rows = db
      .select({ messageId: archiveMessages.messageId, deletedAt: archiveMessages.deletedAt })
      .from(archiveMessages)
      .where(scope.only(archiveMessages, inArray(archiveMessages.messageId, [...input.messageIds])))
      .all();
    const live = rows.filter((row) => row.deletedAt === null).map((row) => row.messageId);
    if (live.length === 0) return 0;
    db.update(archiveMessages)
      .set({ deletedAt: input.deletedAt })
      .where(scope.only(archiveMessages, inArray(archiveMessages.messageId, live)))
      .run();
    return live.length;
  });

/**
 * Marks the message preserved. Preserve wins over every other class: a
 * 'case' row becomes 'preserve', and the expiry job never touches a
 * 'preserve' row.
 */
export const markPreserve = (
  scope: GuildScope,
  messageId: string,
): 'preserved' | 'no-such-message' | 'already-preserved' =>
  write(scope, ({ db }) => {
    const current = db
      .select({ retentionClass: archiveMessages.retentionClass })
      .from(archiveMessages)
      .where(scope.only(archiveMessages, eq(archiveMessages.messageId, messageId)))
      .get();
    if (current === undefined) return 'no-such-message';
    if (current.retentionClass === 'preserve') return 'already-preserved';
    db.update(archiveMessages)
      .set({ retentionClass: 'preserve' })
      .where(scope.only(archiveMessages, eq(archiveMessages.messageId, messageId)))
      .run();
    return 'preserved';
  });

/**
 * Links the message to a moderation case (PR-69), moving it to the 'case'
 * retention tier. The case must exist in scope with status 'open', read
 * through `mod_cases` via `findCase` — never written.
 *
 * 'preserved' wins: a 'preserve' row is stronger than any case link, so
 * nothing changes. 'already-linked' when the row already carries this case;
 * a link to a *different* case re-links (there is no unlink, so a wrong link
 * must be movable) and reports 'linked'.
 */
export const linkToCase = (
  scope: GuildScope,
  input: { messageId: string; caseId: string },
):
  | 'linked'
  | 'no-such-message'
  | 'no-such-case'
  | 'case-closed'
  | 'already-linked'
  | 'preserved' => {
  const current = read(scope, (db) =>
    db
      .select({
        retentionClass: archiveMessages.retentionClass,
        caseId: archiveMessages.caseId,
      })
      .from(archiveMessages)
      .where(scope.only(archiveMessages, eq(archiveMessages.messageId, input.messageId)))
      .get(),
  );
  if (current === undefined) return 'no-such-message';
  if (current.retentionClass === 'preserve') return 'preserved';
  const kase = findCase(scope, input.caseId);
  if (kase === undefined) return 'no-such-case';
  if (kase.status !== 'open') return 'case-closed';
  if (current.caseId === input.caseId) return 'already-linked';
  write(scope, ({ db }) => {
    db.update(archiveMessages)
      .set({ retentionClass: 'case', caseId: input.caseId })
      .where(scope.only(archiveMessages, eq(archiveMessages.messageId, input.messageId)))
      .run();
  });
  return 'linked';
};

const caseClosedAtOn = (db: Db, scope: GuildScope, caseId: string): number | undefined => {
  const kase = db
    .select({ status: modCases.status })
    .from(modCases)
    .where(scope.only(modCases, eq(modCases.caseId, caseId)))
    .get();
  if (kase?.status !== 'closed') return undefined;
  const latest = db
    .select({ at: modCaseEvents.at })
    .from(modCaseEvents)
    .where(scope.only(modCaseEvents, eq(modCaseEvents.caseId, caseId)))
    .orderBy(desc(modCaseEvents.at))
    .limit(1)
    .get();
  return latest?.at;
};

/**
 * The one read on `mod_case_events` this module owns: the latest event
 * timestamp for a closed case, else undefined — for an open case, an unknown
 * case, and a closed case with no events alike. Read-only.
 */
export const caseClosedAt = (scope: GuildScope, caseId: string): number | undefined =>
  read(scope, (db) => caseClosedAtOn(db, scope, caseId));

/**
 * The three tiers (ADR 0046 D3), in one transaction.
 *
 * Purges content (`content = NULL`, `content_purged_at = now`) and deletes
 * the message's edit rows AND its attachment metadata rows (a filename is
 * content too), for rows where `deleted_at` is set and `content` is still
 * present and:
 *
 * - `default`: `deleted_at <= now - 30d`;
 * - `case`: the linked case has closed and its latest event is `<= now - 90d`;
 * - `preserve`: never.
 *
 * Candidate rows are few (deleted but not yet purged), so the per-tier
 * filter runs in JS with `caseClosedAt` for `case` rows. Returns the count
 * purged.
 */
export const expireContent = (scope: GuildScope, now: number): number =>
  write(scope, ({ db }) => {
    const candidates = db
      .select()
      .from(archiveMessages)
      .where(
        scope.only(
          archiveMessages,
          isNotNull(archiveMessages.deletedAt),
          isNotNull(archiveMessages.content),
        ),
      )
      .all();

    const purged: string[] = [];
    for (const row of candidates) {
      if (row.deletedAt === null) continue;
      if (row.retentionClass === 'preserve') continue;
      if (row.retentionClass === 'default') {
        if (row.deletedAt <= now - ARCHIVE_DEFAULT_RETENTION_MS) purged.push(row.messageId);
      } else {
        if (row.caseId === null) continue;
        const closedAt = caseClosedAtOn(db, scope, row.caseId);
        if (closedAt !== undefined && closedAt <= now - ARCHIVE_CASE_RETENTION_MS) {
          purged.push(row.messageId);
        }
      }
    }

    for (const messageId of purged) {
      db.update(archiveMessages)
        .set({ content: null, contentPurgedAt: now })
        .where(scope.only(archiveMessages, eq(archiveMessages.messageId, messageId)))
        .run();
      db.delete(archiveMessageEdits)
        .where(scope.only(archiveMessageEdits, eq(archiveMessageEdits.messageId, messageId)))
        .run();
      db.delete(archiveAttachments)
        .where(scope.only(archiveAttachments, eq(archiveAttachments.messageId, messageId)))
        .run();
    }
    return purged.length;
  });

export const countMessages = (scope: GuildScope, channelId: string): number =>
  read(
    scope,
    (db) =>
      db
        .select({ n: count() })
        .from(archiveMessages)
        .where(scope.only(archiveMessages, eq(archiveMessages.channelId, channelId)))
        .get()?.n ?? 0,
  );
