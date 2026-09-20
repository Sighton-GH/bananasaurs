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

/** Cache first; one Discord fetch on miss; never returns a channel from another guild. */
export const resolveChannel = async (
  client: Client,
  guildId: Snowflake,
  channelId: Snowflake,
): Promise<ResolvedChannel | undefined> => {
  const cached = client.channels.cache.get(channelId);
  if (cached !== undefined && !cached.isDMBased()) return fromChannel(guildId, cached);
  const fetched = await client.channels.fetch(channelId).catch(() => null);
  return fetched !== null && !fetched.isDMBased() ? fromChannel(guildId, fetched) : undefined;
};
