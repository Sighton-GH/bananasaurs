import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { GuildScope } from '../scope.js';
import {
  findGuild,
  readSafetyState,
  resetBreaker,
  setAutomodState,
  setLimits,
  tripBreaker,
  upsertGuild,
} from './guilds.js';

/**
 * The `guilds` row, as the operator surface writes it.
 *
 * `setLimits` and the breaker reset are what `bananasaurs config set` reaches
 * (ADR 0025). The breaker half is the reason this file exists at all:
 * `resetBreaker` has been in the tree since WP2 with no caller outside
 * `write.test.ts`, so a tripped breaker could not be cleared by anything the
 * product shipped.
 */

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  upsertGuild(a, { name: 'guild a', now: 0 });
  upsertGuild(b, { name: 'guild b', now: 0 });
});
afterEach(() => {
  t.close();
});

describe('setLimits', () => {
  it('changes one limit and leaves the others alone', () => {
    setLimits(a, { roleRatePerMin: 60 }, 100);
    expect(readSafetyState(a)).toMatchObject({
      roleRatePerMin: 60,
      reconcileBudget: 25,
      breakerThreshold: 5,
    });
  });

  it('changes several at once', () => {
    setLimits(a, { roleRatePerMin: 60, reconcileBudget: 100, breakerThreshold: 9 }, 100);
    expect(readSafetyState(a)).toMatchObject({
      roleRatePerMin: 60,
      reconcileBudget: 100,
      breakerThreshold: 9,
    });
  });

  it('does not touch `updated_at` for an empty patch', () => {
    // The load-bearing assertion, and the one `not.toThrow()` was not: the
    // statement is never empty (`updatedAt` is always in the `set`), so the
    // guard's only observable effect is that a call which changed nothing does
    // not claim the configuration changed. Mutation 174 survived until this
    // asserted the timestamp instead of the absence of an exception.
    setLimits(a, { roleRatePerMin: 60 }, 100);
    const before = findGuild(a)?.updatedAt;
    expect(before).toBe(100);

    setLimits(a, {}, 999);
    expect(findGuild(a)?.updatedAt).toBe(before);
    expect(readSafetyState(a)?.roleRatePerMin).toBe(60);
  });

  it('refuses a non-positive limit at the database, not only in Zod', () => {
    // `guilds_positive_limits`. The CHECK is what makes "a rate cap of zero
    // silently stops every role change" impossible even from a path that
    // forgot to validate.
    expect(() => setLimits(a, { roleRatePerMin: 0 }, 100)).toThrow();
    expect(readSafetyState(a)?.roleRatePerMin).toBe(20);
  });

  it("does not change another guild's limits", () => {
    setLimits(a, { roleRatePerMin: 60 }, 100);
    expect(readSafetyState(b)?.roleRatePerMin).toBe(20);
  });
});

describe('the breaker, opened and closed', () => {
  it('closes an open breaker and forgets why it opened', () => {
    tripBreaker(a, 'too many failures', 100);
    expect(readSafetyState(a)).toMatchObject({
      breakerOpen: true,
      breakerReason: 'too many failures',
    });

    resetBreaker(a, 200);
    expect(readSafetyState(a)).toMatchObject({ breakerOpen: false, breakerReason: null });
  });

  it("does not close another guild's breaker", () => {
    tripBreaker(b, 'too many failures', 100);
    resetBreaker(a, 200);
    expect(readSafetyState(b)?.breakerOpen).toBe(true);
  });
});

describe('automod state (ADR 0121)', () => {
  it('defaults to off for a newly seen guild', () => {
    expect(readSafetyState(a)?.automodState).toBe('off');
  });

  it('rejects a value the CHECK does not name, even from a hand-written row', () => {
    expect(() =>
      t.raw.prepare(`UPDATE guilds SET automod_state = 'enforce' WHERE guild_id = ?`).run(GUILD_A),
    ).toThrow(/CHECK constraint failed: guilds_automod_state/);
  });

  it('sets one guild without touching another', () => {
    setAutomodState(a, 'on', 1_000);
    expect(readSafetyState(a)?.automodState).toBe('on');
    expect(readSafetyState(b)?.automodState).toBe('off');
  });

  it('round-trips watch', () => {
    setAutomodState(a, 'watch', 1_000);
    expect(readSafetyState(a)?.automodState).toBe('watch');
  });

  it('bumps updated_at', () => {
    setAutomodState(a, 'watch', 5_000);
    expect(findGuild(a)?.updatedAt).toBe(5_000);
  });

  it('reads an unexpected stored value as off', () => {
    // The CHECK forbids this row, so the test switches CHECKs off to plant
    // it: the read must still fail closed if one ever exists.
    t.raw.pragma('ignore_check_constraints = ON');
    t.raw.prepare("UPDATE guilds SET automod_state = 'bogus' WHERE guild_id = ?").run(GUILD_A);
    t.raw.pragma('ignore_check_constraints = OFF');
    expect(readSafetyState(a)?.automodState).toBe('off');
  });
});
