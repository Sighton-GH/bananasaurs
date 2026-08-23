import {
  JOB_KINDS,
  safeLogFields,
  sweepEventDedupePayload,
  type JobHandler,
  type Logger,
  type SweepEventDedupePayload,
} from '@bananasaurs/core';
import { pipelineRepo, type GuildScope } from '@bananasaurs/storage';

/**
 * Job handlers live in the composition root, because this is the only place
 * allowed to know both the domain and the database. `core` defines the kinds
 * and their payload schemas so a producer and a consumer cannot disagree about
 * either; the wiring is here.
 */

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
