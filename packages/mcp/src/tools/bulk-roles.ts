import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';
import { idsAreWellFormed } from '../ids.js';
import { resolveRoleRef } from '../resolve.js';
import { safeName } from '../structured.js';
import type { McpGuildPort } from './guild.js';
import { MEMBER_LISTING_CAP, type McpMemberProfile, type McpMembersPort } from './members.js';

/**
 * `bulk_role_change` (slice 4, Task 4): preview → confirm → durable job.
 *
 * A first call with no `confirmToken` resolves the member set live — an
 * explicit id list, or a `{hasRoles, lacksRoles}` selector over the same
 * listing `search_members` reads — caps it at 100, and stores a preview
 * through the port. The port answers the single-use token and its expiry,
 * which this layer renders with the count and the first 20 display names. A
 * second call with the token never lists members: the daemon applies the
 * previewed set, so a selector confirm must not touch the members port at
 * all (pinned by test).
 *
 * The same five steps as `grant_role` — Zod parse → `requireReachableGuild`
 * → resolve → port call → render — so hard rule 3 holds by construction, and
 * the same two-message contract (ruling M4-D18): a parse failure is the
 * argument-fault message, a gate failure or any throw is the shared refusal.
 * No tool here throws. Refusal texts are distinct, actionable and
 * content-free (ids only) — and a confirm refusal never echoes the token,
 * which authenticates the confirm (pinned by test).
 *
 * Member and role refs resolve here, in the tool, before the port is ever
 * called: explicit member ids are snowflake-checked (a traversal string is
 * neither an id nor a name, so it faults here), and the role resolves by id
 * or name through `resolveRoleRef`. The daemon re-checks the role live
 * (unknown, allowlist, grant policy, floor) before its claim, so a role that
 * changed between preview and confirm still refuses cleanly — as a race,
 * through the same refusal vocabulary.
 */

export const BULK_ROLE_CHANGE_TOOL_NAME = 'bulk_role_change';
export const BULK_ROLE_CHANGE_TOOL_DESCRIPTION =
  'Changes one role for up to 100 members at once, in two calls. ' +
  'First call without confirmToken previews: pass action ("add" or "remove"), ' +
  'a role id or name, and either members (1-100 member ids) or a selector ' +
  '({hasRoles, lacksRoles} over role ids or names). ' +
  'The answer names the count, the first 20 members, and a single-use token ' +
  'that expires after 10 minutes. ' +
  'Second call repeats the same arguments with that confirmToken and a fresh ' +
  'idempotencyKey to run the change as one durable job; watch it with get_job. ' +
  'The role must already be on the bot\u2019s role allowlist and pass the MCP grant policy. ' +
  'Pass an idempotencyKey with every call and reuse the same value if you retry this call.';

/** At most this many members per bulk change; more refuses with the narrow-the-set text. */
export const BULK_MEMBERS_MAX = 100;
/** The preview names at most this many members; the rest count as "N more". */
export const BULK_PREVIEW_NAMES_SHOWN = 20;

/** What the daemon's bulk wiring must satisfy (slice 4 Task 4 implements it). */
export interface McpBulkRolesPort {
  readonly preview: (
    guildId: GuildId,
    input: McpBulkPreviewInput,
  ) => Promise<McpBulkPreviewOutcome>;
  readonly confirm: (
    guildId: GuildId,
    input: McpBulkConfirmInput,
  ) => Promise<McpBulkConfirmOutcome>;
}

export interface McpBulkSelector {
  readonly hasRoles: readonly string[];
  readonly lacksRoles: readonly string[];
}

export interface McpBulkPreviewInput {
  readonly action: 'add' | 'remove';
  readonly roleId: string;
  readonly memberIds: readonly string[];
  /**
   * Which member set this preview resolves: present for a selector preview
   * (resolved role ids), absent for an explicit list. The daemon hashes the
   * same form the confirm will, so a selector confirm hashes equal.
   */
  readonly selector: McpBulkSelector | undefined;
  readonly argsHash: string;
  readonly idempotencyKey: string;
  readonly dryRun: boolean;
}

export interface McpBulkConfirmInput {
  readonly action: 'add' | 'remove';
  readonly roleId: string;
  readonly memberIds: readonly string[] | undefined;
  readonly selector: McpBulkSelector | undefined;
  readonly argsHash: string;
  readonly confirmToken: string;
  readonly idempotencyKey: string;
  readonly dryRun: boolean;
}

/** Mirrors the daemon's preview outcomes, named in this package's own vocabulary. */
export type McpBulkPreviewOutcome =
  | { readonly status: 'done'; readonly token: string; readonly expiresAt: number }
  | {
      readonly status: 'refused';
      readonly reason: McpBulkPreviewRefusal;
      readonly detail?: string;
    };

export type McpBulkPreviewRefusal =
  'unknown-role' | 'role-not-allowlisted' | 'role-not-permitted' | 'too-many';

/** Mirrors the daemon's confirm outcomes, named in this package's own vocabulary. */
export type McpBulkConfirmOutcome =
  | { readonly status: 'done'; readonly actionId: string; readonly jobId: number }
  | { readonly status: 'dry-run'; readonly actionId: string }
  | { readonly status: 'replayed'; readonly actionId: string }
  | { readonly status: 'refused'; readonly reason: McpBulkConfirmRefusal; readonly detail?: string }
  | { readonly status: 'failed' };

export type McpBulkConfirmRefusal =
  | 'unknown-token'
  | 'preview-expired'
  | 'preview-used'
  | 'args-changed'
  | 'unknown-role'
  | 'role-not-allowlisted'
  | 'role-not-permitted'
  | 'unauthorized'
  | 'killswitch'
  | 'breaker-open'
  | 'rate-cap'
  | 'duplicate-key-different-content';

export type BulkRoleOutcomeText =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

/**
 * The args hash: `sha256` of the canonical JSON of `{action, roleId}` plus
 * the member set — an order-insensitive member list, or the resolved selector
 * with both role lists sorted. Preview and confirm hash the same way, so a
 * tampered argument at confirm hashes differently from the stored preview and
 * refuses as `args-changed`. The daemon recomputes this over the confirm it
 * receives and requires it to equal both the stored preview's hash and the
 * tool-supplied one.
 */
export const bulkArgsHashFor = (input: {
  readonly action: 'add' | 'remove';
  readonly roleId: string;
  readonly members?: readonly string[] | undefined;
  readonly selector?:
    { readonly hasRoles?: readonly string[]; readonly lacksRoles?: readonly string[] } | undefined;
}): string => {
  const canon = {
    action: input.action,
    roleId: input.roleId,
    ...(input.members !== undefined
      ? { members: [...input.members].sort() }
      : {
          selector: {
            hasRoles: [...(input.selector?.hasRoles ?? [])].sort(),
            lacksRoles: [...(input.selector?.lacksRoles ?? [])].sort(),
          },
        }),
  };
  return createHash('sha256').update(JSON.stringify(canon), 'utf8').digest('hex');
};

/**
 * Zod schemas are the boundary (hard rule 3): a parse failure is the
 * argument-fault message, never a throw, and the parse runs before the guild
 * gate. `guildId` is a bare string on purpose — the gate parses it and
 * refuses malformed and unreachable identically. `role` takes an id or a
 * name (resolved after the gate); `members` takes snowflakes only, checked
 * before any port call. Exactly one of `members` and `selector` is given —
 * the check below the schema refuses both-given and neither-given alike.
 */
const bulkSelectorSchema = z.object({
  hasRoles: z.array(z.string().min(1).max(100)).max(10).optional(),
  lacksRoles: z.array(z.string().min(1).max(100)).max(10).optional(),
});

const bulkArgsSchema = z.object({
  guildId: z.string(),
  action: z.enum(['add', 'remove']),
  role: z.string().min(1).max(100),
  members: z.array(z.string()).min(1).max(BULK_MEMBERS_MAX).optional(),
  selector: bulkSelectorSchema.optional(),
  confirmToken: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
  dryRun: z.boolean().optional(),
});

/**
 * The loose wire shape registered with the MCP server. Deliberately without
 * refinements: the strict schema above stays the single boundary.
 */
export const bulkRoleChangeParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  action: z.enum(['add', 'remove']).describe('Whether members gain or lose the role.'),
  role: z
    .string()
    .describe(
      'Role to change, as an id or a name. Must already be on the bot\u2019s role allowlist.',
    ),
  members: z
    .array(z.string())
    .describe('Member ids to change (1-100). Exactly one of members and selector is given.')
    .optional(),
  selector: z
    .object({
      hasRoles: z.array(z.string()).describe('Keep members holding every named role.').optional(),
      lacksRoles: z.array(z.string()).describe('Drop members holding any named role.').optional(),
    })
    .describe('Role filter over the guild listing. Exactly one of members and selector is given.')
    .optional(),
  confirmToken: z
    .string()
    .describe('The preview token from the first call. Absent means preview; present means confirm.')
    .optional(),
  idempotencyKey: z
    .string()
    .describe('Caller-supplied key for this call; reuse the same value if you retry this call.'),
  dryRun: z.boolean().optional().describe('Record without changing: no job is enqueued.'),
};

const refuse = (): BulkRoleOutcomeText => ({ ok: false, message: GUILD_REFUSAL_MESSAGE });

const refuseInvalidArgs = (): BulkRoleOutcomeText => ({
  ok: false,
  message: INVALID_ARGUMENTS_MESSAGE,
});

const memberNoun = (count: number): string =>
  count === 1 ? '1 member' : `${String(count)} members`;

/**
 * Every preview refusal renders distinctly and actionably (pinned by test).
 * `detail` is the daemon's machine reason — a role id, or a member count for
 * `too-many` — never member content.
 */
const previewRefusalText = (
  guildId: GuildId,
  roleRef: string,
  reason: McpBulkPreviewRefusal,
  detail: string | undefined,
): string => {
  switch (reason) {
    case 'unknown-role':
      return (
        `Role ${detail ?? roleRef} does not exist in guild ${guildId}, ` +
        'so no preview was stored. Check the id or name with `list_roles`.'
      );
    case 'role-not-allowlisted':
      return (
        `Role ${roleRef} in guild ${guildId} is not on the bot's role allowlist; ` +
        'an operator must allowlist it before this tool can change it, so no preview was stored.'
      );
    case 'role-not-permitted':
      return (
        `Role ${roleRef} in guild ${guildId} does not pass the MCP grant policy` +
        `${detail !== undefined ? ` (${detail})` : ''}, so no preview was stored.`
      );
    case 'too-many':
      return (
        `That set holds ${detail ?? 'more than 100'} members, ` +
        `so no preview was stored: narrow the set to ${String(BULK_MEMBERS_MAX)} or fewer and preview again.`
      );
  }
};

/**
 * Every confirm refusal renders distinctly and actionably (pinned by test).
 * The token authenticates the confirm, so it is never rendered back — and
 * `detail` may carry it (or a reset time), so no confirm refusal renders
 * `detail` at all.
 */
const confirmRefusalText = (guildId: GuildId, reason: McpBulkConfirmRefusal): string => {
  switch (reason) {
    case 'unknown-token':
      return (
        `No bulk preview matches that token in guild ${guildId}, so nothing was changed. ` +
        'Preview again without a confirm token: tokens belong to one guild and expire after 10 minutes.'
      );
    case 'preview-expired':
      return (
        `That bulk preview in guild ${guildId} expired, so nothing was changed. ` +
        'Preview again for a fresh token, which lasts 10 minutes.'
      );
    case 'preview-used':
      return (
        `That bulk preview in guild ${guildId} was already used, so nothing new was changed. ` +
        'A preview confirms at most once: preview again for a fresh token. ' +
        'Watch the earlier job with `get_job`.'
      );
    case 'args-changed':
      return (
        `Those confirm arguments do not match the preview in guild ${guildId}, so nothing was changed. ` +
        'The action, role and member set must repeat the preview exactly: preview again if the set moved.'
      );
    case 'unknown-role':
      return (
        `That role does not exist in guild ${guildId}, so nothing was changed. ` +
        'Check the id or name with `list_roles` and preview again.'
      );
    case 'role-not-allowlisted':
      return (
        `That role in guild ${guildId} is not on the bot's role allowlist; ` +
        'an operator must allowlist it before this tool can change it, so nothing was changed.'
      );
    case 'role-not-permitted':
      return `That role in guild ${guildId} does not pass the MCP grant policy, so nothing was changed.`;
    case 'unauthorized':
      return (
        `This account lacks the roles.mutate capability in guild ${guildId}, ` +
        'so nothing was changed. An operator must grant it first.'
      );
    case 'killswitch':
      return (
        `The kill switch is on for guild ${guildId}, so nothing was changed. ` +
        'Role changes stay paused until an operator turns it off; do not retry in a loop.'
      );
    case 'breaker-open':
      return (
        `The circuit breaker is open for guild ${guildId} after repeated Discord faults, ` +
        'so nothing was changed. Wait for an operator to clear it; do not retry in a loop.'
      );
    case 'rate-cap':
      return (
        `Guild ${guildId} has used its member-role budget of 1000 role changes ` +
        'per rolling hour, so nothing was changed. Wait for the window to pass before retrying; ' +
        'answering an already-recorded idempotency key still works meanwhile.'
      );
    case 'duplicate-key-different-content':
      return (
        `That idempotency key was already used for a different write in guild ${guildId}, ` +
        'so nothing new was changed. To change this set, retry with a fresh key; ' +
        'the earlier write under the old key is unaffected.'
      );
  }
};

/** The preview answer: the count, the first 20 display names, the token and its expiry. */
const renderPreview = (
  guildId: GuildId,
  action: 'add' | 'remove',
  roleRef: string,
  members: readonly { readonly id: string; readonly displayName: string }[],
  token: string,
  expiresAt: number,
): string => {
  const verb = action === 'add' ? 'gain' : 'lose';
  const shown = members.slice(0, BULK_PREVIEW_NAMES_SHOWN);
  const names = shown.map((member) => safeName(member.displayName)).join(', ');
  const rest =
    members.length > shown.length ? ` and ${String(members.length - shown.length)} more` : '';
  return (
    `Bulk preview in guild ${guildId}: ${memberNoun(members.length)} will ${verb} role ${roleRef}` +
    `${members.length === 0 ? '.' : ` (${names}${rest}).`} ` +
    `Confirm with confirmToken "${token}" before ${new Date(expiresAt).toISOString()} ` +
    'to run the change as one durable job; the token is single-use. ' +
    'Repeat the same action, role and member set with the token, or preview again.'
  );
};

const renderConfirmDone = (actionId: string, jobId: number): string =>
  `Bulk change recorded as action ${actionId}: job ${String(jobId)} is applying the previewed set. ` +
  'Watch it with `get_job`.';

const bulkRoleChangeInner = async (
  principal: McpPrincipal,
  port: McpBulkRolesPort,
  guild: McpGuildPort,
  members: McpMembersPort,
  rawArgs: unknown,
): Promise<BulkRoleOutcomeText> => {
  const parsed = bulkArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  const input = parsed.data;
  // Exactly one of `members` and `selector`: both or neither is the
  // argument fault, answered before anything is consulted.
  if ((input.members !== undefined) === (input.selector !== undefined)) {
    return refuseInvalidArgs();
  }
  const gate = requireReachableGuild(principal, input.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const guildId = gate.guildId;
  // The role resolves by id or name before any port call, exactly as
  // `grant_role` does: an unknown name refuses here with no ledger row.
  const resolvedRole = resolveRoleRef(guild.listRoles(guildId), input.role);
  if (!resolvedRole.ok) return { ok: false, message: resolvedRole.message };
  const roleId = resolvedRole.id;
  const dryRun = input.dryRun ?? false;

  if (input.confirmToken === undefined) {
    // --- Preview: resolve the member set live, through the same listing
    // `search_members` reads. An explicit list is snowflake-checked id by id
    // (a traversal string faults before any port call) and looked up for
    // names; a selector filters the listing by role.
    let resolved: readonly McpMemberProfile[];
    let previewHash: string;
    let previewSelector: McpBulkSelector | undefined;
    if (input.members !== undefined) {
      if (!idsAreWellFormed(input.members)) return refuseInvalidArgs();
      const { members: listing, truncated } = await members.listAllMembers(guildId);
      const byId = new Map(listing.map((profile) => [profile.id, profile] as const));
      const found: McpMemberProfile[] = [];
      for (const id of input.members) {
        const profile = byId.get(id);
        if (profile === undefined) {
          return {
            ok: false,
            message: truncated
              ? `Member ${id} was not found in guild ${guildId}'s member listing, which is capped at ` +
                `${MEMBER_LISTING_CAP.toLocaleString('en-US')} and was cut off, so no preview was stored. ` +
                'Check the id with `get_member`.'
              : `Member ${id} is not in guild ${guildId}, ` +
                'so no preview was stored. Pass member ids, or pick them with `search_members`.',
          };
        }
        found.push(profile);
      }
      resolved = found;
      previewHash = bulkArgsHashFor({ action: input.action, roleId, members: input.members });
      previewSelector = undefined;
    } else {
      const selector = input.selector;
      if (selector === undefined) return refuseInvalidArgs();
      const hasIds: string[] = [];
      for (const ref of selector.hasRoles ?? []) {
        const resolvedRef = resolveRoleRef(guild.listRoles(guildId), ref);
        if (!resolvedRef.ok) return { ok: false, message: resolvedRef.message };
        hasIds.push(resolvedRef.id);
      }
      const lacksIds: string[] = [];
      for (const ref of selector.lacksRoles ?? []) {
        const resolvedRef = resolveRoleRef(guild.listRoles(guildId), ref);
        if (!resolvedRef.ok) return { ok: false, message: resolvedRef.message };
        lacksIds.push(resolvedRef.id);
      }
      const { members: listing, truncated } = await members.listAllMembers(guildId);
      if (truncated) {
        // A selector over a cut-off listing would silently preview a subset
        // of the members it names: refuse rather than under-apply.
        return {
          ok: false,
          message:
            `Guild ${guildId}'s member listing is capped at ${MEMBER_LISTING_CAP.toLocaleString('en-US')} ` +
            'and was cut off, so a selector ' +
            'cannot see every member and no preview was stored. Pass explicit `members` ids instead.',
        };
      }
      resolved = listing.filter(
        (profile) =>
          hasIds.every((id) => profile.roleIds.includes(id)) &&
          !lacksIds.some((id) => profile.roleIds.includes(id)),
      );
      // The hash covers resolved ids, not the caller's refs, so a name and
      // its id hash the same — and preview and confirm hash the same way.
      previewHash = bulkArgsHashFor({
        action: input.action,
        roleId,
        selector: { hasRoles: hasIds, lacksRoles: lacksIds },
      });
      previewSelector = { hasRoles: hasIds, lacksRoles: lacksIds };
    }
    if (resolved.length > BULK_MEMBERS_MAX) {
      return {
        ok: false,
        message:
          `That set holds ${memberNoun(resolved.length)}, ` +
          `so no preview was stored: narrow the set to ${String(BULK_MEMBERS_MAX)} or fewer and preview again.`,
      };
    }
    const argsHash = previewHash;
    const outcome = await port.preview(guildId, {
      action: input.action,
      roleId,
      memberIds: resolved.map((profile) => profile.id),
      selector: previewSelector,
      argsHash,
      idempotencyKey: input.idempotencyKey,
      dryRun,
    });
    if (outcome.status === 'refused') {
      return {
        ok: false,
        message: previewRefusalText(guildId, input.role, outcome.reason, outcome.detail),
      };
    }
    return {
      ok: true,
      text: renderPreview(
        guildId,
        input.action,
        input.role,
        resolved.map((profile) => ({ id: profile.id, displayName: profile.displayName })),
        outcome.token,
        outcome.expiresAt,
      ),
    };
  }

  // --- Confirm: the previewed set is never re-resolved, so a selector
  // confirm resolves its roles (for the hash) but never lists members. The
  // hash must equal the preview's, or the set moved between the calls.
  let confirmHash: string;
  let confirmInput: McpBulkConfirmInput;
  if (input.members !== undefined) {
    if (!idsAreWellFormed(input.members)) return refuseInvalidArgs();
    confirmHash = bulkArgsHashFor({ action: input.action, roleId, members: input.members });
    confirmInput = {
      action: input.action,
      roleId,
      memberIds: [...input.members],
      selector: undefined,
      argsHash: confirmHash,
      confirmToken: input.confirmToken,
      idempotencyKey: input.idempotencyKey,
      dryRun,
    };
  } else {
    const selector = input.selector;
    if (selector === undefined) return refuseInvalidArgs();
    const hasIds: string[] = [];
    for (const ref of selector.hasRoles ?? []) {
      const resolvedRef = resolveRoleRef(guild.listRoles(guildId), ref);
      if (!resolvedRef.ok) return { ok: false, message: resolvedRef.message };
      hasIds.push(resolvedRef.id);
    }
    const lacksIds: string[] = [];
    for (const ref of selector.lacksRoles ?? []) {
      const resolvedRef = resolveRoleRef(guild.listRoles(guildId), ref);
      if (!resolvedRef.ok) return { ok: false, message: resolvedRef.message };
      lacksIds.push(resolvedRef.id);
    }
    confirmHash = bulkArgsHashFor({
      action: input.action,
      roleId,
      selector: { hasRoles: hasIds, lacksRoles: lacksIds },
    });
    confirmInput = {
      action: input.action,
      roleId,
      memberIds: undefined,
      selector: { hasRoles: hasIds, lacksRoles: lacksIds },
      argsHash: confirmHash,
      confirmToken: input.confirmToken,
      idempotencyKey: input.idempotencyKey,
      dryRun,
    };
  }
  const outcome = await port.confirm(guildId, confirmInput);
  switch (outcome.status) {
    case 'done':
      return { ok: true, text: renderConfirmDone(outcome.actionId, outcome.jobId) };
    case 'dry-run':
      return {
        ok: true,
        text:
          `Dry run is on for guild ${guildId}: ` +
          `nothing changed (role ${input.role}). The change was recorded ` +
          `as action ${outcome.actionId} under its idempotency key but no job was enqueued.`,
      };
    case 'replayed':
      return {
        ok: true,
        text:
          `Already recorded under this idempotency key as action ${outcome.actionId}: ` +
          `nothing new was changed (role ${input.role}).`,
      };
    case 'refused':
      return { ok: false, message: confirmRefusalText(guildId, outcome.reason) };
    case 'failed':
      return {
        ok: false,
        message:
          `The bulk change (role ${input.role}) ` +
          `in guild ${guildId} failed with an unknown result: some members ` +
          `may or may not have changed. Check the members before retrying, ` +
          'and retry with the same idempotency key — never a fresh one.',
      };
  }
};

/**
 * Never throws and never rejects: a malformed argument is the
 * argument-fault message, and anything unexpected (a port fault, which
 * cannot carry member content outward from here — the renderings name ids,
 * the caller's own refs and display names only) is the shared refusal
 * rather than an exception out of the handler. The two messages are
 * deliberately different (ruling M4-D18).
 */
export const bulkRoleChangeText = async (
  principal: McpPrincipal,
  port: McpBulkRolesPort,
  guild: McpGuildPort,
  members: McpMembersPort,
  rawArgs: unknown,
): Promise<BulkRoleOutcomeText> => {
  try {
    return await bulkRoleChangeInner(principal, port, guild, members, rawArgs);
  } catch {
    return refuse();
  }
};
