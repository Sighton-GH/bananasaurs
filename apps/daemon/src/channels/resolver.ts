import { ChannelType, type Client, type GuildBasedChannel } from 'discord.js';
import type { Snowflake } from '@bananasaurs/core';

export interface ResolvedChannel {
  readonly channelId: Snowflake;
  readonly parentChannelId: Snowflake | undefined;
  readonly categoryId: Snowflake | undefined;
  readonly isPrivateThread: boolean;
  readonly isThread: boolean;
  readonly isForum: boolean;
  readonly postable: boolean;
}

const fromChannel = (
  guildId: Snowflake,
  channel: GuildBasedChannel,
): ResolvedChannel | undefined => {
  if (channel.guildId !== guildId) return undefined;
  const isThread = channel.isThread();
  const parentChannelId = isThread ? (channel.parentId ?? undefined) : undefined;
  const authorized = isThread ? channel.parent : channel;
  return {
    channelId: channel.id,
    parentChannelId,
    categoryId:
      authorized !== null && 'parentId' in authorized
        ? (authorized.parentId ?? undefined)
        : undefined,
    isPrivateThread: isThread && channel.type === ChannelType.PrivateThread,
    isThread,
    isForum: channel.type === ChannelType.GuildForum || authorized?.type === ChannelType.GuildForum,
    postable: channel.isTextBased() && !channel.isDMBased(),
  };
};

/** Cache only, never fetches: for synchronous ports that must stay synchronous. */
export const resolveChannelCached = (
  client: Client,
  guildId: Snowflake,
  channelId: Snowflake,
): ResolvedChannel | undefined => {
  const cached = client.channels.cache.get(channelId);
  if (cached === undefined || cached.isDMBased()) return undefined;
  return fromChannel(guildId, cached);
};

/** Cache first; one Discord fetch on miss; never returns a channel from another guild. */
export const resolveChannel = async (
  client: Client,
  guildId: Snowflake,
  channelId: Snowflake,
): Promise<ResolvedChannel | undefined> => {
  const cached = resolveChannelCached(client, guildId, channelId);
  if (cached !== undefined) return withThreadParentCategory(client, guildId, cached);
  const fetched = await client.channels.fetch(channelId).catch(() => null);
  const resolved =
    fetched !== null && !fetched.isDMBased() ? fromChannel(guildId, fetched) : undefined;
  if (resolved === undefined) return undefined;
  return withThreadParentCategory(client, guildId, resolved);
};

/**
 * ADR 0126 F6: a thread whose parent is not cached carries
 * `categoryId: undefined`, so a category exclusion would be missed for that
 * call. Fetch the parent once — the same one-fetch rule as the channel
 * itself — and read the category off it. A parent that cannot be fetched,
 * is a DM, or is from another guild leaves the category unknown.
 */
const withThreadParentCategory = async (
  client: Client,
  guildId: Snowflake,
  resolved: ResolvedChannel,
): Promise<ResolvedChannel> => {
  if (
    !resolved.isThread ||
    resolved.parentChannelId === undefined ||
    resolved.categoryId !== undefined
  )
    return resolved;
  const parent = await client.channels.fetch(resolved.parentChannelId).catch(() => null);
  if (parent === null || parent.isDMBased() || parent.guildId !== guildId) return resolved;
  return {
    ...resolved,
    categoryId: 'parentId' in parent ? (parent.parentId ?? undefined) : undefined,
  };
};
