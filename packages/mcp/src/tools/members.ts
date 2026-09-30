import { z } from 'zod';
import { type GuildId } from '@bananasaurs/core';
import {
  GUILD_REFUSAL_MESSAGE,
  INVALID_ARGUMENTS_MESSAGE,
  requireReachableGuild,
  type McpPrincipal,
} from '../scope.js';
import { safeName, structuredText } from '../structured.js';
import { isSnowflake, normalizeRef, resolveRoleRef } from '../resolve.js';
import { MCP_READ_GET_MEMBER, MCP_READ_SEARCH_MEMBERS } from '../read-audit.js';
import { registerReadTool, type ReadOutcome, type RegisterContext } from '../register.js';
import type { McpGuildPort } from './guild.js';

/**
 * `get_member` / `search_members` — "who has Car Team A but not Club Member?"
 * or "who in Tech Team hasn't posted in 14 days?" in one call, with role
 * names and last-active times.
 *
 * The port takes the already-resolved `GuildId`, never raw input (hard rule
 * 2). `listAllMembers` pages the daemon's REST listing past 1,000 up to
 * `MEMBER_LISTING_CAP`; `lastMessageAt` reads the archive's newest message
 * time per author. This package never sees discord.js or storage handles.
 */

export const GET_MEMBER_TOOL_NAME = 'get_member';
export const GET_MEMBER_TOOL_DESCRIPTION =
  'One guild member by id or by username, display name or nickname: id, names, ' +
  'role ids with names, joined-at, and last archived message time. ' +
  'lastMessageAt null means no archived message from this member in any archive-enabled channel. ' +
  'An ambiguous name answers candidates to pick an id from. ' +
  'Refuses when the guild is unreachable.';

export const SEARCH_MEMBERS_TOOL_NAME = 'search_members';
export const SEARCH_MEMBERS_TOOL_DESCRIPTION =
  'Search guild members by role names, name text, inactivity, or join date: ' +
  'id, names, role ids with names, joined-at, and last archived message time. ' +
  'lastMessageAt null means no archived message from this member in any archive-enabled channel. ' +
  'inactiveDays keeps members with no archived message in that many days, or none at all (never-posters count as inactive). ' +
  'Refuses when the guild is unreachable.';

/** The listing cap the daemon's port enforces; the head says so when hit. */
export const MEMBER_LISTING_CAP = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One member as the daemon projects it — plain data, no discord.js. */
export interface McpMemberProfile {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly nickname: string | undefined;
  readonly roleIds: readonly string[];
  readonly joinedAt: number | undefined;
}

export interface McpMembersPort {
  /** Every member via paged REST (1,000 per page) until a short page, capped at 5,000; truncated when the cap cut it. */
  readonly listAllMembers: (guildId: GuildId) => Promise<{
    readonly members: readonly McpMemberProfile[];
    readonly truncated: boolean;
  }>;
  readonly lastMessageAt: (
    guildId: GuildId,
    authorIds: readonly string[],
  ) => ReadonlyMap<string, number>;
  readonly now: () => number;
}

const getMemberArgsSchema = z.object({
  guildId: z.string(),
  member: z.string().min(1).max(100),
});

const searchMembersArgsSchema = z.object({
  guildId: z.string(),
  hasRoles: z.array(z.string()).max(10).optional(),
  lacksRoles: z.array(z.string()).max(10).optional(),
  nameContains: z.string().min(1).max(100).optional(),
  inactiveDays: z.number().int().min(1).max(30).optional(),
  joinedAfter: z.number().finite().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

/**
 * The loose wire shapes registered with the MCP server. Deliberately without
 * refinements: this documents the wire types for clients while the strict
 * schemas above stay the single boundary.
 */
export const getMemberParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  member: z
    .string()
    .describe('Member id, or a username, display name or nickname ("@" prefix optional).'),
};

export const searchMembersParams = {
  guildId: z.string().describe('Guild id; must be reachable by the caller.'),
  hasRoles: z
    .array(z.string())
    .describe('Keep members holding every named role (id or name, "@" prefix optional; max 10).')
    .optional(),
  lacksRoles: z
    .array(z.string())
    .describe('Drop members holding any named role (id or name, "@" prefix optional; max 10).')
    .optional(),
  nameContains: z
    .string()
    .describe(
      'Keep members whose username, display name or nickname contains this text (case-insensitive).',
    )
    .optional(),
  inactiveDays: z
    .number()
    .describe(
      'Keep members with no archived message in this many days (1..30), or with no archived message at all (never-posters count).',
    )
    .optional(),
  joinedAfter: z
    .number()
    .describe('Keep members who joined after this unix-ms time; unknown join dates are excluded.')
    .optional(),
  limit: z.number().describe('Max rows, default 100, 1..200.').optional(),
  offset: z.number().describe('Skip this many sorted rows, default 0.').optional(),
};

const refuse = (): ReadOutcome => ({ ok: false, message: GUILD_REFUSAL_MESSAGE });

const refuseInvalidArgs = (): ReadOutcome => ({
  ok: false,
  message: INVALID_ARGUMENTS_MESSAGE,
});

const compareMembers = (a: McpMemberProfile, b: McpMemberProfile): number => {
  const an = a.displayName.toLowerCase();
  const bn = b.displayName.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const renderRow = (
  member: McpMemberProfile,
  roleNameById: ReadonlyMap<string, string>,
  last: number | undefined,
): Record<string, unknown> => ({
  id: member.id,
  username: safeName(member.username),
  displayName: safeName(member.displayName),
  nickname: member.nickname === undefined ? null : safeName(member.nickname),
  roles: member.roleIds.map((id) => ({
    id,
    name: safeName(roleNameById.get(id) ?? '(unknown role)'),
  })),
  joinedAt: member.joinedAt === undefined ? null : new Date(member.joinedAt).toISOString(),
  lastMessageAt: last === undefined ? null : new Date(last).toISOString(),
});

const roleNameByIdOf = (guild: McpGuildPort, guildId: GuildId): ReadonlyMap<string, string> =>
  new Map(guild.listRoles(guildId).map((role) => [role.id, role.name] as const));

const getMemberInner = async (
  principal: McpPrincipal,
  port: McpMembersPort,
  guild: McpGuildPort,
  rawArgs: unknown,
): Promise<ReadOutcome> => {
  const parsed = getMemberArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  // The guild gate: parses the id and refuses malformed and unreachable
  // identically — removing this call answers any guild's members.
  const gate = requireReachableGuild(principal, parsed.data.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const roleNameById = roleNameByIdOf(guild, gate.guildId);
  const { members } = await port.listAllMembers(gate.guildId);
  // Trimmed once here, like `resolveRef`: a padded id takes the id path.
  const query = parsed.data.member.trim();
  if (isSnowflake(query)) {
    const found = members.find((m) => m.id === query);
    if (found === undefined) {
      return {
        ok: true,
        text: structuredText(`No member matches "${safeName(query)}".`, { member: null }),
        read: {
          kind: 'structural',
          action: MCP_READ_GET_MEMBER,
          guildIds: [gate.guildId],
          resultCount: 0,
        },
      };
    }
    const last = port.lastMessageAt(gate.guildId, [found.id]);
    const row = renderRow(found, roleNameById, last.get(found.id));
    return {
      ok: true,
      text: structuredText(`Member ${found.id} in guild ${gate.guildId}.`, { member: row }),
      read: {
        kind: 'structural',
        action: MCP_READ_GET_MEMBER,
        guildIds: [gate.guildId],
        resultCount: 1,
      },
    };
  }
  const needle = normalizeRef(query, '@');
  const matches = members
    .filter(
      (m) =>
        m.username.toLowerCase() === needle ||
        m.displayName.toLowerCase() === needle ||
        (m.nickname !== undefined && m.nickname.toLowerCase() === needle),
    )
    .slice()
    .sort(compareMembers);
  if (matches.length === 0) {
    return {
      ok: true,
      text: structuredText(`No member matches "${safeName(query)}".`, { member: null }),
      read: {
        kind: 'structural',
        action: MCP_READ_GET_MEMBER,
        guildIds: [gate.guildId],
        resultCount: 0,
      },
    };
  }
  if (matches.length === 1) {
    const only = matches[0];
    if (only === undefined) throw new Error('unreachable');
    const last = port.lastMessageAt(gate.guildId, [only.id]);
    const row = renderRow(only, roleNameById, last.get(only.id));
    return {
      ok: true,
      text: structuredText(`Member ${only.id} in guild ${gate.guildId}.`, { member: row }),
      read: {
        kind: 'structural',
        action: MCP_READ_GET_MEMBER,
        guildIds: [gate.guildId],
        resultCount: 1,
      },
    };
  }
  const candidates = matches.slice(0, 10);
  const last = port.lastMessageAt(
    gate.guildId,
    candidates.map((c) => c.id),
  );
  const rows = candidates.map((c) => renderRow(c, roleNameById, last.get(c.id)));
  const list = candidates.map((c) => `${safeName(c.displayName)} (${c.id})`).join(', ');
  return {
    ok: true,
    text: structuredText(
      `"${safeName(query)}" matches ${String(matches.length)} members: ${list}. Pass an id.`,
      { member: null, candidates: rows },
    ),
    read: {
      kind: 'structural',
      action: MCP_READ_GET_MEMBER,
      guildIds: [gate.guildId],
      resultCount: rows.length,
    },
  };
};

const searchMembersInner = async (
  principal: McpPrincipal,
  port: McpMembersPort,
  guild: McpGuildPort,
  rawArgs: unknown,
): Promise<ReadOutcome> => {
  const parsed = searchMembersArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return refuseInvalidArgs();
  const input = parsed.data;
  const gate = requireReachableGuild(principal, input.guildId);
  if (!gate.ok) return { ok: false, message: gate.message };
  const roles = guild.listRoles(gate.guildId);
  const hasIds: string[] = [];
  for (const ref of input.hasRoles ?? []) {
    const resolved = resolveRoleRef(roles, ref);
    if (!resolved.ok) return { ok: false, message: resolved.message };
    hasIds.push(resolved.id);
  }
  const lacksIds: string[] = [];
  for (const ref of input.lacksRoles ?? []) {
    const resolved = resolveRoleRef(roles, ref);
    if (!resolved.ok) return { ok: false, message: resolved.message };
    lacksIds.push(resolved.id);
  }
  const { members, truncated } = await port.listAllMembers(gate.guildId);
  // The non-activity filters first: the archive read below covers only the
  // ids that survive them, in one call.
  const needle = input.nameContains?.toLowerCase();
  const preActivity = members.filter((m) => {
    if (!hasIds.every((id) => m.roleIds.includes(id))) return false;
    if (lacksIds.some((id) => m.roleIds.includes(id))) return false;
    if (needle !== undefined) {
      const hit =
        m.username.toLowerCase().includes(needle) ||
        m.displayName.toLowerCase().includes(needle) ||
        (m.nickname !== undefined && m.nickname.toLowerCase().includes(needle));
      if (!hit) return false;
    }
    if (input.joinedAfter !== undefined) {
      if (m.joinedAt === undefined || !(m.joinedAt > input.joinedAfter)) return false;
    }
    return true;
  });
  const lastById = port.lastMessageAt(
    gate.guildId,
    preActivity.map((m) => m.id),
  );
  const now = port.now();
  const inactiveDays = input.inactiveDays;
  const filtered =
    inactiveDays === undefined
      ? preActivity
      : preActivity.filter((m) => {
          const last = lastById.get(m.id);
          // Never-posters count as inactive: null is silence, not unknown.
          return last === undefined || last <= now - inactiveDays * DAY_MS;
        });
  const sorted = filtered.slice().sort(compareMembers);
  const limit = input.limit ?? 100;
  const offset = input.offset ?? 0;
  const page = sorted.slice(offset, offset + limit);
  const roleNameById = new Map(roles.map((role) => [role.id, role.name] as const));
  const rows = page.map((m) => renderRow(m, roleNameById, lastById.get(m.id)));
  const total = sorted.length;
  const shown = rows.length;
  let head =
    `${String(total)} members match ` +
    `(showing ${String(shown)} from offset ${String(offset)})` +
    `${truncated ? '; member listing was capped at 5,000' : ''}.`;
  if (offset + shown < total) head += ` Next offset: ${String(offset + shown)}.`;
  return {
    ok: true,
    text: structuredText(head, { members: rows }),
    read: {
      kind: 'structural',
      action: MCP_READ_SEARCH_MEMBERS,
      guildIds: [gate.guildId],
      resultCount: shown,
    },
  };
};

/**
 * Never throws and never rejects: a malformed argument is the argument-fault
 * message, and anything unexpected (a port fault) is the shared refusal
 * rather than an exception out of the handler.
 */
export const getMemberText = async (
  principal: McpPrincipal,
  port: McpMembersPort,
  guild: McpGuildPort,
  rawArgs: unknown,
): Promise<ReadOutcome> => {
  try {
    return await getMemberInner(principal, port, guild, rawArgs);
  } catch {
    return refuse();
  }
};

/** Never throws and never rejects; see `getMemberText`. */
export const searchMembersText = async (
  principal: McpPrincipal,
  port: McpMembersPort,
  guild: McpGuildPort,
  rawArgs: unknown,
): Promise<ReadOutcome> => {
  try {
    return await searchMembersInner(principal, port, guild, rawArgs);
  } catch {
    return refuse();
  }
};

/** Registers both member tools through the shared read-tool shape. */
export const registerMemberTools = (
  ctx: RegisterContext,
  port: McpMembersPort,
  guild: McpGuildPort,
): void => {
  registerReadTool(
    ctx,
    GET_MEMBER_TOOL_NAME,
    GET_MEMBER_TOOL_DESCRIPTION,
    getMemberParams,
    (args) => getMemberText(ctx.principal, port, guild, args),
  );
  registerReadTool(
    ctx,
    SEARCH_MEMBERS_TOOL_NAME,
    SEARCH_MEMBERS_TOOL_DESCRIPTION,
    searchMembersParams,
    (args) => searchMembersText(ctx.principal, port, guild, args),
  );
};
