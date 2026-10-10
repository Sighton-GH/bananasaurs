import { and, asc, count, desc, eq, inArray, isNotNull, lt, lte, notInArray } from 'drizzle-orm';
import type { ClaimFilter } from '@bananasaurs/core';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { jobs } from '../schema.js';

/**
 * The durable job table (ADR 0008: no external queue, one process).
 *
 * Everything here is guild-scoped, including the claim. Release 1 has one
 * guild, and a worker that claims across guilds would be the one query in the
 * system able to omit the partition key — which `CLAUDE.md` rule 2 calls a bug
 * even when every current caller passes it. A cross-guild worker, if it is ever
 * wanted, iterates the allowlist and claims per guild.
 */

export interface JobRow {
  jobId: number;
  kind: string;
  /** JSON. Zod-validated by the handler on read — never trusted because we wrote it. */
  payload: string;
  dedupeKey: string;
  state: string;
  runAfter: number;
  attempts: number;
  maxAttempts: number;
  cursor: string | null;
  lastError: string | null;
  /** ADR 0135: the assistant lane's per-channel ordering key; null = no key. */
  orderingKey: string | null;
}

const columns = {
  jobId: jobs.jobId,
  kind: jobs.kind,
  payload: jobs.payload,
  dedupeKey: jobs.dedupeKey,
  state: jobs.state,
  runAfter: jobs.runAfter,
  attempts: jobs.attempts,
  maxAttempts: jobs.maxAttempts,
  cursor: jobs.cursor,
  lastError: jobs.lastError,
  orderingKey: jobs.orderingKey,
};

export interface EnqueueInput {
  kind: string;
  payload: string;
  /** Makes enqueuing the same work twice a no-op. */
  dedupeKey: string;
  runAfter?: number;
  maxAttempts?: number;
  /** ADR 0135: the lane ordering key, written to `jobs.ordering_key`, null when absent. */
  orderingKey?: string;
  /**
   * Progress the new row starts already knowing, for a job that enqueues its
   * own continuation (the purge job, ADR 0037 — `packages/core/src/mod/
   * purge.ts`). `undefined`/omitted leaves it `null`, same as every other
   * caller today. When the insert is skipped by `jobs_dedupe` (a row already
   * live under this key), the existing row's cursor is left exactly as it
   * is — this is not an update, only ever a starting value for a row this
   * call actually creates.
   */
  cursor?: string | null;
  /**
   * ADR 0127: for a dedupe key that ends in a time bucket (an hour, a day, a
   * minute), refuse when ANY row in this guild already carries the key, in
   * any state, so a bucket runs once even after its job has finished.
   * `jobs_dedupe` alone only collapses pending work (ADR 0016). Never set it
   * for a key without a time bucket (`…:added`, `reconcile_guild:*`,
   * `deliver_reminders`): those must re-enqueue after completion.
   */
  oncePerBucket?: boolean;
  now: number;
}

export interface EnqueueResult {
  enqueued: boolean;
  /** Present when this call created the row. */
  jobId: number | undefined;
}

/**
 * Enqueues work, once.
 *
 * The dedupe key matters because reconnects re-trigger reconciliation: without
 * it, a flapping connection queues one reconciliation pass per reconnect and
 * the worker spends the outage doing the same work repeatedly.
 */
export const enqueue = (scope: GuildScope, input: EnqueueInput): EnqueueResult =>
  write(scope, ({ db }) => {
    if (input.oncePerBucket === true) {
      const existing = db
        .select({ jobId: jobs.jobId })
        .from(jobs)
        .where(scope.only(jobs, eq(jobs.dedupeKey, input.dedupeKey)))
        .limit(1)
        .get();
      if (existing !== undefined) return { enqueued: false, jobId: undefined };
    }
    const result = db
      .insert(jobs)
      .values({
        guildId: scope.guildId,
        kind: input.kind,
        payload: input.payload,
        dedupeKey: input.dedupeKey,
        runAfter: input.runAfter ?? input.now,
        maxAttempts: input.maxAttempts ?? 5,
        cursor: input.cursor ?? null,
        orderingKey: input.orderingKey ?? null,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing()
      .run();

    return result.changes === 1
      ? { enqueued: true, jobId: Number(result.lastInsertRowid) }
      : { enqueued: false, jobId: undefined };
  });

/**
 * Claims the next due job, marking it running.
 *
 * **`attempts` increments on claim, not on failure.** A job that crashes the
 * process — or is killed mid-run — never reaches a failure handler, so counting
 * on failure lets it be retried forever and take the process down with it every
 * time. Counting on claim bounds that at `max_attempts`.
 *
 * Select-then-update inside one `write()`. better-sqlite3 is synchronous and
 * `write()` forbids an await, so nothing can interleave between the two
 * statements.
 *
 * With no filter, this is exactly the old oldest-first claim. With a filter
 * (ADR 0135):
 * 1. Find `oldest`: the first due `queued` row in this guild matching `kinds`
 *    and `excludeKinds`, ordered by `run_after, job_id`. None means `undefined`.
 * 2. When `oldest` has no ordering key, claim it only when `laneBusy` is not
 *    true — a keyless job waits for the lane to empty, and nothing newer jumps
 *    it, so it cannot starve.
 * 3. Otherwise claim the first due `queued` row matching `kinds` and
 *    `excludeKinds` whose key is not busy, ordered by `run_after, job_id`.
 */
export const claimNext = (
  scope: GuildScope,
  now: number,
  filter?: ClaimFilter,
): JobRow | undefined =>
  write(scope, ({ db }) => {
    if (filter === undefined) {
      const next = db
        .select(columns)
        .from(jobs)
        .where(scope.only(jobs, eq(jobs.state, 'queued'), lte(jobs.runAfter, now)))
        .orderBy(asc(jobs.runAfter), asc(jobs.jobId))
        .limit(1)
        .get();

      if (!next) return undefined;

      db.update(jobs)
        .set({ state: 'running', attempts: next.attempts + 1, updatedAt: now })
        .where(scope.only(jobs, eq(jobs.jobId, next.jobId)))
        .run();

      return { ...next, state: 'running', attempts: next.attempts + 1 };
    }

    const claim = (row: JobRow): JobRow => {
      db.update(jobs)
        .set({ state: 'running', attempts: row.attempts + 1, updatedAt: now })
        .where(scope.only(jobs, eq(jobs.jobId, row.jobId)))
        .run();
      return { ...row, state: 'running', attempts: row.attempts + 1 };
    };

    const kindConditions = [
      ...(filter.kinds === undefined ? [] : [inArray(jobs.kind, [...filter.kinds])]),
      ...(filter.excludeKinds === undefined
        ? []
        : [notInArray(jobs.kind, [...filter.excludeKinds])]),
    ];

    const oldest = db
      .select(columns)
      .from(jobs)
      .where(
        scope.only(jobs, eq(jobs.state, 'queued'), lte(jobs.runAfter, now), ...kindConditions),
      )
      .orderBy(asc(jobs.runAfter), asc(jobs.jobId))
      .limit(1)
      .get();

    if (!oldest) return undefined;

    if (oldest.orderingKey === null) {
      if (filter.laneBusy === true) return undefined;
      return claim(oldest);
    }

    const busy = filter.busyOrderingKeys ?? [];
    const keyed = db
      .select(columns)
      .from(jobs)
      .where(
        scope.only(
          jobs,
          eq(jobs.state, 'queued'),
          lte(jobs.runAfter, now),
          ...kindConditions,
          isNotNull(jobs.orderingKey),
          ...(busy.length === 0 ? [] : [notInArray(jobs.orderingKey, [...busy])]),
        ),
      )
      .orderBy(asc(jobs.runAfter), asc(jobs.jobId))
      .limit(1)
      .get();

    if (!keyed) return undefined;
    return claim(keyed);
  });

export const completeJob = (scope: GuildScope, jobId: number, now: number): void =>
  write(scope, ({ db }) => {
    db.update(jobs)
      .set({ state: 'done', updatedAt: now, lastError: null })
      .where(scope.only(jobs, eq(jobs.jobId, jobId)))
      .run();
  });

/** Exponential, capped. The cap keeps a poisoned job from receding forever. */
export const backoffMs = (attempts: number, baseMs = 1_000, capMs = 300_000): number =>
  Math.min(baseMs * 2 ** Math.max(0, attempts - 1), capMs);

export interface FailResult {
  /** False when the job has exhausted max_attempts and is now terminal. */
  willRetry: boolean;
  nextRunAfter: number | undefined;
}

/**
 * Records a failure and either reschedules or gives up.
 *
 * Giving up is a state, not a deletion: a job that exhausted its attempts stays
 * in the table as `failed` so `doctor` and `audit tail` can show it. Silently
 * dropping work is how an outage becomes invisible.
 */
export interface FailOptions {
  /**
   * Mark the job failed now, skipping the retry schedule.
   *
   * For failures a second attempt cannot change: an unregistered job kind, or
   * a payload that does not validate. Retrying those to exhaustion burns
   * twenty minutes of backoff to reach the same answer and buries the real
   * error under four duplicates.
   */
  permanent?: boolean;
  /** Retry after this long instead of `backoffMs` (a handler knows its failure best). */
  retryAfterMs?: number;
}

export const failJob = (
  scope: GuildScope,
  jobId: number,
  error: string,
  now: number,
  options: FailOptions = {},
): FailResult =>
  write(scope, ({ db }) => {
    const row = db
      .select(columns)
      .from(jobs)
      .where(scope.only(jobs, eq(jobs.jobId, jobId)))
      .get();

    if (!row) return { willRetry: false, nextRunAfter: undefined };

    if (options.permanent === true || row.attempts >= row.maxAttempts) {
      db.update(jobs)
        .set({ state: 'failed', lastError: error, updatedAt: now })
        .where(scope.only(jobs, eq(jobs.jobId, jobId)))
        .run();
      return { willRetry: false, nextRunAfter: undefined };
    }

    const nextRunAfter = now + (options.retryAfterMs ?? backoffMs(row.attempts));
    db.update(jobs)
      .set({ state: 'queued', lastError: error, runAfter: nextRunAfter, updatedAt: now })
      .where(scope.only(jobs, eq(jobs.jobId, jobId)))
      .run();
    return { willRetry: true, nextRunAfter };
  });

/**
 * Saves resumable progress.
 *
 * This is what lets the adoption pass survive a restart mid-page rather than
 * starting over — which for a 250-reactor panel is three REST calls it does not
 * need to make again.
 */
export const saveCursor = (
  scope: GuildScope,
  jobId: number,
  cursor: string | null,
  now: number,
): void =>
  write(scope, ({ db }) => {
    db.update(jobs)
      .set({ cursor, updatedAt: now })
      .where(scope.only(jobs, eq(jobs.jobId, jobId)))
      .run();
  });

export const cancelJob = (scope: GuildScope, jobId: number, now: number): void =>
  write(scope, ({ db }) => {
    db.update(jobs)
      .set({ state: 'cancelled', updatedAt: now })
      .where(scope.only(jobs, and(eq(jobs.jobId, jobId), eq(jobs.state, 'queued'))))
      .run();
  });

/**
 * ADR 0127: deletes up to `limit` finished rows (`done`, `failed`, `cancelled`)
 * whose `updated_at` is strictly before `olderThanMs`. Never touches `queued` or
 * `running`. Returns how many were deleted; the caller loops while it equals `limit`.
 */
export const deleteFinishedBatch = (
  scope: GuildScope,
  olderThanMs: number,
  limit: number,
): number =>
  write(scope, ({ db }) => {
    const ids = db
      .select({ jobId: jobs.jobId })
      .from(jobs)
      .where(
        scope.only(
          jobs,
          inArray(jobs.state, ['done', 'failed', 'cancelled']),
          lt(jobs.updatedAt, olderThanMs),
        ),
      )
      .limit(limit)
      .all()
      .map((row) => row.jobId);
    if (ids.length === 0) return 0;
    return db
      .delete(jobs)
      .where(scope.only(jobs, inArray(jobs.jobId, ids)))
      .run().changes;
  });

/** The guild's most recent job under `dedupeKey` (highest job id), any state. */
export const latestByDedupeKey = (
  scope: GuildScope,
  dedupeKey: string,
): { readonly state: string; readonly updatedAt: number } | undefined =>
  read(scope, (db) =>
    db
      .select({ state: jobs.state, updatedAt: jobs.updatedAt })
      .from(jobs)
      .where(scope.only(jobs, eq(jobs.dedupeKey, dedupeKey)))
      .orderBy(desc(jobs.jobId))
      .limit(1)
      .get(),
  );

export const findJob = (scope: GuildScope, jobId: number): JobRow | undefined =>
  read(scope, (db) =>
    db
      .select(columns)
      .from(jobs)
      .where(scope.only(jobs, eq(jobs.jobId, jobId)))
      .get(),
  );

/**
 * The `run_after` of the oldest queued job that is already due.
 *
 * The number behind `bananasaurs status`'s scheduler lag: `now` minus this is
 * how far behind the worker actually is. Filtered on *due-ness* rather than on
 * queued-ness, because a job deliberately scheduled for the future is not lag —
 * reporting it as lag would make an idle instance with one delayed
 * `log_message_delete` job look permanently behind.
 *
 * Guild-scoped like every other query here, and served by the existing partial
 * `jobs_claim` index on `(guild_id, state, run_after)` — the same index
 * `claimNext` uses, in the same order, so this costs no new index.
 */
export const oldestDueAt = (scope: GuildScope, now: number): number | undefined =>
  read(scope, (db) =>
    db
      .select({ runAfter: jobs.runAfter })
      .from(jobs)
      .where(scope.only(jobs, eq(jobs.state, 'queued'), lte(jobs.runAfter, now)))
      .orderBy(asc(jobs.runAfter))
      .limit(1)
      .get(),
  )?.runAfter;

export interface ListJobsInput {
  /** `bananasaurs jobs list --failed`: the reason an operator asks. */
  failedOnly?: boolean | undefined;
  limit?: number | undefined;
}

export interface JobListRow extends JobRow {
  createdAt: number;
  updatedAt: number;
}

/**
 * The job table, newest first, for `bananasaurs jobs list`.
 *
 * Ordered by `job_id` rather than by a timestamp: the id is monotonic and
 * unique, so two jobs enqueued in the same millisecond still have a defined
 * order, which a tail needs and `created_at` cannot give.
 */
export const listJobs = (scope: GuildScope, input: ListJobsInput): JobListRow[] =>
  read(scope, (db) =>
    db
      .select({
        ...columns,
        createdAt: jobs.createdAt,
        updatedAt: jobs.updatedAt,
      })
      .from(jobs)
      .where(scope.only(jobs, input.failedOnly === true ? eq(jobs.state, 'failed') : undefined))
      .orderBy(desc(jobs.jobId))
      .limit(input.limit ?? 50)
      .all(),
  );

/** For `doctor` and for the worker's own logging. */
export const countByState = (scope: GuildScope): Record<string, number> =>
  read(scope, (db) => {
    const rows = db
      .select({ state: jobs.state, n: count() })
      .from(jobs)
      .where(scope.only(jobs))
      .groupBy(jobs.state)
      .all();
    return Object.fromEntries(rows.map((row) => [row.state, row.n]));
  });

/**
 * Returns jobs stuck in `running` to the queue.
 *
 * A crash leaves a claimed job marked running forever, and nothing else will
 * ever pick it up. Called at startup, before the worker begins. `attempts` was
 * already incremented at claim time, so a job that crashes the process on every
 * start still terminates rather than looping.
 */
export const requeueStranded = (scope: GuildScope, now: number): number =>
  write(scope, ({ db }) => {
    const result = db
      .update(jobs)
      .set({ state: 'queued', runAfter: now, updatedAt: now })
      .where(scope.only(jobs, eq(jobs.state, 'running')))
      .run();
    return result.changes;
  });

/**
 * The outcome of `bananasaurs jobs retry <id> --confirm`.
 *
 * A union rather than a boolean, because the three refusals need three
 * different actions from the operator: find the right id, wait for the job that
 * is already running, or do nothing because the work is already queued.
 */
export type RetryOutcome =
  | { ok: true; job: JobRow }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'not-failed'; state: string }
  | { ok: false; reason: 'dedupe-blocked'; blockingJobId: number };

/**
 * Returns a failed job to the queue.
 *
 * Only a `failed` job. A `queued` one is already going to run, a `running` one
 * is running, and a `done` one succeeded — requeueing any of those would mean
 * the operator's mental model is wrong, and the refusal says which state it is
 * actually in rather than doing something plausible.
 *
 * **`attempts` resets to zero.** `claimNext` increments it and `failJob` gives
 * up once it reaches `max_attempts`, so a retry that preserved the count would
 * spend one claim arriving back at exactly the state the operator asked to
 * leave.
 *
 * **The dedupe key is checked first.** `jobs_dedupe` is unique over
 * `queued` and `running` rows (ADR 0016), so a failed row and a freshly
 * enqueued replacement coexist — until this makes the failed one queued too, at
 * which point SQLite raises a constraint error naming an index. That is a true
 * statement an operator cannot act on, so the condition is detected and
 * reported as what it means: the work is already going to run, as job N.
 *
 * Select-then-update inside one `write()`; better-sqlite3 is synchronous and
 * `write()` forbids an await, so nothing interleaves between the two.
 */
export const retryJob = (scope: GuildScope, jobId: number, now: number): RetryOutcome =>
  write(scope, ({ db }) => {
    const row = db
      .select(columns)
      .from(jobs)
      .where(scope.only(jobs, eq(jobs.jobId, jobId)))
      .get();

    // Guild-scoped, so another guild's job is not "forbidden", it is not there.
    // Distinguishing the two would confirm the id exists somewhere, which is a
    // partition leak however small.
    if (!row) return { ok: false, reason: 'not-found' };
    if (row.state !== 'failed') return { ok: false, reason: 'not-failed', state: row.state };

    const blocking = db
      .select({ jobId: jobs.jobId })
      .from(jobs)
      .where(
        scope.only(
          jobs,
          eq(jobs.dedupeKey, row.dedupeKey),
          inArray(jobs.state, ['queued', 'running']),
        ),
      )
      .limit(1)
      .get();
    if (blocking) return { ok: false, reason: 'dedupe-blocked', blockingJobId: blocking.jobId };

    db.update(jobs)
      .set({ state: 'queued', attempts: 0, runAfter: now, lastError: null, updatedAt: now })
      .where(scope.only(jobs, eq(jobs.jobId, jobId)))
      .run();

    return { ok: true, job: { ...row, state: 'queued', attempts: 0, runAfter: now } };
  });
