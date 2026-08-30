import { and, asc, desc, eq, lte } from 'drizzle-orm';
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
};

export interface EnqueueInput {
  kind: string;
  payload: string;
  /** Makes enqueuing the same work twice a no-op. */
  dedupeKey: string;
  runAfter?: number;
  maxAttempts?: number;
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
    const result = db
      .insert(jobs)
      .values({
        guildId: scope.guildId,
        kind: input.kind,
        payload: input.payload,
        dedupeKey: input.dedupeKey,
        runAfter: input.runAfter ?? input.now,
        maxAttempts: input.maxAttempts ?? 5,
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
 */
export const claimNext = (scope: GuildScope, now: number): JobRow | undefined =>
  write(scope, ({ db }) => {
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

    const nextRunAfter = now + backoffMs(row.attempts);
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
    const rows = db.select(columns).from(jobs).where(scope.only(jobs)).all();
    const out: Record<string, number> = {};
    for (const row of rows) out[row.state] = (out[row.state] ?? 0) + 1;
    return out;
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
