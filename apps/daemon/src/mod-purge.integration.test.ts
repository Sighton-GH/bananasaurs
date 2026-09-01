import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  JOB_KINDS,
  JobWorker,
  parseGuildId,
  purgeDedupeKey,
  type MessageDeleteAttributionPorts,
  type PurgePorts,
} from '@bananasaurs/core';
import {
  effectRepo,
  guildRepo,
  jobRepo,
  jobStoreFor,
  loggingRepo,
  modCaseRepo,
  pipelineRepo,
  schema,
  type GuildScope,
} from '@bananasaurs/storage';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { FakeDiscord } from '@bananasaurs/testkit';
import { logMessageDeleteHandler } from './jobs/logging.js';
import { modPurgeHandler } from './jobs/mod.js';

/**
 * The bounded purge job wired against the real job table (ADR 0037, Task 5).
 *
 * `packages/core/src/mod/purge.test.ts` proves `runPurgeTick`'s own logic
 * with faked ports, including the dedupe-key scheme against a fake store
 * that *simulates* `jobs_dedupe`'s partial-unique-while-live rule. This file
 * is the fully real version of that proof — actual `jobRepo.enqueue`, actual
 * SQLite's own partial unique index, actual `JobWorker.runOnce` — plus the
 * task brief's Step 3 acceptance test: run part of a purge, throw away the
 * in-memory `JobWorker` (a stand-in for a process restart), build a
 * genuinely new one over the same on-disk state, and prove the purge
 * resumes without deleting anything twice.
 */

const GUILD = parseGuildId('111111111111111111');
const CHANNEL = '222222222222222222';
const MOD = '333333333333333333';
const logger = pino({ level: 'silent' });

let t: ReturnType<typeof openMigratedTestDatabase>;
let scope: GuildScope;
let discord: FakeDiscord;

/** Mirrors `guild.ts`'s `purgePorts` construction exactly. */
const purgePortsFor = (): PurgePorts => ({
  guildId: GUILD,
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
    void jobRepo.enqueue(scope, {
      kind: JOB_KINDS.logMessageDelete,
      payload,
      dedupeKey,
      runAfter,
      now: discord.now(),
    }),
  enqueuePurgeContinuation: ({ payload, cursor, dedupeKey, runAfter }) =>
    void jobRepo.enqueue(scope, {
      kind: JOB_KINDS.modPurge,
      payload,
      cursor,
      dedupeKey,
      runAfter,
      now: discord.now(),
    }),
  now: () => discord.now(),
  logger,
});

/**
 * The purge job self-enqueues the *ordinary* `log_message_delete` job for
 * every deletion (ADR 0037), and in the real daemon (`guild.ts`) both
 * handlers share one worker and one queue. Registering only
 * `modPurgeHandler` here would let a `log_message_delete` row reach
 * `claimNext` first (it is due at the same instant) and fail with "no
 * handler registered" — a false negative that has nothing to do with what
 * this suite is proving. No log route is seeded, so
 * `attributeAndLogDeletion` finds none and no-ops rather than sending
 * anything; its own behaviour is `logging-deletion.integration.test.ts`'s
 * job, not this file's.
 */
const deletionAttributionPortsFor = (): MessageDeleteAttributionPorts => ({
  guildId: GUILD,
  findRoute: (eventKind) => loggingRepo.findRoute(scope, eventKind),
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
});

const newWorker = (): JobWorker =>
  new JobWorker({
    store: jobStoreFor(scope),
    handlers: [
      modPurgeHandler(purgePortsFor()),
      logMessageDeleteHandler(deletionAttributionPortsFor()),
    ],
    logger,
    now: () => discord.now(),
  });

/**
 * Discord's real snowflake epoch — `fetchRecentMessages`
 * (`packages/testkit/src/fake-discord.ts`) decodes a message id's age with
 * exactly this constant, but does not export it, so it is reproduced here to
 * build ids whose *decoded* age is known and controlled, rather than hoping
 * an arbitrary large id happens to land under the 14-day ceiling.
 */
const DISCORD_EPOCH_MS = 1_420_070_400_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const idAt = (createdAtMs: number): string =>
  ((BigInt(Math.trunc(createdAtMs)) - BigInt(DISCORD_EPOCH_MS)) << 22n).toString();

/** `count` messages, newest first, all `ageMs` (well under 14 days) old. */
const seedFreshMessages = (count: number, ageMs = DAY_MS): string[] => {
  const base = discord.now() - ageMs;
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // Each successive message one ms older, so ids sort newest-first and are
    // pairwise distinct without needing the id's low sequence bits.
    const id = idAt(base - i);
    discord.defineMessage({ channelId: CHANNEL, messageId: id, authorId: MOD });
    ids.push(id);
  }
  return ids;
};

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.forGuild(GUILD);
  guildRepo.upsertGuild(scope, { name: 'test guild', now: 0 });
  // docs/18 Layer 4: an unconfigured guild defaults to dry run, so no
  // Discord side effect happens by accident. This suite is explicitly about
  // real deletions, so it opts in the same way `apps/daemon`'s other
  // integration tests do.
  guildRepo.setDryRun(scope, false, 0);
  discord = new FakeDiscord({ guildId: GUILD });
});

afterEach(() => {
  t.close();
});

const enqueueFirstJob = (intentId: string): void => {
  const payload = JSON.stringify({
    intentId,
    channelId: CHANNEL,
    initiatorUserId: MOD,
    reason: 'spam cleanup',
  });
  const result = jobRepo.enqueue(scope, {
    kind: JOB_KINDS.modPurge,
    payload,
    dedupeKey: purgeDedupeKey(GUILD, intentId),
    now: discord.now(),
  });
  expect(result.enqueued).toBe(true);
};

describe('the purge job resumes across a restart without double-deleting (Step 3)', () => {
  it('a fresh JobWorker instance claims the continuation and finishes the purge, deleting every message exactly once', async () => {
    // 150 messages: one full 100-message tick (fresh phase, a full page),
    // then a second, 50-message tick that finds a short page and completes.
    const ids = seedFreshMessages(150);

    enqueueFirstJob('intent-restart');

    // Tick 1, on worker A: deletes the first 100 (bulk), enqueues its own
    // continuation pre-loaded with the resume cursor. It is the *only* job
    // in the table at this instant, so this claim cannot be anything else.
    const workerA = newWorker();
    const outcome1 = await workerA.runOnce();
    expect(outcome1).toEqual({ status: 'completed', jobId: 1, kind: JOB_KINDS.modPurge });
    expect(discord.restCalls('bulkDeleteMessages')).toHaveLength(1);
    expect(discord.restCalls('bulkDeleteMessages')[0]?.args[2]).toHaveLength(100);

    // "Drop the worker": discard `workerA` entirely — no reference to it
    // survives, exactly like a process exit. Nothing but the database
    // remembers tick 1 happened. `workerB` is a *genuinely new* `JobWorker`
    // over the same on-disk state — the restart this step models.
    //
    // Tick 1 also enqueued 100 `log_message_delete` jobs, due immediately;
    // its own continuation is due `PURGE_TICK_SPACING_MS` later (rate-limit
    // spacing between ticks). Advancing the clock past that spacing, once,
    // lets one `drain()` reach everything now on the queue — including tick
    // 2's own 50 `log_message_delete` jobs, enqueued and immediately due at
    // this same, already-advanced clock reading.
    discord.advance(3_000);
    const workerB = newWorker();
    const ran = await workerB.drain(500);
    expect(ran).toBeGreaterThan(0);
    expect(await workerB.runOnce()).toEqual({ status: 'idle' }); // nothing left at all

    // 150 messages, deleted across exactly two bulk-delete calls (100 then
    // 50), no message id repeated between them.
    const bulkCalls = discord.restCalls('bulkDeleteMessages');
    expect(bulkCalls).toHaveLength(2);
    const deletedIds = bulkCalls.flatMap((c) => c.args[2] as readonly string[]);
    expect(deletedIds).toHaveLength(150);
    expect(new Set(deletedIds).size).toBe(150); // no id appears twice
    expect(new Set(deletedIds)).toEqual(new Set(ids));
    expect(discord.restCalls('deleteMessage')).toHaveLength(0);

    // Exactly one `purged` case event for the whole purge — the 50-message
    // tick completed inline (a short page needs no further continuation),
    // not a separate discovery tick.
    const events = modCaseRepo.listCaseEvents(
      scope,
      modCaseRepo.openOrResolveCase(scope, { memberId: MOD, now: discord.now() }).caseId,
    );
    const purged = events.filter((e) => e.actionTaken === 'purged');
    expect(purged).toHaveLength(1);
    expect(purged[0]?.matchedSnippet).toContain('150');

    // Every deleted message is honestly attributed to the moderator, not a
    // guess — the audit row this job writes directly (ADR 0023 decision 3).
    const auditRows = t.db
      .select()
      .from(schema.auditEvents)
      .all()
      .filter((r) => r.action === 'message_delete');
    expect(auditRows).toHaveLength(150);
    for (const row of auditRows) {
      expect(row.actorId).toBe(MOD);
      expect(row.inferred).toBe(0);
    }

    // And the ordinary deletion-attribution job was enqueued once per
    // message — the self-enqueue this task's ADR calls for.
    const attributionJobs = jobRepo
      .listJobs(scope, { limit: 500 })
      .filter((j) => j.kind === JOB_KINDS.logMessageDelete);
    expect(attributionJobs).toHaveLength(150);
  });

  it('a stranded (crashed mid-tick) job requeues to exactly one live continuation, not two', async () => {
    // 250 messages so a claimed-but-never-completed tick 1 (simulating a
    // real crash, via `requeueStranded` rather than a clean `runOnce`
    // return) still has real work to redo, and the *retried* tick 1 must
    // mint the identical successor key the (lost) first attempt would have.
    seedFreshMessages(250);
    enqueueFirstJob('intent-crash');

    // Claim tick 1 directly (bypassing `runOnce`/`complete`) to model a
    // process that dies mid-handler: the row is left `running` forever until
    // something calls `requeueStranded`.
    const claimed = jobStoreFor(scope).claimNext(discord.now());
    expect(claimed).toBeDefined();

    // The crash: nothing marks this row `done`. A new process starts,
    // recovers stranded work, and reclaims the same row.
    const recovered = jobStoreFor(scope).requeueStranded(discord.now());
    expect(recovered).toBe(1);

    const workerC = newWorker();
    const outcome = await workerC.runOnce();
    expect(outcome.status).toBe('completed');

    // Exactly one continuation exists for this retried tick, not two — the
    // dedupe key it minted is stable across the crash (keyed off this row's
    // own `jobId`, not off anything the (lost) first attempt computed).
    const queued = jobRepo
      .listJobs(scope, { limit: 50 })
      .filter((j) => j.kind === JOB_KINDS.modPurge && j.state === 'queued');
    expect(queued).toHaveLength(1);

    expect(discord.restCalls('bulkDeleteMessages')).toHaveLength(1);
    expect(discord.restCalls('bulkDeleteMessages')[0]?.args[2]).toHaveLength(100);
  });
});
