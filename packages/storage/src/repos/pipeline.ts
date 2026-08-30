import { and, eq, isNull, lt } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { eventDedupe, gatewayGaps } from '../schema.js';

/**
 * Event dedupe and gateway gaps.
 *
 * Note on readonly mode: `recordFirstSight` writes, so it throws
 * `ReadonlyError` when the process was started with `BANANASAURS_READONLY`.
 * That is deliberate rather than a degradation — a readonly process that
 * processed gateway events would either drop deduplication (letting replays
 * through) or silently pretend to record. The daemon does not attach the
 * pipeline in readonly mode; if it ever does, this is meant to say so loudly.
 */

export interface FirstSightInput {
  eventKind: string;
  fingerprint: string;
  atMs: number;
}

/**
 * Records the first sight of a fingerprint, returning true if it is the first.
 *
 * INSERT OR IGNORE and a zero-row result, so the check and the record are one
 * atomic statement. A read-then-write would leave a window in which a replayed
 * dispatch — which is exactly what this exists to stop — slips between them.
 */
export const recordFirstSight = (scope: GuildScope, input: FirstSightInput): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .insert(eventDedupe)
      .values({
        guildId: scope.guildId,
        eventKind: input.eventKind,
        fingerprint: input.fingerprint,
        firstSeenAt: input.atMs,
      })
      .onConflictDoNothing()
      .run();
    return result.changes === 1;
  });

/**
 * Releases a claim made by `recordFirstSight`, so the same fingerprint can be
 * seen as "first" again.
 *
 * For ADR 0023: the logging module claims before attempting a Discord send
 * and releases the claim if the send throws, so a transient failure does not
 * blackhole a log line forever the way it safely can for a role effect (which
 * has reconciliation to fall back on; logging does not). A harmless no-op
 * when nothing was claimed, matching `recordFirstSight`'s own tolerance for
 * being called from a guarded, non-concurrent path (ADR 0020: one promise
 * chain per guild, so there is no race between a claim and its release).
 */
export const forgetFirstSight = (
  scope: GuildScope,
  input: Pick<FirstSightInput, 'eventKind' | 'fingerprint'>,
): void =>
  write(scope, ({ db }) => {
    db.delete(eventDedupe)
      .where(
        scope.only(
          eventDedupe,
          and(
            eq(eventDedupe.eventKind, input.eventKind),
            eq(eventDedupe.fingerprint, input.fingerprint),
          ),
        ),
      )
      .run();
  });

/**
 * Drops dedupe rows older than the retention window.
 *
 * The table grows without bound otherwise — one row per non-reaction event,
 * forever. Bounding it is the whole reason `event_dedupe_sweep` exists as an
 * index. The window must comfortably exceed the longest plausible replay
 * window; a reconnect replays recent history, not last week's.
 */
export const sweepEventDedupe = (scope: GuildScope, olderThanMs: number): number =>
  write(scope, ({ db }) => {
    const result = db
      .delete(eventDedupe)
      .where(scope.only(eventDedupe, lt(eventDedupe.firstSeenAt, olderThanMs)))
      .run();
    return result.changes;
  });

/** Rows currently held, for `doctor` and for the sweep's own logging. */
export const countEventDedupe = (scope: GuildScope): number =>
  read(scope, (db) => db.select().from(eventDedupe).where(scope.only(eventDedupe)).all().length);

export interface GapInput {
  disconnectedAtMs: number;
  reconnectedAtMs: number;
  /** RESUMED replays the gap; a fresh IDENTIFY does not. */
  resumed: boolean;
}

export interface GapRow {
  gapId: number;
  disconnectedAt: number;
  reconnectedAt: number;
  resumed: number;
  reconciledAt: number | null;
}

/**
 * Records a connection gap.
 *
 * `resumed = false` means a fresh IDENTIFY, so dispatches in the window were
 * lost and are not replayed. Reaction state is recoverable by reconciliation;
 * message edits and deletions are not, which is why the logging module marks
 * the gap rather than presenting the period as quiet.
 */
export const recordGap = (scope: GuildScope, input: GapInput): number =>
  write(scope, ({ db }) => {
    const result = db
      .insert(gatewayGaps)
      .values({
        guildId: scope.guildId,
        disconnectedAt: input.disconnectedAtMs,
        reconnectedAt: input.reconnectedAtMs,
        resumed: input.resumed ? 1 : 0,
      })
      .run();
    return Number(result.lastInsertRowid);
  });

/** Gaps that still need a reconciliation pass. */
export const unreconciledGaps = (scope: GuildScope): GapRow[] =>
  read(scope, (db) =>
    db
      .select({
        gapId: gatewayGaps.gapId,
        disconnectedAt: gatewayGaps.disconnectedAt,
        reconnectedAt: gatewayGaps.reconnectedAt,
        resumed: gatewayGaps.resumed,
        reconciledAt: gatewayGaps.reconciledAt,
      })
      .from(gatewayGaps)
      .where(scope.only(gatewayGaps, isNull(gatewayGaps.reconciledAt)))
      .all(),
  );

export const markGapReconciled = (scope: GuildScope, gapId: number, now: number): void =>
  write(scope, ({ db }) => {
    db.update(gatewayGaps)
      .set({ reconciledAt: now })
      .where(scope.only(gatewayGaps, and(eq(gatewayGaps.gapId, gapId))))
      .run();
  });
