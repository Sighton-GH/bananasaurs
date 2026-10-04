import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelType, type Client } from 'discord.js';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { channelReadRepo, guildRepo, mcpSendRepo } from '@bananasaurs/storage';
import { parseGuildId } from '@bananasaurs/core';
import { seedChannelScopes } from './read-seed.js';

/**
 * Task 14: the one-time Read + Write seed over the live guild cache. The fake
 * client carries plain Maps, not discord.js structures — the seed may only
 * touch `guilds.cache.get(guildId)?.channels.cache`, `id`, `type` and
 * `parentId` (plus `isThread()` when the object has one).
 */

const GUILD = parseGuildId('111111111111111111');
const CATEGORY = '200000000000000001';
const TOP_CHANNEL = '200000000000000002';
const NESTED_CHANNEL = '200000000000000003';
const THREAD = '200000000000000004';
const TOP_THREAD = '200000000000000005';

type FakeChannel = {
  readonly id: string;
  readonly type: ChannelType;
  readonly parentId: string | null;
  readonly isThread?: () => boolean;
};

const fakeChannel = (
  id: string,
  type: ChannelType,
  parentId: string | null,
  isThread?: () => boolean,
): FakeChannel => ({ id, type, parentId, ...(isThread === undefined ? {} : { isThread }) });

const fullCache = (): readonly FakeChannel[] => [
  fakeChannel(CATEGORY, ChannelType.GuildCategory, null),
  fakeChannel(TOP_CHANNEL, ChannelType.GuildText, null),
  fakeChannel(NESTED_CHANNEL, ChannelType.GuildText, CATEGORY),
  fakeChannel(THREAD, ChannelType.PublicThread, TOP_CHANNEL, () => true),
  // No parent, but still a thread: the thread check must exclude it, not the parent check.
  fakeChannel(TOP_THREAD, ChannelType.PublicThread, null, () => true),
];

const clientWith = (channels: readonly FakeChannel[] | undefined): Client =>
  ({
    guilds: {
      cache: new Map(
        channels === undefined
          ? []
          : [[GUILD, { channels: { cache: new Map(channels.map((c) => [c.id, c])) } }]],
      ),
    },
  }) as unknown as Client;

let t: MigratedTestDatabase;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  t = openMigratedTestDatabase();
  guildRepo.upsertGuild(t.scopes.forGuild(GUILD), { name: 'guild', now: NOW });
});

afterEach(() => {
  t.close();
});

describe('seedChannelScopes', () => {
  it('seeds Read and Write once from one target computation', () => {
    const outcome = seedChannelScopes(clientWith(fullCache()), t.scopes.forGuild(GUILD), NOW);
    expect(outcome).toEqual({ read: 'seeded', write: 'seeded' });
    expect(channelReadRepo.listReadScope(t.scopes.forGuild(GUILD))).toEqual([
      { channelId: CATEGORY, scopeKind: 'category', addedAt: NOW },
      { channelId: TOP_CHANNEL, scopeKind: 'channel', addedAt: NOW },
    ]);
    // Write is the MCP send allowlist: the same targets, authored by the seed.
    expect(mcpSendRepo.listAllowedChannels(t.scopes.forGuild(GUILD))).toEqual([
      {
        channelId: CATEGORY,
        scopeKind: 'category',
        addedByAccountId: mcpSendRepo.WRITE_SEED_ACCOUNT_ID,
        addedAt: NOW,
      },
      {
        channelId: TOP_CHANNEL,
        scopeKind: 'channel',
        addedByAccountId: mcpSendRepo.WRITE_SEED_ACCOUNT_ID,
        addedAt: NOW,
      },
    ]);
  });

  it('a second call is already-seeded for both and leaves the rows alone', () => {
    const scope = t.scopes.forGuild(GUILD);
    expect(seedChannelScopes(clientWith(fullCache()), scope, NOW)).toEqual({
      read: 'seeded',
      write: 'seeded',
    });
    expect(seedChannelScopes(clientWith(fullCache()), scope, NOW + 1)).toEqual({
      read: 'already-seeded',
      write: 'already-seeded',
    });
    expect(channelReadRepo.listReadScope(scope)).toEqual([
      { channelId: CATEGORY, scopeKind: 'category', addedAt: NOW },
      { channelId: TOP_CHANNEL, scopeKind: 'channel', addedAt: NOW },
    ]);
    expect(mcpSendRepo.listAllowedChannels(scope).map((r) => r.channelId)).toEqual([
      CATEGORY,
      TOP_CHANNEL,
    ]);
  });

  it('an uncached guild gives nothing-to-seed for both, and a later call with channels seeds them', () => {
    const scope = t.scopes.forGuild(GUILD);
    expect(seedChannelScopes(clientWith(undefined), scope, NOW)).toEqual({
      read: 'nothing-to-seed',
      write: 'nothing-to-seed',
    });
    expect(channelReadRepo.listReadScope(scope)).toEqual([]);
    expect(mcpSendRepo.listAllowedChannels(scope)).toEqual([]);
    // The empty call claimed no marker, so the later call still seeds.
    expect(seedChannelScopes(clientWith(fullCache()), scope, NOW + 1)).toEqual({
      read: 'seeded',
      write: 'seeded',
    });
    expect(channelReadRepo.listReadScope(scope)).toEqual([
      { channelId: CATEGORY, scopeKind: 'category', addedAt: NOW + 1 },
      { channelId: TOP_CHANNEL, scopeKind: 'channel', addedAt: NOW + 1 },
    ]);
    expect(mcpSendRepo.listAllowedChannels(scope)).toHaveLength(2);
  });

  it('logs one line per seed with the purpose, outcome and target count', () => {
    const seen: unknown[][] = [];
    const logger = { info: (...args: unknown[]): void => void seen.push(args) } as never;
    const outcome = seedChannelScopes(
      clientWith(fullCache()),
      t.scopes.forGuild(GUILD),
      NOW,
      logger,
    );
    expect(outcome).toEqual({ read: 'seeded', write: 'seeded' });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.[0]).toMatchObject({
      guildId: GUILD,
      purpose: 'read',
      outcome: 'seeded',
      count: 2,
    });
    expect(seen[1]?.[0]).toMatchObject({
      guildId: GUILD,
      purpose: 'write',
      outcome: 'seeded',
      count: 2,
    });
  });

  it('a throwing isThread() falls through to the channel type, not to "not a thread"', () => {
    const throwing = (): boolean => {
      throw new Error('boom');
    };
    const channels: readonly FakeChannel[] = [
      // A thread whose isThread() throws is still a thread: never a target.
      fakeChannel(TOP_THREAD, ChannelType.PublicThread, null, throwing),
      // A plain channel whose isThread() throws is still seedable.
      fakeChannel(TOP_CHANNEL, ChannelType.GuildText, null, throwing),
    ];
    const outcome = seedChannelScopes(clientWith(channels), t.scopes.forGuild(GUILD), NOW);
    expect(outcome).toEqual({ read: 'seeded', write: 'seeded' });
    expect(channelReadRepo.listReadScope(t.scopes.forGuild(GUILD)).map((r) => r.channelId)).toEqual(
      [TOP_CHANNEL],
    );
    expect(
      mcpSendRepo.listAllowedChannels(t.scopes.forGuild(GUILD)).map((r) => r.channelId),
    ).toEqual([TOP_CHANNEL]);
  });
});
