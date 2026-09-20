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

/** The single dynamic authorization predicate for archive and send scope. */
export const isInScope = (purpose: ScopePurpose, facts: ScopeFacts): boolean => {
  const { channelId, parentChannelId, categoryId, isPrivateThread } = facts;
  if (facts.isExcluded(channelId)) return false;
  if (parentChannelId !== undefined && facts.isExcluded(parentChannelId)) return false;
  if (categoryId !== undefined && facts.isExcluded(categoryId)) return false;

  if (facts.hasOwnRow(channelId)) return true;
  if (isPrivateThread) return false;

  if (parentChannelId !== undefined) {
    const threadsAllowed = purpose === 'send' || facts.parentIncludesThreads(parentChannelId);
    if (threadsAllowed && facts.hasOwnRow(parentChannelId)) return true;
  }

  if (categoryId !== undefined && facts.hasCategoryRow(categoryId)) {
    if (parentChannelId === undefined) return true;
    return purpose === 'send' || facts.parentIncludesThreads(parentChannelId);
  }
  return false;
};
