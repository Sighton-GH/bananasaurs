import { beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId, parseSnowflakeId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import { upsertGuild } from './guilds.js';
import { putPendingAction, takePendingAction } from './mod-pending.js';

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
});
