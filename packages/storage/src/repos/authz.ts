import { and, eq, or, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { isSnowflakeId } from '@bananasaurs/core';
import type { AuthzStore, Capability, PrincipalRef } from '@bananasaurs/core';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { capabilityGrants, principals } from '../schema.js';

/**
 * Principals and capability grants.
 *
 * ADR 0012: Discord Administrator grants nothing. Capability comes only from a
 * `capability_grants` row, so nothing about a member's Discord permission bits
 * is ever consulted. That is deliberate — the club has other administrators,
 * and "admin in Discord" should not silently mean "can reconfigure the bot".
 */

export const upsertPrincipal = (
  scope: GuildScope,
  input: { principalType: 'user' | 'role'; principalId: string; protected?: boolean },
): void =>
  write(scope, ({ db }) => {
    db.insert(principals)
      .values({
        guildId: scope.guildId,
        principalType: input.principalType,
        principalId: input.principalId,
        protected: input.protected === true ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: [principals.guildId, principals.principalType, principals.principalId],
        set: { protected: input.protected === true ? 1 : 0 },
      })
      .run();
  });

export const grantCapability = (
  scope: GuildScope,
  input: {
    principalType: 'user' | 'role';
    principalId: string;
    capability: Capability;
    grantedBy: string;
    now: number;
  },
): void =>
  write(scope, ({ db }) => {
    db.insert(capabilityGrants)
      .values({
        guildId: scope.guildId,
        principalType: input.principalType,
        principalId: input.principalId,
        capability: input.capability,
        grantedAt: input.now,
        grantedBy: input.grantedBy,
      })
      .onConflictDoNothing()
      .run();
  });

export const revokeCapability = (
  scope: GuildScope,
  input: { principalType: 'user' | 'role'; principalId: string; capability: Capability },
): void =>
  write(scope, ({ db }) => {
    db.delete(capabilityGrants)
      .where(
        scope.only(
          capabilityGrants,
          and(
            eq(capabilityGrants.principalType, input.principalType),
            eq(capabilityGrants.principalId, input.principalId),
            eq(capabilityGrants.capability, input.capability),
          ),
        ),
      )
      .run();
  });

/**
 * Matches any of the actor's principals.
 *
 * Built as an OR of exact `(type, id)` pairs rather than two `IN` lists,
 * because separate lists would match a *cross product* — a user id that
 * happened to equal some role's id would match a grant made to that role.
 */
const matchesAny = (
  refs: readonly PrincipalRef[],
  typeColumn: SQLiteColumn,
  idColumn: SQLiteColumn,
): SQL | undefined => {
  const clauses = refs.map((ref) =>
    and(eq(typeColumn, ref.principalType), eq(idColumn, ref.principalId)),
  );
  return clauses.length === 0 ? undefined : or(...clauses);
};

/** The `AuthzStore` port, bound to one guild. */
export const authzStoreFor = (scope: GuildScope): AuthzStore => ({
  hasGrant(capability, refs) {
    if (refs.length === 0) return false;
    return read(scope, (db) => {
      const match = matchesAny(refs, capabilityGrants.principalType, capabilityGrants.principalId);
      if (!match) return false;
      const row = db
        .select({ capability: capabilityGrants.capability })
        .from(capabilityGrants)
        .where(scope.only(capabilityGrants, eq(capabilityGrants.capability, capability), match))
        .get();
      return row !== undefined;
    });
  },

  anyProtected(refs) {
    if (refs.length === 0) return false;
    return read(scope, (db) => {
      const match = matchesAny(refs, principals.principalType, principals.principalId);
      if (!match) return false;
      const row = db
        .select({ principalId: principals.principalId })
        .from(principals)
        .where(scope.only(principals, eq(principals.protected, 1), match))
        .get();
      return row !== undefined;
    });
  },
});

/**
 * Is this *target* protected? (docs/18 Layer 2, target side.)
 *
 * Distinct from `AuthzStore.anyProtected`, which asks whether an *actor* is
 * protected. The two share a table and mean different things: an actor that is
 * protected holds no capability; a target that is protected is not mutated,
 * whoever asks.
 */
export const isTargetProtected = (
  scope: GuildScope,
  input: { userId: string; roleId: string },
): boolean =>
  read(scope, (db) => {
    const row = db
      .select({ principalId: principals.principalId })
      .from(principals)
      .where(
        scope.only(
          principals,
          eq(principals.protected, 1),
          or(
            and(eq(principals.principalType, 'user'), eq(principals.principalId, input.userId)),
            and(eq(principals.principalType, 'role'), eq(principals.principalId, input.roleId)),
          ),
        ),
      )
      .get();
    return row !== undefined;
  });

export interface GrantRow {
  principalType: string;
  principalId: string;
  capability: string;
  grantedAt: number;
  grantedBy: string;
}

/** For the dashboard and `bananasaurs status`. */
export const listGrants = (scope: GuildScope): GrantRow[] =>
  read(scope, (db) =>
    db
      .select({
        principalType: capabilityGrants.principalType,
        principalId: capabilityGrants.principalId,
        capability: capabilityGrants.capability,
        grantedAt: capabilityGrants.grantedAt,
        grantedBy: capabilityGrants.grantedBy,
      })
      .from(capabilityGrants)
      .where(scope.only(capabilityGrants))
      .all(),
  );

/**
 * Protected principals, for `doctor` and the dashboard.
 *
 * The rows are narrowed rather than asserted: `principal_id` is TEXT with a
 * snowflake CHECK, so the database guarantees the shape, but the *type* coming
 * back from drizzle is `string`. `isSnowflakeId` turns that into a real
 * narrowing instead of a cast that quietly claims something the compiler
 * cannot see.
 */
export const listProtectedPrincipals = (scope: GuildScope): PrincipalRef[] =>
  read(scope, (db) =>
    db
      .select({
        principalType: principals.principalType,
        principalId: principals.principalId,
      })
      .from(principals)
      .where(scope.only(principals, eq(principals.protected, 1)))
      .all()
      .flatMap((row): PrincipalRef[] => {
        if (row.principalType !== 'user' && row.principalType !== 'role') return [];
        if (!isSnowflakeId(row.principalId)) return [];
        return [{ principalType: row.principalType, principalId: row.principalId }];
      }),
  );
