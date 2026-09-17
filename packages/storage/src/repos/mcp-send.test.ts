import { beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import { upsertGuild } from './guilds.js';
import {
  allowChannel,
  claimSend,
  countSendsSince,
  disallowChannel,
  findSend,
  isChannelAllowed,
  listAllowedChannels,
  listSends,
  recordSentMessageId,
} from './mcp-send.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL_A = '444444444444444444';
const CHANNEL_B = '444444444444444445';
const MESSAGE_ID = '555555555555555555';

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

describe('allowlist', () => {
  it('allowChannel then isChannelAllowed is true', () => {
    expect(allowChannel(a, { channelId: CHANNEL_A, addedByAccountId: 'acct-1', now: 1000 })).toBe(
      true,
    );
    expect(isChannelAllowed(a, CHANNEL_A)).toBe(true);
  });

  it('a channel allowed in guild A is not allowed in guild B, and vice versa', () => {
    allowChannel(a, { channelId: CHANNEL_A, addedByAccountId: 'acct-1', now: 1000 });
    expect(isChannelAllowed(a, CHANNEL_A)).toBe(true);
    expect(isChannelAllowed(b, CHANNEL_A)).toBe(false);
    allowChannel(b, { channelId: CHANNEL_B, addedByAccountId: 'acct-2', now: 1000 });
    expect(isChannelAllowed(b, CHANNEL_B)).toBe(true);
    expect(isChannelAllowed(a, CHANNEL_B)).toBe(false);
  });

  it('allowChannel twice returns false the second time and does not duplicate the row', () => {
    expect(allowChannel(a, { channelId: CHANNEL_A, addedByAccountId: 'acct-1', now: 1000 })).toBe(
      true,
    );
    expect(allowChannel(a, { channelId: CHANNEL_A, addedByAccountId: 'acct-1', now: 2000 })).toBe(
      false,
    );
    expect(listAllowedChannels(a)).toHaveLength(1);
  });

  it('disallowChannel removes it; false for a channel that was never allowed', () => {
    expect(disallowChannel(a, CHANNEL_A)).toBe(false);
    allowChannel(a, { channelId: CHANNEL_A, addedByAccountId: 'acct-1', now: 1000 });
    expect(disallowChannel(a, CHANNEL_A)).toBe(true);
    expect(isChannelAllowed(a, CHANNEL_A)).toBe(false);
    expect(disallowChannel(a, CHANNEL_A)).toBe(false);
  });

  it('listAllowedChannels returns the rows', () => {
    allowChannel(a, { channelId: CHANNEL_A, addedByAccountId: 'acct-1', now: 1000 });
    allowChannel(a, { channelId: CHANNEL_B, addedByAccountId: 'acct-2', now: 2000 });
    const rows = listAllowedChannels(a);
    expect(rows.map((r) => r.channelId).sort()).toEqual([CHANNEL_A, CHANNEL_B].sort());
    expect(rows.find((r) => r.channelId === CHANNEL_A)).toMatchObject({
      addedByAccountId: 'acct-1',
      addedAt: 1000,
    });
  });
});

describe('sends', () => {
  it('claimSend returns claimed:true once and claimed:false again, with exactly one row', () => {
    expect(
      claimSend(a, {
        idempotencyKey: 'k1',
        channelId: CHANNEL_A,
        contentHash: 'h1',
        tokenId: 'tok_1',
        now: 1000,
        outcome: 'sent',
      }),
    ).toEqual({ claimed: true });
    expect(
      claimSend(a, {
        idempotencyKey: 'k1',
        channelId: CHANNEL_A,
        contentHash: 'h1',
        tokenId: 'tok_1',
        now: 2000,
        outcome: 'sent',
      }),
    ).toEqual({ claimed: false });
    expect(listSends(a, {})).toHaveLength(1);
  });

  it('the same idempotency key in a different guild is a separate row', () => {
    expect(
      claimSend(a, {
        idempotencyKey: 'shared',
        channelId: CHANNEL_A,
        contentHash: 'h1',
        tokenId: 'tok_1',
        now: 1000,
        outcome: 'sent',
      }),
    ).toEqual({ claimed: true });
    expect(
      claimSend(b, {
        idempotencyKey: 'shared',
        channelId: CHANNEL_A,
        contentHash: 'h1',
        tokenId: 'tok_2',
        now: 1000,
        outcome: 'sent',
      }),
    ).toEqual({ claimed: true });
    expect(listSends(a, {})).toHaveLength(1);
    expect(listSends(b, {})).toHaveLength(1);
  });

  it('findSend returns the row, with messageId undefined before recordSentMessageId', () => {
    expect(findSend(a, 'missing')).toBeUndefined();
    claimSend(a, {
      idempotencyKey: 'k1',
      channelId: CHANNEL_A,
      contentHash: 'h1',
      tokenId: 'tok_1',
      now: 1000,
      outcome: 'sent',
    });
    const found = findSend(a, 'k1');
    expect(found).toBeDefined();
    expect(found?.messageId).toBeUndefined();
    expect(recordSentMessageId(a, { idempotencyKey: 'k1', messageId: MESSAGE_ID })).toBe(true);
    expect(findSend(a, 'k1')?.messageId).toBe(MESSAGE_ID);
    expect(recordSentMessageId(a, { idempotencyKey: 'nope', messageId: MESSAGE_ID })).toBe(false);
  });

  it('countSendsSince counts sent and dry_run, is guild-partitioned, and drops old rows', () => {
    claimSend(a, {
      idempotencyKey: 's1',
      channelId: CHANNEL_A,
      contentHash: 'h1',
      tokenId: 'tok_1',
      now: 1000,
      outcome: 'sent',
    });
    claimSend(a, {
      idempotencyKey: 'd1',
      channelId: CHANNEL_A,
      contentHash: 'h2',
      tokenId: 'tok_1',
      now: 2000,
      outcome: 'dry_run',
    });
    claimSend(a, {
      idempotencyKey: 'old',
      channelId: CHANNEL_A,
      contentHash: 'h3',
      tokenId: 'tok_1',
      now: 100,
      outcome: 'sent',
    });
    claimSend(b, {
      idempotencyKey: 'other-guild',
      channelId: CHANNEL_A,
      contentHash: 'h4',
      tokenId: 'tok_2',
      now: 1500,
      outcome: 'sent',
    });
    expect(countSendsSince(a, 500)).toBe(2);
    expect(countSendsSince(b, 500)).toBe(1);
    expect(countSendsSince(a, 1500)).toBe(1);
  });

  it('listSends is newest first and respects sinceMs and limit', () => {
    claimSend(a, {
      idempotencyKey: 'k1',
      channelId: CHANNEL_A,
      contentHash: 'h1',
      tokenId: 'tok_1',
      now: 1000,
      outcome: 'sent',
    });
    claimSend(a, {
      idempotencyKey: 'k2',
      channelId: CHANNEL_A,
      contentHash: 'h2',
      tokenId: 'tok_1',
      now: 2000,
      outcome: 'dry_run',
    });
    claimSend(a, {
      idempotencyKey: 'k3',
      channelId: CHANNEL_A,
      contentHash: 'h3',
      tokenId: 'tok_1',
      now: 3000,
      outcome: 'sent',
    });
    expect(listSends(a, {}).map((r) => r.idempotencyKey)).toEqual(['k3', 'k2', 'k1']);
    expect(listSends(a, { sinceMs: 2500 }).map((r) => r.idempotencyKey)).toEqual(['k3']);
    expect(listSends(a, { limit: 2 }).map((r) => r.idempotencyKey)).toEqual(['k3', 'k2']);
  });
});
