import { eq } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { mcpPrivateThreads, mcpRoleAllowlist, mcpRolePolicy } from '../schema.js';

/**
 * The MCP role policy and the MCP-created private threads (ADR 0117 §2,
 * ADR 0116 §3). Every function takes a `GuildScope` first and scopes through
 * `scope.only`, like every repository here.
 *
 * The policy and allowlist rows are written by slice 5's policy controls; the
 * private-thread rows are written by the thread tools in the same transaction
 * as the creating action's completion. This module reads all three and owns
 * the idempotent private-thread write.
 */

export type RolePolicyMode = 'below-bot' | 'allowlist';
export type RoleAllowlistPurpose = 'grant' | 'ping';

export interface RolePolicy {
  readonly grantMode: RolePolicyMode;
  readonly pingMode: RolePolicyMode;
}

/** Absent row means both modes are `below-bot` (ADR 0117, consequences). */
export const readRolePolicy = (scope: GuildScope): RolePolicy =>
  read(scope, (db) => {
    const row = db
      .select({ grantMode: mcpRolePolicy.grantMode, pingMode: mcpRolePolicy.pingMode })
      .from(mcpRolePolicy)
      .where(scope.only(mcpRolePolicy))
      .get();
    return {
      grantMode: (row?.grantMode ?? 'below-bot') as RolePolicyMode,
      pingMode: (row?.pingMode ?? 'below-bot') as RolePolicyMode,
    };
  });

/**
 * Whether the role is allowlisted for this purpose. A `ping` row never
 * satisfies `grant` and vice versa — a role allowed for both has two rows.
 */
export const isRoleAllowlisted = (
  scope: GuildScope,
  roleId: string,
  purpose: RoleAllowlistPurpose,
): boolean =>
  read(
    scope,
    (db) =>
      db
        .select({ roleId: mcpRoleAllowlist.roleId })
        .from(mcpRoleAllowlist)
        .where(
          scope.only(
            mcpRoleAllowlist,
            eq(mcpRoleAllowlist.roleId, roleId),
            eq(mcpRoleAllowlist.purpose, purpose),
          ),
        )
        .get() !== undefined,
  );

/**
 * Records a private thread the MCP created. Idempotent: recording the same
 * thread twice is a no-op, so a retried completion cannot duplicate the row.
 */
export const recordPrivateThread = (
  scope: GuildScope,
  input: { threadId: string; parentChannelId: string; createdActionId: string; now: number },
): void =>
  write(scope, ({ db }) => {
    db.insert(mcpPrivateThreads)
      .values({
        guildId: scope.guildId,
        threadId: input.threadId,
        parentChannelId: input.parentChannelId,
        createdActionId: input.createdActionId,
        createdAt: input.now,
      })
      .onConflictDoNothing({ target: [mcpPrivateThreads.guildId, mcpPrivateThreads.threadId] })
      .run();
  });

/** Whether the thread was created through the MCP (ADR 0115 §1's read rule). */
export const isMcpPrivateThread = (scope: GuildScope, threadId: string): boolean =>
  read(
    scope,
    (db) =>
      db
        .select({ threadId: mcpPrivateThreads.threadId })
        .from(mcpPrivateThreads)
        .where(scope.only(mcpPrivateThreads, eq(mcpPrivateThreads.threadId, threadId)))
        .get() !== undefined,
  );
