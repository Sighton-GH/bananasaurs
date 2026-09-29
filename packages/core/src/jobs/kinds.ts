import { z } from 'zod';
import { snowflakeIdSchema } from '../ids.js';
import { CONTINUE_RULES, NEW_RULES } from '../assistant/conversation.js';
import { assistantTraceSchema } from '../assistant/trace.js';

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
  /** The daily conversation auto-delete past the guild's retention (Task 19). */
  conversationPrune: 'conversation_prune',
  /**
   * One conversation summary over evicted turns (ADR 0091). Enqueued after an
   * answer when stored turns fell out of the history window; the payload
   * names the answering entry so the job re-resolves the same model.
   */
  assistantSummarise: 'assistant_summarise',
  /**
   * One assistant invocation (Release 3, B2): resource fetches and the
   * provider call are far too slow for the serial per-guild dispatch chain —
   * run them here so /ask cannot stall reaction roles, automod or /mod.
   */
  assistantInvoke: 'assistant_invoke',
  /**
   * One resource-cache refresh pass (ADR 0073): fetches (or, for a note,
   * re-reads) a resource, re-chunks it only when its content changed, and
   * writes the persistent cache the assistant reads from — the request path
   * never fetches live.
   */
  resourceRefresh: 'resource_refresh',
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

export const conversationPrunePayload = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type ConversationPrunePayload = z.infer<typeof conversationPrunePayload>;

/**
 * One pending prune per UTC day, across the process.
 *
 * Deliberately guild-free like `archiveExpiryDedupeKey`: the timer enqueues
 * one job per guild per day under the same key, and the `(guild_id,
 * dedupe_key)` index collapses per guild — a second `runOnce` on the same
 * day enqueues nothing anywhere.
 */
export const conversationPruneDedupeKey = (day: string): string =>
  `${JOB_KINDS.conversationPrune}:${day}`;

/**
 * One conversation summary over evicted turns (ADR 0091 decision 3).
 *
 * `throughAt` is the `at` of the newest evicted turn the run must cover;
 * `providerId`, `model` and `keyId` name the chain entry that answered, so
 * the job re-resolves the same model (ADR 0091 decision 4).
 */
export const assistantSummarisePayload = z.object({
  conversationId: z.string().min(1),
  throughAt: z.number().int(),
  providerId: z.string().min(1),
  model: z.string().min(1),
  keyId: z.string().min(1),
});
export type AssistantSummarisePayload = z.infer<typeof assistantSummarisePayload>;

/**
 * Idempotency: one pending summary per conversation and coverage point
 * (hard rule 6). A retry of the same answer re-enqueues the identical key
 * and collapses into the row already queued.
 */
export const assistantSummariseDedupeKey = (conversationId: string, throughAt: number): string =>
  `summary_${conversationId}_${throughAt}`;

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
  /**
   * Task 14: the member's Discord message id, when the source is a message.
   * The first answer part is posted as a Discord Reply to it, and it is
   * linked to the conversation as the member's turn. Absent for slash
   * invocations, which have no message yet (the respond call's returned id
   * is linked instead).
   */
  messageId: z.string().min(1).optional(),
  /**
   * Task 14: the message this one replies to (`message_reference`), for the
   * conversation resolver — which conversation a reply continues — and, for
   * an unknown message, the quote fetched as untrusted context. Absent when
   * this invocation is not a reply.
   */
  referencedMessageId: z.string().min(1).optional(),
  /**
   * Task 14: the author of the replied-to message, from
   * `referenced_message.author` — never guessed. Tells a reply to our own
   * message apart from a quoted reply to someone else's.
   */
  referencedAuthorId: z.string().min(1).optional(),
  /** The parent channel when the mention was posted in a thread. */
  threadParentId: z.string().min(1).optional(),
  /**
   * Task 14: the member's display name for history labels, when the producer
   * knew one. The mention path carries the member's display name; other paths
   * may omit it — always best-effort, never fetched.
   */
  authorName: z.string().min(1).max(200).optional(),
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

/**
 * Task 14: the full run detail the invoke job persists as an `AssistantTrace`.
 * Carried in the cursor so a retry that resumes after `invoke-done` still
 * writes the trace with the original sections, attempts, tool calls, usage
 * and guard. The trace-read fields reuse `assistantTraceSchema`'s own shapes
 * so the cursor can never drift from what the trace table accepts; the
 * conversation history is validated the same way (the tool-call `args` and
 * `providerParts` stay opaque JSON, as in the trace schema — the trace write
 * never reads into them).
 */
const assistantInvokeDetail = z.object({
  sections: assistantTraceSchema.shape.sections,
  history: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'tool']),
      text: z.string(),
      toolCalls: z
        .array(z.object({ id: z.string().optional(), name: z.string(), args: z.unknown() }))
        .optional(),
      toolName: z.string().optional(),
      toolCallId: z.string().optional(),
      providerParts: z.unknown().optional(),
    }),
  ),
  attempts: assistantTraceSchema.shape.attempts,
  toolCalls: assistantTraceSchema.shape.toolCalls,
  usage: assistantTraceSchema.shape.usage,
  guard: assistantTraceSchema.shape.guard,
  model: z.string().optional(),
  finishReason: assistantTraceSchema.shape.finishReason,
  web: z.boolean().optional(),
  included: assistantTraceSchema.shape.included,
  /**
   * ADR 0091: the chain entry whose response was accepted. Carried so the
   * summary job can re-resolve it; never written to the stored trace, since
   * the key id is not for display.
   */
  answeredBy: z
    .object({
      providerId: z.string().min(1),
      model: z.string().min(1),
      keyId: z.string().min(1),
    })
    .optional(),
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
      /**
       * Task 20: trace flags the service attached to the result (currently
       * only `resources-unavailable`). Carried so a retry that skips the
       * invoke still writes them into the trace.
       */
      flags: z.array(z.string().min(1)).optional(),
      trace: invocationTrace.optional(),
      detail: assistantInvokeDetail.optional(),
    }),
    z.object({
      ok: z.literal(false),
      content: z.string(),
      flags: z.array(z.string().min(1)).optional(),
      trace: invocationTrace.optional(),
      detail: assistantInvokeDetail.optional(),
    }),
  ]),
  /**
   * Task 14: the conversation this invocation joined, created or continued in
   * the invoke step and carried so a retry resumes it instead of re-resolving
   * (and re-creating) it. Absent on pre-Task-14 rows and on invocations with
   * no channel, which skip conversation work entirely.
   */
  conversationId: z.string().min(1).optional(),
  /**
   * Task 14: how the conversation was resolved
   * (`packages/core/src/assistant/conversation.ts`). The schema lives here,
   * next to the cursor, because the cursor is validated at the jobs boundary
   * like every payload — `core`'s resolver type itself stays Zod-free.
   */
  resolution: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('continue'),
        conversationId: z.string().min(1),
        rule: z.enum(CONTINUE_RULES),
      }),
      z.object({
        kind: z.literal('new'),
        rule: z.enum(NEW_RULES),
        quotedMessageId: z.string().min(1).optional(),
      }),
    ])
    .optional(),
  /**
   * Task 14: durable posting progress — parts `[0, partsPosted)` already
   * landed, so a retry posts from `partsPosted` and never re-posts a part
   * (hard rule 6). Defaults keep pre-Task-14 rows valid: an old
   * `invoke-done` row re-posts from part 0, an old later-stage row skips
   * posting by stage rank as before.
   */
  partsPosted: z.number().int().nonnegative().default(0),
  /** Task 14: every posted part's message id, in order, for links and the trace. */
  postedMessageIds: z.array(z.string().min(1)).default([]),
  /**
   * Task 14: trace flags gathered before the invoke (currently only
   * `quote-unavailable`), carried so a retry that skips the invoke still
   * writes them into the trace.
   */
  flags: z.array(z.string().min(1)).default([]),
});
export type AssistantInvokeCursor = z.infer<typeof assistantInvokeCursor>;

/**
 * One job per Discord interaction or message: the invocation id is the
 * idempotency anchor the rest of Release 3 already dedupes on, so a gateway
 * replay of the same interaction cannot queue a second provider call.
 */
export const assistantInvokeDedupeKey = (invocationId: string): string =>
  `${JOB_KINDS.assistantInvoke}:${invocationId}`;

/**
 * The resource-cache refresh job (ADR 0073). `resourceId` absent means "every
 * resource in the guild" — the hourly sweep and "Update all" both use
 * this shape; `reason` is carried through to the trace/log line, not used to
 * branch behaviour inside the handler.
 */
export const resourceRefreshPayload = z.object({
  resourceId: z.string().min(1).max(64).optional(),
  reason: z.enum(['hourly', 'manual', 'added', 'assistant']),
});
export type ResourceRefreshPayload = z.infer<typeof resourceRefreshPayload>;

/**
 * `resource_refresh:<resourceId|all>:<bucket>` — one pending refresh per
 * resource (or per guild, for "all") per bucket, so a flapping timer or a
 * double-tapped "Update now" collapses into the one already queued rather
 * than piling up (ADR 0016). `added` carries no time bucket: a resource is
 * added or edited rarely, and collapsing every edit within the pending job's
 * lifetime into one refresh is exactly the point — the job re-reads the
 * resource row at run time, so it always picks up the latest save.
 */
export const resourceRefreshDedupeKey = (
  input:
    | { readonly reason: 'hourly'; readonly resourceId?: string; readonly hourBucket: number }
    | { readonly reason: 'manual'; readonly resourceId?: string; readonly minuteBucket: number }
    | {
        readonly reason: 'assistant';
        readonly resourceId?: string;
        readonly tenMinuteBucket: number;
      }
    | { readonly reason: 'added'; readonly resourceId: string },
): string => {
  const target = input.resourceId ?? 'all';
  switch (input.reason) {
    case 'hourly':
      return `${JOB_KINDS.resourceRefresh}:${target}:${String(input.hourBucket)}`;
    case 'manual':
      return `${JOB_KINDS.resourceRefresh}:${target}:manual:${String(input.minuteBucket)}`;
    case 'assistant':
      return `${JOB_KINDS.resourceRefresh}:${target}:assistant:${String(input.tenMinuteBucket)}`;
    case 'added':
      return `${JOB_KINDS.resourceRefresh}:${target}:added`;
  }
};
