import type { Logger } from '../obs/logger.js';
import { safeLogFields } from '../obs/logger.js';
import type { Subscriber } from './pipeline.js';
import { JOB_KINDS, reconcileDedupeKey } from '../jobs/kinds.js';

/**
 * Turns a reconnect into a durable record, and a *lossy* reconnect into work.
 *
 * The distinction is the whole point. `resumed: true` means Discord replayed
 * the dispatches we missed, so there is nothing to repair. `resumed: false`
 * means a fresh IDENTIFY: everything in the window is gone and will not be
 * redelivered. Reaction state is recoverable by reconciliation; message edits
 * and deletions are not, which is why the gap is recorded either way rather
 * than only when there is work to do.
 */

export interface ConnectionPorts {
  recordGap(input: { disconnectedAtMs: number; reconnectedAtMs: number; resumed: boolean }): number;
  enqueueReconcile(input: { gapId: number; dedupeKey: string; payload: string }): {
    enqueued: boolean;
  };
}

export const createConnectionSubscriber = (ports: ConnectionPorts, logger: Logger): Subscriber => ({
  name: 'connection',
  handle(event) {
    if (event.kind !== 'connection') return;

    const gapId = ports.recordGap({
      disconnectedAtMs: event.disconnectedAtMs,
      reconnectedAtMs: event.receivedAtMs,
      resumed: event.resumed,
    });

    if (event.resumed) {
      logger.info(
        safeLogFields({
          component: 'connection',
          guildId: event.guildId,
          durationMs: event.receivedAtMs - event.disconnectedAtMs,
          outcome: 'resumed',
        }),
        'session resumed; the gap was replayed',
      );
      return;
    }

    const { enqueued } = ports.enqueueReconcile({
      gapId,
      dedupeKey: reconcileDedupeKey('gateway-gap'),
      payload: JSON.stringify({ gapId, reason: 'gateway-gap' }),
    });

    logger.warn(
      safeLogFields({
        component: 'connection',
        guildId: event.guildId,
        durationMs: event.receivedAtMs - event.disconnectedAtMs,
        jobKind: JOB_KINDS.reconcileGuild,
        outcome: enqueued ? 'reconcile-queued' : 'reconcile-already-queued',
      }),
      'fresh IDENTIFY: dispatches in the gap were lost and will not be replayed',
    );
  },
});
