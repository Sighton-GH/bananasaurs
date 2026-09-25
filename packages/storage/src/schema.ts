import { desc, sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
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

    // ADR 0042 §5 — a third lever, distinct from `killswitch` (emergency,
    // everything) and `dryRun` (guild-wide, everything): automod takes no
    // Discord action while every other subsystem, role panels above all,
    // keeps working. Added here, its CHECK in a separate `db:generate` run:
    // the CHECK forces a table rebuild (SQLite cannot `ALTER TABLE ADD
    // COLUMN` a CHECK constraint at all), and drizzle-kit 0.31.10 generates
    // an invalid rebuild — its `INSERT … SELECT` reads the new column from
    // the *old*, pre-rebuild table — when the column and its CHECK are added
    // in the same call. Adding the column first, unconstrained, means the
    // later CHECK-only run's rebuild reads a column the old table already
    // has, which is what the 0010/0011 precedent for `mod_rules_kind` does
    // too (add `config` in 0010; widen `kind`'s existing CHECK in 0011).
    automodTestingMode: integer('automod_testing_mode').notNull().default(0),

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
    check('guilds_automod_testing_mode_bool', boolCheck(t.automodTestingMode)),
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
    /** Managed panels only: the message body to post. NULL uses the default copy. */
    content: text('content'),
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
      sql`${t.actorType} IN ('member','owner','operator_cli','dashboard','system','doctor','mcp_operator')`,
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

// --- automod ------------------------------------------------------------

/**
 * A configured automod rule. `kind` is the extension point for the
 * predicate types the roadmap names beyond `keyword_filter` (ADR 0035). ADR
 * 0035's claim that adding a predicate needs no schema change held only for
 * `keyword_filter` itself: ADR 0040 widens `mod_rules_kind` once, here, to
 * all ten kinds Release 2 ships, and adds `config` as the scalar carrier a
 * predicate's whole-rule settings live in — a predicate implementation is
 * pure code from here on, not a migration.
 */
export const modRules = sqliteTable(
  'mod_rules',
  {
    guildId: snowflake('guild_id').notNull(),
    ruleId: text('rule_id').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    /**
     * Scalar, whole-rule predicate configuration as a JSON object (ADR 0040).
     * Validated per `kind` by a Zod schema in
     * `packages/core/src/automod/predicates/`, on write *and* on read — JSON
     * this process wrote is still untrusted on the way back in (CLAUDE.md
     * rule 3, the same reason `jobs.payload` has a validator, ADR 0037).
     *
     * List-shaped data an operator edits item by item stays relational:
     * `keyword_filter`'s word list is three tables and its `config` is `{}`.
     * ADR 0040 states that split as a rule so Slices 3-5 do not re-decide it
     * per predicate.
     */
    config: text('config').notNull().default('{}'),
    mode: text('mode').notNull().default('test'),
    enabled: integer('enabled').notNull().default(1),

    // ADR 0042 — the cutover state machine's clock (PR-27) and provenance.
    // Plain nullable columns, added in their own db:generate run: R-6 records
    // drizzle-kit emitting invalid SQL when a column add and a rebuild land
    // in one generate call, and the CHECK-constrained columns below force a
    // rebuild on this table.
    observeStartedAt: integer('observe_started_at'),
    legacyRuleRef: text('legacy_rule_ref'),
    enforceSignedOffBy: text('enforce_signed_off_by'),
    enforceSignedOffAt: integer('enforce_signed_off_at'),

    // ADR 0042 — added here unconstrained; their CHECKs land in a later,
    // separate `db:generate` run. See the `automodTestingMode` comment above
    // on `guilds` for why: adding a column and its CHECK together makes
    // drizzle-kit 0.31.10 emit a rebuild whose `INSERT … SELECT` reads the
    // new column from the old, pre-rebuild table, which does not have it.
    cutoverState: text('cutover_state').notNull().default('not_started'),
    countsAsViolation: integer('counts_as_violation').notNull().default(1),
    maxFalsePositiveRate: real('max_false_positive_rate').notNull().default(0.05),
    minReviewedMatches: integer('min_reviewed_matches').notNull().default(20),

    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.ruleId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('mod_rules_guild_id_snowflake', snowflakeCheck(t.guildId)),
    /**
     * The ten predicate kinds Release 2 ships (ADR 0040). Widened once, here,
     * rather than one migration per predicate slice, so Slices 3-5 are pure
     * code. A kind is permitted by the CHECK before its predicate exists; a
     * rule whose kind has no registered predicate is inert, logged, and
     * reported by `doctor` — the same handling as an unparseable config.
     */
    check(
      'mod_rules_kind',
      sql`${t.kind} IN ('keyword_filter','regex','invite','link_domain','mention_spam','rapid_spam','duplicate_message','caps','attachment_type','emoji')`,
    ),
    check('mod_rules_mode', sql`${t.mode} IN ('test','observe','enforce')`),
    check('mod_rules_enabled_bool', boolCheck(t.enabled)),
    // PR-27's five cutover states. Distinct from `mod_rules_mode` above.
    check(
      'mod_rules_cutover_state',
      sql`${t.cutoverState} IN ('not_started','observing','ready','cutover','rolled_back')`,
    ),
    check('mod_rules_counts_as_violation_bool', boolCheck(t.countsAsViolation)),
    // "At most 5%" (ADR 0042 §4) — inclusive at both ends: exactly 0 and
    // exactly 1 are valid rates, only outside [0,1] is nonsensical.
    check(
      'mod_rules_max_false_positive_rate_range',
      sql`${t.maxFalsePositiveRate} BETWEEN 0 AND 1`,
    ),
    check('mod_rules_min_reviewed_matches_range', sql`${t.minReviewedMatches} >= 0`),
  ],
);

export const modRuleExemptions = sqliteTable(
  'mod_rule_exemptions',
  {
    guildId: snowflake('guild_id').notNull(),
    ruleId: text('rule_id').notNull(),
    exemptType: text('exempt_type').notNull(),
    exemptId: snowflake('exempt_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.ruleId, t.exemptType, t.exemptId] }),
    foreignKey({
      columns: [t.guildId, t.ruleId],
      foreignColumns: [modRules.guildId, modRules.ruleId],
    }).onDelete('cascade'),
    check('mod_rule_exemptions_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('mod_rule_exemptions_exempt_id_snowflake', snowflakeCheck(t.exemptId)),
    check('mod_rule_exemptions_type', sql`${t.exemptType} IN ('role','channel')`),
  ],
);

/** A group of word terms sharing a default action. One rule may have several. */
export const wordCategories = sqliteTable(
  'word_categories',
  {
    guildId: snowflake('guild_id').notNull(),
    categoryId: text('category_id').notNull(),
    ruleId: text('rule_id').notNull(),
    name: text('name').notNull(),
    defaultAction: text('default_action').notNull(),
    enabled: integer('enabled').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.categoryId] }),
    foreignKey({
      columns: [t.guildId, t.ruleId],
      foreignColumns: [modRules.guildId, modRules.ruleId],
    }).onDelete('cascade'),
    check('word_categories_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check(
      'word_categories_default_action',
      sql`${t.defaultAction} IN ('log_only','delete','delete_and_case')`,
    ),
    check('word_categories_enabled_bool', boolCheck(t.enabled)),
  ],
);

/** One matched word or phrase. `actionOverride` NULL inherits the category default. */
export const wordTerms = sqliteTable(
  'word_terms',
  {
    guildId: snowflake('guild_id').notNull(),
    termId: text('term_id').notNull(),
    categoryId: text('category_id').notNull(),
    text: text('text').notNull(),
    actionOverride: text('action_override'),
    enabled: integer('enabled').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.termId] }),
    foreignKey({
      columns: [t.guildId, t.categoryId],
      foreignColumns: [wordCategories.guildId, wordCategories.categoryId],
    }).onDelete('cascade'),
    check('word_terms_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check(
      'word_terms_action_override',
      sql`${t.actionOverride} IS NULL OR ${t.actionOverride} IN ('log_only','delete','delete_and_case')`,
    ),
    check('word_terms_enabled_bool', boolCheck(t.enabled)),
  ],
);

/** Explicit exceptions, wired into obscenity's own allowlist mechanism. */
export const wordAllowlist = sqliteTable(
  'word_allowlist',
  {
    guildId: snowflake('guild_id').notNull(),
    ruleId: text('rule_id').notNull(),
    phrase: text('phrase').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.ruleId, t.phrase] }),
    foreignKey({
      columns: [t.guildId, t.ruleId],
      foreignColumns: [modRules.guildId, modRules.ruleId],
    }).onDelete('cascade'),
    check('word_allowlist_guild_id_snowflake', snowflakeCheck(t.guildId)),
  ],
);

/**
 * `invite`'s allowlist: the club's own invite codes plus partner and
 * sister-club codes, each with a human label (spec section 3, Slice 3).
 *
 * Relational rather than JSON in `mod_rules.config`, per ADR 0040 section 3:
 * the label is per-item metadata, and Slice 9's one-click suppression for
 * this predicate is "add this code to the allowlist", which is a row.
 *
 * **No `last_matched_at`, deliberately** (plan ruling PR-14). The spec asks
 * for one so a stale partner code is visible, but writing it means either a
 * database write on the hot path for every allowlisted invite in every
 * message, or widening every predicate's return type so a non-match can
 * carry observations. Carried to Slice 9, where the review surface can
 * derive staleness from match history instead. The label is what keeps the
 * list readable until then.
 */
export const automodInviteAllowlist = sqliteTable(
  'automod_invite_allowlist',
  {
    guildId: snowflake('guild_id').notNull(),
    ruleId: text('rule_id').notNull(),
    /** The invite code as it appears after `discord.gg/`. Case-preserving; matched case-insensitively. */
    code: text('code').notNull(),
    /** Why this code is allowed, for the human reading the list a year from now. */
    label: text('label').notNull(),
    addedAt: integer('added_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.ruleId, t.code] }),
    foreignKey({
      columns: [t.guildId, t.ruleId],
      foreignColumns: [modRules.guildId, modRules.ruleId],
    }).onDelete('cascade'),
    check('automod_invite_allowlist_guild_id_snowflake', snowflakeCheck(t.guildId)),
  ],
);

/**
 * `link_domain`'s allow and deny lists (spec section 3, Slice 3).
 *
 * One table with a `list_type` rather than two tables: the two lists are the
 * same shape and are always read together, and a domain that appears on both
 * is a configuration error the primary key makes impossible to express.
 *
 * Matching is label-wise suffix, not registrable-domain (plan ruling PR-15):
 * `example.com` matches `example.com` and `gist.example.com` but not
 * `notexample.com`. No Public Suffix List, and therefore no dependency and no
 * data file to go stale.
 */
export const automodLinkDomains = sqliteTable(
  'automod_link_domains',
  {
    guildId: snowflake('guild_id').notNull(),
    ruleId: text('rule_id').notNull(),
    /** Stored lower-cased, without a scheme, port or path. */
    domain: text('domain').notNull(),
    listType: text('list_type').notNull(),
    addedAt: integer('added_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.ruleId, t.domain] }),
    foreignKey({
      columns: [t.guildId, t.ruleId],
      foreignColumns: [modRules.guildId, modRules.ruleId],
    }).onDelete('cascade'),
    check('automod_link_domains_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('automod_link_domains_list_type', sql`${t.listType} IN ('allow','deny')`),
  ],
);

/**
 * Channels the owner enabled for archiving (ADR 0046 D1).
 *
 * A row here is one veto passing, not permission: live ingestion additionally
 * requires the guild in `BANANASAURS_ARCHIVE_GUILDS` and the channel absent
 * from `log_excluded_channels`, both checked in code rather than the schema.
 */
export const archiveChannels = sqliteTable(
  'archive_channels',
  {
    guildId: snowflake('guild_id').notNull(),
    channelId: snowflake('channel_id').notNull(),
    scopeKind: text('scope_kind').notNull().default('channel'),
    /**
     * ADR 0047 amendment 2026-09-20: for a `derived` row, the category row it
     * was materialised from. NULL on `channel` and `category` rows.
     * Deliberately no FK: `disable-category` removes the category row and its
     * derived children in one write, and a self-referencing composite FK
     * would only order that delete without guarding anything.
     */
    derivedFrom: snowflake('derived_from'),
    includeThreads: integer('include_threads').notNull().default(1),
    threadsFound: integer('threads_found'),
    threadsDone: integer('threads_done').notNull().default(0),
    attachmentPolicy: text('attachment_policy').notNull().default('none'),
    enabledAt: integer('enabled_at').notNull(),
    /** NULL = not started or done. */
    cursorMessageId: text('cursor_message_id'),
    backfillState: text('backfill_state').notNull().default('pending'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.channelId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('archive_channels_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('archive_channels_channel_id_snowflake', snowflakeCheck(t.channelId)),
    check('archive_channels_scope_kind', sql`${t.scopeKind} IN ('channel','category','derived')`),
    check('archive_channels_derived_from_snowflake', nullableSnowflakeCheck(t.derivedFrom)),
    check('archive_channels_include_threads_bool', sql`${t.includeThreads} IN (0,1)`),
    check('archive_channels_attachment_policy', sql`${t.attachmentPolicy} IN ('none','bytes')`),
    check(
      'archive_channels_backfill_state',
      sql`${t.backfillState} IN ('pending','running','done')`,
    ),
  ],
);

/**
 * One archived message. `content` is NULL after purge, or never known.
 *
 * An FTS5 external-content index over this table's `content` exists; it is
 * created by `drizzle/0020_archive_fts.sql` because a virtual table cannot
 * be declared here; see ADR 0049.
 *
 * `caseId` (PR-69) is set by the operator via `linkToCase`, which verifies
 * the case exists in scope and is open. Deliberately no FK: a case deleted
 * by a future path must not cascade into the moderation record's neighbour,
 * and `ON DELETE SET NULL` would be a write to a row whose lifetime the
 * expiry job owns.
 */
export const archiveMessages = sqliteTable(
  'archive_messages',
  {
    guildId: snowflake('guild_id').notNull(),
    messageId: snowflake('message_id').notNull(),
    channelId: snowflake('channel_id').notNull(),
    threadId: text('thread_id'),
    /** NULL for webhook/system messages. */
    authorId: text('author_id'),
    /** NULL after purge, or never known. */
    content: text('content'),
    /**
     * Live ingestion stores `receivedAtMs`, the backfill stores the
     * snowflake-derived `createdAtMs`, so the two populations differ by the
     * gateway delivery delay — M2's search ordering must not assume otherwise.
     */
    createdAt: integer('created_at').notNull(),
    editedAt: integer('edited_at'),
    deletedAt: integer('deleted_at'),
    retentionClass: text('retention_class').notNull().default('default'),
    /** PR-69; no FK. */
    caseId: text('case_id'),
    contentPurgedAt: integer('content_purged_at'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.messageId] }),
    foreignKey({
      columns: [t.guildId, t.channelId],
      foreignColumns: [archiveChannels.guildId, archiveChannels.channelId],
    }).onDelete('cascade'),
    index('archive_messages_channel_created').on(t.guildId, t.channelId, t.createdAt),
    index('archive_messages_thread_created').on(t.guildId, t.threadId, t.createdAt),
    index('archive_messages_deleted').on(t.guildId, t.deletedAt),
    check('archive_messages_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('archive_messages_message_id_snowflake', snowflakeCheck(t.messageId)),
    check('archive_messages_channel_id_snowflake', snowflakeCheck(t.channelId)),
    check('archive_messages_thread_id_snowflake', nullableSnowflakeCheck(t.threadId)),
    check(
      'archive_messages_retention_class',
      sql`${t.retentionClass} IN ('default','case','preserve')`,
    ),
  ],
);

/**
 * Edit history for an archived message. `content` is the content BEFORE this
 * edit. Purged with the message it belongs to.
 */
export const archiveMessageEdits = sqliteTable(
  'archive_message_edits',
  {
    guildId: snowflake('guild_id').notNull(),
    messageId: snowflake('message_id').notNull(),
    editSeq: integer('edit_seq').notNull(),
    /** The content BEFORE this edit. */
    content: text('content'),
    editedAt: integer('edited_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.messageId, t.editSeq] }),
    foreignKey({
      columns: [t.guildId, t.messageId],
      foreignColumns: [archiveMessages.guildId, archiveMessages.messageId],
    }).onDelete('cascade'),
    check('archive_message_edits_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('archive_message_edits_message_id_snowflake', snowflakeCheck(t.messageId)),
  ],
);

/**
 * One attachment on an archived message: filename, declared type, size.
 *
 * `sha256` and `bytesPath` are always NULL in M1 (PR-67): under `none`
 * nothing is fetched so there is nothing to hash, and the `bytes` fetcher
 * ships in a later slice behind a host allowlist. The columns ship now so
 * the schema does not change later.
 */
export const archiveAttachments = sqliteTable(
  'archive_attachments',
  {
    guildId: snowflake('guild_id').notNull(),
    messageId: snowflake('message_id').notNull(),
    attachmentId: snowflake('attachment_id').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type'),
    size: integer('size').notNull(),
    /** Always NULL in M1 (PR-67). */
    sha256: text('sha256'),
    /** Always NULL in M1 (PR-67). */
    bytesPath: text('bytes_path'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.messageId, t.attachmentId] }),
    foreignKey({
      columns: [t.guildId, t.messageId],
      foreignColumns: [archiveMessages.guildId, archiveMessages.messageId],
    }).onDelete('cascade'),
    check('archive_attachments_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('archive_attachments_message_id_snowflake', snowflakeCheck(t.messageId)),
    check('archive_attachments_attachment_id_snowflake', snowflakeCheck(t.attachmentId)),
  ],
);

/** Per-member violation history. What escalation reads to pick the next tier. */
export const modCases = sqliteTable(
  'mod_cases',
  {
    guildId: snowflake('guild_id').notNull(),
    caseId: text('case_id').notNull(),
    memberId: snowflake('member_id').notNull(),
    openedAt: integer('opened_at').notNull(),
    violationCount: integer('violation_count').notNull().default(0),
    escalationTier: integer('escalation_tier').notNull().default(0),
    status: text('status').notNull().default('open'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.caseId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    // One open case per member — a new violation resolves into the existing
    // open case rather than forking a second one.
    uniqueIndex('mod_cases_open_per_member')
      .on(t.guildId, t.memberId)
      .where(sql`${t.status} = 'open'`),
    check('mod_cases_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('mod_cases_member_id_snowflake', snowflakeCheck(t.memberId)),
    check('mod_cases_status', sql`${t.status} IN ('open','closed')`),
    check('mod_cases_violation_count_nonnegative', sql`${t.violationCount} >= 0`),
    check('mod_cases_escalation_tier_nonnegative', sql`${t.escalationTier} >= 0`),
  ],
);

/**
 * One matched event and what happened as a result — including a refusal.
 *
 * ADR 0035: a moderation-action refusal (owner, hierarchy) is recorded here
 * as its own event, not left log-only the way a Release 1 role-effect
 * refusal is. `refusalReason` is deliberately a superset of the effect
 * gateway's `RefusalReason` plus one moderation-specific value
 * (`'discord-owner'`) for Discord's own unconditional owner protection,
 * which has no equivalent in the role-mutation vocabulary.
 */
export const modCaseEvents = sqliteTable(
  'mod_case_events',
  {
    guildId: snowflake('guild_id').notNull(),
    eventId: text('event_id').notNull(),
    caseId: text('case_id').notNull(),
    ruleId: text('rule_id').notNull(),
    memberId: snowflake('member_id').notNull(),
    channelId: text('channel_id'),
    at: integer('at').notNull(),
    matchedCategory: text('matched_category').notNull(),
    matchedSnippet: text('matched_snippet').notNull(),
    actionTaken: text('action_taken').notNull(),
    escalationAction: text('escalation_action'),
    refusalReason: text('refusal_reason'),
    /**
     * Who acted, for manual events (ADR 0037). Null for automod/system
     * events, whose actor is implicitly the bot; a moderator command's
     * actor is a member who must be visible in case history — "every
     * action records actor" is a Release 2 gate, not a convention.
     */
    actorId: snowflake('actor_id'),
    /**
     * Why the rule matched, as JSON (ADR 0041 §4). Nullable — every row
     * written before this slice has none, and a manual `/mod` event never
     * has one.
     *
     * Stored rather than recomputed at review time, because the rule may
     * have been edited in the two weeks between the match and the review:
     * recomputing would answer "what would this rule decide about that
     * message today", which is a different question from the one the
     * reviewer is being asked and looks identical on screen.
     *
     * Storage never validates it (ADR 0014 — the Zod schema lives in
     * `packages/core/src/automod/trace.ts`). It comes back out as raw text
     * and core parses it, the same arrangement `mod_rules.config` has.
     *
     * **Never carries the whole message.** Whole-message content lives in
     * `automod_fixtures` under the owner's explicit decision; a second copy
     * here would put member content somewhere that decision did not reach.
     */
    trace: text('trace'),
    /**
     * The `automod_fixtures` row captured from the same message, when there
     * was one (plan ruling PR-5).
     *
     * This is what makes ADR 0041's "a verdict recorded during the window is
     * a labelled fixture afterwards" an implementation rather than an
     * aspiration: recording a verdict follows this link to set the fixture's
     * label. Null for enforce-mode matches (nothing is captured — PR-2), for
     * manual events, and for every row written before this slice.
     *
     * Deliberately *not* a foreign key. A fixture deleted by `/forgetme`
     * must not cascade into the moderation record, and `ON DELETE SET NULL`
     * would be a write to an append-only table. A dangling id resolves to
     * "no fixture", which is the truthful answer after a deletion.
     */
    fixtureId: text('fixture_id'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.eventId] }),
    foreignKey({
      columns: [t.guildId, t.caseId],
      foreignColumns: [modCases.guildId, modCases.caseId],
    }).onDelete('cascade'),
    check('mod_case_events_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('mod_case_events_member_id_snowflake', snowflakeCheck(t.memberId)),
    check('mod_case_events_channel_id_snowflake', nullableSnowflakeCheck(t.channelId)),
    /**
     * One value per *real* outcome, so case history cannot claim a punishment
     * that never happened.
     *
     * The first vocabulary had three values and the subscriber mapped every
     * non-refused escalation onto `deleted_and_escalated` — which recorded a
     * timeout or a kick for a `dry-run`, `skipped` or `failed`
     * `ModerationOutcome` too — and reused `deleted` for a `test`/`observe`
     * mode match where nothing was deleted at all. Both are lies in a table
     * whose entire purpose (ADR 0035) is a durable, truthful record a
     * moderator reads back later.
     *
     * The five `escalation_*`/`deleted*` values below map one-to-one onto
     * `ModerationOutcome`'s five variants, after a real deletion. The
     * `delete_blocked_*` values are the case where enforcement never reached
     * Discord because a safety layer (docs/18) said no; `would_delete` is the
     * `test`/`observe` case, which is not a deletion and no longer pretends
     * to be one; `delete_failed` is a deletion Discord actually refused.
     */
    check(
      'mod_case_events_action_taken',
      sql`${t.actionTaken} IN (
        'deleted','deleted_and_escalated','escalation_refused','escalation_failed',
        'escalation_dry_run','escalation_skipped','would_delete','delete_failed',
        'delete_blocked_killswitch','delete_blocked_breaker','delete_blocked_dry_run',
        'delete_blocked_guild_unknown',
        'warned','note','evidence_added','purged','purge_refused','purge_failed',
        'manual_applied',
        'native_blocked','native_alerted','native_timeout','native_blocked_interaction')`,
    ),
    check(
      'mod_case_events_escalation_action',
      sql`${t.escalationAction} IS NULL OR ${t.escalationAction} IN ('timeout','kick','ban','unban')`,
    ),
    check(
      'mod_case_events_refusal_reason',
      sql`${t.refusalReason} IS NULL OR ${t.refusalReason} IN
        ('unauthorized','guild-unknown','killswitch','breaker-open','rate-cap','discord-owner','role-above-bot')`,
    ),
    check('mod_case_events_actor_id_snowflake', nullableSnowflakeCheck(t.actorId)),
  ],
);

/**
 * The automod review corpus (ADR 0041 §1).
 *
 * Holds whole messages, which is a deliberate, owner-approved extension of
 * what Bananasaurs keeps — `PRIVACY.md`'s retention table carries the
 * matching row, added in the same commit as this table, because a policy
 * that is not true is worse than no policy.
 *
 * Two sources with different rules. An `observed` row is a real member's
 * message, captured because a `test`/`observe` rule matched it, and
 * `deleteObservedFixturesForMember` can remove every one of a member's rows
 * — the path Release 3's `/forgetme` (R3-10) wires up rather than invents.
 * A `handwritten` row is an adversarial case the project wrote itself: not
 * member data, and never deleted by `/forgetme`.
 *
 * `content` is the zero-width-stripped text the predicate actually saw, so a
 * replay reproduces the original evaluation exactly rather than a
 * re-normalised approximation of it.
 */
export const automodFixtures = sqliteTable(
  'automod_fixtures',
  {
    guildId: snowflake('guild_id').notNull(),
    /**
     * For an `observed` fixture, `<messageId>:<first 16 hex of sha256(content)>`
     * (plan ruling PR-1): a gateway replay of the identical message is the
     * same fixture and collapses into one row, while an edit that matches
     * again is different evidence and gets its own. For a `handwritten`
     * fixture, a UUID.
     *
     * TEXT rather than a snowflake column: only half of it is a snowflake,
     * and a handwritten fixture's id is not one at all.
     */
    fixtureId: text('fixture_id').notNull(),
    content: text('content').notNull(),
    /**
     * The message's author, so a member's own rows can be found and removed.
     * Null for `handwritten` fixtures, which have no member behind them.
     */
    authorId: snowflake('author_id'),
    label: text('label').notNull().default('unlabelled'),
    source: text('source').notNull(),
    /** Why a human labelled it this way. Free text, nullable. */
    note: text('note'),
    /**
     * Also the replay clock: `PredicateInput.atMs` comes from here, never
     * from `Date.now()`, which is what makes the window tier's dry run
     * deterministic (ADR 0041 §6).
     */
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.fixtureId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('automod_fixtures_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('automod_fixtures_author_id_snowflake', nullableSnowflakeCheck(t.authorId)),
    check(
      'automod_fixtures_label',
      sql`${t.label} IN ('should_match','should_not_match','unlabelled')`,
    ),
    check('automod_fixtures_source', sql`${t.source} IN ('observed','handwritten')`),
    /**
     * A `handwritten` fixture has no author and an `observed` one must have
     * one — the invariant `deleteObservedFixturesForMember` depends on. Left
     * to the database rather than the repo, so a row inserted by hand in
     * `sqlite3` cannot break the `/forgetme` promise either.
     */
    check(
      'automod_fixtures_observed_has_author',
      sql`(${t.source} = 'observed' AND ${t.authorId} IS NOT NULL)
        OR (${t.source} = 'handwritten' AND ${t.authorId} IS NULL)`,
    ),
    /** The dry run reads the whole corpus in `created_at` order (ADR 0041 §6). */
    index('automod_fixtures_replay').on(t.guildId, t.createdAt),
    /** `deleteObservedFixturesForMember`'s lookup. */
    index('automod_fixtures_by_author').on(t.guildId, t.authorId),
  ],
);

/**
 * One attachment on a corpus message: filename, declared content type, size
 * (OD-3).
 *
 * A child table rather than columns on `automod_fixtures` because a message
 * carries up to ten attachments, and neither a JSON blob nor an arbitrary
 * three-column cap is a schema.
 *
 * **This stores personal information and the owner was told so before
 * approving it.** Filenames routinely carry it — `Bryan_resume_2026.pdf`,
 * `medical_letter.docx` — and this keeps them for as long as the corpus keeps
 * the message. `PRIVACY.md` names attachments in the same commit that created
 * this table, and the `ON DELETE CASCADE` below is what makes `/forgetme`
 * (R3-10) reach them through `deleteObservedFixturesForMember`. That cascade
 * is tested, not assumed.
 *
 * No `attachment_id` from Discord: the corpus is evidence about a message,
 * not a mirror of Discord's own ids, and the ordinal is enough to keep two
 * identically-named files apart.
 */
export const automodFixtureAttachments = sqliteTable(
  'automod_fixture_attachments',
  {
    guildId: snowflake('guild_id').notNull(),
    fixtureId: text('fixture_id').notNull(),
    /** Position on the message, 0-based. Part of the key: two attachments can share a name. */
    ordinal: integer('ordinal').notNull(),
    fileName: text('file_name').notNull(),
    /** Null when Discord declared none. Never flattened to '' — that is a different fact. */
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.fixtureId, t.ordinal] }),
    foreignKey({
      columns: [t.guildId, t.fixtureId],
      foreignColumns: [automodFixtures.guildId, automodFixtures.fixtureId],
    }).onDelete('cascade'),
    check('automod_fixture_attachments_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('automod_fixture_attachments_ordinal_nonnegative', sql`${t.ordinal} >= 0`),
    check('automod_fixture_attachments_size_nonnegative', sql`${t.sizeBytes} >= 0`),
  ],
);

/**
 * A human's verdict on one recorded match (ADR 0041 §5).
 *
 * Its own table rather than a column on `mod_case_events`, for the reason
 * ADR 0036 exists: a case event is the record of what happened and must
 * never be rewritten. A verdict is a later judgement *about* that record,
 * made by a named person at a known time — a different fact with a different
 * lifetime. Merging them would let a review edit history.
 *
 * One row per event (plan ruling PR-4): a reviewer who changes their mind
 * updates the verdict rather than appending a second one. The current
 * verdict is the fact Slice 6's gate reads; the history of a *revised*
 * verdict is not something anything needs today, and adding it later is an
 * additive table rather than a migration of this one.
 */
export const modMatchReviews = sqliteTable(
  'mod_match_reviews',
  {
    guildId: snowflake('guild_id').notNull(),
    eventId: text('event_id').notNull(),
    verdict: text('verdict').notNull(),
    /**
     * Who thought this — plain TEXT, deliberately not a snowflake column
     * (plan ruling PR-9).
     *
     * Two reviewers with two kinds of identity write here. Slice 9's
     * dashboard authenticates a Discord user and writes a snowflake; the
     * operator CLI, which ships first and covers the whole first fortnight
     * of the observe window, has only the Unix user the invocation claimed
     * (ADR 0024) and writes `cli:<user>`. A snowflake CHECK would make the
     * path that exists on flip day impossible to write.
     *
     * Provenance, not authorisation: the socket's group permissions are the
     * access control, and the dispatcher's `audit_events` row is the
     * authoritative record of who ran the command.
     */
    reviewedBy: text('reviewed_by').notNull(),
    reviewedAt: integer('reviewed_at').notNull(),
    note: text('note'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.eventId] }),
    foreignKey({
      columns: [t.guildId, t.eventId],
      foreignColumns: [modCaseEvents.guildId, modCaseEvents.eventId],
    }).onDelete('cascade'),
    check('mod_match_reviews_guild_id_snowflake', snowflakeCheck(t.guildId)),
    /**
     * `unclear` is a real verdict, not a missing one: the spec's decision 16
     * counts it as a false positive for the Slice 6 gate. Recording it
     * faithfully here is this slice's whole job; the counting is Slice 6's.
     */
    check(
      'mod_match_reviews_verdict',
      sql`${t.verdict} IN ('false_positive','true_positive','unclear')`,
    ),
  ],
);

/**
 * A moderation action awaiting its second confirmation (ADR 0037).
 *
 * `/mod ban` and `/mod purge` do not execute on invocation: the command
 * writes the intent here, renders an ephemeral preview with Confirm/Cancel
 * buttons, and only the confirming tap — by the same moderator, before
 * `expires_at` — executes it. The row is the durable half of that handshake;
 * the interaction token is Discord's half and dies with the process, so an
 * intent that outlives its token simply expires (recorded as accepted in
 * the ADR, not fixed).
 *
 * `payload` is JSON and Zod-validated on read, like every payload we wrote
 * ourselves. `takePendingAction` reads and deletes in one write, so a
 * confirm is one-shot at the storage layer — a double-tap on Confirm, or a
 * replayed component dispatch, finds the row already gone.
 */
export const modPendingActions = sqliteTable(
  'mod_pending_actions',
  {
    guildId: snowflake('guild_id').notNull(),
    intentId: text('intent_id').notNull(),
    payload: text('payload').notNull(),
    /** Only this principal may confirm — a button left on screen is not an authorization transfer. */
    createdBy: snowflake('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    /** The interaction-token window: created_at + 15 minutes (ADR 0018). */
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.intentId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    index('mod_pending_actions_expiry').on(t.expiresAt),
    check('mod_pending_actions_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('mod_pending_actions_created_by_snowflake', snowflakeCheck(t.createdBy)),
    check('mod_pending_actions_expiry_sane', sql`${t.expiresAt} > ${t.createdAt}`),
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
 * OAuth 2.1 clients. Instance-level (ADR 0045 D3): a client is registered
 * against the daemon, not against a guild.
 */
export const oauthClients = sqliteTable(
  'oauth_clients',
  {
    clientId: text('client_id').primaryKey(),
    clientName: text('client_name').notNull(),
    /** JSON array of absolute URIs. */
    redirectUris: text('redirect_uris').notNull(),
    createdAt: integer('created_at').notNull(),
    createdByAccountId: text('created_by_account_id'),
    registrationSource: text('registration_source').notNull(),
  },
  (t) => [
    check('oauth_clients_registration_source', sql`${t.registrationSource} IN ('dynamic','cli')`),
  ],
);

/**
 * Pending consent forms (ADR 0045 Amendment 1, PR-91). The dashboard's CSRF
 * is a custom request header matched against the session's token, which an
 * HTML form cannot send and this flow has no session to draw from. So the
 * form carries a single-use nonce instead, issued only after the client,
 * redirect URI and PKCE parameters have already been validated.
 */
export const oauthPendingAuthorizations = sqliteTable('oauth_pending_authorizations', {
  requestId: text('request_id').primaryKey(),
  nonceHash: text('nonce_hash').notNull(),
  clientId: text('client_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  scopes: text('scopes').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  state: text('state'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
});

/** Authorization codes. Single-use; a replay revokes what it minted (ADR 0045 D5). */
export const oauthAuthorizationCodes = sqliteTable('oauth_authorization_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull(),
  accountId: text('account_id').notNull(),
  scopes: text('scopes').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
});

/**
 * Access and refresh tokens. No `guild_id`, deliberately and permanently:
 * ADR 0045 Amendment 1 PR-92 computes the reachable guild set live at each
 * call from the approving account's current `mcp.authorize` grants, so a
 * guild recorded here would be a second, staler place where scope is decided.
 */
export const oauthTokens = sqliteTable(
  'oauth_tokens',
  {
    tokenId: text('token_id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    kind: text('kind').notNull(),
    clientId: text('client_id').notNull(),
    accountId: text('account_id').notNull(),
    scopes: text('scopes').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    lastUsedAt: integer('last_used_at'),
    /** The refresh token this was rotated from. */
    parentTokenId: text('parent_token_id'),
    /**
     * The code_hash this token's ANCESTRY was minted from — inherited by
     * every rotation, not just the first pair (ruling PR-94). Without the
     * inheritance, a code replayed after a rotation finds only dead rows and
     * the live tokens survive the very event that proves the code leaked.
     */
    issuedFromCodeHash: text('issued_from_code_hash').notNull(),
  },
  (t) => [
    uniqueIndex('oauth_tokens_hash').on(t.tokenHash),
    index('oauth_tokens_by_account').on(t.accountId),
    index('oauth_tokens_by_client').on(t.clientId),
    check('oauth_tokens_kind', sql`${t.kind} IN ('access','refresh')`),
  ],
);

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

/**
 * The channels the owner has allowed the MCP connector to post into (slice
 * M5, ruling M5-D1 layer 1). The allowlist is per guild: the primary key
 * leads with `guild_id`, so the same channel id in two guilds is two rows.
 */
export const mcpSendAllowlist = sqliteTable(
  'mcp_send_allowlist',
  {
    guildId: snowflake('guild_id').notNull(),
    channelId: snowflake('channel_id').notNull(),
    scopeKind: text('scope_kind').notNull().default('channel'),
    /** The dashboard account that allowed it — an account id, not a snowflake. */
    addedByAccountId: text('added_by_account_id').notNull(),
    addedAt: integer('added_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.channelId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('mcp_send_allowlist_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('mcp_send_allowlist_channel_id_snowflake', snowflakeCheck(t.channelId)),
    check('mcp_send_allowlist_scope_kind', sql`${t.scopeKind} IN ('channel','category')`),
  ],
);

/**
 * One row per accepted send, and the idempotency ledger (slice M5, hard
 * rule 6).
 *
 * `content_hash` is the hash of `(channel_id, content)` (ruling M5-D3): a
 * retried key with a matching hash is a replay, with a differing hash a
 * refusal. `message_id` is NULL for `dry_run` rows and filled in by
 * `recordSentMessageId` once the Discord REST call returns. `token_id` is the
 * opaque `tok_…` row id, never a token value (ADR 0045 D8). The UNIQUE on
 * `(guild_id, idempotency_key)` is what makes double execution impossible;
 * `sent_at` carries the index the rolling-hour count (ruling M5-D4) reads.
 */
export const mcpSends = sqliteTable(
  'mcp_sends',
  {
    guildId: snowflake('guild_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    channelId: snowflake('channel_id').notNull(),
    contentHash: text('content_hash').notNull(),
    messageId: snowflake('message_id'),
    tokenId: text('token_id').notNull(),
    sentAt: integer('sent_at').notNull(),
    outcome: text('outcome').notNull(),
  },
  (t) => [
    unique('mcp_sends_idempotency_once').on(t.guildId, t.idempotencyKey),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    index('mcp_sends_recent').on(t.guildId, t.sentAt),
    check('mcp_sends_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('mcp_sends_channel_id_snowflake', snowflakeCheck(t.channelId)),
    check('mcp_sends_message_id_snowflake', nullableSnowflakeCheck(t.messageId)),
    check('mcp_sends_outcome', sql`${t.outcome} IN ('sent','dry_run')`),
  ],
);

/**
 * Training-eligibility record (ADR 0044 §7, ADR 0010 §1). Instance-level
 * (ADR 0027): a provider is a fact about the daemon, not a guild — the same
 * reason `bootstrap_tokens` and `oauth_clients` carry no `guild_id`.
 */
export const providerEligibility = sqliteTable(
  'provider_eligibility',
  {
    provider: text('provider').primaryKey(),
    trainsOnInput: text('trains_on_input').notNull(),
    /** The settings page / clause cited as evidence. */
    evidenceUrl: text('evidence_url').notNull(),
    /**
     * The quoted terms clause (ADR 0061 §1). Null on migration-seeded rows,
     * which cite their clause in the migration and `PRIVACY.md`; a row the
     * dashboard writes always carries one.
     */
    evidenceClause: text('evidence_clause'),
    productionUseAllowed: integer('production_use_allowed').notNull(),
    /** Epoch-ms the evidence was last verified. */
    reviewedAt: integer('reviewed_at').notNull(),
  },
  (t) => [
    check(
      'provider_eligibility_trains_on_input',
      sql`${t.trainsOnInput} IN ('no','yes','unknown')`,
    ),
    check('provider_eligibility_production_use_allowed_bool', boolCheck(t.productionUseAllowed)),
  ],
);

// Instance-level encrypted provider configuration. The API key is write-only; only ciphertext reaches storage.
export const assistantProviderConfig = sqliteTable(
  'assistant_provider_config',
  {
    configId: text('config_id').primaryKey().default('active'),
    provider: text('provider').notNull().default('off'),
    model: text('model'),
    apiKeyEnc: text('api_key_enc'),
    enabled: integer('enabled').notNull().default(0),
    /** The owner's statement of the model's cost (ADR 0061 §2); overrides `AI_PROFILE_COST_CLASS`. */
    costClass: text('cost_class').notNull().default('unknown'),
    /** ADR 0068: up to two more models, tried in order when the one before is busy. */
    fallbackModelsJson: text('fallback_models_json').notNull().default('[]'),
    /** ADR 0066: the Brave Search API key, sealed like `api_key_enc`. */
    searchApiKeyEnc: text('search_api_key_enc'),
    searchEnabled: integer('search_enabled').notNull().default(0),
    /** ADR 0075: the GitHub token, sealed like `api_key_enc`. */
    githubTokenEnc: text('github_token_enc'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    check('assistant_provider_config_cost_class', sql`${t.costClass} IN ('free','paid','unknown')`),
    check('assistant_provider_config_search_enabled_bool', boolCheck(t.searchEnabled)),
    check(
      'assistant_provider_config_provider',
      sql`${t.provider} IN ('off','gemini','openrouter','nvidia-nim')`,
    ),
    check('assistant_provider_config_enabled_bool', boolCheck(t.enabled)),
  ],
);

// ADR 0075: one row per AI provider (Gemini, OpenRouter, NVIDIA NIM), each
// with its own sealed API key, cost class and enabled flag. Instance-level
// like the single-provider config it replaces; the old row's provider, model
// and fallback models are copied here and into `assistant_model_chain` by
// the migration, and the old columns stay but are no longer read.
export const assistantProviders = sqliteTable(
  'assistant_providers',
  {
    provider: text('provider').primaryKey(),
    apiKeyEnc: text('api_key_enc'),
    /** The owner's statement of the model's cost (ADR 0061 §2). */
    costClass: text('cost_class').notNull().default('unknown'),
    enabled: integer('enabled').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    check(
      'assistant_providers_provider',
      sql`${t.provider} IN ('gemini','openrouter','nvidia-nim')`,
    ),
    check('assistant_providers_cost_class', sql`${t.costClass} IN ('free','paid','unknown')`),
    check('assistant_providers_enabled_bool', boolCheck(t.enabled)),
  ],
);

// ADR 0075: the one ordered model chain, at most 6 entries. Each entry names
// its provider plus model; positions are dense from 0. The foreign key keeps
// a chain entry from naming a provider with no key row, and removing a
// provider drops its chain rows.
export const assistantModelChain = sqliteTable(
  'assistant_model_chain',
  {
    position: integer('position').primaryKey(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.provider], foreignColumns: [assistantProviders.provider] }).onDelete(
      'cascade',
    ),
    check('assistant_model_chain_position', sql`${t.position} BETWEEN 0 AND 5`),
    check(
      'assistant_model_chain_provider',
      sql`${t.provider} IN ('gemini','openrouter','nvidia-nim')`,
    ),
  ],
);

// --- Release 3 assistant ----------------------------------------------------
export const assistantServerCards = sqliteTable(
  'assistant_server_cards',
  {
    guildId: snowflake('guild_id').notNull(),
    content: text('content').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('assistant_server_cards_guild_id_snowflake', snowflakeCheck(t.guildId)),
  ],
);

export const assistantMemories = sqliteTable(
  'assistant_memories',
  {
    guildId: snowflake('guild_id').notNull(),
    memoryId: text('memory_id').notNull(),
    section: text('section').notNull().default('General'),
    content: text('content').notNull(),
    subjectId: snowflake('subject_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.memoryId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('assistant_memories_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('assistant_memories_subject_id_snowflake', nullableSnowflakeCheck(t.subjectId)),
  ],
);

export const assistantMemoryPreferences = sqliteTable(
  'assistant_memory_preferences',
  {
    guildId: snowflake('guild_id').notNull(),
    userId: snowflake('user_id').notNull(),
    optedOut: integer('opted_out').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.userId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('assistant_memory_preferences_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('assistant_memory_preferences_user_id_snowflake', snowflakeCheck(t.userId)),
    check('assistant_memory_preferences_opted_out_bool', boolCheck(t.optedOut)),
  ],
);
export const assistantBehaviours = sqliteTable(
  'assistant_behaviours',
  {
    guildId: snowflake('guild_id').notNull(),
    behaviourId: text('behaviour_id').notNull(),
    surface: text('surface').notNull(),
    mentionRoleId: snowflake('mention_role_id'),
    name: text('name').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    promptVersion: integer('prompt_version').notNull().default(1),
    enabled: integer('enabled').notNull().default(1),
    skillIdsJson: text('skill_ids_json').notNull().default('[]'),
    callerRoleIdsJson: text('caller_role_ids_json').notNull().default('[]'),
    ticketChannelId: snowflake('ticket_channel_id'),
    reviewerRoleIdsJson: text('reviewer_role_ids_json').notNull().default('[]'),
    resourceIdsJson: text('resource_ids_json').notNull().default('[]'),
    // ADR 0063: the one behaviour that answers a tag of the bot user itself.
    answersBotTag: integer('answers_bot_tag').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.behaviourId] }),
    // At most one per guild, enforced here rather than by caller discipline.
    uniqueIndex('assistant_behaviours_one_bot_tag')
      .on(t.guildId)
      .where(sql`${t.answersBotTag} = 1`),
    check('assistant_behaviours_answers_bot_tag_bool', boolCheck(t.answersBotTag)),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check(
      'assistant_behaviours_surface',
      sql`${t.surface} IN ('bananasaurs','it-services','help','direct-command')`,
    ),
    check('assistant_behaviours_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('assistant_behaviours_enabled_bool', boolCheck(t.enabled)),
    check('assistant_behaviours_mention_snowflake', nullableSnowflakeCheck(t.mentionRoleId)),
    check(
      'assistant_behaviours_ticket_channel_snowflake',
      nullableSnowflakeCheck(t.ticketChannelId),
    ),
  ],
);

/** ADR 0065: per-guild assistant settings that are not about one behaviour. */
export const assistantSettings = sqliteTable(
  'assistant_settings',
  {
    guildId: snowflake('guild_id').primaryKey(),
    logChannelId: snowflake('log_channel_id'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('assistant_settings_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('assistant_settings_log_channel_snowflake', nullableSnowflakeCheck(t.logChannelId)),
  ],
);

export const assistantResources = sqliteTable(
  'assistant_resources',
  {
    guildId: snowflake('guild_id').notNull(),
    resourceId: text('resource_id').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    kind: text('kind').notNull(),
    enabled: integer('enabled').notNull().default(1),
    reviewedAt: integer('reviewed_at').notNull(),
    lastFetchedAt: integer('last_fetched_at'),
    fetchStatus: text('fetch_status').notNull().default('pending'),
    content: text('content'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.resourceId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check(
      'assistant_resources_kind',
      sql`${t.kind} IN ('website','document','discord-channel','repository','note')`,
    ),
    check('assistant_resources_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('assistant_resources_enabled_bool', boolCheck(t.enabled)),
    check(
      'assistant_resources_fetch_status',
      sql`${t.fetchStatus} IN ('pending','ok','failed','blocked')`,
    ),
  ],
);

export const assistantReminders = sqliteTable(
  'assistant_reminders',
  {
    guildId: snowflake('guild_id').notNull(),
    reminderId: text('reminder_id').notNull(),
    creatorId: snowflake('creator_id').notNull(),
    destinationId: snowflake('destination_id').notNull(),
    text: text('text').notNull(),
    dueAt: integer('due_at').notNull(),
    // The original due time never moves: retries persist the next attempt in
    // next_attempt_at and claims stamp claimed_at, so the delivery terminal
    // window can be measured from when the reminder fell due (finding 4).
    nextAttemptAt: integer('next_attempt_at'),
    claimedAt: integer('claimed_at'),
    createdAt: integer('created_at').notNull(),
    status: text('status').notNull().default('scheduled'),
    dedupeKey: text('dedupe_key').notNull(),
    failureReason: text('failure_reason'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.reminderId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    unique('assistant_reminders_dedupe').on(t.guildId, t.dedupeKey),
    check('assistant_reminders_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('assistant_reminders_creator_snowflake', snowflakeCheck(t.creatorId)),
    check('assistant_reminders_destination_snowflake', snowflakeCheck(t.destinationId)),
    check(
      'assistant_reminders_status',
      sql`${t.status} IN ('scheduled','delivering','delivered','cancelled','failed')`,
    ),
    index('assistant_reminders_due').on(t.guildId, t.status, t.dueAt),
  ],
);

export const assistantSkillActivity = sqliteTable(
  'assistant_skill_activity',
  {
    guildId: snowflake('guild_id').notNull(),
    activityId: text('activity_id').notNull(),
    at: integer('at').notNull(),
    behaviourId: text('behaviour_id').notNull(),
    skillId: text('skill_id').notNull(),
    actorId: snowflake('actor_id').notNull(),
    outcome: text('outcome').notNull(),
    detail: text('detail'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.activityId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('assistant_skill_activity_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('assistant_skill_activity_actor_snowflake', snowflakeCheck(t.actorId)),
    index('assistant_skill_activity_recent').on(t.guildId, t.at),
  ],
);

export const assistantSkillGrants = sqliteTable(
  'assistant_skill_grants',
  {
    guildId: snowflake('guild_id').notNull(),
    skillId: text('skill_id').notNull(),
    roleIdsJson: text('role_ids_json').notNull().default('[]'),
    userIdsJson: text('user_ids_json').notNull().default('[]'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.skillId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('assistant_skill_grants_guild_id_snowflake', snowflakeCheck(t.guildId)),
  ],
);

export const assistantTickets = sqliteTable(
  'assistant_tickets',
  {
    guildId: snowflake('guild_id').notNull(),
    ticketId: text('ticket_id').notNull(),
    behaviourId: text('behaviour_id').notNull(),
    channelId: snowflake('channel_id').notNull(),
    requesterId: snowflake('requester_id').notNull(),
    summary: text('summary').notNull(),
    status: text('status').notNull().default('open'),
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.ticketId] }),
    unique('assistant_tickets_dedupe').on(t.guildId, t.dedupeKey),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('assistant_tickets_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('assistant_tickets_channel_id_snowflake', snowflakeCheck(t.channelId)),
    check('assistant_tickets_requester_id_snowflake', snowflakeCheck(t.requesterId)),
    check('assistant_tickets_status', sql`${t.status} IN ('open','claimed','resolved')`),
  ],
);

export const assistantDecisions = sqliteTable(
  'assistant_decisions',
  {
    guildId: snowflake('guild_id').notNull(),
    decisionId: text('decision_id').notNull(),
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    status: text('status').notNull().default('draft'),
    requesterId: snowflake('requester_id').notNull(),
    provenance: text('provenance').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.decisionId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('assistant_decisions_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('assistant_decisions_requester_id_snowflake', snowflakeCheck(t.requesterId)),
    check('assistant_decisions_kind', sql`${t.kind} IN ('decision','review-plan','memory')`),
    check('assistant_decisions_status', sql`${t.status} IN ('draft','reviewed','saved')`),
  ],
);

// ADR 0076: one row per assistant run. The queryable columns (who, when,
// behaviour, outcome, conversation, tokens) stay real columns so the History
// list filters without parsing JSON; the full run is `body_json`, capped at
// 200 KB by `capTrace` before it reaches this table. Rows die with their
// conversation through the prune job, and with their guild through the FK.
export const assistantTraces = sqliteTable(
  'assistant_traces',
  {
    guildId: snowflake('guild_id').notNull(),
    traceId: text('trace_id').notNull(),
    at: integer('at').notNull(),
    userId: snowflake('user_id').notNull(),
    behaviourId: text('behaviour_id').notNull(),
    outcome: text('outcome').notNull(),
    conversationId: text('conversation_id'),
    durationMs: integer('duration_ms').notNull(),
    totalTokens: integer('total_tokens'),
    bodyJson: text('body_json').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.traceId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('assistant_traces_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('assistant_traces_user_id_snowflake', snowflakeCheck(t.userId)),
    check('assistant_traces_outcome', sql`${t.outcome} IN ('answered','refused','failed')`),
    index('assistant_traces_recent').on(t.guildId, t.at),
    index('assistant_traces_conversation').on(t.guildId, t.conversationId),
  ],
);

// ADR 0073: the persistent resource cache. One row per fetched document
// (a reviewed resource's URL, or a note's own text); `resource_chunks` holds
// the chunker's output for search and `resource_chunks_fts`
// (drizzle/hand-written, ADR 0049 pattern) indexes `resource_chunks.text`.
export const resourceDocuments = sqliteTable(
  'resource_documents',
  {
    guildId: snowflake('guild_id').notNull(),
    docId: text('doc_id').notNull(),
    resourceId: text('resource_id').notNull(),
    url: text('url').notNull(),
    path: text('path').notNull(),
    title: text('title').notNull(),
    etag: text('etag'),
    lastModified: text('last_modified'),
    // Empty until the first successful fetch or note chunk; never NULL, so a
    // change-comparison never has to special-case "no prior hash".
    contentHash: text('content_hash').notNull().default(''),
    fetchedAt: integer('fetched_at').notNull(),
    bytes: integer('bytes').notNull().default(0),
    status: text('status').notNull().default('ok'),
    error: text('error'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.docId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    foreignKey({
      columns: [t.guildId, t.resourceId],
      foreignColumns: [assistantResources.guildId, assistantResources.resourceId],
    }).onDelete('cascade'),
    check('resource_documents_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('resource_documents_status', sql`${t.status} IN ('ok','error')`),
    index('resource_documents_resource').on(t.guildId, t.resourceId),
  ],
);

export const resourceChunks = sqliteTable(
  'resource_chunks',
  {
    guildId: snowflake('guild_id').notNull(),
    chunkId: text('chunk_id').notNull(),
    docId: text('doc_id').notNull(),
    resourceId: text('resource_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    headingPath: text('heading_path').notNull(),
    lineStart: integer('line_start').notNull(),
    lineEnd: integer('line_end').notNull(),
    text: text('text').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.chunkId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    foreignKey({
      columns: [t.guildId, t.docId],
      foreignColumns: [resourceDocuments.guildId, resourceDocuments.docId],
    }).onDelete('cascade'),
    check('resource_chunks_guild_id_snowflake', snowflakeCheck(t.guildId)),
    index('resource_chunks_doc').on(t.guildId, t.docId, t.ordinal),
    index('resource_chunks_resource').on(t.guildId, t.resourceId),
  ],
);
