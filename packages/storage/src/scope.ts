import { and, eq, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { GuildId } from '@bananasaurs/core';
import type { Db } from './db.js';

/**
 * Guild scope, made structural.
 *
 * `CLAUDE.md` rule 2 says a query that *can* omit guild scope is a bug even if
 * every current caller passes it, and that this must be enforced in signatures
 * rather than in caller discipline. Two things do that here:
 *
 * 1. The database handle is not reachable outside this package. `dbOf` is not
 *    re-exported from `index.ts`, so the only way for `core`, `http` or `cli`
 *    to read a row is a repository function, and every repository function
 *    takes a `GuildScope` as its first parameter.
 * 2. `scope.only(table)` accepts only tables that carry a `guild_id` column, so
 *    passing an instance-level table is a compile error rather than a silently
 *    unscoped query.
 *
 * Neither replaces the composite foreign keys, which are what make a
 * cross-guild row physically impossible. These make the *common* mistake — a
 * forgotten predicate — not expressible.
 */

/** A table that carries the partition key. Instance-level tables do not match. */
export type GuildPartitionedTable = SQLiteTable & { guildId: SQLiteColumn };

export interface GuildScope {
  readonly guildId: GuildId;

  /**
   * The guild predicate for `table`, and any further conditions.
   *
   * There is no overload without a table and no way to build the predicate by
   * hand from outside this module, so a scoped query cannot lose its scope by
   * someone deleting a line.
   */
  only(table: GuildPartitionedTable, ...extra: (SQL | undefined)[]): SQL;
}

interface ScopeInternals {
  db: Db;
  readonly: boolean;
}

/**
 * Deliberately a WeakMap rather than a property. A property named `db` on the
 * scope would be reachable by anything holding a scope — including `core` —
 * which is exactly the thing the boundary exists to prevent.
 */
const internals = new WeakMap<AnyScope, ScopeInternals>();

/**
 * A scope for the tables that are deliberately not guild-partitioned:
 * `dashboard_accounts` and `bootstrap_tokens` (ADR 0027).
 *
 * It carries **no `only()`**, and that absence is the design. A repository
 * function's first parameter answers "is this query partitioned?" — a
 * `GuildScope` means yes, an `InstanceScope` means deliberately no. Passing a
 * `GuildScope` to an instance-level repository and simply not calling `only()`
 * would make that a question you answer by reading the body, which is exactly
 * the failure `CLAUDE.md` rule 2 names.
 */
export interface InstanceScope {
  /**
   * A real property, so `{}` is not structurally an `InstanceScope`. That keeps
   * the fabricated-scope refusal reachable in a test rather than only in
   * theory.
   */
  readonly kind: 'instance';
}

/** Either scope. The database handle is reached the same way through both. */
export type AnyScope = GuildScope | InstanceScope;

export interface ScopeFactory {
  /** The only way to obtain a scope, and therefore to reach guild data. */
  forGuild(guildId: GuildId): GuildScope;
  /**
   * The only way to reach an instance-level table (ADR 0027).
   *
   * Returns a fresh object per call rather than a cached singleton, for the
   * same reason `forGuild` does: the handle lives in a `WeakMap` keyed by the
   * scope, so a scope is a capability that gets passed, not a global that gets
   * reached.
   */
  instance(): InstanceScope;
}

export const createScopeFactory = (db: Db, options: { readonly: boolean }): ScopeFactory => ({
  forGuild(guildId: GuildId): GuildScope {
    const scope: GuildScope = {
      guildId,
      only(table, ...extra) {
        const guildOnly = eq(table.guildId, guildId);
        // `and` returns undefined when every condition is undefined; the guild
        // predicate is never undefined, so the fallback is unreachable in
        // practice and is here to avoid a non-null assertion.
        return and(guildOnly, ...extra) ?? guildOnly;
      },
    };
    internals.set(scope, { db, readonly: options.readonly });
    return scope;
  },

  instance(): InstanceScope {
    const scope: InstanceScope = { kind: 'instance' };
    internals.set(scope, { db, readonly: options.readonly });
    return scope;
  },
});

/**
 * The database behind a scope. Internal to this package — not exported from
 * `index.ts`, which is what keeps the handle out of `core`.
 */
export const dbOf = (scope: AnyScope): Db => {
  const found = internals.get(scope);
  if (!found) {
    throw new Error(
      'this scope was not produced by createScopeFactory. Scopes carry the ' +
        'database handle out of band precisely so one cannot be fabricated; obtain ' +
        'it from forGuild() or instance().',
    );
  }
  return found.db;
};

/**
 * Whether the process was started with BANANASAURS_READONLY.
 *
 * Defaults to `true` for a scope this module did not produce, so a fabricated
 * scope refuses a write rather than being handed an unguarded handle. `dbOf`
 * throws on the same input a line later; this is the safer of the two orders.
 */
export const isReadonly = (scope: AnyScope): boolean => internals.get(scope)?.readonly ?? true;
