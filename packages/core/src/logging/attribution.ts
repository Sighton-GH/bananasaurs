import type { Snowflake } from '../discord/port.js';

/**
 * Message-delete attribution (ADR 0022 decision 3).
 *
 * The audit log's `MESSAGE_DELETE` entries coalesce (ADR 0019): an entry
 * describes a *run* of deletions by one actor against one author in one
 * channel, and `count` is a running total, not a per-deletion signal. The
 * only way to tell "a new deletion joined this run" is to remember how much
 * of that count this module has already claimed and compare against what is
 * visible now — which is what `claimedCount` is.
 */

/**
 * How long, once a `MESSAGE_DELETE` is received, to wait before consulting
 * the audit log. ADR 0019 fact 3: the entry appears *after* the dispatch, so
 * a synchronous fetch is expected to find nothing. This is a guess, exactly
 * as the fake's own coalescing window is a guess — Discord documents no
 * figure — comfortably past the fake's `AUDIT_LOG_LAG_MS` (2s).
 */
export const MESSAGE_DELETE_ATTRIBUTION_DELAY_MS = 3_000;

export interface CorrelationCandidate {
  actorUserId: Snowflake;
  /** The audit entry's live `count` (or 1, when Discord sent no `count`). */
  liveCount: number;
  /** How much of that count this module has already attributed to a message. */
  claimedCount: number;
}

/**
 * Decides who deleted a message, or refuses to guess.
 *
 * Exactly one candidate with an unclaimed increment is attributed. Zero
 * candidates means no run shows fresh activity — most likely a self-deletion
 * (ADR 0019 fact 4: it writes no entry at all) or the audit log has not
 * caught up yet. **Two or more candidates with an unclaimed increment is
 * also unknown** — different actors both show a deletion of this author in
 * this channel that nothing has claimed yet, and there is no message id to
 * tell which one is ours (ADR 0019 fact 1). Guessing between them is exactly
 * the guess `docs/20`'s gate forbids, even though one of them is probably
 * right.
 */
export function correlateDeletion(
  candidates: readonly CorrelationCandidate[],
): Snowflake | undefined {
  const active = candidates.filter((c) => c.liveCount - c.claimedCount > 0);
  return active.length === 1 ? active[0]?.actorUserId : undefined;
}
