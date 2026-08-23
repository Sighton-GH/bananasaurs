import { z } from 'zod';

/**
 * Job kinds and their payload schemas.
 *
 * The kind strings and the schemas live in `core` so a producer and a consumer
 * cannot disagree about either. The handlers themselves live where their
 * dependencies do — the composition root — because a handler that sweeps a
 * table needs the database, and `core` may not have it.
 */

export const JOB_KINDS = {
  /** Bounds `event_dedupe`, which otherwise grows one row per event forever. */
  sweepEventDedupe: 'sweep_event_dedupe',
  /** Repairs drift after a gateway gap, or on the periodic timer. */
  reconcileGuild: 'reconcile_guild',
} as const;

export type JobKind = (typeof JOB_KINDS)[keyof typeof JOB_KINDS];

export const sweepEventDedupePayload = z.object({
  /** Rows first seen strictly before this are dropped. */
  olderThanMs: z.number().int().nonnegative(),
});
export type SweepEventDedupePayload = z.infer<typeof sweepEventDedupePayload>;

export const reconcileGuildPayload = z.object({
  /** The gap that caused this, when there was one. Absent for the timer pass. */
  gapId: z.number().int().positive().optional(),
  reason: z.enum(['gateway-gap', 'timer', 'operator']),
});
export type ReconcileGuildPayload = z.infer<typeof reconcileGuildPayload>;

/**
 * A dedupe key that collapses repeated requests for the same work.
 *
 * A flapping connection produces a reconnect every few seconds. Without
 * collapsing, each one queues its own reconciliation and the worker spends the
 * whole outage repeating a pass whose inputs have not changed.
 */
export const reconcileDedupeKey = (reason: ReconcileGuildPayload['reason']): string =>
  `${JOB_KINDS.reconcileGuild}:${reason}`;

/** One sweep pending at a time is enough; the next run picks up what it missed. */
export const sweepDedupeKey = (): string => JOB_KINDS.sweepEventDedupe;
