import { asc, desc, eq, gt, gte, inArray, isNull, lt, max } from 'drizzle-orm';
import {
  ACTIVE_RUN_STATES,
  runEventSchema,
  type ModelResult,
  type RunEvent,
  type RunEventRow,
  type RunRow,
} from '@bananasaurs/core';
import { assistantRunEvents, assistantRuns } from '../schema.js';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';

type RunTableRow = typeof assistantRuns.$inferSelect;

const toRunRow = (row: RunTableRow): RunRow => ({
  runId: row.runId,
  ...(row.conversationId === null ? {} : { conversationId: row.conversationId }),
  ...(row.traceId === null ? {} : { traceId: row.traceId }),
  userId: row.userId,
  ...(row.channelId === null ? {} : { channelId: row.channelId }),
  behaviourId: row.behaviourId,
  source: row.source as RunRow['source'],
  state: row.state as RunRow['state'],
  stage: row.stage as RunRow['stage'],
  attempt: row.attempt,
  queuedAt: row.queuedAt,
  ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
  updatedAt: row.updatedAt,
  ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt }),
  ...(row.retryAt === null ? {} : { retryAt: row.retryAt }),
  ...(row.model === null ? {} : { model: row.model }),
  ...(row.keyLabel === null ? {} : { keyLabel: row.keyLabel }),
  ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
  ...(row.totalTokens === null ? {} : { totalTokens: row.totalTokens }),
});

/**
 * Records a run's start (ADR 0129 §6): one row in state `queued`, stage
 * `queued`, attempt 1. Repeating the same `runId` keeps the first row —
 * gateway replays must not reset a run already in flight.
 */
export const ensureRun = (
  scope: GuildScope,
  init: {
    readonly runId: string;
    readonly userId: string;
    readonly channelId?: string;
    readonly behaviourId: string;
    readonly source: RunRow['source'];
    readonly queuedAt: number;
  },
): void =>
  write(scope, ({ db }) => {
    db.insert(assistantRuns)
      .values({
        guildId: scope.guildId,
        runId: init.runId,
        userId: init.userId,
        ...(init.channelId === undefined ? {} : { channelId: init.channelId }),
        behaviourId: init.behaviourId,
        source: init.source,
        state: 'queued',
        stage: 'queued',
        attempt: 1,
        queuedAt: init.queuedAt,
        updatedAt: init.queuedAt,
      })
      .onConflictDoNothing({ target: [assistantRuns.guildId, assistantRuns.runId] })
      .run();
  });

/** The fields `updateRun` may change, plus the new `updatedAt`. Absent means untouched. */
export type RunPatch = Partial<
  Pick<
    RunRow,
    | 'state'
    | 'stage'
    | 'attempt'
    | 'startedAt'
    | 'finishedAt'
    | 'retryAt'
    | 'model'
    | 'keyLabel'
    | 'errorCode'
    | 'totalTokens'
    | 'conversationId'
    | 'traceId'
  >
> & { readonly updatedAt: number };

/** Moves a run in place (ADR 0129 §6): only the given fields. A missing run is a no-op. */
export const updateRun = (scope: GuildScope, runId: string, patch: RunPatch): void =>
  write(scope, ({ db }) => {
    db.update(assistantRuns)
      .set({
        updatedAt: patch.updatedAt,
        ...(patch.state === undefined ? {} : { state: patch.state }),
        ...(patch.stage === undefined ? {} : { stage: patch.stage }),
        ...(patch.attempt === undefined ? {} : { attempt: patch.attempt }),
        ...(patch.startedAt === undefined ? {} : { startedAt: patch.startedAt }),
        ...(patch.finishedAt === undefined ? {} : { finishedAt: patch.finishedAt }),
        ...(patch.retryAt === undefined ? {} : { retryAt: patch.retryAt }),
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.keyLabel === undefined ? {} : { keyLabel: patch.keyLabel }),
        ...(patch.errorCode === undefined ? {} : { errorCode: patch.errorCode }),
        ...(patch.totalTokens === undefined ? {} : { totalTokens: patch.totalTokens }),
        ...(patch.conversationId === undefined ? {} : { conversationId: patch.conversationId }),
        ...(patch.traceId === undefined ? {} : { traceId: patch.traceId }),
      })
      .where(scope.only(assistantRuns, eq(assistantRuns.runId, runId)))
      .run();
  });

/**
 * Appends one step to a run's log (ADR 0129 §6). The event is validated
 * first — an unknown field throws rather than storing message text — then
 * written with its queryable columns in a single transaction: the next `seq`
 * for this run, the model and key the step ran on, the outcome, code,
 * latency, token count and cost. Returns the `seq`. Throws when the run does
 * not exist (the composite foreign key).
 */
export const appendRunEvent = (
  scope: GuildScope,
  runId: string,
  at: number,
  event: RunEvent,
): number =>
  write(scope, ({ db }) => {
    const parsed = runEventSchema.parse(event);
    const [top] = db
      .select({ m: max(assistantRunEvents.seq) })
      .from(assistantRunEvents)
      .where(scope.only(assistantRunEvents, eq(assistantRunEvents.runId, runId)))
      .all();
    const seq = (top?.m ?? 0) + 1;
    db.insert(assistantRunEvents)
      .values({
        guildId: scope.guildId,
        runId,
        seq,
        at,
        kind: parsed.kind,
        ...(parsed.kind === 'model-call' ||
        parsed.kind === 'model-result' ||
        parsed.kind === 'model-skipped'
          ? { model: parsed.model, keyId: parsed.keyId }
          : {}),
        ...(parsed.kind === 'model-result' || parsed.kind === 'tool-result'
          ? { ok: parsed.ok ? 1 : 0 }
          : {}),
        ...(parsed.kind === 'model-result' ||
        parsed.kind === 'retry-scheduled' ||
        parsed.kind === 'finished'
          ? { code: parsed.code ?? null }
          : {}),
        ...(parsed.kind === 'model-result' || parsed.kind === 'tool-result'
          ? { ms: parsed.ms }
          : {}),
        ...(parsed.kind === 'model-result' &&
        (parsed.promptTokens !== undefined || parsed.completionTokens !== undefined)
          ? { tokens: (parsed.promptTokens ?? 0) + (parsed.completionTokens ?? 0) }
          : parsed.kind === 'finished' && parsed.totalTokens !== undefined
            ? { tokens: parsed.totalTokens }
            : {}),
        ...(parsed.kind === 'model-result' && parsed.costUsd !== undefined
          ? { costUsd: parsed.costUsd }
          : {}),
        dataJson: JSON.stringify(parsed),
      })
      .run();
    return seq;
  });

/** One run's current row, or undefined when missing. */
export const getRun = (scope: GuildScope, runId: string): RunRow | undefined =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(assistantRuns)
      .where(scope.only(assistantRuns, eq(assistantRuns.runId, runId)))
      .get();
    return row === undefined ? undefined : toRunRow(row);
  });

/**
 * Runs newest first, paged by `before` (rows with `updated_at` strictly below
 * it). `active: true` keeps only runs still in flight; false or absent keeps
 * everything.
 */
export const listRuns = (
  scope: GuildScope,
  q: { readonly active?: boolean; readonly before?: number; readonly limit: number },
): RunRow[] =>
  read(scope, (db) => {
    const rows = db
      .select()
      .from(assistantRuns)
      .where(
        scope.only(
          assistantRuns,
          q.active === true ? inArray(assistantRuns.state, [...ACTIVE_RUN_STATES]) : undefined,
          q.before === undefined ? undefined : lt(assistantRuns.updatedAt, q.before),
        ),
      )
      .orderBy(desc(assistantRuns.updatedAt), desc(assistantRuns.runId))
      .limit(q.limit)
      .all();
    return rows.map(toRunRow);
  });

/**
 * One run's steps after `afterSeq`, oldest first, up to `limit`. A row whose
 * stored JSON no longer parses is skipped — the ledger stays readable after
 * a schema change.
 */
export const listRunEvents = (
  scope: GuildScope,
  runId: string,
  afterSeq: number,
  limit: number,
): RunEventRow[] =>
  read(scope, (db) => {
    const rows = db
      .select()
      .from(assistantRunEvents)
      .where(
        scope.only(
          assistantRunEvents,
          eq(assistantRunEvents.runId, runId),
          gt(assistantRunEvents.seq, afterSeq),
        ),
      )
      .orderBy(asc(assistantRunEvents.seq))
      .limit(limit)
      .all();
    const out: RunEventRow[] = [];
    for (const row of rows) {
      try {
        const parsed = runEventSchema.safeParse(JSON.parse(row.dataJson) as unknown);
        if (parsed.success) out.push({ seq: row.seq, at: row.at, event: parsed.data });
      } catch {
        // Corrupt JSON: skip the row, same as an unparseable one.
      }
    }
    return out;
  });

/**
 * ADR 0129 §8: every model-result event since `since`, oldest first, for
 * health and usage stats. Reads on the (guild_id, kind, at) index; a row
 * whose stored JSON no longer parses (or is not a model-result) is skipped,
 * like `listRunEvents`.
 */
export const modelResultsSince = (scope: GuildScope, since: number): ModelResult[] =>
  read(scope, (db) => {
    const rows = db
      .select()
      .from(assistantRunEvents)
      .where(
        scope.only(
          assistantRunEvents,
          eq(assistantRunEvents.kind, 'model-result'),
          gte(assistantRunEvents.at, since),
        ),
      )
      .orderBy(asc(assistantRunEvents.at))
      .all();
    const out: ModelResult[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.dataJson) as unknown;
      } catch {
        continue;
      }
      const event = runEventSchema.safeParse(parsed);
      if (!event.success || event.data.kind !== 'model-result') continue;
      const e = event.data;
      out.push({
        at: row.at,
        model: e.model,
        keyId: e.keyId,
        ok: e.ok,
        ms: e.ms,
        ...(e.code === undefined ? {} : { code: e.code }),
        ...(e.providerMessage === undefined ? {} : { providerMessage: e.providerMessage }),
        ...(e.costUsd === undefined ? {} : { costUsd: e.costUsd }),
        ...(e.promptTokens === undefined && e.completionTokens === undefined
          ? {}
          : { tokens: (e.promptTokens ?? 0) + (e.completionTokens ?? 0) }),
      });
    }
    return out;
  });

/**
 * Removes every run of the named conversations in this guild (the prune job,
 * the DELETE route and forgetMember call this alongside the conversation
 * delete). Events die with their run through the composite foreign key.
 * Returns the run count.
 */
export const deleteRunsForConversations = (
  scope: GuildScope,
  conversationIds: readonly string[],
): number => {
  if (conversationIds.length === 0) return 0;
  return write(
    scope,
    ({ db }) =>
      db
        .delete(assistantRuns)
        .where(
          scope.only(assistantRuns, inArray(assistantRuns.conversationId, [...conversationIds])),
        )
        .run().changes,
  );
};

/** Removes every run a member started in this guild. Returns the run count. */
export const deleteRunsForUser = (scope: GuildScope, userId: string): number =>
  write(
    scope,
    ({ db }) =>
      db
        .delete(assistantRuns)
        .where(scope.only(assistantRuns, eq(assistantRuns.userId, userId)))
        .run().changes,
  );

/**
 * Removes runs with no conversation older than `olderThan` (ADR 0129 §6: 30
 * days). Runs tied to a conversation follow that conversation's own
 * retention instead. Returns the run count.
 */
export const failStaleRuns = (scope: GuildScope, olderThan: number, now: number): number =>
  write(
    scope,
    ({ db }) =>
      db
        .update(assistantRuns)
        .set({ state: 'failed', stage: 'done', errorCode: 'stalled', finishedAt: now, updatedAt: now })
        .where(
          scope.only(
            assistantRuns,
            inArray(assistantRuns.state, [...ACTIVE_RUN_STATES]),
            lt(assistantRuns.updatedAt, olderThan),
          ),
        )
        .run().changes,
  );

export const pruneOrphanRuns = (scope: GuildScope, olderThan: number): number =>
  write(
    scope,
    ({ db }) =>
      db
        .delete(assistantRuns)
        .where(
          scope.only(
            assistantRuns,
            isNull(assistantRuns.conversationId),
            lt(assistantRuns.updatedAt, olderThan),
          ),
        )
        .run().changes,
  );
