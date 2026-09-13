import type { Subscriber } from '../pipeline/pipeline.js';
import type { ArchivePorts } from './ports.js';

/**
 * The live archive subscriber (ADR 0046 D5, Slice M1 Task 4).
 *
 * Read-side only with respect to moderation: it never calls the effect
 * gateway and never touches `mod_rules` or `mod_cases` writers. It runs
 * after the automod subscriber so a message the automod deletes is still
 * archived as created-then-deleted.
 */
export const createArchiveSubscriber = (ports: ArchivePorts): Subscriber => ({
  name: 'archive',
  handle(_event) {
    void ports;
  },
});
