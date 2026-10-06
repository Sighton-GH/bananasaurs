import { beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import { upsertGuild } from './guilds.js';
import { tailAudit } from './effects.js';
import {
  allowRead,
  disallowRead,
  isReadScopeAllowed,
  listReadScope,
  seedReadScopeOnce,
} from './channel-read.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');
const CHANNEL_A = '444444444444444444';
const CHANNEL_B = '444444444444444445';
const CATEGORY = '444444444444444446';

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

describe('read scope', () => {
  it('allowRead is guild-scoped: a row in guild a grants nothing in guild b', () => {
    expect(allowRead(a, { channelId: CHANNEL_A, scopeKind: 'channel', now: 1000 })).toBe(true);
    expect(isReadScopeAllowed(a, CHANNEL_A, 'channel')).toBe(true);
    expect(isReadScopeAllowed(b, CHANNEL_A, 'channel')).toBe(false);
    expect(listReadScope(b)).toEqual([]);
    expect(allowRead(a, { channelId: CHANNEL_A, scopeKind: 'channel', now: 2000 })).toBe(false);
    expect(listReadScope(a)).toEqual([
      { channelId: CHANNEL_A, scopeKind: 'channel', addedAt: 1000 },
    ]);
  });

  it('disallowRead refuses the other kind with wrong-kind and keeps the row', () => {
    allowRead(a, { channelId: CATEGORY, scopeKind: 'category', now: 1000 });
    expect(disallowRead(a, CATEGORY, 'channel')).toBe('wrong-kind');
    expect(isReadScopeAllowed(a, CATEGORY, 'category')).toBe(true);
    expect(disallowRead(a, CATEGORY, 'category')).toBe('removed');
    expect(disallowRead(a, CATEGORY, 'category')).toBe('not-allowed');
    expect(isReadScopeAllowed(a, CATEGORY, 'category')).toBe(false);
  });
});

describe('seedReadScopeOnce', () => {
  const targets = [
    { channelId: CHANNEL_A, scopeKind: 'channel' as const },
    { channelId: CATEGORY, scopeKind: 'category' as const },
  ];

  it('inserts targets once; the second call is already-seeded and inserts nothing', () => {
    expect(seedReadScopeOnce(a, { targets, now: 1000 })).toBe('seeded');
    expect(listReadScope(a)).toHaveLength(2);
    disallowRead(a, CHANNEL_A, 'channel');
    expect(
      seedReadScopeOnce(a, {
        targets: [{ channelId: CHANNEL_B, scopeKind: 'channel' }],
        now: 2000,
      }),
    ).toBe('already-seeded');
    expect(listReadScope(a).map((r) => r.channelId)).toEqual([CATEGORY]);
    // Another guild still seeds.
    expect(seedReadScopeOnce(b, { targets, now: 1000 })).toBe('seeded');
  });

  it('with empty targets returns nothing-to-seed and does NOT claim the marker, so a later call with targets seeds', () => {
    expect(seedReadScopeOnce(a, { targets: [], now: 1000 })).toBe('nothing-to-seed');
    expect(seedReadScopeOnce(a, { targets, now: 2000 })).toBe('seeded');
    expect(listReadScope(a)).toHaveLength(2);
  });

  it('never overwrites an existing row (insert-or-ignore)', () => {
    allowRead(a, { channelId: CHANNEL_A, scopeKind: 'channel', now: 500 });
    expect(seedReadScopeOnce(a, { targets, now: 1000 })).toBe('seeded');
    const row = listReadScope(a).find((r) => r.channelId === CHANNEL_A);
    expect(row?.addedAt).toBe(500);
    expect(listReadScope(a)).toHaveLength(2);
  });

  it('N8: records one system audit row with the target count when it seeds, and none otherwise', () => {
    expect(seedReadScopeOnce(a, { targets, now: 1000 })).toBe('seeded');

    const rows = tailAudit(a, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'system',
      action: 'read_scope.seed',
      subjectType: 'guild',
      subjectId: GUILD_A,
    });
    expect(JSON.parse(rows[0]?.after ?? '{}')).toMatchObject({ targetCount: 2 });

    // Neither a repeat seed nor an empty one writes a further row.
    expect(seedReadScopeOnce(a, { targets, now: 2000 })).toBe('already-seeded');
    expect(seedReadScopeOnce(a, { targets: [], now: 3000 })).toBe('nothing-to-seed');
    expect(tailAudit(a, { limit: 10 })).toHaveLength(1);
    expect(tailAudit(b, { limit: 10 })).toHaveLength(0);
  });
});
