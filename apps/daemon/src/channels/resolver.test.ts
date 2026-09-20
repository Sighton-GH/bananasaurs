import { ChannelType, Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { buildClientOptions } from '@bananasaurs/discord';
import { resolveChannel } from './resolver.js';

const G = '111111111111111111';
const OTHER = '222222222222222222';

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
});
