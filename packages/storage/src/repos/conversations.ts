import { and, asc, desc, eq, gt, inArray, like, lt } from 'drizzle-orm';
import type { KnownMessage } from '@bananasaurs/core';
import {
  assistantConversationMessages,
  assistantConversationTurns,
  assistantConversations,
} from '../schema.js';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';

export type ConversationSource = 'discord' | 'dashboard-test';
export type ConversationStatus = 'open' | 'ended';
export type TurnRole = 'user' | 'assistant' | 'quote';
export type MessageRole = 'user' | 'assistant';
export type Feedback = 'up' | 'down';

export interface NewConversation {
  readonly conversationId: string;
  readonly channelId: string;
  readonly behaviourId: string;
  readonly startedBy: string;
  readonly title: string;
  readonly source: ConversationSource;
  readonly at: number;
}

export interface Conversation {
  readonly conversationId: string;
  readonly channelId: string;
  readonly behaviourId: string;
  readonly startedBy: string;
  readonly title: string;
  readonly source: ConversationSource;
  readonly status: ConversationStatus;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly turnCount: number;
}

export interface NewTurn {
  readonly conversationId: string;
  readonly turnId: string;
  readonly at: number;
  readonly role: TurnRole;
  readonly authorId?: string | undefined;
  readonly authorName: string;
  readonly text: string;
  readonly traceId?: string | undefined;
}

export interface ConversationTurn {
  readonly turnId: string;
  readonly at: number;
  readonly role: TurnRole;
  readonly authorId?: string | undefined;
  readonly authorName: string;
  readonly text: string;
  readonly traceId?: string | undefined;
  readonly feedback?: Feedback | undefined;
}

export interface ConversationListQuery {
  readonly sort: 'last-activity' | 'started' | 'turns';
  readonly order: 'desc' | 'asc';
  readonly channelId?: string;
  readonly userId?: string;
  readonly behaviourId?: string;
  readonly search?: string;
  readonly before?: number;
  readonly limit: number;
}

const toConversation = (row: typeof assistantConversations.$inferSelect): Conversation => ({
  conversationId: row.conversationId,
  channelId: row.channelId,
  behaviourId: row.behaviourId,
  startedBy: row.startedBy,
  title: row.title,
  source: row.source as ConversationSource,
  status: row.status as ConversationStatus,
  createdAt: row.createdAt,
  lastActivityAt: row.lastActivityAt,
  turnCount: row.turnCount,
});

const toTurn = (row: typeof assistantConversationTurns.$inferSelect): ConversationTurn => ({
  turnId: row.turnId,
  at: row.at,
  role: row.role as TurnRole,
  authorId: row.authorId ?? undefined,
  authorName: row.authorName,
  text: row.text,
  traceId: row.traceId ?? undefined,
  feedback: (row.feedback as Feedback | null) ?? undefined,
});

/** Starts a conversation, `open`, with zero turns. */
export const createConversation = (scope: GuildScope, c: NewConversation): void =>
  write(scope, ({ db }) => {
    db.insert(assistantConversations)
      .values({
        guildId: scope.guildId,
        conversationId: c.conversationId,
        channelId: c.channelId,
        behaviourId: c.behaviourId,
        startedBy: c.startedBy,
        title: c.title,
        source: c.source,
        status: 'open',
        createdAt: c.at,
        lastActivityAt: c.at,
        turnCount: 0,
      })
      .run();
  });

/** Appends a turn and bumps the parent conversation's last_activity_at/turn_count. */
export const appendTurn = (scope: GuildScope, t: NewTurn): void =>
  write(scope, ({ db }) => {
    db.insert(assistantConversationTurns)
      .values({
        guildId: scope.guildId,
        conversationId: t.conversationId,
        turnId: t.turnId,
        at: t.at,
        role: t.role,
        authorId: t.authorId ?? null,
        authorName: t.authorName,
        text: t.text,
        traceId: t.traceId ?? null,
        feedback: null,
      })
      .run();
    const parent = db
      .select({ turnCount: assistantConversations.turnCount })
      .from(assistantConversations)
      .where(
        scope.only(
          assistantConversations,
          eq(assistantConversations.conversationId, t.conversationId),
        ),
      )
      .get();
    db.update(assistantConversations)
      .set({ lastActivityAt: t.at, turnCount: (parent?.turnCount ?? 0) + 1 })
      .where(
        scope.only(
          assistantConversations,
          eq(assistantConversations.conversationId, t.conversationId),
        ),
      )
      .run();
  });

/**
 * Links Discord message ids to the turn that produced them. Idempotent: a
 * message id already linked (its PK is `[guild_id, message_id]`) is left
 * alone rather than erroring — a job that replays after a partial post must
 * not double-link.
 */
export const linkMessages = (
  scope: GuildScope,
  conversationId: string,
  turnId: string,
  role: MessageRole,
  messageIds: readonly string[],
): void =>
  write(scope, ({ db }) => {
    for (const messageId of messageIds) {
      db.insert(assistantConversationMessages)
        .values({ guildId: scope.guildId, messageId, conversationId, turnId, role })
        .onConflictDoNothing({
          target: [assistantConversationMessages.guildId, assistantConversationMessages.messageId],
        })
        .run();
    }
  });

/**
 * Whether a message id is known — a `user` or `assistant` turn's linked
 * message — and if so which conversation and behaviour it belongs to. A
 * `quote` turn's source message is never linked (see the `KnownMessage` doc
 * comment in `@bananasaurs/core`), so this can never report `role: 'quote'`.
 */
export const lookupMessage = (scope: GuildScope, messageId: string): KnownMessage | undefined =>
  read(scope, (db) => {
    const row = db
      .select({
        conversationId: assistantConversationMessages.conversationId,
        role: assistantConversationMessages.role,
        channelId: assistantConversations.channelId,
        behaviourId: assistantConversations.behaviourId,
      })
      .from(assistantConversationMessages)
      .innerJoin(
        assistantConversations,
        and(
          eq(assistantConversationMessages.guildId, assistantConversations.guildId),
          eq(assistantConversationMessages.conversationId, assistantConversations.conversationId),
        ),
      )
      .where(
        scope.only(
          assistantConversationMessages,
          eq(assistantConversationMessages.messageId, messageId),
        ),
      )
      .get();
    if (row === undefined) return undefined;
    return {
      conversationId: row.conversationId,
      role: row.role as MessageRole,
      channelId: row.channelId,
      behaviourId: row.behaviourId,
    };
  });

/** The author's most recent `open` conversation in this channel, if any. */
export const latestForAuthor = (
  scope: GuildScope,
  authorId: string,
  channelId: string,
): { conversationId: string; lastActivityAt: number } | undefined =>
  read(scope, (db) => {
    const row = db
      .select({
        conversationId: assistantConversations.conversationId,
        lastActivityAt: assistantConversations.lastActivityAt,
      })
      .from(assistantConversations)
      .innerJoin(
        assistantConversationTurns,
        and(
          eq(assistantConversationTurns.guildId, assistantConversations.guildId),
          eq(assistantConversationTurns.conversationId, assistantConversations.conversationId),
        ),
      )
      .where(
        scope.only(
          assistantConversations,
          eq(assistantConversations.channelId, channelId),
          eq(assistantConversations.status, 'open'),
          eq(assistantConversationTurns.authorId, authorId),
        ),
      )
      .orderBy(desc(assistantConversations.lastActivityAt))
      .limit(1)
      .get();
    return row;
  });

/**
 * The last `maxTurns` turns, capped to `maxChars` total, returned oldest
 * first.
 *
 * The conversation's opening `quote` turn (if it has one) is always kept —
 * it is the context the conversation was started to answer — even when the
 * turn-count window would otherwise have aged it out; it still counts
 * against `maxChars`. The newest turn is never dropped for being too long:
 * if it alone exceeds `maxChars`, it is truncated to its last `maxChars`
 * characters instead. Every other turn in the window is dropped, oldest
 * first, once the remaining budget cannot fit it.
 */
export const recentTurns = (
  scope: GuildScope,
  conversationId: string,
  opts: { maxTurns: number; maxChars: number },
): ConversationTurn[] =>
  read(scope, (db) => {
    const firstRow = db
      .select()
      .from(assistantConversationTurns)
      .where(
        scope.only(
          assistantConversationTurns,
          eq(assistantConversationTurns.conversationId, conversationId),
        ),
      )
      .orderBy(asc(assistantConversationTurns.at), asc(assistantConversationTurns.turnId))
      .limit(1)
      .get();

    const pinnedQuote = firstRow !== undefined && firstRow.role === 'quote' ? firstRow : undefined;
    if (pinnedQuote !== undefined && pinnedQuote.text.length > opts.maxChars) {
      const text = pinnedQuote.text.slice(pinnedQuote.text.length - opts.maxChars);
      return [toTurn({ ...pinnedQuote, text })];
    }

    const quoteLen = pinnedQuote?.text.length ?? 0;
    const budget = opts.maxChars - quoteLen;
    if (pinnedQuote !== undefined && budget <= 0) {
      return [toTurn(pinnedQuote)];
    }

    const windowRows = db
      .select()
      .from(assistantConversationTurns)
      .where(
        scope.only(
          assistantConversationTurns,
          eq(assistantConversationTurns.conversationId, conversationId),
        ),
      )
      .orderBy(desc(assistantConversationTurns.at), desc(assistantConversationTurns.turnId))
      .limit(opts.maxTurns)
      .all();
    const nonQuoteNewestFirst =
      pinnedQuote === undefined
        ? windowRows
        : windowRows.filter((r) => r.turnId !== pinnedQuote.turnId);

    const result: ConversationTurn[] = [];
    let total = 0;
    let budgetExhausted = false;
    for (let i = 0; i < nonQuoteNewestFirst.length; i += 1) {
      const row = nonQuoteNewestFirst[i]!;
      const isNewest = i === 0;
      let text = row.text;
      if (isNewest && text.length > budget) {
        text = text.slice(text.length - budget);
      }
      if (budgetExhausted) continue;
      if (!isNewest && total + text.length > budget) {
        budgetExhausted = true;
        continue;
      }
      result.unshift(toTurn({ ...row, text }));
      total += text.length;
    }
    if (pinnedQuote === undefined) return result;
    return [toTurn(pinnedQuote), ...result];
  });

const SORT_COLUMN = {
  'last-activity': assistantConversations.lastActivityAt,
  started: assistantConversations.createdAt,
  turns: assistantConversations.turnCount,
} as const;

/** Newest (or oldest) first, filtered and paged by `q`. */
export const listConversations = (scope: GuildScope, q: ConversationListQuery): Conversation[] =>
  read(scope, (db) => {
    const column = SORT_COLUMN[q.sort];
    const dir = q.order === 'asc' ? asc : desc;
    const cursor =
      q.before === undefined
        ? undefined
        : q.order === 'asc'
          ? gt(column, q.before)
          : lt(column, q.before);
    const rows = db
      .select()
      .from(assistantConversations)
      .where(
        scope.only(
          assistantConversations,
          q.channelId === undefined ? undefined : eq(assistantConversations.channelId, q.channelId),
          q.userId === undefined ? undefined : eq(assistantConversations.startedBy, q.userId),
          q.behaviourId === undefined
            ? undefined
            : eq(assistantConversations.behaviourId, q.behaviourId),
          q.search === undefined ? undefined : like(assistantConversations.title, `%${q.search}%`),
          cursor,
        ),
      )
      .orderBy(dir(column), dir(assistantConversations.conversationId))
      .limit(q.limit)
      .all();
    return rows.map(toConversation);
  });

export const getConversation = (scope: GuildScope, id: string): Conversation | undefined =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(assistantConversations)
      .where(scope.only(assistantConversations, eq(assistantConversations.conversationId, id)))
      .get();
    return row === undefined ? undefined : toConversation(row);
  });

export const endConversation = (scope: GuildScope, id: string): void =>
  write(scope, ({ db }) => {
    db.update(assistantConversations)
      .set({ status: 'ended' })
      .where(scope.only(assistantConversations, eq(assistantConversations.conversationId, id)))
      .run();
  });

/** Cascades to its turns and message links. */
export const deleteConversation = (scope: GuildScope, id: string): void =>
  write(scope, ({ db }) => {
    db.delete(assistantConversations)
      .where(scope.only(assistantConversations, eq(assistantConversations.conversationId, id)))
      .run();
  });

/** Sets feedback on the turn a message belongs to. Returns false when the message is unknown. */
export const setFeedback = (scope: GuildScope, messageId: string, feedback: Feedback): boolean =>
  write(scope, ({ db }) => {
    const link = db
      .select({ turnId: assistantConversationMessages.turnId })
      .from(assistantConversationMessages)
      .where(
        scope.only(
          assistantConversationMessages,
          eq(assistantConversationMessages.messageId, messageId),
        ),
      )
      .get();
    if (link === undefined) return false;
    db.update(assistantConversationTurns)
      .set({ feedback })
      .where(
        scope.only(assistantConversationTurns, eq(assistantConversationTurns.turnId, link.turnId)),
      )
      .run();
    return true;
  });

/** Deletes every conversation whose `last_activity_at` is older than `cutoff`. */
export const pruneOlderThan = (
  scope: GuildScope,
  cutoff: number,
): { conversations: number; ids: string[] } =>
  write(scope, ({ db }) => {
    const rows = db
      .select({ conversationId: assistantConversations.conversationId })
      .from(assistantConversations)
      .where(scope.only(assistantConversations, lt(assistantConversations.lastActivityAt, cutoff)))
      .all();
    const ids = rows.map((r) => r.conversationId);
    if (ids.length > 0) {
      db.delete(assistantConversations)
        .where(
          scope.only(assistantConversations, inArray(assistantConversations.conversationId, ids)),
        )
        .run();
    }
    return { conversations: ids.length, ids };
  });

/**
 * Deletes every turn authored by this user, then removes any conversation
 * that as a result no longer has a `user` turn — a conversation with none is
 * nothing but the assistant's side of a deleted member's questions. Returns
 * the number of turns deleted.
 */
export const forgetAuthor = (scope: GuildScope, userId: string): number =>
  write(scope, ({ db }) => {
    const touched = db
      .select({ conversationId: assistantConversationTurns.conversationId })
      .from(assistantConversationTurns)
      .where(
        scope.only(assistantConversationTurns, eq(assistantConversationTurns.authorId, userId)),
      )
      .all();
    const touchedIds = [...new Set(touched.map((r) => r.conversationId))];

    const deleted = db
      .delete(assistantConversationTurns)
      .where(
        scope.only(assistantConversationTurns, eq(assistantConversationTurns.authorId, userId)),
      )
      .run().changes;

    if (touchedIds.length > 0) {
      const remaining = db
        .select({ conversationId: assistantConversationTurns.conversationId })
        .from(assistantConversationTurns)
        .where(
          scope.only(
            assistantConversationTurns,
            inArray(assistantConversationTurns.conversationId, touchedIds),
            eq(assistantConversationTurns.role, 'user'),
          ),
        )
        .all();
      const stillHasUserTurn = new Set(remaining.map((r) => r.conversationId));
      const orphaned = touchedIds.filter((id) => !stillHasUserTurn.has(id));
      if (orphaned.length > 0) {
        db.delete(assistantConversations)
          .where(
            scope.only(
              assistantConversations,
              inArray(assistantConversations.conversationId, orphaned),
            ),
          )
          .run();
      }
    }

    return deleted;
  });
