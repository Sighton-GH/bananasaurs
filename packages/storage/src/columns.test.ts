import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SnowflakeTypeError } from './columns.js';
import { openMigratedTestDatabase, type MigratedTestDatabase } from './test-support.js';
import { guilds } from './schema.js';

const REAL = '1234567890123456789';

let t: MigratedTestDatabase;

beforeEach(() => {
  t = openMigratedTestDatabase();
});
afterEach(() => {
  t.close();
});

const row = (overrides: Record<string, unknown> = {}) => ({
  guildId: REAL,
  name: 'test guild',
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

describe('a JS number reaching a snowflake column', () => {
  /**
   * The test Bryan asked for. It fails if the guard is removed.
   *
   * Note what it does NOT rely on: SQLite refusing the value. SQLite would
   * accept it. TEXT affinity coerces a number to text, and STRICT does not
   * change that — STRICT permits lossless INTEGER/REAL-to-TEXT conversion
   * exactly as affinity does. The refusal is ours.
   */
  it('is refused by the column, not by SQLite', () => {
    expect(() =>
      // The column's TS type is string; the whole point of the runtime guard is
      // that the type is not what stops this at three in the morning.
      t.db
        .insert(guilds)
        .values(row({ guildId: Number(REAL) }) as never)
        .run(),
    ).toThrow(SnowflakeTypeError);
  });

  it('names the column and says why', () => {
    expect(() =>
      t.db
        .insert(guilds)
        .values(row({ guildId: Number(REAL) }) as never)
        .run(),
    ).toThrow(/guild_id: expected a snowflake string, received number/);
  });

  it('is refused as a bigint too', () => {
    expect(() =>
      t.db
        .insert(guilds)
        .values(row({ guildId: BigInt(REAL) }) as never)
        .run(),
    ).toThrow(SnowflakeTypeError);
  });

  it('accepts the same snowflake as a string', () => {
    t.db.insert(guilds).values(row()).run();
    expect(t.raw.prepare('SELECT guild_id FROM guilds').get()).toEqual({ guild_id: REAL });
  });
});

describe('raw SQL that bypasses drizzle entirely', () => {
  // Defence in depth: the migration ships a format CHECK, so a number that
  // never passes through the column mapper is still refused.
  it('cannot store a number in a snowflake column', () => {
    expect(() =>
      t.raw
        .prepare('INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?,?,?,?)')
        .run(Number(REAL), 'x', 0, 0),
    ).toThrow(/CHECK constraint failed/);
  });

  it('honestly cannot catch a snowflake already stringified after corruption', () => {
    // Documented as a limit, not asserted as a protection. This value is 19
    // digits and passes every check; it is simply the wrong guild. Only
    // parseSnowflakeId at the boundary can refuse it, and only because it is
    // still a number there.
    const corrupted = String(Number(REAL));
    expect(corrupted).not.toBe(REAL);
    expect(() =>
      t.raw
        .prepare('INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?,?,?,?)')
        .run(corrupted, 'x', 0, 0),
    ).not.toThrow();
  });
});

describe('the snowflake format CHECK', () => {
  const insert = (guildId: string) =>
    t.raw
      .prepare('INSERT INTO guilds (guild_id, name, created_at, updated_at) VALUES (?,?,?,?)')
      .run(guildId, 'x', 0, 0);

  it.each([
    ['digits then letters', '1234567890123456abc'],
    ['digits with a space', '123456789012345 78'],
    ['too short', '12345'],
    ['too long', '123456789012345678901'],
  ])('refuses %s', (_label, value) => {
    expect(() => insert(value)).toThrow(/CHECK constraint failed/);
  });

  it('accepts a well-formed snowflake', () => {
    expect(() => insert('987654321098765432')).not.toThrow();
  });
});

describe('STRICT', () => {
  /**
   * STRICT's actual contribution. Without it SQLite stores the string 'lots' in
   * an INTEGER column and every later read gets a string where it expected a
   * number. This is the failure STRICT prevents; it is not the snowflake one.
   */
  it('refuses a text value in an INTEGER column', () => {
    expect(() =>
      t.raw
        .prepare(
          'INSERT INTO guilds (guild_id, name, created_at, updated_at, role_rate_per_min) VALUES (?,?,?,?,?)',
        )
        .run(REAL, 'x', 0, 0, 'lots'),
    ).toThrow(/cannot store TEXT value in INTEGER column/);
  });

  it('still applies the usual numeric-string affinity conversion', () => {
    // STRICT is not a straitjacket: '7' is a well-formed integer literal and is
    // converted. Worth pinning so nobody later "fixes" a passing test.
    t.raw
      .prepare(
        'INSERT INTO guilds (guild_id, name, created_at, updated_at, role_rate_per_min) VALUES (?,?,?,?,?)',
      )
      .run(REAL, 'x', 0, 0, '7');
    expect(
      t.raw.prepare('SELECT role_rate_per_min r, typeof(role_rate_per_min) t FROM guilds').get(),
    ).toEqual({ r: 7, t: 'integer' });
  });
});
