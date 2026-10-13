import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  cardCustomIds,
  cardTexts,
  createLoggingSubscriber,
  createModCardActionSubscriber,
  createModCommandSubscriber,
  createModConfirmationSubscriber,
  JOB_KINDS,
  ModerationActionGateway,
  parseGuildId,
  Pipeline,
  type HistoryDeps,
  type LoggingPorts,
  type MessageEvent,
  type ModCommandDeps,
  type ModConfirmationDeps,
  type ModerationGatewayDeps,
  type ModerationRefusalReason,
  type OutgoingMessage,
  type Snowflake,
} from '@bananasaurs/core';
import {
  authzRepo,
  guildRepo,
  jobRepo,
  loggingRepo,
  modCaseRepo,
  modPendingRepo,
  pipelineRepo,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { FakeDiscord } from '@bananasaurs/testkit';

/**
 * Moderator buttons on log cards, end to end (P2 Task 7, ADR 0141 decisions
 * 4–7).
 *
 * Wired the way `guild.ts` wires it — real repos on a migrated SQLite
 * database, `FakeDiscord`, a real `Pipeline` with the logging subscriber
 * (which posts the card carrying the buttons) plus the three mod
 * subscribers — but assembled by hand, the way `mod.integration.test.ts`
 * does, because `guild.ts` itself wants a real discord.js `Client`.
 */

const GUILD = parseGuildId('111111111111111111');

const MOD_ROLE: Snowflake = '700000000000000001';
const MODERATOR: Snowflake = '200000000000000001';
const UNAUTHORIZED: Snowflake = '200000000000000002';
const TARGET: Snowflake = '300000000000000001';

const CHANNEL: Snowflake = '500000000000000001';
const LOG: Snowflake = '777777777777777777';
const MESSAGE: Snowflake = '600000000000000001';

const BOT_HIGHEST_ROLE_POSITION = 50;

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let discord: FakeDiscord;
let pipeline: Pipeline;

function buildWiring(): {
  modCommandDeps: ModCommandDeps;
  modConfirmationDeps: ModConfirmationDeps;
} {
  const guildId = GUILD;
  const now = () => discord.now();

  const modCommandGateway = new ModerationActionGateway({
    guildId,
    authz: authzRepo.authzStoreFor(scope),
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

  const modConfirmationDeps: ModConfirmationDeps = {
    guildId,
    authz: authzRepo.authzStoreFor(scope),
    fetchInvokerRoleIds: async (userId) => (await discord.fetchMember(guildId, userId)).roleIds,
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
      take: (intentId, atMs) => modPendingRepo.takePendingAction(scope, intentId, atMs),
      peek: (intentId) => modPendingRepo.peekPendingAction(scope, intentId),
    },
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
    authz: authzRepo.authzStoreFor(scope),
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
          // Same narrowing `guild.ts` applies: `core`'s `WarnCasePorts`
          // widens this to a bare `string` (ADR 0014), and only
          // `ModerationOutcome['reason']` values ever flow through here.
          ...(input.refusalReason !== undefined && {
            refusalReason: input.refusalReason as ModerationRefusalReason,
          }),
        }),
    },
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
    history: {
      guildId,
      authz: authzRepo.authzStoreFor(scope),
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

  return { modCommandDeps, modConfirmationDeps };
}

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);

  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });
  guildRepo.setDryRun(scope, false, 0);

  loggingRepo.createRoute(scope, {
    name: 'route-message_create',
    channelId: LOG,
    includeContent: true,
    enabled: true,
    eventKinds: ['message_create'],
    excludedChannelIds: [],
    nowMs: 0,
  });

  discord = new FakeDiscord({ guildId: GUILD, botHighestRolePosition: BOT_HIGHEST_ROLE_POSITION });
  discord.defineRole({ id: MOD_ROLE, name: 'moderator', position: 10 });
  discord.defineMember(MODERATOR, [MOD_ROLE]);
  discord.defineMember(UNAUTHORIZED, []);
  discord.defineMember(TARGET, []);

  authzRepo.upsertPrincipal(scope, { principalType: 'role', principalId: MOD_ROLE });
  authzRepo.grantCapability(scope, {
    principalType: 'role',
    principalId: MOD_ROLE,
    capability: 'moderation.act',
    grantedBy: 'test',
    now: 0,
  });

  const { modCommandDeps, modConfirmationDeps } = buildWiring();

  const loggingPorts: LoggingPorts = {
    guildId: GUILD,
    listEnabledRoutesFor: (eventKind) => loggingRepo.listEnabledRoutesFor(scope, eventKind),
    isChannelExcluded: (channelId) => loggingRepo.isChannelExcluded(scope, channelId),
    listEnabledLogChannels: () => loggingRepo.listEnabledLogChannels(scope),
    claim: (input) => pipelineRepo.recordFirstSight(scope, { ...input, atMs: discord.now() }),
    release: (input) => pipelineRepo.forgetFirstSight(scope, input),
    sendMessage: (channelId, message) => discord.sendMessage(GUILD, channelId, message),
    enqueueDeletionAttribution: ({ dedupeKey, payload, runAfter }) =>
      jobRepo.enqueue(scope, {
        kind: JOB_KINDS.logMessageDelete,
        payload,
        dedupeKey,
        runAfter,
        now: discord.now(),
      }),
    getMemberSnapshot: (id) => loggingRepo.getMemberSnapshot(scope, id),
    saveMemberSnapshot: (s) =>
      loggingRepo.upsertMemberSnapshot(scope, { ...s, roleIds: [...s.roleIds] }),
    deleteMemberSnapshot: (id) => {
      loggingRepo.deleteMemberSnapshot(scope, id);
    },
    now: () => discord.now(),
    logger,
  };

  pipeline = new Pipeline({
    allowlist: new Set([GUILD]),
    dedupe: {
      firstSight: (input) => pipelineRepo.recordFirstSight(scope, input),
    },
    subscribers: [
      createLoggingSubscriber(loggingPorts),
      createModCommandSubscriber(modCommandDeps),
      createModConfirmationSubscriber(modConfirmationDeps),
      createModCardActionSubscriber({
        guildId: GUILD,
        commands: modCommandDeps,
        confirmations: modConfirmationDeps,
        responder: modCommandDeps.responder,
        now: () => discord.now(),
        logger,
      }),
    ],
    leaveGuild: async () => undefined,
    logger,
  });
  discord.onEvent(async (event) => {
    await pipeline.dispatch(event);
  });
});

afterEach(() => {
  t.close();
});

const messageCreate = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  kind: 'messageCreate',
  guildId: GUILD,
  receivedAtMs: 1,
  channelId: CHANNEL,
  parentChannelId: undefined,
  categoryId: undefined,
  isPrivateThread: false,
  messageId: MESSAGE,
  authorId: TARGET,
  authorDisplayName: undefined,
  authorIsBot: false,
  content: 'hello there',
  editedTimestampMs: undefined,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  ...over,
});

/** Every event recorded against any of the member's cases, oldest first. */
const caseEventsFor = (memberId: string) =>
  modCaseRepo
    .listCasesForMember(scope, memberId)
    .flatMap((c) => modCaseRepo.listCaseEvents(scope, c.caseId));

const replyTexts = (interactionId: string): string => {
  const replies = discord.interactionReplies(interactionId);
  return cardTexts(replies[replies.length - 1]?.components ?? []);
};

/**
 * Posts a message as TARGET, lets the log route post its card, and clicks
 * the card's Delete button as the moderator. Returns the confirm button's
 * custom id and the click's interaction id.
 */
const startDeleteFlow = async (): Promise<{ confirmId: string }> => {
  discord.defineMessage({ channelId: CHANNEL, messageId: MESSAGE, authorId: TARGET });
  await pipeline.dispatch(messageCreate());

  const sends = discord.restCalls('sendMessage');
  expect(sends).toHaveLength(1);
  const logCard = sends[0]?.args[2] as OutgoingMessage;
  const deleteId = cardCustomIds(logCard.components ?? []).find((id) =>
    id.startsWith('bs.mod:delete:'),
  );
  if (deleteId === undefined) throw new Error('no Delete button on the posted log card');

  const clickId = await discord.emitInteraction({
    channelId: LOG,
    messageId: '777777777777777779',
    userId: MODERATOR,
    customId: deleteId,
  });
  const confirmText = replyTexts(clickId);
  expect(confirmText).toContain(`Delete this message by <@${TARGET}>`);
  const confirmId = cardCustomIds(
    discord.interactionReplies(clickId).at(-1)?.components ?? [],
  ).find((id) => id.startsWith('modconfirm:'));
  if (confirmId === undefined) throw new Error('no Confirm button on the delete confirm card');
  return { confirmId };
};

describe('moderator buttons on log cards, end to end', () => {
  it('Delete: click → confirm card → Confirm deletes once, records deleted, and a second Confirm is already handled', async () => {
    const { confirmId } = await startDeleteFlow();

    const confirmClick = await discord.emitInteraction({
      channelId: LOG,
      messageId: '777777777777777779',
      userId: MODERATOR,
      customId: confirmId,
    });
    expect(replyTexts(confirmClick)).toContain('Deleted the message');
    expect(discord.restCalls('deleteMessage')).toHaveLength(1);

    const events = caseEventsFor(TARGET);
    const deleted = events.filter((e) => e.actionTaken === 'deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.actorId).toBe(MODERATOR);

    const replayClick = await discord.emitInteraction({
      channelId: LOG,
      messageId: '777777777777777779',
      userId: MODERATOR,
      customId: confirmId,
    });
    expect(replyTexts(replayClick)).toContain('This was already handled');
    expect(discord.restCalls('deleteMessage')).toHaveLength(1);
  });

  it('Delete with the kill switch on deletes nothing, records delete_blocked_killswitch, and says moderation is paused', async () => {
    const { confirmId } = await startDeleteFlow();
    guildRepo.setKillswitch(scope, true, discord.now());

    const confirmClick = await discord.emitInteraction({
      channelId: LOG,
      messageId: '777777777777777779',
      userId: MODERATOR,
      customId: confirmId,
    });

    expect(replyTexts(confirmClick)).toContain('Moderation is paused');
    expect(discord.restCalls('deleteMessage')).toHaveLength(0);
    const events = caseEventsFor(TARGET);
    expect(events.filter((e) => e.actionTaken === 'delete_blocked_killswitch')).toHaveLength(1);
  });

  it('Delete when someone else removed the message first says it was already gone and records no deleted event', async () => {
    const { confirmId } = await startDeleteFlow();
    discord.simulateDeletedMessage({ channelId: CHANNEL, messageId: MESSAGE });

    const confirmClick = await discord.emitInteraction({
      channelId: LOG,
      messageId: '777777777777777779',
      userId: MODERATOR,
      customId: confirmId,
    });

    expect(replyTexts(confirmClick)).toContain('That message was already gone');
    expect(caseEventsFor(TARGET).filter((e) => e.actionTaken === 'deleted')).toHaveLength(0);
  });

  it('Warn from a non-moderator warns nobody, records escalation_refused, and refuses privately', async () => {
    const submitId = await discord.emitModalSubmit({
      channelId: CHANNEL,
      userId: UNAUTHORIZED,
      customId: `bs.mod:warn:${TARGET}`,
      fields: { reason: 'spam' },
    });

    expect(replyTexts(submitId)).toContain("You can't take moderation actions");
    const events = caseEventsFor(TARGET);
    expect(events.filter((e) => e.actionTaken === 'warned')).toHaveLength(0);
    const refused = events.filter((e) => e.actionTaken === 'escalation_refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.refusalReason).toBe('unauthorized');
  });

  it('Timeout through the modal times out for the chosen duration and replies in words', async () => {
    const submitId = await discord.emitModalSubmit({
      channelId: CHANNEL,
      userId: MODERATOR,
      customId: `bs.mod:timeout:${TARGET}`,
      fields: { minutes: '10', reason: 'raid' },
    });

    expect(replyTexts(submitId)).toContain(`Timed out <@${TARGET}> for 10 minutes`);
    expect(discord.memberModerationState(TARGET)).toEqual({
      until: discord.now() + 600_000,
    });
  });
});
