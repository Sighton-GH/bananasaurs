import type { Db } from './db.js';
import { dbOf, isReadonly, type GuildScope } from './scope.js';

/**
 * Refused because the process was started with BANANASAURS_READONLY.
 *
 * A single interception point, so "is readonly respected?" is one test against
 * one function rather than an audit of every call site.
 */
export class ReadonlyError extends Error {
  override readonly name = 'ReadonlyError';
  constructor(guildId: string) {
    super(
      `refusing a write for guild ${guildId}: BANANASAURS_READONLY is set. ` +
        `The process is running in observe-only mode.`,
    );
  }
}

/**
 * Rejects any type that is a Promise.
 *
 * `Promise<T>` resolves to `never`, so an `async` callback is not assignable to
 * the parameter and the call fails to compile:
 *
 *     error TS2345: Argument of type '() => Promise<number>' is not assignable
 *                   to parameter of type '(tx: WriteTx) => never'.
 */
type NotPromise<T> = T extends Promise<unknown> ? never : T;

/**
 * The transaction handle. Same scope, bound to the transaction's connection.
 */
export interface WriteTx {
  readonly db: Db;
  readonly scope: GuildScope;
}

/**
 * The only way to write.
 *
 * **Threat B, the one that actually bites.** better-sqlite3 is synchronous and
 * Node is single-threaded, so two `.run()` calls cannot interleave — a
 * background worker and interactive reads sharing the process is not by itself
 * a problem. The problem is `await` *inside* a transaction:
 *
 *     db.exec('BEGIN');
 *     const panel = readPanel();
 *     await discord.addRole(...);   // event loop yields; another task writes
 *     db.exec('COMMIT');            // ...inside our transaction
 *
 * The callback's return type makes that unrepresentable rather than merely
 * discouraged: an `async` function cannot be passed. There is no runtime check
 * to forget and no lint rule to disable.
 *
 * The consequence shapes every module, and is meant to: **every unit of work is
 * plan → decide → execute → record.** Reads and Discord I/O are async and
 * happen outside transactions; the decision and the recording are synchronous
 * and happen inside them. That is what single-writer discipline means
 * concretely (ADR 0008).
 */
export function write<T>(scope: GuildScope, fn: (tx: WriteTx) => NotPromise<T>): T {
  if (isReadonly(scope)) throw new ReadonlyError(scope.guildId);
  const db = dbOf(scope);
  return db.transaction((tx) => fn({ db: tx, scope }) as T);
}

/**
 * A read, for symmetry and for the readonly check's absence.
 *
 * Reads are allowed in readonly mode — that is the entire point of the mode —
 * so this exists to give repository code one obvious way to reach the handle
 * without exporting `dbOf` from the package.
 */
export function read<T>(scope: GuildScope, fn: (db: Db) => NotPromise<T>): T {
  return fn(dbOf(scope));
}
