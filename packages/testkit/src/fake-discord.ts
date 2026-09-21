import {
  DiscordApiError,
  DiscordErrorCode,
  type AuditLogEntry,
  type DiscordMember,
  type DiscordMessageRef,
  type DiscordPort,
  type DiscordThread,
  type DiscordRole,
  type DomainEvent,
  type InteractionRef,
  type EmojiKey,
  type FetchedMessage,
  type NativeAutoModAction,
  type NativeAutoModTrigger,
  type OutgoingMessage,
  type ReactionUserPage,
  type RecentMessagesPage,
  type Snowflake,
} from '@bananasaurs/core';

/** Discord's epoch, which every snowflake timestamp is an offset from. */
const DISCORD_EPOCH_MS = 1_420_070_400_000;

/**
 * `MessageAttachment` is not among `@bananasaurs/core`'s public exports (only
 * the union types that carry it — `DomainEvent`, `FetchedMessage` — are), so
 * it is derived structurally from `FetchedMessage` rather than adding an
 * export outside this file's remit.
 */
type FakeAttachment = NonNullable<FetchedMessage['attachments']>[number];

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
  /** Last-known content, for `fetchRecentMessages` (ADR 0037). */
  content: string | undefined;
  /** Last-known edit timestamp, for `fetchRecentMessages` (PR-68). */
  editedTimestampMs: number | undefined;
  /** Metadata only, for `fetchRecentMessages` (PR-68). */
  attachments: FakeAttachment[];
}

/**
 * How long an audit log entry takes to appear after the action (ADR 0019 §3).
 *
 * The gateway dispatch beats the entry, every time. The exact figure is not
 * documented and is not the point: what the fake has to model is that a fetch
 * issued on receipt of the delete finds nothing, so that no code can be
 * written that assumes otherwise.
 */
export const AUDIT_LOG_LAG_MS = 2_000;

/**
 * How long a MESSAGE_DELETE run stays open to further deletions (ADR 0019 §2).
 *
 * Sliding: each deletion that joins the run extends it. Discord does not
 * document the real window, and this is a chosen approximation — but the
 * behaviour it exists to reproduce is not approximate. A run's entry keeps the
 * timestamp it was minted with while its count goes on rising, so an entry
 * whose count changed a second ago can sit arbitrarily far down a log ordered
 * by id.
 */
export const AUDIT_LOG_COALESCE_WINDOW_MS = 60_000;

/**
 * An audit log entry plus the two things Discord never shows: when it becomes
 * visible, and when its run was last extended.
 */
interface FakeAuditEntry extends AuditLogEntry {
  availableAtMs: number;
  lastActionAtMs: number;
}

interface FakeInteraction {
  token: string;
  createdAtMs: number;
  deferred: boolean;
  ephemeral: boolean;
  replies: OutgoingMessage[];
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

/**
 * A GUILD_MEMBER_UPDATE that Discord would dispatch because a role changed.
 *
 * Discord fires it for *every* role change, including ones this bot just made
 * over REST — which is the whole reason amendment 5's self-mutation filter
 * exists. Modelling only the human-made ones would make the fake agree with a
 * broken implementation.
 *
 * Queued rather than emitted inline, because the real event arrives over the
 * gateway *after* the REST call returns, not during it. Emitting synchronously
 * inside `addRole` would re-enter the pipeline from the middle of the effect
 * gateway's execute step — an ordering that cannot happen against Discord, and
 * one that would make a passing test meaningless.
 */
interface MemberUpdateEcho {
  userId: Snowflake;
  roleIds: Snowflake[];
  previousRoleIds: Snowflake[];
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
  /**
   * What `timeoutMember`/`kickMember` most recently did to a member.
   *
   * Mirrors the `members` map's role: state the port methods mutate and tests
   * read back through an inspector, the same shape as `memberRoles`.
   */
  private moderationState = new Map<Snowflake, { until: number } | 'kicked'>();
  private messages = new Map<string, FakeMessage>();
  /** Guild bans, for `banMember`/`unbanMember` (ADR 0037). */
  private bans = new Set<Snowflake>();
  private auditLog: FakeAuditEntry[] = [];
  private botPosition: number;

  private interactions = new Map<Snowflake, FakeInteraction>();
  private failures = new Map<PortMethod, Failure>();
  private calls: RestCall[] = [];
  private listeners: Array<(e: DomainEvent) => void | Promise<void>> = [];

  private pendingEchoes: MemberUpdateEcho[] = [];

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
  /** What `timeoutMember`/`kickMember` most recently did to this member, if anything. */
  memberModerationState(userId: Snowflake): { until: number } | 'kicked' | undefined {
    return this.moderationState.get(userId);
  }
  /** Whether `banMember` has banned this user and `unbanMember` not lifted it. */
  isBanned(userId: Snowflake): boolean {
    return this.bans.has(userId);
  }

  defineMessage(msg: {
    channelId: Snowflake;
    messageId: Snowflake;
    authorId?: Snowflake;
    cached?: boolean;
    content?: string | undefined;
    editedTimestampMs?: number | undefined;
    attachments?: ReadonlyArray<{
      attachmentId: Snowflake;
      fileName: string;
      contentType?: string | undefined;
      sizeBytes: number;
    }>;
  }): void {
    this.messages.set(key(msg.channelId, msg.messageId), {
      channelId: msg.channelId,
      messageId: msg.messageId,
      authorId: msg.authorId ?? '111111111111111111',
      reactions: new Map(),
      cached: msg.cached ?? true,
      deleted: false,
      content: msg.content,
      editedTimestampMs: msg.editedTimestampMs,
      attachments: (msg.attachments ?? []).map((a) => ({
        attachmentId: a.attachmentId,
        fileName: a.fileName,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
      })),
    });
  }
  /** A message outside the client cache. Its events arrive partial. */
  setMessageCached(ref: DiscordMessageRef, cached: boolean): void {
    this.mustMessage(ref).cached = cached;
  }
  /**
   * Marks a message gone without going through the `DiscordPort` method or
   * emitting anything — for tests setting up "this message is already
   * deleted" world state (e.g. an out-of-band deletion discovered on
   * reconciliation), as distinct from `deleteMessage`, the port method a
   * caller under test invokes to delete one.
   */
  simulateDeletedMessage(ref: DiscordMessageRef): void {
    this.mustMessage(ref).deleted = true;
  }
  /**
   * Place an entry directly, for the action types the fake has no verb for.
   * Subject to the same lag as any other: it is not visible until the clock
   * has moved past `AUDIT_LOG_LAG_MS`.
   */
  defineAuditLogEntry(entry: Partial<AuditLogEntry> & Pick<AuditLogEntry, 'actionType'>): void {
    const createdAtMs = entry.createdAtMs ?? this.clock;
    this.auditLog.push({
      actorUserId: entry.actorUserId,
      targetId: entry.targetId,
      actionType: entry.actionType,
      createdAtMs,
      reason: entry.reason,
      count: entry.count,
      channelId: entry.channelId,
      availableAtMs: createdAtMs + AUDIT_LOG_LAG_MS,
      lastActionAtMs: createdAtMs,
    });
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
  static unknownInteraction(): DiscordApiError {
    return new DiscordApiError(404, DiscordErrorCode.UnknownInteraction, 'Unknown interaction');
  }
  /** Confirmed live: `scripts/seed-test-panel.mjs --emoji 🅲` produced exactly this. */
  static unknownEmoji(): DiscordApiError {
    return new DiscordApiError(400, DiscordErrorCode.UnknownEmoji, 'Unknown Emoji');
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

  /**
   * MESSAGE_CREATE. Exists for later tasks' keyword-filter subscriber (the
   * automod rule engine): it needs new messages arriving through the same
   * `DomainEvent` stream as everything else, not a bespoke path.
   */
  async emitMessageCreate(p: {
    channelId: Snowflake;
    parentChannelId?: Snowflake;
    categoryId?: Snowflake;
    isPrivateThread?: boolean;
    messageId: Snowflake;
    authorId: Snowflake;
    content: string;
    /** Defaults to the bot's own id being the only bot in the fixture. */
    authorIsBot?: boolean;
    /** Every attachment on a `messageCreate` carries an id (PR-71). */
    attachments?: ReadonlyArray<{
      attachmentId: Snowflake;
      fileName: string;
      contentType?: string | undefined;
      sizeBytes: number;
    }>;
  }): Promise<void> {
    const attachments: FakeAttachment[] = (p.attachments ?? []).map((a) => ({
      attachmentId: a.attachmentId,
      fileName: a.fileName,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
    }));
    await this.emit({
      kind: 'messageCreate',
      guildId: this.guildId,
      receivedAtMs: this.clock,
      channelId: p.channelId,
      parentChannelId: p.parentChannelId,
      categoryId: p.categoryId,
      isPrivateThread: p.isPrivateThread ?? false,
      messageId: p.messageId,
      authorId: p.authorId,
      authorIsBot: p.authorIsBot ?? p.authorId === BOT_USER_ID,
      content: p.content,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [],
      mentionsEveryone: false,
      attachments,
    });
  }

  /**
   * MESSAGE_UPDATE: an edit. Updates the fake's own record of the message so
   * `fetchRecentMessages` agrees with the event just emitted, the same
   * contract `deleteMessageAs` keeps for deletion.
   */
  async emitMessageUpdate(p: {
    channelId: Snowflake;
    parentChannelId?: Snowflake;
    categoryId?: Snowflake;
    isPrivateThread?: boolean;
    messageId: Snowflake;
    authorId: Snowflake;
    content: string;
    editedTimestampMs: number;
  }): Promise<void> {
    const m = this.mustMessage(p);
    m.content = p.content;
    m.editedTimestampMs = p.editedTimestampMs;
    await this.emit({
      kind: 'messageUpdate',
      guildId: this.guildId,
      receivedAtMs: this.clock,
      channelId: p.channelId,
      parentChannelId: p.parentChannelId,
      categoryId: p.categoryId,
      isPrivateThread: p.isPrivateThread ?? false,
      messageId: p.messageId,
      authorId: p.authorId,
      authorIsBot: p.authorId === BOT_USER_ID,
      content: p.content,
      editedTimestampMs: p.editedTimestampMs,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [],
      mentionsEveryone: false,
      attachments: m.attachments,
    });
  }

  /**
   * MESSAGE_DELETE, the raw gateway event (not the moderation action
   * `deleteMessage`/`deleteMessageAs` drive — no audit log entry is written
   * here). `authorId` is optional the same way `deleteMessageAs`'s own event
   * body is: an uncached message names nobody.
   */
  async emitMessageDelete(p: {
    channelId: Snowflake;
    parentChannelId?: Snowflake;
    categoryId?: Snowflake;
    isPrivateThread?: boolean;
    messageId: Snowflake;
    authorId?: Snowflake;
  }): Promise<void> {
    const existing = this.messages.get(key(p.channelId, p.messageId));
    if (existing) existing.deleted = true;
    const authorId = p.authorId ?? (existing?.cached ? existing.authorId : undefined);
    await this.emit({
      kind: 'messageDelete',
      guildId: this.guildId,
      receivedAtMs: this.clock,
      channelId: p.channelId,
      parentChannelId: p.parentChannelId,
      categoryId: p.categoryId,
      isPrivateThread: p.isPrivateThread ?? false,
      messageId: p.messageId,
      authorId,
      authorIsBot: authorId === BOT_USER_ID,
      content: undefined,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [],
      mentionsEveryone: false,
      attachments: [],
    });
  }

  /**
   * MESSAGE_DELETE_BULK (PR-66): one event naming every id Discord named.
   * Marks each as deleted in the fake's own record, the same as a run of
   * `emitMessageDelete` would, but as the single dispatch Discord actually
   * sends.
   */
  async emitMessageDeleteBulk(p: {
    channelId: Snowflake;
    parentChannelId?: Snowflake;
    categoryId?: Snowflake;
    isPrivateThread?: boolean;
    messageIds: readonly Snowflake[];
  }): Promise<void> {
    for (const messageId of p.messageIds) {
      const m = this.messages.get(key(p.channelId, messageId));
      if (m) m.deleted = true;
    }
    await this.emit({
      kind: 'messageDeleteBulk',
      guildId: this.guildId,
      receivedAtMs: this.clock,
      channelId: p.channelId,
      parentChannelId: p.parentChannelId,
      categoryId: p.categoryId,
      isPrivateThread: p.isPrivateThread ?? false,
      messageIds: p.messageIds,
    });
  }

  /**
   * AUTO_MODERATION_ACTION_EXECUTION (ADR 0038). Defaults describe the common
   * case: a keyword rule that *blocked* the message, so Discord supplies no
   * message id — which is exactly the case the fingerprint has to handle
   * without one.
   */
  async emitAutoModerationAction(p: {
    ruleId: Snowflake;
    userId: Snowflake;
    actionType?: NativeAutoModAction;
    triggerType?: NativeAutoModTrigger;
    channelId?: Snowflake;
    messageId?: Snowflake;
    alertMessageId?: Snowflake;
    content?: string;
    matchedKeyword?: string;
    matchedContent?: string;
  }): Promise<void> {
    await this.emit({
      kind: 'autoModerationAction',
      guildId: this.guildId,
      receivedAtMs: this.clock,
      ruleId: p.ruleId,
      triggerType: p.triggerType ?? 'keyword',
      userId: p.userId,
      actionType: p.actionType ?? 'block',
      channelId: p.channelId,
      messageId: p.messageId,
      alertMessageId: p.alertMessageId,
      content: p.content ?? '',
      matchedKeyword: p.matchedKeyword,
      matchedContent: p.matchedContent,
    });
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

  /**
   * Records an interaction Discord has minted, without emitting anything.
   *
   * `emitInteraction` does this for itself, and for a component interaction
   * that is all anyone needs. A test that drives the **real gateway translation
   * layer** — pushing a raw `INTERACTION_CREATE` packet through
   * `client.actions` rather than calling `emit` — produces the domain event by
   * a path this fake never sees, so the interaction would be unknown to it and
   * the first `deferInteraction` would throw `UnknownInteraction`.
   *
   * That is a gap in the fake, not a fact about Discord: Discord knows an
   * interaction exists because it minted the id and the token, whatever route
   * the dispatch took to reach the bot. Added for `/status` (WP5 slice 15),
   * whose whole point is being reached through translation.
   *
   * Idempotent, so re-registering a replayed interaction does not reset its
   * clock or discard the replies already recorded against it.
   */
  registerInteraction(p: { interactionId: Snowflake; token: string }): void {
    if (this.interactions.has(p.interactionId)) return;
    this.interactions.set(p.interactionId, {
      token: p.token,
      createdAtMs: this.clock,
      deferred: false,
      ephemeral: false,
      replies: [],
    });
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
    const token = `tok-${interactionId}`;
    // Recorded before the emit, because the handler responds during it.
    this.registerInteraction({ interactionId, token });
    await this.emit({
      kind: 'interaction',
      guildId: this.guildId,
      receivedAtMs: this.clock,
      interactionId,
      token,
      channelId: p.channelId,
      messageId: p.messageId,
      userId: p.userId,
      customId: p.customId,
      values: p.values,
    });
    return interactionId;
  }

  /** What the member actually saw, and whether only they saw it. */
  interactionReplies(interactionId: Snowflake): readonly OutgoingMessage[] {
    return this.interactions.get(interactionId)?.replies ?? [];
  }
  wasDeferred(interactionId: Snowflake): boolean {
    return this.interactions.get(interactionId)?.deferred ?? false;
  }
  wasEphemeral(interactionId: Snowflake): boolean {
    return this.interactions.get(interactionId)?.ephemeral ?? false;
  }

  /**
   * GUILD_MEMBER_UPDATE.
   *
   * `previousRoleIds` is `undefined` when discord.js had no cached copy of the
   * member to diff against, which is routine on a live gateway and is what the
   * adapter reports (`packages/discord/src/events.ts`, `before.partial`). The
   * key is required rather than optional so that passing `undefined` is a
   * decision: unknown and empty are different facts, and code that confuses
   * them revokes roles it has no evidence about.
   */
  async emitMemberUpdate(p: {
    userId: Snowflake;
    roleIds: Snowflake[];
    previousRoleIds: Snowflake[] | undefined;
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
      // GUILD_MEMBER_UPDATE carries the member object, so joined_at is present
      // on the wire. It is unused for this kind — memberUpdate is
      // level-triggered and carries no fingerprint — but omitting it here
      // would make the fake diverge from what the adapter will produce.
      joinedAtMs: undefined,
    });
  }

  /** How many GUILD_MEMBER_UPDATE dispatches are waiting to be delivered. */
  pendingMemberUpdates(): number {
    return this.pendingEchoes.length;
  }

  /**
   * Delivers the GUILD_MEMBER_UPDATE dispatches queued by role changes.
   *
   * A test that never calls this is a test where the gateway subscription is
   * not the thing under examination; the queue still holds what Discord would
   * have sent, so `pendingMemberUpdates()` can assert the count without
   * pretending the events do not exist.
   */
  async flushMemberUpdates(): Promise<number> {
    let delivered = 0;
    // Draining in a loop rather than iterating a snapshot: handling an echo can
    // cause another role change, which is exactly the feedback loop amendment 5
    // is about. A loop makes a runaway visible as a hang or a huge count rather
    // than quietly stopping after one round.
    while (this.pendingEchoes.length > 0 && delivered < 1000) {
      const echo = this.pendingEchoes.shift();
      if (echo === undefined) break;
      delivered += 1;
      await this.emit({
        kind: 'memberUpdate',
        guildId: this.guildId,
        receivedAtMs: this.clock,
        userId: echo.userId,
        roleIds: echo.roleIds,
        previousRoleIds: echo.previousRoleIds,
        joinedAtMs: undefined,
      });
    }
    return delivered;
  }

  /** GUILD_MEMBER_ADD. `joinedAtMs` is what fingerprints it. */
  async emitMemberAdd(p: {
    userId: Snowflake;
    roleIds?: Snowflake[];
    joinedAtMs?: number;
  }): Promise<void> {
    await this.emit({
      kind: 'memberAdd',
      guildId: this.guildId,
      receivedAtMs: this.clock,
      userId: p.userId,
      roleIds: p.roleIds ?? [],
      previousRoleIds: undefined,
      joinedAtMs: p.joinedAtMs ?? this.clock,
    });
  }

  /**
   * GUILD_MEMBER_REMOVE. `joinedAtMs` is frequently absent on the wire, which
   * is why the fingerprint has a time-bucket fallback at all — leaving it
   * undefined here is the realistic case, not a shortcut.
   */
  async emitMemberRemove(p: { userId: Snowflake; joinedAtMs?: number }): Promise<void> {
    await this.emit({
      kind: 'memberRemove',
      guildId: this.guildId,
      receivedAtMs: this.clock,
      userId: p.userId,
      roleIds: [],
      previousRoleIds: undefined,
      joinedAtMs: p.joinedAtMs,
    });
  }

  /**
   * Someone deletes a message: the dispatch now, the audit log entry later.
   *
   * All four of ADR 0019's facts live here, because all four of them are
   * consequences of this one act. The delete event goes out immediately and
   * carries no actor — it never does, that is the whole reason WP4 has to
   * consult the audit log. The entry, if there is one, becomes visible
   * `AUDIT_LOG_LAG_MS` later, is keyed on the message's *author* rather than
   * the message, joins an open run by the same actor rather than standing
   * alone, and does not exist at all when the author deleted their own message.
   */
  async deleteMessageAs(p: {
    channelId: Snowflake;
    messageId: Snowflake;
    actorUserId: Snowflake;
    reason?: string | undefined;
  }): Promise<void> {
    const message = this.mustMessage(p);
    message.deleted = true;

    // A member deleting their own message writes nothing. "No entry" and "not
    // yet" are indistinguishable at the moment of the fetch, and only one of
    // them is safe to assert.
    if (p.actorUserId !== message.authorId) {
      const run = this.auditLog.find(
        (e) =>
          e.actionType === 'message_delete' &&
          e.actorUserId === p.actorUserId &&
          e.targetId === message.authorId &&
          e.channelId === p.channelId &&
          this.clock - e.lastActionAtMs <= AUDIT_LOG_COALESCE_WINDOW_MS,
      );
      if (run) {
        // Only the count moves. Not the id, not the timestamp, not the
        // position in the log.
        run.count = (run.count ?? 0) + 1;
        run.lastActionAtMs = this.clock;
      } else {
        this.defineAuditLogEntry({
          actionType: 'message_delete',
          actorUserId: p.actorUserId,
          targetId: message.authorId,
          channelId: p.channelId,
          count: 1,
          reason: p.reason,
        });
      }
    }

    await this.emit({
      kind: 'messageDelete',
      guildId: this.guildId,
      receivedAtMs: this.clock,
      channelId: p.channelId,
      parentChannelId: undefined,
      categoryId: undefined,
      isPrivateThread: false,
      messageId: p.messageId,
      // MESSAGE_DELETE carries id, channel and guild and nothing else.
      // discord.js fills the author in from its cache when it has one, so an
      // uncached message names nobody.
      authorId: message.cached ? message.authorId : undefined,
      authorIsBot: message.cached && message.authorId === BOT_USER_ID,
      content: undefined,
      editedTimestampMs: undefined,
      mentionedUserIds: [],
      authorRoleIds: [],
      mentionedRoleIds: [],
      mentionsEveryone: false,
      attachments: [],
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
    const before = [...member.roleIds];
    member.roleIds.add(roleId);
    if (member.roleIds.size !== before.length) {
      this.pendingEchoes.push({ userId, roleIds: [...member.roleIds], previousRoleIds: before });
    }
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
    const before = [...member.roleIds];
    if (member.roleIds.delete(roleId)) {
      this.pendingEchoes.push({ userId, roleIds: [...member.roleIds], previousRoleIds: before });
    }
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

    // The bot is NOT filtered out. Discord's GET /reactions returns every user
    // who reacted, bot accounts included — there is no server-side exclusion.
    // Filtering here would have hidden a real bug class: the adoption pass must
    // drop its own seeded reactions itself, or it grants the bot every role on
    // the panel it just seeded. WP1 modelled this the other way and a WP3
    // mutation check found it, because removing the application's filter
    // changed nothing.
    const all = m.reactions.get(emoji) ?? [];
    // Discord caps a page at 100 regardless of what you ask for.
    const limit = Math.min(options.limit ?? 100, 100);
    const start = options.after ? all.indexOf(options.after) + 1 : 0;
    const page = all.slice(start, start + limit);
    // A FULL page always yields a cursor, even when it happens to have
    // exhausted the reactors. Discord's GET /reactions returns users and
    // nothing else — no total, no "has more" — so no adapter over the real API
    // can know it has finished until it asks again and gets an empty page.
    // This fake previously answered `undefined` early, because it can see the
    // whole array; that let a caller look correct while depending on knowledge
    // real Discord never sends. Found in WP5 slice 6b while writing the
    // adapter's own pagination.
    return { userIds: page, nextAfter: page.length === limit ? page[page.length - 1] : undefined };
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

  /**
   * Not hierarchy-gated (ADR 0035): a bot with Manage Messages can delete any
   * member's message, owner included, so unlike `timeoutMember`/`kickMember`
   * this never consults `this.check`'s hierarchy machinery — it does the same
   * existence/already-deleted check `editMessage` does, then reuses the same
   * assignment `simulateDeletedMessage` uses to mark a message gone.
   */
  async deleteMessage(guildId: Snowflake, ref: DiscordMessageRef, reason: string): Promise<void> {
    this.record('deleteMessage', [guildId, ref, reason]);
    this.check('deleteMessage', guildId);
    const m = this.mustMessage(ref);
    if (m.deleted) throw FakeDiscord.unknownMessage();
    m.deleted = true;
  }

  /**
   * Hierarchy-gated the same way `addRole`/`removeRole` are: the guild owner
   * can never be timed out by any bot, and nobody can act on a member whose
   * highest role sits at or above the bot's own role position (ADR 0035).
   */
  async timeoutMember(
    guildId: Snowflake,
    userId: Snowflake,
    durationMs: number,
    reason: string,
  ): Promise<void> {
    this.record('timeoutMember', [guildId, userId, durationMs, reason]);
    this.check('timeoutMember', guildId);
    const member = this.members.get(userId);
    if (!member) throw FakeDiscord.unknownMember();
    if (member.isGuildOwner || this.highestRolePosition(member) >= this.botPosition) {
      throw FakeDiscord.missingPermissions();
    }
    this.moderationState.set(userId, { until: this.clock + durationMs });
  }

  /** Hierarchy-gated the same way `timeoutMember` is; see there. */
  async kickMember(guildId: Snowflake, userId: Snowflake, reason: string): Promise<void> {
    this.record('kickMember', [guildId, userId, reason]);
    this.check('kickMember', guildId);
    const member = this.members.get(userId);
    if (!member) throw FakeDiscord.unknownMember();
    if (member.isGuildOwner || this.highestRolePosition(member) >= this.botPosition) {
      throw FakeDiscord.missingPermissions();
    }
    this.moderationState.set(userId, 'kicked');
    // A kick removes the member from the guild, same as Discord.
    this.members.delete(userId);
  }

  /**
   * Removes a member's timeout by clearing the state, hierarchy-gated exactly
   * like `timeoutMember` — Discord gates the PATCH by role position the same
   * way, whatever the gateway decided, so the fake refuses what Discord would.
   */
  async untimeoutMember(guildId: Snowflake, userId: Snowflake, reason: string): Promise<void> {
    this.record('untimeoutMember', [guildId, userId, reason]);
    this.check('untimeoutMember', guildId);
    const member = this.members.get(userId);
    if (!member) throw FakeDiscord.unknownMember();
    if (member.isGuildOwner || this.highestRolePosition(member) >= this.botPosition) {
      throw FakeDiscord.missingPermissions();
    }
    this.moderationState.delete(userId);
  }

  /**
   * Hierarchy-gated exactly like `kickMember` for a member still in the
   * guild: the owner can never be banned and a member at or above the bot
   * cannot be. A user who has already left CAN be banned by id — Discord
   * allows it, and there is no member record to compare roles against — so
   * an absent member is banned without a hierarchy check.
   */
  async banMember(guildId: Snowflake, userId: Snowflake, reason: string): Promise<void> {
    this.record('banMember', [guildId, userId, reason]);
    this.check('banMember', guildId);
    const member = this.members.get(userId);
    if (member) {
      if (member.isGuildOwner || this.highestRolePosition(member) >= this.botPosition) {
        throw FakeDiscord.missingPermissions();
      }
      // A ban removes the member from the guild, same as Discord.
      this.members.delete(userId);
    }
    this.bans.add(userId);
    this.defineAuditLogEntry({
      actionType: 'member_ban',
      actorUserId: BOT_USER_ID,
      targetId: userId,
      reason,
    });
  }

  /**
   * Not hierarchy-gated (ADR 0037): the target is not a member, so there is
   * nothing to compare. Lifting a ban that does not exist is a no-op, the
   * way Discord treats it.
   */
  async unbanMember(guildId: Snowflake, userId: Snowflake, reason: string): Promise<void> {
    this.record('unbanMember', [guildId, userId, reason]);
    this.check('unbanMember', guildId);
    this.bans.delete(userId);
  }

  /**
   * Discord rejects the ENTIRE call if any message is 14 days old or older,
   * and accepts 2..100 ids. Modelled, not approximated: a caller that sends
   * a mixed batch gets the same 400 real Discord returns, because the whole
   * point of the fresh/old split in the purge is that this refusal exists.
   * Age comes from the snowflake — the same derivation the REST port uses
   * for `fetchRecentMessages` timestamps.
   */
  async bulkDeleteMessages(
    guildId: Snowflake,
    channelId: Snowflake,
    messageIds: readonly Snowflake[],
    reason: string,
  ): Promise<void> {
    this.record('bulkDeleteMessages', [guildId, channelId, messageIds, reason]);
    this.check('bulkDeleteMessages', guildId);
    if (messageIds.length < 2 || messageIds.length > 100) {
      throw new DiscordApiError(400, undefined, 'bulk delete accepts 2..100 messages');
    }
    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
    for (const messageId of messageIds) {
      const createdAtMs = Number((BigInt(messageId) >> 22n) + BigInt(DISCORD_EPOCH_MS));
      if (this.clock - createdAtMs >= fourteenDaysMs) {
        throw new DiscordApiError(
          400,
          undefined,
          'You can only bulk delete messages that are under 14 days old',
        );
      }
    }
    for (const messageId of messageIds) {
      const m = this.messages.get(key(channelId, messageId));
      if (m) m.deleted = true;
    }
  }

  /**
   * Recent messages in a channel, newest first by snowflake, excluding
   * deleted ones — the shape the purge preview and the purge job page over.
   * A full page yields a cursor for the same reason `fetchReactionUsers`
   * does: Discord never says "that was the last page".
   */
  async fetchRecentMessages(
    guildId: Snowflake,
    channelId: Snowflake,
    options: { before?: Snowflake | undefined; limit?: number | undefined } = {},
  ): Promise<RecentMessagesPage> {
    this.record('fetchRecentMessages', [guildId, channelId, options]);
    this.check('fetchRecentMessages', guildId);
    const limit = Math.min(options.limit ?? 50, 100);
    const all = [...this.messages.values()]
      .filter((m) => m.channelId === channelId && !m.deleted)
      .filter((m) => options.before === undefined || BigInt(m.messageId) < BigInt(options.before))
      .sort((a, b) => (BigInt(b.messageId) > BigInt(a.messageId) ? 1 : -1))
      .slice(0, limit)
      .map((m) => ({
        messageId: m.messageId,
        authorId: m.authorId,
        createdAtMs: Number((BigInt(m.messageId) >> 22n) + BigInt(DISCORD_EPOCH_MS)),
        content: m.content,
        editedTimestampMs: m.editedTimestampMs,
        attachments: m.attachments ?? [],
      }));
    const last = all.length > 0 ? all[all.length - 1] : undefined;
    return {
      messages: all,
      nextBefore: all.length === limit && last !== undefined ? last.messageId : undefined,
    };
  }

  async listPublicThreads(
    guildId: Snowflake,
    channelId: Snowflake,
  ): Promise<readonly DiscordThread[]> {
    this.record('listPublicThreads', [guildId, channelId]);
    this.check('listPublicThreads', guildId);
    return [];
  }

  /**
   * Three seconds. Discord discards the token rather than queueing, so being
   * late is unrecoverable and the member sees "This interaction failed".
   */
  async deferInteraction(
    guildId: Snowflake,
    ref: InteractionRef,
    options: { ephemeral: boolean },
  ): Promise<void> {
    this.record('deferInteraction', [guildId, { interactionId: ref.interactionId }, options]);
    this.check('deferInteraction', guildId);
    const state = this.mustInteraction(ref);
    if (this.clock - state.createdAtMs > ACK_DEADLINE_MS) {
      throw FakeDiscord.unknownInteraction();
    }
    state.deferred = true;
    state.ephemeral = options.ephemeral;
  }

  async respondToInteraction(
    guildId: Snowflake,
    ref: InteractionRef,
    message: OutgoingMessage,
  ): Promise<void> {
    this.record('respondToInteraction', [guildId, { interactionId: ref.interactionId }, message]);
    this.check('respondToInteraction', guildId);
    const state = this.mustInteraction(ref);
    const age = this.clock - state.createdAtMs;
    // Undeferred, the initial-response window still applies. Deferred, there
    // are fifteen minutes to follow up.
    if (!state.deferred && age > ACK_DEADLINE_MS) throw FakeDiscord.unknownInteraction();
    if (age > FOLLOWUP_DEADLINE_MS) throw FakeDiscord.unknownInteraction();
    state.replies.push(message);
  }

  async fetchAuditLog(
    guildId: Snowflake,
    options: { actionType: AuditLogEntry['actionType']; limit?: number | undefined },
  ): Promise<readonly AuditLogEntry[]> {
    this.record('fetchAuditLog', [guildId, options]);
    this.check('fetchAuditLog', guildId);
    return (
      this.auditLog
        .filter((e) => e.actionType === options.actionType && e.availableAtMs <= this.clock)
        // Discord orders by entry id, which is minted once. A coalesced entry
        // therefore does not rise to the top when its count changes.
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .slice(0, options.limit ?? 50)
        .map(
          ({ availableAtMs: _availableAtMs, lastActionAtMs: _lastActionAtMs, ...entry }) => entry,
        )
    );
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

  private mustInteraction(ref: InteractionRef): FakeInteraction {
    const state = this.interactions.get(ref.interactionId);
    if (!state) throw FakeDiscord.unknownInteraction();
    // A wrong token is a wrong interaction as far as Discord is concerned.
    if (state.token !== ref.token) throw FakeDiscord.unknownInteraction();
    return state;
  }

  private mustMessage(ref: DiscordMessageRef): FakeMessage {
    const m = this.messages.get(key(ref.channelId, ref.messageId));
    if (!m) throw FakeDiscord.unknownMessage();
    return m;
  }

  /** The position of the member's highest role, or 0 (`@everyone`) if none. */
  private highestRolePosition(member: FakeMember): number {
    let highest = 0;
    for (const roleId of member.roleIds) {
      const role = this.roles.get(roleId);
      if (role && role.position > highest) highest = role.position;
    }
    return highest;
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

/** Discord's initial-response window. Missing it discards the token. */
export const ACK_DEADLINE_MS = 3_000;
/** How long a deferred interaction may be followed up. */
export const FOLLOWUP_DEADLINE_MS = 15 * 60_000;

function key(channelId: Snowflake, messageId: Snowflake): string {
  return `${channelId}/${messageId}`;
}
