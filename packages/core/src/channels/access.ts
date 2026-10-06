import type { Snowflake } from '../discord/port.js';
import { isInScope, isNoAccess, type ScopeFacts, type ScopePurpose } from './scope.js';

export interface ChannelFacts {
  readonly channelId: Snowflake;
  readonly parentChannelId: Snowflake | undefined;
  readonly categoryId: Snowflake | undefined;
  readonly isPrivateThread: boolean;
}

export type AccessPurpose = 'read' | 'write' | 'record';

export type AccessDecision =
  | { readonly allowed: true; readonly grantedBy: Snowflake }
  | { readonly allowed: false; readonly reason: 'no-access' | 'not-granted' | 'unknown-channel' };

export interface RowPredicates {
  hasOwnRow(id: Snowflake): boolean;
  hasCategoryRow(id: Snowflake): boolean;
}

export interface ChannelAccessDeps {
  resolve(channelId: Snowflake): Promise<ChannelFacts | undefined>;
  isExcluded(id: Snowflake): boolean;
  read: RowPredicates;
  write: RowPredicates;
  record: RowPredicates & {
    parentIncludesThreads(id: Snowflake): boolean;
    /** ADR 0126 I1: the pause veto; absent means no row is paused. */
    hasPausedOwnRow?(id: Snowflake): boolean;
  };
  hasArchivedChannel(channelId: Snowflake): boolean;
}

export interface ChannelAccess {
  check(purpose: AccessPurpose, channelId: Snowflake): Promise<AccessDecision>;
  /** Archived history readable: an archive row exists and the channel is not No access. Unresolvable channel → own exclusion only. */
  canSearchArchived(channelId: Snowflake): Promise<boolean>;
  isNoAccess(channelId: Snowflake): Promise<boolean>; // unresolvable → own exclusion only
}

/**
 * The one place a Discord-facing feature asks "may I read / write / record
 * this channel". No caching: facts are re-resolved on every call so a moved
 * channel or a changed row takes effect immediately. Fail closed: a channel
 * that cannot be resolved is denied.
 */
export const createChannelAccess = (deps: ChannelAccessDeps): ChannelAccess => {
  const scopeFacts = (
    f: ChannelFacts,
    rows: RowPredicates,
    parentIncludesThreads: (id: Snowflake) => boolean,
  ): ScopeFacts => ({
    ...f,
    hasOwnRow: (id) => rows.hasOwnRow(id),
    hasCategoryRow: (id) => rows.hasCategoryRow(id),
    isExcluded: (id) => deps.isExcluded(id),
    parentIncludesThreads,
  });

  const noAccessOf = (f: ChannelFacts): boolean =>
    isNoAccess({ ...f, isExcluded: (id) => deps.isExcluded(id) });

  const isNoAccessById = async (channelId: Snowflake): Promise<boolean> => {
    const f = await deps.resolve(channelId);
    if (f === undefined) return deps.isExcluded(channelId);
    return noAccessOf(f);
  };

  return {
    async check(purpose, channelId) {
      const f = await deps.resolve(channelId);
      if (f === undefined) return { allowed: false, reason: 'unknown-channel' };
      if (noAccessOf(f)) return { allowed: false, reason: 'no-access' };
      let scopePurpose: ScopePurpose;
      let facts: ScopeFacts;
      if (purpose === 'read') {
        scopePurpose = 'read';
        facts = scopeFacts(f, deps.read, () => true);
      } else if (purpose === 'write') {
        scopePurpose = 'send';
        facts = scopeFacts(f, deps.write, () => true);
      } else {
        scopePurpose = 'archive';
        const recordFacts = scopeFacts(f, deps.record, (id) =>
          deps.record.parentIncludesThreads(id),
        );
        // Called through `deps.record` (never separated from its object):
        // the branch above already proved it defined, and `?? false` is
        // type-level only.
        facts =
          deps.record.hasPausedOwnRow === undefined
            ? recordFacts
            : {
                ...recordFacts,
                hasPausedOwnRow: (id: Snowflake) => deps.record.hasPausedOwnRow?.(id) ?? false,
              };
      }
      const grantedBy = isInScope(scopePurpose, facts);
      return grantedBy === undefined
        ? { allowed: false, reason: 'not-granted' }
        : { allowed: true, grantedBy };
    },

    async canSearchArchived(channelId) {
      if (!deps.hasArchivedChannel(channelId)) return false;
      return !(await isNoAccessById(channelId));
    },

    async isNoAccess(channelId) {
      return isNoAccessById(channelId);
    },
  };
};
