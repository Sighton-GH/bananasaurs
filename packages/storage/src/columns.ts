import { sql, type SQL } from 'drizzle-orm';
import { customType, type SQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * Thrown when a non-string reaches a snowflake column. Named rather than a bare
 * TypeError so the daemon can log it as a bug in our code — which it always
 * is — rather than as bad input from Discord.
 */
export class SnowflakeTypeError extends TypeError {
  override readonly name = 'SnowflakeTypeError';
  constructor(
    readonly column: string,
    readonly received: unknown,
  ) {
    super(
      `${column}: expected a snowflake string, received ${typeof received}. ` +
        `A JS number cannot hold a snowflake — by the time it reaches the database ` +
        `the digits are already wrong, and TEXT affinity would store the corruption ` +
        `faithfully. Parse it with parseSnowflakeId() at the boundary it entered.`,
    );
  }
}

const guardSnowflake = (column: string, value: unknown): string => {
  if (typeof value === 'string') return value;
  throw new SnowflakeTypeError(column, value);
};

/**
 * A Discord snowflake column.
 *
 * TEXT, because snowflakes exceed Number.MAX_SAFE_INTEGER. The custom type
 * exists for `toDriver`: it is the last point on the write path where a number
 * is still recognisably a number, so it refuses one there with a message that
 * names the column. Without it, SQLite stores the corruption without complaint
 * — TEXT affinity coerces, and STRICT does *not* prevent this: STRICT permits
 * lossless INTEGER/REAL-to-TEXT conversion exactly as affinity does.
 *
 * This guard is defence in depth, not the control. It cannot see a snowflake
 * that was corrupted and then stringified — `String(1234567890123456800)` is a
 * valid-looking nineteen-digit string. That case is refused at the parse
 * boundary by `parseSnowflakeId` in `@bananasaurs/core`; see the note there.
 *
 * Pair every one of these with `snowflakeCheck` in the table's constraint list.
 */
export const snowflake = (name: string) =>
  customType<{ data: string; driverData: string }>({
    dataType: () => 'text',
    toDriver: (value: string) => guardSnowflake(name, value),
  })(name);

/**
 * Value must be 17-20 digits, and digits only.
 *
 * `NOT GLOB '*[^0-9]*'` asserts no non-digit anywhere. The earlier form,
 * `GLOB '[0-9]*'`, anchored only the first character, so '1234567890123456abc'
 * and '123456789012345 78' both passed it.
 */
export const snowflakeCheck = (column: SQLiteColumn): SQL =>
  sql`(${column} NOT GLOB '*[^0-9]*' AND length(${column}) BETWEEN 17 AND 20)`;

/** Same, but satisfied when the column is NULL. */
export const nullableSnowflakeCheck = (column: SQLiteColumn): SQL =>
  sql`(${column} IS NULL OR (${column} NOT GLOB '*[^0-9]*' AND length(${column}) BETWEEN 17 AND 20))`;

export const boolCheck = (column: SQLiteColumn): SQL => sql`${column} IN (0,1)`;
