import { randomUUID } from 'node:crypto';
import { ChannelType, type Client, type GuildMember } from 'discord.js';
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
  createLogPoster,
  createMemberUpdateSubscriber,
  createModCardActionSubscriber,
  createModCommandSubscriber,
  createTaskCommandSubscriber,
  createModConfirmationSubscriber,
  createNativeAutomodSubscriber,
  createReactionSubscriber,
  formatAutomodMatch,
  formatWarn,
  DIGEST_DEFAULT_INPUT_CHARS,
  DIGEST_DEFAULT_MAX_PROPOSALS,
  DiscordApiError,
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
  type OpsPorts,
  type PanelDefinition,
  ProviderError,
  type PurgePorts,
  type ReconcilePorts,
  type Subscriber,
  TASK_UPDATE_BLOCKER_MAX,
  TASK_UPDATE_BODY_MAX,
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
  mcpBulkRepo,
  modCaseRepo,
  modPendingRepo,
  panelRepo,
  pipelineRepo,
  resourceCacheRepo,
  roleRepo,
  runRepo,
  traceRepo,
  taskNudgeRepo,
  taskRepo,
  type GuildScope,
  type InstanceScope,
} from '@bananasaurs/storage';
import { nativeAutomodPortsFor } from '../automod/native-wiring.js';
import { automodAuthorization, automodGatewayFor, automodPortsFor } from '../automod/wiring.js';
import { adoptionStateWriter, adoptPanelHandler } from '../jobs/adopt.js';
import { mcpBulkRoleHandler } from '../jobs/mcp-bulk-role.js';
import {
  authorizeRolesMutate,
  mcpRateLimiterFor,
  mcpRoleGatewayFor,
} from '../mcp/roles-gateway.js';
import { pruneJobsHandler, sweepEventDedupeHandler } from '../jobs/handlers.js';
import { logMessageDeleteHandler } from '../jobs/logging.js';
import { modPurgeHandler } from '../jobs/mod.js';
import { reconcileGuildHandler } from '../jobs/reconcile.js';
import { refreshOneTaskCard } from '../jobs/task-cards.js';
import { taskPostsEnabledFor } from './task-posts-gate.js';
import { undoBatchHandler } from '../jobs/undo.js';
import { deliverRemindersHandler } from '../jobs/reminders.js';
import { resourceRefreshHandler } from '../jobs/resource-refresh.js';
import { ATTACHMENT_HOSTS, type AttachmentCaps } from '../assistant/attachments.js';
import { ReviewedResourceFetcher } from '../assistant/resource-fetcher.js';
import { websiteFetchHeaders } from '../assistant/website-fetch-headers.js';
import { conversationPruneHandler } from '../jobs/conversation-prune.js';
import { createGitHubClient } from '../assistant/github-client.js';
import { createGithubFetch, githubGuard } from '../assistant/github-fetch.js';
import {
  assistantWriteGateFor,
  createReminderDelivery,
  reminderStoreFor,
} from '../assistant/reminder-delivery.js';
import { opsPortsFor } from '../ops/wiring.js';
import { scheduleUpdatePost } from '../jobs/task-update-slot.js';
import { channelAccessFor } from '../channels/access.js';
import { createAssistantCommandSubscriber } from '../assistant/commands.js';
import { resolveReplyPings } from '../assistant/reply-ping-policy.js';
import { createRunRecorder } from '../assistant/run-recorder.js';
import { assistantInvokeHandler } from '../jobs/assistant.js';
import { assistantSummariseHandler, type SummariseModelPort } from '../jobs/assistant-summarise.js';
import {
  assistantDailyDigestHandler,
  pickBackgroundEntry,
  type DigestModelPort,
} from '../jobs/assistant-digest.js';
import { reserveEntryCall } from '../assistant/local-limit.js';
import type { InteractionTokenSealer } from '../assistant/interaction-token.js';
import { createAssistantService } from '../assistant/service.js';
import type { ChainEntry } from '../assistant/model-chain.js';
import type { QuotaLedger } from '../assistant/quota-ledger.js';
import type { WebSearchRun } from '../assistant/web-search.js';
import type { InstanceSettingsStore } from '../settings/instance-settings-store.js';
import { memberChannels } from '../assistant/member-channels.js';
import { guildAudienceChannels } from '../assistant/audience.js';
import {
  resolveReminderTargets,
  type ReminderTargetMember,
} from '../assistant/reminder-targets.js';
import { taskMemberAccess } from '../task-access.js';
import { decideTaskReview } from '../task-approval.js';
import { createTaskReplySubscriber, resolveReplyChoice } from '../task-replies.js';
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
  /** ADR 0120: the web search run for one request, from the composition root. */
  readonly assistantWebSearch?: ((guildId: string) => WebSearchRun | undefined) | undefined;
  /**
   * Task 17: the sealed GitHub token, opened for the GitHub client only.
   * Supplied by the composition root (`daemon.ts` owns the provider store);
   * absent in tests, in which case GitHub refreshes run unauthenticated.
   */
  readonly githubToken?: (() => string | undefined) | undefined;
  /**
   * Task 7: the owner-edited instance settings (ADR 0080), from the
   * composition root. Absent in isolated uses, where today's constants stand.
   */
  readonly instanceSettings?: InstanceSettingsStore | undefined;
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
  /**
   * Replaces a panel's definition — options, blocked roles and scalar fields —
   * keeping its `message_id` and its `status`. Storage only, like
   * `createPanel`: publishing the change stays `publishPanel`'s job.
   */
  updatePanel(definition: PanelDefinition, newlyAllowlistedRoleIds?: readonly string[]): void;
  /** `panel sync`'s bounded half: post or edit the message, re-seed reactions. */
  publishPanel(panelId: string): Promise<OpsPublishResult>;
  /**
   * `panel delete`'s Discord half plus its rows: deletes the message of a
   * managed posted panel, then the panel's rows. An adopted panel's message
   * belongs to someone else and an unposted panel has none — both delete
   * their rows only.
   */
  unpublishPanel(panelId: string): Promise<void>;
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

/** Same live team and destination requirements as the MCP task-admin port. */
export const verifyAssistantTaskDestination = async (
  scope: GuildScope,
  client: Client,
  discord: DiscordPort,
  inspectTaskChannel: (channelId: string) => ReturnType<OpsPorts['inspectTaskChannel']>,
  checkWrite: (channelId: string) => Promise<{ readonly allowed: boolean }>,
  teamId: string,
  destinationId: string,
): Promise<boolean> => {
  const team = taskRepo.listTeams(scope).find((t) => t.teamId === teamId);
  const guild = client.guilds.cache.get(scope.guildId);
  if (!team || !guild) return false;
  try {
    const category = await guild.channels.fetch(team.categoryId, { force: true });
    if (category?.type !== ChannelType.GuildCategory) return false;
    const roles = await discord.fetchRoles(scope.guildId);
    if (team.leadRoleId && !roles.some((r) => r.id === team.leadRoleId)) return false;
    if (team.memberRoleId && !roles.some((r) => r.id === team.memberRoleId)) return false;
    if (team.announcementChannelId) {
      const announcement = await guild.channels.fetch(team.announcementChannelId, {
        force: true,
      });
      if (
        !announcement ||
        announcement.parentId !== team.categoryId ||
        (announcement.type !== ChannelType.GuildText &&
          announcement.type !== ChannelType.GuildAnnouncement) ||
        !(await checkWrite(team.announcementChannelId)).allowed
      )
        return false;
    }
    const channel = await inspectTaskChannel(destinationId);
    return channel?.categoryId === team.categoryId && (await checkWrite(destinationId)).allowed;
  } catch {
    return false;
  }
};

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
    listEnabledRoutesFor: (eventKind) => loggingRepo.listEnabledRoutesFor(scope, eventKind),
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
    getMemberSnapshot: (id) => loggingRepo.getMemberSnapshot(scope, id),
    saveMemberSnapshot: (s) =>
      loggingRepo.upsertMemberSnapshot(scope, { ...s, roleIds: [...s.roleIds] }),
    deleteMemberSnapshot: (id) => {
      loggingRepo.deleteMemberSnapshot(scope, id);
    },
    now,
    logger,
  };

  // ADR 0035, Task 10: the automod rule engine's ports, built the same way
  // `panels/wiring.ts` builds a panel's — `automodPortsFor` mirrors
  // `panelEffectsFor` in taking an already-constructed gateway and witness so
  // Task 12's integration test can build the identical wiring without
  // re-deriving it (`apps/daemon/src/automod/wiring.ts`).
  //
  // P2 Task 4 (ADR 0141 decision 3): every recorded match also posts an
  // `automod_match` card to log routes, through the same `createLogPoster`
  // `/mod warn` uses for `member_warn` — claimed on
  // `automod:<messageId>:<ruleId>`, so a redelivered message posts no second
  // card. Built here rather than inside `automodPortsFor` because the poster
  // belongs to the logging module, not the automod one.
  const logPoster = createLogPoster(loggingPorts);
  const automodGateway = automodGatewayFor(scope, discord, logger, now);
  const automodAuth = automodAuthorization(scope);
  const automodPorts = automodPortsFor(
    scope,
    discord,
    automodGateway,
    automodAuth,
    logger,
    now,
    (info) =>
      logPoster.post({
        eventKind: 'automod_match',
        fingerprint: `automod:${info.messageId}:${info.ruleId}`,
        source: {
          channelId: parseSnowflakeId(info.channelId),
          parentChannelId:
            info.parentChannelId === undefined ? undefined : parseSnowflakeId(info.parentChannelId),
          categoryId: info.categoryId === undefined ? undefined : parseSnowflakeId(info.categoryId),
        },
        view: (includeContent) => formatAutomodMatch(info, includeContent),
      }),
  );

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
    hasPausedOwnRow: (channelId) => archiveRepo.hasPausedOwnRow(scope, channelId),
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
    listEnabledRoutesFor: (eventKind) => loggingRepo.listEnabledRoutesFor(scope, eventKind),
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
      deferUpdate: (ref) => discord.deferUpdate(guildId, ref),
      showModal: (ref, modal) => discord.showModal(guildId, ref, modal),
      respond: async (ref, message) => {
        await discord.respondToInteraction(guildId, ref, message);
      },
      editOriginal: (ref, message) => discord.editOriginalResponse(guildId, ref, message),
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
    // ADR 0123 (logging routes): a warning is the bot's own action, so it
    // never arrives as a gateway event — `/mod warn` hands it to the logging
    // module here, posted under the warn's interaction id so a retried hook
    // call replays to nothing. `onWarned` is `readonly`, so it is set in the
    // literal rather than assigned afterwards.
    onWarned: (info) =>
      logPoster.post({
        eventKind: 'member_warn',
        fingerprint: info.warnId,
        source: undefined,
        view: () => formatWarn(info, now()),
      }),
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
        deferUpdate: (ref) => discord.deferUpdate(guildId, ref),
        showModal: (ref, modal) => discord.showModal(guildId, ref, modal),
        respond: async (ref, message) => {
          await discord.respondToInteraction(guildId, ref, message);
        },
        editOriginal: (ref, message) => discord.editOriginalResponse(guildId, ref, message),
      },
      now,
      logger,
    } satisfies HistoryDeps,
    responder: {
      defer: (ref, options) => discord.deferInteraction(guildId, ref, options),
      deferUpdate: (ref) => discord.deferUpdate(guildId, ref),
      showModal: (ref, modal) => discord.showModal(guildId, ref, modal),
      respond: async (ref, message) => {
        await discord.respondToInteraction(guildId, ref, message);
      },
      editOriginal: (ref, message) => discord.editOriginalResponse(guildId, ref, message),
    },
    now,
    logger,
  };

  // Task 7: captured once for the closures below, so neither needs a
  // non-null assertion after its explicit undefined check.
  const settings = deps.instanceSettings;
  // ADR 0126: one guild-bound `ChannelAccess` for the assistant's three
  // consumers (the mention subscriber, the invoke job and the service).
  // Stateless — every check re-resolves, so a moved channel or a changed row
  // takes effect on the next call.
  const channelAccess = channelAccessFor(client, scope);
  const assistantService = createAssistantService(
    scope,
    instance,
    config,
    now,
    {},
    deps.assistantConfig ?? (() => config),
    logger,
    {
      verifyTaskDestination: (teamId, destinationId) => {
        const taskPorts = opsPortsFor(
          scope,
          instance,
          ops,
          now,
          client,
          config.BANANASAURS_ARCHIVE_GUILDS.includes(guildId),
        );
        return verifyAssistantTaskDestination(
          scope,
          client,
          discord,
          (channelId) => taskPorts.inspectTaskChannel(channelId),
          (channelId) => channelAccess.check('write', channelId),
          teamId,
          destinationId,
        );
      },
      taskContext: {
        access: async (actorId) => {
          try {
            const access = await taskMemberAccess(scope, client, discord, actorId);
            if (access.teams.length === 0) return undefined;
            const leadTeamIds = access.teams
              .filter((team) => access.leadOf(team.teamId))
              .map((team) => team.teamId);
            return {
              actorId,
              teams: access.teams.map((team) => ({
                teamId: team.teamId,
                name: team.name,
                kind: team.kind,
                categoryId: team.categoryId,
              })),
              president: access.president,
              leadTeamIds,
            };
          } catch {
            return undefined;
          }
        },
        anchorTaskId: (channelId, messageId) => taskRepo.taskForAnchor(scope, channelId, messageId),
      },
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
      // ADR 0087: role display names for the skill scope-denial reasons,
      // from the live roles cache. An uncached guild gives an empty map.
      roleNames: (roleIds) => {
        const names = new Map<string, string>();
        const guild = client.guilds.cache.get(guildId);
        if (guild === undefined) return names;
        for (const roleId of roleIds) {
          const name = guild.roles.cache.get(roleId)?.name;
          if (name !== undefined) names.set(roleId, name);
        }
        return names;
      },
      // ADR 0090: the channels every viewer of the answer channel can
      // read, from the live overwrites — mirroring the `memberChannels`
      // adapter above. An uncached guild fails closed to the empty set.
      audienceChannels: (answerChannelId) => {
        const guild = client.guilds.cache.get(guildId);
        if (guild === undefined) return Promise.resolve(new Set<string>());
        return Promise.resolve(
          guildAudienceChannels({ channels: guild.channels, roles: guild.roles }, answerChannelId),
        );
      },
      // ADR 0092 decision 1: guild scheduled events behind `upcoming_events`.
      listScheduledEvents: () => discord.listScheduledEvents(guildId),
      // ADR 0092 decision 2: one channel page behind `channel_history`, the
      // same shape as the invoke job's closure below.
      fetchChannelMessages: (channelId, opts) =>
        discord.fetchChannelMessages(guildId, channelId, opts),
      // ADR 0090 D3: resolves a `search_archive` `from` value against the
      // live member list. A bare 17–20 digit id or `<@id>` mention fetches
      // that member; anything else searches by name. Lookups never throw:
      // an unknown id or a failed search resolves to no candidates, and the
      // service refuses with one sentence.
      findMember: (nameOrId) => {
        const guild = client.guilds.cache.get(guildId);
        if (guild === undefined) return Promise.resolve([]);
        const trimmed = nameOrId.trim();
        const id = /^<@!?(\d{17,20})>$/.exec(trimmed)?.[1] ?? /^(\d{17,20})$/.exec(trimmed)?.[1];
        const toEntry = (member: GuildMember) => ({
          id: member.id,
          displayName: member.displayName,
          ...(member.user.globalName === null ? {} : { globalName: member.user.globalName }),
          username: member.user.username,
          roleNames: [...member.roles.cache.values()]
            .filter((r) => r.id !== guild.id)
            .map((r) => r.name)
            .slice(0, 20),
        });
        if (id !== undefined) {
          return guild.members.fetch(id).then(
            (member) => [toEntry(member)],
            () => [],
          );
        }
        return guild.members.search({ query: nameOrId, limit: 5 }).then(
          (members) => [...members.values()].map(toEntry),
          () => [],
        );
      },
      // ADR 0145: reply pings are decided by code, within the owner's caps.
      resolveReplyPings: (input) =>
        resolveReplyPings(
          client,
          scope,
          {
            members: settings?.get('assistant.pingMaxMembers') ?? 5,
            roles: settings?.get('assistant.pingMaxRoles') ?? 3,
          },
          input,
        ),
      // B2b: the acting reminder tools resolve their channel and mentions
      // against the live guild, mirroring the `memberChannels` adapter above:
      // an uncached guild fails closed inside `resolveReminderTargets`.
      resolveReminderTargets: (request) => {
        const live = client.guilds.cache.get(guildId);
        if (live === undefined) return resolveReminderTargets(undefined, request);
        const adaptMember = (member: GuildMember): ReminderTargetMember => ({
          id: member.id,
          displayName: member.displayName,
          user: { username: member.user.username },
          permissionsIn: (channel) => ({
            has: (permission) => member.permissionsIn(channel.id).has(permission),
          }),
        });
        return resolveReminderTargets(
          {
            channels: {
              cache: new Map(
                [...live.channels.cache.values()].map(
                  (channel) =>
                    [
                      channel.id,
                      {
                        id: channel.id,
                        name: channel.name,
                        type: channel.type,
                        parentId: 'parentId' in channel ? (channel.parentId ?? null) : null,
                        // discord.js `isTextBased()` is true for voice and
                        // stage channels too; only text and announcement
                        // channels can host a reminder.
                        isTextBased: () =>
                          channel.type === ChannelType.GuildText ||
                          channel.type === ChannelType.GuildAnnouncement,
                        isThread: () => channel.isThread(),
                      },
                    ] as const,
                ),
              ),
            },
            roles: {
              cache: new Map(
                [...live.roles.cache.values()].map(
                  (role) =>
                    [
                      role.id,
                      { id: role.id, name: role.name, mentionable: role.mentionable },
                    ] as const,
                ),
              ),
            },
            members: {
              me: live.members.me === null ? null : adaptMember(live.members.me),
              cache: new Map(
                [...live.members.cache.values()].map(
                  (member) => [member.id, adaptMember(member)] as const,
                ),
              ),
              fetch: async (userId) => adaptMember(await live.members.fetch(userId)),
              search: async ({ query, limit }) =>
                new Map(
                  [...(await live.members.search({ query, limit })).values()].map(
                    (member) => [member.id, adaptMember(member)] as const,
                  ),
                ),
            },
          },
          request,
        );
      },
    },
    deps.assistantChain ?? (() => []),
    // A defaulted parameter accepts `undefined`: absent in isolated uses,
    // where the service falls back to its own ledger.
    deps.quotaLedger,
    // Task 7: the live tool-loop limits from the AI tuning settings. Absent
    // means the loop's own defaults, which equal today's constants.
    settings === undefined
      ? undefined
      : () => ({
          rounds: settings.get('assistant.maxToolRounds'),
          totalCalls: settings.get('assistant.maxToolCalls'),
          maxOutputTokens: settings.get('assistant.maxOutputTokens'),
        }),
    // ADR 0092 decision 2: the live channel-context window from the AI tuning
    // settings. Absent means off, and the `channel_history` tool stays hidden.
    settings === undefined ? undefined : () => settings.get('assistant.channelContextMessages'),
    // ADR 0126: Read gates the `channel_history` tool declaration.
    channelAccess,
    deps.assistantWebSearch,
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
    createTaskReplySubscriber(scope, deps.client, discord),
    createNativeAutomodSubscriber(nativeAutomodPorts),
    createTaskCommandSubscriber({
      guildId,
      responder: {
        defer: (ref, options) => discord.deferInteraction(guildId, ref, options),
        deferUpdate: (ref) => discord.deferUpdate(guildId, ref),
        showModal: (ref, modal) => discord.showModal(guildId, ref, modal),
        respond: async (ref, message) => {
          await discord.respondToInteraction(guildId, ref, message);
        },
        editOriginal: (ref, message) => discord.editOriginalResponse(guildId, ref, message),
      },
      now,
      listForMember: async (userId) => {
        const { teams } = await taskMemberAccess(scope, deps.client, discord, userId);
        const allowed = new Set(teams.map((team) => team.teamId));
        return taskRepo
          .listTasks(scope)
          .filter((task) => allowed.has(task.teamId))
          .map((task) => ({
            taskId: task.taskId,
            teamName: teams.find((team) => team.teamId === task.teamId)?.name ?? '',
            title: task.title,
            status: task.status,
            dueAt: task.dueAt,
            timezone: task.timezone,
          }));
      },
      completableForMember: async (userId) => {
        const access = await taskMemberAccess(scope, deps.client, discord, userId);
        const allowed = new Set(access.teams.map((team) => team.teamId));
        return taskRepo
          .listTasks(scope)
          .filter(
            (task) =>
              allowed.has(task.teamId) &&
              (task.status === 'not_started' || task.status === 'in_progress'),
          )
          .filter((task) =>
            task.assignmentKind === 'individual'
              ? taskRepo.isTaskAssignee(scope, task.taskId, userId) && access.onTeam(task.teamId)
              : access.onTeam(task.teamId),
          )
          .sort((a, b) => a.dueAt - b.dueAt)
          .slice(0, 25)
          .map((task) => ({
            taskId: task.taskId,
            title: task.title,
            dueAt: task.dueAt,
            timezone: task.timezone,
          }));
      },
      completeForMember: async (userId, taskId) => {
        const access = await taskMemberAccess(scope, deps.client, discord, userId);
        const task = taskRepo.getTask(scope, taskId);
        if (
          !task ||
          task.archivedAt ||
          task.status === 'done' ||
          !access.teams.some((team) => team.teamId === task.teamId)
        )
          return 'not-found';
        if (
          task.assignmentKind === 'individual' &&
          !(taskRepo.isTaskAssignee(scope, taskId, userId) && access.onTeam(task.teamId))
        )
          return 'not-found';
        if (task.assignmentKind === 'team' && !access.onTeam(task.teamId)) return 'not-found';
        if (task.status === 'awaiting_approval') return 'already-awaiting';
        return taskRepo.requestCompletion(
          scope,
          task.taskId,
          task.version,
          { actorType: 'member', actorId: userId, via: 'gateway' },
          now(),
        )
          ? 'awaiting_approval'
          : 'conflict';
      },
      decideReview: async (userId, taskId, version, decision) => {
        const outcome = await decideTaskReview(
          scope,
          deps.client,
          discord,
          userId,
          taskId,
          version,
          decision,
          now(),
        );
        const found = taskRepo.getTask(scope, taskId);
        const teamName = taskRepo.listTeams(scope).find((t) => t.teamId === found?.teamId)?.name;
        return {
          outcome,
          ...(found === undefined ? {} : { title: found.title }),
          ...(teamName === undefined ? {} : { teamName }),
        };
      },
      pickReplyTask: async (userId, choiceMessageId, taskId) => {
        const outcome = await resolveReplyChoice(
          scope,
          deps.client,
          discord,
          userId,
          choiceMessageId,
          taskId,
          now(),
        );
        const found = taskRepo.getTask(scope, taskId);
        return found?.title === undefined ? { outcome } : { outcome, title: found.title };
      },
      startTask: async (userId, taskId, version) => {
        // Preserve the helper's call-time timestamp across the live access check.
        const startedAt = now();
        const task = taskRepo.getTask(scope, taskId);
        if (
          !task ||
          task.archivedAt ||
          task.status === 'done' ||
          task.status === 'awaiting_approval'
        )
          return 'not-open';
        if (task.status === 'in_progress' || task.version !== version) return 'stale';
        const access = await taskMemberAccess(scope, deps.client, discord, userId);
        const allowed =
          access.teams.some((team) => team.teamId === task.teamId) &&
          (task.assignmentKind === 'individual'
            ? taskRepo.isTaskAssignee(scope, taskId, userId) && access.onTeam(task.teamId)
            : access.onTeam(task.teamId));
        if (!allowed) return 'not-yours';
        return taskRepo.setStatus(
          scope,
          taskId,
          version,
          'in_progress',
          { actorType: 'member', actorId: userId, via: 'gateway' },
          startedAt,
        )
          ? 'started'
          : 'stale';
      },
      taskTitle: (taskId) => taskRepo.getTask(scope, taskId)?.title,
      postUpdate: async (userId, taskId, interactionId, body, blocker) => {
        const postsOn = taskPostsEnabledFor(scope, config.BANANASAURS_DRY_RUN);
        // Server-side guard for hand-rolled interactions: the modal's client
        // checks (min_length 3, max_length) do not stop a direct submit. An
        // empty or oversized update must not be recorded or move the task to
        // In progress (P1 phase review P3-1).
        if (
          body.trim() === '' ||
          body.length > TASK_UPDATE_BODY_MAX ||
          (blocker !== undefined && blocker.length > TASK_UPDATE_BLOCKER_MAX)
        )
          return { outcome: 'invalid', postsOn };
        const task = taskRepo.getTask(scope, taskId);
        if (
          !task ||
          task.archivedAt ||
          (task.status !== 'not_started' && task.status !== 'in_progress')
        )
          return { outcome: 'not-open', postsOn };
        const access = await taskMemberAccess(scope, deps.client, discord, userId);
        // The membership fetch above awaited: re-read the task so status, team and
        // assignment are judged as of now, not as of before the await.
        const current = taskRepo.getTask(scope, taskId);
        if (
          !current ||
          current.archivedAt ||
          (current.status !== 'not_started' && current.status !== 'in_progress')
        )
          return { outcome: 'not-open', postsOn };
        const onLiveTeam = access.teams.some((team) => team.teamId === current.teamId);
        const allowed =
          onLiveTeam &&
          (current.assignmentKind === 'individual'
            ? taskRepo.isTaskAssignee(scope, taskId, userId) && access.onTeam(current.teamId)
            : access.onTeam(current.teamId));
        if (!allowed) return { outcome: 'not-yours', postsOn };
        const reportId = `modal:${interactionId}`;
        const text = blocker === undefined ? body : `${body}\n\nBlocked: ${blocker}`;
        const at = now();
        const outcome = taskRepo.recordReport(
          scope,
          taskId,
          reportId,
          userId,
          text,
          { actorType: 'member', actorId: userId, via: 'gateway' },
          at,
        );
        if (outcome === 'not-open') return { outcome: 'not-open', postsOn };
        if (outcome === 'recorded') scheduleUpdatePost(scope, taskId, reportId, at);
        return { outcome, postsOn };
      },
      refreshTaskCard: (taskId) =>
        refreshOneTaskCard(scope, discord, taskId, now(), {
          enabled: taskPostsEnabledFor(scope, config.BANANASAURS_DRY_RUN),
          logger,
        }),
      editBotMessage: async (channelId, messageId, message) => {
        await discord.editMessage(guildId, { channelId, messageId }, message);
      },
    }),
    createModCommandSubscriber(modCommandDeps),
    createModConfirmationSubscriber(modConfirmationDeps),
    createModCardActionSubscriber({
      guildId,
      commands: modCommandDeps,
      confirmations: modConfirmationDeps,
      responder: modCommandDeps.responder,
      now,
      logger,
    }),

    // Assistant skills route only through mentions; one service handles routing and jobs (B2).
    createAssistantCommandSubscriber({
      guildId,
      botUserId,
      service: assistantService,
      // ADR 0126: Write gates the reply — a mention in a channel the bot may
      // not post in never reaches the queue.
      channelAccess,
      enqueue: (input) => {
        const result = jobRepo.enqueue(scope, {
          ...input,
          payload: JSON.stringify(input.payload),
        });
        return { enqueued: result.enqueued };
      },
      now,
      logger,
      sendTyping: (channelId) => discord.sendTyping(guildId, channelId),
      // ADR 0129 §6: a newly queued mention opens the run's ledger row, so
      // the run exists before the job starts it.
      recordQueued: (run) => {
        runRepo.ensureRun(scope, {
          runId: run.runId,
          userId: run.userId,
          channelId: run.channelId,
          behaviourId: run.behaviourId,
          source: 'mention',
          queuedAt: now(),
        });
        createRunRecorder({ scope, runId: run.runId, now, logger }).event({
          kind: 'queued',
          via: run.via,
        });
      },
      lookupMessage: (messageId) => conversationRepo.lookupMessage(scope, messageId),
      // ADR 0112 decision 4: a pinged reply to a task post is a progress
      // update for the reply subscriber, never a general assistant question.
      isTaskPost: (messageId) => taskNudgeRepo.isTaskPost(scope, messageId),
      // ADR 0125: a tag of the bot's integration role is a tag of the bot.
      botRoleId: () => client.guilds.cache.get(guildId)?.roles.botRoleFor(botUserId)?.id,
      // Task 20: member 👍/👎 on a bot answer sets feedback and a trace
      // flag; anything else (and the bot's own reactions) is ignored inside.
      feedback: {
        setFeedback: (messageId, vote) => conversationRepo.setFeedback(scope, messageId, vote),
        addTraceFlag: (traceId, flag) => traceRepo.addTraceFlag(scope, traceId, flag),
      },
    }),
  ];

  // ADR 0091 decision 4 as amended by S5-T14: the summary job answers on the
  // forced summary tier from `backgroundTier('summary')` (Slice 6, setting
  // `assistant.routerSummaryTier`, default light), never the entry that
  // answered - background jobs never run the router. The payload keeps the
  // answering entry as provenance. A missing or skipped entry, a refused
  // reservation and a failed call are all skips, never retries - the raw
  // turns are kept for the next run.
  const summariseModel: SummariseModelPort = async ({ systemInstruction, text }) => {
    const entry = pickBackgroundEntry(
      (deps.assistantChain ?? (() => []))(),
      assistantService.backgroundTier('summary'),
    );
    if (entry === undefined || entry.provider === undefined || entry.skip !== undefined) {
      return { ok: false, reason: 'entry-unavailable' };
    }
    const reserved = reserveEntryCall(instance, entry, guildId, now());
    if (!reserved.ok) return { ok: false, reason: 'rate-limited' };
    try {
      const response = await entry.provider.generateText({
        model: entry.model,
        systemInstruction,
        messages: [{ role: 'user', text }],
        maxOutputTokens: 2_000,
        temperature: 0,
      });
      return { ok: true, text: response.text };
    } catch (err) {
      return { ok: false, reason: err instanceof ProviderError ? err.kind : 'error' };
    }
  };

  // ADR 0150 decision 2: the digest never runs the router. Its tier is the
  // owner-set forced tier from `backgroundTier('daily-digest')` (Slice 6,
  // setting `assistant.routerDailyDigestTier`, default light); the handler
  // records it as a `routed` event with reason `background-tier`. The first
  // usable entry in that tier's order answers; a missing entry, a refused
  // reservation and a failed call are completed failures, never retries.
  const digestModel: DigestModelPort = async ({ systemInstruction, text }) => {
    const entry = pickBackgroundEntry(
      (deps.assistantChain ?? (() => []))(),
      assistantService.backgroundTier('daily-digest'),
    );
    if (entry === undefined || entry.provider === undefined) {
      return { ok: false, reason: 'entry-unavailable' };
    }
    const reserved = reserveEntryCall(instance, entry, guildId, now());
    if (!reserved.ok) return { ok: false, reason: 'rate-limited' };
    try {
      const response = await entry.provider.generateText({
        model: entry.model,
        systemInstruction,
        messages: [{ role: 'user', text }],
        maxOutputTokens: 2_000,
        temperature: 0,
      });
      return { ok: true, text: response.text };
    } catch (err) {
      return { ok: false, reason: err instanceof ProviderError ? err.kind : 'error' };
    }
  };

  // ADR 0149: attachment bytes come only from Discord's CDN hosts, through
  // the reviewed fetcher (DNS pinning, public-address check, per-hop
  // allowlist re-check, byte cap). Caps are read live per call, so
  // dashboard changes apply without a restart; absent settings mean the
  // D7 defaults.
  const attachmentFetcher =
    settings === undefined
      ? new ReviewedResourceFetcher({ now })
      : new ReviewedResourceFetcher({
          now,
          limits: () => ({ timeoutMs: settings.get('resources.fetchTimeoutMs') }),
        });
  const attachmentCaps = (): AttachmentCaps => ({
    textMaxBytes: settings?.get('assistant.attachments.textMaxBytes') ?? 262_144,
    textMaxChars: settings?.get('assistant.attachments.textMaxChars') ?? 24_000,
    textMaxCount: settings?.get('assistant.attachments.textMaxCount') ?? 3,
    imageMaxBytes: settings?.get('assistant.attachments.imageMaxBytes') ?? 5_242_880,
    imageMaxCount: settings?.get('assistant.attachments.imageMaxCount') ?? 4,
    pdfMaxBytes: settings?.get('assistant.attachments.pdfMaxBytes') ?? 10_485_760,
    pdfMaxCount: settings?.get('assistant.attachments.pdfMaxCount') ?? 2,
  });

  const worker = new JobWorker({
    store: jobStoreFor(scope),
    handlers: [
      assistantSummariseHandler(scope, { summariseModel, now, logger }),
      assistantDailyDigestHandler(scope, {
        now,
        logger,
        timeZone: () => config.BANANASAURS_TIME_ZONE,
        botUserId,
        digestModel,
        forcedTier: () => assistantService.backgroundTier('daily-digest'),
        digestEnabled: () =>
          settings === undefined ? true : settings.get('assistant.digestEnabled') === 1,
        digestInputChars: () =>
          settings === undefined
            ? DIGEST_DEFAULT_INPUT_CHARS
            : settings.get('assistant.digestInputChars'),
        digestMaxProposals: () =>
          settings === undefined
            ? DIGEST_DEFAULT_MAX_PROPOSALS
            : settings.get('assistant.digestMaxProposals'),
      }),
      assistantInvokeHandler({
        guildId,
        service: assistantService,
        openToken: (token) => interactionTokenSealer.open(token),
        respond: (ref, message) => discord.respondToInteraction(guildId, ref, message),
        send: (channelId, message) => discord.sendMessage(guildId, channelId, message),
        logger,
        logChannelId: () => assistantRepo.getAssistantSettings(scope).logChannelId,
        now,
        // Task 7: the live retry delays from the AI tuning settings. Absent
        // means today's 10 s / 30 s / 90 s defaults.
        ...(settings === undefined
          ? {}
          : { retryDelaysMs: () => settings.get('assistant.retryDelaysMs') }),
        // Slice 3: the typing indicator lives to the hard provider ceiling.
        ...(settings === undefined
          ? {}
          : { progressCeilingMs: () => settings.get('assistant.providerMaxCallMs') }),
        // ADR 0081: the member-facing clock zone for the local-limit reply.
        timeZone: () => config.BANANASAURS_TIME_ZONE,
        // Task 14: every answer joins a conversation (ADR 0072), posts as
        // Discord replies in staged parts, shows typing and writes a trace.
        conversations: { scope, botUserId, botDisplayName: client.user?.username ?? 'bananasaurs' },
        sendTyping: (channelId) => discord.sendTyping(guildId, channelId),
        fetchMessageContent: (channelId, messageId) =>
          discord.fetchMessageContent(guildId, channelId, messageId),
        // ADR 0089: channel context for mentions, beside the quote fetch.
        fetchChannelMessages: (channelId, opts) =>
          discord.fetchChannelMessages(guildId, channelId, opts),
        // ADR 0149: live attachment bytes and caps (S4-T5/S4-T9 deps).
        fetchAttachmentBytes: async (url, maxBytes) => {
          const fetched = await attachmentFetcher.fetchBytes(url, {
            allowedHosts: ATTACHMENT_HOSTS,
            maxBytes,
          });
          return fetched.ok
            ? { ok: true as const, bytes: fetched.bytes, mediaType: fetched.mediaType }
            : { ok: false as const, code: fetched.code };
        },
        attachmentCaps,
        // ADR 0126: Write re-gates the reply at run time; Read gates the
        // live channel-context fetches. The quoted message fetch stays
        // ungated (a handed message).
        channelAccess,
        guildReady: () => client.guilds.cache.get(guildId)?.available === true,
        ...(settings === undefined
          ? {}
          : {
              channelContextMessages: () => settings.get('assistant.channelContextMessages'),
            }),
      }),
      reconcileGuildHandler(scope, reconcilePorts, now),
      adoptPanelHandler(adoptionPorts),
      // Slice 4, Task 4: the durable bulk role walk, through the MCP's own
      // gateway instance (same policy, same no-op breaker, same `mcp` audit
      // rows as the interactive role tools) on the shared per-guild limiter
      // from `mcp/roles-gateway.ts` — the job and the HTTP role ports spend
      // one `roleRatePerMin` bucket.
      mcpBulkRoleHandler({
        scope,
        logger,
        now,
        gateway: mcpRoleGatewayFor(
          { authz: authzStoreFor(scope), rateLimiter: mcpRateLimiterFor(scope), logger, now },
          client,
          discord,
          scope,
        ),
        authorizeAccount: (accountId) => authorizeRolesMutate(scope, accountId),
        findPreview: (previewId) => mcpBulkRepo.findPreviewById(scope, previewId),
      }),
      logMessageDeleteHandler(deletionAttributionPorts),
      modPurgeHandler(purgePorts),
      archiveBackfillHandler(archiveBackfillPorts),
      archiveExpiryHandler(archiveExpiryPorts),
      undoBatchHandler(scope, { guildId, gateway, logger, now }),
      deliverRemindersHandler({
        store: reminderStoreFor(scope),
        delivery: createReminderDelivery(guildId, discord, assistantWriteGateFor(client, scope), {
          client,
          scope,
          logger,
        }),
        now,
        logger,
      }),
      resourceRefreshHandler({
        scope,
        listResources: assistantRepo.listResources,
        refresh: {
          // The live fetch timeout and the owner's header (listed hosts
          // only) from the AI tuning settings. Absent means today's 5 s
          // default and no header.
          fetcher:
            settings === undefined
              ? new ReviewedResourceFetcher({ now })
              : new ReviewedResourceFetcher({
                  now,
                  limits: () => ({ timeoutMs: settings.get('resources.fetchTimeoutMs') }),
                  headersFor: websiteFetchHeaders(settings),
                }),
          repo: resourceCacheRepo,
          now,
        },
        // Task 17: GitHub kinds refresh through `github-refresh.ts` — the
        // REST client is pinned to api.github.com (never global `fetch`) and
        // raw file downloads reuse the reviewed fetcher like any other
        // resource. The token is read per request and travels only in the
        // `Authorization` header.
        github: {
          client: createGitHubClient({
            token: deps.githubToken ?? (() => undefined),
            fetch: createGithubFetch(),
            guard: githubGuard,
          }),
          // Pinned to raw.githubusercontent.com: a redirect in a GitHub raw
          // download can never carry the refresh to another host (hard rule 8).
          // The live fetch timeout applies here too — but never headersFor:
          // the owner's header goes to listed website hosts only, never to
          // GitHub.
          fetcher:
            settings === undefined
              ? new ReviewedResourceFetcher({
                  now,
                  allowedHosts: ['raw.githubusercontent.com'],
                })
              : new ReviewedResourceFetcher({
                  now,
                  allowedHosts: ['raw.githubusercontent.com'],
                  limits: () => ({ timeoutMs: settings.get('resources.fetchTimeoutMs') }),
                }),
          store: assistantRepo,
          cache: resourceCacheRepo,
          now,
        },
        logger,
      }),
      conversationPruneHandler(scope, {
        now,
        logger,
        timeZone: () => config.BANANASAURS_TIME_ZONE,
      }),
      // Both enqueued daily by `housekeeping-timer.ts` (ADR 0127).
      pruneJobsHandler(scope, logger),
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
    updatePanel: (definition, newlyAllowlistedRoleIds = []) => {
      panelRepo.updatePanel(scope, definition, now(), newlyAllowlistedRoleIds);
    },
    async unpublishPanel(panelId) {
      const panel = panelRepo.findPanel(scope, panelId);
      if (panel === undefined) throw new Error(`no panel ${panelId} in guild ${guildId}`);

      if (panel.kind === 'managed' && panel.messageId !== undefined) {
        // Deleting a message that is already gone is a no-op, so retrying
        // this command is safe: an unknown message (10008/404) counts as
        // success. Any other Discord error throws with the rows still in
        // place, so a retry can finish.
        try {
          await discord.deleteMessage(
            guildId,
            { channelId: panel.channelId, messageId: panel.messageId },
            `panel delete ${panelId}`,
          );
        } catch (err) {
          if (!(err instanceof DiscordApiError && err.isGone)) throw err;
        }
      }
      panelRepo.deletePanel(scope, panelId);
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
