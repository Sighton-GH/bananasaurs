import { archiveExpiryPayload, JOB_KINDS } from '../jobs/kinds.js';
import type { JobHandler } from '../jobs/worker.js';
import { safeLogFields, type Logger } from '../obs/logger.js';

/**
 * The archive expiry job (ADR 0046 D3, Slice M1 Task 5, Step 2).
 *
 * One run expires one guild's due content through the three tiers — the
 * `day` in the payload names the UTC day the timer enqueued for and exists
 * so the dedupe key collapses repeats, not so this handler reads it: the
 * cutoff is always the current time, so a job that sat through a backlog
 * expires what is due when it runs rather than what was due when queued.
 */

export interface ExpiryPorts {
  expireContent(now: number): number;
  now(): number;
  readonly logger: Logger;
}

export const archiveExpiryHandler = (ports: ExpiryPorts): JobHandler<{ day: string }> => ({
  kind: JOB_KINDS.archiveExpiry,
  payload: archiveExpiryPayload,
  run() {
    const count = ports.expireContent(ports.now());
    ports.logger.info(
      safeLogFields({
        component: 'archive',
        jobKind: JOB_KINDS.archiveExpiry,
        count,
      }),
      'archive: expiry run purged deleted content',
    );
  },
});
