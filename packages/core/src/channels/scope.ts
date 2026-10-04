import type { Snowflake } from '../discord/port.js';

export type ScopePurpose = 'archive' | 'send' | 'read';

export interface ScopeFacts {
  readonly channelId: Snowflake;
  readonly parentChannelId: Snowflake | undefined;
  readonly categoryId: Snowflake | undefined;
  readonly isPrivateThread: boolean;
  readonly hasOwnRow: (id: Snowflake) => boolean;
  readonly hasCategoryRow: (id: Snowflake) => boolean;
  readonly isExcluded: (id: Snowflake) => boolean;
  readonly parentIncludesThreads: (id: Snowflake) => boolean;
  /**
   * ADR 0126 I1: a paused own row (`collecting = 0`, kind `channel`) vetoes
   * the `archive` purpose — pausing stops recording even under a collecting
   * category. Only the archive path reads it; `read` and `send` never do.
   */
  readonly hasPausedOwnRow?: ((id: Snowflake) => boolean) | undefined;
}

/**
 * No access: an exclusion on the channel, its parent, or its category. The
 * single veto implementation; `isInScope` calls it so the two cannot drift.
 * Sync, for subscribers that hold event facts.
 */
export const isNoAccess = (
  facts: Pick<ScopeFacts, 'channelId' | 'parentChannelId' | 'categoryId' | 'isExcluded'>,
): boolean =>
  facts.isExcluded(facts.channelId) ||
  (facts.parentChannelId !== undefined && facts.isExcluded(facts.parentChannelId)) ||
  (facts.categoryId !== undefined && facts.isExcluded(facts.categoryId));

/**
 * The single dynamic authorization predicate for archive, send and read scope
 * (review M3): returns the id of the row that GRANTS the scope — the
 * channel, its parent, or its category — and `undefined` when nothing does.
 * Callers that record provenance (the MCP send audit's
 * `grantedByChannelId`) get it from here rather than re-walking the
 * precedence themselves; the precedence is identical to the old boolean.
 */
export const isInScope = (purpose: ScopePurpose, facts: ScopeFacts): Snowflake | undefined => {
  const { channelId, parentChannelId, categoryId, isPrivateThread } = facts;
  if (isNoAccess(facts)) return undefined;

  // ADR 0126 I1: Archive off stops recording. A paused own row is a veto for
  // the archive purpose only — `hasOwnRow` already ignores paused rows, so
  // without this the check would fall through to the parent or category. For
  // a thread, the parent's paused own row vetoes the same way.
  if (purpose === 'archive' && facts.hasPausedOwnRow !== undefined) {
    if (facts.hasPausedOwnRow(channelId)) return undefined;
    if (parentChannelId !== undefined && facts.hasPausedOwnRow(parentChannelId)) return undefined;
  }

  if (facts.hasOwnRow(channelId)) return channelId;
  // Owner decision 2026-10-03: a private thread inherits Read and Write from
  // its parent or category. Archive still never inherits — a private thread
  // is recorded only under its own row.
  if (isPrivateThread && purpose === 'archive') return undefined;

  if (parentChannelId !== undefined) {
    const threadsAllowed = purpose !== 'archive' || facts.parentIncludesThreads(parentChannelId);
    if (threadsAllowed && facts.hasOwnRow(parentChannelId)) return parentChannelId;
  }

  if (categoryId !== undefined && facts.hasCategoryRow(categoryId)) {
    if (parentChannelId === undefined) return categoryId;
    return purpose !== 'archive' || facts.parentIncludesThreads(parentChannelId)
      ? categoryId
      : undefined;
  }
  return undefined;
};
