import {
  DiscordApiError,
  DiscordErrorCode,
  type AuditLogEntry,
  type DiscordMember,
  type DiscordMessageRef,
  type DiscordPort,
  type DiscordRole,
  type DomainEvent,
  type EmojiKey,
  type OutgoingMessage,
  type ReactionUserPage,
  type Snowflake,
} from '@bananasaurs/core';

/**
 * In-memory Discord, built before the features that use it.
 *
 * Claude Code cannot connect to Discord and cannot tell whether a role panel
 * behaves correctly. Without this, the owner is the test suite and progress
 * stops (docs/16). It implements DiscordPort so production code under test
 * cannot tell the difference, and it can be told to fail on demand.
 *
 * It is a *port*-level fake, not a discord.js fake. What it cannot prove is
 * that discord.js delivers an event for an uncached message on the real
 * gateway; that stays a live smoke test. What it does prove is that our code
 * handles the event correctly once delivered, which is the part we own.
 */

export type PortMethod = keyof DiscordPort;

interface FakeMessage {
  channelId: Snowflake;
  messageId: Snowflake;
  authorId: Snowflake;
  /** emojiKey -> ordered user ids, mirroring Discord's insertion order. */
  reactions: Map<EmojiKey, Snowflake[]>;
  cached: boolean;
  deleted: boolean;
}

interface FakeMember {
  userId: Snowflake;
  roleIds: Set<Snowflake>;
  isGuildOwner: boolean;
}

export interface RestCall {
  method: PortMethod;
  args: readonly unknown[];
  atMs: number;
}

interface Failure {
  error: DiscordApiError;
  remaining: number;
}

export interface FakeDiscordOptions {
  guildId: Snowflake;
  /** Where the bot's own highest role sits. Roles at or above are unassignable. */
  botHighestRolePosition?: number;
}

export class FakeDiscord implements DiscordPort {
  readonly guildId: Snowflake;

  private roles = new Map<Snowflake, DiscordRole>();
  private members = new Map<Snowflake, FakeMember>();
  private messages = new Map<string, FakeMessage>();
  private auditLog: AuditLogEntry[] = [];
  private botPosition: number;

  private failures = new Map<PortMethod, Failure>();
  private calls: RestCall[] = [];
  private listeners: Array<(e: DomainEvent) => void | Promise<void>> = [];

  private connected = true;
  private disconnectedAtMs = 0;
  private clock = 1_700_000_000_000;
  private idSeq = 900_000_000_000_000_000n;

  constructor(options: FakeDiscordOptions) {
    this.guildId = options.guildId;
    this.botPosition = options.botHighestRolePosition ?? 100;
  }

  // ── clock and ids ──────────────────────────────────────────────────────
  now(): number {
    return this.clock;
  }
  advance(ms: number): void {
    this.clock += ms;
  }
  nextId(): Snowflake {
    this.idSeq += 1n;
    return this.idSeq.toString();
  }

  // ── world building ─────────────────────────────────────────────────────
  defineRole(role: Partial<DiscordRole> & { id: Snowflake }): DiscordRole {
    const full: DiscordRole = {
      id: role.id,
      name: role.name ?? `role-${role.id}`,
      position: role.position ?? 1,
      managed: role.managed ?? false,
    };
    this.roles.set(full.id, full);
    return full;
  }
  setRolePosition(roleId: Snowflake, position: number): void {
    const r = this.roles.get(roleId);
    if (!r) throw new Error(`no such role ${roleId}`);
    this.roles.set(roleId, { ...r, position });
  }
  setBotHighestRolePosition(position: number): void {
    this.botPosition = position;
  }
  deleteRole(roleId: Snowflake): void {
    this.roles.delete(roleId);
    for (const m of this.members.values()) m.roleIds.delete(roleId);
  }

  defineMember(userId: Snowflake, roleIds: Snowflake[] = [], isGuildOwner = false): void {
    this.members.set(userId, { userId, roleIds: new Set(roleIds), isGuildOwner });
  }
  memberRoles(userId: Snowflake): Snowflake[] {
    return [...(this.members.get(userId)?.roleIds ?? [])].sort();
  }

  defineMessage(msg: {
    channelId: Snowflake;
    messageId: Snowflake;
    authorId?: Snowflake;
    cached?: boolean;
  }): void {
    this.messages.set(key(msg.channelId, msg.messageId), {
      channelId: msg.channelId,
      messageId: msg.messageId,
      authorId: msg.authorId ?? '111111111111111111',
      reactions: new Map(),
      cached: msg.cached ?? true,
      deleted: false,
    });
  }
  /** A message outside the client cache. Its events arrive partial. */
  setMessageCached(ref: DiscordMessageRef, cached: boolean): void {
    this.mustMessage(ref).cached = cached;
  }
  deleteMessage(ref: DiscordMessageRef): void {
    this.mustMessage(ref).deleted = true;
  }
  defineAuditLogEntry(entry: AuditLogEntry): void {
    this.auditLog.unshift(entry);
  }

  // ── failure injection ──────────────────────────────────────────────────
  failNext(method: PortMethod, error: DiscordApiError): void {
    this.failures.set(method, { error, remaining: 1 });
  }
  failTimes(method: PortMethod, times: number, error: DiscordApiError): void {
    this.failures.set(method, { error, remaining: times });
  }
  failAlways(method: PortMethod, error: DiscordApiError): void {
    this.failures.set(method, { error, remaining: Number.POSITIVE_INFINITY });
  }
  clearFailures(): void {
    this.failures.clear();
  }

  static rateLimited(retryAfter = 1.5, global = false): DiscordApiError {
    return new DiscordApiError(429, DiscordErrorCode.RateLimited, 'You are being rate limited.', {
      retryAfter,
      global,
    });
  }
  static missingPermissions(): DiscordApiError {
    return new DiscordApiError(403, DiscordErrorCode.MissingPermissions, 'Missing Permissions');
  }
  static unknownMessage(): DiscordApiError {
    return new DiscordApiError(404, DiscordErrorCode.UnknownMessage, 'Unknown Message');
  }
  static unknownMember(): DiscordApiError {
    return new DiscordApiError(404, DiscordErrorCode.UnknownMember, 'Unknown Member');
  }

  // ── inspection ─────────────────────────────────────────────────────────
  restCalls(method?: PortMethod): readonly RestCall[] {
    return method ? this.calls.filter((c) => c.method === method) : this.calls;
  }
  resetCalls(): void {
    this.calls = [];
  }

  onEvent(listener: (e: DomainEvent) => void | Promise<void>): void {
    this.listeners.push(listener);
  }

  // ── gateway ────────────────────────────────────────────────────────────
  async emit(event: DomainEvent): Promise<void> {
    if (!this.connected) return; // offline: the event is lost, not queued
    for (const l of this.listeners) await l(event);
  }

  async emitReactionAdd(p: {
    channelId: Snowflake;
    messageId: Snowflake;
    userId: Snowflake;
    emoji: EmojiKey;
  }): Promise<void> {
    this.applyReaction(p, 'add');
    await this.emitReaction('reactionAdd', p);
  }

  async emitReactionRemove(p: {
    channelId: Snowflake;
    messageId: Snowflake;
    userId: Snowflake;
    emoji: EmojiKey;
  }): Promise<void> {
    this.applyReaction(p, 'remove');
    await this.emitReaction('reactionRemove', p);
  }

  /**
   * Replays an event Discord already delivered. Reconnects do this; it is
   * normal operating condition, not an error case.
   */
  async emitDuplicateReactionAdd(p: {
    channelId: Snowflake;
    messageId: Snowflake;
    userId: Snowflake;
    emoji: EmojiKey;
  }): Promise<void> {
    await this.emitReaction('reactionAdd', p); // state already reflects it
  }

  /**
   * A reaction added while the bot is disconnected. State changes; NO event is
   * emitted, and none is replayed on reconnect. This is the drift that makes
   * reconciliation necessary for adopted panels.
   */
  offlineReactionAdd(p: {
    channelId: Snowflake;
    messageId: Snowflake;
    userId: Snowflake;
    emoji: EmojiKey;
  }): void {
    this.applyReaction(p, 'add');
  }
  offlineReactionRemove(p: {
    channelId: Snowflake;
    messageId: Snowflake;
    userId: Snowflake;
    emoji: EmojiKey;
  }): void {
    this.applyReaction(p, 'remove');
  }

  async emitInteraction(p: {
    channelId: Snowflake;
    messageId: Snowflake;
    userId: Snowflake;
    customId: string;
    values?: readonly string[];
    interactionId?: Snowflake;
  }): Promise<Snowflake> {
    const interactionId = p.interactionId ?? this.nextId();
    await this.emit({
      kind: 'interaction',
      guildId: this.guildId,
      receivedAtMs: this.clock,
      interactionId,
      channelId: p.channelId,
      messageId: p.messageId,
      userId: p.userId,
      customId: p.customId,
      values: p.values,
    });
    return interactionId;
  }

  async emitMemberUpdate(p: {
    userId: Snowflake;
    roleIds: Snowflake[];
    previousRoleIds: Snowflake[];
  }): Promise<void> {
    const m = this.members.get(p.userId);
    if (m) m.roleIds = new Set(p.roleIds);
    await this.emit({
      kind: 'memberUpdate',
      guildId: this.guildId,
      receivedAtMs: this.clock,
      userId: p.userId,
      roleIds: p.roleIds,
      previousRoleIds: p.previousRoleIds,
    });
  }

  disconnect(): void {
    this.connected = false;
    this.disconnectedAtMs = this.clock;
  }

  /**
   * `resumed: true` replays the session buffer, so nothing was missed.
   * `resumed: false` is a fresh IDENTIFY: everything in the gap is gone and is
   * never replayed.
   */
  async reconnect(options: { resumed: boolean }): Promise<void> {
    const disconnectedAtMs = this.disconnectedAtMs;
    this.connected = true;
    await this.emit({
      kind: 'connection',
      guildId: this.guildId,
      receivedAtMs: this.clock,
      resumed: options.resumed,
      disconnectedAtMs,
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ── DiscordPort ────────────────────────────────────────────────────────
  async addRole(
    guildId: Snowflake,
    userId: Snowflake,
    roleId: Snowflake,
    reason: string,
  ): Promise<void> {
    this.record('addRole', [guildId, userId, roleId, reason]);
    this.check('addRole', guildId);
    const member = this.members.get(userId);
    if (!member) throw FakeDiscord.unknownMember();
    if (!this.roles.has(roleId))
      throw new DiscordApiError(404, DiscordErrorCode.UnknownRole, 'Unknown Role');
    // Discord enforces hierarchy server-side and reports it as 50013, which is
    // indistinguishable from a plain permission failure.
    const role = this.roles.get(roleId);
    if (role && (role.position >= this.botPosition || role.managed)) {
      throw FakeDiscord.missingPermissions();
    }
    if (member.isGuildOwner) throw FakeDiscord.missingPermissions();
    member.roleIds.add(roleId);
  }

  async removeRole(
    guildId: Snowflake,
    userId: Snowflake,
    roleId: Snowflake,
    reason: string,
  ): Promise<void> {
    this.record('removeRole', [guildId, userId, roleId, reason]);
    this.check('removeRole', guildId);
    const member = this.members.get(userId);
    if (!member) throw FakeDiscord.unknownMember();
    const role = this.roles.get(roleId);
    if (role && (role.position >= this.botPosition || role.managed)) {
      throw FakeDiscord.missingPermissions();
    }
    member.roleIds.delete(roleId);
  }

  async fetchRoles(guildId: Snowflake): Promise<readonly DiscordRole[]> {
    this.record('fetchRoles', [guildId]);
    this.check('fetchRoles', guildId);
    return [...this.roles.values()].sort((a, b) => b.position - a.position);
  }

  async fetchBotHighestRolePosition(guildId: Snowflake): Promise<number> {
    this.record('fetchBotHighestRolePosition', [guildId]);
    this.check('fetchBotHighestRolePosition', guildId);
    return this.botPosition;
  }

  async fetchMember(guildId: Snowflake, userId: Snowflake): Promise<DiscordMember> {
    this.record('fetchMember', [guildId, userId]);
    this.check('fetchMember', guildId);
    const m = this.members.get(userId);
    if (!m) throw FakeDiscord.unknownMember();
    return { userId: m.userId, roleIds: [...m.roleIds], isGuildOwner: m.isGuildOwner };
  }

  async fetchMessage(guildId: Snowflake, ref: DiscordMessageRef): Promise<{ exists: true }> {
    this.record('fetchMessage', [guildId, ref]);
    this.check('fetchMessage', guildId);
    const m = this.messages.get(key(ref.channelId, ref.messageId));
    if (!m || m.deleted) throw FakeDiscord.unknownMessage();
    m.cached = true; // fetching a partial hydrates it, as discord.js does
    return { exists: true };
  }

  async createReaction(guildId: Snowflake, ref: DiscordMessageRef, emoji: EmojiKey): Promise<void> {
    this.record('createReaction', [guildId, ref, emoji]);
    this.check('createReaction', guildId);
    const m = this.mustMessage(ref);
    if (m.deleted) throw FakeDiscord.unknownMessage();
    const users = m.reactions.get(emoji) ?? [];
    if (!users.includes(BOT_USER_ID)) users.push(BOT_USER_ID);
    m.reactions.set(emoji, users);
  }

  async fetchReactionUsers(
    guildId: Snowflake,
    ref: DiscordMessageRef,
    emoji: EmojiKey,
    options: { after?: Snowflake | undefined; limit?: number | undefined } = {},
  ): Promise<ReactionUserPage> {
    this.record('fetchReactionUsers', [guildId, ref, emoji, options]);
    this.check('fetchReactionUsers', guildId);
    const m = this.mustMessage(ref);
    if (m.deleted) throw FakeDiscord.unknownMessage();

    const all = (m.reactions.get(emoji) ?? []).filter((u) => u !== BOT_USER_ID);
    // Discord caps a page at 100 regardless of what you ask for.
    const limit = Math.min(options.limit ?? 100, 100);
    const start = options.after ? all.indexOf(options.after) + 1 : 0;
    const page = all.slice(start, start + limit);
    const consumed = start + page.length;
    return { userIds: page, nextAfter: consumed < all.length ? page[page.length - 1] : undefined };
  }

  async sendMessage(
    guildId: Snowflake,
    channelId: Snowflake,
    message: OutgoingMessage,
  ): Promise<DiscordMessageRef> {
    this.record('sendMessage', [guildId, channelId, message]);
    this.check('sendMessage', guildId);
    const messageId = this.nextId();
    this.defineMessage({ channelId, messageId, authorId: BOT_USER_ID });
    return { channelId, messageId };
  }

  async editMessage(
    guildId: Snowflake,
    ref: DiscordMessageRef,
    message: OutgoingMessage,
  ): Promise<void> {
    this.record('editMessage', [guildId, ref, message]);
    this.check('editMessage', guildId);
    const m = this.mustMessage(ref);
    if (m.deleted) throw FakeDiscord.unknownMessage();
    // A bot may only edit its own messages. An adopted panel is somebody
    // else's message, so this is the failure that makes adopted panels
    // reaction-only.
    if (m.authorId !== BOT_USER_ID) throw FakeDiscord.missingPermissions();
  }

  async fetchAuditLog(
    guildId: Snowflake,
    options: { actionType: AuditLogEntry['actionType']; limit?: number | undefined },
  ): Promise<readonly AuditLogEntry[]> {
    this.record('fetchAuditLog', [guildId, options]);
    this.check('fetchAuditLog', guildId);
    return this.auditLog
      .filter((e) => e.actionType === options.actionType)
      .slice(0, options.limit ?? 50);
  }

  async leaveGuild(guildId: Snowflake): Promise<void> {
    this.record('leaveGuild', [guildId]);
    this.check('leaveGuild', guildId, { allowForeignGuild: true });
  }

  // ── internals ──────────────────────────────────────────────────────────
  private record(method: PortMethod, args: readonly unknown[]): void {
    this.calls.push({ method, args, atMs: this.clock });
  }

  private check(
    method: PortMethod,
    guildId: Snowflake,
    opts: { allowForeignGuild?: boolean } = {},
  ): void {
    if (!opts.allowForeignGuild && guildId !== this.guildId) {
      // Guild scope is a partition key. Reaching another guild is a bug, and
      // the fake refuses rather than quietly answering.
      throw new Error(`fake is scoped to guild ${this.guildId}, got ${guildId}`);
    }
    const f = this.failures.get(method);
    if (!f) return;
    f.remaining -= 1;
    if (f.remaining <= 0) this.failures.delete(method);
    throw f.error;
  }

  private mustMessage(ref: DiscordMessageRef): FakeMessage {
    const m = this.messages.get(key(ref.channelId, ref.messageId));
    if (!m) throw FakeDiscord.unknownMessage();
    return m;
  }

  private applyReaction(
    p: { channelId: Snowflake; messageId: Snowflake; userId: Snowflake; emoji: EmojiKey },
    op: 'add' | 'remove',
  ): void {
    const m = this.mustMessage(p);
    const users = m.reactions.get(p.emoji) ?? [];
    const i = users.indexOf(p.userId);
    if (op === 'add' && i === -1) users.push(p.userId);
    if (op === 'remove' && i !== -1) users.splice(i, 1);
    m.reactions.set(p.emoji, users);
  }

  private async emitReaction(
    kind: 'reactionAdd' | 'reactionRemove',
    p: { channelId: Snowflake; messageId: Snowflake; userId: Snowflake; emoji: EmojiKey },
  ): Promise<void> {
    const m = this.messages.get(key(p.channelId, p.messageId));
    await this.emit({
      kind,
      guildId: this.guildId,
      receivedAtMs: this.clock,
      channelId: p.channelId,
      messageId: p.messageId,
      userId: p.userId,
      emoji: p.emoji,
      wasPartial: m ? !m.cached : true,
    });
  }
}

export const BOT_USER_ID = '999999999999999999';

function key(channelId: Snowflake, messageId: Snowflake): string {
  return `${channelId}/${messageId}`;
}
