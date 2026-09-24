import { desc, eq, gte, inArray, lt } from 'drizzle-orm';
import {
  assistantTraceSchema,
  capTrace,
  isFallbackTrace,
  summaryOfTrace,
  totalTokensOf,
  type AssistantTrace,
  type DayUsage,
  type TraceSummary,
} from '@bananasaurs/core';
import { assistantTraces } from '../schema.js';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';

const parseBody = (raw: string): AssistantTrace | undefined => {
  try {
    const parsed = assistantTraceSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

export interface TraceListQuery {
  readonly before?: number;
  readonly limit: number;
  readonly outcome?: 'answered' | 'refused' | 'failed';
  readonly behaviourId?: string;
  readonly userId?: string;
}

/** Stores one run, capped to 200 KB first so no single run grows the table. */
export const insertTrace = (scope: GuildScope, t: AssistantTrace): void =>
  write(scope, ({ db }) => {
    const capped = capTrace(t);
    db.insert(assistantTraces)
      .values({
        guildId: scope.guildId,
        traceId: capped.traceId,
        at: capped.at,
        userId: capped.userId,
        behaviourId: capped.behaviourId,
        outcome: capped.outcome,
        conversationId: capped.conversationId ?? null,
        durationMs: capped.durationMs,
        totalTokens: totalTokensOf(capped.usage),
        bodyJson: JSON.stringify(capped),
      })
      .run();
  });

/**
 * Newest first, paged by `before` (rows with `at` strictly below it).
 * Summaries come from the stored body, the columns only filter and order —
 * one source of truth either way. A row whose body no longer parses is
 * skipped here; `getTrace` reports it as missing.
 */
export const listTraces = (scope: GuildScope, q: TraceListQuery): TraceSummary[] =>
  read(scope, (db) => {
    const rows = db
      .select()
      .from(assistantTraces)
      .where(
        scope.only(
          assistantTraces,
          q.before === undefined ? undefined : lt(assistantTraces.at, q.before),
          q.outcome === undefined ? undefined : eq(assistantTraces.outcome, q.outcome),
          q.behaviourId === undefined ? undefined : eq(assistantTraces.behaviourId, q.behaviourId),
          q.userId === undefined ? undefined : eq(assistantTraces.userId, q.userId),
        ),
      )
      .orderBy(desc(assistantTraces.at), desc(assistantTraces.traceId))
      .limit(q.limit)
      .all();
    const out: TraceSummary[] = [];
    for (const row of rows) {
      const parsed = parseBody(row.bodyJson);
      if (parsed !== undefined) out.push(summaryOfTrace(parsed));
    }
    return out;
  });

/** The full stored run, or undefined when missing or no longer parseable. */
export const getTrace = (scope: GuildScope, traceId: string): AssistantTrace | undefined =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(assistantTraces)
      .where(scope.only(assistantTraces, eq(assistantTraces.traceId, traceId)))
      .get();
    return row === undefined ? undefined : parseBody(row.bodyJson);
  });

/**
 * Removes every trace of the named conversations in this guild (the prune
 * job calls this alongside the conversation delete). Returns the row count.
 */
export const deleteTracesForConversations = (scope: GuildScope, ids: readonly string[]): number => {
  if (ids.length === 0) return 0;
  return write(
    scope,
    ({ db }) =>
      db
        .delete(assistantTraces)
        .where(scope.only(assistantTraces, inArray(assistantTraces.conversationId, [...ids])))
        .run().changes,
  );
};

/** Appends a flag once (`feedback:up`, `prompt-leak-blocked`, …). False when missing. */
export const addTraceFlag = (scope: GuildScope, traceId: string, flag: string): boolean =>
  write(scope, ({ db }) => {
    const row = db
      .select()
      .from(assistantTraces)
      .where(scope.only(assistantTraces, eq(assistantTraces.traceId, traceId)))
      .get();
    if (row === undefined) return false;
    const parsed = parseBody(row.bodyJson);
    if (parsed === undefined) return false;
    if (parsed.flags.includes(flag)) return true;
    const updated: AssistantTrace = { ...parsed, flags: [...parsed.flags, flag] };
    db.update(assistantTraces)
      .set({ bodyJson: JSON.stringify(capTrace(updated)) })
      .where(scope.only(assistantTraces, eq(assistantTraces.traceId, traceId)))
      .run();
    return true;
  });

/**
 * Per-day totals from `sinceMs`, oldest day first. Only days with runs are
 * returned — the usage strip fills the quiet days with zeros itself.
 */
export const dailyUsage = (scope: GuildScope, sinceMs: number): DayUsage[] =>
  read(scope, (db) => {
    const rows = db
      .select()
      .from(assistantTraces)
      .where(scope.only(assistantTraces, gte(assistantTraces.at, sinceMs)))
      .all();
    const byDay = new Map<
      string,
      { answers: number; failures: number; fallbacks: number; tokens: number }
    >();
    for (const row of rows) {
      const parsed = parseBody(row.bodyJson);
      if (parsed === undefined) continue;
      const day = new Date(parsed.at).toISOString().slice(0, 10);
      const entry = byDay.get(day) ?? { answers: 0, failures: 0, fallbacks: 0, tokens: 0 };
      if (parsed.outcome === 'answered') entry.answers += 1;
      if (parsed.outcome === 'failed') entry.failures += 1;
      if (isFallbackTrace(parsed)) entry.fallbacks += 1;
      entry.tokens += totalTokensOf(parsed.usage) ?? 0;
      byDay.set(day, entry);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([day, counts]) => ({ day, ...counts }));
  });
