import { PermissionFlagsBits, type Client, type GuildMember } from 'discord.js';
import { isInScope, rolePingAllowed, type GuildId } from '@bananasaurs/core';
import { loggingRepo, mcpSendRepo, mcpRolePolicyRepo, type GuildScope } from '@bananasaurs/storage';
import { resolveRoleRef } from '@bananasaurs/mcp';
import { resolveChannel } from '../channels/resolver.js';

/**
 * Send-target resolution for the MCP writes (ADR 0116 §3): send scope ∩ the
 * bot's live Discord permissions.
 *
 * The scope half is the same facts today's `sendPortFor` passes to ADR 0047's
 * `isInScope('send', …)` — own row, the private-thread own-row rule,
 * parent/category inheritance, exclusions — carried over unchanged. The
 * permission half is live discord.js math: `channel.permissionsFor` of the
 * bot member, so an overwrite changed after allowlisting binds at the call.
 */

export type TargetNeed =
  | 'post'
  | 'post-in-thread'
  | 'create-public-thread'
  | 'create-private-thread'
  | 'pin'
  | 'manage-thread'
  | 'react';

export type SendTargetRefusal =
  'not-in-guild' | 'not-in-send-scope' | 'private-thread-not-allowed' | 'bot-lacks-permission';

export type SendTarget =
  | {
      readonly ok: true;
      readonly channelId: string;
      readonly parentChannelId: string | undefined;
      readonly categoryId: string | undefined;
      readonly isThread: boolean;
      readonly isPrivateThread: boolean;
      readonly isForum: boolean;
      /** The id of the row that grants send scope — the audit's provenance. */
      readonly grantId: string;
      /** True when the grant comes from a parent or category row. */
      readonly derivedGrant: boolean;
    }
  | { readonly ok: false; readonly reason: SendTargetRefusal; readonly missing?: string };

/** A `{ bit, name }` pair, so the refusal can name the missing permission. */
interface NeedBit {
  readonly bit: bigint;
  readonly name: string;
}

const BIT = (bit: bigint, name: string): NeedBit => ({ bit, name });

const NEED_BITS: Record<TargetNeed, readonly NeedBit[]> = {
  // Posting needs sight as well as voice: without ViewChannel the bot cannot
  // see the channel it would speak in.
  post: [
    BIT(PermissionFlagsBits.ViewChannel, 'ViewChannel'),
    BIT(PermissionFlagsBits.SendMessages, 'SendMessages'),
  ],
  // A thread inherits sight from its parent: without ViewChannel there the
  // bot cannot reach the thread at all.
  'post-in-thread': [
    BIT(PermissionFlagsBits.ViewChannel, 'ViewChannel'),
    BIT(PermissionFlagsBits.SendMessagesInThreads, 'SendMessagesInThreads'),
  ],
  'create-public-thread': [BIT(PermissionFlagsBits.CreatePublicThreads, 'CreatePublicThreads')],
  'create-private-thread': [BIT(PermissionFlagsBits.CreatePrivateThreads, 'CreatePrivateThreads')],
  // PinMessages alone pins; ManageMessages alone pins too. Checked in
  // `resolveSendTarget` rather than here, because no bit list expresses "or".
  pin: [BIT(PermissionFlagsBits.PinMessages, 'PinMessages')],
  'manage-thread': [BIT(PermissionFlagsBits.ManageThreads, 'ManageThreads')],
  react: [BIT(PermissionFlagsBits.AddReactions, 'AddReactions')],
};

interface ChannelPermissions {
  has(bit: bigint): boolean;
}

const permissionsOf = (
  client: Client,
  guildId: GuildId,
  channelId: string,
): { readonly me: GuildMember; readonly perms: ChannelPermissions } | undefined => {
  const guild = client.guilds.cache.get(guildId);
  const me = guild?.members.me ?? null;
  if (guild === undefined || me === null) return undefined;
  const channel = client.channels.cache.get(channelId) as
    { permissionsFor(member: GuildMember): ChannelPermissions | null } | undefined;
  const perms = channel?.permissionsFor(me) ?? null;
  if (perms === null) return undefined;
  return { me, perms };
};

export const resolveSendTarget = async (
  client: Client,
  scope: GuildScope,
  guildId: GuildId,
  channelId: string,
  need: TargetNeed,
): Promise<SendTarget> => {
  // A guild the client never saw, or a channel outside it: the stale-row
  // shape C2 is about. Answered before anything else, with no Discord call.
  if (client.guilds.cache.get(guildId) === undefined) {
    return { ok: false, reason: 'not-in-guild' };
  }
  const resolved = await resolveChannel(client, guildId, channelId);
  if (resolved === undefined || !resolved.postable) {
    return { ok: false, reason: 'not-in-guild' };
  }
  // The private-thread own-row rule, before the scope predicate: private
  // threads never inherit, so the predicate below would refuse them anyway —
  // this branch names the reason.
  if (resolved.isPrivateThread && !mcpSendRepo.isChannelAllowed(scope, resolved.channelId)) {
    return { ok: false, reason: 'private-thread-not-allowed' };
  }
  // ADR 0047's send scope, with the same facts `sendPortFor` always passed.
  const grantId = isInScope('send', {
    channelId: resolved.channelId,
    parentChannelId: resolved.parentChannelId,
    categoryId: resolved.categoryId,
    isPrivateThread: resolved.isPrivateThread,
    hasOwnRow: (id) => mcpSendRepo.isChannelAllowed(scope, id),
    hasCategoryRow: (id) => mcpSendRepo.isScopeAllowed(scope, id, 'category'),
    isExcluded: (id) => loggingRepo.isChannelExcluded(scope, id),
    parentIncludesThreads: () => true,
  });
  if (grantId === undefined) return { ok: false, reason: 'not-in-send-scope' };
  // The live permission half: the bot member's channel permissions right
  // now, not as they were when the row was written.
  const live = permissionsOf(client, guildId, resolved.channelId);
  const bits = NEED_BITS[need];
  if (need === 'pin') {
    const pinned =
      live !== undefined &&
      (live.perms.has(PermissionFlagsBits.PinMessages) ||
        live.perms.has(PermissionFlagsBits.ManageMessages));
    if (!pinned) return { ok: false, reason: 'bot-lacks-permission', missing: 'PinMessages' };
  } else {
    const missing =
      live === undefined ? bits[0]?.name : bits.find((bit) => !live.perms.has(bit.bit))?.name;
    if (missing !== undefined) return { ok: false, reason: 'bot-lacks-permission', missing };
  }
  return {
    ok: true,
    channelId: resolved.channelId,
    parentChannelId: resolved.parentChannelId,
    categoryId: resolved.categoryId,
    isThread: resolved.isThread,
    isPrivateThread: resolved.isPrivateThread,
    isForum: resolved.isForum,
    grantId,
    derivedGrant: grantId !== resolved.channelId,
  };
};

/**
 * Explicit role/user pings under the role policy and the dangerous-permission
 * floor (ADR 0117). Role facts — position, permissions, managed — are read
 * off the live guild cache at the call, so a role that gains a dangerous
 * permission after being allowlisted stops being pingable at once. User pings
 * need a live guild membership each; there are no DMs.
 */

export type PingRefusal =
  | 'role-unknown'
  | 'role-dangerous'
  | 'role-managed-or-everyone'
  | 'role-above-bot'
  | 'role-not-allowlisted'
  | 'user-not-member';

export type PingResolution =
  | { readonly ok: true; readonly roleIds: string[]; readonly userIds: string[] }
  | { readonly ok: false; readonly reason: PingRefusal; readonly ref: string };

/** Discord's 10007 Unknown Member / 10013 Unknown User, or a bare 404. */
const isUnknownMember = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const { code, status } = err as { code?: unknown; status?: unknown };
  return code === 10007 || code === 10013 || status === 404;
};

export const resolvePings = async (
  client: Client,
  scope: GuildScope,
  guildId: GuildId,
  input: { readonly roles: readonly string[]; readonly users: readonly string[] },
): Promise<PingResolution> => {
  const guild = client.guilds.cache.get(guildId);
  if (guild === undefined) {
    const firstRole = input.roles[0];
    if (firstRole !== undefined) return { ok: false, reason: 'role-unknown', ref: firstRole };
    const firstUser = input.users[0];
    if (firstUser !== undefined) return { ok: false, reason: 'user-not-member', ref: firstUser };
    return { ok: true, roleIds: [], userIds: [] };
  }
  const roleIds: string[] = [];
  if (input.roles.length > 0) {
    // Full `McpGuildRole` rows for `resolveRoleRef` (it reads id and name;
    // the rest rides along because the resolver owns its input shape, not us).
    const names = [...guild.roles.cache.values()].map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position,
      color: role.color,
      managedByBananasaurs: false,
    }));
    const policy = mcpRolePolicyRepo.readRolePolicy(scope);
    const botTopPosition = guild.members.me?.roles.highest.position ?? 0;
    for (const ref of input.roles) {
      const matched = resolveRoleRef(names, ref);
      if (!matched.ok) return { ok: false, reason: 'role-unknown', ref };
      const role = guild.roles.cache.get(matched.id);
      if (role === undefined) return { ok: false, reason: 'role-unknown', ref };
      const allowed = rolePingAllowed(
        {
          id: role.id,
          position: role.position,
          permissions: role.permissions.bitfield,
          managed: role.managed,
          isEveryone: role.id === guild.id,
        },
        botTopPosition,
        policy.pingMode,
        mcpRolePolicyRepo.isRoleAllowlisted(scope, role.id, 'ping'),
      );
      if (allowed !== true) {
        const reason: PingRefusal =
          allowed === 'dangerous'
            ? 'role-dangerous'
            : allowed === 'managed-or-everyone'
              ? 'role-managed-or-everyone'
              : allowed === 'above-bot'
                ? 'role-above-bot'
                : 'role-not-allowlisted';
        return { ok: false, reason, ref };
      }
      if (!roleIds.includes(role.id)) roleIds.push(role.id);
    }
  }
  const userIds: string[] = [];
  for (const ref of input.users) {
    const cached = guild.members.cache.get(ref) !== undefined;
    // Live, not cached: the cache caps at fifty members, so a cache hit
    // proves membership but a miss proves nothing — one REST read decides.
    // Only Discord's own "no such member/user" answer means not a member; a
    // transport fault throws, so an outage is never reported as a refusal.
    const member = cached
      ? true
      : await guild.members.fetch(ref).then(
          () => true,
          (err: unknown) => {
            if (isUnknownMember(err)) return false;
            throw err;
          },
        );
    if (!member) return { ok: false, reason: 'user-not-member', ref };
    if (!userIds.includes(ref)) userIds.push(ref);
  }
  return { ok: true, roleIds, userIds };
};
