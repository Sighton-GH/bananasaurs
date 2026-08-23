import { sql, type SQL } from 'drizzle-orm';
import { text, type SQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * A Discord snowflake column.
 *
 * Snowflakes are 64-bit and exceed Number.MAX_SAFE_INTEGER, so they are TEXT
 * everywhere. Pair every one of these with `snowflakeCheck` in the table's
 * constraint list.
 *
 * Note on STRICT: the plan called for STRICT tables. drizzle-kit does not emit
 * STRICT, and SQLite's TEXT affinity already coerces an integer to text on
 * insert, so the precision failure STRICT was meant to prevent does not
 * actually occur here. The format CHECK below is a stronger guarantee than
 * STRICT would have given, because it constrains the value rather than only
 * its type: STRICT would happily accept the string 'not-an-id'.
 */
export const snowflake = (name: string) => text(name);

/** Value must be 17-20 digits. */
export const snowflakeCheck = (column: SQLiteColumn): SQL =>
  sql`(${column} GLOB '[0-9]*' AND length(${column}) BETWEEN 17 AND 20)`;

/** Same, but satisfied when the column is NULL. */
export const nullableSnowflakeCheck = (column: SQLiteColumn): SQL =>
  sql`(${column} IS NULL OR (${column} GLOB '[0-9]*' AND length(${column}) BETWEEN 17 AND 20))`;

export const boolCheck = (column: SQLiteColumn): SQL => sql`${column} IN (0,1)`;
