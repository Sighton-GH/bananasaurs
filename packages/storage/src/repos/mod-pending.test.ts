import { beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId, parseSnowflakeId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { upsertGuild } from './guilds.js';
import { peekPendingAction, putPendingAction, takePendingAction } from './mod-pending.js';

const GUILD = parseGuildId('111111111111111111');
const OTHER_GUILD = parseGuildId('333333333333333333');
const MOD = parseSnowflakeId('444444444444444444');
const TARGET = parseSnowflakeId('555555555555555555');

let t: MigratedTestDatabase;

beforeEach(() => {
  t = openMigratedTestDatabase();
  upsertGuild(t.scopes.forGuild(GUILD), { name: 'guild', now: 0 });
  upsertGuild(t.scopes.forGuild(OTHER_GUILD), { name: 'other', now: 0 });
});

describe('mod pending actions repo (ADR 0037 confirmation intents)', () => {
  it('stores and takes an intent once — the second take finds nothing', () => {
    const scope = t.scopes.forGuild(GUILD);
    putPendingAction(scope, {
      intentId: 'i-1',
      payload: JSON.stringify({
        kind: 'ban',
        targetUserId: TARGET,
        reason: 'raiding',
        dedupeKey: 'd-1',
      }),
      createdBy: MOD,
      now: 1000,
      expiresAt: 1000 + 15 * 60_000,
    });

    const taken = takePendingAction(scope, 'i-1', 2000);
    expect(taken).not.toBeUndefined();
    expect(taken?.createdBy).toBe(MOD);
    const parsed = JSON.parse(taken?.payload ?? '{}') as { kind?: string; dedupeKey?: string };
    expect(parsed.kind).toBe('ban');
    expect(parsed.dedupeKey).toBe('d-1');

    // A double-tap on Confirm is a second take: it must find nothing, or
    // duplicate execution would be one replayed dispatch away.
    expect(takePendingAction(scope, 'i-1', 2000)).toBeUndefined();
  });

  it('refuses an expired intent', () => {
    const scope = t.scopes.forGuild(GUILD);
    putPendingAction(scope, {
      intentId: 'i-2',
      payload: JSON.stringify({
        kind: 'purge',
        channelId: TARGET,
        reason: 'spam',
        dedupeKey: 'd-2',
      }),
      createdBy: MOD,
      now: 1000,
      expiresAt: 1000 + 15 * 60_000,
    });
    // The interaction token is dead fifteen minutes from the interaction
    // (ADR 0018); the intent dies with it.
    expect(takePendingAction(scope, 'i-2', 1000 + 15 * 60_000 + 1)).toBeUndefined();
  });

  it('is guild-scoped — another guild cannot see or take the intent', () => {
    const scope = t.scopes.forGuild(GUILD);
    const other = t.scopes.forGuild(OTHER_GUILD);
    putPendingAction(scope, {
      intentId: 'i-3',
      payload: JSON.stringify({ kind: 'ban', targetUserId: TARGET, reason: 'x', dedupeKey: 'd-3' }),
      createdBy: MOD,
      now: 1000,
      expiresAt: 2000,
    });
    expect(takePendingAction(other, 'i-3', 1500)).toBeUndefined();
    expect(takePendingAction(scope, 'i-3', 1500)).not.toBeUndefined();
  });

  describe('peekPendingAction — the expired-vs-already-executed distinction (Task 7)', () => {
    it('finds a fresh row without taking it — a second peek still finds it, and it can still be taken', () => {
      const scope = t.scopes.forGuild(GUILD);
      putPendingAction(scope, {
        intentId: 'i-4',
        payload: JSON.stringify({ kind: 'ban', targetId: TARGET, reason: 'x' }),
        createdBy: MOD,
        now: 1000,
        expiresAt: 1000 + 15 * 60_000,
      });

      const first = peekPendingAction(scope, 'i-4');
      expect(first).not.toBeUndefined();
      expect(first?.createdBy).toBe(MOD);
      expect(first?.expiresAt).toBe(1000 + 15 * 60_000);

      // Peeking twice is idempotent — it never deletes.
      const second = peekPendingAction(scope, 'i-4');
      expect(second).toEqual(first);

      // And the row is still there to be actually taken afterward.
      expect(takePendingAction(scope, 'i-4', 2000)).not.toBeUndefined();
    });

    it('takes no `now` and applies no expiry filter — the row comes back exactly as stored', () => {
      const scope = t.scopes.forGuild(GUILD);
      putPendingAction(scope, {
        intentId: 'i-5',
        payload: JSON.stringify({ kind: 'purge', channelId: TARGET, reason: 'spam' }),
        createdBy: MOD,
        now: 1000,
        expiresAt: 1000 + 15 * 60_000,
      });

      // `takePendingAction` at a `now` past `expiresAt` reports "nothing
      // here" (and deletes the row); `peekPendingAction` has no `now`
      // parameter at all, so a caller must compare `expiresAt` itself to
      // decide "expired" vs. "still good" — that comparison is exactly what
      // lets a confirm handler tell "expired" apart from "already executed".
      const row = peekPendingAction(scope, 'i-5');
      expect(row).not.toBeUndefined();
      expect(row?.expiresAt).toBe(1000 + 15 * 60_000);
      // Far past expiry — still returned, unfiltered.
      expect((row?.expiresAt ?? 0) < 1000 + 20 * 60_000).toBe(true);
    });

    it('finds nothing for an intent that was never put, or already taken', () => {
      const scope = t.scopes.forGuild(GUILD);
      expect(peekPendingAction(scope, 'never-existed')).toBeUndefined();

      putPendingAction(scope, {
        intentId: 'i-6',
        payload: JSON.stringify({ kind: 'ban', targetId: TARGET, reason: 'x' }),
        createdBy: MOD,
        now: 1000,
        expiresAt: 2000,
      });
      takePendingAction(scope, 'i-6', 1500);
      expect(peekPendingAction(scope, 'i-6')).toBeUndefined();
    });

    it('is guild-scoped — another guild cannot peek the intent', () => {
      const scope = t.scopes.forGuild(GUILD);
      const other = t.scopes.forGuild(OTHER_GUILD);
      putPendingAction(scope, {
        intentId: 'i-7',
        payload: JSON.stringify({ kind: 'ban', targetId: TARGET, reason: 'x' }),
        createdBy: MOD,
        now: 1000,
        expiresAt: 2000,
      });
      expect(peekPendingAction(other, 'i-7')).toBeUndefined();
      expect(peekPendingAction(scope, 'i-7')).not.toBeUndefined();
    });
  });
});
