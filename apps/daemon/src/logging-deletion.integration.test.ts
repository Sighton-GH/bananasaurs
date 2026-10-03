import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  attributeAndLogDeletion,
  createLoggingSubscriber,
  JOB_KINDS,
  JobWorker,
  MESSAGE_DELETE_ATTRIBUTION_DELAY_MS,
  parseGuildId,
  parseSnowflakeId,
  type LoggingPorts,
  type MessageDeleteAttributionPorts,
} from '@bananasaurs/core';
import {
  effectRepo,
  guildRepo,
  jobRepo,
  jobStoreFor,
  loggingRepo,
  pipelineRepo,
  write,
  schema,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { AUDIT_LOG_LAG_MS, FakeDiscord } from '@bananasaurs/testkit';
import { logMessageDeleteHandler } from './jobs/logging.js';

/**
 * The hard part of WP4 (ADR 0023 decision 3): who deleted a message, decided
 * from a coalesced, late-arriving, message-id-free audit log. Wired against
 * the real repositories and `FakeDiscord`'s own clock, because the timing —
 * the whole reason the job is delayed at all — cannot be proven by a fake
 * agreeing with itself.
 */

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = '222222222222222222';
const LOG = '777777777777777777';
const OTHER_LOG = '888888888888888888';
const AUTHOR = '333333333333333333';
const MOD_A = '444444444444444444';
const MOD_B = '555555555555555555';
const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let discord: FakeDiscord;
let subscriber: ReturnType<typeof createLoggingSubscriber>;
let worker: JobWorker;
let jobPorts: MessageDeleteAttributionPorts;

const seedRoute = (
  over: { name?: string; channelId?: string; includeContent?: boolean; enabled?: boolean } = {},
) =>
  loggingRepo.createRoute(scope, {
    name: over.name ?? 'route-message-delete',
    channelId: over.channelId ?? LOG,
    includeContent: over.includeContent ?? true,
    enabled: over.enabled ?? true,
    eventKinds: ['message_delete'],
    excludedChannelIds: [],
    nowMs: 0,
  });

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });
  discord = new FakeDiscord({ guildId: GUILD });
  seedRoute();

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
  subscriber = createLoggingSubscriber(loggingPorts);
  discord.onEvent((event) => subscriber.handle(event));

  jobPorts = {
    guildId: GUILD,
    listEnabledRoutesFor: (eventKind) => loggingRepo.listEnabledRoutesFor(scope, eventKind),
    fetchAuditLog: () => discord.fetchAuditLog(GUILD, { actionType: 'message_delete', limit: 25 }),
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
    claim: (input) => pipelineRepo.recordFirstSight(scope, { ...input, atMs: discord.now() }),
    release: (input) => pipelineRepo.forgetFirstSight(scope, input),
    sendMessage: (channelId, message) => discord.sendMessage(GUILD, channelId, message),
    logger,
    now: () => discord.now(),
  };
  worker = new JobWorker({
    store: jobStoreFor(scope),
    handlers: [logMessageDeleteHandler(jobPorts)],
    logger,
    now: () => discord.now(),
  });
});

afterEach(() => {
  t.close();
});

const define = (messageId: string) =>
  discord.defineMessage({ channelId: CHANNEL, messageId, authorId: AUTHOR });

describe('a known actor', () => {
  it('is attributed and labelled inferred, never as plain attribution', async () => {
    const messageId = '600000000000000001';
    define(messageId);
    await discord.deleteMessageAs({ channelId: CHANNEL, messageId, actorUserId: MOD_A });

    discord.advance(MESSAGE_DELETE_ATTRIBUTION_DELAY_MS);
    expect(await worker.drain()).toBe(1);

    const posted = discord.restCalls('sendMessage').at(-1);
    const content = (posted?.args[2] as { content: string }).content;
    expect(content).toContain(`<@${MOD_A}>`);
    expect(content.toLowerCase()).toContain('inferred');

    const attribution = loggingRepo.findMessageDeleteAttribution(scope, messageId);
    expect(attribution).toEqual({ actorId: MOD_A, inferred: true });
  });

  it('claims one unit of the run so a second, independent deletion by the same moderator is also attributed', async () => {
    const first = '600000000000000002';
    const second = '600000000000000003';
    define(first);
    define(second);

    await discord.deleteMessageAs({ channelId: CHANNEL, messageId: first, actorUserId: MOD_A });
    await discord.deleteMessageAs({ channelId: CHANNEL, messageId: second, actorUserId: MOD_A });

    discord.advance(MESSAGE_DELETE_ATTRIBUTION_DELAY_MS);
    expect(await worker.drain()).toBe(2);

    expect(loggingRepo.findMessageDeleteAttribution(scope, first)).toEqual({
      actorId: MOD_A,
      inferred: true,
    });
    expect(loggingRepo.findMessageDeleteAttribution(scope, second)).toEqual({
      actorId: MOD_A,
      inferred: true,
    });
  });

  it('does not let a fully-claimed run keep attributing a later, unrelated self-deletion', async () => {
    // If the cursor never advanced, both prior deletions' "unclaimed" would
    // stay visible forever, and a self-deletion arriving later in the same
    // (author, channel) would wrongly inherit the stale, ever-unclaimed
    // activity and be attributed to the moderator who deleted the first two.
    const first = '600000000000000010';
    const second = '600000000000000011';
    const selfDeleted = '600000000000000012';
    define(first);
    define(second);
    define(selfDeleted);

    await discord.deleteMessageAs({ channelId: CHANNEL, messageId: first, actorUserId: MOD_A });
    await discord.deleteMessageAs({ channelId: CHANNEL, messageId: second, actorUserId: MOD_A });
    discord.advance(MESSAGE_DELETE_ATTRIBUTION_DELAY_MS);
    expect(await worker.drain()).toBe(2);
    // Both real deletions correctly attributed first — the cursor must now
    // read 2 for this run, matching the entry's live count exactly.
    expect(loggingRepo.findMessageDeleteAttribution(scope, first)?.actorId).toBe(MOD_A);
    expect(loggingRepo.findMessageDeleteAttribution(scope, second)?.actorId).toBe(MOD_A);

    await discord.deleteMessageAs({
      channelId: CHANNEL,
      messageId: selfDeleted,
      actorUserId: AUTHOR,
    });
    discord.advance(MESSAGE_DELETE_ATTRIBUTION_DELAY_MS);
    expect(await worker.drain()).toBe(1);

    expect(loggingRepo.findMessageDeleteAttribution(scope, selfDeleted)).toEqual({
      actorId: undefined,
      inferred: false,
    });
  });
});

describe('a self-deletion', () => {
  it('is unknown, never a guess — Discord writes no entry for it (ADR 0019)', async () => {
    const messageId = '600000000000000004';
    define(messageId);
    await discord.deleteMessageAs({ channelId: CHANNEL, messageId, actorUserId: AUTHOR });

    discord.advance(MESSAGE_DELETE_ATTRIBUTION_DELAY_MS);
    expect(await worker.drain()).toBe(1);

    const content = (discord.restCalls('sendMessage').at(-1)?.args[2] as { content: string })
      .content;
    expect(content.toLowerCase()).toContain('unknown');

    expect(loggingRepo.findMessageDeleteAttribution(scope, messageId)).toEqual({
      actorId: undefined,
      inferred: false,
    });
  });
});

describe('the audit log has not caught up yet', () => {
  it('is unknown rather than treated as a self-deletion', async () => {
    // Direct call, bypassing the job's own delay: the entry exists but is not
    // visible yet, which is exactly ADR 0019 fact 3's "no entry yet" case —
    // indistinguishable from a self-deletion at the moment of the fetch, and
    // only one of them is safe to assert.
    const messageId = '600000000000000005';
    discord.defineAuditLogEntry({
      actionType: 'message_delete',
      actorUserId: MOD_A,
      targetId: AUTHOR,
      channelId: CHANNEL,
      count: 1,
    });

    await attributeAndLogDeletion(jobPorts, {
      channelId: parseSnowflakeId(CHANNEL),
      messageId: parseSnowflakeId(messageId),
      authorId: parseSnowflakeId(AUTHOR),
      content: undefined,
      deletedAtMs: discord.now(),
    });

    expect(loggingRepo.findMessageDeleteAttribution(scope, messageId)).toEqual({
      actorId: undefined,
      inferred: false,
    });
  });
});

describe('two candidates, both unclaimed', () => {
  it('is unknown — guessing between them is the guess the gate forbids', async () => {
    const messageId = '600000000000000006';
    discord.defineAuditLogEntry({
      actionType: 'message_delete',
      actorUserId: MOD_A,
      targetId: AUTHOR,
      channelId: CHANNEL,
      count: 1,
    });
    discord.defineAuditLogEntry({
      actionType: 'message_delete',
      actorUserId: MOD_B,
      targetId: AUTHOR,
      channelId: CHANNEL,
      count: 1,
    });
    discord.advance(AUDIT_LOG_LAG_MS);

    await attributeAndLogDeletion(jobPorts, {
      channelId: parseSnowflakeId(CHANNEL),
      messageId: parseSnowflakeId(messageId),
      authorId: parseSnowflakeId(AUTHOR),
      content: undefined,
      deletedAtMs: discord.now(),
    });

    const content = (discord.restCalls('sendMessage').at(-1)?.args[2] as { content: string })
      .content;
    expect(content).not.toContain(`<@${MOD_A}>`);
    expect(content).not.toContain(`<@${MOD_B}>`);
    expect(loggingRepo.findMessageDeleteAttribution(scope, messageId)?.actorId).toBeUndefined();
  });
});

describe('idempotency across a retry', () => {
  it('does not re-resolve or re-record on a retry after a failed send, and still delivers on the retry', async () => {
    const messageId = '600000000000000007';
    define(messageId);
    await discord.deleteMessageAs({ channelId: CHANNEL, messageId, actorUserId: MOD_A });
    discord.advance(AUDIT_LOG_LAG_MS);

    const payload = {
      channelId: parseSnowflakeId(CHANNEL),
      messageId: parseSnowflakeId(messageId),
      authorId: parseSnowflakeId(AUTHOR),
      content: undefined,
      deletedAtMs: discord.now(),
    };

    discord.failNext('sendMessage', FakeDiscord.missingPermissions());
    await expect(attributeAndLogDeletion(jobPorts, payload)).rejects.toThrow();
    // The failed attempt is recorded (the fake records before it checks for a
    // queued failure) but nothing was actually delivered by it.
    expect(discord.restCalls('sendMessage')).toHaveLength(1);
    // The resolution is durable even though the send failed.
    expect(loggingRepo.findMessageDeleteAttribution(scope, messageId)).toEqual({
      actorId: MOD_A,
      inferred: true,
    });

    await attributeAndLogDeletion(jobPorts, payload);
    expect(discord.restCalls('sendMessage')).toHaveLength(2);
    const content = (discord.restCalls('sendMessage').at(-1)?.args[2] as { content: string })
      .content;
    expect(content).toContain(`<@${MOD_A}>`);

    // A third message in the same run must still see its own unclaimed unit —
    // the retry above must not have double-claimed the first message's unit.
    const third = '600000000000000008';
    define(third);
    await discord.deleteMessageAs({ channelId: CHANNEL, messageId: third, actorUserId: MOD_A });
    discord.advance(MESSAGE_DELETE_ATTRIBUTION_DELAY_MS);
    // 2, not 1: the wired subscriber also auto-enqueued a job for the first
    // message when it was deleted above, which the direct calls to
    // `attributeAndLogDeletion` in this test never claimed from the queue. It
    // is still sitting there, due, and runs as a harmless no-op — the
    // per-message claim is already set from the direct call's success.
    expect(await worker.drain()).toBe(2);
    expect(loggingRepo.findMessageDeleteAttribution(scope, third)).toEqual({
      actorId: MOD_A,
      inferred: true,
    });
  });
});

describe('the route', () => {
  it('is not consulted before the job runs — checked fresh, at execution time', async () => {
    const messageId = '600000000000000009';
    define(messageId);
    await discord.deleteMessageAs({ channelId: CHANNEL, messageId, actorUserId: MOD_A });

    // Disable the route after enqueueing but before the job runs.
    write(scope, ({ db }) => {
      db.update(schema.logRoutes).set({ enabled: 0 }).run();
    });

    discord.advance(MESSAGE_DELETE_ATTRIBUTION_DELAY_MS);
    expect(await worker.drain()).toBe(1);
    expect(discord.restCalls('sendMessage')).toHaveLength(0);
  });
});

describe('two routes', () => {
  it('each gets the deletion line, with one audit row recorded', async () => {
    seedRoute({ name: 'route-b', channelId: OTHER_LOG });
    const messageId = '600000000000000020';
    define(messageId);
    await discord.deleteMessageAs({ channelId: CHANNEL, messageId, actorUserId: MOD_A });

    discord.advance(MESSAGE_DELETE_ATTRIBUTION_DELAY_MS);
    expect(await worker.drain()).toBe(1);

    const calls = discord.restCalls('sendMessage');
    expect(calls.map((c) => c.args[1]).sort()).toEqual([LOG, OTHER_LOG].sort());
    for (const call of calls) {
      expect((call.args[2] as { content: string }).content).toContain(`<@${MOD_A}>`);
    }
    expect(loggingRepo.findMessageDeleteAttribution(scope, messageId)).toEqual({
      actorId: MOD_A,
      inferred: true,
    });
  });
});
