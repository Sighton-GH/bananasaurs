import type { Client } from 'discord.js';
import {
  createChannelAccess,
  isNoAccess,
  type ChannelAccess,
  type Snowflake,
} from '@bananasaurs/core';
import {
  archiveRepo,
  channelReadRepo,
  loggingRepo,
  mcpSendRepo,
  type GuildScope,
} from '@bananasaurs/storage';
import { resolveChannel, resolveChannelCached } from './resolver.js';

/**
 * The daemon's per-guild `ChannelAccess` (channel-permissions Task 3).
 *
 * Stateless: no field on the guild runtime, no cache. Every consumer calls
 * this where it already holds the live client and a `GuildScope`, so a moved
 * channel or a changed row takes effect on the next check — the same
 * no-caching contract `createChannelAccess` documents. Every predicate reads
 * its repository through `scope`.
 */
export const channelAccessFor = (client: Client, scope: GuildScope): ChannelAccess =>
  createChannelAccess({
    resolve: async (channelId: Snowflake) => {
      const resolved = await resolveChannel(client, scope.guildId, channelId);
      if (resolved === undefined) return undefined;
      return {
        channelId: resolved.channelId,
        parentChannelId: resolved.parentChannelId,
        categoryId: resolved.categoryId,
        isPrivateThread: resolved.isPrivateThread,
      };
    },
    isExcluded: (id) => loggingRepo.isChannelExcluded(scope, id),
    read: {
      hasOwnRow: (id) => channelReadRepo.isReadScopeAllowed(scope, id, 'channel'),
      hasCategoryRow: (id) => channelReadRepo.isReadScopeAllowed(scope, id, 'category'),
    },
    write: {
      hasOwnRow: (id) => mcpSendRepo.isChannelAllowed(scope, id),
      hasCategoryRow: (id) => mcpSendRepo.isScopeAllowed(scope, id, 'category'),
    },
    record: {
      hasOwnRow: (id) => archiveRepo.isChannelEnabled(scope, id),
      hasCategoryRow: (id) => archiveRepo.hasCategoryRow(scope, id),
      hasPausedOwnRow: (id) => archiveRepo.hasPausedOwnRow(scope, id),
      parentIncludesThreads: (id) => archiveRepo.parentIncludesThreads(scope, id),
    },
    hasArchivedChannel: (channelId) => archiveRepo.hasArchivedChannel(scope, channelId),
  });

/**
 * The synchronous No-access check for the archive read ports (ADR 0126 Task
 * 9), which must stay synchronous. Resolves from the channel cache only — no
 * fetch — and applies the channel → parent → category exclusion precedence.
 * A channel the cache cannot resolve (deleted, or never cached) answers from
 * its own exclusion only, so archived history of a channel no longer in
 * Discord stays searchable unless that channel id itself is excluded.
 */
export const noAccessFromCache = (
  client: Client,
  scope: GuildScope,
  channelId: Snowflake,
): boolean => {
  const resolved = resolveChannelCached(client, scope.guildId, channelId);
  if (resolved === undefined) return loggingRepo.isChannelExcluded(scope, channelId);
  return isNoAccess({
    channelId: resolved.channelId,
    parentChannelId: resolved.parentChannelId,
    categoryId: resolved.categoryId,
    isExcluded: (id) => loggingRepo.isChannelExcluded(scope, id),
  });
};

/**
 * N5: the archived thread ids excluded ON THEIR OWN, computed once per call,
 * so the repository drops those rows in SQL, before its limit, instead of
 * after it. A thread hidden by its parent or category needs no entry: thread
 * rows are archived under the parent's channel_id, and every caller's
 * channel-level filter (visibility set or channel pre-check) already drops
 * them. Listing only own exclusions keeps the parameter list small (R2) —
 * excluding one busy forum must not push it past SQLite's variable limit.
 */
export const excludedThreadIds = (scope: GuildScope): readonly string[] => {
  const excluded = new Set(loggingRepo.listExcludedChannels(scope));
  if (excluded.size === 0) return [];
  return archiveRepo.listArchivedThreadIds(scope).filter((threadId) => excluded.has(threadId));
};

/**
 * ADR 0126 M6: drop the rows No access hides — the row's channel or, for a
 * thread message, the thread itself (an exclusion on the thread, its parent
 * or its category hides it). Thread messages are archived under the parent's
 * channel_id with thread_id set, so a channel-level filter alone misses a
 * thread excluded on its own. Verdicts are memoized per call: a digest page
 * holds up to 1001 rows and each check is up to three exclusion reads.
 */
export const withoutNoAccessRows = <
  T extends { readonly channelId: string; readonly threadId?: string | undefined },
>(
  client: Client,
  scope: GuildScope,
  rows: readonly T[],
): T[] => {
  const verdict = new Map<string, boolean>();
  const isNoAccessRow = (id: string): boolean => {
    const known = verdict.get(id);
    if (known !== undefined) return known;
    const denied = noAccessFromCache(client, scope, id);
    verdict.set(id, denied);
    return denied;
  };
  return rows.filter(
    (row) =>
      !isNoAccessRow(row.channelId) && (row.threadId === undefined || !isNoAccessRow(row.threadId)),
  );
};
