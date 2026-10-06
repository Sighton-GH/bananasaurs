import { ChannelType, type Client } from 'discord.js';
import { safeLogFields, type Logger } from '@bananasaurs/core';
import { channelReadRepo, mcpSendRepo, type GuildScope } from '@bananasaurs/storage';

/**
 * The one-time Read + Write seed (channel-permissions Tasks 3 and 14, hard
 * rule 6).
 *
 * Targets are computed once — every `GuildCategory` channel plus every
 * non-thread channel with no `parentId`, read from the live guild cache — and
 * both seeds run from them. Write is the MCP send allowlist, so seeding it
 * also lets the owner's connector post in those places (owner decision
 * 2026-10-03). Each purpose has its own once-only marker, so a guild that
 * seeded Read before Write existed still seeds Write on the next start.
 *
 * An uncached guild has empty targets, which claims no marker — so a later
 * call once the guild is cached still seeds. One info line per seed, through
 * `safeLogFields`: guild, purpose, outcome and target count, never channel
 * contents.
 */

export type ChannelSeedOutcome = 'seeded' | 'already-seeded' | 'nothing-to-seed';

export interface ChannelSeedOutcomes {
  readonly read: ChannelSeedOutcome;
  readonly write: ChannelSeedOutcome;
}

const THREAD_TYPES: ReadonlySet<ChannelType> = new Set([
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

const isThreadChannel = (channel: { readonly type: ChannelType }): boolean => {
  // discord.js channels carry `isThread()`; plain cache-shaped fakes may not,
  // so the type check is the fallback rather than the method. A throwing
  // `isThread()` falls through to the type check too — a thread that cannot
  // answer must not seed as a channel.
  const maybe = channel as { readonly isThread?: unknown };
  if (typeof maybe.isThread === 'function') {
    try {
      return (maybe.isThread as () => boolean)();
    } catch {
      return THREAD_TYPES.has(channel.type);
    }
  }
  return THREAD_TYPES.has(channel.type);
};

export const seedChannelScopes = (
  client: Client,
  scope: GuildScope,
  now: number,
  logger?: Logger,
): ChannelSeedOutcomes => {
  const cached = client.guilds.cache.get(scope.guildId)?.channels.cache;
  const targets: Array<{ channelId: string; scopeKind: 'channel' | 'category' }> = [];
  if (cached !== undefined) {
    for (const channel of cached.values()) {
      if (channel.type === ChannelType.GuildCategory) {
        targets.push({ channelId: channel.id, scopeKind: 'category' });
      } else if (
        !isThreadChannel(channel) &&
        ('parentId' in channel ? (channel.parentId ?? undefined) === undefined : true)
      ) {
        targets.push({ channelId: channel.id, scopeKind: 'channel' });
      }
    }
  }
  const outcomes: ChannelSeedOutcomes = {
    read: channelReadRepo.seedReadScopeOnce(scope, { targets, now }),
    write: mcpSendRepo.seedWriteScopeOnce(scope, { targets, now }),
  };
  if (logger !== undefined) {
    for (const purpose of ['read', 'write'] as const) {
      logger.info(
        safeLogFields({
          component: 'channel-seed',
          guildId: scope.guildId,
          purpose,
          outcome: outcomes[purpose],
          count: targets.length,
        }),
        'channel scope seed complete',
      );
    }
  }
  return outcomes;
};
