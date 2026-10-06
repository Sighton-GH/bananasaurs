import { ChannelType, Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { buildClientOptions } from '@bananasaurs/discord';
import { resolveChannel, resolveChannelCached } from './resolver.js';

const G = '111111111111111111';
const OTHER = '222222222222222222';

const textShape = (id: string, parentId: string | null): Record<string, unknown> => ({
  id,
  guildId: G,
  type: ChannelType.GuildText,
  parentId,
  parent: null,
  isThread: () => false,
  isTextBased: () => true,
  isDMBased: () => false,
});

describe('resolveChannel', () => {
  it('resolves a cached thread to parent and category and rejects the wrong guild', async () => {
    const client = new Client(buildClientOptions(() => '999999999999999999'));
    const internals = client as unknown as {
      guilds: { _add(v: object): object; cache: Map<string, object> };
      channels: { _add(v: object, guild: object, opts: object): void };
    };
    internals.guilds._add({
      id: G,
      name: 'g',
      owner_id: '9',
      channels: [],
      roles: [],
      members: [],
      emojis: [],
      unavailable: false,
    });
    const guild = internals.guilds.cache.get(G)!;
    internals.channels._add(
      {
        id: '333333333333333333',
        guild_id: G,
        parent_id: '444444444444444444',
        type: ChannelType.GuildText,
        name: 'p',
      },
      guild,
      {},
    );
    internals.channels._add(
      {
        id: '555555555555555555',
        guild_id: G,
        parent_id: '333333333333333333',
        type: ChannelType.PublicThread,
        name: 't',
        owner_id: '9',
        message_count: 0,
        member_count: 1,
        thread_metadata: {
          archived: false,
          auto_archive_duration: 60,
          archive_timestamp: new Date().toISOString(),
          locked: false,
          invitable: true,
        },
      },
      guild,
      {},
    );
    expect(await resolveChannel(client, G, '555555555555555555')).toMatchObject({
      parentChannelId: '333333333333333333',
      categoryId: '444444444444444444',
      isThread: true,
    });
    expect(await resolveChannel(client, OTHER, '555555555555555555')).toBeUndefined();
  });

  it('fetches an uncached thread parent once so a category exclusion is not missed', async () => {
    const THREAD = '777777777777777777';
    const PARENT = '888888888888888888';
    const CATEGORY = '999999999999999999';
    const threadShape: Record<string, unknown> = {
      id: THREAD,
      guildId: G,
      type: ChannelType.PublicThread,
      parentId: PARENT,
      // The sweeper evicted the parent: discord.js leaves `parent` null, so
      // the category cannot be read off the cache.
      parent: null,
      isThread: () => true,
      isTextBased: () => true,
      isDMBased: () => false,
    };
    const parentShape: Record<string, unknown> = {
      id: PARENT,
      guildId: G,
      type: ChannelType.GuildText,
      parentId: CATEGORY,
      parent: null,
      isThread: () => false,
      isTextBased: () => true,
      isDMBased: () => false,
    };
    let fetches = 0;
    const fetchedIds: string[] = [];
    const client = {
      channels: {
        cache: new Map([[THREAD, threadShape]]),
        fetch: async (id: string): Promise<unknown> => {
          fetches += 1;
          fetchedIds.push(id);
          if (id === PARENT) return parentShape;
          throw new Error(`unexpected fetch of ${id}`);
        },
      },
    } as unknown as Client;
    const resolved = await resolveChannel(client, G, THREAD);
    expect(resolved).toMatchObject({
      channelId: THREAD,
      parentChannelId: PARENT,
      categoryId: CATEGORY,
      isThread: true,
    });
    expect(fetches).toBe(1);
    expect(fetchedIds).toEqual([PARENT]);
  });
});

describe('resolveChannelCached', () => {
  const CHANNEL = '666666666666666666';

  const fakeClient = (): Client =>
    ({
      channels: {
        cache: new Map([[CHANNEL, textShape(CHANNEL, null)]]),
        fetch: () => {
          throw new Error('resolveChannelCached must never fetch');
        },
      },
    }) as unknown as Client;

  it('resolves a cached channel with no fetch', () => {
    expect(resolveChannelCached(fakeClient(), G, CHANNEL)).toMatchObject({ channelId: CHANNEL });
  });

  it('answers undefined for an uncached channel without fetching', () => {
    expect(resolveChannelCached(fakeClient(), G, '777777777777777777')).toBeUndefined();
  });

  it('rejects a cached channel from another guild', () => {
    expect(resolveChannelCached(fakeClient(), OTHER, CHANNEL)).toBeUndefined();
  });
});
