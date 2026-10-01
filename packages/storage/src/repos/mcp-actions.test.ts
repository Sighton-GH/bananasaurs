import { beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import { upsertGuild } from './guilds.js';
import {
  claimAction,
  completeAction,
  countActionsSince,
  findAction,
  findActionById,
  listActions,
  markUndone,
  recentSameContent,
} from './mcp-actions.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL_A = '444444444444444444';
const CHANNEL_B = '444444444444444445';
const MESSAGE_ID = '555555555555555555';
const THREAD_ID = '666666666666666666';

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

const claim = (
  scope: GuildScope,
  overrides: {
    actionId?: string;
    idempotencyKey?: string;
    kind?: string;
    capGroup?: 'message' | 'edit' | 'member_role' | 'structure' | 'pin_react';
    argsHash?: string;
    tokenId?: string;
    targetChannelId?: string;
    now?: number;
    dryRun?: boolean;
  } = {},
) =>
  claimAction(scope, {
    actionId: overrides.actionId ?? `act-${overrides.idempotencyKey ?? 'k1'}`,
    idempotencyKey: overrides.idempotencyKey ?? 'k1',
    kind: overrides.kind ?? 'message.send',
    capGroup: overrides.capGroup ?? 'message',
    argsHash: overrides.argsHash ?? 'hash-1',
    tokenId: overrides.tokenId ?? 'tok_1',
    targetChannelId: overrides.targetChannelId ?? CHANNEL_A,
    now: overrides.now ?? 1000,
    dryRun: overrides.dryRun ?? false,
  });

describe('claimAction / findAction / findActionById', () => {
  it('claim twice with one key: the second returns claimed:false and leaves one row', () => {
    expect(claim(a)).toEqual({ claimed: true });
    expect(claim(a, { actionId: 'act-other' })).toEqual({ claimed: false });
    expect(listActions(a, {})).toHaveLength(1);
  });

  it('a dry_run claim stores status dry_run; a normal claim stores claimed', () => {
    claim(a, { idempotencyKey: 'dry', actionId: 'act-dry', dryRun: true });
    claim(a, { idempotencyKey: 'live', actionId: 'act-live' });
    expect(findAction(a, 'dry')?.status).toBe('dry_run');
    expect(findAction(a, 'live')?.status).toBe('claimed');
  });

  it('findAction and findActionById read the row back with every field', () => {
    claim(a);
    expect(findAction(a, 'missing')).toBeUndefined();
    expect(findActionById(a, 'missing')).toBeUndefined();
    expect(findAction(a, 'k1')).toMatchObject({
      actionId: 'act-k1',
      idempotencyKey: 'k1',
      kind: 'message.send',
      capGroup: 'message',
      argsHash: 'hash-1',
      status: 'claimed',
      tokenId: 'tok_1',
      targetChannelId: CHANNEL_A,
      createdAt: 1000,
    });
    expect(findActionById(a, 'act-k1')?.idempotencyKey).toBe('k1');
  });

  it('the same key and the same action id in guild B are separate rows', () => {
    expect(claim(a)).toEqual({ claimed: true });
    expect(claim(b)).toEqual({ claimed: true });
    expect(findAction(a, 'k1')?.tokenId).toBe('tok_1');
    expect(findAction(b, 'k1')?.tokenId).toBe('tok_1');
    expect(findActionById(b, 'act-k1')).toBeDefined();
    expect(listActions(a, {})).toHaveLength(1);
    expect(listActions(b, {})).toHaveLength(1);
  });
});

describe('completeAction', () => {
  it('moves a claimed row to done with the result ids and completion time', () => {
    claim(a);
    completeAction(a, 'act-k1', {
      status: 'done',
      resultMessageId: MESSAGE_ID,
      resultThreadId: THREAD_ID,
      undoJson: '{"op":"unpin"}',
      now: 2000,
    });
    expect(findActionById(a, 'act-k1')).toMatchObject({
      status: 'done',
      resultMessageId: MESSAGE_ID,
      resultThreadId: THREAD_ID,
      undoJson: '{"op":"unpin"}',
      completedAt: 2000,
    });
  });

  it('records a failure without result ids', () => {
    claim(a);
    completeAction(a, 'act-k1', { status: 'failed', now: 2000 });
    expect(findActionById(a, 'act-k1')).toMatchObject({ status: 'failed', completedAt: 2000 });
    expect(findActionById(a, 'act-k1')?.resultMessageId).toBeUndefined();
  });

  it('is guild-scoped: completing in A leaves the same action id claimed in B', () => {
    claim(a);
    claim(b);
    completeAction(a, 'act-k1', { status: 'done', resultMessageId: MESSAGE_ID, now: 2000 });
    expect(findActionById(a, 'act-k1')?.status).toBe('done');
    expect(findActionById(b, 'act-k1')?.status).toBe('claimed');
  });
});

describe('markUndone', () => {
  it('marks once: the second call returns false and keeps the first undoer', () => {
    claim(a);
    completeAction(a, 'act-k1', { status: 'done', resultMessageId: MESSAGE_ID, now: 2000 });
    expect(markUndone(a, 'act-k1', 'act-undo-1')).toBe(true);
    expect(markUndone(a, 'act-k1', 'act-undo-2')).toBe(false);
    expect(findActionById(a, 'act-k1')?.undoneByActionId).toBe('act-undo-1');
  });

  it('returns false for an unknown action id', () => {
    expect(markUndone(a, 'act-nope', 'act-undo-1')).toBe(false);
  });

  it('is guild-scoped: undoing in A does not undo B', () => {
    claim(a);
    claim(b);
    expect(markUndone(a, 'act-k1', 'act-undo-1')).toBe(true);
    expect(markUndone(b, 'act-k1', 'act-undo-1')).toBe(true);
    expect(findActionById(b, 'act-k1')?.undoneByActionId).toBe('act-undo-1');
  });
});

describe('countActionsSince', () => {
  it('counts claimed, done and dry_run; ignores failed; drops old rows', () => {
    claim(a, { idempotencyKey: 'claimed', actionId: 'act-claimed', now: 1000 });
    claim(a, { idempotencyKey: 'done', actionId: 'act-done', now: 1500 });
    completeAction(a, 'act-done', { status: 'done', resultMessageId: MESSAGE_ID, now: 1600 });
    claim(a, { idempotencyKey: 'dry', actionId: 'act-dry', now: 1700, dryRun: true });
    claim(a, { idempotencyKey: 'failed', actionId: 'act-failed', now: 1800 });
    completeAction(a, 'act-failed', { status: 'failed', now: 1900 });
    claim(a, {
      idempotencyKey: 'old',
      actionId: 'act-old',
      capGroup: 'message',
      now: 100,
    });
    // Three in-window non-failed rows (claimed, done, dry_run) count; the failed
    // one excluded — the old row is outside the window.
    expect(countActionsSince(a, 'message', 500)).toBe(3);
    expect(countActionsSince(a, 'message', 1600)).toBe(1);
  });

  it('counts per cap group and per guild', () => {
    claim(a, { idempotencyKey: 'm', actionId: 'act-m', capGroup: 'message' });
    claim(a, { idempotencyKey: 'e', actionId: 'act-e', capGroup: 'edit', kind: 'message.edit' });
    claim(b, { idempotencyKey: 'm', actionId: 'act-m', capGroup: 'message' });
    expect(countActionsSince(a, 'message', 0)).toBe(1);
    expect(countActionsSince(a, 'edit', 0)).toBe(1);
    expect(countActionsSince(a, 'structure', 0)).toBe(0);
    expect(countActionsSince(b, 'message', 0)).toBe(1);
    expect(countActionsSince(b, 'edit', 0)).toBe(0);
  });
});

describe('recentSameContent', () => {
  it('is true for the same hash in the same channel inside the window', () => {
    claim(a, { argsHash: 'dup', targetChannelId: CHANNEL_A, now: 1000 });
    expect(recentSameContent(a, 'dup', CHANNEL_A, 500)).toBe(true);
  });

  it('is false for a different channel, a different hash, or an expired window', () => {
    claim(a, { argsHash: 'dup', targetChannelId: CHANNEL_A, now: 1000 });
    expect(recentSameContent(a, 'dup', CHANNEL_B, 500)).toBe(false);
    expect(recentSameContent(a, 'other', CHANNEL_A, 500)).toBe(false);
    expect(recentSameContent(a, 'dup', CHANNEL_A, 1500)).toBe(false);
  });

  it('does not see the other guild’s rows', () => {
    claim(b, { argsHash: 'dup', targetChannelId: CHANNEL_A, now: 1000 });
    expect(recentSameContent(a, 'dup', CHANNEL_A, 500)).toBe(false);
    expect(recentSameContent(b, 'dup', CHANNEL_A, 500)).toBe(true);
  });
});

describe('listActions', () => {
  it('is newest first and respects limit and beforeCreatedAt', () => {
    claim(a, { idempotencyKey: 'k1', actionId: 'act-1', now: 1000 });
    claim(a, { idempotencyKey: 'k2', actionId: 'act-2', now: 2000 });
    claim(a, { idempotencyKey: 'k3', actionId: 'act-3', now: 3000 });
    expect(listActions(a, {}).map((r) => r.idempotencyKey)).toEqual(['k3', 'k2', 'k1']);
    expect(listActions(a, { limit: 2 }).map((r) => r.idempotencyKey)).toEqual(['k3', 'k2']);
    expect(listActions(a, { beforeCreatedAt: 3000 }).map((r) => r.idempotencyKey)).toEqual([
      'k2',
      'k1',
    ]);
  });

  it('lists only its own guild’s rows', () => {
    claim(a, { idempotencyKey: 'only-a', actionId: 'act-a' });
    claim(b, { idempotencyKey: 'only-b', actionId: 'act-b' });
    expect(listActions(a, {}).map((r) => r.idempotencyKey)).toEqual(['only-a']);
    expect(listActions(b, {}).map((r) => r.idempotencyKey)).toEqual(['only-b']);
  });
});
