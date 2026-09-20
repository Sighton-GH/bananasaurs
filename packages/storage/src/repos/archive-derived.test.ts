import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import { upsertGuild } from './guilds.js';
import {
  countMessages,
  disableCategory,
  disableChannel,
  enableChannel,
  ensureDerivedChannel,
  findChannel,
  findMessage,
  hasCategoryRow,
  isChannelEnabled,
  parentIncludesThreads,
  upsertMessage,
} from './archive.js';

/**
 * ADR 0047 Amendment 2026-09-20: derived `archive_channels` rows.
 *
 * A channel covered only by a category row has no row of its own, and
 * `archive_messages`' composite foreign key to
 * `archive_channels(guild_id, channel_id)` refused the first message written
 * for it (foreign_keys = ON, as `db.ts` sets in production). Every test here
 * runs through `openMigratedTestDatabase` — real migrations, real foreign
 * keys — because a Map-backed fake is exactly what let this through.
 */

const GUILD = parseGuildId('111111111111111111');
const CATEGORY = '555555555555555551';
const CHANNEL = '444444444444444444';
const CHANNEL_TWO = '444444444444444445';
const EXPLICIT = '444444444444444446';
const MEMBER = '555555555555555555';
const MESSAGE_ONE = '666666666666666661';
const MESSAGE_TWO = '666666666666666662';
const MESSAGE_THREE = '666666666666666663';

let t: MigratedTestDatabase;
let scope: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  upsertGuild(scope, { name: 'guild', now: 0 });
  enableChannel(scope, {
    channelId: CATEGORY,
    attachmentPolicy: 'none',
    now: 1000,
    scopeKind: 'category',
  });
});

afterEach(() => {
  t.close();
});

const message = (messageId: string, channelId: string, categoryId?: string) =>
  upsertMessage(scope, {
    messageId,
    channelId,
    authorId: MEMBER,
    content: `content ${messageId}`,
    createdAt: 2000,
    editedAt: undefined,
    attachments: [],
    ...(categoryId === undefined ? {} : { categoryId }),
  });

describe('derived archive_channels rows (ADR 0047 amendment)', () => {
  it('a message for a category-covered channel lands, materialising the derived row in the same write', () => {
    expect(message(MESSAGE_ONE, CHANNEL, CATEGORY)).toBe(true);
    expect(findMessage(scope, MESSAGE_ONE)).toBeDefined();

    const derived = findChannel(scope, CHANNEL);
    expect(derived).toBeDefined();
    expect(derived?.scopeKind).toBe('derived');
    expect(derived?.derivedFrom).toBe(CATEGORY);
  });

  it('a thread message materialises the derived row for its parent channel', () => {
    expect(
      upsertMessage(scope, {
        messageId: MESSAGE_ONE,
        channelId: CHANNEL,
        threadId: '777777777777777777',
        authorId: MEMBER,
        content: 'thread message',
        createdAt: 2000,
        editedAt: undefined,
        attachments: [],
        categoryId: CATEGORY,
      }),
    ).toBe(true);
    expect(findChannel(scope, CHANNEL)?.scopeKind).toBe('derived');
  });

  it('an upsert with no covering row and no category id is a loud refusal, not an FK error', () => {
    expect(() => message(MESSAGE_ONE, EXPLICIT)).toThrowError(/no archive_channels row/);
    expect(findMessage(scope, MESSAGE_ONE)).toBeUndefined();
  });

  it('authorization reads never match a derived row', () => {
    message(MESSAGE_ONE, CHANNEL, CATEGORY);

    expect(isChannelEnabled(scope, CHANNEL)).toBe(false);
    expect(hasCategoryRow(scope, CHANNEL)).toBe(false);
    // No own row means the include-threads default, exactly as before the
    // derived row existed: the category row decides scope, not the derived one.
    expect(parentIncludesThreads(scope, CHANNEL)).toBe(true);

    // And the category row itself answers the other way around.
    expect(hasCategoryRow(scope, CATEGORY)).toBe(true);
    expect(isChannelEnabled(scope, CATEGORY)).toBe(false);
  });

  it('a second message for the same channel reuses the derived row', () => {
    message(MESSAGE_ONE, CHANNEL, CATEGORY);
    expect(message(MESSAGE_TWO, CHANNEL, CATEGORY)).toBe(true);
    expect(countMessages(scope, CHANNEL)).toBe(2);
    expect(findChannel(scope, CHANNEL)?.scopeKind).toBe('derived');
  });

  it('enableChannel upgrades a derived row into an explicit channel row and keeps its messages', () => {
    message(MESSAGE_ONE, CHANNEL, CATEGORY);

    expect(enableChannel(scope, { channelId: CHANNEL, attachmentPolicy: 'none', now: 3000 })).toBe(
      'enabled',
    );
    const row = findChannel(scope, CHANNEL);
    expect(row?.scopeKind).toBe('channel');
    expect(row?.derivedFrom).toBeUndefined();
    expect(isChannelEnabled(scope, CHANNEL)).toBe(true);
    expect(countMessages(scope, CHANNEL)).toBe(1);

    expect(enableChannel(scope, { channelId: CHANNEL, attachmentPolicy: 'none', now: 4000 })).toBe(
      'already-enabled',
    );
  });

  it('ensureDerivedChannel is idempotent and never overwrites an explicit row', () => {
    expect(
      ensureDerivedChannel(scope, {
        channelId: CHANNEL,
        categoryId: CATEGORY,
        attachmentPolicy: 'none',
        now: 1000,
      }),
    ).toBe('created');
    expect(
      ensureDerivedChannel(scope, {
        channelId: CHANNEL,
        categoryId: CATEGORY,
        attachmentPolicy: 'none',
        now: 1000,
      }),
    ).toBe('already-present');

    enableChannel(scope, { channelId: EXPLICIT, attachmentPolicy: 'none', now: 1000 });
    expect(
      ensureDerivedChannel(scope, {
        channelId: EXPLICIT,
        categoryId: CATEGORY,
        attachmentPolicy: 'none',
        now: 1000,
      }),
    ).toBe('already-present');
    expect(findChannel(scope, EXPLICIT)?.scopeKind).toBe('channel');
  });

  it('disableCategory deletes the category row and its derived children, cascading their messages', () => {
    message(MESSAGE_ONE, CHANNEL, CATEGORY);
    message(MESSAGE_TWO, CHANNEL_TWO, CATEGORY);
    enableChannel(scope, { channelId: EXPLICIT, attachmentPolicy: 'none', now: 1000 });
    message(MESSAGE_THREE, EXPLICIT);

    const result = disableCategory(scope, CATEGORY);
    expect(result).toEqual({ outcome: 'disabled', messageCount: 2 });

    expect(hasCategoryRow(scope, CATEGORY)).toBe(false);
    expect(findChannel(scope, CHANNEL)).toBeUndefined();
    expect(findChannel(scope, CHANNEL_TWO)).toBeUndefined();
    expect(countMessages(scope, CHANNEL)).toBe(0);
    expect(countMessages(scope, CHANNEL_TWO)).toBe(0);

    // The explicitly-enabled channel is untouched.
    expect(isChannelEnabled(scope, EXPLICIT)).toBe(true);
    expect(countMessages(scope, EXPLICIT)).toBe(1);

    expect(disableCategory(scope, CATEGORY)).toEqual({ outcome: 'not-enabled' });
  });

  it('disableCategory on a channel row refuses the kind mismatch instead of deleting it', () => {
    enableChannel(scope, { channelId: EXPLICIT, attachmentPolicy: 'none', now: 1000 });
    expect(disableCategory(scope, EXPLICIT)).toEqual({ outcome: 'wrong-kind' });
    expect(isChannelEnabled(scope, EXPLICIT)).toBe(true);
  });

  it('disableChannel refuses category and derived rows rather than silently deleting them', () => {
    message(MESSAGE_ONE, CHANNEL, CATEGORY);

    expect(disableChannel(scope, CATEGORY)).toBe('wrong-kind');
    expect(hasCategoryRow(scope, CATEGORY)).toBe(true);

    expect(disableChannel(scope, CHANNEL)).toBe('wrong-kind');
    expect(findChannel(scope, CHANNEL)?.scopeKind).toBe('derived');
    expect(countMessages(scope, CHANNEL)).toBe(1);

    expect(disableChannel(scope, EXPLICIT)).toBe('not-enabled');
  });

  it('disableChannel still disables an explicitly enabled channel, cascading its messages', () => {
    enableChannel(scope, { channelId: EXPLICIT, attachmentPolicy: 'none', now: 1000 });
    message(MESSAGE_THREE, EXPLICIT);
    expect(disableChannel(scope, EXPLICIT)).toBe('disabled');
    expect(countMessages(scope, EXPLICIT)).toBe(0);
    expect(disableChannel(scope, EXPLICIT)).toBe('not-enabled');
  });

  it('archive_messages.thread_id rejects a non-snowflake (M4)', () => {
    enableChannel(scope, { channelId: EXPLICIT, attachmentPolicy: 'none', now: 1000 });
    expect(() =>
      upsertMessage(scope, {
        messageId: MESSAGE_ONE,
        channelId: EXPLICIT,
        threadId: 'not-a-snowflake',
        authorId: MEMBER,
        content: 'x',
        createdAt: 2000,
        editedAt: undefined,
        attachments: [],
      }),
    ).toThrowError();
  });
});
