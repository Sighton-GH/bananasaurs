import {
  JOB_KINDS,
  pruneJobsPayload,
  safeLogFields,
  sweepEventDedupePayload,
  type JobHandler,
  type Logger,
  type PruneJobsPayload,
  type SweepEventDedupePayload,
} from '@bananasaurs/core';
import { jobRepo, pipelineRepo, type GuildScope } from '@bananasaurs/storage';

/**
 * Job handlers live in the composition root, because this is the only place
 * allowed to know both the domain and the database. `core` defines the kinds
 * and their payload schemas so a producer and a consumer cannot disagree about
 * either; the wiring is here.
 */

const PRUNE_JOBS_BATCH = 500;

export const pruneJobsHandler = (scope: GuildScope, logger: Logger): JobHandler<PruneJobsPayload> => ({
  kind: JOB_KINDS.pruneJobs,
  payload: pruneJobsPayload,
  async run(payload) {
    // Batched, yielding between batches, so the first prune over a large
    // backlog never holds the event loop for one long DELETE.
    let removed = 0;
    for (;;) {
      const batch = jobRepo.deleteFinishedBatch(scope, payload.olderThanMs, PRUNE_JOBS_BATCH);
      removed += batch;
      if (batch < PRUNE_JOBS_BATCH) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    logger.info(
      safeLogFields({ component: 'jobs', jobKind: JOB_KINDS.pruneJobs, guildId: scope.guildId, count: removed }),
      'pruned finished jobs',
    );
  },
});

export const sweepEventDedupeHandler = (
  scope: GuildScope,
  logger: Logger,
): JobHandler<SweepEventDedupePayload> => ({
  kind: JOB_KINDS.sweepEventDedupe,
  payload: sweepEventDedupePayload,
  run(payload) {
    // The cutoff travels in the payload rather than being recomputed here, so
    // a job that sat through a backlog sweeps the window it was created for
    // rather than one that has since moved past rows it was meant to keep.
    const removed = pipelineRepo.sweepEventDedupe(scope, payload.olderThanMs);
    logger.info(
      safeLogFields({
        component: 'jobs',
        jobKind: JOB_KINDS.sweepEventDedupe,
        guildId: scope.guildId,
        count: removed,
        total: pipelineRepo.countEventDedupe(scope),
      }),
      'swept expired event fingerprints',
    );
  },
});
