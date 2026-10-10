import type { ClaimedJob, ClaimFilter, FailOptions, JobStore } from '@bananasaurs/core';
import type { GuildScope } from '../scope.js';
import {
  claimNext,
  completeJob,
  failJob,
  requeueStranded,
  saveCursor,
  type JobRow,
} from './jobs.js';

/**
 * Binds the job repository to one guild, producing the `JobStore` port that
 * `core`'s worker consumes.
 *
 * The worker never sees a `GuildScope` and has no way to reach another guild's
 * queue: the scope is captured here, once, at wiring time. That is the shape
 * every port in this package takes — `core` holds behaviour, the scope stays on
 * this side of the boundary.
 */
const toClaimedJob = (row: JobRow): ClaimedJob => ({
  jobId: row.jobId,
  kind: row.kind,
  payload: row.payload,
  attempts: row.attempts,
  maxAttempts: row.maxAttempts,
  cursor: row.cursor,
  orderingKey: row.orderingKey,
});

export const jobStoreFor = (scope: GuildScope): JobStore => ({
  claimNext(nowMs, filter?: ClaimFilter) {
    const row = claimNext(scope, nowMs, filter);
    return row ? toClaimedJob(row) : undefined;
  },
  complete(jobId, nowMs) {
    completeJob(scope, jobId, nowMs);
  },
  fail(jobId, error, nowMs, options: FailOptions = {}) {
    const { willRetry } = failJob(scope, jobId, error, nowMs, options);
    return { willRetry };
  },
  saveCursor(jobId, cursor, nowMs) {
    saveCursor(scope, jobId, cursor, nowMs);
  },
  requeueStranded(nowMs) {
    return requeueStranded(scope, nowMs);
  },
});
