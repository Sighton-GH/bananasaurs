import { z } from 'zod';
import { snowflakeIdSchema } from '../ids.js';

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
  /** Turns a panel's existing reactions into roles, once an owner sized it. */
  adoptPanel: 'adopt_panel',
  /** Consults the audit log for who deleted a message (ADR 0019, ADR 0023). */
  logMessageDelete: 'log_message_delete',
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

export const adoptPanelPayload = z.object({
  panelId: z.string().min(1).max(64),
});
export type AdoptPanelPayload = z.infer<typeof adoptPanelPayload>;

/**
 * One pending adoption per panel.
 *
 * Per panel rather than global: adopting two panels are independent pieces of
 * work and collapsing them would silently drop one. Re-enqueueable once the
 * first has finished — see ADR 0016, which is what makes "grant the allowance,
 * then run the pass again" possible at all.
 */
export const adoptDedupeKey = (panelId: string): string => `${JOB_KINDS.adoptPanel}:${panelId}`;

/**
 * `undefined` on `authorId` and `content` are decisions, not omissions:
 * `authorId` is genuinely absent when the message was uncached (ADR 0019
 * fact 4), and `content` is `undefined` both when uncached and when the
 * route's `include_content` was off at enqueue time — decided once, there,
 * rather than persisting content the owner turned off into the job table
 * for the run_after delay's duration.
 */
export const logMessageDeletePayload = z.object({
  channelId: snowflakeIdSchema,
  messageId: snowflakeIdSchema,
  authorId: snowflakeIdSchema.optional(),
  content: z.string().optional(),
  deletedAtMs: z.number().int().nonnegative(),
});
export type LogMessageDeletePayload = z.infer<typeof logMessageDeletePayload>;

/** One job per deletion — a message is deleted at most once. */
export const logMessageDeleteDedupeKey = (channelId: string, messageId: string): string =>
  `${JOB_KINDS.logMessageDelete}:${channelId}:${messageId}`;
