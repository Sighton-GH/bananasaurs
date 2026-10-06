import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelType, type Client } from 'discord.js';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import {
  archiveRepo,
  channelReadRepo,
  guildRepo,
  loggingRepo,
  mcpSendRepo,
} from '@bananasaurs/storage';
import { parseGuildId } from '@bananasaurs/core';
import { channelAccessFor, excludedThreadIds, noAccessFromCache } from './access.js';

/**
 * Task 3: `channelAccessFor` over a real migrated database and a fake client
 * carrying plain channel shapes (the resolver's cache read, backed by a Map;
 * `fetch` never resolves).
 */

const GUILD = parseGuildId('111111111111111111');
const CATEGORY = '200000000000000001';
const CHANNEL = '200000000000000002';
const OTHER_CATEGORY = '200000000000000003';
const CHANNEL_UNDER_OTHER = '200000000000000004';
const PRIVATE_THREAD = '200000000000000005';

const textChannel = (id: string, parentId: string | null): Record<string, unknown> => ({
  id,
  guildId: String(GUILD),
  type: ChannelType.GuildText,
  parentId,
  parent: null,
  isThread: () => false,
  isTextBased: () => true,
  isDMBased: () => false,
});

const fakeClient = (): Client =>
  ({
    channels: {
      cache: new Map([
        [CHANNEL, textChannel(CHANNEL, CATEGORY)],
        [CHANNEL_UNDER_OTHER, textChannel(CHANNEL_UNDER_OTHER, OTHER_CATEGORY)],
        [
          PRIVATE_THREAD,
          {
            id: PRIVATE_THREAD,
            guildId: String(GUILD),
            type: ChannelType.PrivateThread,
            parentId: CHANNEL,
            parent: { id: CHANNEL, parentId: CATEGORY },
            isThread: () => true,
            isTextBased: () => true,
            isDMBased: () => false,
          },
        ],
      ]),
      fetch: async () => null,
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

describe('channelAccessFor', () => {
  it('a channel with a Read row and Write off reads allowed and writes not-granted', async () => {
    const scope = t.scopes.forGuild(GUILD);
    channelReadRepo.allowRead(scope, { channelId: CHANNEL, scopeKind: 'channel', now: NOW });
    const access = channelAccessFor(fakeClient(), scope);
    expect(await access.check('read', CHANNEL)).toEqual({ allowed: true, grantedBy: CHANNEL });
    expect(await access.check('write', CHANNEL)).toEqual({
      allowed: false,
      reason: 'not-granted',
    });
  });

  it('an excluded category is no-access for both read and write, with no rows at all', async () => {
    const scope = t.scopes.forGuild(GUILD);
    loggingRepo.excludeChannel(scope, OTHER_CATEGORY);
    const access = channelAccessFor(fakeClient(), scope);
    // No Read or Write row exists: without the exclusion these would be
    // `not-granted`, so `no-access` proves the exclusion vetoes first.
    expect(await access.check('read', CHANNEL_UNDER_OTHER)).toEqual({
      allowed: false,
      reason: 'no-access',
    });
    expect(await access.check('write', CHANNEL_UNDER_OTHER)).toEqual({
      allowed: false,
      reason: 'no-access',
    });
  });

  it('a private thread under a Read+Write parent reads and writes via the parent, but never records', async () => {
    const scope = t.scopes.forGuild(GUILD);
    channelReadRepo.allowRead(scope, { channelId: CHANNEL, scopeKind: 'channel', now: NOW });
    mcpSendRepo.allowChannel(scope, { channelId: CHANNEL, addedByAccountId: 'acct-1', now: NOW });
    const access = channelAccessFor(fakeClient(), scope);
    expect(await access.check('read', PRIVATE_THREAD)).toEqual({
      allowed: true,
      grantedBy: CHANNEL,
    });
    expect(await access.check('write', PRIVATE_THREAD)).toEqual({
      allowed: true,
      grantedBy: CHANNEL,
    });
    // Archive still never inherits for private threads: no own archive row.
    expect(await access.check('record', PRIVATE_THREAD)).toEqual({
      allowed: false,
      reason: 'not-granted',
    });
  });
});

describe('noAccessFromCache', () => {
  it('a cached channel under an excluded category is no-access', () => {
    const scope = t.scopes.forGuild(GUILD);
    loggingRepo.excludeChannel(scope, OTHER_CATEGORY);
    expect(noAccessFromCache(fakeClient(), scope, CHANNEL_UNDER_OTHER)).toBe(true);
  });

  it('a cached channel with no exclusion is not no-access', () => {
    const scope = t.scopes.forGuild(GUILD);
    expect(noAccessFromCache(fakeClient(), scope, CHANNEL)).toBe(false);
  });

  it('an uncached channel answers from its own exclusion only', () => {
    const scope = t.scopes.forGuild(GUILD);
    const UNCACHED = '200000000000000099';
    loggingRepo.excludeChannel(scope, OTHER_CATEGORY);
    // No cached shape, so the category exclusion is invisible: the archived
    // history of a deleted channel stays searchable.
    expect(noAccessFromCache(fakeClient(), scope, UNCACHED)).toBe(false);
    loggingRepo.excludeChannel(scope, UNCACHED);
    expect(noAccessFromCache(fakeClient(), scope, UNCACHED)).toBe(true);
  });
});

describe('excludedThreadIds', () => {
  it('lists only threads excluded on their own, not threads hidden by a parent or category (R2)', () => {
    const scope = t.scopes.forGuild(GUILD);
    const OWN_EXCLUDED_THREAD = '200000000000000098';
    archiveRepo.enableChannel(scope, { channelId: CHANNEL, attachmentPolicy: 'none', now: NOW });
    const seedThreadRow = (messageId: string, threadId: string): void => {
      archiveRepo.upsertMessage(scope, {
        messageId,
        channelId: CHANNEL,
        threadId,
        authorId: '600000000000000001',
        content: 'hello',
        createdAt: NOW,
        editedAt: undefined,
        attachments: [],
      });
    };
    seedThreadRow('700000000000000001', PRIVATE_THREAD);
    seedThreadRow('700000000000000002', OWN_EXCLUDED_THREAD);
    // PRIVATE_THREAD is hidden through its category: the callers' channel
    // filter (its parent, CHANNEL) already drops those rows, so listing it
    // would only grow the SQL parameter list.
    loggingRepo.excludeChannel(scope, CATEGORY);
    loggingRepo.excludeChannel(scope, OWN_EXCLUDED_THREAD);
    expect(excludedThreadIds(scope)).toEqual([OWN_EXCLUDED_THREAD]);
  });
});
