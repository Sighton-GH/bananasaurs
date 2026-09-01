import type { DiscordPort, FetchedMessage, Snowflake } from '../discord/port.js';
import type { ModerationSafetyState } from '../effects/moderation-gateway.js';
import { checkPurgeBudget, PURGE_MAX_MESSAGES } from '../effects/budget.js';
import { parseSnowflakeId } from '../ids.js';
import type { LogMessageDeletePayload, ModPurgeCursor, ModPurgePayload } from '../jobs/kinds.js';
import { logMessageDeleteDedupeKey, modPurgeCursorSchema, purgeDedupeKey } from '../jobs/kinds.js';
import type { Logger } from '../obs/logger.js';
import { safeLogFields } from '../obs/logger.js';
import { MANUAL_RULE_ID } from './warn.js';

/**
 * The bounded purge job's body (ADR 0037): one tick of `/mod purge`, run
 * through the daemon's job worker (`packages/core/src/jobs/worker.ts`).
 *
 * ## The dedupe-key trap this module does not fall into
 *
 * `JobWorker.runOnce` (`jobs/worker.ts`) claims a job, runs its handler, and
 * — if the handler returns without throwing — *always* marks that same row
 * `done` immediately after. There is no "run me again later" signal a
 * handler can return; a job that is not finished must enqueue a **new** row
 * for its own continuation before returning, and this tick's own row still
 * becomes `done` regardless.
 *
 * While a tick's `run()` is executing, its own job row is still `state =
 * 'running'` — it only flips to `done` after `run()` resolves, back in
 * `runOnce`. `jobs_dedupe` (`packages/storage/src/schema.ts`) is unique only
 * over `state IN ('queued','running')`. So a tick that enqueued its
 * successor under **the same dedupe key its own row currently holds** would
 * find `enqueue()`'s `onConflictDoNothing()` refusing the insert — it would
 * see its own still-`running` row as the conflict — and the purge would stop
 * dead after one tick, with nothing to say why: a completed job is just...
 * complete.
 *
 * This module avoids that by keying every successor off **the tick's own
 * `jobId`** (`purgeDedupeKey(guildId, intentId, context.jobId)`), never off
 * the cursor content the tick computed. A tick was itself enqueued under its
 * *progenitor's* id, never its own, so the successor's key can never equal
 * the current row's key — self-collision is structurally impossible, not
 * merely unlikely. And because `jobId` is a property of the row (stable
 * across a crash: `requeueStranded` returns a stranded `running` row to
 * `queued` without touching its id), a tick that gets stranded and reclaimed
 * computes the *identical* successor key on retry, whatever page of messages
 * it happens to fetch and delete the second time around — so a crash between
 * "successor inserted" and "this row marked done" cannot leave two live
 * successors racing each other through the same channel. See
 * `purgeDedupeKey`'s own docstring (`jobs/kinds.ts`) for the two-shape
 * design (bare key for the confirm tap's first job, `:after:<jobId>` for
 * every successor) this relies on.
 *
 * ## Why message-level double-deletion cannot happen either
 *
 * Independently of the dedupe-key scheme above: `fetchRecentMessages`
 * (`discord/port.ts`) excludes messages already deleted (the real Discord
 * API behaves the same way, and the fake test harness mirrors it — see
 * `packages/testkit/src/fake-discord.ts`). So even a tick that somehow
 * resumed from a stale `before` cursor — one that predates messages this
 * job already deleted — would simply page past them: they are not in the
 * result, so nothing re-submits their ids to `bulkDeleteMessages`/
 * `deleteMessage`. Resuming from an out-of-date cursor wastes no REST calls
 * and, more importantly, cannot delete the same message twice.
 *
 * ## The two bounded imprecisions this leaves
 *
 * **1. An undercounted, but never double-deleted, page.** If a tick's row is
 * claimed and run to completion **twice** (attempt 1 succeeds — deletes a
 * page, enqueues a successor — but the process dies before
 * `store.complete()` persists; the row is stranded, reclaimed, and attempt 2
 * runs the same tick fresh), attempt 2 will fetch a *different* page than
 * attempt 1 did, because attempt 1's page is already gone from Discord by
 * then. Attempt 2's own successor-enqueue call collides with attempt 1's
 * already-inserted row (same `jobId`-derived key) and is silently dropped —
 * so only attempt 1's successor survives, carrying attempt 1's cursor, not
 * attempt 2's. The eventual successor therefore resumes from attempt 1's
 * stopping point, and the messages attempt 2 additionally deleted are real
 * deletions that simply are not re-counted into `deletedCount` — a bounded
 * undercount of at most one page (<=100) that can only occur on this
 * specific crash timing, and never a double-deletion.
 *
 * **2. A narrow window where a real deletion can end up with no audit row
 * and no attribution job.** `bulkDeleteMessages`/`deleteMessage` runs
 * first; `recordDeletion` (audit row + self-enqueued `log_message_delete`,
 * per message) runs afterward, in the same tick. A crash between "the
 * delete call returned" and "every `recordDeletion` in this page's loop has
 * finished" leaves whichever messages hadn't been recorded yet deleted with
 * no audit trail at all — and since nothing here subscribes to
 * `MESSAGE_DELETE_BULK`, nothing else covers that gap either (ADR 0037's
 * whole reason for self-enqueuing in the first place). There is no clean
 * redesign that closes this within one tick: recording the audit row
 * *before* the delete call would claim deletions that may never actually
 * happen if the delete call itself then fails. So this is an honest,
 * accepted gap, not a solved one — bounded to at most one page (<=100)
 * per purge, on this same narrow crash timing.
 */

/** Mirrors `ModCaseRefusalReason` (`packages/storage/src/repos/mod-cases.ts`) — ADR 0014 boundary. */
export type PurgeRefusalReason =
  | 'unauthorized'
  | 'guild-unknown'
  | 'killswitch'
  | 'breaker-open'
  | 'rate-cap'
  | 'discord-owner'
  | 'role-above-bot';

/** The narrow slice of the case repo this job calls. Ports, not `@bananasaurs/storage`. */
export interface PurgeCasePorts {
  openOrResolveCase(input: { memberId: string; now: number; countsAsViolation: boolean }): {
    caseId: string;
    violationCount: number;
  };
  recordCaseEvent(input: {
    eventId: string;
    caseId: string;
    ruleId: string;
    memberId: string;
    at: number;
    matchedCategory: string;
    matchedSnippet: string;
    actionTaken: 'purged' | 'purge_refused' | 'purge_failed';
    /** Required (not optional) so every call site states its choice, matching `warn.ts`'s pattern. */
    refusalReason: PurgeRefusalReason | undefined;
    actorId: string;
  }): void;
}

/**
 * Everything one purge tick needs, as ports (`core` never imports
 * `@bananasaurs/storage` — ADR 0014). Bound to a guild and a Discord client
 * once, in the composition root (`apps/daemon/src/jobs/mod.ts`).
 */
export interface PurgePorts extends PurgeCasePorts {
  readonly guildId: Snowflake;
  readonly discord: Pick<
    DiscordPort,
    'fetchRecentMessages' | 'bulkDeleteMessages' | 'deleteMessage'
  >;
  /** The same read `ModerationActionGateway`'s `state.read()` performs (`guildRepo.readSafetyState`). */
  readSafetyState(): ModerationSafetyState | undefined;
  /**
   * The honest `audit_events` row for one deleted message (ADR 0023 decision
   * 3, ADR 0037): actor is the confirming moderator, `inferred: false`.
   * Mirrors `guild.ts`'s `deletionAttributionPorts.recordAudit` exactly.
   */
  recordDeletionAudit(input: {
    at: number;
    actorId: Snowflake;
    messageId: Snowflake;
    channelId: Snowflake;
    authorId: Snowflake | undefined;
    content: string | undefined;
  }): void;
  /**
   * The normal delayed `log_message_delete` job for one deleted message —
   * the same self-enqueue `guild.ts`'s `loggingPorts.enqueueDeletionAttribution`
   * performs, so `attributeAndLogDeletion` finds the audit row this job just
   * wrote and never falls back to guessing from Discord's audit log.
   */
  enqueueDeletionAttribution(input: { dedupeKey: string; payload: string; runAfter: number }): void;
  /**
   * This tick's own successor, pre-loaded with the cursor to resume from
   * (`packages/storage/src/repos/jobs.ts`'s `enqueue`'s new `cursor` field).
   * See this module's docstring for why the dedupe key must be minted from
   * `context.jobId`, never from the cursor content.
   */
  enqueuePurgeContinuation(input: {
    payload: string;
    cursor: string;
    dedupeKey: string;
    runAfter: number;
  }): void;
  now(): number;
  readonly logger: Logger;
}

/** One tick's input, lifted straight from `JobContext` by the daemon handler. */
export interface PurgeTickInput {
  readonly payload: ModPurgePayload;
  readonly cursor: string | null;
  readonly jobId: number;
}

/**
 * Discord rejects a bulk-delete call carrying even one message this old or
 * older. Exported so the purge preview (Task 7, `confirmations.ts`) can
 * split its "age distribution" on the exact same boundary the job itself
 * acts on, rather than a second hand-copied constant drifting from this one.
 */
export const BULK_DELETE_CEILING_MS = 14 * 24 * 60 * 60 * 1000;

/** A page of `fetchRecentMessages`; also Discord's own bulk-delete cap. */
const PAGE_LIMIT = 100;

/**
 * Spacing between ticks (fresh or old phase alike), so a purge walks a busy
 * channel out under Discord's rate limits instead of hammering them —
 * `ADR 0037`'s "requeues itself with a spaced `runAfter` between ticks".
 */
export const PURGE_TICK_SPACING_MS = 2_500;

const parseCursor = (raw: string | null): ModPurgeCursor => {
  const fresh: ModPurgeCursor = { phase: 'fresh', lastMessageId: undefined, deletedCount: 0 };
  if (raw === null) return fresh;
  try {
    return modPurgeCursorSchema.parse(JSON.parse(raw));
  } catch {
    // Untrusted input, exactly like a job payload (CLAUDE.md rule 3). An
    // unparseable cursor restarts the fresh phase from the top, which is
    // safe: `fetchRecentMessages` excludes already-deleted messages, so
    // re-paging from the beginning skips everything already removed rather
    // than re-deleting it (see this module's docstring).
    return fresh;
  }
};

type InternalRefusal = 'guild-unknown' | 'killswitch' | 'breaker-open' | 'dry-run';

/** `dry-run` has no `PurgeRefusalReason` counterpart — see `recordRefusal` below. */
const CASE_REFUSAL_REASON: Record<InternalRefusal, PurgeRefusalReason | undefined> = {
  'guild-unknown': 'guild-unknown',
  killswitch: 'killswitch',
  'breaker-open': 'breaker-open',
  'dry-run': undefined,
};

const classifyRefusal = (state: ModerationSafetyState | undefined): InternalRefusal | undefined => {
  if (state === undefined) return 'guild-unknown';
  if (state.killswitch) return 'killswitch';
  if (state.breakerOpen) return 'breaker-open';
  if (state.dryRun) return 'dry-run';
  return undefined;
};

/**
 * Opens or resolves the *initiating moderator's* own case and appends one
 * purge event to it. There is no violator to attach a channel cleanup to —
 * `never countsAsViolation`, since running a purge is not, itself, a
 * violation by the moderator who ran it.
 *
 * `eventId` is deterministic — `<intentId>:<jobId>:<actionTaken>` — rather
 * than a fresh `crypto.randomUUID()` per call (CLAUDE.md rule 6: this runs
 * inside a retryable job body). If this tick's row is claimed and run to
 * completion twice (attempt 1 writes this event and enqueues a successor,
 * but the process dies before `store.complete()` persists; the row is
 * stranded and reclaimed; attempt 2 reaches the identical outcome), attempt
 * 2 computes the *same* `eventId` — `jobId` is stable across the crash, and
 * `intentId`/`actionTaken` do not depend on anything either attempt fetched
 * from Discord. `mod_case_events`' primary key is `(guild_id, event_id)`
 * with a targeted `ON CONFLICT ... DO NOTHING` on exactly that pair
 * (`packages/storage/src/repos/mod-cases.ts`), so the second write
 * collapses into a no-op rather than a duplicate row or a thrown
 * constraint error — the same "insert once, key on identity" idiom
 * `jobs_dedupe` already uses for the job row itself.
 */
const recordPurgeCaseEvent = (
  ports: PurgePorts,
  payload: ModPurgePayload,
  jobId: number,
  input: {
    actionTaken: 'purged' | 'purge_refused' | 'purge_failed';
    refusalReason: PurgeRefusalReason | undefined;
    snippet: string;
    at: number;
  },
): void => {
  const { caseId } = ports.openOrResolveCase({
    memberId: payload.initiatorUserId,
    now: input.at,
    countsAsViolation: false,
  });
  ports.recordCaseEvent({
    eventId: `${payload.intentId}:${jobId}:${input.actionTaken}`,
    caseId,
    ruleId: MANUAL_RULE_ID,
    memberId: payload.initiatorUserId,
    at: input.at,
    matchedCategory: 'purge',
    matchedSnippet: input.snippet,
    actionTaken: input.actionTaken,
    refusalReason: input.refusalReason,
    actorId: payload.initiatorUserId,
  });
};

/**
 * `deletedCount` is the cursor's running total *before* this tick — a
 * refusal can fire well into a multi-tick purge (a killswitch flip at tick
 * 3, the budget tripping at tick 5), and `purge_refused` on its own reads as
 * "nothing happened" even though up to `PURGE_MAX_MESSAGES` messages may
 * already be gone. Folded into the snippet so a moderator reading case
 * history sees the truth, not just the refusal.
 */
const recordRefusal = (
  ports: PurgePorts,
  payload: ModPurgePayload,
  reason: InternalRefusal,
  deletedCount: number,
  jobId: number,
  at: number,
): void => {
  const snippet =
    deletedCount > 0
      ? `purge of <#${payload.channelId}> refused after deleting ${deletedCount} message(s): ${reason}`
      : `purge of <#${payload.channelId}> refused: ${reason}`;
  recordPurgeCaseEvent(ports, payload, jobId, {
    actionTaken: 'purge_refused',
    refusalReason: CASE_REFUSAL_REASON[reason],
    snippet,
    at,
  });
  ports.logger.warn(
    safeLogFields({
      component: 'mod-purge',
      guildId: ports.guildId,
      channelId: payload.channelId,
      intentId: payload.intentId,
      outcome: 'refused',
      reason,
      deletedCount,
    }),
    'purge refused',
  );
};

const recordBudgetRefusal = (
  ports: PurgePorts,
  payload: ModPurgePayload,
  deletedCount: number,
  prospectiveCount: number,
  jobId: number,
  at: number,
): void => {
  recordPurgeCaseEvent(ports, payload, jobId, {
    actionTaken: 'purge_refused',
    // 'over-budget' has no PurgeRefusalReason counterpart either — the
    // vocabulary check in `recordCaseEvent`'s callers only "supports one, if
    // the vocabulary supports one" (task brief); the snippet carries it.
    refusalReason: undefined,
    snippet: `purge of <#${payload.channelId}> refused: continuing would reach ${prospectiveCount} total messages (${deletedCount} already deleted), over the ${PURGE_MAX_MESSAGES}-message budget`,
    at,
  });
  ports.logger.warn(
    safeLogFields({
      component: 'mod-purge',
      guildId: ports.guildId,
      channelId: payload.channelId,
      intentId: payload.intentId,
      outcome: 'refused',
      reason: 'over-budget',
      deletedCount,
      prospectiveCount,
      budget: PURGE_MAX_MESSAGES,
    }),
    'purge refused: over budget',
  );
};

const completePurge = (
  ports: PurgePorts,
  payload: ModPurgePayload,
  jobId: number,
  totalDeleted: number,
  at: number,
): void => {
  recordPurgeCaseEvent(ports, payload, jobId, {
    actionTaken: 'purged',
    refusalReason: undefined,
    snippet: `purged ${totalDeleted} message(s) from <#${payload.channelId}>`,
    at,
  });
  ports.logger.info(
    safeLogFields({
      component: 'mod-purge',
      guildId: ports.guildId,
      channelId: payload.channelId,
      intentId: payload.intentId,
      outcome: 'purged',
      count: totalDeleted,
    }),
    'purge complete',
  );
};

/** Writes the honest audit row and enqueues the ordinary attribution job for one deletion. */
const recordDeletion = (
  ports: PurgePorts,
  payload: ModPurgePayload,
  message: FetchedMessage,
  at: number,
): void => {
  ports.recordDeletionAudit({
    at,
    actorId: payload.initiatorUserId,
    messageId: message.messageId,
    channelId: payload.channelId,
    authorId: message.authorId,
    content: message.content,
  });
  const attributionPayload: LogMessageDeletePayload = {
    channelId: payload.channelId,
    messageId: parseSnowflakeId(message.messageId),
    ...(message.authorId !== undefined && { authorId: parseSnowflakeId(message.authorId) }),
    content: message.content,
    deletedAtMs: at,
  };
  ports.enqueueDeletionAttribution({
    dedupeKey: logMessageDeleteDedupeKey(payload.channelId, message.messageId),
    payload: JSON.stringify(attributionPayload),
    // Immediate: unlike the ordinary `MESSAGE_DELETE` path, this job already
    // knows the true actor (the audit row above), so
    // `attributeAndLogDeletion`'s `findExistingAttribution` short-circuits
    // before ever consulting Discord's audit log — there is nothing to wait
    // for it to catch up on.
    runAfter: at,
  });
};

const enqueueSuccessor = (
  ports: PurgePorts,
  payload: ModPurgePayload,
  jobId: number,
  nextCursor: ModPurgeCursor,
  at: number,
): void => {
  ports.enqueuePurgeContinuation({
    payload: JSON.stringify(payload),
    cursor: JSON.stringify(nextCursor),
    dedupeKey: purgeDedupeKey(ports.guildId, payload.intentId, jobId),
    runAfter: at + PURGE_TICK_SPACING_MS,
  });
};

const runFreshTick = async (
  ports: PurgePorts,
  payload: ModPurgePayload,
  cursor: ModPurgeCursor,
  jobId: number,
  now: number,
): Promise<void> => {
  const page = await ports.discord.fetchRecentMessages(ports.guildId, payload.channelId, {
    before: cursor.lastMessageId,
    limit: PAGE_LIMIT,
  });

  if (page.messages.length === 0) {
    completePurge(ports, payload, jobId, cursor.deletedCount, now);
    return;
  }

  // Newest first: once one message crosses the 14-day ceiling, everything
  // after it in this page is at least as old, so the scan can stop there —
  // the remainder belongs to the 'old' phase, one message at a time.
  const cutoff = now - BULK_DELETE_CEILING_MS;
  const freshBatch: FetchedMessage[] = [];
  let boundaryReached = false;
  for (const m of page.messages) {
    if (m.createdAtMs > cutoff) {
      freshBatch.push(m);
    } else {
      boundaryReached = true;
      break;
    }
  }

  const freshIds = freshBatch.map((m) => m.messageId);
  const prospectiveTotal = cursor.deletedCount + freshIds.length;
  const budget = checkPurgeBudget(prospectiveTotal, PURGE_MAX_MESSAGES);
  if (!budget.ok) {
    recordBudgetRefusal(ports, payload, cursor.deletedCount, prospectiveTotal, jobId, now);
    return;
  }

  // Discord's bulk-delete endpoint accepts 2..100 ids; exactly one fresh
  // message in the page needs the single-delete call instead.
  if (freshIds.length === 1) {
    await ports.discord.deleteMessage(
      ports.guildId,
      { channelId: payload.channelId, messageId: freshIds[0]! },
      payload.reason,
    );
  } else if (freshIds.length >= 2) {
    await ports.discord.bulkDeleteMessages(
      ports.guildId,
      payload.channelId,
      freshIds,
      payload.reason,
    );
  }

  for (const m of freshBatch) recordDeletion(ports, payload, m, now);

  const deletedCount = cursor.deletedCount + freshIds.length;

  if (boundaryReached) {
    const nextCursor: ModPurgeCursor = {
      phase: 'old',
      lastMessageId: freshIds.length > 0 ? freshIds[freshIds.length - 1] : cursor.lastMessageId,
      deletedCount,
    };
    enqueueSuccessor(ports, payload, jobId, nextCursor, now);
    return;
  }

  if (page.nextBefore === undefined) {
    completePurge(ports, payload, jobId, deletedCount, now);
    return;
  }

  enqueueSuccessor(
    ports,
    payload,
    jobId,
    { phase: 'fresh', lastMessageId: page.nextBefore, deletedCount },
    now,
  );
};

const runOldTick = async (
  ports: PurgePorts,
  payload: ModPurgePayload,
  cursor: ModPurgeCursor,
  jobId: number,
  now: number,
): Promise<void> => {
  const page = await ports.discord.fetchRecentMessages(ports.guildId, payload.channelId, {
    before: cursor.lastMessageId,
    limit: 1,
  });

  if (page.messages.length === 0) {
    completePurge(ports, payload, jobId, cursor.deletedCount, now);
    return;
  }

  const message = page.messages[0]!;
  const prospectiveTotal = cursor.deletedCount + 1;
  const budget = checkPurgeBudget(prospectiveTotal, PURGE_MAX_MESSAGES);
  if (!budget.ok) {
    recordBudgetRefusal(ports, payload, cursor.deletedCount, prospectiveTotal, jobId, now);
    return;
  }

  await ports.discord.deleteMessage(
    ports.guildId,
    { channelId: payload.channelId, messageId: message.messageId },
    payload.reason,
  );
  recordDeletion(ports, payload, message, now);

  // Always requeue rather than looking ahead: the *next* tick's fetch is
  // what discovers the channel is finally exhausted (an empty page above),
  // which is also what keeps this phase to exactly one delete per tick.
  enqueueSuccessor(
    ports,
    payload,
    jobId,
    { phase: 'old', lastMessageId: message.messageId, deletedCount: prospectiveTotal },
    now,
  );
};

/**
 * Runs one tick of a bounded purge: reads the cursor, checks the safety
 * gate, checks the budget, deletes what this tick is allowed to, and either
 * enqueues its own successor or completes the purge outright.
 *
 * Discord errors are not caught here — CLAUDE.md rule 6 and ADR 0037 leave
 * that to the job worker's own retry/backoff (`jobs/worker.ts`): a thrown
 * error fails this attempt without marking anything `purged`, and the next
 * claim resumes from whatever cursor the *last successful* tick saved.
 */
export const runPurgeTick = async (ports: PurgePorts, input: PurgeTickInput): Promise<void> => {
  const cursor = parseCursor(input.cursor);
  const now = ports.now();

  const refusal = classifyRefusal(ports.readSafetyState());
  if (refusal !== undefined) {
    recordRefusal(ports, input.payload, refusal, cursor.deletedCount, input.jobId, now);
    return;
  }

  if (cursor.phase === 'fresh') {
    await runFreshTick(ports, input.payload, cursor, input.jobId, now);
  } else {
    await runOldTick(ports, input.payload, cursor, input.jobId, now);
  }
};
