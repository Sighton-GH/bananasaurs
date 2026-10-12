import { asc, desc, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { digestOutputSchema, type DigestOutput } from '@bananasaurs/core';
import {
  assistantConversationTurns,
  assistantConversations,
  assistantDailyDigests,
} from '../schema.js';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import type { ConversationTurn } from './conversations.js';

export interface DigestConversationBond {
  readonly conversationId: string;
  readonly channelId: string;
  readonly title: string;
}

export interface StoredDigest {
  readonly summary: DigestOutput;
  readonly conversations: readonly DigestConversationBond[];
}

export interface DailyDigestRow extends StoredDigest {
  readonly day: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const renderDigestText = (stored: StoredDigest): string =>
  [
    stored.summary.daySummary,
    ...stored.summary.memoryProposals.map((p) => `${p.text} ${p.why}`),
    ...stored.conversations.map((c) => c.title),
  ].join('\n');

/** Once per guild and day (hard rule 6): a replay returns `duplicate`. */
export const putDigestOnce = (
  scope: GuildScope,
  input: {
    readonly day: string;
    readonly summary: DigestOutput;
    readonly conversations: readonly DigestConversationBond[];
    readonly now: number;
  },
): 'created' | 'duplicate' =>
  write(scope, ({ db }) => {
    const parsed = digestOutputSchema.parse(input.summary);
    const stored: StoredDigest = { summary: parsed, conversations: [...input.conversations] };
    const changed = db
      .insert(assistantDailyDigests)
      .values({
        guildId: scope.guildId,
        day: input.day,
        summaryJson: JSON.stringify(stored),
        summaryText: renderDigestText(stored),
        proposalsJson: JSON.stringify(parsed.memoryProposals),
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({ target: [assistantDailyDigests.guildId, assistantDailyDigests.day] })
      .run().changes;
    return changed === 0 ? 'duplicate' : 'created';
  });

const conversationBondsSchema = z.array(
  z.object({
    conversationId: z.string().min(1),
    channelId: z.string().regex(/^\d{17,20}$/),
    title: z.string(),
  }),
);

const toRow = (row: typeof assistantDailyDigests.$inferSelect): DailyDigestRow | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.summaryJson);
  } catch {
    return undefined;
  }
  const envelope = typeof parsed === 'object' && parsed !== null ? parsed : {};
  const summary = digestOutputSchema.safeParse('summary' in envelope ? envelope.summary : parsed);
  if (!summary.success) return undefined;
  // Do not keep only the valid bonds: dropping an unknown private channel
  // would make the remaining public coverage falsely look complete.
  const bonds = conversationBondsSchema.safeParse(
    'conversations' in envelope ? envelope.conversations : [],
  );
  if (!bonds.success) return undefined;
  const conversations = bonds.data;
  return {
    day: row.day,
    summary: summary.data,
    conversations,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

export const getDigest = (scope: GuildScope, day: string): DailyDigestRow | undefined =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(assistantDailyDigests)
      .where(scope.only(assistantDailyDigests, sql`${assistantDailyDigests.day} = ${day}`))
      .get();
    return row === undefined ? undefined : toRow(row);
  });

export interface DigestListEntry {
  readonly day: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly topics: string;
}

export const listDigests = (scope: GuildScope, limit: number): DigestListEntry[] =>
  read(scope, (db) =>
    db
      .select()
      .from(assistantDailyDigests)
      .where(scope.only(assistantDailyDigests))
      .orderBy(desc(assistantDailyDigests.day))
      .limit(Math.min(Math.max(Math.floor(limit), 1), 100))
      .all()
      .flatMap((row) => {
        const parsed = toRow(row);
        return parsed === undefined
          ? []
          : [
              {
                day: parsed.day,
                createdAt: parsed.createdAt,
                updatedAt: parsed.updatedAt,
                topics: parsed.summary.daySummary.slice(0, 200),
              },
            ];
      }),
  );

/** Deletes rows with `day` strictly before `cutoffDay` (`YYYY-MM-DD` compares). */
export const deleteDigestsOlderThan = (scope: GuildScope, cutoffDay: string): number =>
  write(
    scope,
    ({ db }) =>
      db
        .delete(assistantDailyDigests)
        .where(scope.only(assistantDailyDigests, lt(assistantDailyDigests.day, cutoffDay)))
        .run().changes,
  );

/**
 * Whether the guild has any digest at all — a cheap `LIMIT 1` existence
 * check for the daily prune timer's enqueue gate, so a guild whose
 * conversations all aged out still gets its digests pruned (the same reason
 * `conversationRepo.hasConversations` exists).
 */
export const hasDigests = (scope: GuildScope): boolean =>
  read(scope, (db) => {
    const row = db
      .select({ day: assistantDailyDigests.day })
      .from(assistantDailyDigests)
      .where(scope.only(assistantDailyDigests))
      .limit(1)
      .get();
    return row !== undefined;
  });

const TURN_PAGE_LIMIT = 2_000;

export interface DigestDayGroup {
  readonly conversationId: string;
  readonly channelId: string;
  readonly title: string;
  readonly summaryText: string | null;
  readonly turns: ConversationTurn[];
}

/** Turns with `at` in `[start, end)`, grouped by conversation, oldest first. */
export const turnsForDay = (scope: GuildScope, start: number, end: number): DigestDayGroup[] =>
  read(scope, (db) => {
    const rows = db
      .select()
      .from(assistantConversationTurns)
      .where(
        scope.only(
          assistantConversationTurns,
          gte(assistantConversationTurns.at, start),
          lt(assistantConversationTurns.at, end),
        ),
      )
      .orderBy(asc(assistantConversationTurns.conversationId), asc(assistantConversationTurns.at))
      .limit(TURN_PAGE_LIMIT)
      .all();
    const byConv = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byConv.get(row.conversationId) ?? [];
      list.push(row);
      byConv.set(row.conversationId, list);
    }
    const groups: DigestDayGroup[] = [];
    for (const [conversationId, turns] of byConv) {
      const conv = db
        .select()
        .from(assistantConversations)
        .where(
          scope.only(
            assistantConversations,
            sql`${assistantConversations.conversationId} = ${conversationId}`,
          ),
        )
        .get();
      if (conv === undefined) continue;
      groups.push({
        conversationId,
        channelId: conv.channelId,
        title: conv.title,
        summaryText: conv.summaryText,
        turns: turns.map((r) => ({
          turnId: r.turnId,
          at: r.at,
          role: r.role as ConversationTurn['role'],
          ...(r.authorId === null ? {} : { authorId: r.authorId }),
          authorName: r.authorName,
          text: r.text,
          ...(r.traceId === null ? {} : { traceId: r.traceId }),
        })),
      });
    }
    return groups;
  });

export interface DigestSearchHit {
  readonly day: string;
  readonly topics: string;
  readonly channelId: string;
}

/**
 * Query words are literal text, not LIKE patterns: escape the LIKE
 * metacharacters (`\` first so the escape itself survives) and match with an
 * explicit `ESCAPE '\'`. Otherwise a query like `100%` matches every digest
 * containing `100`, leaking other days' summaries past the channel check.
 */
const escapeLikeWord = (word: string): string =>
  word.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

/**
 * Digests whose text matches, returned only when every covered conversation
 * is in the asker's searchable channels. The summary spans the whole day, so
 * one allowed channel cannot authorise other channels' content. Missing or
 * invalid coverage fails closed.
 */
export const searchDigests = (
  scope: GuildScope,
  input: {
    readonly query: string;
    readonly channelIds: readonly string[];
    readonly limit?: number | undefined;
  },
): DigestSearchHit[] =>
  read(scope, (db) => {
    const channels = new Set(input.channelIds);
    if (channels.size === 0) return [];
    const words = input.query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .slice(0, 6);
    if (words.length === 0) return [];
    const limit =
      input.limit === undefined ? 5 : Math.min(Math.max(Math.floor(input.limit), 1), 10);
    const rows = db
      .select()
      .from(assistantDailyDigests)
      .where(
        scope.only(
          assistantDailyDigests,
          sql.join(
            words.map(
              (w) =>
                sql`${assistantDailyDigests.summaryText} LIKE ${`%${escapeLikeWord(w)}%`} ESCAPE '\\'`,
            ),
            sql` AND `,
          ),
        ),
      )
      .orderBy(desc(assistantDailyDigests.day))
      .limit(20)
      .all();
    const hits: DigestSearchHit[] = [];
    for (const row of rows) {
      const parsed = toRow(row);
      if (parsed === undefined) continue;
      if (
        parsed.conversations.length === 0 ||
        !parsed.conversations.every((c) => channels.has(c.channelId))
      )
        continue;
      const first = parsed.conversations[0];
      if (first === undefined) continue;
      hits.push({
        day: parsed.day,
        topics: parsed.summary.daySummary.slice(0, 300),
        channelId: first.channelId,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  });
