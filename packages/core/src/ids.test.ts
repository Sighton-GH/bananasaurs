import { describe, expect, it } from 'vitest';
import { isSnowflakeId, parseGuildId, parseSnowflakeId, type SnowflakeId } from './ids.js';

/**
 * The snowflake that motivates all of this. 1234567890123456789 is a plausible
 * Discord id; as a JS number it becomes 1234567890123456800.
 */
const REAL = '1234567890123456789';
const CORRUPTED_BY_JS = String(Number(REAL));

describe('parseSnowflakeId', () => {
  it('accepts a real snowflake string', () => {
    expect(parseSnowflakeId(REAL)).toBe(REAL);
  });

  it('refuses a JS number, because it is already corrupted', () => {
    // This is the case the whole module exists for. By the time a snowflake is
    // a number the digits are gone, and every layer below this one — TEXT
    // affinity, a format CHECK, even a STRICT column — will store the
    // corruption without complaint.
    expect(() => parseSnowflakeId(Number(REAL))).toThrow(/already corrupted/);
  });

  it('says why, rather than reporting a generic type error', () => {
    // A useful message at the call site is the entire advantage of refusing
    // here instead of at the database.
    expect(() => parseSnowflakeId(Number(REAL))).toThrow(/cannot hold a snowflake/);
  });

  it('refuses a bigint', () => {
    expect(() => parseSnowflakeId(BigInt(REAL))).toThrow(/bigint/);
  });

  it('refuses a snowflake that has been through a JS number and back to string', () => {
    // Proof that the format is not the defence: this value passes every regex
    // and CHECK we could write, and is the wrong id.
    expect(CORRUPTED_BY_JS).toMatch(/^[0-9]{19}$/);
    expect(CORRUPTED_BY_JS).not.toBe(REAL);
    // It is indistinguishable from a valid id and IS accepted here. The refusal
    // has to happen upstream, where it was still a number.
    expect(parseSnowflakeId(CORRUPTED_BY_JS)).toBe(CORRUPTED_BY_JS);
  });

  it.each([
    ['too short', '12345'],
    ['digits then letters', '1234567890123456abc'],
    ['digits with a space', '123456789012345 78'],
    ['scientific notation', '1.2345678901234568e+18'],
    ['empty', ''],
    ['null', null],
    ['undefined', undefined],
    ['object', { id: REAL }],
  ])('refuses %s', (_label, value) => {
    expect(() => parseSnowflakeId(value)).toThrow();
  });
});

describe('parseGuildId', () => {
  it('produces a value usable wherever a SnowflakeId is required', () => {
    const guildId = parseGuildId(REAL);
    const asSnowflake: SnowflakeId = guildId;
    expect(asSnowflake).toBe(REAL);
  });

  it('refuses a number for the same reason', () => {
    expect(() => parseGuildId(Number(REAL))).toThrow(/already corrupted/);
  });
});

describe('a job payload round-tripped through JSON', () => {
  /**
   * The realistic path by which a numeric snowflake reaches us. `jobs.payload`
   * is TEXT holding JSON; if anything ever writes a snowflake as a bare numeric
   * literal, JSON.parse hands back a corrupted number on read.
   */
  it('fails validation when a snowflake was written as a numeric literal', () => {
    const payload: unknown = JSON.parse(`{"userId": 1234567890123456789}`);
    const userId = (payload as { userId: unknown }).userId;

    expect(typeof userId).toBe('number');
    expect(() => parseSnowflakeId(userId)).toThrow(/already corrupted/);
  });

  it('passes when the snowflake was written as a string, as Discord sends it', () => {
    const payload: unknown = JSON.parse(`{"userId": "${REAL}"}`);
    const userId = (payload as { userId: unknown }).userId;

    expect(parseSnowflakeId(userId)).toBe(REAL);
  });
});

describe('isSnowflakeId', () => {
  it('narrows a valid string', () => {
    expect(isSnowflakeId(REAL)).toBe(true);
  });

  it('rejects a number without throwing', () => {
    expect(isSnowflakeId(Number(REAL))).toBe(false);
  });
});
