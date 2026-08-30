import { desc, sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { boolCheck, nullableSnowflakeCheck, snowflake, snowflakeCheck } from './columns.js';

/**
 * The Release 1 schema.
 *
 * Guild scope is structural, not conventional: every table outside the short
 * INSTANCE_LEVEL list in `schema-invariants.test.ts` carries `guild_id`, and
 * every foreign key includes it, so a child row physically cannot reference a
 * parent in another guild. That is enforced by the invariant test, which reads
 * the live schema and fails the build rather than trusting review.
 *
 * Snowflakes are TEXT because they exceed Number.MAX_SAFE_INTEGER. Timestamps
 * are INTEGER epoch-millis. Every table is STRICT — drizzle-kit cannot emit it,
 * so `scripts/strictify.mjs` adds it after generation and the schema invariant
 * test fails the build if a table ever loses it.
 */
export const guilds = sqliteTable(
  'guilds',
  {
    guildId: snowflake('guild_id').primaryKey(),
    name: text('name').notNull(),
    enabled: integer('enabled').notNull().default(0),

    // docs/18 Layer 6: stops side effects while leaving the process observable.
    killswitch: integer('killswitch').notNull().default(0),
    // docs/18 Layer 4. Defaults on: an unconfigured guild performs no writes.
    dryRun: integer('dry_run').notNull().default(1),

    // docs/18 Layer 3, as amended: the standing per-source ceiling.
    roleRatePerMin: integer('role_rate_per_min').notNull().default(20),
    reconcileBudget: integer('reconcile_budget').notNull().default(25),
    breakerThreshold: integer('breaker_threshold').notNull().default(5),
    breakerState: text('breaker_state').notNull().default('closed'),
    breakerTrippedAt: integer('breaker_tripped_at'),
    breakerReason: text('breaker_reason'),

    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    // The partition key is format-checked at the database, not only in Zod.
    check('guilds_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('guilds_breaker_state', sql`${t.breakerState} IN ('closed','open')`),
    check('guilds_enabled_bool', boolCheck(t.enabled)),
    check('guilds_killswitch_bool', boolCheck(t.killswitch)),
    check('guilds_dry_run_bool', boolCheck(t.dryRun)),
    check(
      'guilds_positive_limits',
      sql`${t.roleRatePerMin} > 0 AND ${t.reconcileBudget} > 0 AND ${t.breakerThreshold} > 0`,
    ),
  ],
);

// --- panels -----------------------------------------------------------------

/**
 * The role allowlist (docs/18 Layer 2), as a table rather than a code check.
 *
 * `panel_options` and `role_effects` both carry a composite foreign key into
 * this table, which is what makes "the bot may only touch these roles" a
 * constraint rather than a guard clause someone can forget. `assignable` and
 * `unassignable_reason` are written by the doctor self-check.
 */
export const managedRoles = sqliteTable(
  'managed_roles',
  {
    guildId: snowflake('guild_id').notNull(),
    roleId: snowflake('role_id').notNull(),
    assignable: integer('assignable').notNull().default(1),
    unassignableReason: text('unassignable_reason'),
    lastCheckedAt: integer('last_checked_at'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.roleId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('managed_roles_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('managed_roles_role_id_snowflake', snowflakeCheck(t.roleId)),
    check('managed_roles_assignable_bool', boolCheck(t.assignable)),
    check(
      'managed_roles_unassignable_reason',
      sql`${t.unassignableReason} IS NULL OR ${t.unassignableReason} IN ('above_bot','managed','deleted')`,
    ),
  ],
);

/**
 * A role panel, adopted or managed.
 *
 * `message_id` is NULL until a managed panel is posted. An adopted panel is
 * reaction-driven by definition — the bot did not author the message and so
 * cannot attach components to it — which the `kind`/`component` check enforces
 * rather than leaving to the code that creates panels.
 */
export const panels = sqliteTable(
  'panels',
  {
    guildId: snowflake('guild_id').notNull(),
    panelId: text('panel_id').notNull(),
    kind: text('kind').notNull(),
    channelId: snowflake('channel_id').notNull(),
    messageId: snowflake('message_id'),
    behaviour: text('behaviour').notNull(),
    component: text('component').notNull(),
    /** Per-panel ceiling. NULL means unlimited. */
    maxRoles: integer('max_roles'),
    requiredRoleId: snowflake('required_role_id'),
    status: text('status').notNull().default('enabled'),
    disabledReason: text('disabled_reason'),
    adoptedAt: integer('adopted_at'),
    adoptionPassState: text('adoption_pass_state').notNull().default('pending'),
    /**
     * The size of the change list the most recent `runAdoptionPass` computed
     * and could not apply because the standing allowance did not cover it.
     * `0` means either "never examined" or "resolved" — `adoption_pass_state`
     * alone cannot tell those apart, which is what let `reconcileGuild` apply
     * a grant `runAdoptionPass` had explicitly refused (ADR 0021).
     */
    adoptionBlockedCount: integer('adoption_blocked_count').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.panelId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    // A message hosts at most one panel.
    unique('panels_message_once').on(t.guildId, t.channelId, t.messageId),
    check('panels_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('panels_channel_id_snowflake', snowflakeCheck(t.channelId)),
    check('panels_message_id_snowflake', nullableSnowflakeCheck(t.messageId)),
    check('panels_required_role_id_snowflake', nullableSnowflakeCheck(t.requiredRoleId)),
    check('panels_kind', sql`${t.kind} IN ('adopted','managed')`),
    check(
      'panels_behaviour',
      sql`${t.behaviour} IN ('toggle','add_only','remove_only','single_choice')`,
    ),
    check('panels_component', sql`${t.component} IN ('reaction','button','select')`),
    check(
      'panels_status',
      sql`${t.status} IN ('enabled','disabled_by_doctor','disabled_by_owner')`,
    ),
    check(
      'panels_adoption_pass_state',
      sql`${t.adoptionPassState} IN ('pending','running','done','refused')`,
    ),
    check('panels_adoption_blocked_count_nonnegative', sql`${t.adoptionBlockedCount} >= 0`),
    // An adopted panel is reaction-driven and can never carry components.
    check('panels_adopted_is_reaction', sql`${t.kind} <> 'adopted' OR ${t.component} = 'reaction'`),
    // single_choice on an adopted panel cannot work: removing another emoji's
    // reaction on someone else's behalf is not possible. Collision 1 in
    // docs/19 §6.3, enforced here rather than validated in code.
    check(
      'panels_single_choice_is_managed',
      sql`${t.behaviour} <> 'single_choice' OR ${t.kind} = 'managed'`,
    ),
    check('panels_max_roles_positive', sql`${t.maxRoles} IS NULL OR ${t.maxRoles} > 0`),
  ],
);

/**
 * One offered role on a panel.
 *
 * The foreign key into `managed_roles` **is** the role allowlist: inserting an
 * option for an unregistered role raises SQLITE_CONSTRAINT_FOREIGNKEY. RESTRICT
 * rather than CASCADE, because removing a role from the allowlist while a panel
 * still offers it should fail loudly rather than silently emptying the panel.
 */
export const panelOptions = sqliteTable(
  'panel_options',
  {
    guildId: snowflake('guild_id').notNull(),
    panelId: text('panel_id').notNull(),
    optionId: text('option_id').notNull(),
    roleId: snowflake('role_id').notNull(),
    /** Canonical: 'u:1f9e0' or 'c:123456789012345678'. See core/discord/emoji. */
    emojiKey: text('emoji_key'),
    label: text('label'),
    position: integer('position').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.panelId, t.optionId] }),
    foreignKey({
      columns: [t.guildId, t.panelId],
      foreignColumns: [panels.guildId, panels.panelId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.guildId, t.roleId],
      foreignColumns: [managedRoles.guildId, managedRoles.roleId],
    }).onDelete('restrict'),
    unique('panel_options_role_once').on(t.guildId, t.panelId, t.roleId),
    unique('panel_options_emoji_once').on(t.guildId, t.panelId, t.emojiKey),
    check('panel_options_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('panel_options_role_id_snowflake', snowflakeCheck(t.roleId)),
  ],
);

/** Roles that bar a member from using a panel. Need not be allowlisted. */
export const panelBlockedRoles = sqliteTable(
  'panel_blocked_roles',
  {
    guildId: snowflake('guild_id').notNull(),
    panelId: text('panel_id').notNull(),
    roleId: snowflake('role_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.panelId, t.roleId] }),
    foreignKey({
      columns: [t.guildId, t.panelId],
      foreignColumns: [panels.guildId, panels.panelId],
    }).onDelete('cascade'),
    check('panel_blocked_roles_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('panel_blocked_roles_role_id_snowflake', snowflakeCheck(t.roleId)),
  ],
);

// --- effects and idempotency ------------------------------------------------

/**
 * A group of effects applied together, and the unit of undo.
 *
 * Every side effect belongs to a batch, so `bananasaurs undo <batch>` has
 * something to name and the audit trail has something to group by.
 */
export const effectBatches = sqliteTable(
  'effect_batches',
  {
    guildId: snowflake('guild_id').notNull(),
    batchId: text('batch_id').notNull(),
    source: text('source').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    undoneAt: integer('undone_at'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.batchId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('effect_batches_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check(
      'effect_batches_source',
      sql`${t.source} IN ('interaction','reaction','adoption','reconcile','cli','dashboard')`,
    ),
  ],
);

/**
 * One attempted role mutation, and the record that makes double execution
 * impossible.
 *
 * `role_effects_dedupe` is THE idempotency constraint. The gateway does an
 * insert-or-ignore before the REST call; a zero-row insert means this effect
 * already happened, so the call is skipped. Gateway events replay on
 * reconnect, so this is not a defensive nicety — it is the thing that makes a
 * replayed event harmless.
 *
 * `had_role_before` is the before-state that makes undo possible. Without it,
 * undoing a grant cannot tell "we added this role" from "they already had it".
 */
export const roleEffects = sqliteTable(
  'role_effects',
  {
    guildId: snowflake('guild_id').notNull(),
    effectId: text('effect_id').notNull(),
    batchId: text('batch_id').notNull(),
    /** sha256(guild ‖ panel ‖ user ‖ role ‖ action ‖ trigger_ref). */
    dedupeKey: text('dedupe_key').notNull(),
    userId: snowflake('user_id').notNull(),
    roleId: snowflake('role_id').notNull(),
    action: text('action').notNull(),
    state: text('state').notNull().default('planned'),
    hadRoleBefore: integer('had_role_before').notNull(),
    panelId: text('panel_id'),
    attemptedAt: integer('attempted_at'),
    completedAt: integer('completed_at'),
    errorCode: text('error_code'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.effectId] }),
    foreignKey({
      columns: [t.guildId, t.batchId],
      foreignColumns: [effectBatches.guildId, effectBatches.batchId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.guildId, t.roleId],
      foreignColumns: [managedRoles.guildId, managedRoles.roleId],
    }).onDelete('restrict'),
    uniqueIndex('role_effects_dedupe').on(t.guildId, t.dedupeKey),
    // Amendment 5: GUILD_MEMBER_UPDATE fires for our own mutations too, and the
    // handler suppresses the feedback loop by looking for a recent effect on
    // this (guild, user, role). That lookup needs an index of its own.
    index('role_effects_recent').on(t.guildId, t.userId, t.roleId, t.completedAt),
    check('role_effects_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('role_effects_user_id_snowflake', snowflakeCheck(t.userId)),
    check('role_effects_role_id_snowflake', snowflakeCheck(t.roleId)),
    check('role_effects_action', sql`${t.action} IN ('grant','revoke')`),
    check(
      'role_effects_state',
      sql`${t.state} IN ('planned','applied','skipped','failed','dry_run')`,
    ),
    check('role_effects_had_role_before_bool', boolCheck(t.hadRoleBefore)),
  ],
);

/**
 * Provenance, not current state.
 *
 * Amendment 4: convergence diffs the desired role set against the member's
 * **live Discord roles**, fetched at convergence time — never against this
 * table. Diffing against our own record means a role removed by hand in
 * Discord still reads "granted" here, convergence computes an empty change
 * set, and the drift is never repaired.
 *
 * So this answers "which panel granted this, when, under which effect". Discord
 * answers "does this member have the role", which is the same principle that
 * makes adopted panels work at all.
 */
export const managedRoleAssignments = sqliteTable(
  'managed_role_assignments',
  {
    guildId: snowflake('guild_id').notNull(),
    userId: snowflake('user_id').notNull(),
    roleId: snowflake('role_id').notNull(),
    panelId: text('panel_id').notNull(),
    grantedAt: integer('granted_at').notNull(),
    grantedByEffect: text('granted_by_effect').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.userId, t.roleId] }),
    foreignKey({
      columns: [t.guildId, t.panelId],
      foreignColumns: [panels.guildId, panels.panelId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.guildId, t.roleId],
      foreignColumns: [managedRoles.guildId, managedRoles.roleId],
    }).onDelete('restrict'),
    check('managed_role_assignments_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('managed_role_assignments_user_id_snowflake', snowflakeCheck(t.userId)),
    check('managed_role_assignments_role_id_snowflake', snowflakeCheck(t.roleId)),
  ],
);

// --- event pipeline, jobs, audit --------------------------------------------

/**
 * Gateway dedupe, by derived fingerprint.
 *
 * `docs/02`, `docs/08` and `REVIEW.md` C8 all prescribe a unique index on
 * `(guild_id, discord_event_id)`. That cannot be built: **gateway dispatches
 * carry no event ID.** `MESSAGE_REACTION_ADD` has no id field, and the `s`
 * sequence number is per-session and resets on reconnect. So the fingerprint is
 * derived per event kind — see `core/src/pipeline/fingerprint.ts`.
 *
 * Reactions are deliberately absent from this table. `(message, user, emoji,
 * action)` is not unique over time — a member may add, remove and add again —
 * so reactions are treated as level-triggered: the event is a hint that state
 * may have changed, and convergence recomputes rather than deduplicating.
 *
 * No foreign key to `guilds`, deliberately. This is written by the pipeline at
 * a point where the guild row may not exist yet (a reconnect delivers events
 * around GUILD_CREATE), and a constraint failure here would drop the very
 * event it is meant to record. The sweep job bounds the table instead.
 */
export const eventDedupe = sqliteTable(
  'event_dedupe',
  {
    guildId: snowflake('guild_id').notNull(),
    eventKind: text('event_kind').notNull(),
    fingerprint: text('fingerprint').notNull(),
    firstSeenAt: integer('first_seen_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.eventKind, t.fingerprint] }),
    // The table grows without bound otherwise; the sweep job runs on this.
    index('event_dedupe_sweep').on(t.firstSeenAt),
    check('event_dedupe_guild_id_snowflake', snowflakeCheck(t.guildId)),
  ],
);

/**
 * A window during which events were not received.
 *
 * `resumed = 0` means a fresh IDENTIFY, so dispatches in the gap were lost and
 * are not replayed. Reaction state is recoverable by reconciliation; message
 * edits and deletions are not, and the logging module marks the gap rather than
 * pretending the period was quiet.
 *
 * No foreign key, for the same reason as `event_dedupe`: a gap is recorded on
 * reconnect, which is exactly when the guild row may not have been written yet.
 */
export const gatewayGaps = sqliteTable(
  'gateway_gaps',
  {
    gapId: integer('gap_id').primaryKey({ autoIncrement: true }),
    guildId: snowflake('guild_id').notNull(),
    disconnectedAt: integer('disconnected_at').notNull(),
    reconnectedAt: integer('reconnected_at').notNull(),
    resumed: integer('resumed').notNull(),
    reconciledAt: integer('reconciled_at'),
  },
  (t) => [
    index('gateway_gaps_unreconciled').on(t.guildId, t.reconciledAt),
    check('gateway_gaps_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('gateway_gaps_resumed_bool', boolCheck(t.resumed)),
  ],
);

/**
 * The durable job table (ADR 0008 — no external queue, one process).
 *
 * `jobs_dedupe` makes enqueuing the same work twice a no-op, which matters
 * because reconnects re-trigger reconciliation. `cursor` holds resumable
 * progress so the adoption pass survives a restart mid-page.
 *
 * `payload` is JSON and is Zod-validated on read, never trusted because we
 * wrote it — a payload written by an older version is untrusted input.
 */
export const jobs = sqliteTable(
  'jobs',
  {
    jobId: integer('job_id').primaryKey({ autoIncrement: true }),
    guildId: snowflake('guild_id').notNull(),
    kind: text('kind').notNull(),
    payload: text('payload').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    state: text('state').notNull().default('queued'),
    runAfter: integer('run_after').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    cursor: text('cursor'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    // Partial, over pending work only (ADR 0016).
    //
    // The dedupe key exists so a flapping connection queues one reconciliation
    // rather than one per reconnect. Unconditional, it did something else:
    // rows are never deleted, so a key was single-use for the lifetime of the
    // database and the *second* gateway gap ever enqueued nothing at all.
    // Uniqueness over `queued`/`running` keeps the collapse and drops the
    // permanent block.
    uniqueIndex('jobs_dedupe')
      .on(t.guildId, t.dedupeKey)
      .where(sql`${t.state} IN ('queued','running')`),
    // Partial, so the index holds only claimable work rather than every job
    // ever run.
    //
    // Led by guild_id, unlike the plan's `(state, run_after)`. The plan's form
    // anticipated a worker claiming across every guild; the claim in
    // `repos/jobs.ts` is guild-scoped instead, because a cross-guild claim
    // would be the one query in the system able to omit the partition key.
    // Index what is actually queried, not what was once imagined.
    index('jobs_claim')
      .on(t.guildId, t.state, t.runAfter)
      .where(sql`${t.state} = 'queued'`),
    check('jobs_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('jobs_state', sql`${t.state} IN ('queued','running','done','failed','cancelled')`),
    check('jobs_attempts_sane', sql`${t.attempts} >= 0 AND ${t.maxAttempts} > 0`),
  ],
);

/**
 * The audit trail. Every effect writes one, including a refused one and
 * including a dry run.
 *
 * `inferred` marks attribution that came from the audit log rather than from
 * the event (REVIEW C4). MESSAGE_DELETE carries no actor, so the actor is a
 * best-effort guess, and it is labelled as one everywhere it surfaces.
 *
 * `actor_unix_user_claimed` is CLI-asserted and **not kernel-verified** —
 * Node cannot read SO_PEERCRED, so the operator CLI's identity is a claim.
 * Amendment 2: the real access control is the socket's group permissions, and
 * `audit tail` renders this field as claimed rather than as fact. The column
 * name carries the caveat so the next person to build on it inherits it.
 */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    auditId: integer('audit_id').primaryKey({ autoIncrement: true }),
    guildId: snowflake('guild_id').notNull(),
    at: integer('at').notNull(),
    actorType: text('actor_type').notNull(),
    /** A Discord user id or a dashboard account id — no snowflake CHECK. */
    actorId: text('actor_id'),
    actorUnixUserClaimed: text('actor_unix_user_claimed'),
    via: text('via'),
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id'),
    batchId: text('batch_id'),
    before: text('before'),
    after: text('after'),
    dryRun: integer('dry_run').notNull().default(0),
    inferred: integer('inferred').notNull().default(0),
  },
  (t) => [
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    index('audit_tail').on(t.guildId, desc(t.at)),
    check('audit_events_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check(
      'audit_events_actor_type',
      sql`${t.actorType} IN ('member','owner','operator_cli','dashboard','system','doctor')`,
    ),
    check('audit_events_via', sql`${t.via} IS NULL OR ${t.via} IN ('ssh','http','gateway')`),
    check('audit_events_dry_run_bool', boolCheck(t.dryRun)),
    check('audit_events_inferred_bool', boolCheck(t.inferred)),
  ],
);

// --- log routing ------------------------------------------------------------

/**
 * Where each logged event kind goes.
 *
 * `include_content` defaults on for `message_delete` and `message_edit`
 * (decision 3, reversed on owner review: Carl-bot already logs content to a
 * log channel, so metadata-only would be a regression members never asked
 * for). Any route can be turned off individually.
 */
export const logRoutes = sqliteTable(
  'log_routes',
  {
    guildId: snowflake('guild_id').notNull(),
    eventKind: text('event_kind').notNull(),
    channelId: snowflake('channel_id').notNull(),
    includeContent: integer('include_content').notNull().default(1),
    enabled: integer('enabled').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.eventKind] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('log_routes_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('log_routes_channel_id_snowflake', snowflakeCheck(t.channelId)),
    check('log_routes_include_content_bool', boolCheck(t.includeContent)),
    check('log_routes_enabled_bool', boolCheck(t.enabled)),
  ],
);

/** Channels never logged from, whatever the routes say. */
export const logExcludedChannels = sqliteTable(
  'log_excluded_channels',
  {
    guildId: snowflake('guild_id').notNull(),
    channelId: snowflake('channel_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.channelId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('log_excluded_channels_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('log_excluded_channels_channel_id_snowflake', snowflakeCheck(t.channelId)),
  ],
);

/**
 * How much of a coalesced `MESSAGE_DELETE` audit run this module has already
 * attributed to a message (ADR 0023 decision 3).
 *
 * A `MESSAGE_DELETE` audit entry describes a *run* of deletions by one actor
 * against one author in one channel, and its `count` is a running total, not
 * a per-deletion signal (ADR 0019). `claimed_count` is what makes "a new
 * deletion joined this run" answerable at all: compare the entry's live
 * count against how much of it this module has already claimed.
 */
export const messageDeleteRuns = sqliteTable(
  'message_delete_runs',
  {
    guildId: snowflake('guild_id').notNull(),
    actorUserId: snowflake('actor_user_id').notNull(),
    authorId: snowflake('author_id').notNull(),
    channelId: snowflake('channel_id').notNull(),
    claimedCount: integer('claimed_count').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.actorUserId, t.authorId, t.channelId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('message_delete_runs_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('message_delete_runs_actor_user_id_snowflake', snowflakeCheck(t.actorUserId)),
    check('message_delete_runs_author_id_snowflake', snowflakeCheck(t.authorId)),
    check('message_delete_runs_channel_id_snowflake', snowflakeCheck(t.channelId)),
    check('message_delete_runs_claimed_count_nonnegative', sql`${t.claimedCount} >= 0`),
  ],
);

// --- dashboard accounts and capability --------------------------------------

/**
 * A dashboard login. Instance-level, not guild-scoped: an account exists
 * before a guild is chosen, and ADR 0012 makes access a separate grant.
 */
export const dashboardAccounts = sqliteTable(
  'dashboard_accounts',
  {
    accountId: text('account_id').primaryKey(),
    username: text('username').notNull(),
    /** Argon2id. */
    passwordHash: text('password_hash').notNull(),
    totpSecretEnc: text('totp_secret_enc'),
    totpEnrolled: integer('totp_enrolled').notNull().default(0),
    isOwner: integer('is_owner').notNull().default(0),
    disabled: integer('disabled').notNull().default(0),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: integer('locked_until'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('dashboard_accounts_username').on(t.username),
    check('dashboard_accounts_totp_enrolled_bool', boolCheck(t.totpEnrolled)),
    check('dashboard_accounts_is_owner_bool', boolCheck(t.isOwner)),
    check('dashboard_accounts_disabled_bool', boolCheck(t.disabled)),
  ],
);

/**
 * Which guilds an account may reach. Nothing reaches guild data ungated.
 *
 * Keyed `(guild_id, account_id)` rather than the plan's `(account_id,
 * guild_id)`, so the partition key leads and the schema invariant holds
 * without an exemption. The reversed order costs nothing here: the table holds
 * a handful of rows, and the login-time "which guilds can I see" query is not
 * hot.
 */
export const accountGuildAccess = sqliteTable(
  'account_guild_access',
  {
    guildId: snowflake('guild_id').notNull(),
    accountId: text('account_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.accountId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    foreignKey({
      columns: [t.accountId],
      foreignColumns: [dashboardAccounts.accountId],
    }).onDelete('cascade'),
    check('account_guild_access_guild_id_snowflake', snowflakeCheck(t.guildId)),
  ],
);

/**
 * What a dashboard account may do in a guild it can reach (ADR 0028).
 *
 * A second capability table beside `capability_grants`, deliberately. The two
 * hold grants for two disjoint key spaces: a Discord principal is a snowflake,
 * a dashboard account is an `acct_…` id. Putting accounts in
 * `capability_grants` would have meant relaxing both the `snowflake()` column
 * guard and the `NOT GLOB` CHECK on `principals.principal_id` — dropping a
 * protection on the most security-critical table in the schema so that two rows
 * could share a column. `AuthzStore.hasGrant` remains the single function
 * anything calls to ask "does this principal hold this capability", so there is
 * still exactly one place the two could diverge.
 *
 * The foreign key is composite and points at `account_guild_access`, not at
 * `dashboard_accounts`. That is the load-bearing part: **capability in a guild
 * the account cannot reach is not representable**, and revoking access cascades
 * the capabilities away rather than leaving them dormant for the next time
 * access is granted.
 */
export const accountCapabilities = sqliteTable(
  'account_capabilities',
  {
    guildId: snowflake('guild_id').notNull(),
    accountId: text('account_id').notNull(),
    capability: text('capability').notNull(),
    grantedAt: integer('granted_at').notNull(),
    /** A dashboard account id or a Discord user id — no snowflake CHECK. */
    grantedBy: text('granted_by').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.accountId, t.capability] }),
    foreignKey({
      columns: [t.guildId, t.accountId],
      foreignColumns: [accountGuildAccess.guildId, accountGuildAccess.accountId],
    }).onDelete('cascade'),
    check('account_capabilities_guild_id_snowflake', snowflakeCheck(t.guildId)),
  ],
);

/**
 * A dashboard session. Guild-scoped per ADR 0012: a session is for one guild,
 * so a stolen cookie cannot be pointed at another.
 *
 * The primary key is the session id alone, and is the one unique index in the
 * schema that does not lead with `guild_id`. That is deliberate and is
 * recorded in UNIQUE_BY_DESIGN: a session is looked up by its token *before*
 * the guild is known, so guild-scoping the lookup would mean trusting a
 * client-supplied guild in order to authenticate the session.
 */
export const dashboardSessions = sqliteTable(
  'dashboard_sessions',
  {
    /** Random 256-bit, hashed at rest. */
    sessionId: text('session_id').primaryKey(),
    accountId: text('account_id').notNull(),
    guildId: snowflake('guild_id').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    /** Destructive actions require a recent re-authentication. */
    reauthAt: integer('reauth_at'),
    ip: text('ip'),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId],
      foreignColumns: [dashboardAccounts.accountId],
    }).onDelete('cascade'),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    index('dashboard_sessions_by_account').on(t.guildId, t.accountId),
    check('dashboard_sessions_guild_id_snowflake', snowflakeCheck(t.guildId)),
  ],
);

/** Single-use token that provisions the first owner account. Instance-level. */
export const bootstrapTokens = sqliteTable('bootstrap_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
});

/**
 * A Discord identity that can hold capability.
 *
 * Discord Administrator grants nothing (ADR 0012). Capability comes only from
 * a row here plus a grant. `protected` marks the principals docs/18 Layer 2
 * refuses to act on at all, regardless of grants.
 */
export const principals = sqliteTable(
  'principals',
  {
    guildId: snowflake('guild_id').notNull(),
    principalId: snowflake('principal_id').notNull(),
    principalType: text('principal_type').notNull(),
    protected: integer('protected').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.principalType, t.principalId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('principals_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('principals_principal_id_snowflake', snowflakeCheck(t.principalId)),
    check('principals_principal_type', sql`${t.principalType} IN ('user','role')`),
    check('principals_protected_bool', boolCheck(t.protected)),
  ],
);

/**
 * The table `authorize()` queries. One indexed lookup on a composite primary
 * key, which is what makes runtime re-verification in the effect gateway cheap
 * enough to do on every call (amendment 3).
 */
export const capabilityGrants = sqliteTable(
  'capability_grants',
  {
    guildId: snowflake('guild_id').notNull(),
    principalType: text('principal_type').notNull(),
    principalId: snowflake('principal_id').notNull(),
    capability: text('capability').notNull(),
    grantedAt: integer('granted_at').notNull(),
    /** A Discord user id or a dashboard account id — no snowflake CHECK. */
    grantedBy: text('granted_by').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.principalType, t.principalId, t.capability] }),
    foreignKey({
      columns: [t.guildId, t.principalType, t.principalId],
      foreignColumns: [principals.guildId, principals.principalType, principals.principalId],
    }).onDelete('cascade'),
    check('capability_grants_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('capability_grants_principal_id_snowflake', snowflakeCheck(t.principalId)),
  ],
);
