import { z } from 'zod';
import { snowflakeIdSchema } from '../../ids.js';
import {
  defineCommand,
  type OpsContext,
  type OpsWriteResult,
} from '../dispatch.js';

/**
 * The `mcp role-policy` / `mcp allow-role` / `mcp disallow-role` surface
 * (slice 5 task 6, ADR 0117 §2).
 *
 * The same shape `mcp-allowlist.ts` established: guild-scoped throughout
 * (these read `ctx.ports`, not `ctx.instance`), write commands return audit
 * records, and usage answers ("already allowed", "no such role", the three
 * never-allowlistable refusals) are data, not faults.
 *
 * Ids and purposes only — no role names in audit rows, data, or logs. The
 * dashboard resolves names from its live role list instead.
 *
 * `mcp role-policy` is `write: true` even though its no-flag form changes
 * nothing: the flag form writes, and one command has one write bit. The
 * no-flag form still audits what it showed, the way `mcp allow-channel`
 * audits its usage answers.
 *
 * The `accountId` an allow write records is the operator's claim
 * (`ctx.actor.unixUserClaimed`), the same claim-not-identity `account grant`
 * records as `grantedBy`: the CLI has no verified account to put there (ADR
 * 0024 amendment 2), and `'operator_cli'` when the socket did not name one.
 */

const iso = (ms: number): string => new Date(ms).toISOString();

const modeSchema = z.enum(['below-bot', 'allowlist']);
const purposeSchema = z.enum(['grant', 'ping']);

// --- mcp role-policy ---------------------------------------------------------

const rolePolicyArgs = z.object({
  grant: modeSchema.optional(),
  ping: modeSchema.optional(),
});

export const mcpRolePolicyCommand = defineCommand<z.infer<typeof rolePolicyArgs>>({
  name: 'mcp role-policy',
  write: true,
  summary: 'show or change which roles the MCP connector may grant or ping',
  flags: [
    { name: 'grant', kind: 'string', describe: 'below-bot | allowlist — how grantable roles pass' },
    { name: 'ping', kind: 'string', describe: 'below-bot | allowlist — how pingable roles pass' },
  ],
  args: rolePolicyArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    if (args.grant === undefined && args.ping === undefined) {
      const policy = ctx.ports.readRolePolicy();
      const rows = ctx.ports.listRoleAllowlist();
      const lines = [
        `grant mode: ${policy.grantMode}`,
        `ping mode: ${policy.pingMode}`,
        ...(rows.length === 0
          ? ['no roles allowlisted']
          : rows.map(
              (row) =>
                `${row.roleId}  ${row.purpose}  allowed by ${row.addedByAccountId}  ${iso(row.addedAt)}`,
            )),
      ];
      return {
        text: lines.join('\n'),
        data: {
          grantMode: policy.grantMode,
          pingMode: policy.pingMode,
          entries: rows.map((row) => ({
            roleId: row.roleId,
            purpose: row.purpose,
            addedByAccountId: row.addedByAccountId,
            addedAt: row.addedAt,
          })),
        },
        audit: {
          action: 'mcp.role_policy.read',
          subjectType: 'mcp_role_policy',
          after: { grantMode: policy.grantMode, pingMode: policy.pingMode },
        },
      };
    }

    const { before, after } = ctx.ports.setRolePolicy({
      ...(args.grant !== undefined && { grantMode: args.grant }),
      ...(args.ping !== undefined && { pingMode: args.ping }),
    });
    const changed = before.grantMode !== after.grantMode || before.pingMode !== after.pingMode;
    return {
      text: changed
        ? `role policy is now grant=${after.grantMode} ping=${after.pingMode}`
        : `role policy is already grant=${after.grantMode} ping=${after.pingMode}; nothing changed`,
      data: { before, after, changed },
      audit: {
        action: 'mcp.role_policy.updated',
        subjectType: 'mcp_role_policy',
        before,
        after: { ...after, changed },
      },
    };
  },
});

// --- mcp allow-role ----------------------------------------------------------

const allowRoleArgs = z.object({ roleId: snowflakeIdSchema, purpose: purposeSchema });

export const mcpAllowRoleCommand = defineCommand<z.infer<typeof allowRoleArgs>>({
  name: 'mcp allow-role',
  write: true,
  summary: 'allowlist a role for MCP grants or pings in this guild',
  positional: [{ name: 'roleId', required: true, describe: 'the role to allowlist' }],
  flags: [
    {
      name: 'purpose',
      kind: 'string',
      describe:
        'grant | ping — a role above the bot may still be allowlisted; hierarchy is checked at use time',
    },
  ],
  args: allowRoleArgs,

  async run(ctx: OpsContext, args): Promise<OpsWriteResult> {
    const outcome = await ctx.ports.allowRole({
      roleId: args.roleId,
      purpose: args.purpose,
      accountId: ctx.actor.unixUserClaimed ?? 'operator_cli',
    });
    const base = { roleId: args.roleId, purpose: args.purpose };

    if (outcome === 'no-such-role') {
      return {
        text: `role ${args.roleId} is not a role of this guild; nothing changed`,
        data: { ok: false, reason: outcome, ...base },
        audit: {
          action: 'mcp.role_allowlist.allowed',
          subjectType: 'mcp_role_allowlist',
          subjectId: args.roleId,
          after: { outcome, ...base },
        },
      };
    }

    if (outcome === 'everyone') {
      return {
        text: `role ${args.roleId} is @everyone, which can never be allowlisted; nothing changed`,
        data: { ok: false, reason: outcome, ...base },
        audit: {
          action: 'mcp.role_allowlist.allowed',
          subjectType: 'mcp_role_allowlist',
          subjectId: args.roleId,
          after: { outcome, ...base },
        },
      };
    }

    if (outcome === 'managed') {
      return {
        text: `role ${args.roleId} is managed by an integration and can never be allowlisted; nothing changed`,
        data: { ok: false, reason: outcome, ...base },
        audit: {
          action: 'mcp.role_allowlist.allowed',
          subjectType: 'mcp_role_allowlist',
          subjectId: args.roleId,
          after: { outcome, ...base },
        },
      };
    }

    if (outcome === 'dangerous') {
      return {
        text: `role ${args.roleId} holds a dangerous permission (ADR 0117 floor) and can never be allowlisted; nothing changed`,
        data: { ok: false, reason: outcome, ...base },
        audit: {
          action: 'mcp.role_allowlist.allowed',
          subjectType: 'mcp_role_allowlist',
          subjectId: args.roleId,
          after: { outcome, ...base },
        },
      };
    }

    if (outcome === 'already-allowed') {
      return {
        text: `role ${args.roleId} is already allowlisted for ${args.purpose}; nothing changed`,
        data: { ...base, allowed: true, changed: false },
        audit: {
          action: 'mcp.role_allowlist.allowed',
          subjectType: 'mcp_role_allowlist',
          subjectId: args.roleId,
          before: { allowed: true },
          after: { allowed: true, changed: false, ...base },
        },
      };
    }

    return {
      text: `role ${args.roleId} may now be ${args.purpose === 'grant' ? 'granted' : 'pinged'} by the MCP connector`,
      data: { ...base, allowed: true, changed: true },
      audit: {
        action: 'mcp.role_allowlist.allowed',
        subjectType: 'mcp_role_allowlist',
        subjectId: args.roleId,
        before: { allowed: false },
        after: { allowed: true, changed: true, ...base },
      },
    };
  },
});

// --- mcp disallow-role -------------------------------------------------------

const disallowRoleArgs = z.object({ roleId: snowflakeIdSchema, purpose: purposeSchema });

export const mcpDisallowRoleCommand = defineCommand<z.infer<typeof disallowRoleArgs>>({
  name: 'mcp disallow-role',
  write: true,
  summary: "remove a role from this guild's MCP allowlist for a purpose",
  positional: [{ name: 'roleId', required: true, describe: 'the role to remove' }],
  flags: [{ name: 'purpose', kind: 'string', describe: 'grant | ping' }],
  args: disallowRoleArgs,

  run(ctx: OpsContext, args): OpsWriteResult {
    const outcome = ctx.ports.disallowRole({ roleId: args.roleId, purpose: args.purpose });
    const base = { roleId: args.roleId, purpose: args.purpose };

    if (outcome === 'not-allowed') {
      return {
        text: `role ${args.roleId} was not allowlisted for ${args.purpose}; nothing changed`,
        data: { ...base, allowed: false, changed: false },
        audit: {
          action: 'mcp.role_allowlist.disallowed',
          subjectType: 'mcp_role_allowlist',
          subjectId: args.roleId,
          before: { allowed: false },
          after: { allowed: false, changed: false, ...base },
        },
      };
    }

    return {
      text: `role ${args.roleId} is no longer allowlisted for ${args.purpose}`,
      data: { ...base, allowed: false, changed: true },
      audit: {
        action: 'mcp.role_allowlist.disallowed',
        subjectType: 'mcp_role_allowlist',
        subjectId: args.roleId,
        before: { allowed: true },
        after: { allowed: false, changed: true, ...base },
      },
    };
  },
});
