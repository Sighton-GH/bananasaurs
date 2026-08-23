import type { DiscordPort, DiscordRole, Snowflake } from './port.js';

/**
 * Can the bot assign this role, right now?
 *
 * Checked immediately before every mutation rather than at startup, because the
 * failure mode is somebody reordering roles in the Discord UI months later
 * (REVIEW C9). It is also the periodic self-check that marks a managed role
 * unassignable in the dashboard.
 *
 * `managed` is the case every planning document missed: an integration role, a
 * Nitro booster role, or another bot's role cannot be assigned no matter where
 * it sits in the hierarchy. Without this branch, `doctor` reports the role
 * healthy and the grant fails at runtime with a confusing 403.
 */
export type Assignability =
  | { assignable: true }
  | { assignable: false; reason: 'above_bot' | 'managed' | 'is_everyone' | 'missing' };

export function resolveAssignability(
  role: DiscordRole | undefined,
  botHighestPosition: number,
  guildId: Snowflake,
): Assignability {
  if (!role) return { assignable: false, reason: 'missing' };
  // @everyone shares the guild id and can never be granted or removed.
  if (role.id === guildId) return { assignable: false, reason: 'is_everyone' };
  if (role.managed) return { assignable: false, reason: 'managed' };
  // Strictly below. A role at the same position as the bot's highest is not
  // assignable either, which is the off-by-one that makes panels fail after a
  // role reorder.
  if (role.position >= botHighestPosition) return { assignable: false, reason: 'above_bot' };
  return { assignable: true };
}

export async function checkRoleAssignable(
  port: DiscordPort,
  guildId: Snowflake,
  roleId: Snowflake,
): Promise<Assignability> {
  const [roles, botPosition] = await Promise.all([
    port.fetchRoles(guildId),
    port.fetchBotHighestRolePosition(guildId),
  ]);
  return resolveAssignability(
    roles.find((r) => r.id === roleId),
    botPosition,
    guildId,
  );
}
