import { z } from 'zod';
import type { GuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';

/**
 * The two role-admin tools, registered under the roles scope: creating a
 * plain role and editing one's name, color or mentionable.
 *
 * The same five steps as `send_message` in `send.ts` — Zod parse →
 * `requireReachableGuild` → port call → render — so hard rule 3 holds by
 * construction, and the same two-message contract (ruling M4-D18): a parse
 * failure is the argument-fault message, a guild the caller cannot reach or
 * a throw out of the port is the shared refusal. No tool here throws.
 * Refusal texts are distinct, actionable and name role ids only — never role
 * names — as in `packages/mcp/src/tools/send.ts`.
 *
 * This module holds no allowlist handle of any kind: the daemon owns the
 * grant-policy check, the dangerous-permission floor, the `roles.mutate`
 * authorization and the ledger, and this package's port projects its outcomes
 * field by field. There is deliberately no permissions parameter anywhere —
 * the schemas are `.strict()`, so a `permissions` key is an argument fault
 * before the guild gate (review focus 6) — and a created role always lands
 * with permissions `"0"`, which only the daemon can assert.
 *
 * Both writes go through `runMcpAction` on the daemon side with kinds
 * `role.create` / `role.edit` in cap group `structure`: no tool or port calls
 * a Discord role-write method any other way.
 */

/** A Discord role name is capped at 100 characters. */
export const ROLE_NAME_MAX = 100;
/** A Discord role color is a 24-bit integer. */
export const ROLE_COLOR_MAX = 0xff_ff_ff;

export const CREATE_ROLE_TOOL_NAME = 'create_role';
export const CREATE_ROLE_TOOL_DESCRIPTION =
  'Creates a role with no permissions in this guild, placed directly below the bot\u2019s highest role. ' +
  'Takes a name up to 100 characters, with an optional color, hoist and mentionable flag. ' +
  'The new role is not on the bot\u2019s role allowlist, so an operator must allowlist it before the MCP can grant it. ' +
  'A creation cannot be undone. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without creating.';

export const EDIT_ROLE_TOOL_NAME = 'edit_role';
export const EDIT_ROLE_TOOL_DESCRIPTION =
  'Edits a role\u2019s name, color or mentionable flag in this guild, by id or name. ' +
  'Only roles already on the bot\u2019s role allowlist that pass the MCP grant policy ' +
  '(below the bot, not managed, not @everyone, without dangerous permissions) can be edited, ' +
  'and the previous values are kept for undo. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call. ' +
  'Pass dryRun to record without editing.';

/** What the daemon's role-admin wiring must satisfy (slice 4, Task 5 implements it). */
export interface McpRoleAdminPort {
  readonly createRole: (
    guildId: GuildId,
    input: {
      readonly name: string;
      readonly color: number | undefined;
      readonly hoist: boolean | undefined;
      readonly mentionable: boolean | undefined;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpRoleAdminOutcome>;
  readonly editRole: (
    guildId: GuildId,
    input: {
      /** The role to edit, as an id or a name; the daemon resolves it live. */
      readonly role: string;
      readonly name: string | undefined;
      readonly color: number | undefined;
      readonly mentionable: boolean | undefined;
      readonly dryRun: boolean;
      readonly idempotencyKey: string;
    },
  ) => Promise<McpRoleAdminOutcome>;
}

/** Mirrors the daemon's outcomes, named in this package's own vocabulary. */
export type McpRoleAdminOutcome =
  | { readonly status: 'done'; readonly actionId: string; readonly roleId: string }
  | { readonly status: 'dry-run'; readonly actionId: string; readonly roleId?: string | undefined }
  | { readonly status: 'replayed'; readonly actionId: string; readonly roleId?: string | undefined }
  | { readonly status: 'refused'; readonly reason: McpRoleAdminRefusal; readonly detail?: string }
  | { readonly status: 'failed'; readonly roleId?: string | undefined };

export type McpRoleAdminRefusal =
  | 'unknown-role'
  | 'ambiguous-role'
  | 'role-not-allowlisted'
  | 'role-not-permitted'
  | 'unauthorized'
  | 'killswitch'
  | 'breaker-open'
  | 'rate-cap'
  | 'duplicate-key-different-content'
  | 'duplicate-content-recently';

export type RoleAdminOutcomeText =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

const colorSchema = z.number().int().min(0).max(ROLE_COLOR_MAX);

/**
 * Zod schemas are the boundary (hard rule 3): a parse failure is the
 * argument-fault message, never a throw, and the parse runs before the guild
 * gate. `guildId` is a bare string on purpose, like `send.ts`: the gate
 * parses it and refuses malformed and unreachable identically. Both schemas
 * are `.strict()`, so a `permissions` key — or any other unknown key — is an
 * argument fault here, before anything is consulted or recorded.
 */
const createArgsSchema = z
  .object({
    guildId: z.string(),
    name: z.string().min(1).max(ROLE_NAME_MAX),
    color: colorSchema.optional(),
    hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    idempotencyKey: z.string().min(1),
  })
  .strict();

const editArgsSchema = z
  .object({
    guildId: z.string(),
    role: z.string().min(1),
    name: z.string().min(1).max(ROLE_NAME_MAX).optional(),
    color: colorSchema.optional(),
    mentionable: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    idempotencyKey: z.string().min(1),
  })
  .strict()
  .refine(
    (args) => args.name !== undefined || args.color !== undefined || args.mentionable !== undefined,
    { message: 'name, color or mentionable required' },
  );

/**
 * The loose wire shapes registered with the MCP server. Deliberately without
 * refinements or strictness, like `sendMessageParams`: these document the
 * wire types for clients while the strict schemas above stay the single
 * boundary.
 */
export const createRoleParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  name: z.string().describe(`Role name, 1 to ${String(ROLE_NAME_MAX)} characters.`),
  color: z.number().optional().describe('Role color as an integer, 0 to 16777215.'),
  hoist: z.boolean().optional().describe('Whether the role shows separately in the member list.'),
  mentionable: z.boolean().optional().describe('Whether anyone may mention the role.'),
  dryRun: z.boolean().optional().describe('Record without creating: nothing reaches Discord.'),
  idempotencyKey: z
    .string()
    .describe(
      'Caller-supplied key for this creation; reuse the same value if you retry this call.',
    ),
};

export const editRoleParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  role: z.string().describe('Role to edit, as an id or the exact name shown by list_roles.'),
  name: z
    .string()
    .optional()
    .describe(`New name, 1 to ${String(ROLE_NAME_MAX)} characters.`),
  color: z.number().optional().describe('New color as an integer, 0 to 16777215.'),
  mentionable: z.boolean().optional().describe('New mentionable flag.'),
  dryRun: z.boolean().optional().describe('Record without editing: nothing reaches Discord.'),
  idempotencyKey: z
    .string()
    .describe('Caller-supplied key for this edit; reuse the same value if you retry this call.'),
};

/** Which tool is rendering, for the verbs below. */
type RoleAdminKind = 'create' | 'edit';

const refuse = (): RoleAdminOutcomeText => ({ ok: false, message: GUILD_REFUSAL_MESSAGE });

const refuseInvalidArgs = (): RoleAdminOutcomeText => ({
  ok: false,
  message: INVALID_ARGUMENTS_MESSAGE,
});

/**
 * Every refusal renders distinctly and actionably: the operator reading it
 * knows what stopped the write and what to do next. No two reasons share a
 * string (pinned by test). `roleRef` is the caller's own ref (an id or a
 * name, like `grant_role`'s renderer): the daemon resolves it to an id
 * before refusing, and the one refusal that cannot name even the ref
 * (`unknown-role`) names no ref at all.
 */
const refusalText = (
  kind: RoleAdminKind,
  guildId: GuildId,
  roleRef: string | undefined,
  reason: McpRoleAdminRefusal,
  detail?: string,
): string => {
  const created = kind === 'create' ? 'no role was created' : 'nothing was edited';
  const id = roleRef ?? 'that role';
  switch (reason) {
    case 'unknown-role':
      return (
        `That role is not in guild ${guildId}, so ${created}. ` +
        'Pass a role id or the exact name shown by `list_roles`.'
      );
    case 'ambiguous-role':
      return (
        `That reference matches several roles in guild ${guildId}` +
        `${detail !== undefined ? ` (${detail})` : ''}, so ${created}. ` +
        'Pass one role id instead of a name.'
      );
    case 'role-not-allowlisted':
      // The bot's role allowlist (`managed_roles`), the same refusal
      // `grant_role` gives: the role id is the daemon-resolved id in `detail`.
      return (
        `Role ${detail ?? id} in guild ${guildId} is not on the bot's role allowlist, ` +
        `so ${created}. An operator must allowlist it before the MCP can change it.`
      );
    case 'role-not-permitted': {
      // The daemon's grant-policy reason, named the way the policy names it —
      // the same vocabulary `grant_role` renders.
      let cause: string;
      switch (detail) {
        case 'above-bot':
          cause =
            'sits above the bot\u2019s highest role, so the grant policy refuses it. ' +
            'An operator must move it below the bot first';
          break;
        case 'managed-or-everyone':
          cause =
            'is managed by an integration (or is @everyone), so the grant policy refuses it. ' +
            'Managed roles are never changed through this tool';
          break;
        case 'dangerous':
          cause =
            'carries a dangerous permission, so the floor refuses it. ' +
            'The MCP never touches a role that could escalate its holder';
          break;
        case 'not-allowlisted':
          cause =
            'is not on the MCP grant allowlist, so the grant policy refuses it. ' +
            'An operator must allow it for MCP grants first';
          break;
        default:
          cause =
            `does not pass the MCP grant policy` +
            `${detail !== undefined ? ` (${detail})` : ''}, so the grant policy refuses it. ` +
            'An operator must fix the role first';
          break;
      }
      return `Role ${id} in guild ${guildId} ${cause}, so ${created}.`;
    }
    case 'unauthorized':
      return (
        `This account lacks roles.mutate in guild ${guildId}, so ${created}. ` +
        'An operator who can edit authorization can grant it, then retry this call.'
      );
    case 'killswitch':
      return (
        `The kill switch is on for guild ${guildId}, so ${created}. ` +
        'Role changes stay paused until an operator turns it off; do not retry in a loop.'
      );
    case 'breaker-open':
      return (
        `The circuit breaker is open for guild ${guildId} after repeated Discord faults, ` +
        `so ${created}. Wait for an operator to clear it; do not retry in a loop.`
      );
    case 'rate-cap':
      return (
        `Guild ${guildId} has used its rolling-hour structure budget (setting mcp.cap.structure) ` +
        `for role, thread and panel changes, so ${created}. Wait for the window to pass before retrying` +
        `${detail !== undefined ? ` (resets at ${detail})` : ''}; ` +
        'answering an already-recorded idempotency key still works meanwhile.'
      );
    case 'duplicate-key-different-content':
      return (
        `That idempotency key was already used for a different write in guild ${guildId}, ` +
        (kind === 'create'
          ? 'so nothing new was created. To create this, retry with a fresh key; '
          : 'so nothing was changed. To edit this, retry with a fresh key; ') +
        'the earlier write under the old key is unaffected.'
      );
    case 'duplicate-content-recently':
      return (
        `The same write already ran in guild ${guildId} within the last minute, ` +
        (kind === 'create'
          ? 'so nothing new was created. Wait a minute, then retry with a fresh key.'
          : 'so nothing was changed. Wait a minute, then retry with a fresh key.')
      );
  }
};

const renderDone = (
  kind: RoleAdminKind,
  guildId: GuildId,
  outcome: Extract<McpRoleAdminOutcome, { status: 'done' }>,
): RoleAdminOutcomeText => {
  if (kind === 'create') {
    return {
      ok: true,
      text:
        `Created role ${outcome.roleId} in guild ${guildId} with no permissions ` +
        `(action ${outcome.actionId}). It is not on the bot\u2019s role allowlist, ` +
        'so an operator must allowlist it before the MCP can grant it to anyone. ' +
        'A creation cannot be undone.',
    };
  }
  return {
    ok: true,
    text:
      `Edited role ${outcome.roleId} in guild ${guildId} ` +
      `(action ${outcome.actionId}). The previous values were kept for undo.`,
  };
};

/**
 * Refused outcomes that name a role id carry it in `detail` (the daemon
 * resolves the caller's ref to an id before refusing, except for
 * `unknown-role` and `ambiguous-role`, which have no single id). The
 * grant-policy refusal instead carries the policy cause in `detail`, so the
 * renderer names the caller's own ref there — the same precedent as
 * `grant_role`'s renderer, which speaks the caller's refs throughout.
 */
const renderRefused = (
  kind: RoleAdminKind,
  guildId: GuildId,
  roleRef: string | undefined,
  outcome: Extract<McpRoleAdminOutcome, { status: 'refused' }>,
): RoleAdminOutcomeText => {
  if (outcome.reason === 'role-not-allowlisted') {
    return {
      ok: false,
      message: refusalText(kind, guildId, outcome.detail ?? roleRef, outcome.reason, undefined),
    };
  }
  if (outcome.reason === 'role-not-permitted') {
    return {
      ok: false,
      message: refusalText(kind, guildId, roleRef, outcome.reason, outcome.detail),
    };
  }
  return {
    ok: false,
    message: refusalText(
      kind,
      guildId,
      undefined,
      outcome.reason,
      outcome.reason === 'ambiguous-role' ? outcome.detail : undefined,
    ),
  };
};

const renderOutcome = (
  kind: RoleAdminKind,
  guildId: GuildId,
  roleRef: string | undefined,
  outcome: McpRoleAdminOutcome,
): RoleAdminOutcomeText => {
  switch (outcome.status) {
    case 'done':
      return renderDone(kind, guildId, outcome);
    case 'dry-run':
      return {
        ok: true,
        text:
          `Dry run is on for guild ${guildId}: ` +
          (kind === 'create'
            ? 'no role was created. '
            : `nothing was changed on role ${outcome.roleId ?? 'that role'}. `) +
          `The write was recorded as action ${outcome.actionId} under its idempotency key ` +
          'but no Discord call was made.',
      };
    case 'replayed':
      // Not a failure: the write is already handled under this key and
      // nothing new changed — ok:true, no failure language. A creation
      // replay cannot name the role: the ledger row holds no role id by
      // design (only an edit's undo row does), so it points at list_roles.
      return kind === 'create'
        ? {
            ok: true,
            text:
              `Already recorded under this idempotency key as action ${outcome.actionId}: ` +
              `nothing new was created in guild ${guildId}. ` +
              'This answer does not name the created role: find it with `list_roles`.',
          }
        : {
            ok: true,
            text:
              `Already recorded under this idempotency key as action ${outcome.actionId}: ` +
              `nothing new was changed on role ${outcome.roleId ?? 'that role'}.`,
          };
    case 'refused':
      return renderRefused(kind, guildId, roleRef, outcome);
    case 'failed':
      // The Discord call failed with an unknown result: Discord may have
      // applied the write and the response been lost, so this must not claim
      // nothing changed — nobody knows that. Check-then-retry with the same
      // key, never a fresh one. When the create got far enough to mint the
      // role before failing, the text names the created role id.
      return {
        ok: false,
        message:
          kind === 'create'
            ? `The Discord call creating a role in guild ${guildId} failed with an unknown result: ` +
              'the role may or may not have been created. ' +
              (outcome.roleId !== undefined
                ? `A role ${outcome.roleId} was created before the failure — check \`list_roles\` for it before retrying. `
                : 'Check `list_roles` before retrying. ') +
              'Retry with the same idempotency key — never a fresh one.'
            : `The Discord call editing a role in guild ${guildId} failed with an unknown result: ` +
              'the role may or may not have been changed. Check `list_roles` before retrying, ' +
              'and retry with the same idempotency key — never a fresh one.',
      };
  }
};

/**
 * Never throws and never rejects: a malformed argument is the
 * argument-fault message, and anything unexpected (a port fault) is the
 * shared refusal rather than an exception out of the handler. The two
 * messages are deliberately different (ruling M4-D18).
 */
export const createRoleText = async (
  principal: McpPrincipal,
  port: McpRoleAdminPort,
  rawArgs: unknown,
): Promise<RoleAdminOutcomeText> => {
  try {
    const parsed = createArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return refuseInvalidArgs();
    const input = parsed.data;
    // M8, like `send.ts`: trim before anything else, so a whitespace-only
    // name never claims a ledger row. The created name is the trimmed
    // string, so the hash, the ledger and the REST call agree.
    const name = input.name.trim();
    if (name === '') return refuseInvalidArgs();
    const gate = requireReachableGuild(principal, input.guildId);
    if (!gate.ok) return { ok: false, message: gate.message };
    const outcome = await port.createRole(gate.guildId, {
      name,
      color: input.color,
      hoist: input.hoist,
      mentionable: input.mentionable,
      dryRun: input.dryRun ?? false,
      idempotencyKey: input.idempotencyKey,
    });
    // A creation names no role ref on refusal: the name the caller typed must
    // never be echoed back (it is member content), and the daemon never got
    // far enough to resolve one.
    return renderOutcome('create', gate.guildId, undefined, outcome);
  } catch {
    return refuse();
  }
};

export const editRoleText = async (
  principal: McpPrincipal,
  port: McpRoleAdminPort,
  rawArgs: unknown,
): Promise<RoleAdminOutcomeText> => {
  try {
    const parsed = editArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return refuseInvalidArgs();
    const input = parsed.data;
    // The ref may be an id or a name: only blank-after-trim is rejected here.
    // A name that matches nothing refuses daemon-side as `unknown-role` —
    // this layer never interprets the ref, so a traversal-shaped string is
    // passed through untouched and refused there, never resolved as a path.
    const role = input.role.trim();
    if (role === '') return refuseInvalidArgs();
    const name = input.name === undefined ? undefined : input.name.trim();
    if (name !== undefined && name === '') return refuseInvalidArgs();
    const gate = requireReachableGuild(principal, input.guildId);
    if (!gate.ok) return { ok: false, message: gate.message };
    const outcome = await port.editRole(gate.guildId, {
      role,
      name,
      color: input.color,
      mentionable: input.mentionable,
      dryRun: input.dryRun ?? false,
      idempotencyKey: input.idempotencyKey,
    });
    // The caller's own ref, like `grant_role`'s renderer: the grant-policy
    // refusal names its cause from the daemon's detail and this ref.
    return renderOutcome('edit', gate.guildId, role, outcome);
  } catch {
    return refuse();
  }
};
