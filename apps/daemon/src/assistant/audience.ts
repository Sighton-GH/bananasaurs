import { ChannelType, OverwriteType, PermissionsBitField } from 'discord.js';

/**
 * What "can read" means here: View Channel and Read Message History
 * together (ADR 0090). The same two bits `member-channels.ts` checks.
 */
const READ = PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.ReadMessageHistory;

export interface AudienceChannel {
  readonly id: string;
  readonly isThread: boolean;
  readonly isPrivateThread: boolean;
  readonly parentId?: string | undefined;
  /** @everyone's effective ViewChannel AND ReadMessageHistory in this channel. */
  readonly everyoneCanRead: boolean;
  /** Only overwrites whose allow or deny touches ViewChannel or ReadMessageHistory, masked to those two bits. */
  readonly overwrites: readonly {
    id: string;
    type: 'role' | 'member';
    allow: bigint;
    deny: bigint;
  }[];
}

/** One permission overwrite as discord.js carries it. */
export interface AudienceGuildOverwrite {
  readonly id: string;
  readonly type: unknown;
  readonly allow: { readonly bitfield: bigint };
  readonly deny: { readonly bitfield: bigint };
}

/** The slice of a discord.js channel `buildAudienceMap` needs, so it can be tested without one. */
export interface AudienceGuildChannel {
  readonly id: string;
  isThread(): boolean;
  readonly type?: unknown;
  readonly parentId?: string | null | undefined;
  permissionsFor?(role: unknown): { has(permission: bigint): boolean } | null | undefined;
  readonly permissionOverwrites?:
    { readonly cache: ReadonlyMap<string, AudienceGuildOverwrite> } | undefined;
}

/** The slice of a discord.js `Guild` this needs, so it can be tested without one. */
export interface AudienceGuild {
  readonly channels: {
    readonly cache: ReadonlyMap<string, AudienceGuildChannel>;
  };
  readonly roles: {
    readonly everyone: unknown;
  };
}

/**
 * The discord.js mapping: one `AudienceChannel` per cached channel.
 * `everyoneCanRead` comes from `channel.permissionsFor(guild.roles.everyone)`;
 * overwrites come from `channel.permissionOverwrites.cache`, masked to the
 * read bits with unrelated entries dropped. Threads carry no overwrites —
 * only their type and parent. An uncached guild maps to nothing.
 */
export const buildAudienceMap = (
  guild: AudienceGuild | undefined,
): ReadonlyMap<string, AudienceChannel> => {
  const map = new Map<string, AudienceChannel>();
  if (guild === undefined) return map;
  for (const channel of guild.channels.cache.values()) {
    if (channel.isThread()) {
      map.set(channel.id, {
        id: channel.id,
        isThread: true,
        isPrivateThread: channel.type === ChannelType.PrivateThread,
        parentId: channel.parentId ?? undefined,
        everyoneCanRead: false,
        overwrites: [],
      });
      continue;
    }
    const overwrites = [...(channel.permissionOverwrites?.cache.values() ?? [])].flatMap(
      (overwrite) => {
        const allow = overwrite.allow.bitfield & READ;
        const deny = overwrite.deny.bitfield & READ;
        if (allow === 0n && deny === 0n) return [];
        return [
          {
            id: overwrite.id,
            type: overwrite.type === OverwriteType.Role ? ('role' as const) : ('member' as const),
            allow,
            deny,
          },
        ];
      },
    );
    map.set(channel.id, {
      id: channel.id,
      isThread: false,
      isPrivateThread: false,
      parentId: channel.parentId ?? undefined,
      everyoneCanRead: channel.permissionsFor?.(guild.roles.everyone)?.has(READ) === true,
      overwrites,
    });
  }
  return map;
};

/** Canonical form of the read-relevant overwrites, for same-audience comparison. */
const canonicalOverwrites = (
  overwrites: readonly {
    readonly id: string;
    readonly type: 'role' | 'member';
    readonly allow: bigint;
    readonly deny: bigint;
  }[],
): string =>
  overwrites
    .map((overwrite) => ({
      type: overwrite.type,
      id: overwrite.id,
      allow: overwrite.allow & READ,
      deny: overwrite.deny & READ,
    }))
    .filter((overwrite) => overwrite.allow !== 0n || overwrite.deny !== 0n)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type < b.type ? -1 : 1;
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      return 0;
    })
    .map(
      (overwrite) =>
        `${overwrite.type}:${overwrite.id}:${overwrite.allow.toString(16)}:${overwrite.deny.toString(16)}`,
    )
    .join('|');

/**
 * The channels an answer posted in `answerChannelId` may draw on (ADR 0090):
 * every viewer of the answer channel can read each of them. A candidate text
 * channel X (never a thread) is in the set when X is the answer channel,
 * when X is open (@everyone can read and nothing denies it), or when X has
 * the same audience (same @everyone base, identical read overwrites).
 *
 * A private thread as C yields only itself; a public thread answers with its
 * parent's audience and includes itself. Anything unknown — an uncached
 * channel, a thread with an unknown parent — fails closed.
 */
export const audienceChannels = (
  answerChannelId: string,
  channels: ReadonlyMap<string, AudienceChannel>,
): ReadonlySet<string> => {
  const answer = channels.get(answerChannelId);
  if (answer === undefined) return new Set<string>();
  let effective = answer;
  let threadSelf: string | undefined;
  if (answer.isThread) {
    if (answer.isPrivateThread) return new Set<string>([answer.id]);
    const parent = answer.parentId === undefined ? undefined : channels.get(answer.parentId);
    if (parent === undefined || parent.isThread) return new Set<string>([answer.id]);
    effective = parent;
    threadSelf = answer.id;
  }
  const audience = new Set<string>();
  if (threadSelf !== undefined) audience.add(threadSelf);
  const effectiveKey = canonicalOverwrites(effective.overwrites);
  for (const candidate of channels.values()) {
    // Threads are never candidates (ADR 0067).
    if (candidate.isThread) continue;
    if (candidate.id === effective.id) {
      audience.add(candidate.id);
      continue;
    }
    if (
      candidate.everyoneCanRead &&
      candidate.overwrites.every((overwrite) => (overwrite.deny & READ) === 0n)
    ) {
      audience.add(candidate.id);
      continue;
    }
    if (
      candidate.everyoneCanRead === effective.everyoneCanRead &&
      canonicalOverwrites(candidate.overwrites) === effectiveKey
    )
      audience.add(candidate.id);
  }
  return audience;
};

/** `audienceChannels` straight from a live guild; an uncached guild answers nothing. */
export const guildAudienceChannels = (
  guild: AudienceGuild | undefined,
  answerChannelId: string,
): ReadonlySet<string> => audienceChannels(answerChannelId, buildAudienceMap(guild));
