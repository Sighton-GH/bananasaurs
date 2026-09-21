import { asc, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
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

/**
 * ADR 0047 amendment 2026-09-20: `channel` and `category` rows are written by
 * the operator and decide scope. A `derived` row only satisfies
 * `archive_messages`' composite foreign key and owns the cascade — no
 * authorization read below ever matches one.
 */
export type ScopeKind = 'channel' | 'category' | 'derived';

export interface ArchiveChannel {
  readonly channelId: string;
  readonly scopeKind: ScopeKind;
  /** The category row a `derived` row was materialised from; otherwise absent. */
  readonly derivedFrom: string | undefined;
  readonly attachmentPolicy: AttachmentPolicy;
  readonly enabledAt: number;
  readonly cursorMessageId: string | undefined;
  readonly backfillState: BackfillState;
  readonly threadsFound: number | undefined;
  readonly threadsDone: number;
  /** Whether public threads under this channel are archived (schema default: on). */
  readonly includeThreads: boolean;
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
  readonly threadId?: string | undefined;
  /**
   * The category covering `channelId` at write time. Read only when the
   * channel has no `archive_channels` row of its own: the first write for a
   * category-covered channel materialises its derived row with this as
   * `derived_from` (ADR 0047 amendment 2026-09-20).
   */
  readonly categoryId?: string | undefined;
  readonly authorId: string | undefined;
  readonly content: string | undefined;
  readonly createdAt: number;
  readonly editedAt: number | undefined;
  readonly attachments: readonly ArchiveAttachmentInput[];
}

export const ARCHIVE_DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ARCHIVE_CASE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The shared read limit cap: defined here in the lower layer (which
 * `archive-search.ts` already depends on) so the import points one way.
 */
export const SEARCH_LIMIT_MAX = 100;

const toArchiveChannel = (row: typeof archiveChannels.$inferSelect): ArchiveChannel => ({
  channelId: row.channelId,
  scopeKind: row.scopeKind as ScopeKind,
  derivedFrom: row.derivedFrom ?? undefined,
  attachmentPolicy: row.attachmentPolicy as AttachmentPolicy,
  enabledAt: row.enabledAt,
  cursorMessageId: row.cursorMessageId ?? undefined,
  backfillState: row.backfillState as BackfillState,
  threadsFound: row.threadsFound ?? undefined,
  threadsDone: row.threadsDone,
  includeThreads: row.includeThreads !== 0,
});

/** Inserts the channel row; a replayed enable is a no-op reported as such. */
export const enableChannel = (
  scope: GuildScope,
  input: {
    channelId: string;
    attachmentPolicy: AttachmentPolicy;
    now: number;
    scopeKind?: 'channel' | 'category';
  },
): 'enabled' | 'already-enabled' =>
  write(scope, ({ db }) => {
    const result = db
      .insert(archiveChannels)
      .values({
        guildId: scope.guildId,
        channelId: input.channelId,
        attachmentPolicy: input.attachmentPolicy,
        scopeKind: input.scopeKind ?? 'channel',
        derivedFrom: null,
        enabledAt: input.now,
        cursorMessageId: null,
        backfillState: 'pending',
      })
      .onConflictDoNothing({ target: [archiveChannels.guildId, archiveChannels.channelId] })
      .run();
    if (result.changes === 1) return 'enabled';

    // An explicit enable over a derived row upgrades it into the row the
    // operator asked for: the derived row only ever satisfied the foreign
    // key, and its archived messages stay attached through the upgrade.
    const existing = db
      .select({ scopeKind: archiveChannels.scopeKind })
      .from(archiveChannels)
      .where(scope.only(archiveChannels, eq(archiveChannels.channelId, input.channelId)))
      .get();
    if (existing?.scopeKind !== 'derived') return 'already-enabled';
    db.update(archiveChannels)
      .set({
        scopeKind: input.scopeKind ?? 'channel',
        derivedFrom: null,
        attachmentPolicy: input.attachmentPolicy,
        enabledAt: input.now,
        cursorMessageId: null,
        backfillState: 'pending',
      })
      .where(
        scope.only(
          archiveChannels,
          sql`${archiveChannels.channelId} = ${input.channelId} AND ${archiveChannels.scopeKind} = 'derived'`,
        ),
      )
      .run();
    return 'enabled';
  });

/**
 * Materialises a derived row for a category-covered channel (ADR 0047
 * amendment 2026-09-20): it satisfies `archive_messages`' composite foreign
 * key and owns the cascade, and nothing else. Authorization never reads it —
 * `isChannelEnabled`, `hasCategoryRow` and `parentIncludesThreads` all skip
 * derived rows, so scope keeps resolving from the category row at use time.
 *
 * Idempotent, and never overwrites an operator-written row: any existing row
 * — derived, channel or category — is reported as already present.
 */
export const ensureDerivedChannel = (
  scope: GuildScope,
  input: {
    channelId: string;
    categoryId: string;
    attachmentPolicy: AttachmentPolicy;
    now: number;
  },
): 'created' | 'already-present' =>
  write(scope, ({ db }) => {
    const result = db
      .insert(archiveChannels)
      .values({
        guildId: scope.guildId,
        channelId: input.channelId,
        scopeKind: 'derived',
        derivedFrom: input.categoryId,
        attachmentPolicy: input.attachmentPolicy,
        enabledAt: input.now,
        cursorMessageId: null,
        backfillState: 'pending',
      })
      .onConflictDoNothing({ target: [archiveChannels.guildId, archiveChannels.channelId] })
      .run();
    return result.changes === 1 ? 'created' : 'already-present';
  });

export const setIncludeThreads = (
  scope: GuildScope,
  channelId: string,
  includeThreads: boolean,
): boolean =>
  write(
    scope,
    ({ db }) =>
      db
        .update(archiveChannels)
        .set({ includeThreads: includeThreads ? 1 : 0 })
        .where(scope.only(archiveChannels, eq(archiveChannels.channelId, channelId)))
        .run().changes === 1,
  );

/**
 * Deletes the explicitly-enabled channel row; the messages, edits and
 * attachments cascade in the schema.
 *
 * Kind-scoped (review S1): the predicate names `scope_kind = 'channel'`, so
 * `archive disable-channel <categoryId>` can no longer delete a category row
 * and report it as a channel. A row of another kind is a refusal, not a
 * silent delete and not a misleading `'not-enabled'`.
 *
 * A derived row answers `'derived'` rather than `'wrong-kind'` (review 2 N1):
 * "this is archived as a category, use disable-category" is false of a
 * derived row, and `disable-category` refused it in turn, so the two verbs
 * sent the operator in a circle with no way to act on the row at all. Only
 * the caller knows whether the channel is still covered — that is a live
 * cache fact, not a stored one — so the decision belongs above this layer.
 */
export const disableChannel = (
  scope: GuildScope,
  channelId: string,
): 'disabled' | 'not-enabled' | 'wrong-kind' | 'derived' =>
  write(scope, ({ db }) => {
    const result = db
      .delete(archiveChannels)
      .where(
        scope.only(
          archiveChannels,
          sql`${archiveChannels.channelId} = ${channelId} AND ${archiveChannels.scopeKind} = 'channel'`,
        ),
      )
      .run();
    if (result.changes === 1) return 'disabled';
    const other = db
      .select({ scopeKind: archiveChannels.scopeKind })
      .from(archiveChannels)
      .where(scope.only(archiveChannels, eq(archiveChannels.channelId, channelId)))
      .get();
    if (other === undefined) return 'not-enabled';
    return other.scopeKind === 'derived' ? 'derived' : 'wrong-kind';
  });

/**
 * Deletes a derived row and cascades its messages (review 2 N1).
 *
 * The caller has already established that the channel is no longer covered
 * by an enabled category — a derived row whose channel is still covered
 * would simply be re-materialised by the next message, so destroying its
 * history there would be a delete that disables nothing. ADR 0047's
 * amendment says an orphaned derived row keeps its history "matching what an
 * explicit `disable-channel` would have destroyed only by operator choice";
 * this is the verb that makes that choice available.
 */
export const disableDerivedChannel = (
  scope: GuildScope,
  channelId: string,
):
  | { readonly outcome: 'disabled'; readonly messageCount: number }
  | { readonly outcome: 'not-derived' } =>
  write(scope, ({ db }) => {
    const row = db
      .select({ scopeKind: archiveChannels.scopeKind })
      .from(archiveChannels)
      .where(scope.only(archiveChannels, eq(archiveChannels.channelId, channelId)))
      .get();
    if (row?.scopeKind !== 'derived') return { outcome: 'not-derived' };
    const messageCount =
      db
        .select({ n: count() })
        .from(archiveMessages)
        .where(scope.only(archiveMessages, eq(archiveMessages.channelId, channelId)))
        .get()?.n ?? 0;
    db.delete(archiveChannels)
      .where(
        scope.only(
          archiveChannels,
          sql`${archiveChannels.channelId} = ${channelId} AND ${archiveChannels.scopeKind} = 'derived'`,
        ),
      )
      .run();
    return { outcome: 'disabled', messageCount };
  });

/** What `disableCategory` destroyed, or why it refused. */
export type DisableCategoryOutcome =
  | { readonly outcome: 'disabled'; readonly messageCount: number }
  | { readonly outcome: 'not-enabled' }
  | { readonly outcome: 'wrong-kind' };

/**
 * Deletes the category row and its derived children; every message archived
 * under those rows cascades in the schema, the way `disableChannel`'s do
 * (ADR 0047 amendment 2026-09-20).
 *
 * The count is taken before the delete and covers the derived children's
 * messages — the category id itself never owns messages, so counting under
 * it would report `0 archived message(s) removed` regardless (review M4).
 */
export const disableCategory = (scope: GuildScope, categoryId: string): DisableCategoryOutcome =>
  write(scope, ({ db }) => {
    const row = db
      .select({ scopeKind: archiveChannels.scopeKind })
      .from(archiveChannels)
      .where(scope.only(archiveChannels, eq(archiveChannels.channelId, categoryId)))
      .get();
    if (row === undefined) return { outcome: 'not-enabled' };
    if (row.scopeKind !== 'category') return { outcome: 'wrong-kind' };

    const derivedChildren = db
      .select({ channelId: archiveChannels.channelId })
      .from(archiveChannels)
      .where(scope.only(archiveChannels, eq(archiveChannels.derivedFrom, categoryId)))
      .all()
      .map((child) => child.channelId);
    const messageCount =
      derivedChildren.length === 0
        ? 0
        : (db
            .select({ n: count() })
            .from(archiveMessages)
            .where(scope.only(archiveMessages, inArray(archiveMessages.channelId, derivedChildren)))
            .get()?.n ?? 0);

    db.delete(archiveChannels)
      .where(scope.only(archiveChannels, eq(archiveChannels.derivedFrom, categoryId)))
      .run();
    db.delete(archiveChannels)
      .where(
        scope.only(
          archiveChannels,
          sql`${archiveChannels.channelId} = ${categoryId} AND ${archiveChannels.scopeKind} = 'category'`,
        ),
      )
      .run();
    return { outcome: 'disabled', messageCount };
  });

/**
 * Whether the channel has its OWN row (review B1: never a derived row —
 * `isInScope`'s `hasOwnRow` decides scope, and a derived row is not a scope
 * grant). A category row under the same id does not count either.
 */
export const isChannelEnabled = (scope: GuildScope, channelId: string): boolean =>
  read(
    scope,
    (db) =>
      db
        .select({ channelId: archiveChannels.channelId })
        .from(archiveChannels)
        .where(
          scope.only(
            archiveChannels,
            sql`${archiveChannels.channelId} = ${channelId} AND ${archiveChannels.scopeKind} = 'channel'`,
          ),
        )
        .get() !== undefined,
  );

export const hasCategoryRow = (scope: GuildScope, channelId: string): boolean =>
  read(
    scope,
    (db) =>
      db
        .select({ channelId: archiveChannels.channelId })
        .from(archiveChannels)
        .where(
          scope.only(
            archiveChannels,
            sql`${archiveChannels.channelId} = ${channelId} AND ${archiveChannels.scopeKind} = 'category'`,
          ),
        )
        .get() !== undefined,
  );

/**
 * The parent channel's own include-threads flag, defaulting to true when it
 * has no explicit row. Derived rows are skipped (review B1): a thread's
 * inheritance is decided by the parent's own row or by the default, never by
 * a row that exists only to satisfy the foreign key.
 */
export const parentIncludesThreads = (scope: GuildScope, channelId: string): boolean =>
  read(
    scope,
    (db) =>
      db
        .select({ includeThreads: archiveChannels.includeThreads })
        .from(archiveChannels)
        .where(
          scope.only(
            archiveChannels,
            sql`${archiveChannels.channelId} = ${channelId} AND ${archiveChannels.scopeKind} = 'channel'`,
          ),
        )
        .get()?.includeThreads !== 0,
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

export const setThreadProgress = (
  scope: GuildScope,
  input: { channelId: string; found: number; done: number },
): void =>
  write(scope, ({ db }) => {
    db.update(archiveChannels)
      .set({ threadsFound: input.found, threadsDone: input.done })
      .where(scope.only(archiveChannels, eq(archiveChannels.channelId, input.channelId)))
      .run();
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
    // ADR 0047 amendment 2026-09-20: `archive_messages`' composite foreign
    // key needs a parent row for `input.channelId`. A category-covered
    // channel has none, so the first write materialises the derived row in
    // this same transaction. A write naming a channel with no row and no
    // category to derive from is a bug in the caller — the subscriber only
    // writes in-scope messages — and is refused loudly rather than surfaced
    // as a bare foreign-key error.
    const parentRow = db
      .select({ channelId: archiveChannels.channelId })
      .from(archiveChannels)
      .where(scope.only(archiveChannels, eq(archiveChannels.channelId, input.channelId)))
      .get();
    if (parentRow === undefined) {
      if (input.categoryId === undefined) {
        throw new Error(
          `archive: upsert for channel ${input.channelId} has no archive_channels row ` +
            'and no category id to derive one from',
        );
      }
      db.insert(archiveChannels)
        .values({
          guildId: scope.guildId,
          channelId: input.channelId,
          scopeKind: 'derived',
          derivedFrom: input.categoryId,
          attachmentPolicy: 'none',
          enabledAt: input.createdAt,
          cursorMessageId: null,
          backfillState: 'pending',
        })
        .onConflictDoNothing({ target: [archiveChannels.guildId, archiveChannels.channelId] })
        .run();
    }

    const result = db
      .insert(archiveMessages)
      .values({
        guildId: scope.guildId,
        messageId: input.messageId,
        channelId: input.channelId,
        threadId: input.threadId ?? null,
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
    .select({ status: modCases.status, openedAt: modCases.openedAt })
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
  if (latest !== undefined) return latest.at;
  // A closed case with zero events has no latest event to start the 90-day
  // clock from. Fall back to the case's `openedAt`: deliberately
  // conservative-in-the-other-direction — a closed case's messages must not
  // be retained forever just because nothing was logged against it.
  return kase.openedAt;
};

/**
 * The one read on `mod_case_events` this module owns: the latest event
 * timestamp for a closed case (or the case's `openedAt` when a closed case
 * has no events), else undefined — for an open case and an unknown case
 * alike. Read-only.
 */
export const caseClosedAt = (scope: GuildScope, caseId: string): number | undefined =>
  read(scope, (db) => caseClosedAtOn(db, scope, caseId));

/**
 * The three tiers (ADR 0046 D3), in one transaction.
 *
 * Purges content (`content = NULL`, `content_purged_at = now`) and deletes
 * the message's edit rows AND its attachment metadata rows (a filename is
 * content too), for rows where `deleted_at` is set and `content_purged_at`
 * is still NULL — a deleted row whose `content` is already NULL (an
 * attachment-only or embed-only message stores `content = NULL`) still has
 * filenames and edit history to remove, and still gets its
 * `content_purged_at` stamped — and:
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
          isNull(archiveMessages.contentPurgedAt),
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

/**
 * One archived message row, including a purged one (ADR 0049 Amendment 1 D7).
 *
 * `content` is NULL after purge, or never known; a purged row keeps its
 * tombstone — `contentPurgedAt` set — and stays reachable by id even though it
 * has left the search index.
 */
export interface ArchiveMessage {
  readonly messageId: string;
  readonly channelId: string;
  readonly threadId: string | undefined;
  readonly authorId: string | undefined;
  readonly content: string | null;
  readonly createdAt: number;
  readonly editedAt: number | undefined;
  readonly deletedAt: number | undefined;
  readonly retentionClass: RetentionClass;
  readonly caseId: string | undefined;
  readonly contentPurgedAt: number | undefined;
}

const toArchiveMessage = (row: typeof archiveMessages.$inferSelect): ArchiveMessage => ({
  messageId: row.messageId,
  channelId: row.channelId,
  threadId: row.threadId ?? undefined,
  authorId: row.authorId ?? undefined,
  content: row.content,
  createdAt: row.createdAt,
  editedAt: row.editedAt ?? undefined,
  deletedAt: row.deletedAt ?? undefined,
  retentionClass: row.retentionClass as RetentionClass,
  caseId: row.caseId ?? undefined,
  contentPurgedAt: row.contentPurgedAt ?? undefined,
});

/** The row by id, including a purged one — the tombstone is the point. */
export const findMessage = (scope: GuildScope, messageId: string): ArchiveMessage | undefined =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(archiveMessages)
      .where(scope.only(archiveMessages, eq(archiveMessages.messageId, messageId)))
      .get();
    return row === undefined ? undefined : toArchiveMessage(row);
  });

const LIST_CHANNEL_HISTORY_LIMIT_DEFAULT = 20;

/**
 * One channel's archived messages, newest first (Ruling M4-D3).
 *
 * Newest first means ordered numerically by `message_id` descending.
 * Discord snowflakes are time-ordered as numbers, not as strings, so the
 * query orders by digit count then value (`length(message_id) DESC,
 * message_id DESC`): that is numeric order for digit strings without an
 * integer cast, which would overflow at 20 digits (SQLite integers are
 * signed 64-bit). The `beforeMessageId` cursor uses the same comparison —
 * fewer digits, or the same length and lexically below — so paging stays
 * stable across the length boundary.
 *
 * The same visibility rule `searchMessages` enforces: the visible set is the
 * guild's archive-enabled channels, built here from `archive_channels` —
 * never from caller input. A channel not in `archive_channels` returns an
 * empty list, not an error, so the call cannot reveal whether the channel
 * exists. A purged message is returned as its tombstone (`content: null`,
 * metadata intact), never omitted.
 *
 * `limit` is capped at `SEARCH_LIMIT_MAX` (100), reused rather than
 * re-numbered. An absent, non-finite, or zero-or-negative limit is treated as
 * the default (20); a fractional limit is floored.
 */
export const listChannelHistory = (
  scope: GuildScope,
  input: {
    readonly channelId: string;
    readonly beforeMessageId?: string;
    readonly limit?: number;
    /**
     * ADR 0047 amendment 2026-09-20 (M1): a forum owns no messages of its
     * own — every post is a thread — so a forum's history read rolls its
     * posts up under the forum id. The daemon wiring sets this from the
     * live cache (GuildForum); a plain channel read keeps its threadless
     * shape.
     */
    readonly includeThreads?: boolean;
  },
): readonly ArchiveMessage[] =>
  read(scope, (db) => {
    const channel = db
      .select({ channelId: archiveChannels.channelId })
      .from(archiveChannels)
      .where(scope.only(archiveChannels, eq(archiveChannels.channelId, input.channelId)))
      .get();
    const threadExists =
      db
        .select({ threadId: archiveMessages.threadId })
        .from(archiveMessages)
        .where(scope.only(archiveMessages, eq(archiveMessages.threadId, input.channelId)))
        .get() !== undefined;
    if (channel === undefined && !threadExists) return [];

    const wanted = input.limit;
    const limit =
      wanted === undefined || !Number.isFinite(wanted) || Math.floor(wanted) <= 0
        ? LIST_CHANNEL_HISTORY_LIMIT_DEFAULT
        : Math.min(Math.floor(wanted), SEARCH_LIMIT_MAX);

    return db
      .select()
      .from(archiveMessages)
      .where(
        scope.only(
          archiveMessages,
          threadExists
            ? eq(archiveMessages.threadId, input.channelId)
            : eq(archiveMessages.channelId, input.channelId),
          threadExists || input.includeThreads === true
            ? undefined
            : isNull(archiveMessages.threadId),
          input.beforeMessageId === undefined
            ? undefined
            : sql`(length(${archiveMessages.messageId}) < length(${input.beforeMessageId}) OR (length(${archiveMessages.messageId}) = length(${input.beforeMessageId}) AND ${archiveMessages.messageId} < ${input.beforeMessageId}))`,
        ),
      )
      .orderBy(sql`length(${archiveMessages.messageId}) DESC`, desc(archiveMessages.messageId))
      .limit(limit)
      .all()
      .map(toArchiveMessage);
  });
