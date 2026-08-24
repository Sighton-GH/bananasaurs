import { eq } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { managedRoles } from '../schema.js';

/**
 * The role allowlist (docs/18 Layer 2), and its health.
 *
 * Membership of this table is what `panel_options` and `role_effects` hold a
 * foreign key into, so "the bot may only touch these roles" is a constraint
 * rather than a check somebody remembers to write. `assignable` and
 * `unassignable_reason` are the *diagnosis*: a role that has been deleted, or
 * that has drifted above the bot in the hierarchy, or that an integration owns.
 *
 * The diagnosis is never the control. The gateway re-checks hierarchy live,
 * immediately before every mutation (`docs/19` §6.6), because the failure mode
 * is somebody reordering roles months after this flag was written. What these
 * columns buy is a `status` and `doctor` that can say *why* a panel option
 * stopped working, instead of a member reporting that a button does nothing.
 */

export const allowlistRole = (scope: GuildScope, roleId: string): void =>
  write(scope, ({ db }) => {
    db.insert(managedRoles).values({ guildId: scope.guildId, roleId }).onConflictDoNothing().run();
  });

export const isAllowlisted = (scope: GuildScope, roleId: string): boolean =>
  read(scope, (db) => {
    const row = db
      .select({ roleId: managedRoles.roleId })
      .from(managedRoles)
      .where(scope.only(managedRoles, eq(managedRoles.roleId, roleId)))
      .get();
    return row !== undefined;
  });

export interface ManagedRoleRow {
  roleId: string;
  assignable: number;
  unassignableReason: string | null;
  lastCheckedAt: number | null;
}

export const findManagedRole = (scope: GuildScope, roleId: string): ManagedRoleRow | undefined =>
  read(scope, (db) =>
    db
      .select({
        roleId: managedRoles.roleId,
        assignable: managedRoles.assignable,
        unassignableReason: managedRoles.unassignableReason,
        lastCheckedAt: managedRoles.lastCheckedAt,
      })
      .from(managedRoles)
      .where(scope.only(managedRoles, eq(managedRoles.roleId, roleId)))
      .get(),
  );

/**
 * Records what a live check found.
 *
 * `reason` is constrained by a CHECK to the three the schema knows about, so a
 * new reason is a migration rather than a string that quietly never renders.
 */
export const setRoleAssignability = (
  scope: GuildScope,
  input: {
    roleId: string;
    assignable: boolean;
    reason?: 'above_bot' | 'managed' | 'deleted' | undefined;
    now: number;
  },
): void =>
  write(scope, ({ db }) => {
    db.update(managedRoles)
      .set({
        assignable: input.assignable ? 1 : 0,
        unassignableReason: input.assignable ? null : (input.reason ?? null),
        lastCheckedAt: input.now,
      })
      .where(scope.only(managedRoles, eq(managedRoles.roleId, input.roleId)))
      .run();
  });
