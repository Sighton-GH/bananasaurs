import type { Logger } from '../obs/logger.js';
import { safeLogFields } from '../obs/logger.js';

/**
 * The job worker.
 *
 * It owns claiming, retry and failure classification. It does **not** own
 * scheduling: there is no timer here, only `runOnce` and `drain`. The daemon
 * decides when to call them, which keeps `core` free of process lifecycle and
 * keeps the worker trivially testable without fake timers.
 */

export interface ClaimedJob {
  jobId: number;
  kind: string;
  /** JSON we wrote. Still untrusted — see `parsePayload` below. */
  payload: string;
  attempts: number;
  maxAttempts: number;
  cursor: string | null;
}

export interface FailOptions {
  /**
   * Skip the retry schedule and mark the job failed now.
   *
   * For failures that cannot come out differently on a second attempt: an
   * unregistered job kind, or a payload that does not validate. Retrying those
   * five times with exponential backoff burns twenty minutes to reach the same
   * answer, and buries the real error under four duplicates.
   */
  permanent?: boolean;
}

export interface JobStore {
  claimNext(nowMs: number): ClaimedJob | undefined;
  complete(jobId: number, nowMs: number): void;
  fail(jobId: number, error: string, nowMs: number, options?: FailOptions): { willRetry: boolean };
  saveCursor(jobId: number, cursor: string | null, nowMs: number): void;
  requeueStranded(nowMs: number): number;
}

export interface JobContext {
  readonly jobId: number;
  readonly attempts: number;
  /** Progress from a previous attempt, if this job was interrupted. */
  readonly cursor: string | null;
  /** Persist progress, so a restart resumes instead of starting over. */
  saveCursor(cursor: string | null): void;
}

/** Just enough of a Zod schema to validate a payload, without depending on it. */
export interface PayloadSchema<T> {
  parse(input: unknown): T;
}

/**
 * The type a *collection* of handlers takes.
 *
 * `JobHandler<never>` looks like the right existential and is not: `payload` is
 * `PayloadSchema<T>` whose `parse` returns `T`, which is covariant, so
 * `JobHandler<{ x: number }>` is not assignable to `JobHandler<never>`.
 * `unknown` works in both positions — the return type widens, and `run` is
 * declared as a method, so its parameter is bivariant.
 */
export type AnyJobHandler = JobHandler<unknown>;

export interface JobHandler<T = unknown> {
  readonly kind: string;
  /**
   * A payload written by an older version of this process is untrusted input
   * exactly like a form submission (`CLAUDE.md` rule 3). It gets a validator,
   * not a cast.
   */
  readonly payload: PayloadSchema<T>;
  run(payload: T, context: JobContext): Promise<void> | void;
}

export type RunOutcome =
  | { status: 'idle' }
  | { status: 'completed'; jobId: number; kind: string }
  | { status: 'failed'; jobId: number; kind: string; willRetry: boolean; error: string };

export interface JobWorkerDeps {
  readonly store: JobStore;
  readonly handlers: readonly AnyJobHandler[];
  readonly logger: Logger;
  now(): number;
}

const describeError = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

export class JobWorker {
  readonly #byKind = new Map<string, AnyJobHandler>();

  constructor(private readonly deps: JobWorkerDeps) {
    for (const handler of deps.handlers) {
      if (this.#byKind.has(handler.kind)) {
        // Two handlers for one kind means one of them silently never runs.
        throw new Error(`duplicate job handler for kind '${handler.kind}'`);
      }
      this.#byKind.set(handler.kind, handler);
    }
  }

  /**
   * Returns jobs left `running` by a crash to the queue.
   *
   * Call once at startup, before `drain`. Without it a job claimed at the
   * moment of a crash stays marked running forever and nothing picks it up.
   */
  recoverStranded(): number {
    const now = this.deps.now();
    const count = this.deps.store.requeueStranded(now);
    if (count > 0) {
      this.deps.logger.warn(
        safeLogFields({ component: 'jobs', count, reason: 'stranded-at-startup' }),
        'returned jobs left running by a previous process to the queue',
      );
    }
    return count;
  }

  /** Claims and runs at most one job. */
  async runOnce(): Promise<RunOutcome> {
    const { store, logger } = this.deps;
    const job = store.claimNext(this.deps.now());
    if (!job) return { status: 'idle' };

    const handler = this.#byKind.get(job.kind);
    if (!handler) {
      // Permanent: an unregistered kind will still be unregistered in a minute.
      return this.#fail(job, `no handler registered for job kind '${job.kind}'`, true);
    }

    let payload: unknown;
    try {
      payload = handler.payload.parse(JSON.parse(job.payload));
    } catch (err) {
      // Permanent: a payload that does not validate never will.
      return this.#fail(job, `invalid payload: ${describeError(err)}`, true);
    }

    const context: JobContext = {
      jobId: job.jobId,
      attempts: job.attempts,
      cursor: job.cursor,
      saveCursor: (cursor) => store.saveCursor(job.jobId, cursor, this.deps.now()),
    };

    try {
      await handler.run(payload, context);
    } catch (err) {
      return this.#fail(job, describeError(err), false);
    }

    store.complete(job.jobId, this.deps.now());
    logger.info(
      safeLogFields({
        component: 'jobs',
        jobId: job.jobId,
        jobKind: job.kind,
        attempt: job.attempts,
        outcome: 'completed',
      }),
      'job completed',
    );
    return { status: 'completed', jobId: job.jobId, kind: job.kind };
  }

  /**
   * Runs until the queue is empty or `limit` jobs have been attempted.
   *
   * The limit is not a nicety. A handler that enqueues its own successor —
   * a resumable pass, for instance — would otherwise keep this loop running
   * forever and starve everything else in the process.
   */
  async drain(limit = 50): Promise<number> {
    let ran = 0;
    while (ran < limit) {
      const outcome = await this.runOnce();
      if (outcome.status === 'idle') break;
      ran += 1;
    }
    return ran;
  }

  #fail(job: ClaimedJob, error: string, permanent: boolean): RunOutcome {
    const { willRetry } = this.deps.store.fail(job.jobId, error, this.deps.now(), { permanent });
    this.deps.logger.error(
      safeLogFields({
        component: 'jobs',
        jobId: job.jobId,
        jobKind: job.kind,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        outcome: willRetry ? 'will-retry' : 'failed',
        error,
      }),
      'job failed',
    );
    return { status: 'failed', jobId: job.jobId, kind: job.kind, willRetry, error };
  }
}
