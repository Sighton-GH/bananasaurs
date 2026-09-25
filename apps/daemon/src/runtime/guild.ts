import { randomUUID } from 'node:crypto';
import { ChannelType, type Client } from 'discord.js';
import {
  createConnectionSubscriber,
  editManagedPanel,
  postManagedPanel,
  seedPanelReactions,
  archiveBackfillDedupeKey,
  archiveBackfillHandler,
  archiveExpiryHandler,
  createArchiveSubscriber,
  createAutomodSubscriber,
  createInteractionSubscriber,
  createLoggingSubscriber,
  createMemberUpdateSubscriber,
  createModCommandSubscriber,
  createModConfirmationSubscriber,
  createNativeAutomodSubscriber,
  createReactionSubscriber,
  EffectGateway,
  JobWorker,
  JOB_KINDS,
  ModerationActionGateway,
  parseGuildId,
  parseSnowflakeId,
  RateLimiter,
  type AdoptionPorts,
  type ArchivePorts,
  type BackfillPorts,
  type Config,
  type DiscordPort,
  type EffectGatewayDeps,
  type HistoryDeps,
  type InteractionSubscriberDeps,
  type Logger,
  type LoggingPorts,
  type MemberUpdatePorts,
  type MessageDeleteAttributionPorts,
  type ModCommandDeps,
  type ModConfirmationDeps,
  type ModerationGatewayDeps,
  type ModerationRefusalReason,
  type NativeAutomodSubscriberDeps,
  type OpsPublishResult,
  type PanelDefinition,
  type PurgePorts,
  type ReconcilePorts,
  type Subscriber,
} from '@bananasaurs/core';
import {
  authzStoreFor,
  archiveRepo,
  assistantRepo,
  conversationRepo,
  effectRepo,
  guildRepo,
  isTargetProtected,
  jobRepo,
  jobStoreFor,
  loggingRepo,
  modCaseRepo,
  modPendingRepo,
  panelRepo,
  pipelineRepo,
  resourceCacheRepo,
  roleRepo,
  type GuildScope,
  type InstanceScope,
} from '@bananasaurs/storage';
import { nativeAutomodPortsFor } from '../automod/native-wiring.js';
import { automodAuthorization, automodGatewayFor, automodPortsFor } from '../automod/wiring.js';
import { adoptionStateWriter, adoptPanelHandler } from '../jobs/adopt.js';
import { sweepEventDedupeHandler } from '../jobs/handlers.js';
import { logMessageDeleteHandler } from '../jobs/logging.js';
import { modPurgeHandler } from '../jobs/mod.js';
import { reconcileGuildHandler } from '../jobs/reconcile.js';
import { undoBatchHandler } from '../jobs/undo.js';
import { deliverRemindersHandler } from '../jobs/reminders.js';
import { resourceRefreshHandler } from '../jobs/resource-refresh.js';
import { ReviewedResourceFetcher } from '../assistant/resource-fetcher.js';
import { conversationPruneHandler } from '../jobs/conversation-prune.js';
import { createReminderDelivery, reminderStoreFor } from '../assistant/reminder-delivery.js';
import { createAssistantCommandSubscriber } from '../assistant/commands.js';
import { assistantInvokeHandler } from '../jobs/assistant.js';
import type { InteractionTokenSealer } from '../assistant/interaction-token.js';
import { createAssistantService } from '../assistant/service.js';
import type { ChainEntry } from '../assistant/model-chain.js';
import type { QuotaLedger } from '../assistant/quota-ledger.js';
import { memberChannels } from '../assistant/member-channels.js';
import { panelAuthorization, panelEffectsFor, panelStoreFor } from '../panels/wiring.js';

/**
 * Everything that belongs to one guild, wired once.
 *
 * The integration tests have each assembled this by hand since WP2; this is the
 * same assembly for real, with a `GuildScope` and a `DiscordPort` in place of a
 * test's locals. Nothing here decides anything — every decision lives in `core`,
 * and the composition root's whole job is to be the only place that knows both
 * the domain and the database (`docs/19` §1).
 *
 * One instance per allowlisted guild. The subscribers it returns are bound to
 * this scope and do not check `event.guildId` themselves, which is why
 * `daemon.ts` wraps them (ADR 0020).
 */

/**
 * How recently one of our own effects still counts as ours, for amendment 5.
 *
 * `GUILD_MEMBER_UPDATE` fires for the bot's own grants as well as a moderator's.
 * Repair naively and the bot reacts to its own grant, re-grants, and reacts
 * again — a feedback loop that looks like a hung process and burns the rate cap.
 * A role changed by a completed effect inside this window is ours; anything
 * older is external drift however it happened.
 */
export const SELF_MUTATION_WINDOW_MS = 60_000;

export interface GuildRuntimeDeps {
  readonly scope: GuildScope;
  /** Provider eligibility is instance-level (ADR 0027); the assistant gate reads it. */
  readonly instance: InstanceScope;
  readonly config: Config;
  readonly discord: DiscordPort;
  /**
   * The live discord.js client: forum detection and category membership are
   * cache facts, not port calls (review B3 — a hardwired `false` skipped
   * forum backfills entirely).
   */
  readonly client: Client;
  readonly logger: Logger;
  /** A property, not a method: it is destructured and passed on by value. */
  readonly now: () => number;
  /**
   * Sealed at the composition root (`runtime/daemon.ts`), one per process:
   * interaction tokens reach the durable job table only as ciphertext
   * (SECURITY, independent audit), and every guild in the process must open
   * the same envelope the queue hands back.
   */
  readonly interactionTokenSealer: InteractionTokenSealer;
  readonly assistantConfig?: (() => Config) | undefined;
  /** ADR 0075: the resolved, ordered model chain, from the composition root. */
  readonly assistantChain?: (() => readonly ChainEntry[]) | undefined;
  /**
   * Task 8: the process-wide QuotaLedger, from the composition root. Absent
   * in isolated uses, where the service falls back to its own ledger.
   */
  readonly quotaLedger?: QuotaLedger | undefined;
}

/**
 * What the operator surface needs that only the live process holds.
 *
 * Everything else `bananasaurs` reaches is a query or a column, and
 * `ops/wiring.ts` builds those from a `GuildScope` alone. These three are
 * different: two of them need the Discord port and the panel renderer, and the
 * third needs the `RateLimiter` **object**, which is in-memory and per-process.
 * That last one is the concrete reason ADR 0013 puts the CLI on a socket rather
 * than letting it open the database — a CLI that wrote SQLite could not reach
 * a live allowance at all.
 */
export interface GuildOperations {
  /**
   * Writes a validated panel definition — panel, options and blocked roles in
   * one transaction. Storage only: nothing reaches Discord here, so a
   * half-built panel cannot go live; publishing stays `publishPanel`'s job
   * (ADR 0053).
   */
  createPanel(definition: PanelDefinition, newlyAllowlistedRoleIds?: readonly string[]): void;
  /** `panel sync`'s bounded half: post or edit the message, re-seed reactions. */
  publishPanel(panelId: string): Promise<OpsPublishResult>;
  grantAdoptionAllowance(count: number): void;
  adoptionAllowance(): number;
}

export interface GuildRuntime {
  readonly guildId: string;
  readonly subscribers: readonly Subscriber[];
  readonly worker: JobWorker;
  readonly ops: GuildOperations;
}

/**
 * `trigger_ref` for one convergence pass.
 *
 * Random rather than a counter: a counter restarts at zero with the process and
 * would collide in `role_effects` with a pass from the previous one. A pass id
 * has no ordering requirement — it exists to tie one pass's effects together.
 */
const newPassId = (): string => `pass-${randomUUID()}`;

export function buildGuildRuntime(deps: GuildRuntimeDeps): GuildRuntime {
  const { scope, instance, config, discord, client, logger, now } = deps;
  const guildId = parseGuildId(scope.guildId);

  /**
   * The bot's own user id.
   *
   * Discord mints a bot user with the same snowflake as its application, so the
   * configured application id is it. That equality is an assumption rather than
   * a guarantee, and getting it wrong means the bot treats its own seeded
   * reactions as member requests — so `daemon.ts` checks it against
   * `client.user.id` at READY rather than trusting it silently.
   */
  const botUserId = parseSnowflakeId(config.DISCORD_APPLICATION_ID);

  const rateLimiter = new RateLimiter(config.BANANASAURS_ROLE_RATE_LIMIT_PER_MIN);

  const gateway = new EffectGateway({
    guildId,
    authz: authzStoreFor(scope),
    discord,
    rateLimiter,
    logger,
    now,
    state: {
      read: () => guildRepo.readSafetyState(scope),
      isPanelEnabled: (panelId) => panelRepo.isPanelEnabled(scope, panelId),
      isRoleAllowlisted: (roleId) => roleRepo.isAllowlisted(scope, roleId),
      isTargetProtected: (userId, roleId) => isTargetProtected(scope, { userId, roleId }),
      tripBreaker: (reason, atMs) => guildRepo.tripBreaker(scope, reason, atMs),
    },
    effects: {
      claim: ({ dedupeKey, intent, hadRoleBefore, atMs }) =>
        effectRepo.claimEffect(scope, {
          dedupeKey,
          batchId: intent.batchId,
          userId: intent.userId,
          roleId: intent.roleId,
          action: intent.action,
          hadRoleBefore,
          panelId: intent.panelId,
          now: atMs,
        }),
      record: ({ effectId, state, completedAtMs, errorCode }) =>
        effectRepo.recordOutcome(scope, { effectId, state, completedAt: completedAtMs, errorCode }),
    },
    audit: {
      record: (input) =>
        effectRepo.recordAudit(scope, {
          at: input.atMs,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: input.action,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          batchId: input.batchId,
          before: input.before,
          after: input.after,
          dryRun: input.dryRun,
        }),
    },
  } satisfies EffectGatewayDeps);

  // Obtained once, honestly, and never cast. `panels/wiring.ts` explains why the
  // actor is `system` rather than the member who clicked.
  const authorization = panelAuthorization(scope);
  const effects = panelEffectsFor(scope, gateway, authorization, now);

  const reconcilePorts: ReconcilePorts = {
    guildId,
    botUserId,
    store: panelStoreFor(scope),
    discord,
    effects,
    logger,
    now,
    newPassId,
    fetchRoles: () => discord.fetchRoles(guildId),
    assignedMembers: (panelId) => effectRepo.listAssignedUsers(scope, panelId),
    // Read per pass rather than captured, so raising the budget takes effect on
    // the next run without a restart.
    reconcileBudget: () =>
      guildRepo.findGuild(scope)?.reconcileBudget ?? config.BANANASAURS_RECONCILE_BUDGET,
    setPanelStatus: (panelId, status, reason) =>
      panelRepo.setPanelStatus(scope, panelId, status, reason, now()),
    setRoleMissing: (roleId) =>
      roleRepo.setRoleAssignability(scope, {
        roleId,
        assignable: false,
        reason: 'deleted',
        now: now(),
      }),
  };

  const interactionPorts: InteractionSubscriberDeps = {
    ...reconcilePorts,
    responder: {
      defer: (ref, options) => discord.deferInteraction(guildId, ref, options),
      respond: async (ref, message) => {
        await discord.respondToInteraction(guildId, ref, message);
      },
    },
  };

  const memberUpdatePorts: MemberUpdatePorts = {
    guildId,
    botUserId,
    store: panelStoreFor(scope),
    discord,
    effects,
    logger,
    now,
    newPassId,
    wasRecentlyApplied: (input) => effectRepo.wasRecentlyApplied(scope, input),
    selfMutationWindowMs: SELF_MUTATION_WINDOW_MS,
  };

  const adoptionPorts: AdoptionPorts = {
    ...reconcilePorts,
    allowanceFor: (source) => rateLimiter.bucketFor(source, now()).allowance,
    setAdoptionPassState: adoptionStateWriter(scope, now),
  };

  const loggingPorts: LoggingPorts = {
    guildId,
    findRoute: (eventKind) => loggingRepo.findRoute(scope, eventKind),
    isChannelExcluded: (channelId) => loggingRepo.isChannelExcluded(scope, channelId),
    listEnabledLogChannels: () => loggingRepo.listEnabledLogChannels(scope),
    claim: (input) => pipelineRepo.recordFirstSight(scope, { ...input, atMs: now() }),
    release: (input) => pipelineRepo.forgetFirstSight(scope, input),
    sendMessage: (channelId, message) => discord.sendMessage(guildId, channelId, message),
    enqueueDeletionAttribution: ({ dedupeKey, payload, runAfter }) =>
      jobRepo.enqueue(scope, {
        kind: JOB_KINDS.logMessageDelete,
        payload,
        dedupeKey,
        runAfter,
        now: now(),
      }),
    now,
    logger,
  };

  // ADR 0035, Task 10: the automod rule engine's ports, built the same way
  // `panels/wiring.ts` builds a panel's — `automodPortsFor` mirrors
  // `panelEffectsFor` in taking an already-constructed gateway and witness so
  // Task 12's integration test can build the identical wiring without
  // re-deriving it (`apps/daemon/src/automod/wiring.ts`).
  const automodGateway = automodGatewayFor(scope, discord, logger, now);
  const automodAuth = automodAuthorization(scope);
  const automodPorts = automodPortsFor(scope, discord, automodGateway, automodAuth, logger, now);

  // ADR 0038, Task 5: native Discord AutoMod observability. Deliberately
  // narrower than `automodPorts` above — this subscriber makes no Discord
  // calls, so it needs no gateway and no witness of its own
  // (`automod/native-wiring.ts`).
  const nativeAutomodPorts: NativeAutomodSubscriberDeps = nativeAutomodPortsFor(scope, logger, now);

  // ADR 0046, Slice M1 Task 4: the live archive subscriber's ports. The guild
  // allowlist closes over config here; the channel vetoes read the repo and
  // the logging module's exclusion list through this scope.
  const archivePorts: ArchivePorts = {
    guildArchiveEnabled: config.BANANASAURS_ARCHIVE_GUILDS.includes(guildId),
    isChannelEnabled: (channelId) => archiveRepo.isChannelEnabled(scope, channelId),
    hasCategoryRow: (channelId) => archiveRepo.hasCategoryRow(scope, channelId),
    parentIncludesThreads: (channelId) => archiveRepo.parentIncludesThreads(scope, channelId),
    isChannelExcluded: (channelId) => loggingRepo.isChannelExcluded(scope, channelId),
    upsertMessage: (input) => archiveRepo.upsertMessage(scope, input),
    recordEdit: (input) => archiveRepo.recordEdit(scope, input),
    recordDelete: (input) => archiveRepo.recordDelete(scope, input),
    recordBulkDelete: (input) => archiveRepo.recordBulkDelete(scope, input),
    logger,
  };

  // ADR 0046, Slice M1 Task 5: the archive backfill and expiry jobs' ports.
  // The backfill pages the guild's `DiscordPort` at 100 per run and persists
  // its cursor in `archive_channels` after every page, so a restart resumes
  // rather than restarting (D4); the continuation re-enqueues under the
  // per-channel dedupe key, collapsing while live (ADR 0016).
  const archiveBackfillPorts: BackfillPorts = {
    guildArchiveEnabled: config.BANANASAURS_ARCHIVE_GUILDS.includes(guildId),
    isChannelExcluded: (channelId) => loggingRepo.isChannelExcluded(scope, channelId),
    fetchRecentMessages: (channelId, before) =>
      discord.fetchRecentMessages(guildId, channelId, { before, limit: 100 }),
    listThreads: (channelId) => discord.listPublicThreads(guildId, channelId),
    isForum: (channelId) =>
      client.guilds.cache.get(guildId)?.channels.cache.get(channelId)?.type ===
      ChannelType.GuildForum,
    hasCategoryRow: (categoryId) => archiveRepo.hasCategoryRow(scope, categoryId),
    categoryOf: (channelId) => {
      const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
      return channel !== undefined && 'parentId' in channel
        ? (channel.parentId ?? undefined)
        : undefined;
    },
    setThreadProgress: (input) => archiveRepo.setThreadProgress(scope, input),
    findChannel: (channelId) => archiveRepo.findChannel(scope, channelId),
    upsertMessage: (input) => archiveRepo.upsertMessage(scope, input),
    setBackfillCursor: (input) => archiveRepo.setBackfillCursor(scope, input),
    enqueueContinuation: ({ channelId, threadWalk, jobId, runAfter }) =>
      void jobRepo.enqueue(scope, {
        kind: JOB_KINDS.archiveBackfill,
        payload: JSON.stringify({ channelId, threadWalk }),
        dedupeKey: archiveBackfillDedupeKey(guildId, channelId, jobId),
        runAfter,
        now: now(),
      }),
    now,
    logger,
  };

  const archiveExpiryPorts = {
    expireContent: (nowMs: number) => archiveRepo.expireContent(scope, nowMs),
    now,
    logger,
  };

  const deletionAttributionPorts: MessageDeleteAttributionPorts = {
    guildId,
    findRoute: (eventKind) => loggingRepo.findRoute(scope, eventKind),
    fetchAuditLog: () =>
      discord.fetchAuditLog(guildId, { actionType: 'message_delete', limit: 25 }),
    claimedCountFor: (input) => loggingRepo.claimedCountFor(scope, input),
    incrementClaimedCount: (input) => loggingRepo.incrementClaimedCount(scope, input),
    findExistingAttribution: (messageId) =>
      loggingRepo.findMessageDeleteAttribution(scope, messageId),
    recordAudit: ({ actorId, inferred, at, payload }) =>
      effectRepo.recordAudit(scope, {
        at,
        actorType: actorId === undefined ? 'system' : 'member',
        actorId,
        action: 'message_delete',
        subjectType: 'message',
        subjectId: payload.messageId,
        before: {
          channelId: payload.channelId,
          authorId: payload.authorId,
          content: payload.content,
        },
        dryRun: false,
        inferred,
      }),
    claim: (input) => pipelineRepo.recordFirstSight(scope, { ...input, atMs: now() }),
    release: (input) => pipelineRepo.forgetFirstSight(scope, input),
    sendMessage: (channelId, message) => discord.sendMessage(guildId, channelId, message),
    logger,
    now,
  };

  // The bounded purge job (ADR 0037, Task 5): built the same way
  // `deletionAttributionPorts` above is, and reusing the exact honest-
  // attribution `recordAudit` shape it uses — a purge's deletions go through
  // the same ADR 0023 path as any other, with the confirming moderator as
  // the actor rather than a guess from Discord's audit log.
  const purgePorts: PurgePorts = {
    guildId,
    discord,
    readSafetyState: () => guildRepo.readSafetyState(scope),
    openOrResolveCase: (input) => modCaseRepo.openOrResolveCase(scope, input),
    recordCaseEvent: (input) =>
      modCaseRepo.recordCaseEvent(scope, {
        eventId: input.eventId,
        caseId: input.caseId,
        ruleId: input.ruleId,
        memberId: input.memberId,
        at: input.at,
        matchedCategory: input.matchedCategory,
        matchedSnippet: input.matchedSnippet,
        actionTaken: input.actionTaken,
        actorId: input.actorId,
        // `exactOptionalPropertyTypes` (tsconfig) treats an optional property
        // set to literal `undefined` as distinct from the property being
        // absent, and `RecordCaseEventInput` wants the latter (same idiom as
        // `automod/wiring.ts`'s `recordCaseEvent`).
        ...(input.refusalReason !== undefined && { refusalReason: input.refusalReason }),
      }),
    recordDeletionAudit: ({ at, actorId, messageId, channelId, authorId, content }) =>
      effectRepo.recordAudit(scope, {
        at,
        actorType: 'member',
        actorId,
        action: 'message_delete',
        subjectType: 'message',
        subjectId: messageId,
        before: { channelId, authorId, content },
        dryRun: false,
        inferred: false,
      }),
    enqueueDeletionAttribution: ({ dedupeKey, payload, runAfter }) =>
      jobRepo.enqueue(scope, {
        kind: JOB_KINDS.logMessageDelete,
        payload,
        dedupeKey,
        runAfter,
        now: now(),
      }),
    enqueuePurgeContinuation: ({ payload, cursor, dedupeKey, runAfter }) =>
      void jobRepo.enqueue(scope, {
        kind: JOB_KINDS.modPurge,
        payload,
        cursor,
        dedupeKey,
        runAfter,
        now: now(),
      }),
    now,
    logger,
  };

  // ADR 0037, Task 6: `/mod`'s five direct-invocation subcommands
  // (`timeout`/`untimeout`/`kick`/`unban`/`warn`). Its own
  // `ModerationActionGateway` instance, mirroring `automodGatewayFor`
  // exactly except for the idempotency claim's `event_kind` — a distinct
  // string so a moderator's `/mod timeout` and an automod ladder escalation
  // can never be confused for the same claim in `event_dedupe`, even if the
  // two ever produced an identical `dedupeKey` by coincidence.
  const modCommandGateway = new ModerationActionGateway({
    guildId,
    authz: authzStoreFor(scope),
    discord,
    logger,
    now,
    state: { read: () => guildRepo.readSafetyState(scope) },
    claims: {
      claim: (dedupeKey) => ({
        claimed: pipelineRepo.recordFirstSight(scope, {
          eventKind: 'mod-command-moderation-action',
          fingerprint: dedupeKey,
          atMs: now(),
        }),
      }),
    },
  } satisfies ModerationGatewayDeps);

  // ADR 0037, Task 7: the ban/purge confirm-then-execute handshake
  // (`mod_pending_actions`, Confirm/Cancel buttons). Its own deps object
  // (`ModConfirmationDeps`) rather than flattened into `modCommandDeps`
  // directly, mirroring `confirmations.ts`'s own module boundary — built
  // once here and referenced both by `modCommandDeps.confirmations` (so
  // `commands.ts`'s subscriber can route `ban`/`purge` previews into it)
  // and by `createModConfirmationSubscriber` below (the confirm/cancel
  // button-click subscriber, a sibling of `createModCommandSubscriber`
  // rather than a branch inside it — the two answer different
  // `DomainEvent` kinds).
  const modConfirmationDeps: ModConfirmationDeps = {
    guildId,
    authz: authzStoreFor(scope),
    fetchInvokerRoleIds: async (userId) => (await discord.fetchMember(guildId, userId)).roleIds,
    // Reuses the same gateway instance `modCommandDeps` does — same claim
    // partition (`event_kind: 'mod-command-moderation-action'`), so a
    // confirmed ban and a Task 6 direct action can never coincidentally
    // share a dedupe key without also sharing this claim table.
    moderationGateway: modCommandGateway,
    cases: {
      openOrResolveCase: (input) => modCaseRepo.openOrResolveCase(scope, input),
      recordCaseEvent: (input) =>
        modCaseRepo.recordCaseEvent(scope, {
          eventId: input.eventId,
          caseId: input.caseId,
          ruleId: input.ruleId,
          memberId: input.memberId,
          at: input.at,
          matchedCategory: input.matchedCategory,
          matchedSnippet: input.matchedSnippet,
          actionTaken: input.actionTaken,
          actorId: input.actorId,
          ...(input.escalationAction !== undefined && { escalationAction: input.escalationAction }),
          ...(input.refusalReason !== undefined && { refusalReason: input.refusalReason }),
        }),
    },
    pendingActions: {
      put: (input) => modPendingRepo.putPendingAction(scope, input),
      take: (intentId, now) => modPendingRepo.takePendingAction(scope, intentId, now),
      peek: (intentId) => modPendingRepo.peekPendingAction(scope, intentId),
    },
    // Ignores the passed `guildId` in favour of this scope's own, the same
    // discipline every other port in this file follows — `fetchRoles: () =>
    // discord.fetchRoles(guildId)` above, for instance.
    fetchRecentMessages: (_guildId, channelId, options) =>
      discord.fetchRecentMessages(guildId, channelId, options),
    enqueuePurgeJob: ({ payload, dedupeKey, now: enqueuedAt }) =>
      void jobRepo.enqueue(scope, {
        kind: JOB_KINDS.modPurge,
        payload,
        dedupeKey,
        now: enqueuedAt,
      }),
    responder: {
      defer: (ref, options) => discord.deferInteraction(guildId, ref, options),
      respond: async (ref, message) => {
        await discord.respondToInteraction(guildId, ref, message);
      },
    },
    now,
    logger,
  };

  const modCommandDeps: ModCommandDeps = {
    guildId,
    authz: authzStoreFor(scope),
    fetchInvokerRoleIds: async (userId) => (await discord.fetchMember(guildId, userId)).roleIds,
    moderationGateway: modCommandGateway,
    confirmations: modConfirmationDeps,
    cases: {
      openOrResolveCase: (input) => modCaseRepo.openOrResolveCase(scope, input),
      recordCaseEvent: (input) =>
        modCaseRepo.recordCaseEvent(scope, {
          eventId: input.eventId,
          caseId: input.caseId,
          ruleId: input.ruleId,
          memberId: input.memberId,
          at: input.at,
          matchedCategory: input.matchedCategory,
          matchedSnippet: input.matchedSnippet,
          actionTaken: input.actionTaken,
          actorId: input.actorId,
          // `exactOptionalPropertyTypes` (tsconfig): included only when a
          // value actually exists, the same idiom `automodPortsFor` and
          // `purgePorts` above use.
          ...(input.escalationAction !== undefined && { escalationAction: input.escalationAction }),
          ...(input.refusalReason !== undefined && { refusalReason: input.refusalReason }),
        }),
    },
    warnRepo: {
      openOrResolveCase: (input) => modCaseRepo.openOrResolveCase(scope, input),
      recordCaseEvent: (input) =>
        modCaseRepo.recordCaseEvent(scope, {
          eventId: input.eventId,
          caseId: input.caseId,
          ruleId: input.ruleId,
          memberId: input.memberId,
          at: input.at,
          matchedCategory: input.matchedCategory,
          matchedSnippet: input.matchedSnippet,
          actionTaken: input.actionTaken,
          actorId: input.actorId,
        }),
      nextEscalationTier: (violationCount) => modCaseRepo.nextEscalationTier(violationCount),
      recordEscalationOutcome: (input) =>
        modCaseRepo.recordCaseEvent(scope, {
          eventId: input.eventId,
          caseId: input.caseId,
          ruleId: input.ruleId,
          memberId: input.memberId,
          at: input.at,
          matchedCategory: input.matchedCategory,
          matchedSnippet: input.matchedSnippet,
          actionTaken: input.actionTaken,
          escalationAction: input.escalationAction,
          actorId: input.actorId,
          // `core`'s `WarnCasePorts.recordEscalationOutcome` widens this to a
          // bare `string` so `packages/core` need not depend on
          // `@bananasaurs/storage`'s `ModCaseRefusalReason` (ADR 0014). The
          // composition root is exactly where it is narrowed back — the only
          // values that ever flow through here are `ModerationOutcome['reason']`,
          // whose `ModerationRefusalReason` union (also `core`) is identical to
          // `ModCaseRefusalReason`'s, member for member. Same idiom
          // `automodPortsFor` uses.
          ...(input.refusalReason !== undefined && {
            refusalReason: input.refusalReason as ModerationRefusalReason,
          }),
        }),
    },
    // Task 8: `note`/`evidence`. A third sibling port beside `cases` and
    // `warnRepo` above (`NoteEvidenceCasePorts`'s own docstring explains
    // why it is not a widening of either), but the same one underlying
    // `modCaseRepo.recordCaseEvent` call every other manual-event port in
    // this file already makes — no new repo function.
    noteEvidenceCases: {
      openOrResolveCase: (input) => modCaseRepo.openOrResolveCase(scope, input),
      recordCaseEvent: (input) =>
        modCaseRepo.recordCaseEvent(scope, {
          eventId: input.eventId,
          caseId: input.caseId,
          ruleId: input.ruleId,
          memberId: input.memberId,
          at: input.at,
          matchedCategory: input.matchedCategory,
          matchedSnippet: input.matchedSnippet,
          actionTaken: input.actionTaken,
          actorId: input.actorId,
          ...(input.refusalReason !== undefined && { refusalReason: input.refusalReason }),
        }),
    },
    // Task 9: `history` — mostly read-only, so a fourth, narrower sibling
    // port (`HistoryCasePorts`) rather than a widening of
    // `cases`/`noteEvidenceCases` above: it names the two reads its own call
    // site uses, plus (fix round) the same `openOrResolveCase`/
    // `recordCaseEvent` write pair every other subcommand's refusal path
    // already calls through `modCaseRepo` — restricted at the type level to
    // the single `escalation_refused`/`unauthorized` combination `history`
    // ever writes.
    history: {
      guildId,
      authz: authzStoreFor(scope),
      fetchInvokerRoleIds: async (userId) => (await discord.fetchMember(guildId, userId)).roleIds,
      cases: {
        listCasesForMember: (memberId) => modCaseRepo.listCasesForMember(scope, memberId),
        listCaseEvents: (caseId) => modCaseRepo.listCaseEvents(scope, caseId),
        openOrResolveCase: (input) => modCaseRepo.openOrResolveCase(scope, input),
        recordCaseEvent: (input) => modCaseRepo.recordCaseEvent(scope, input),
      },
      responder: {
        defer: (ref, options) => discord.deferInteraction(guildId, ref, options),
        respond: async (ref, message) => {
          await discord.respondToInteraction(guildId, ref, message);
        },
      },
      now,
      logger,
    } satisfies HistoryDeps,
    responder: {
      defer: (ref, options) => discord.deferInteraction(guildId, ref, options),
      respond: async (ref, message) => {
        await discord.respondToInteraction(guildId, ref, message);
      },
    },
    now,
    logger,
  };

  const assistantService = createAssistantService(
    scope,
    instance,
    config,
    now,
    {},
    deps.assistantConfig ?? (() => config),
    logger,
    {
      memberChannels: (userId) => {
        const guild = client.guilds.cache.get(guildId);
        return memberChannels(
          guild === undefined
            ? undefined
            : {
                channels: guild.channels,
                members: {
                  fetch: async (id) => {
                    const member = await guild.members.fetch(id);
                    return { permissionsIn: (channel) => member.permissionsIn(channel.id) };
                  },
                },
              },
          userId,
        );
      },
    },
    deps.assistantChain ?? (() => []),
    // A defaulted parameter accepts `undefined`: absent in isolated uses,
    // where the service falls back to its own ledger.
    deps.quotaLedger,
  );
  const { interactionTokenSealer } = deps;

  const subscribers: Subscriber[] = [
    createConnectionSubscriber(
      {
        recordGap: (input) => pipelineRepo.recordGap(scope, input),
        enqueueReconcile: ({ dedupeKey, payload }) =>
          jobRepo.enqueue(scope, {
            kind: JOB_KINDS.reconcileGuild,
            payload,
            dedupeKey,
            now: now(),
          }),
      },
      logger,
    ),
    createReactionSubscriber(reconcilePorts),
    createInteractionSubscriber(interactionPorts),
    createMemberUpdateSubscriber(memberUpdatePorts),
    createLoggingSubscriber(loggingPorts),
    createAutomodSubscriber(automodPorts),
    // After automod so a message the automod deletes is archived as
    // created-then-deleted (ADR 0046 D5); read-side only.
    createArchiveSubscriber(archivePorts),
    createNativeAutomodSubscriber(nativeAutomodPorts),
    createModCommandSubscriber(modCommandDeps),
    createModConfirmationSubscriber(modConfirmationDeps),
    // Release 3 assistant: slash commands and @behaviour mentions. The
    // service owns permission, safety and provider eligibility; the Discord
    // layer never calls a provider itself. One service instance is shared by
    // the subscriber (cheap inline routing) and the job handler (the
    // expensive invoke, off the serial dispatch chain — B2).
    createAssistantCommandSubscriber({
      guildId,
      botUserId,
      service: assistantService,
      defer: (ref, options) => discord.deferInteraction(guildId, ref, options),
      respond: async (ref, message) => {
        await discord.respondToInteraction(guildId, ref, message);
      },
      enqueue: (input) => {
        jobRepo.enqueue(scope, { ...input, payload: JSON.stringify(input.payload) });
      },
      sealToken: (ref) => interactionTokenSealer.seal(ref),
      now,
      logger,
      lookupMessage: (messageId) => conversationRepo.lookupMessage(scope, messageId),
    }),
  ];

  const worker = new JobWorker({
    store: jobStoreFor(scope),
    handlers: [
      assistantInvokeHandler({
        guildId,
        service: assistantService,
        openToken: (token) => interactionTokenSealer.open(token),
        respond: async (ref, message) => {
          await discord.respondToInteraction(guildId, ref, message);
        },
        send: (channelId, message) => discord.sendMessage(guildId, channelId, message),
        logger,
        logChannelId: () => assistantRepo.getAssistantSettings(scope).logChannelId,
        now,
      }),
      reconcileGuildHandler(scope, reconcilePorts, now),
      adoptPanelHandler(adoptionPorts),
      logMessageDeleteHandler(deletionAttributionPorts),
      modPurgeHandler(purgePorts),
      archiveBackfillHandler(archiveBackfillPorts),
      archiveExpiryHandler(archiveExpiryPorts),
      undoBatchHandler(scope, { guildId, gateway, logger, now }),
      deliverRemindersHandler({
        store: reminderStoreFor(scope),
        delivery: createReminderDelivery(guildId, discord),
        now,
        logger,
      }),
      resourceRefreshHandler({
        scope,
        listResources: assistantRepo.listResources,
        refresh: {
          fetcher: new ReviewedResourceFetcher({ now }),
          repo: resourceCacheRepo,
          now,
        },
        logger,
      }),
      conversationPruneHandler(scope, { now, logger }),
      // Registered although nothing enqueues one yet: a handler missing when a
      // job arrives fails the job, and the sweep's producer is a scheduler this
      // slice does not build (ADR 0020).
      sweepEventDedupeHandler(scope, logger),
    ],
    logger,
    now,
  });

  /**
   * The publish deps, shared by the post and edit paths.
   *
   * `setPanelMessage` is what makes a posted panel resolvable from an
   * interaction: until it lands, a click on the message cannot be traced back
   * to a panel and the buttons do nothing.
   */
  const publishDeps = {
    guildId,
    discord,
    logger,
    setPanelMessage: (panelId: string, messageId: string) =>
      panelRepo.setPanelMessage(scope, panelId, messageId, now()),
  };

  const ops: GuildOperations = {
    createPanel: (definition, newlyAllowlistedRoleIds = []) => {
      panelRepo.createPanel(scope, definition, now(), newlyAllowlistedRoleIds);
    },
    async publishPanel(panelId) {
      const panel = panelRepo.findPanel(scope, panelId);
      if (panel === undefined) throw new Error(`no panel ${panelId} in guild ${guildId}`);

      let action: OpsPublishResult['action'];
      if (panel.kind !== 'managed') {
        // A bot may only edit its own messages, and that asymmetry is the whole
        // reason there are two kinds of panel. Not a failure: an adopted panel
        // is reaction-driven, and re-seeding plus reconciling is its sync.
        action = 'not-managed';
      } else if (panel.messageId === undefined) {
        await postManagedPanel(panel, publishDeps);
        action = 'posted';
      } else {
        // Rewritten every sync, not only when something changed. The message is
        // rendered from the configuration, so an edit is idempotent, and the
        // alternative — comparing rendered output to what Discord holds —
        // would need a fetch to answer a question the rewrite settles.
        await editManagedPanel(panel, publishDeps);
        action = 'edited';
      }

      // Re-read, because posting has just written a message id and the seeder
      // refuses a panel without one.
      const posted = panelRepo.findPanel(scope, panelId);
      const seed =
        posted?.messageId === undefined
          ? { seeded: 0, failed: [] }
          : await seedPanelReactions(posted, { guildId, discord, logger });

      return {
        action,
        messageId: posted?.messageId,
        reactionsSeeded: seed.seeded,
        reactionsFailed: seed.failed,
      };
    },

    grantAdoptionAllowance: (count) => {
      rateLimiter.grantAllowance('adoption', count, now());
    },
    adoptionAllowance: () => rateLimiter.bucketFor('adoption', now()).allowance,
  };

  return { guildId, subscribers, worker, ops };
}
