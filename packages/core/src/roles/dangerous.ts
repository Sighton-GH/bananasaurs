/**
 * The dangerous-permission floor (ADR 0117 section 3): a role holding any of
 * these permissions is never pingable by policy, never grantable, and never
 * allowlisted.
 *
 * The values are bigint literals because `packages/core` must not depend on
 * discord-api-types or discord.js; the test in `packages/discord` checks
 * `DANGEROUS_PERMISSION_BITS` against `PermissionFlagsBits` so the literals
 * cannot drift from the real flags.
 */

/** Discord flag `KickMembers`. */
export const KICK_MEMBERS = 1n << 1n;
/** Discord flag `BanMembers`. */
export const BAN_MEMBERS = 1n << 2n;
/** Discord flag `Administrator`. */
export const ADMINISTRATOR = 1n << 3n;
/** Discord flag `ManageChannels`. */
export const MANAGE_CHANNELS = 1n << 4n;
/** Discord flag `ManageGuild`. */
export const MANAGE_GUILD = 1n << 5n;
/** Discord flag `ManageMessages`. */
export const MANAGE_MESSAGES = 1n << 13n;
/** Discord flag `MentionEveryone`. */
export const MENTION_EVERYONE = 1n << 17n;
/** Discord flag `ManageRoles`. */
export const MANAGE_ROLES = 1n << 28n;
/** Discord flag `ManageWebhooks`. */
export const MANAGE_WEBHOOKS = 1n << 29n;
/** Discord flag `ManageGuildExpressions`. */
export const MANAGE_GUILD_EXPRESSIONS = 1n << 30n;
/** Discord flag `ManageEvents`. */
export const MANAGE_EVENTS = 1n << 33n;
/** Discord flag `ManageThreads`. */
export const MANAGE_THREADS = 1n << 34n;
/** Discord flag `ModerateMembers`. */
export const MODERATE_MEMBERS = 1n << 40n;

/**
 * The floor, keyed by the Discord flag name (`PermissionFlagsBits` key), so
 * the packages/discord cross-check and callers can iterate it readably.
 */
export const DANGEROUS_PERMISSION_BITS = {
  Administrator: ADMINISTRATOR,
  ManageChannels: MANAGE_CHANNELS,
  ManageGuild: MANAGE_GUILD,
  KickMembers: KICK_MEMBERS,
  BanMembers: BAN_MEMBERS,
  ManageMessages: MANAGE_MESSAGES,
  MentionEveryone: MENTION_EVERYONE,
  ManageRoles: MANAGE_ROLES,
  ManageWebhooks: MANAGE_WEBHOOKS,
  ManageGuildExpressions: MANAGE_GUILD_EXPRESSIONS,
  ManageEvents: MANAGE_EVENTS,
  ManageThreads: MANAGE_THREADS,
  ModerateMembers: MODERATE_MEMBERS,
} as const;

/**
 * Does this permission bitmask include any dangerous bit? Pure, so callers can
 * run it live at the call site (the floor is checked at the call, not cached).
 */
export function isDangerousRole(permissions: bigint): boolean {
  return Object.values(DANGEROUS_PERMISSION_BITS).some((bit) => (permissions & bit) !== 0n);
}

/** Everything the ping policy needs about a role, without importing Discord types. */
export interface RoleFacts {
  readonly id: string;
  readonly position: number;
  readonly permissions: bigint;
  readonly managed: boolean;
  readonly isEveryone: boolean;
}

/** Why `rolePingAllowed` refused, when it does. */
export type RolePingRefusal = 'managed-or-everyone' | 'dangerous' | 'above-bot' | 'not-allowlisted';

/**
 * May this role be pinged under ADR 0117 section 3? Returns `true` or the
 * first refusal, checked in order: managed/@everyone, dangerous permissions,
 * above the bot, and (allowlist mode only) not on the allowlist.
 *
 * `above-bot` is the same off-by-one rule as assignability: a role at the bot's
 * highest position counts as above it.
 */
export function rolePingAllowed(
  role: RoleFacts,
  botTopPosition: number,
  mode: 'below-bot' | 'allowlist',
  allowlisted: boolean,
): true | RolePingRefusal {
  if (role.managed || role.isEveryone) return 'managed-or-everyone';
  if (isDangerousRole(role.permissions)) return 'dangerous';
  if (role.position >= botTopPosition) return 'above-bot';
  if (mode === 'allowlist' && !allowlisted) return 'not-allowlisted';
  return true;
}
