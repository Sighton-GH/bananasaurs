import { PermissionsBitField } from 'discord.js';

/** The slice of a discord.js `Guild` this needs, so it can be tested without one. */
export interface MemberChannelsGuild {
  readonly channels: {
    readonly cache: ReadonlyMap<
      string,
      { readonly id: string; readonly name: string; isTextBased(): boolean; isThread(): boolean }
    >;
  };
  readonly members: {
    fetch(userId: string): Promise<{
      permissionsIn(channel: { readonly id: string }): { has(permission: bigint): boolean };
    }>;
  };
}

const READ = PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.ReadMessageHistory;

/**
 * The text channels a member can view and read history in, from their live
 * permissions (ADR 0067). Threads are left out. Anything unknown (the guild
 * not cached, the member not fetchable) fails closed to no channels.
 */
export const memberChannels = async (
  guild: MemberChannelsGuild | undefined,
  userId: string,
): Promise<readonly { id: string; name: string }[]> => {
  if (guild === undefined) return [];
  let member: Awaited<ReturnType<MemberChannelsGuild['members']['fetch']>>;
  try {
    member = await guild.members.fetch(userId);
  } catch {
    return [];
  }
  return [...guild.channels.cache.values()]
    .filter((c) => c.isTextBased() && !c.isThread() && member.permissionsIn(c).has(READ))
    .map((c) => ({ id: c.id, name: c.name }));
};
