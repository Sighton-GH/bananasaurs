import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { parseGuildId } from '@bananasaurs/core';
import { openMigratedTestDatabase, type MigratedTestDatabase } from './test-support.js';
import { createScopeFactory, type GuildScope } from './scope.js';
import { read, write, ReadonlyError } from './write.js';
import { dashboardAccounts, guilds, panels } from './schema.js';
import {
  findGuild,
  readSafetyState,
  resetBreaker,
  setKillswitch,
  tripBreaker,
  upsertGuild,
} from './repos/guilds.js';

const GUILD_A = parseGuildId('111111111111111111');
const GUILD_B = parseGuildId('222222222222222222');

let t: MigratedTestDatabase;
let a: GuildScope;
let b: GuildScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  a = t.scopes.forGuild(GUILD_A);
  b = t.scopes.forGuild(GUILD_B);
  upsertGuild(a, { name: 'guild a', now: 1000 });
  upsertGuild(b, { name: 'guild b', now: 1000 });
});
afterEach(() => {
  t.close();
});

describe('write() makes an await inside a transaction unrepresentable', () => {
  /**
   * The threat: `db.exec('BEGIN')`, then `await discord.addRole(...)`, then
   * COMMIT. The await yields the event loop and another task's writes land
   * inside our transaction. better-sqlite3 being synchronous does not save us,
   * because the transaction stays open across the yield.
   *
   * This is enforced by the callback's return type, so the check is at compile
   * time and there is no runtime guard to forget. These two assertions are
   * checked by `npm run typecheck`, not at runtime: if the async case ever
   * becomes assignable, `@ts-expect-error` itself becomes the error.
   */
  it('rejects an async callback', () => {
    // @ts-expect-error Promise<T> resolves to never, so this does not compile
    expect(() => write(a, async () => Promise.resolve(1))).toBeDefined();
  });

  it('rejects a callback that returns a promise without being async', () => {
    // The `async` keyword is not what is being caught — the return type is. A
    // plain function handing back a promise leaves the same transaction open
    // across the same yield, so it is refused the same way.
    // @ts-expect-error NotPromise rejects any promise return, async or not
    expect(() => write(a, () => Promise.resolve(1))).toBeDefined();
  });

  it('accepts a synchronous callback and returns its value', () => {
    expect(write(a, () => 42)).toBe(42);
  });

  it('commits what the callback wrote', () => {
    write(a, ({ db }) => {
      db.update(guilds).set({ name: 'renamed' }).where(a.only(guilds)).run();
    });
    expect(findGuild(a)?.name).toBe('renamed');
  });

  it('rolls back when the callback throws', () => {
    expect(() =>
      write(a, ({ db }) => {
        db.update(guilds).set({ name: 'half-written' }).where(a.only(guilds)).run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(findGuild(a)?.name).toBe('guild a');
  });
});

describe('readonly mode', () => {
  it('refuses every write through a readonly scope', () => {
    const ro = createScopeFactory(t.db, { readonly: true }).forGuild(GUILD_A);
    expect(() => write(ro, () => 1)).toThrow(ReadonlyError);
  });

  it('names the guild it refused, so a log line is actionable', () => {
    const ro = createScopeFactory(t.db, { readonly: true }).forGuild(GUILD_A);
    expect(() => write(ro, () => 1)).toThrow(/111111111111111111/);
  });

  it('still allows reads, which is the point of the mode', () => {
    const ro = createScopeFactory(t.db, { readonly: true }).forGuild(GUILD_A);
    expect(findGuild(ro)?.name).toBe('guild a');
  });
});

describe('guild scope is structural', () => {
  it('refuses to build a predicate for an instance-level table', () => {
    // dashboard_accounts has no guild_id, so scoping it is meaningless. This
    // is a compile error rather than a query that silently returns every row.
    // @ts-expect-error dashboardAccounts has no guildId column
    expect(() => a.only(dashboardAccounts)).toBeDefined();
  });

  it('reads only its own guild, with no predicate written by the caller', () => {
    write(a, ({ db }) => {
      db.insert(panels)
        .values({
          guildId: GUILD_A,
          panelId: 'p1',
          kind: 'managed',
          channelId: '333333333333333333',
          behaviour: 'toggle',
          component: 'button',
          createdAt: 0,
          updatedAt: 0,
        })
        .run();
    });

    expect(read(a, (db) => db.select().from(panels).where(a.only(panels)).all())).toHaveLength(1);
    expect(read(b, (db) => db.select().from(panels).where(b.only(panels)).all())).toHaveLength(0);
  });

  it('combines the guild predicate with further conditions', () => {
    const withExtra = a.only(guilds, eq(guilds.name, 'guild a'));
    expect(read(a, (db) => db.select().from(guilds).where(withExtra).all())).toHaveLength(1);

    const noMatch = a.only(guilds, eq(guilds.name, 'guild b'));
    // Guild B exists and is named 'guild b', so a match here would mean the
    // guild predicate had been dropped in favour of the extra condition.
    expect(read(a, (db) => db.select().from(guilds).where(noMatch).all())).toHaveLength(0);
  });

  it('refuses a fabricated scope rather than reaching an arbitrary database', () => {
    const forged: GuildScope = { guildId: GUILD_A, only: () => a.only(guilds) };
    expect(() => findGuild(forged)).toThrow(/not produced by createScopeFactory/);
  });
});

describe('upsertGuild survives a replayed GUILD_CREATE', () => {
  it('does not duplicate', () => {
    upsertGuild(a, { name: 'guild a', now: 2000 });
    expect(read(a, (db) => db.select().from(guilds).all())).toHaveLength(2); // a and b
  });

  it('updates the name', () => {
    upsertGuild(a, { name: 'new name', now: 2000 });
    expect(findGuild(a)?.name).toBe('new name');
  });

  it('does not reset the kill switch', () => {
    // The failure this guards: a reconnect replays GUILD_CREATE for every
    // guild. If the upsert reset operator state, every reconnect would silently
    // re-enable a bot someone had deliberately stopped.
    setKillswitch(a, true, 1500);
    upsertGuild(a, { name: 'guild a', now: 2000 });
    expect(readSafetyState(a)?.killswitch).toBe(true);
  });

  it('does not reset a tripped breaker', () => {
    tripBreaker(a, 'too many failures', 1500);
    upsertGuild(a, { name: 'guild a', now: 2000 });
    expect(readSafetyState(a)?.breakerOpen).toBe(true);
  });

  it('does not reset dry run to its default', () => {
    write(a, ({ db }) => {
      db.update(guilds).set({ dryRun: 0 }).where(a.only(guilds)).run();
    });
    upsertGuild(a, { name: 'guild a', now: 2000 });
    expect(readSafetyState(a)?.dryRun).toBe(false);
  });
});

describe('the circuit breaker is durable', () => {
  it('records the reason so an operator knows what happened', () => {
    tripBreaker(a, 'rate cap exceeded by adoption pass', 1500);
    expect(readSafetyState(a)?.breakerReason).toBe('rate cap exceeded by adoption pass');
  });

  it('does not overwrite the first reason when tripped again', () => {
    tripBreaker(a, 'first cause', 1500);
    tripBreaker(a, 'second cause', 1600);
    expect(readSafetyState(a)?.breakerReason).toBe('first cause');
  });

  it('is scoped: tripping one guild does not open another', () => {
    tripBreaker(a, 'first cause', 1500);
    expect(readSafetyState(b)?.breakerOpen).toBe(false);
  });

  it('closes only when reset', () => {
    tripBreaker(a, 'first cause', 1500);
    resetBreaker(a, 1700);
    const state = readSafetyState(a);
    expect(state?.breakerOpen).toBe(false);
    expect(state?.breakerReason).toBeNull();
  });
});
