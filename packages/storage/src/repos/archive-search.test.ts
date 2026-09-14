import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import { upsertGuild } from './guilds.js';
import {
  ARCHIVE_DEFAULT_RETENTION_MS,
  enableChannel,
  expireContent,
  recordDelete,
  upsertMessage,
} from './archive.js';
import {
  findMessage,
  rebuildSearchIndex,
  SEARCH_LIMIT_MAX,
  searchMessages,
} from './archive-search.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL_A = '444444444444444444';
const CHANNEL_B = '444444444444444445';
const MEMBER = '555555555555555555';
const OTHER_MEMBER = '555555555555555556';

const DAY_MS = 24 * 60 * 60 * 1000;

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  upsertGuild(a, { name: 'guild-a', now: 0 });
  upsertGuild(b, { name: 'guild-b', now: 0 });
});

const enable = (scope: GuildScope, channelId: string) =>
  enableChannel(scope, { channelId, attachmentPolicy: 'none', now: 1000 });

const seedMessage = (
  scope: GuildScope,
  over: {
    messageId?: string;
    channelId?: string;
    authorId?: string;
    content?: string;
    createdAt?: number;
  } = {},
) => {
  const messageId = over.messageId ?? '666666666666666666';
  const channelId = over.channelId ?? CHANNEL_A;
  enable(scope, channelId);
  upsertMessage(scope, {
    messageId,
    channelId,
    authorId: over.authorId ?? MEMBER,
    content: over.content ?? 'hello',
    createdAt: over.createdAt ?? 2000,
    editedAt: undefined,
    attachments: [],
  });
  return messageId;
};

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

  it('two-channel and five-channel visibility sets both build a working IN list', () => {
    const channels = [
      '444444444444444444',
      '444444444444444445',
      '444444444444444446',
      '444444444444444447',
      '444444444444444448',
    ];
    channels.forEach((channelId, i) => {
      seedMessage(a, {
        messageId: `66666666666666666${i}`,
        channelId,
        content: 'kiwi harvest report',
      });
    });

    const two = searchMessages(a, {
      query: 'kiwi',
      visibility: { channelIds: channels.slice(0, 2) },
    });
    expect(two.hits).toHaveLength(2);
    expect(two.total).toBe(2);

    const five = searchMessages(a, {
      query: 'kiwi',
      visibility: { channelIds: channels },
    });
    expect(five.hits).toHaveLength(5);
    expect(five.total).toBe(5);
  });

  it('an empty visibility set returns empty without running a query', () => {
    seedMessage(a, { content: 'mango overview' });
    const prepare = vi.spyOn(t.raw, 'prepare');
    const result = searchMessages(a, { query: 'mango', visibility: { channelIds: [] } });
    expect(result).toEqual({ hits: [], total: 0 });
    // Chosen over the dropped-table variant: the implementation must not reach
    // the database at all, so spying proves the absence rather than merely
    // surviving it.
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
  });

  it('a malformed query returns empty rather than throwing', () => {
    seedMessage(a, { content: 'ordinary content' });
    const result = searchMessages(a, {
      query: '"unbalanced',
      visibility: { channelIds: [CHANNEL_A] },
    });
    expect(result).toEqual({ hits: [], total: 0 });
  });
});

describe('guild scope', () => {
  it('two guilds with colliding message ids share neither hits nor counts', () => {
    const messageId = '666666666666666666';
    enable(a, CHANNEL_A);
    enable(b, CHANNEL_A);
    upsertMessage(a, {
      messageId,
      channelId: CHANNEL_A,
      authorId: MEMBER,
      content: 'quince tart recipe',
      createdAt: 2000,
      editedAt: undefined,
      attachments: [],
    });
    upsertMessage(b, {
      messageId,
      channelId: CHANNEL_A,
      authorId: MEMBER,
      content: 'quince pie recipe',
      createdAt: 2000,
      editedAt: undefined,
      attachments: [],
    });

    const underA = searchMessages(a, {
      query: 'quince',
      visibility: { channelIds: [CHANNEL_A] },
    });
    expect(underA.hits).toHaveLength(1);
    expect(underA.total).toBe(1);
    expect(underA.hits[0]?.excerpt).toContain('tart');

    const underB = searchMessages(b, {
      query: 'quince',
      visibility: { channelIds: [CHANNEL_A] },
    });
    expect(underB.hits).toHaveLength(1);
    expect(underB.total).toBe(1);
    expect(underB.hits[0]?.excerpt).toContain('pie');

    // Each guild's own term is invisible from the other side.
    expect(
      searchMessages(a, { query: 'pie', visibility: { channelIds: [CHANNEL_A] } }).total,
    ).toBe(0);
    expect(
      searchMessages(b, { query: 'tart', visibility: { channelIds: [CHANNEL_A] } }).total,
    ).toBe(0);
  });
});

describe('narrowing, filters and limits', () => {
  it('channelIds narrows within the visibility set and never widens it', () => {
    seedMessage(a, { messageId: '666666666666666666', channelId: CHANNEL_A, content: 'plum notes' });
    seedMessage(a, { messageId: '777777777777777777', channelId: CHANNEL_B, content: 'plum notes' });

    const narrowed = searchMessages(a, {
      query: 'plum',
      visibility: { channelIds: [CHANNEL_A, CHANNEL_B] },
      channelIds: [CHANNEL_B],
    });
    expect(narrowed.hits).toHaveLength(1);
    expect(narrowed.hits[0]?.channelId).toBe(CHANNEL_B);
    expect(narrowed.total).toBe(1);

    // Asking for a channel outside the visibility set yields nothing.
    const widened = searchMessages(a, {
      query: 'plum',
      visibility: { channelIds: [CHANNEL_A] },
      channelIds: [CHANNEL_B],
    });
    expect(widened.hits).toHaveLength(0);
    expect(widened.total).toBe(0);
  });

  it('authorId, before and after bound the rows', () => {
    seedMessage(a, {
      messageId: '666666666666666666',
      authorId: MEMBER,
      content: 'fig jam plan',
      createdAt: 1000,
    });
    seedMessage(a, {
      messageId: '777777777777777777',
      authorId: OTHER_MEMBER,
      content: 'fig jam plan',
      createdAt: 2000,
    });
    seedMessage(a, {
      messageId: '888888888888888888',
      authorId: MEMBER,
      content: 'fig jam plan',
      createdAt: 3000,
    });
    const visibility = { channelIds: [CHANNEL_A] };

    const byAuthor = searchMessages(a, { query: 'fig', visibility, authorId: OTHER_MEMBER });
    expect(byAuthor.hits.map((h) => h.messageId)).toEqual(['777777777777777777']);
    expect(byAuthor.total).toBe(1);
    expect(byAuthor.hits[0]?.authorId).toBe(OTHER_MEMBER);

    const before = searchMessages(a, { query: 'fig', visibility, before: 2500 });
    expect(before.hits.map((h) => h.messageId).sort()).toEqual([
      '666666666666666666',
      '777777777777777777',
    ]);
    expect(before.total).toBe(2);

    const after = searchMessages(a, { query: 'fig', visibility, after: 1500 });
    expect(after.hits.map((h) => h.messageId).sort()).toEqual([
      '777777777777777777',
      '888888888888888888',
    ]);
    expect(after.total).toBe(2);
  });

  it('limit clamps at SEARCH_LIMIT_MAX and defaults to a page', () => {
    expect(SEARCH_LIMIT_MAX).toBe(100);
    const total = SEARCH_LIMIT_MAX + 5;
    for (let i = 0; i < total; i += 1) {
      // String-built ids: a numeric base this large would exceed
      // `Number.MAX_SAFE_INTEGER` and collapse into duplicates.
      seedMessage(a, {
        messageId: `66${String(i).padStart(16, '0')}`,
        content: 'berry inventory line',
      });
    }
    const visibility = { channelIds: [CHANNEL_A] };

    const clamped = searchMessages(a, { query: 'berry', visibility, limit: 500 });
    expect(clamped.hits).toHaveLength(SEARCH_LIMIT_MAX);
    expect(clamped.total).toBe(total);

    const def = searchMessages(a, { query: 'berry', visibility });
    expect(def.hits.length).toBeLessThanOrEqual(20);
    expect(def.hits.length).toBeGreaterThan(0);
    expect(def.total).toBe(total);
  });
});

describe('ranking and excerpts', () => {
  it('the message repeating the term ranks first', () => {
    seedMessage(a, {
      messageId: '666666666666666666',
      content: 'apricot trifle',
    });
    seedMessage(a, {
      messageId: '777777777777777777',
      content: 'apricot apricot apricot feast',
    });

    const result = searchMessages(a, {
      query: 'apricot',
      visibility: { channelIds: [CHANNEL_A] },
    });
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]?.messageId).toBe('777777777777777777');
    expect(result.hits[1]?.messageId).toBe('666666666666666666');
    expect(result.hits[0]?.rank).toBeLessThanOrEqual(result.hits[1]?.rank ?? 0);
  });

  it('the excerpt wraps the matched term in the snippet delimiters', () => {
    seedMessage(a, { content: 'fresh guava salad today' });
    const result = searchMessages(a, {
      query: 'guava',
      visibility: { channelIds: [CHANNEL_A] },
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.excerpt).toContain('[guava]');
  });
});

describe('purge leaves the index while the tombstone stays', () => {
  it('expireContent removes the words from search but not the row from findMessage', () => {
    expect(ARCHIVE_DEFAULT_RETENTION_MS).toBe(30 * DAY_MS);
    const now = 50 * DAY_MS;
    const messageId = seedMessage(a, { content: 'papaya secret plan' });
    expect(recordDelete(a, { messageId, deletedAt: now - 31 * DAY_MS })).toBe('recorded');

    const before = searchMessages(a, {
      query: 'papaya',
      visibility: { channelIds: [CHANNEL_A] },
    });
    expect(before.hits).toHaveLength(1);
    expect(before.total).toBe(1);

    // The purge must do work: a test that purges nothing passes vacuously.
    expect(expireContent(a, now)).toBe(1);

    const after = searchMessages(a, {
      query: 'papaya',
      visibility: { channelIds: [CHANNEL_A] },
    });
    expect(after.hits).toHaveLength(0);
    expect(after.total).toBe(0);

    const tombstone = findMessage(a, messageId);
    expect(tombstone).toBeDefined();
    expect(tombstone?.content).toBeNull();
    expect(tombstone?.contentPurgedAt).toBe(now);
    expect(tombstone?.messageId).toBe(messageId);
  });
});

describe('rebuildSearchIndex', () => {
  it('restores every row after the index is wiped, and reports this guild count', () => {
    seedMessage(a, { messageId: '666666666666666666', content: 'durian log one' });
    seedMessage(a, { messageId: '777777777777777777', content: 'durian log two' });
    seedMessage(b, {
      messageId: '888888888888888888',
      channelId: CHANNEL_A,
      content: 'durian log three',
    });

    t.raw.exec('DELETE FROM archive_messages_fts');
    expect(
      searchMessages(a, { query: 'durian', visibility: { channelIds: [CHANNEL_A] } }).total,
    ).toBe(0);

    // The rebuild is table-global while the count returned is this guild's.
    expect(rebuildSearchIndex(a)).toBe(2);

    const restored = searchMessages(a, {
      query: 'durian',
      visibility: { channelIds: [CHANNEL_A] },
    });
    expect(restored.hits).toHaveLength(2);
    expect(restored.total).toBe(2);
    expect(
      searchMessages(b, { query: 'durian', visibility: { channelIds: [CHANNEL_A] } }).total,
    ).toBe(1);
  });
});
