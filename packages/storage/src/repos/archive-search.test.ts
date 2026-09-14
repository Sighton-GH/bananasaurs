import { beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import { upsertGuild } from './guilds.js';
import { enableChannel, upsertMessage } from './archive.js';
import { searchMessages } from './archive-search.js';

const GUILD_A = parseGuildId('111111111111111111');
const CHANNEL_A = '444444444444444444';
const CHANNEL_B = '444444444444444445';
const MEMBER = '555555555555555555';

let t: MigratedTestDatabase;
let a: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  upsertGuild(a, { name: 'guild-a', now: 0 });
});

const enable = (scope: GuildScope, channelId: string) =>
  enableChannel(scope, { channelId, attachmentPolicy: 'none', now: 1000 });

describe('visibility filtering', () => {
  it('a citation never names a channel outside the visibility set', () => {
    enable(a, CHANNEL_A);
    enable(a, CHANNEL_B);
    upsertMessage(a, {
      messageId: '666666666666666666',
      channelId: CHANNEL_A,
      authorId: MEMBER,
      content: 'pineapple in the visible channel',
      createdAt: 2000,
      editedAt: undefined,
      attachments: [],
    });
    upsertMessage(a, {
      messageId: '777777777777777777',
      channelId: CHANNEL_B,
      authorId: MEMBER,
      content: 'pineapple in the hidden channel',
      createdAt: 2000,
      editedAt: undefined,
      attachments: [],
    });

    const result = searchMessages(a, {
      query: 'pineapple',
      visibility: { channelIds: [CHANNEL_A] },
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.channelId).toBe(CHANNEL_A);
    expect(result.total).toBe(1);
  });
});
