import { PermissionFlagsBits, type Client, type Guild, type GuildMember } from 'discord.js';
import { rolePingAllowed, type GuildId } from '@bananasaurs/core';
import { mcpRolePolicyRepo, type GuildScope } from '@bananasaurs/storage';
import {
  resolveRoleRef,
  SEND_PING_ROLES_MAX,
  SEND_PING_USERS_MAX,
  type McpNotPinged,
} from '@bananasaurs/mcp';
import { resolveChannel } from '../channels/resolver.js';
import { channelAccessFor } from '../channels/access.js';

/**
 * Send-target resolution for the MCP writes (ADR 0116 §3): Write scope ∩ the
 * bot's live Discord permissions.
 *
 * The scope half is the one `ChannelAccess` precedence every surface shares
 * (ADR 0126): `check('write', …)` — the Write row, with parent/category
 * inheritance (which private threads share since the 2026-10-03 owner
 * decision), and No access overriding all of it. The permission half is live
 * discord.js math: `channel.permissionsFor` of the bot member, so an
 * overwrite changed after allowlisting binds at the call.
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

export type SendTargetRefusal = 'not-in-guild' | 'not-in-send-scope' | 'bot-lacks-permission';

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
  // Owner decision 2026-10-03: private threads inherit Write from their
  // parent or category like any thread — `check('write', …)` below decides,
  // through the one `ChannelAccess` precedence (ADR 0126). A private thread
  // with no grant at all still refuses, as `not-in-send-scope`.
  const decision = await channelAccessFor(client, scope).check('write', resolved.channelId);
  if (!decision.allowed) {
    // No access and not-granted are both "outside the send allowlist" to the
    // caller; a channel the access check cannot resolve answers the way an
    // out-of-guild channel does. That arm is reachable: the access check
    // resolves the channel again behind `check`, so a channel deleted between
    // the resolve above and that second resolve answers `unknown-channel` —
    // and is refused here all the same.
    return decision.reason === 'unknown-channel'
      ? { ok: false, reason: 'not-in-guild' }
      : { ok: false, reason: 'not-in-send-scope' };
  }
  const grantId = decision.grantedBy;
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

/**
 * The user and role mentions typed into MCP-posted text (ADR 0128 §1), in
 * order and without repeats: `<@id>` and `<@!id>` are users, `<@&id>` roles.
 * `@everyone`, `@here` and channel mentions are never ping targets. Code
 * spans and fenced blocks are skipped: Discord renders a mention there as
 * text and never pings it, so checking it would only cost a lookup and
 * report a false "not pinged".
 */
const TEXT_MENTION = /<@([!&]?)(\d{17,20})>/g;
const CODE_SPAN = /```[\s\S]*?```|`[^`\n]*`/g;

export const textMentions = (
  text: string | undefined,
): { readonly users: string[]; readonly roles: string[] } => {
  const users: string[] = [];
  const roles: string[] = [];
  if (text === undefined) return { users, roles };
  for (const match of text.replace(CODE_SPAN, ' ').matchAll(TEXT_MENTION)) {
    const id = match[2];
    if (id === undefined) continue;
    const list = match[1] === '&' ? roles : users;
    if (!list.includes(id)) list.push(id);
  }
  return { users, roles };
};

export interface CappedPings {
  readonly roleIds: string[];
  readonly userIds: string[];
  readonly notPinged: McpNotPinged[];
}

export type SendPingResolution =
  | ({ readonly ok: true } & CappedPings)
  | { readonly ok: false; readonly reason: PingRefusal; readonly ref: string };

/**
 * The pings of one MCP post (ADR 0128 §2): the explicit `pingRoles` /
 * `pingUsers` stay strict — `resolvePings` refuses the call on the first bad
 * one — and the mentions typed into `text` are best effort — `filterPings`
 * drops a bad one, which the result reports as not pinged.
 */
export const resolveSendPings = async (
  client: Client,
  scope: GuildScope,
  guildId: GuildId,
  input: {
    readonly roles: readonly string[];
    readonly users: readonly string[];
    readonly text: string | undefined;
  },
): Promise<SendPingResolution> => {
  const explicit = await resolvePings(client, scope, guildId, {
    roles: input.roles,
    users: input.users,
  });
  if (!explicit.ok) return explicit;
  return { ok: true, ...(await withTextPings(client, scope, guildId, explicit, input.text)) };
};

/**
 * Adds the mentions typed into `text` to already-resolved `base` pings, best
 * effort and under the caps (ADR 0128 §2–§3). Scheduling calls it on its
 * own, to report what the text would not ping while storing only the
 * explicit ids.
 *
 * Best effort means it never throws and never refuses: a mention past the
 * cap is reported `over-cap` without a lookup (a 2,000-character text can
 * hold ~90 mentions, and each uncached one costs a REST call), and a
 * membership lookup that fails for any reason other than Unknown Member is
 * reported `member-check-failed` instead of failing the post — a Discord
 * blip must not stop a send that needed no lookup before ADR 0128.
 */
export const withTextPings = async (
  client: Client,
  scope: GuildScope,
  guildId: GuildId,
  base: { readonly roleIds: readonly string[]; readonly userIds: readonly string[] },
  text: string | undefined,
  /** Ids already checked and dropped by the caller: neither re-checked nor re-reported. */
  decided: readonly McpNotPinged[] = [],
): Promise<CappedPings> => {
  const seen = (kind: 'role' | 'user', id: string): boolean =>
    decided.some((drop) => drop.kind === kind && drop.id === id);
  const all = textMentions(text);
  const mentioned = {
    roles: all.roles.filter((id) => !seen('role', id)),
    users: all.users.filter((id) => !seen('user', id)),
  };
  const roleIds = [...base.roleIds];
  const userIds = [...base.userIds];
  const notPinged: McpNotPinged[] = [];
  const guild = client.guilds.cache.get(guildId);
  const context =
    guild === undefined || mentioned.roles.length === 0
      ? undefined
      : rolePingContextFor(client, scope, guildId);
  for (const id of mentioned.roles) {
    if (roleIds.includes(id)) continue;
    if (roleIds.length >= SEND_PING_ROLES_MAX) {
      notPinged.push({ kind: 'role', id, reason: 'over-cap' });
      continue;
    }
    if (context === undefined) {
      notPinged.push({ kind: 'role', id, reason: 'role-unknown' });
      continue;
    }
    const checked = checkRolePing(client, scope, guildId, id, context);
    if (!checked.ok) notPinged.push({ kind: 'role', id: checked.id, reason: checked.reason });
    else if (!roleIds.includes(checked.id)) roleIds.push(checked.id);
  }
  for (const id of mentioned.users) {
    if (userIds.includes(id)) continue;
    if (userIds.length >= SEND_PING_USERS_MAX) {
      notPinged.push({ kind: 'user', id, reason: 'over-cap' });
      continue;
    }
    if (guild === undefined) {
      notPinged.push({ kind: 'user', id, reason: 'user-not-member' });
      continue;
    }
    let member: boolean;
    try {
      member = await isLiveMember(guild, id);
    } catch {
      notPinged.push({ kind: 'user', id, reason: 'member-check-failed' });
      continue;
    }
    if (member) userIds.push(id);
    else notPinged.push({ kind: 'user', id, reason: 'user-not-member' });
  }
  return { roleIds, userIds, notPinged };
};

/**
 * The delivery-time pings of a scheduled send (ADR 0128 §5): the stored
 * explicit pings through the ADR 0119 §2 filter, unchanged — a transport
 * fault there still throws, so the pass retries — then the mentions in the
 * text as it stands now, best effort under `withTextPings`.
 */
export const filterSendPings = async (
  client: Client,
  scope: GuildScope,
  guildId: GuildId,
  input: {
    readonly roles: readonly string[];
    readonly users: readonly string[];
    readonly text: string | undefined;
  },
): Promise<CappedPings> => {
  const stored = await filterPings(client, scope, guildId, {
    roles: input.roles,
    users: input.users,
  });
  const withText = await withTextPings(
    client,
    scope,
    guildId,
    {
      roleIds: stored.roleIds.slice(0, SEND_PING_ROLES_MAX),
      userIds: stored.userIds.slice(0, SEND_PING_USERS_MAX),
    },
    input.text,
    stored.dropped,
  );
  return { ...withText, notPinged: [...stored.dropped, ...withText.notPinged] };
};
