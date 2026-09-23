import { z } from 'zod';
import { snowflakeIdSchema } from '../ids.js';

/**
 * Job kinds and their payload schemas.
 *
 * The kind strings and the schemas live in `core` so a producer and a consumer
 * cannot disagree about either. The handlers themselves live where their
 * dependencies do — the composition root — because a handler that sweeps a
 * table needs the database, and `core` may not have it.
 */

export const JOB_KINDS = {
  /** Bounds `event_dedupe`, which otherwise grows one row per event forever. */
  sweepEventDedupe: 'sweep_event_dedupe',
  /** Repairs drift after a gateway gap, or on the periodic timer. */
  reconcileGuild: 'reconcile_guild',
  /** Turns a panel's existing reactions into roles, once an owner sized it. */
  adoptPanel: 'adopt_panel',
  /** Consults the audit log for who deleted a message (ADR 0019, ADR 0023). */
  logMessageDelete: 'log_message_delete',
  /** Reverses one effect batch, for `bananasaurs undo` (ADR 0026). */
  undoBatch: 'undo_batch',
  /** One tick of a bounded `/mod purge` (ADR 0037). */
  modPurge: 'mod_purge',
  /** One resumable 100-message backfill page per run (ADR 0046 D4). */
  archiveBackfill: 'archive_backfill',
  /** The daily three-tier archive content expiry (ADR 0046 D3, PR-70). */
  archiveExpiry: 'archive_expiry',
  /** One due-reminder delivery pass (Release 3, docs/RELEASE3_ASSISTANT_SCOPE.md). */
  deliverReminders: 'deliver_reminders',
  /**
   * One assistant invocation (Release 3, B2): resource fetches and the
   * provider call are far too slow for the serial per-guild dispatch chain —
   * run them here so /ask cannot stall reaction roles, automod or /mod.
   */
  assistantInvoke: 'assistant_invoke',
} as const;

export type JobKind = (typeof JOB_KINDS)[keyof typeof JOB_KINDS];

export const sweepEventDedupePayload = z.object({
  /** Rows first seen strictly before this are dropped. */
  olderThanMs: z.number().int().nonnegative(),
});
export type SweepEventDedupePayload = z.infer<typeof sweepEventDedupePayload>;

export const reconcileGuildPayload = z.object({
  /** The gap that caused this, when there was one. Absent for the timer pass. */
  gapId: z.number().int().positive().optional(),
  reason: z.enum(['gateway-gap', 'timer', 'operator']),
  /**
   * One panel, for `bananasaurs panel sync <id>`. Absent means every panel.
   *
   * Without it the command would name one panel and reconcile the whole guild,
   * which is the kind of quiet over-reach an operator discovers only from the
   * audit trail afterwards (ADR 0026).
   */
  panelId: z.string().min(1).max(64).optional(),
});
export type ReconcileGuildPayload = z.infer<typeof reconcileGuildPayload>;

/**
 * A dedupe key that collapses repeated requests for the same work.
 *
 * A flapping connection produces a reconnect every few seconds. Without
 * collapsing, each one queues its own reconciliation and the worker spends the
 * whole outage repeating a pass whose inputs have not changed.
 */
export const reconcileDedupeKey = (
  reason: ReconcileGuildPayload['reason'],
  panelId?: string,
): string =>
  panelId === undefined
    ? `${JOB_KINDS.reconcileGuild}:${reason}`
    : // Per panel, so syncing panel A does not collapse into a pending sync of
      // panel B. A guild-wide pass and a panel pass are different work and must
      // not share a key.
      `${JOB_KINDS.reconcileGuild}:${reason}:${panelId}`;

/** One sweep pending at a time is enough; the next run picks up what it missed. */
export const sweepDedupeKey = (): string => JOB_KINDS.sweepEventDedupe;

export const adoptPanelPayload = z.object({
  panelId: z.string().min(1).max(64),
});
export type AdoptPanelPayload = z.infer<typeof adoptPanelPayload>;

/**
 * One pending adoption per panel.
 *
 * Per panel rather than global: adopting two panels are independent pieces of
 * work and collapsing them would silently drop one. Re-enqueueable once the
 * first has finished — see ADR 0016, which is what makes "grant the allowance,
 * then run the pass again" possible at all.
 */
export const adoptDedupeKey = (panelId: string): string => `${JOB_KINDS.adoptPanel}:${panelId}`;

/**
 * `undefined` on `authorId` and `content` are decisions, not omissions:
 * `authorId` is genuinely absent when the message was uncached (ADR 0019
 * fact 4), and `content` is `undefined` both when uncached and when the
 * route's `include_content` was off at enqueue time — decided once, there,
 * rather than persisting content the owner turned off into the job table
 * for the run_after delay's duration.
 */
export const logMessageDeletePayload = z.object({
  channelId: snowflakeIdSchema,
  messageId: snowflakeIdSchema,
  authorId: snowflakeIdSchema.optional(),
  content: z.string().optional(),
  deletedAtMs: z.number().int().nonnegative(),
});
export type LogMessageDeletePayload = z.infer<typeof logMessageDeletePayload>;

/** One job per deletion — a message is deleted at most once. */
export const logMessageDeleteDedupeKey = (channelId: string, messageId: string): string =>
  `${JOB_KINDS.logMessageDelete}:${channelId}:${messageId}`;

export const undoBatchPayload = z.object({
  batchId: z.string().min(1).max(64),
  /** Recorded on every reversing effect, so the trail says why it happened. */
  reason: z.string().min(1).max(200),
});
export type UndoBatchPayload = z.infer<typeof undoBatchPayload>;

/**
 * One pending undo per batch.
 *
 * Per batch rather than global: undoing two batches are independent pieces of
 * work and neither should wait for the other. Collapsing a repeat is the
 * point — an operator who runs `undo` twice on a batch still in the queue must
 * not queue the reversal twice, and the partial unique index over `queued` and
 * `running` (ADR 0016) is what enforces it.
 */
export const undoDedupeKey = (batchId: string): string => `${JOB_KINDS.undoBatch}:${batchId}`;

/**
 * The bounded purge job (ADR 0037, `packages/core/src/mod/purge.ts`).
 *
 * `intentId` ties the job back to the `mod_pending_actions` row the confirm
 * tap created it from (Task 7) and, transitively, to the moderator who
 * confirmed. There is no target member: a purge acts on a channel, not a
 * person, which is also why its case events (`purged`/`purge_refused`/
 * `purge_failed`) resolve against the *initiator's* own case rather than a
 * violator's — nobody else's case fits a channel cleanup.
 */
export const modPurgePayload = z.object({
  intentId: z.string().min(1).max(64),
  channelId: snowflakeIdSchema,
  initiatorUserId: snowflakeIdSchema,
  reason: z.string().min(1).max(500),
});
export type ModPurgePayload = z.infer<typeof modPurgePayload>;

/**
 * Where a purge got to, so a restart resumes rather than restarting the
 * channel from the top (`jobs.cursor`, JSON, Zod-validated on read like every
 * job payload — CLAUDE.md rule 3 applies to our own prior writes too).
 *
 * `phase: 'fresh'` pages `fetchRecentMessages` and bulk-deletes messages
 * under Discord's 14-day bulk-delete ceiling; `phase: 'old'` deletes the
 * messages at or past that ceiling one at a time, since Discord refuses a
 * bulk call carrying even one message that old. `lastMessageId` is
 * `fetchRecentMessages`'s own `before` cursor — the id of the oldest message
 * this job has resolved (deleted or confirmed too old to touch yet) —
 * `undefined` only for a purge that has not resolved anything yet.
 * `deletedCount` is the running total `checkPurgeBudget` checks every tick;
 * it is *not* recomputed from Discord, because a deleted message leaves no
 * trace to recount from.
 */
export const modPurgeCursorSchema = z.object({
  phase: z.enum(['fresh', 'old']),
  // Plain `Snowflake` (`discord/port.ts`'s unbranded string alias), not the
  // branded `SnowflakeId`: this id round-trips straight back into
  // `DiscordPort.fetchRecentMessages`'s `before` option, which takes a bare
  // `Snowflake`, and the branded schema would force an unnecessary
  // re-parse at every construction site for a value that already came from
  // Discord's own response.
  lastMessageId: z.string().min(1).optional(),
  deletedCount: z.number().int().nonnegative(),
});
export type ModPurgeCursor = z.infer<typeof modPurgeCursorSchema>;

/**
 * The purge job's dedupe key.
 *
 * Two distinct callers, two distinct shapes, by design (see
 * `packages/core/src/mod/purge.ts`'s module docstring for the full trap this
 * avoids):
 *
 * - The confirm tap (Task 7) mints the *first* job with no `afterJobId`,
 *   producing the bare `mod:<guildId>:purge:<intentId>` key the spec names —
 *   one purge, one confirm, one job at that key, ever (the jobs table's
 *   partial unique index makes a double-tap enqueue nothing).
 * - Every tick after that mints its *own successor's* key from its **own**
 *   `jobId` (`context.jobId` — stable across a crash-and-retry of the same
 *   row, since `requeueStranded` never changes it, and completely
 *   independent of anything the tick fetched from Discord). Keying off the
 *   tick's own id rather than off the cursor content it computed means: (a)
 *   the successor's key can never equal the tick's own key — a tick was
 *   enqueued under *its progenitor's* id, never its own, so self-collision
 *   against the still-`running` current row (the trap `jobs_dedupe`'s
 *   partial uniqueness creates: see `schema.ts`'s `jobs_dedupe` comment) is
 *   structurally impossible; and (b) a stranded tick that gets reclaimed and
 *   re-run computes the *identical* successor key both times (same `jobId`
 *   both times), so a crash between "successor inserted" and "this row
 *   marked done" cannot leave two live successors — the second `enqueue`
 *   collides with the first and is silently dropped, exactly like a
 *   double-tapped confirm collides with itself.
 */
export const purgeDedupeKey = (guildId: string, intentId: string, afterJobId?: number): string =>
  afterJobId === undefined
    ? `mod:${guildId}:purge:${intentId}`
    : `mod:${guildId}:purge:${intentId}:after:${afterJobId}`;

export const archiveBackfillPayload = z.object({
  channelId: snowflakeIdSchema,
  /**
   * Resumable thread-walk position (review M2): once the channel's own
   * pages are exhausted, its threads are walked one page per tick and the
   * continuation carries the walk's state — the thread list, the index of
   * the thread being paged, and the page cursor inside it. Absent on the
   * channel-paging ticks.
   */
  threadWalk: z
    .object({
      threadIds: z.array(snowflakeIdSchema),
      index: z.number().int().nonnegative(),
      before: snowflakeIdSchema.optional(),
    })
    .optional(),
});
export type ArchiveBackfillPayload = z.infer<typeof archiveBackfillPayload>;

/**
 * The backfill job's dedupe key.
 *
 * Two distinct callers, two distinct shapes, by design — the same trap
 * `purgeDedupeKey`'s docstring documents, copied here because the backfill
 * fell into it: `jobs_dedupe` is unique only over `state IN
 * ('queued','running')` and `enqueue` uses `onConflictDoNothing`, so a tick
 * that enqueued its successor under the same key its own still-`running`
 * row holds would see the insert silently refused (its own row is the
 * conflict) and the channel would backfill exactly one page, forever
 * `running`. Keying every successor off the tick's own `jobId`
 * (`context.jobId` — stable across a crash-and-retry, since
 * `requeueStranded` never changes it) makes self-collision structurally
 * impossible: a tick was enqueued under its progenitor's id, never its own.
 *
 * - `archive enable-channel` mints the *first* job with no `afterJobId`,
 *   producing the bare `archive_backfill:<guildId>:<channelId>` key — one
 *   pending backfill per channel (ADR 0046 D4, ADR 0016).
 * - Every tick after that mints its successor's key from its **own** `jobId`,
 *   producing `archive_backfill:<guildId>:<channelId>:after:<jobId>`.
 *
 * The guild is redundant under the `(guild_id, dedupe_key)` partial unique
 * index but matches `purgeDedupeKey`'s shape: a key that names everything it
 * scopes reads correctly in `jobs list` without a join.
 */
export const archiveBackfillDedupeKey = (
  guildId: string,
  channelId: string,
  afterJobId?: number,
): string =>
  afterJobId === undefined
    ? `${JOB_KINDS.archiveBackfill}:${guildId}:${channelId}`
    : `${JOB_KINDS.archiveBackfill}:${guildId}:${channelId}:after:${afterJobId}`;

export const archiveExpiryPayload = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type ArchiveExpiryPayload = z.infer<typeof archiveExpiryPayload>;

/**
 * One pending expiry per UTC day, across the process (PR-70).
 *
 * Deliberately guild-free: the timer enqueues one job per guild per day under
 * the same key, and the `(guild_id, dedupe_key)` index collapses per guild —
 * a second `runOnce` on the same day enqueues nothing anywhere.
 */
export const archiveExpiryDedupeKey = (day: string): string => `${JOB_KINDS.archiveExpiry}:${day}`;

export const deliverRemindersPayload = z.object({
  /** At most this many reminders are claimed in one pass. Defaults apply when absent. */
  limit: z.number().int().positive().max(100).optional(),
});
export type DeliverRemindersPayload = z.infer<typeof deliverRemindersPayload>;

/**
 * One pending delivery pass per guild is enough.
 *
 * A pass claims every due reminder the store hands it, so a second queued pass
 * behind the first would only find an empty claim set — the timer re-enqueues
 * on every tick and the `(guild_id, dedupe_key)` partial unique index
 * collapses the duplicates (ADR 0016). The next tick picks up anything a pass
 * returned to `scheduled` for retry.
 */
export const deliverRemindersDedupeKey = (): string => JOB_KINDS.deliverReminders;

/**
 * One assistant invocation, enqueued by the slash/mention subscriber the
 * moment cheap local routing is done (B2). The behaviour is re-resolved from
 * storage at run time rather than serialised into the payload: a prompt edit
 * or disable between enqueue and run must take effect, and a deleted
 * behaviour fails closed with a plain answer instead of acting on a stale
 * copy.
 */
export const assistantInvokePayload = z.object({
  // Plain strings, not branded snowflakes: the producer (the gateway event)
  // carries unbranded ids, and the schema re-validates at read time anyway.
  channelId: z.string().min(1).optional(),
  userId: z.string().min(1),
  callerRoleIds: z.array(z.string().min(1)),
  behaviourId: z.string().min(1).max(64),
  command: z.enum([
    'ask',
    'find',
    'remind',
    'remember',
    'decision',
    'review-plan',
    'onboard',
    'agenda',
    'summarise',
    'announce',
    'checklist',
    'handoff',
  ]),
  input: z.record(z.string()),
  source: z.enum(['slash-command', 'mention']),
  /**
   * Slash invocations answer through the deferred interaction; mention
   * invocations answer in the channel. Absent means mention. The token is
   * ALWAYS sealed (apps/daemon/src/assistant/interaction-token.ts): this
   * payload is durable and listed on the dashboard Jobs page, and a raw
   * interaction token is a bearer credential.
   */
  interaction: z
    .object({ interactionId: z.string().min(1), sealedToken: z.string().min(1) })
    .optional(),
  /**
   * The Discord interaction or message id that produced this invocation,
   * forwarded to the service as the dedupe anchor (IT-ticket keys are
   * anchored on it — 50820ad).
   */
  invocationId: z.string().min(1),
});
export type AssistantInvokePayload = z.infer<typeof assistantInvokePayload>;

/**
 * The invoke job's progress cursor. It is our own prior write, but hard
 * rule 3 still applies: a row that does not validate is treated as no
 * progress rather than trusted into the answer path on every retry.
 */
/** ADR 0065: what the AI log channel reports; carried so a resumed job can still log it. */
const invocationTrace = z.object({
  latencyMs: z.number().nonnegative(),
  model: z.string().optional(),
  tools: z.array(z.object({ name: z.string(), ok: z.boolean() })).optional(),
  sources: z.array(z.object({ title: z.string(), url: z.string() })).optional(),
  web: z.boolean().optional(),
  usedFallback: z.boolean().optional(),
});

export const assistantInvokeCursor = z.object({
  stage: z.enum(['invoke-done', 'answered', 'escalation-sent', 'logged']),
  result: z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      content: z.string(),
      escalation: z
        .object({
          channelId: z.string().min(1),
          reviewerRoleIds: z.array(z.string()),
          ticketId: z.string().min(1),
        })
        .optional(),
      trace: invocationTrace.optional(),
    }),
    z.object({ ok: z.literal(false), content: z.string(), trace: invocationTrace.optional() }),
  ]),
});
export type AssistantInvokeCursor = z.infer<typeof assistantInvokeCursor>;

/**
 * One job per Discord interaction or message: the invocation id is the
 * idempotency anchor the rest of Release 3 already dedupes on, so a gateway
 * replay of the same interaction cannot queue a second provider call.
 */
export const assistantInvokeDedupeKey = (invocationId: string): string =>
  `${JOB_KINDS.assistantInvoke}:${invocationId}`;
