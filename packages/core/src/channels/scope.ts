import type { Snowflake } from '../discord/port.js';

export type ScopePurpose = 'archive' | 'send';

export interface ScopeFacts {
  readonly channelId: Snowflake;
  readonly parentChannelId: Snowflake | undefined;
  readonly categoryId: Snowflake | undefined;
  readonly isPrivateThread: boolean;
  readonly hasOwnRow: (id: Snowflake) => boolean;
  readonly hasCategoryRow: (id: Snowflake) => boolean;
  readonly isExcluded: (id: Snowflake) => boolean;
  readonly parentIncludesThreads: (id: Snowflake) => boolean;
}

/**
 * The single dynamic authorization predicate for archive and send scope
 * (review M3): returns the id of the row that GRANTS the scope — the
 * channel, its parent, or its category — and `undefined` when nothing does.
 * Callers that record provenance (the MCP send audit's
 * `grantedByChannelId`) get it from here rather than re-walking the
 * precedence themselves; the precedence is identical to the old boolean.
 */
export const isInScope = (purpose: ScopePurpose, facts: ScopeFacts): Snowflake | undefined => {
  const { channelId, parentChannelId, categoryId, isPrivateThread } = facts;
  if (facts.isExcluded(channelId)) return undefined;
  if (parentChannelId !== undefined && facts.isExcluded(parentChannelId)) return undefined;
  if (categoryId !== undefined && facts.isExcluded(categoryId)) return undefined;

  if (facts.hasOwnRow(channelId)) return channelId;
  if (isPrivateThread) return undefined;

  if (parentChannelId !== undefined) {
    const threadsAllowed = purpose === 'send' || facts.parentIncludesThreads(parentChannelId);
    if (threadsAllowed && facts.hasOwnRow(parentChannelId)) return parentChannelId;
  }

  if (categoryId !== undefined && facts.hasCategoryRow(categoryId)) {
    if (parentChannelId === undefined) return categoryId;
    return purpose === 'send' || facts.parentIncludesThreads(parentChannelId)
      ? categoryId
      : undefined;
  }
  return undefined;
};
