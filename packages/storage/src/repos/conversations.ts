import { and, asc, desc, eq, gte, gt, inArray, like, lt, sql } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import type { JoinRule, KnownMessage } from '@bananasaurs/core';
import {
  conversationSummarySchema,
  renderSummary,
  type ConversationSummary,
} from '@bananasaurs/core';
import {
  assistantConversationLinks,
  assistantConversationMessages,
  assistantConversationTurns,
  assistantConversations,
} from '../schema.js';
import type { Db } from '../db.js';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { sanitiseFtsQuery } from './resource-cache.js';

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
  readonly joinRule?: JoinRule | undefined;
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
  readonly joinRule?: JoinRule | undefined;
}

export interface ConversationLink {
  readonly otherConversationId: string;
  readonly otherTitle: string;
  readonly kind: 'same-channel' | 'thread-parent' | 'recalled';
  readonly direction: 'outgoing' | 'incoming';
  readonly at: number;
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
  joinRule: (row.joinRule as JoinRule | null) ?? undefined,
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
        joinRule: t.joinRule ?? null,
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

/** Every Discord message id linked to one conversation (ADR 0089 channel context exclusion). */
export const messageIdsForConversation = (scope: GuildScope, conversationId: string): string[] =>
  read(scope, (db) =>
    db
      .select({ messageId: assistantConversationMessages.messageId })
      .from(assistantConversationMessages)
      .where(
        scope.only(
          assistantConversationMessages,
          eq(assistantConversationMessages.conversationId, conversationId),
        ),
      )
      .all()
      .map((row) => row.messageId),
  );

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

export const latestWithBotReply = (
  scope: GuildScope,
  channelId: string,
): { conversationId: string } | undefined =>
  read(scope, (db) =>
    db
      .select({ conversationId: assistantConversations.conversationId })
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
          eq(assistantConversations.source, 'discord'),
          eq(assistantConversationTurns.role, 'assistant'),
        ),
      )
      .orderBy(desc(assistantConversations.lastActivityAt))
      .limit(1)
      .get(),
  );

export const withBotReplySince = (
  scope: GuildScope,
  channelId: string,
  sinceMs: number,
): readonly string[] =>
  read(scope, (db) => {
    const rows = db
      .select({ conversationId: assistantConversations.conversationId })
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
          eq(assistantConversations.source, 'discord'),
          eq(assistantConversationTurns.role, 'assistant'),
          gte(assistantConversationTurns.at, sinceMs),
        ),
      )
      .all();
    return [...new Set(rows.map((row) => row.conversationId))];
  });

export const linkConversations = (
  scope: GuildScope,
  link: {
    readonly conversationId: string;
    readonly linkedConversationId: string;
    readonly kind: 'same-channel' | 'thread-parent' | 'recalled';
    readonly at: number;
  },
): void => {
  if (link.conversationId === link.linkedConversationId) return;
  write(scope, ({ db }) => {
    db.insert(assistantConversationLinks)
      .values({
        guildId: scope.guildId,
        conversationId: link.conversationId,
        linkedConversationId: link.linkedConversationId,
        kind: link.kind,
        createdAt: link.at,
      })
      .onConflictDoNothing()
      .run();
  });
};

export const listLinks = (scope: GuildScope, conversationId: string): ConversationLink[] =>
  read(scope, (db) => {
    const outgoing = db
      .select({
        otherConversationId: assistantConversations.conversationId,
        otherTitle: assistantConversations.title,
        kind: assistantConversationLinks.kind,
        at: assistantConversationLinks.createdAt,
      })
      .from(assistantConversationLinks)
      .innerJoin(
        assistantConversations,
        and(
          eq(assistantConversationLinks.guildId, assistantConversations.guildId),
          eq(
            assistantConversationLinks.linkedConversationId,
            assistantConversations.conversationId,
          ),
        ),
      )
      .where(
        scope.only(
          assistantConversationLinks,
          eq(assistantConversationLinks.conversationId, conversationId),
        ),
      )
      .all()
      .map((row) => ({
        ...row,
        kind: row.kind as ConversationLink['kind'],
        direction: 'outgoing' as const,
      }));
    const incoming = db
      .select({
        otherConversationId: assistantConversations.conversationId,
        otherTitle: assistantConversations.title,
        kind: assistantConversationLinks.kind,
        at: assistantConversationLinks.createdAt,
      })
      .from(assistantConversationLinks)
      .innerJoin(
        assistantConversations,
        and(
          eq(assistantConversationLinks.guildId, assistantConversations.guildId),
          eq(assistantConversationLinks.conversationId, assistantConversations.conversationId),
        ),
      )
      .where(
        scope.only(
          assistantConversationLinks,
          eq(assistantConversationLinks.linkedConversationId, conversationId),
        ),
      )
      .all()
      .map((row) => ({
        ...row,
        kind: row.kind as ConversationLink['kind'],
        direction: 'incoming' as const,
      }));
    return [...outgoing, ...incoming].sort((a, b) => b.at - a.at);
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

/** Hard safety cap for `listTurns`: the transcript has no context window. */
export const LIST_TURNS_LIMIT = 2_000;

/**
 * Every turn of one conversation, oldest first. Unlike `recentTurns` there is
 * no context window — only the 2,000-turn safety cap — so the transcript route
 * reads the whole conversation in one query.
 */
export const listTurns = (scope: GuildScope, conversationId: string): ConversationTurn[] =>
  read(scope, (db) => {
    const rows = db
      .select()
      .from(assistantConversationTurns)
      .where(
        scope.only(
          assistantConversationTurns,
          eq(assistantConversationTurns.conversationId, conversationId),
        ),
      )
      .orderBy(asc(assistantConversationTurns.at), asc(assistantConversationTurns.turnId))
      .limit(LIST_TURNS_LIMIT)
      .all();
    return rows.map(toTurn);
  });

/**
 * Distinct human author names (`user` and `quote` turns; `assistant` turns are
 * the bot) per conversation, in first-seen (oldest-first) order. One query for
 * the whole page, so the list route never reads turns per row. Every requested
 * id gets an entry — `[]` when the conversation has no human turns or is
 * missing — so callers can look up blindly.
 */
export const peopleForConversations = (
  scope: GuildScope,
  conversationIds: readonly string[],
): Map<string, string[]> => {
  const people = new Map<string, string[]>();
  for (const id of conversationIds) {
    if (!people.has(id)) people.set(id, []);
  }
  if (conversationIds.length === 0) return people;
  const rows = read(scope, (db) =>
    db
      .select({
        conversationId: assistantConversationTurns.conversationId,
        authorName: assistantConversationTurns.authorName,
      })
      .from(assistantConversationTurns)
      .where(
        scope.only(
          assistantConversationTurns,
          inArray(assistantConversationTurns.conversationId, [...new Set(conversationIds)]),
          inArray(assistantConversationTurns.role, ['user', 'quote']),
        ),
      )
      .orderBy(asc(assistantConversationTurns.at), asc(assistantConversationTurns.turnId))
      .all(),
  );
  for (const row of rows) {
    const names = people.get(row.conversationId);
    if (names !== undefined && !names.includes(row.authorName)) names.push(row.authorName);
  }
  return people;
};

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

/**
 * Whether the guild has any conversation at all — a cheap `LIMIT 1`
 * existence check for the daily prune timer's enqueue gate, so a guild with
 * nothing to prune gets no empty `conversation_prune` job (the same reason
 * the resource-refresh timer's `hasResources` exists).
 */
export const hasConversations = (scope: GuildScope): boolean =>
  read(scope, (db) => {
    const row = db
      .select({ conversationId: assistantConversations.conversationId })
      .from(assistantConversations)
      .where(scope.only(assistantConversations))
      .limit(1)
      .get();
    return row !== undefined;
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

/**
 * Sets feedback on the turn a message belongs to. `null` clears it (the
 * member removed their reaction). Reports whether the message is linked at
 * all, plus the turn's trace id so the caller can flag the matching trace —
 * the message link is the only turn-to-trace path the feedback subscriber
 * has. The subscriber, not this function, decides which linked roles count.
 */
export const setFeedback = (
  scope: GuildScope,
  messageId: string,
  feedback: Feedback | null,
): { updated: boolean; traceId: string | undefined } =>
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
    if (link === undefined) return { updated: false, traceId: undefined };
    db.update(assistantConversationTurns)
      .set({ feedback })
      .where(
        scope.only(assistantConversationTurns, eq(assistantConversationTurns.turnId, link.turnId)),
      )
      .run();
    const turn = db
      .select({ traceId: assistantConversationTurns.traceId })
      .from(assistantConversationTurns)
      .where(
        scope.only(assistantConversationTurns, eq(assistantConversationTurns.turnId, link.turnId)),
      )
      .get();
    return { updated: true, traceId: turn?.traceId ?? undefined };
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
      // A surviving conversation's summary may describe the forgotten
      // member's turns, so clear it: the FTS `_au` trigger drops the index
      // entry when the text goes to null.
      const survived = touchedIds.filter((id) => stillHasUserTurn.has(id));
      if (survived.length > 0) {
        db.update(assistantConversations)
          .set({
            summaryJson: null,
            summaryText: null,
            summaryThroughAt: null,
            summaryUpdatedAt: null,
          })
          .where(
            scope.only(
              assistantConversations,
              inArray(assistantConversations.conversationId, survived),
            ),
          )
          .run();
      }
    }

    return deleted;
  });

export interface ConversationSummaryRead {
  readonly summary: ConversationSummary;
  readonly throughAt: number;
  readonly version: number;
  readonly updatedAt: number;
}

/**
 * The stored summary, if the row has one that still validates (ADR 0091).
 *
 * Model output is untrusted (hard rule 3): `summary_json` is parsed with
 * `conversationSummarySchema` on the way back in, and a row that fails to
 * parse reads as undefined rather than erroring.
 */
export const getSummary = (
  scope: GuildScope,
  conversationId: string,
): ConversationSummaryRead | undefined =>
  read(scope, (db) => {
    const row = db
      .select({
        summaryJson: assistantConversations.summaryJson,
        summaryThroughAt: assistantConversations.summaryThroughAt,
        summaryVersion: assistantConversations.summaryVersion,
        summaryUpdatedAt: assistantConversations.summaryUpdatedAt,
      })
      .from(assistantConversations)
      .where(
        scope.only(
          assistantConversations,
          eq(assistantConversations.conversationId, conversationId),
        ),
      )
      .get();
    if (row?.summaryJson == null || row.summaryThroughAt == null || row.summaryUpdatedAt == null) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.summaryJson);
    } catch {
      return undefined;
    }
    const result = conversationSummarySchema.safeParse(parsed);
    if (!result.success) return undefined;
    return {
      summary: result.data,
      throughAt: row.summaryThroughAt,
      version: row.summaryVersion,
      updatedAt: row.summaryUpdatedAt,
    };
  });

/**
 * Compare-and-set summary write (ADR 0091 decision 3).
 *
 * A single `UPDATE … WHERE … (summary_through_at IS NULL OR
 * summary_through_at < ?)` applies only when the stored summary is still
 * older than `throughAt`, and bumps `summary_version`. `written` comes from
 * the changed-row count; `version` is the row's version afterwards (or `0`
 * when the row does not exist). The summary is validated before writing and
 * an invalid one throws rather than writing.
 */
export const writeSummaryIfNewer = (
  scope: GuildScope,
  input: {
    readonly conversationId: string;
    readonly summary: ConversationSummary;
    readonly throughAt: number;
    readonly now: number;
  },
): { written: boolean; version: number } =>
  write(scope, ({ db }) => {
    const validated = conversationSummarySchema.parse(input.summary);
    const changed = db
      .update(assistantConversations)
      .set({
        summaryJson: JSON.stringify(validated),
        // ADR 0093 decision 1: the rendered text lands in the same UPDATE,
        // so the FTS trigger indexes exactly what `summary_json` holds.
        summaryText: renderSummary(validated),
        summaryThroughAt: input.throughAt,
        summaryVersion: sql`${assistantConversations.summaryVersion} + 1`,
        summaryUpdatedAt: input.now,
      })
      .where(
        scope.only(
          assistantConversations,
          eq(assistantConversations.conversationId, input.conversationId),
          sql`(${assistantConversations.summaryThroughAt} IS NULL OR ${assistantConversations.summaryThroughAt} < ${input.throughAt})`,
        ),
      )
      .run().changes;
    const row = db
      .select({ summaryVersion: assistantConversations.summaryVersion })
      .from(assistantConversations)
      .where(
        scope.only(
          assistantConversations,
          eq(assistantConversations.conversationId, input.conversationId),
        ),
      )
      .get();
    return { written: changed > 0, version: row?.summaryVersion ?? 0 };
  });

/**
 * The stored turns that are **not** in the window `recentTurns` would return,
 * and whose `at` is greater than `afterAt` (`null` means no lower bound),
 * oldest first (ADR 0091 decision 3: what the next summary run must cover).
 *
 * Reuses `recentTurns`' own selection — calling it and excluding its turn ids
 * — so the two can never disagree about which turns the window holds.
 */
export const evictedTurnsSince = (
  scope: GuildScope,
  conversationId: string,
  opts: { afterAt: number | null; window: { maxTurns: number; maxChars: number } },
): ConversationTurn[] => {
  const inWindow = new Set(
    recentTurns(scope, conversationId, opts.window).map((turnEntry) => turnEntry.turnId),
  );
  return listTurns(scope, conversationId).filter(
    (turnEntry) =>
      !inWindow.has(turnEntry.turnId) && (opts.afterAt === null || turnEntry.at > opts.afterAt),
  );
};

/**
 * The raw better-sqlite3 handle behind a Drizzle `Db` (mirrors
 * `archive-search.ts`'s `rawOf`: `MATCH` against the FTS5 index is not
 * expressible through the query builder).
 */
const rawOf = (db: Db): Database.Database =>
  (db as unknown as { readonly $client: Database.Database }).$client;

export interface SummarySearchHit {
  readonly conversationId: string;
  readonly channelId: string;
  readonly lastActivityAt: number;
  readonly summary: ConversationSummary;
}

interface SummarySearchRow {
  readonly conversationId: string;
  readonly channelId: string;
  readonly lastActivityAt: number;
  readonly summaryJson: string | null;
}

/**
 * Full-text search over this guild's conversation summaries (ADR 0093).
 *
 * The FTS table (`assistant_conversations_summaries_fts`, migration 0052)
 * carries no `guild_id` of its own, so the query joins back to
 * `assistant_conversations` on rowid with the guild filter — the same
 * arrangement `resource-cache.ts` uses — plus the channel filter and the
 * current-conversation exclusion. Newest first. An empty channel list
 * returns `[]` without running a query (`IN ()` is a syntax error, and
 * "nothing visible" is a real state).
 *
 * Stored summaries are untrusted (hard rule 3): each hit's `summary_json`
 * is parsed with `conversationSummarySchema` and a row that fails to parse
 * is skipped rather than erroring.
 */
export const searchSummaries = (
  scope: GuildScope,
  input: {
    readonly query: string;
    readonly channelIds: readonly string[];
    readonly excludeConversationId?: string | undefined;
    readonly limit?: number | undefined;
  },
): SummarySearchHit[] =>
  read(scope, (db) => {
    const channels = [...new Set(input.channelIds)];
    if (channels.length === 0) return [];
    const match = sanitiseFtsQuery(input.query);
    if (match === '') return [];
    const limit =
      input.limit === undefined || !Number.isFinite(input.limit)
        ? 5
        : Math.min(Math.max(Math.floor(input.limit), 1), 20);

    const where = [
      'assistant_conversations_summaries_fts MATCH ?',
      'c.guild_id = ?',
      `c.channel_id IN (${channels.map(() => '?').join(', ')})`,
      'c.summary_json IS NOT NULL',
    ];
    const params: unknown[] = [match, scope.guildId, ...channels];
    if (input.excludeConversationId !== undefined) {
      where.push('c.conversation_id != ?');
      params.push(input.excludeConversationId);
    }
    const querySql =
      'SELECT c.conversation_id AS conversationId, c.channel_id AS channelId, ' +
      'c.last_activity_at AS lastActivityAt, c.summary_json AS summaryJson ' +
      'FROM assistant_conversations_summaries_fts ' +
      'JOIN assistant_conversations c ON c.rowid = assistant_conversations_summaries_fts.rowid ' +
      `WHERE ${where.join(' AND ')} ` +
      'ORDER BY c.last_activity_at DESC LIMIT ?';
    const rows = rawOf(db)
      .prepare<unknown[], SummarySearchRow>(querySql)
      .all(...params, limit);
    const hits: SummarySearchHit[] = [];
    for (const row of rows) {
      if (row.summaryJson == null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.summaryJson);
      } catch {
        continue;
      }
      const result = conversationSummarySchema.safeParse(parsed);
      if (!result.success) continue;
      hits.push({
        conversationId: row.conversationId,
        channelId: row.channelId,
        lastActivityAt: row.lastActivityAt,
        summary: result.data,
      });
    }
    return hits;
  });
