import { randomUUID } from 'node:crypto';
import {
  createConnectionSubscriber,
  createInteractionSubscriber,
  createLoggingSubscriber,
  createMemberUpdateSubscriber,
  createReactionSubscriber,
  EffectGateway,
  JobWorker,
  JOB_KINDS,
  parseGuildId,
  parseSnowflakeId,
  RateLimiter,
  type AdoptionPorts,
  type Config,
  type DiscordPort,
  type EffectGatewayDeps,
  type InteractionSubscriberDeps,
  type Logger,
  type LoggingPorts,
  type MemberUpdatePorts,
  type MessageDeleteAttributionPorts,
  type ReconcilePorts,
  type Subscriber,
} from '@bananasaurs/core';
import {
  authzStoreFor,
  effectRepo,
  guildRepo,
  isTargetProtected,
  jobRepo,
  jobStoreFor,
  loggingRepo,
  panelRepo,
  pipelineRepo,
  roleRepo,
  type GuildScope,
} from '@bananasaurs/storage';
import { adoptionStateWriter, adoptPanelHandler } from '../jobs/adopt.js';
import { sweepEventDedupeHandler } from '../jobs/handlers.js';
import { logMessageDeleteHandler } from '../jobs/logging.js';
import { reconcileGuildHandler } from '../jobs/reconcile.js';
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
  readonly config: Config;
  readonly discord: DiscordPort;
  readonly logger: Logger;
  /** A property, not a method: it is destructured and passed on by value. */
  readonly now: () => number;
}

export interface GuildRuntime {
  readonly guildId: string;
  readonly subscribers: readonly Subscriber[];
  readonly worker: JobWorker;
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
  const { scope, config, discord, logger, now } = deps;
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
      respond: (ref, message) => discord.respondToInteraction(guildId, ref, message),
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
  ];

  const worker = new JobWorker({
    store: jobStoreFor(scope),
    handlers: [
      reconcileGuildHandler(scope, reconcilePorts, now),
      adoptPanelHandler(adoptionPorts),
      logMessageDeleteHandler(deletionAttributionPorts),
      // Registered although nothing enqueues one yet: a handler missing when a
      // job arrives fails the job, and the sweep's producer is a scheduler this
      // slice does not build (ADR 0020).
      sweepEventDedupeHandler(scope, logger),
    ],
    logger,
    now,
  });

  return { guildId, subscribers, worker };
}
