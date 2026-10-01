import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  createModCommandSubscriber,
  createModConfirmationSubscriber,
  JOB_KINDS,
  JobWorker,
  ModerationActionGateway,
  parseGuildId,
  Pipeline,
  PURGE_TICK_SPACING_MS,
  type DispatchOutcome,
  type HistoryDeps,
  type MessageDeleteAttributionPorts,
  type ModCommandDeps,
  type ModConfirmationDeps,
  type ModerationGatewayDeps,
  type ModerationRefusalReason,
  type OutgoingMessage,
  type PurgePorts,
  type SlashCommandEvent,
  type SlashCommandOption,
  type Snowflake,
} from '@bananasaurs/core';
import {
  authzRepo,
  effectRepo,
  guildRepo,
  jobRepo,
  jobStoreFor,
  loggingRepo,
  modCaseRepo,
  modPendingRepo,
  pipelineRepo,
  schema,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { FakeDiscord } from '@bananasaurs/testkit';
import { logMessageDeleteHandler } from './jobs/logging.js';
import { modPurgeHandler } from './jobs/mod.js';

/**
 * `/mod`, end to end on the fake gateway (ADR 0037, Task 11).
 *
 * Every earlier task in this plan proved its own layer against faked ports:
 * the gateway (Task 3), the escalation ladder (Task 4), the ten subcommands
 * (Tasks 6-9) against a hand-faked `ModCommandDeps`/`ModConfirmationDeps`,
 * the purge job's own resumption mechanics against a real job table but a
 * hand-built `modPurgePayload` (`mod-purge.integration.test.ts`). This file
 * is the one place that wires all of it together the way `guild.ts` actually
 * does — real repos on a migrated SQLite database, `FakeDiscord`, a real
 * `Pipeline` with the real subscribers registered on it — and drives a
 * slash-command invocation all the way through to a Discord call (or an
 * honest refusal), and a confirm click all the way through to a completed
 * background job.
 *
 * Mirrors `automod.integration.test.ts`'s and `mod-purge.integration.test.ts`'s
 * shape: fixed snowflakes, `openMigratedTestDatabase`, dry-run off, and every
 * mod-related port block built the same way `guild.ts`'s `buildGuildRuntime`
 * builds it — not re-derived, copied field for field, per the task brief.
 * `guild.ts` itself is never called (it wants a real discord.js `Client`,
 * exactly what `FakeDiscord` exists to avoid).
 */

const GUILD = parseGuildId('111111111111111111');

// A moderator, granted `moderation.act` through a role rather than
// individually — the more realistic shape, and it doubles as the fixture for
// scenario 3 (a role positioned at or above the bot's own).
const MOD_ROLE: Snowflake = '700000000000000001';
const MODERATOR: Snowflake = '200000000000000001';
const UNAUTHORIZED: Snowflake = '200000000000000002';

const TARGET: Snowflake = '300000000000000001';
const WARN_TARGET: Snowflake = '300000000000000002';
const OWNER: Snowflake = '400000000000000001';

// Positioned at the bot's own highest role — `ModerationActionGateway`'s own
// hierarchy check (`highestMemberRolePosition >= botPosition`) refuses this
// strictly, matching `resolveAssignability`'s off-by-one guard.
const HIGH_ROLE: Snowflake = '700000000000000002';
const HIGH_MEMBER: Snowflake = '300000000000000003';
const BOT_HIGHEST_ROLE_POSITION = 50;

const CHANNEL: Snowflake = '500000000000000001';
const PURGE_CHANNEL: Snowflake = '500000000000000002';

const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let discord: FakeDiscord;
let pipeline: Pipeline;
let worker: JobWorker;
let nextInteractionSeq = 1;

/** A fresh, never-reused interaction id — every real invocation gets one. */
const newInteractionId = (): string => `interaction-${nextInteractionSeq++}`;

/**
 * Everything `/mod`-related that `guild.ts`'s `buildGuildRuntime` builds
 * inline, assembled the same way here — field for field, not re-derived.
 * There is no separate `mod/wiring.ts` module for this feature (unlike
 * automod's `apps/daemon/src/automod/wiring.ts`), so this function is this
 * test file's equivalent of `mod-purge.integration.test.ts`'s
 * `purgePortsFor`, widened to cover every mod port block rather than only
 * `purgePorts`.
 */
function buildModWiring(): {
  modCommandDeps: ModCommandDeps;
  modConfirmationDeps: ModConfirmationDeps;
  purgePorts: PurgePorts;
  deletionAttributionPorts: MessageDeleteAttributionPorts;
} {
  const guildId = GUILD;
  const now = () => discord.now();

  // Mirrors guild.ts:381-397.
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

  // Mirrors guild.ts:409-458.
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
      respond: async (ref, message) => {
        await discord.respondToInteraction(guildId, ref, message);
      },
    },
    now,
    logger,
  };

  // Mirrors guild.ts:319-372.
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

  // Mirrors guild.ts:460-578.
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

  // Mirrors guild.ts:282-312 — needed for the job worker's
  // `log_message_delete` handler, registered alongside `modPurgeHandler` for
  // the same reason `mod-purge.integration.test.ts`'s own docstring gives:
  // both kinds share one worker and one queue in production, and a purge
  // tick's self-enqueued attribution job would otherwise fail with "no
  // handler registered" for a reason that has nothing to do with what this
  // suite is proving. No log route is seeded, so it no-ops.
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

  return { modCommandDeps, modConfirmationDeps, purgePorts, deletionAttributionPorts };
}

/** Dispatches a `/mod <subcommand>` slash command through the real pipeline. */
const dispatchSlashCommand = async (input: {
  subcommandPath: readonly string[];
  options: readonly SlashCommandOption[];
  userId: Snowflake;
  channelId?: Snowflake;
}): Promise<{ interactionId: string; event: SlashCommandEvent; outcome: DispatchOutcome }> => {
  const interactionId = newInteractionId();
  const token = `tok-${interactionId}`;
  discord.registerInteraction({ interactionId, token });
  const event: SlashCommandEvent = {
    kind: 'slashCommand',
    guildId: GUILD,
    receivedAtMs: discord.now(),
    interactionId,
    token,
    commandName: 'mod',
    subcommandPath: input.subcommandPath,
    options: input.options,
    channelId: input.channelId ?? CHANNEL,
    userId: input.userId,
  };
  const outcome = await pipeline.dispatch(event);
  return { interactionId, event, outcome };
};

/** The Confirm button's `custom_id`, pulled out of a preview reply's components. */
const extractConfirmCustomId = (message: OutgoingMessage | undefined): string => {
  const rows = message?.components as
    readonly { components: readonly { custom_id: string }[] }[] | undefined;
  const customId = rows?.[0]?.components?.[0]?.custom_id;
  if (typeof customId !== 'string') throw new Error('no Confirm button found in the preview reply');
  return customId;
};

function findCase(memberId: string) {
  return modCaseRepo.listCasesForMember(scope, memberId)[0];
}

/** Discord's real snowflake epoch — see `mod-purge.integration.test.ts` for why this is reproduced rather than imported. */
const DISCORD_EPOCH_MS = 1_420_070_400_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const idAt = (createdAtMs: number): string =>
  ((BigInt(Math.trunc(createdAtMs)) - BigInt(DISCORD_EPOCH_MS)) << 22n).toString();

/** `count` messages in `PURGE_CHANNEL`, newest first, all `ageMs` old. */
const seedMessages = (count: number, ageMs: number): string[] => {
  const base = discord.now() - ageMs;
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = idAt(base - i);
    discord.defineMessage({ channelId: PURGE_CHANNEL, messageId: id, authorId: TARGET });
    ids.push(id);
  }
  return ids;
};

beforeEach(() => {
  nextInteractionSeq = 1;
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);

  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });
  guildRepo.setDryRun(scope, false, 0);

  discord = new FakeDiscord({ guildId: GUILD, botHighestRolePosition: BOT_HIGHEST_ROLE_POSITION });
  discord.defineRole({ id: MOD_ROLE, name: 'moderator', position: 10 });
  discord.defineRole({ id: HIGH_ROLE, name: 'too-high', position: BOT_HIGHEST_ROLE_POSITION });
  discord.defineMember(MODERATOR, [MOD_ROLE]);
  discord.defineMember(UNAUTHORIZED, []);
  discord.defineMember(TARGET, []);
  discord.defineMember(WARN_TARGET, []);
  discord.defineMember(OWNER, [], true);
  discord.defineMember(HIGH_MEMBER, [HIGH_ROLE]);

  authzRepo.upsertPrincipal(scope, { principalType: 'role', principalId: MOD_ROLE });
  authzRepo.grantCapability(scope, {
    principalType: 'role',
    principalId: MOD_ROLE,
    capability: 'moderation.act',
    grantedBy: 'test',
    now: 0,
  });

  const { modCommandDeps, modConfirmationDeps, purgePorts, deletionAttributionPorts } =
    buildModWiring();

  // Exactly `guild.ts`'s subscriber registration for these two (lines
  // 599-600), plus the connective tissue (dedupe store, allowlist) every
  // integration test in this app builds the same way.
  pipeline = new Pipeline({
    allowlist: new Set([GUILD]),
    dedupe: {
      firstSight: (input) => pipelineRepo.recordFirstSight(scope, input),
    },
    subscribers: [
      createModCommandSubscriber(modCommandDeps),
      createModConfirmationSubscriber(modConfirmationDeps),
    ],
    leaveGuild: async () => undefined,
    logger,
  });
  // Button clicks arrive as ordinary `interaction` gateway events, the same
  // route every other integration test in this app uses.
  discord.onEvent(async (event) => {
    await pipeline.dispatch(event);
  });

  worker = new JobWorker({
    store: jobStoreFor(scope),
    handlers: [modPurgeHandler(purgePorts), logMessageDeleteHandler(deletionAttributionPorts)],
    logger,
    now: () => discord.now(),
  });
});

afterEach(() => {
  t.close();
});

describe('/mod, end to end on the fake gateway', () => {
  it('an unauthorized caller is refused ephemerally, the refusal is durably recorded on the case, and nothing is attempted on the fake', async () => {
    const { interactionId } = await dispatchSlashCommand({
      subcommandPath: ['kick'],
      options: [
        { name: 'target', value: TARGET },
        { name: 'reason', value: 'testing an unauthorized caller' },
      ],
      userId: UNAUTHORIZED,
    });

    expect(discord.wasEphemeral(interactionId)).toBe(true);
    const replies = discord.interactionReplies(interactionId);
    expect(replies[0]?.content).toContain('do not have permission');
    expect(discord.restCalls('kickMember')).toHaveLength(0);

    const modCase = findCase(TARGET);
    expect(modCase).toBeDefined();
    const events = modCaseRepo.listCaseEvents(scope, modCase!.caseId);
    const last = events[events.length - 1];
    expect(last?.actionTaken).toBe('escalation_refused');
    expect(last?.refusalReason).toBe('unauthorized');
    expect(last?.matchedCategory).toBe('kick');
  });

  it('a target who is the guild owner is refused with discord-owner, durably recorded, and no Discord call is attempted', async () => {
    const { interactionId } = await dispatchSlashCommand({
      subcommandPath: ['timeout'],
      options: [
        { name: 'target', value: OWNER },
        { name: 'reason', value: 'testing an owner target' },
        { name: 'duration_minutes', value: 10 },
      ],
      userId: MODERATOR,
    });

    const replies = discord.interactionReplies(interactionId);
    expect(replies[0]?.content).toContain('refused');
    expect(discord.restCalls('timeoutMember')).toHaveLength(0);

    const modCase = findCase(OWNER);
    expect(modCase).toBeDefined();
    const events = modCaseRepo.listCaseEvents(scope, modCase!.caseId);
    const last = events[events.length - 1];
    expect(last?.actionTaken).toBe('escalation_refused');
    expect(last?.refusalReason).toBe('discord-owner');
    expect(last?.escalationAction).toBe('timeout');
  });

  it('a target whose highest role sits at or above the bot is refused with role-above-bot, durably recorded, and no Discord call is attempted', async () => {
    const { interactionId } = await dispatchSlashCommand({
      subcommandPath: ['kick'],
      options: [
        { name: 'target', value: HIGH_MEMBER },
        { name: 'reason', value: 'testing a role-above-bot target' },
      ],
      userId: MODERATOR,
    });

    const replies = discord.interactionReplies(interactionId);
    expect(replies[0]?.content).toContain('refused');
    expect(discord.restCalls('kickMember')).toHaveLength(0);

    const modCase = findCase(HIGH_MEMBER);
    expect(modCase).toBeDefined();
    const events = modCaseRepo.listCaseEvents(scope, modCase!.caseId);
    const last = events[events.length - 1];
    expect(last?.actionTaken).toBe('escalation_refused');
    expect(last?.refusalReason).toBe('role-above-bot');
  });

  it('/mod ban previews then executes on confirm, and a double-tap on Confirm produces exactly one ban', async () => {
    const { interactionId: slashId } = await dispatchSlashCommand({
      subcommandPath: ['ban'],
      options: [
        { name: 'target', value: TARGET },
        { name: 'reason', value: 'repeated spam' },
      ],
      userId: MODERATOR,
    });

    const preview = discord.interactionReplies(slashId)[0];
    expect(preview?.content).toContain('Ban preview');
    // Nothing executed yet — the whole point of the confirm-then-execute
    // handshake (ADR 0037, Task 7).
    expect(discord.restCalls('banMember')).toHaveLength(0);

    const customId = extractConfirmCustomId(preview);
    const messageId = '600000000000000001';

    // A genuine double-tap: two separate Discord interactions (distinct
    // interaction ids, as two real clicks would be), both on the same
    // Confirm button's custom id.
    const click1 = await discord.emitInteraction({
      channelId: CHANNEL,
      messageId,
      userId: MODERATOR,
      customId,
    });
    const click2 = await discord.emitInteraction({
      channelId: CHANNEL,
      messageId,
      userId: MODERATOR,
      customId,
    });

    expect(discord.restCalls('banMember')).toHaveLength(1);
    expect(discord.isBanned(TARGET)).toBe(true);

    const reply1 = discord.interactionReplies(click1)[0];
    expect(reply1?.content).toContain('Ban applied');
    const reply2 = discord.interactionReplies(click2)[0];
    expect(reply2?.content).toContain('already executed');

    const modCase = findCase(TARGET);
    expect(modCase).toBeDefined();
    const events = modCaseRepo.listCaseEvents(scope, modCase!.caseId);
    const applied = events.filter(
      (e) => e.actionTaken === 'manual_applied' && e.matchedCategory === 'ban',
    );
    expect(applied).toHaveLength(1);
  });

  it('three warnings cross the timeout tier automatically; replaying the identical warn interaction applies no second timeout', async () => {
    let lastInteractionId = '';
    let lastEvent: SlashCommandEvent | undefined;
    for (let i = 0; i < 3; i += 1) {
      const { interactionId, event } = await dispatchSlashCommand({
        subcommandPath: ['warn'],
        options: [
          { name: 'target', value: WARN_TARGET },
          { name: 'reason', value: `violation number ${i + 1}` },
        ],
        userId: MODERATOR,
      });
      lastInteractionId = interactionId;
      lastEvent = event;
    }

    expect(discord.restCalls('timeoutMember')).toHaveLength(1);
    const modCase = findCase(WARN_TARGET);
    expect(modCase).toBeDefined();
    expect(modCase!.violationCount).toBe(3);

    const events = modCaseRepo.listCaseEvents(scope, modCase!.caseId);
    const escalation = events.find(
      (e) => e.actionTaken === 'manual_applied' && e.escalationAction === 'timeout',
    );
    expect(escalation).toBeDefined();
    const warnedCount = events.filter((e) => e.actionTaken === 'warned').length;
    expect(warnedCount).toBe(3);

    // Replay: the identical third interaction, re-dispatched through the
    // exact same pipeline path production uses. `fingerprintOf`
    // (`packages/core/src/pipeline/fingerprint.ts`) fingerprints a
    // `slashCommand` event on its own `interactionId`, so the pipeline's own
    // dedupe gate absorbs this literal replay before the mod-command
    // subscriber ever runs a second time — `issueWarn` (`warn.ts`) is not
    // re-invoked at all. The warn-escalation dedupe key inside `issueWarn`
    // (Ruling 2 in this plan's ledger:
    // `mod:<guildId>:warn-escalation:<caseId>:<warnId>`) is a second,
    // independent idempotency layer for the same class of replay — CLAUDE.md
    // rule 6's "assume gateway events replay" — that this particular
    // dispatch never reaches, because the outer pipeline gate already stops
    // it first; that inner key's own behaviour is exercised directly in
    // `packages/core/src/mod/warn.test.ts`. What this assertion proves is
    // that the real, composed dispatch path — the one production actually
    // runs — does not apply a second timeout on a replay, whichever layer is
    // the one that catches it.
    expect(lastEvent).toBeDefined();
    const replayOutcome = await pipeline.dispatch(lastEvent!);
    expect(replayOutcome).toEqual({ status: 'dropped', reason: 'duplicate' });

    expect(discord.restCalls('timeoutMember')).toHaveLength(1);
    expect(findCase(WARN_TARGET)!.violationCount).toBe(3);
    void lastInteractionId; // captured for readability only; not separately asserted
  });

  it('/mod purge confirm runs the job to completion: bulk-deletes the fresh messages, deletes the old ones one at a time, and honestly attributes every deletion', async () => {
    // A small fixture, per the task brief: `mod-purge.integration.test.ts`
    // already exhaustively proves the job's own resumption mechanics at the
    // `runPurgeTick`/job-table level (restart, crash-before-claim,
    // crash-after-work). This scenario's only job is the layer that test
    // does not touch — the real `/mod purge` slash command, preview,
    // confirm click, and the resulting job run to completion through the
    // real subscribers wired above, not a hand-built `modPurgePayload`.
    const freshIds = seedMessages(3, DAY_MS); // well under the 14-day ceiling
    const oldIds = seedMessages(2, 20 * DAY_MS); // over it

    const { interactionId: slashId } = await dispatchSlashCommand({
      subcommandPath: ['purge'],
      options: [
        { name: 'channel', value: PURGE_CHANNEL },
        { name: 'reason', value: 'channel cleanup' },
      ],
      userId: MODERATOR,
      channelId: PURGE_CHANNEL,
    });

    const preview = discord.interactionReplies(slashId)[0];
    expect(preview?.content).toContain('Purge preview');
    expect(discord.restCalls('bulkDeleteMessages')).toHaveLength(0);
    expect(discord.restCalls('deleteMessage')).toHaveLength(0);

    const customId = extractConfirmCustomId(preview);
    await discord.emitInteraction({
      channelId: PURGE_CHANNEL,
      messageId: '610000000000000001',
      userId: MODERATOR,
      customId,
    });

    // Drives the job to completion: `drain` stops the instant nothing is
    // immediately due, and every tick after the first is spaced
    // `PURGE_TICK_SPACING_MS` apart (ADR 0037's rate-limit spacing) — so the
    // clock has to advance between rounds, the same shape
    // `mod-purge.integration.test.ts`'s restart scenario uses, just looped
    // until the queue is genuinely empty rather than stopped after one
    // restart.
    let totalRan = 0;
    for (let round = 0; round < 10; round += 1) {
      const ran = await worker.drain(50);
      totalRan += ran;
      if (ran === 0) break;
      discord.advance(PURGE_TICK_SPACING_MS + 100);
    }
    expect(totalRan).toBeGreaterThan(0);
    expect(await worker.runOnce()).toEqual({ status: 'idle' });

    expect(discord.restCalls('bulkDeleteMessages')).toHaveLength(1);
    expect(discord.restCalls('bulkDeleteMessages')[0]?.args[2]).toEqual(freshIds);
    expect(discord.restCalls('deleteMessage')).toHaveLength(2);
    const oldDeletedIds = discord
      .restCalls('deleteMessage')
      .map((c) => (c.args[1] as { messageId: string }).messageId);
    expect(new Set(oldDeletedIds)).toEqual(new Set(oldIds));

    // A purge has no single target member — it attaches to the confirming
    // moderator's own, non-counting case (`purge.ts`'s `recordPurgeCaseEvent`).
    const modCase = findCase(MODERATOR);
    expect(modCase).toBeDefined();
    expect(modCase!.violationCount).toBe(0);
    const events = modCaseRepo.listCaseEvents(scope, modCase!.caseId);
    const purged = events.filter((e) => e.actionTaken === 'purged');
    expect(purged).toHaveLength(1);
    expect(purged[0]?.matchedSnippet).toContain('5');

    const auditRows = t.db
      .select()
      .from(schema.auditEvents)
      .all()
      .filter((r) => r.action === 'message_delete');
    expect(auditRows).toHaveLength(5);
    for (const row of auditRows) {
      expect(row.actorId).toBe(MODERATOR);
      expect(row.inferred).toBe(0);
    }

    const attributionJobs = jobRepo
      .listJobs(scope, { limit: 500 })
      .filter((j) => j.kind === JOB_KINDS.logMessageDelete);
    expect(attributionJobs).toHaveLength(5);
  });
});
