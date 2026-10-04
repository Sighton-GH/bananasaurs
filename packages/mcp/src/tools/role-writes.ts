import { z } from 'zod';
import type { GuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';
import { isSnowflake, normalizeRef, resolveRoleRef } from '../resolve.js';
import { safeName } from '../structured.js';
import type { McpGuildPort } from './guild.js';
import type { McpMemberProfile, McpMembersPort } from './members.js';

/**
 * The two role-change tools, registered under the roles scope (ADR 0114).
 *
 * They follow the same five steps as `send_message` — Zod parse →
 * `requireReachableGuild` → port call → render — so hard rule 3 holds by
 * construction, and the same two-message contract (ruling M4-D18): a parse
 * failure is the argument-fault message, a gate failure or any throw is the
 * shared refusal. No tool here throws. Refusal texts are distinct, actionable
 * and content-free (ids only).
 *
 * Member and role refs resolve here, in the tool, before the port is ever
 * called: a member by id or by exact username, display name or nickname —
 * the same matching `search_members` uses in `members.ts` — and a role by id
 * or name through `resolveRoleRef`. The daemon's port therefore takes resolved
 * snowflake ids, and anything unresolvable refuses here with no ledger row.
 * The daemon re-checks every one of these live (unknown member or role, the
 * `managed_roles` row, the grant policy, the protected target) before its
 * claim, so a member or role that vanished between resolution and the call
 * still refuses cleanly — as a race, through the same refusal vocabulary.
 *
 * Every change runs as one `runMcpAction` on the daemon side (kinds
 * `role.grant` / `role.remove`, cap group `member_role`) through the MCP role
 * gateway, with the inverse recorded for `undo_action`.
 */

export const GRANT_ROLE_TOOL_NAME = 'grant_role';
export const GRANT_ROLE_TOOL_DESCRIPTION =
  'Grants a role to a guild member. The member and the role take an id or a name. ' +
  'The role must already be on the bot\u2019s role allowlist and pass the MCP grant policy ' +
  '(below the bot, not managed, not @everyone, no dangerous permissions). ' +
  'A grant the member already holds answers that nothing changed. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without changing.';

export const REMOVE_ROLE_TOOL_NAME = 'remove_role';
export const REMOVE_ROLE_TOOL_DESCRIPTION =
  'Removes a role from a guild member. The member and the role take an id or a name. ' +
  'The role must already be on the bot\u2019s role allowlist and pass the MCP grant policy. ' +
  'A removal of a role the member does not hold answers that nothing changed. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without changing.';

/** What the daemon's role wiring must satisfy (slice 4 Task 3 implements it). */
export interface McpRoleWritesPort {
  readonly grant: (
    guildId: GuildId,
    input: {
      readonly memberId: string;
      readonly roleId: string;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpRoleWriteOutcome>;
  readonly remove: (
    guildId: GuildId,
    input: {
      readonly memberId: string;
      readonly roleId: string;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpRoleWriteOutcome>;
}

/** Mirrors the gateway's outcomes, named in this package's own vocabulary. */
export type McpRoleWriteOutcome =
  | { readonly status: 'done'; readonly actionId: string; readonly alreadyHad: boolean }
  | { readonly status: 'dry-run'; readonly actionId: string }
  | { readonly status: 'replayed'; readonly actionId: string }
  | { readonly status: 'refused'; readonly reason: McpRoleWriteRefusal; readonly detail?: string }
  | { readonly status: 'failed' };

export type McpRoleWriteRefusal =
  | 'unknown-member'
  | 'unknown-role'
  | 'role-not-allowlisted'
  | 'role-not-permitted'
  | 'protected-target'
  | 'unauthorized'
  | 'killswitch'
  | 'breaker-open'
  | 'rate-cap'
  | 'duplicate-key-different-content';

export type RoleWriteOutcomeText =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

/**
 * Zod schemas are the boundary (hard rule 3): a parse failure is the
 * argument-fault message, never a throw, and the parse runs before the guild
 * gate. `guildId` is a bare string on purpose — the gate parses it and
 * refuses malformed and unreachable identically. `member` and `role` take an
 * id or a name (Discord role names run to 100 characters; member query text
 * matches `get_member`'s 100), resolved after the gate. There is no blanket
 * `idsAreWellFormed` check here — a name is not a snowflake — but a ref that
 * is neither a well-formed id nor a known name refuses at resolution, before
 * the port is ever called.
 */
const roleWriteArgsSchema = z.object({
  guildId: z.string(),
  member: z.string().min(1).max(100),
  role: z.string().min(1).max(100),
  dryRun: z.boolean().optional(),
  idempotencyKey: z.string().min(1),
});

/**
 * The loose wire shapes registered with the MCP server. Deliberately without
 * refinements: the strict schema above stays the single boundary.
 */
export const grantRoleParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  member: z
    .string()
    .describe('Member to grant the role to, as an id or a username, display name or nickname.'),
  role: z
    .string()
    .describe(
      'Role to grant, as an id or a name. Must already be on the bot\u2019s role allowlist.',
    ),
  dryRun: z.boolean().optional().describe('Record without changing: nobody gains the role.'),
  idempotencyKey: z
    .string()
    .describe('Caller-supplied key for this grant; reuse the same value if you retry this call.'),
};

export const removeRoleParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  member: z
    .string()
    .describe('Member to remove the role from, as an id or a username, display name or nickname.'),
  role: z
    .string()
    .describe(
      'Role to remove, as an id or a name. Must already be on the bot\u2019s role allowlist.',
    ),
  dryRun: z.boolean().optional().describe('Record without changing: nobody loses the role.'),
  idempotencyKey: z
    .string()
    .describe('Caller-supplied key for this removal; reuse the same value if you retry this call.'),
};

/** Which tool is rendering, for the verbs below. */
type RoleWriteKind = 'grant' | 'remove';

const refuse = (): RoleWriteOutcomeText => ({ ok: false, message: GUILD_REFUSAL_MESSAGE });

const refuseInvalidArgs = (): RoleWriteOutcomeText => ({
  ok: false,
  message: INVALID_ARGUMENTS_MESSAGE,
});

/**
 * A member ref to a snowflake id, through `search_members`' matching
 * (`members.ts`): a well-formed id looks the member up directly, anything
 * else matches exactly (case-insensitively) against username, display name
 * and nickname. A path-traversal string is neither, so it refuses here — the
 * daemon port is never called.
 */
const resolveMemberRef = (
  members: readonly McpMemberProfile[],
  ref: string,
):
  { readonly ok: true; readonly id: string } | { readonly ok: false; readonly message: string } => {
  const query = ref.trim();
  if (isSnowflake(query)) {
    const found = members.find((member) => member.id === query);
    return found === undefined
      ? {
          ok: false,
          message: `No member ${query} in this guild. Pass a member id, or pick one with \`search_members\`.`,
        }
      : { ok: true, id: found.id };
  }
  const needle = normalizeRef(query, '@');
  const matches = members.filter(
    (member) =>
      member.username.toLowerCase() === needle ||
      member.displayName.toLowerCase() === needle ||
      (member.nickname !== undefined && member.nickname.toLowerCase() === needle),
  );
  if (matches.length === 0) {
    return {
      ok: false,
      message: `No member named "${safeName(query)}" in this guild. Pass a member id, or pick one with \`search_members\`.`,
    };
  }
  if (matches.length === 1) {
    const only = matches[0];
    if (only === undefined) throw new Error('unreachable');
    return { ok: true, id: only.id };
  }
  const list = matches
    .slice(0, 10)
    .map((member) => `${safeName(member.displayName)} (${member.id})`)
    .join(', ');
  return {
    ok: false,
    message: `"${safeName(query)}" matches ${String(matches.length)} members: ${list}. Pass an id.`,
  };
};

/**
 * Every refusal renders distinctly and actionably: the operator reading it
 * knows what stopped the change and what to do next. No two reasons share a
 * string (pinned by test). `memberRef` / `roleRef` are the caller's own refs
 * (an id or a name); `detail` is the daemon's machine reason or id.
 */
const refusalText = (
  kind: RoleWriteKind,
  guildId: GuildId,
  memberRef: string,
  roleRef: string,
  reason: McpRoleWriteRefusal,
  detail: string | undefined,
): string => {
  const changed = kind === 'grant' ? 'granted' : 'removed';
  switch (reason) {
    case 'unknown-member':
      return (
        `Member ${detail ?? memberRef} is not in guild ${guildId}, ` +
        `so no role was ${changed}. Pass a member id, or pick one with \`search_members\`.`
      );
    case 'unknown-role':
      return (
        `Role ${detail ?? roleRef} does not exist in guild ${guildId}, ` +
        `so no role was ${changed}. Check the id or name with \`list_roles\`.`
      );
    case 'role-not-allowlisted':
      return (
        `Role ${roleRef} in guild ${guildId} is not on the bot's role allowlist; ` +
        `an operator must allowlist it before this tool can change it, so no role was ${changed}.`
      );
    case 'role-not-permitted':
      // The daemon's grant-policy reason, named the way the policy names it.
      switch (detail) {
        case 'above-bot':
          return (
            `Role ${roleRef} in guild ${guildId} sits above the bot's highest role, ` +
            `so the grant policy refuses it and no role was ${changed}. ` +
            'An operator must move it below the bot first.'
          );
        case 'managed-or-everyone':
          return (
            `Role ${roleRef} in guild ${guildId} is managed by an integration (or is @everyone), ` +
            `so the grant policy refuses it and no role was ${changed}. ` +
            'Managed roles are never changed through this tool.'
          );
        case 'dangerous':
          return (
            `Role ${roleRef} in guild ${guildId} carries a dangerous permission, ` +
            `so the floor refuses it and no role was ${changed}.`
          );
        case 'not-allowlisted':
          return (
            `Role ${roleRef} in guild ${guildId} is not on the MCP grant allowlist, ` +
            `so the grant policy refuses it and no role was ${changed}. ` +
            'An operator must allow it for MCP grants first.'
          );
        default:
          return (
            `Role ${roleRef} in guild ${guildId} does not pass the MCP grant policy` +
            `${detail !== undefined ? ` (${detail})` : ''}, so no role was ${changed}.`
          );
      }
    case 'protected-target':
      if (detail === 'guild-owner') {
        return (
          `Member ${memberRef} is the guild owner of guild ${guildId}, ` +
          `so no role was ${changed}. The bot never changes the owner's roles.`
        );
      }
      return (
        `Member ${memberRef} or role ${roleRef} in guild ${guildId} is protected, ` +
        `so no role was ${changed}.`
      );
    case 'unauthorized':
      return (
        `This account lacks the roles.mutate capability in guild ${guildId}, ` +
        `so no role was ${changed}. An operator must grant it first.`
      );
    case 'killswitch':
      return (
        `The kill switch is on for guild ${guildId}, so no role was ${changed}. ` +
        'Role changes stay paused until an operator turns it off; do not retry in a loop.'
      );
    case 'breaker-open':
      return (
        `The circuit breaker is open for guild ${guildId} after repeated Discord faults, ` +
        `so no role was ${changed}. Wait for an operator to clear it; do not retry in a loop.`
      );
    case 'rate-cap':
      return (
        `Guild ${guildId} has used its rolling-hour member-role budget (setting mcp.cap.member_role) ` +
        `for role changes, so no role was ${changed}. Wait for the window to pass before retrying` +
        `${detail !== undefined ? ` (resets at ${detail})` : ''}; ` +
        'answering an already-recorded idempotency key still works meanwhile.'
      );
    case 'duplicate-key-different-content':
      return (
        `That idempotency key was already used for a different write in guild ${guildId}, ` +
        'so nothing new was changed. To change this role, retry with a fresh key; ' +
        'the earlier write under the old key is unaffected.'
      );
  }
};

const renderOutcome = (
  kind: RoleWriteKind,
  guildId: GuildId,
  memberRef: string,
  roleRef: string,
  outcome: McpRoleWriteOutcome,
): RoleWriteOutcomeText => {
  switch (outcome.status) {
    case 'done': {
      if (outcome.alreadyHad) {
        return {
          ok: true,
          text:
            kind === 'grant'
              ? `Member ${memberRef} in guild ${guildId} already had role ${roleRef}: ` +
                `nothing changed (action ${outcome.actionId}).`
              : `Member ${memberRef} in guild ${guildId} did not have role ${roleRef}: ` +
                `nothing changed (action ${outcome.actionId}).`,
        };
      }
      return {
        ok: true,
        text:
          kind === 'grant'
            ? `Granted role ${roleRef} to member ${memberRef} ` +
              `in guild ${guildId} (action ${outcome.actionId}).`
            : `Removed role ${roleRef} from member ${memberRef} ` +
              `in guild ${guildId} (action ${outcome.actionId}).`,
      };
    }
    case 'dry-run':
      return {
        ok: true,
        text:
          `Dry run is on for guild ${guildId}: ` +
          `nothing changed for member ${memberRef} (role ${roleRef}). The change was recorded ` +
          `as action ${outcome.actionId} under its idempotency key but no Discord call was made.`,
      };
    case 'replayed':
      return {
        ok: true,
        text:
          `Already recorded under this idempotency key as action ${outcome.actionId}: ` +
          `nothing new was changed for member ${memberRef} (role ${roleRef}).`,
      };
    case 'refused':
      return {
        ok: false,
        message: refusalText(kind, guildId, memberRef, roleRef, outcome.reason, outcome.detail),
      };
    case 'failed':
      return {
        ok: false,
        message:
          `The Discord call for member ${memberRef} (role ${roleRef}) ` +
          `in guild ${guildId} failed with an unknown result: the role ` +
          `may or may not have changed. Check the member before retrying, ` +
          'and retry with the same idempotency key — never a fresh one.',
      };
  }
};

const roleWriteInner = async (
  kind: RoleWriteKind,
  principal: McpPrincipal,
  port: McpRoleWritesPort,
  guild: McpGuildPort,
  members: McpMembersPort,
  rawArgs: unknown,
): Promise<RoleWriteOutcomeText> => {
  const parsed = roleWriteArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  const input = parsed.data;
  const gate = requireReachableGuild(principal, input.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const guildId = gate.guildId;
  const resolvedMember = resolveMemberRef(
    (await members.listAllMembers(guildId)).members,
    input.member,
  );
  if (!resolvedMember.ok) return { ok: false, message: resolvedMember.message };
  const resolvedRole = resolveRoleRef(guild.listRoles(guildId), input.role);
  if (!resolvedRole.ok) return { ok: false, message: resolvedRole.message };
  const call = kind === 'grant' ? port.grant : port.remove;
  const outcome = await call(guildId, {
    memberId: resolvedMember.id,
    roleId: resolvedRole.id,
    dryRun: input.dryRun ?? false,
    idempotencyKey: input.idempotencyKey,
  });
  return renderOutcome(kind, guildId, input.member, input.role, outcome);
};

/**
 * Never throws and never rejects: a malformed argument is the
 * argument-fault message, and anything unexpected (a port fault, which
 * cannot carry member content outward from here — the renderings name ids
 * and the caller's own refs only) is the shared refusal rather than an
 * exception out of the handler. The two messages are deliberately different
 * (ruling M4-D18).
 */
export const grantRoleText = async (
  principal: McpPrincipal,
  port: McpRoleWritesPort,
  guild: McpGuildPort,
  members: McpMembersPort,
  rawArgs: unknown,
): Promise<RoleWriteOutcomeText> => {
  try {
    return await roleWriteInner('grant', principal, port, guild, members, rawArgs);
  } catch {
    return refuse();
  }
};

export const removeRoleText = async (
  principal: McpPrincipal,
  port: McpRoleWritesPort,
  guild: McpGuildPort,
  members: McpMembersPort,
  rawArgs: unknown,
): Promise<RoleWriteOutcomeText> => {
  try {
    return await roleWriteInner('remove', principal, port, guild, members, rawArgs);
  } catch {
    return refuse();
  }
};
