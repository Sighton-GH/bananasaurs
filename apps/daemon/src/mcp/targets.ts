import { PermissionFlagsBits, type Client, type Guild, type GuildMember } from 'discord.js';
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
  | 'manage-events'
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
  // Scheduled events live in voice and stage channels: sight plus the
  // ManageEvents grant, checked live like every other need. The voice-or-stage
  // type check itself lives in the daemon's event wiring (which reads the
  // live channel type) — this layer only owns send scope and the permission.
  'manage-events': [
    BIT(PermissionFlagsBits.ViewChannel, 'ViewChannel'),
    BIT(PermissionFlagsBits.ManageEvents, 'ManageEvents'),
  ],
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
  // Voice and stage channels host scheduled events but are not text-postable,
  // so the postable gate would refuse them as not-in-guild. The
  // `manage-events` need admits them past that gate; the daemon's event
  // wiring checks the live voice-or-stage type before calling, so a text
  // channel or thread passed as an event channel is still refused there.
  if (resolved === undefined || (!resolved.postable && need !== 'manage-events')) {
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

/**
 * The exact per-role ping decision `resolvePings` applies, one role at a
 * time: ref resolution, then the live role facts through `rolePingAllowed`
 * (below-bot or allowlist, `isDangerousRole`, managed/@everyone; ADR 0117)
 * with the refusal mapped to a `PingRefusal`.
 *
 * Extracted — not copied — so the delivery-time re-check (`filterPings`,
 * ADR 0119 §2) runs the same predicate at delivery that scheduling ran at
 * scheduling. `id` is the resolved role id when the role was found, else the
 * ref itself, so a drop log can always name an id.
 */
export type RolePingCheck =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: PingRefusal; readonly ref: string; readonly id: string };

/**
 * The per-call facts `checkRolePing` reads for every role: the role-name
 * table, the guild's ping policy and the bot's top position. Built once per
 * `resolvePings` / `filterPings` call, so ten pinged roles cost one policy
 * read, not ten.
 */
export interface RolePingContext {
  readonly guild: Guild;
  readonly names: readonly {
    readonly id: string;
    readonly name: string;
    readonly position: number;
    readonly color: number;
    readonly managedByBananasaurs: boolean;
  }[];
  readonly pingMode: ReturnType<typeof mcpRolePolicyRepo.readRolePolicy>['pingMode'];
  readonly botTopPosition: number;
}

export const rolePingContextFor = (
  client: Client,
  scope: GuildScope,
  guildId: GuildId,
): RolePingContext | undefined => {
  const guild = client.guilds.cache.get(guildId);
  if (guild === undefined) return undefined;
  return {
    guild,
    // Full `McpGuildRole` rows for `resolveRoleRef` (it reads id and name;
    // the rest rides along because the resolver owns its input shape, not us).
    names: [...guild.roles.cache.values()].map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position,
      color: role.color,
      managedByBananasaurs: false,
    })),
    pingMode: mcpRolePolicyRepo.readRolePolicy(scope).pingMode,
    botTopPosition: guild.members.me?.roles.highest.position ?? 0,
  };
};

export const checkRolePing = (
  client: Client,
  scope: GuildScope,
  guildId: GuildId,
  ref: string,
  context: RolePingContext | undefined = rolePingContextFor(client, scope, guildId),
): RolePingCheck => {
  if (context === undefined) return { ok: false, reason: 'role-unknown', ref, id: ref };
  const { guild, names, pingMode, botTopPosition } = context;
  const matched = resolveRoleRef(names, ref);
  if (!matched.ok) return { ok: false, reason: 'role-unknown', ref, id: ref };
  const role = guild.roles.cache.get(matched.id);
  if (role === undefined) return { ok: false, reason: 'role-unknown', ref, id: ref };
  const allowed = rolePingAllowed(
    {
      id: role.id,
      position: role.position,
      permissions: role.permissions.bitfield,
      managed: role.managed,
      isEveryone: role.id === guild.id,
    },
    botTopPosition,
    pingMode,
    mcpRolePolicyRepo.isRoleAllowlisted(scope, role.id, 'ping'),
  );
  if (allowed === true) return { ok: true, id: role.id };
  const reason: PingRefusal =
    allowed === 'dangerous'
      ? 'role-dangerous'
      : allowed === 'managed-or-everyone'
        ? 'role-managed-or-everyone'
        : allowed === 'above-bot'
          ? 'role-above-bot'
          : 'role-not-allowlisted';
  return { ok: false, reason, ref, id: role.id };
};

/**
 * Live guild membership, as at schedule time: a cache hit proves it, but a
 * miss proves nothing (the cache caps at fifty members), so one REST read
 * decides. Only Discord's own "no such member/user" answer means not a
 * member; a transport fault throws, so an outage is never reported as a
 * refusal.
 */
const isLiveMember = async (guild: Guild, userId: string): Promise<boolean> => {
  if (guild.members.cache.get(userId) !== undefined) return true;
  return guild.members.fetch(userId).then(
    () => true,
    (err: unknown) => {
      if (isUnknownMember(err)) return false;
      throw err;
    },
  );
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
  const context = rolePingContextFor(client, scope, guildId);
  for (const ref of input.roles) {
    const checked = checkRolePing(client, scope, guildId, ref, context);
    if (!checked.ok) return { ok: false, reason: checked.reason, ref: checked.ref };
    if (!roleIds.includes(checked.id)) roleIds.push(checked.id);
  }
  const userIds: string[] = [];
  for (const ref of input.users) {
    if (!(await isLiveMember(guild, ref))) return { ok: false, reason: 'user-not-member', ref };
    if (!userIds.includes(ref)) userIds.push(ref);
  }
  return { ok: true, roleIds, userIds };
};

export interface PingDrop {
  readonly kind: 'role' | 'user';
  readonly id: string;
  readonly reason: PingRefusal;
}

export interface FilteredPings {
  readonly roleIds: string[];
  readonly userIds: string[];
  readonly dropped: PingDrop[];
}

/**
 * The delivery-time ping filter (ADR 0119 §2): `resolvePings` refuses the
 * whole call on the first bad role, which is right at schedule time but
 * wrong at delivery — here each refused role (or departed user) is dropped
 * from the pings and the rest are kept, with one drop record each for the
 * ids-only log line. The per-role decision is `checkRolePing`, the exact
 * predicate scheduling uses; user membership is the same live check.
 */
export const filterPings = async (
  client: Client,
  scope: GuildScope,
  guildId: GuildId,
  input: { readonly roles: readonly string[]; readonly users: readonly string[] },
): Promise<FilteredPings> => {
  const guild = client.guilds.cache.get(guildId);
  if (guild === undefined) {
    return {
      roleIds: [],
      userIds: [],
      dropped: [
        ...input.roles.map((ref): PingDrop => ({ kind: 'role', id: ref, reason: 'role-unknown' })),
        ...input.users.map((ref): PingDrop => ({
          kind: 'user',
          id: ref,
          reason: 'user-not-member',
        })),
      ],
    };
  }
  const roleIds: string[] = [];
  const userIds: string[] = [];
  const dropped: PingDrop[] = [];
  const context = rolePingContextFor(client, scope, guildId);
  for (const ref of input.roles) {
    const checked = checkRolePing(client, scope, guildId, ref, context);
    if (!checked.ok) {
      if (!dropped.some((drop) => drop.kind === 'role' && drop.id === checked.id))
        dropped.push({ kind: 'role', id: checked.id, reason: checked.reason });
      continue;
    }
    if (!roleIds.includes(checked.id)) roleIds.push(checked.id);
  }
  for (const ref of input.users) {
    if (!(await isLiveMember(guild, ref))) {
      if (!dropped.some((drop) => drop.kind === 'user' && drop.id === ref))
        dropped.push({ kind: 'user', id: ref, reason: 'user-not-member' });
      continue;
    }
    if (!userIds.includes(ref)) userIds.push(ref);
  }
  return { roleIds, userIds, dropped };
};
