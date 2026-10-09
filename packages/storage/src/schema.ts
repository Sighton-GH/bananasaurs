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

    // ADR 0121: the guild-wide automod switch. Off by default. The column
    // and its CHECK were added in separate db:generate runs (0100, then
    // 0101): drizzle-kit 0.31.10 generates an invalid rebuild — its
    // `INSERT … SELECT` reads the new column from the *old*, pre-rebuild
    // table — when a column and its CHECK land in the same call.
    automodState: text('automod_state').notNull().default('off'),

    // ADR 0131: the per-guild task-posts switch (0/1). Off by default; posts
    // go out only when this is on and BANANASAURS_DRY_RUN is off. Column and
    // CHECK are generated in separate runs, for the drizzle-kit reason above.
    taskPostsEnabled: integer('task_posts_enabled').notNull().default(0),

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
    check('guilds_task_posts_enabled_bool', boolCheck(t.taskPostsEnabled)),
    check('guilds_automod_state', sql`${t.automodState} IN ('off','watch','on')`),
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
      sql`${t.source} IN ('interaction','reaction','adoption','reconcile','cli','dashboard','mcp')`,
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
 * A named logging route (ADR 0123 decisions 1-2).
 *
 * One row per route, keyed by its own random-UUID `route_id` (like task ids):
 * a UUID is never reused after a delete, so a replayed event's claim can
 * never be confused with a different route's claim. The route's event kinds
 * and per-route excluded source channels are child rows in
 * `log_route_events` and `log_route_exclusions`.
 */
export const logRoutes = sqliteTable(
  'log_routes',
  {
    guildId: snowflake('guild_id').notNull(),
    routeId: text('route_id').notNull(),
    name: text('name').notNull(),
    channelId: snowflake('channel_id').notNull(),
    includeContent: integer('include_content').notNull().default(1),
    enabled: integer('enabled').notNull().default(1),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.routeId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('log_routes_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('log_routes_channel_id_snowflake', snowflakeCheck(t.channelId)),
    check('log_routes_include_content_bool', boolCheck(t.includeContent)),
    check('log_routes_enabled_bool', boolCheck(t.enabled)),
  ],
);

/**
 * The event kinds a route logs (ADR 0123 decision 2).
 *
 * `event_kind` is validated in code against core's `LOG_EVENT_KINDS`, not by
 * a SQL CHECK. The composite foreign key carries `guild_id`, so a child row
 * cannot point at a route in another guild; deleting the route cascades.
 */
export const logRouteEvents = sqliteTable(
  'log_route_events',
  {
    guildId: snowflake('guild_id').notNull(),
    routeId: text('route_id').notNull(),
    eventKind: text('event_kind').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.routeId, t.eventKind] }),
    foreignKey({
      columns: [t.guildId, t.routeId],
      foreignColumns: [logRoutes.guildId, logRoutes.routeId],
    }).onDelete('cascade'),
    check('log_route_events_guild_id_snowflake', snowflakeCheck(t.guildId)),
  ],
);

/**
 * Per-route excluded source channels (ADR 0123 decisions 2 and 4).
 *
 * Distinct from the guild-wide `log_excluded_channels` list below, which
 * still wins over every route. An event is skipped for a route when its
 * channel, or its thread parent, is in this route's exclusions.
 */
export const logRouteExclusions = sqliteTable(
  'log_route_exclusions',
  {
    guildId: snowflake('guild_id').notNull(),
    routeId: text('route_id').notNull(),
    channelId: snowflake('channel_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.routeId, t.channelId] }),
    foreignKey({
      columns: [t.guildId, t.routeId],
      foreignColumns: [logRoutes.guildId, logRoutes.routeId],
    }).onDelete('cascade'),
    check('log_route_exclusions_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('log_route_exclusions_channel_id_snowflake', snowflakeCheck(t.channelId)),
  ],
);

/**
 * A member's last-seen record, for old → new logging (ADR 0123 decision 8).
 *
 * Written on member events and compared against; the row is deleted once the
 * member leaves. Stores avatar hashes, never images. `role_ids` is a JSON
 * array of snowflake strings, sorted — parsed defensively on read.
 */
export const logMemberSnapshots = sqliteTable(
  'log_member_snapshots',
  {
    guildId: snowflake('guild_id').notNull(),
    userId: snowflake('user_id').notNull(),
    username: text('username').notNull(),
    globalName: text('global_name'),
    nickname: text('nickname'),
    avatarHash: text('avatar_hash'),
    guildAvatarHash: text('guild_avatar_hash'),
    roleIds: text('role_ids').notNull().default('[]'),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.userId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('log_member_snapshots_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('log_member_snapshots_user_id_snowflake', snowflakeCheck(t.userId)),
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
    enabled: integer('enabled').notNull().default(1),

    countsAsViolation: integer('counts_as_violation').notNull().default(1),

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
    check('mod_rules_enabled_bool', boolCheck(t.enabled)),
    check('mod_rules_counts_as_violation_bool', boolCheck(t.countsAsViolation)),
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
     * Deliberately no FK: `delete-category` removes the category row and its
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
    /** ADR 0126: 0 = Archive off (paused). Rows and messages are kept; nothing records. */
    collecting: integer('collecting').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.channelId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('archive_channels_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('archive_channels_collecting', sql`${t.collecting} IN (0,1)`),
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
    /**
     * The message this one replies to (slice 2 task 3). Nullable snowflake,
     * same CHECK shape as `thread_id` above.
     */
    replyToMessageId: snowflake('reply_to_message_id'),
    /**
     * Mentioned roles as a JSON array of snowflakes (slice 2 task 3). NULL
     * when the message mentioned none — never `'[]'` — so "mentions a role"
     * and "mentions no role" stay distinguishable in SQL.
     */
    mentionedRoleIds: text('mentioned_role_ids'),
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
    index('archive_messages_author_created').on(t.guildId, t.authorId, t.createdAt),
    check('archive_messages_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('archive_messages_message_id_snowflake', snowflakeCheck(t.messageId)),
    check('archive_messages_channel_id_snowflake', snowflakeCheck(t.channelId)),
    check('archive_messages_thread_id_snowflake', nullableSnowflakeCheck(t.threadId)),
    check(
      'archive_messages_reply_to_message_id_snowflake',
      nullableSnowflakeCheck(t.replyToMessageId),
    ),
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
     * **Never carries the whole message.** Bananasaurs keeps no copy of a
     * matched message (ADR 0121 removed the fixture corpus).
     */
    trace: text('trace'),
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
     * `ModerationOutcome` too — and reused `deleted` for a match recorded
     * without acting, where nothing was deleted at all. Both are lies in a table
     * whose entire purpose (ADR 0035) is a durable, truthful record a
     * moderator reads back later.
     *
     * The five `escalation_*`/`deleted*` values below map one-to-one onto
     * `ModerationOutcome`'s five variants, after a real deletion. The
     * `delete_blocked_*` values are the case where enforcement never reached
     * Discord because a safety layer (docs/18) said no; `would_delete` is a
     * match recorded while automod is on Watch (ADR 0121), which is not a
     * deletion and does not pretend to be one; `delete_failed` is a deletion Discord actually refused.
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
     * operator CLI has only the Unix user the invocation claimed (ADR 0024)
     * and writes `cli:<user>`. A snowflake CHECK would make the CLI path
     * impossible to write.
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
    /**
     * The sealed copy of the plaintext password, so the owner can reveal it
     * after re-authenticating (ADR 0070). Never the sign-in authority — that
     * stays `password_hash` above — null when the vault was unavailable at
     * set time or the account is an owner (owner accounts never get one).
     */
    passwordSealed: text('password_sealed'),
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

/** ADR 0126: the channels and categories the assistant may read. */
export const channelReadScope = sqliteTable(
  'channel_read_scope',
  {
    guildId: snowflake('guild_id').notNull(),
    channelId: snowflake('channel_id').notNull(),
    scopeKind: text('scope_kind').notNull().default('channel'),
    addedAt: integer('added_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.channelId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('channel_read_scope_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('channel_read_scope_channel_id_snowflake', snowflakeCheck(t.channelId)),
    check('channel_read_scope_scope_kind', sql`${t.scopeKind} IN ('channel','category')`),
  ],
);

/** ADR 0126: the Read seed's once-only marker (hard rule 6) — the PK makes a second seed impossible. */
export const channelReadSeeds = sqliteTable(
  'channel_read_seeds',
  {
    guildId: snowflake('guild_id').notNull().primaryKey(),
    seededAt: integer('seeded_at').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('channel_read_seeds_guild_id_snowflake', snowflakeCheck(t.guildId)),
  ],
);

/** Owner decision 2026-10-03: the Write seed's once-only marker — same shape and semantics as `channelReadSeeds`. */
export const channelWriteSeeds = sqliteTable(
  'channel_write_seeds',
  {
    guildId: snowflake('guild_id').notNull().primaryKey(),
    seededAt: integer('seeded_at').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('channel_write_seeds_guild_id_snowflake', snowflakeCheck(t.guildId)),
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
 * The ledger for every MCP write (ADR 0116 §2, slice M5 follow-up).
 *
 * Keyed `(guild_id, idempotency_key)` and unique per `(guild_id, action_id)`:
 * a retried key with a matching `args_hash` is a replay, with a differing
 * hash a refusal. `status` is `claimed` between the claim and the single
 * Discord call, `dry_run` for a claim that never calls, and `done`/`failed`
 * once `completeAction` records the outcome. `undo_json` holds the inverse of
 * a reversible action (the bot's own previous content for edits, never the
 * posted content itself); `undone_by_action_id` names the undo action.
 * `cap_group` carries the rolling-hour cap bucket the count reads. Migration
 * 0092 copies every `mcp_sends` row in; `mcp_sends` stays as history that
 * nothing new writes.
 */
export const mcpActions = sqliteTable(
  'mcp_actions',
  {
    guildId: snowflake('guild_id').notNull(),
    actionId: text('action_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    kind: text('kind').notNull(),
    capGroup: text('cap_group').notNull(),
    argsHash: text('args_hash').notNull(),
    status: text('status').notNull(),
    tokenId: text('token_id').notNull(),
    targetChannelId: snowflake('target_channel_id'),
    resultMessageId: snowflake('result_message_id'),
    resultThreadId: snowflake('result_thread_id'),
    undoJson: text('undo_json'),
    undoneByActionId: text('undone_by_action_id'),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => [
    unique('mcp_actions_idempotency_once').on(t.guildId, t.idempotencyKey),
    unique('mcp_actions_action_once').on(t.guildId, t.actionId),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    index('mcp_actions_cap_created').on(t.guildId, t.capGroup, t.createdAt),
    index('mcp_actions_target_created').on(t.guildId, t.targetChannelId, t.createdAt),
    check('mcp_actions_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('mcp_actions_target_channel_id_snowflake', nullableSnowflakeCheck(t.targetChannelId)),
    check('mcp_actions_result_message_id_snowflake', nullableSnowflakeCheck(t.resultMessageId)),
    check('mcp_actions_result_thread_id_snowflake', nullableSnowflakeCheck(t.resultThreadId)),
    check(
      'mcp_actions_cap_group',
      sql`${t.capGroup} IN ('message','edit','member_role','structure','pin_react')`,
    ),
    check('mcp_actions_status', sql`${t.status} IN ('claimed','done','dry_run','failed')`),
  ],
);

/**
 * The per-guild MCP role policy (ADR 0117 §2).
 *
 * One row per guild; absent means both modes are `below-bot`. `grant_mode`
 * and the `grant` allowlist rows are stored now and used by slice 4.
 */
export const mcpRolePolicy = sqliteTable(
  'mcp_role_policy',
  {
    guildId: snowflake('guild_id').notNull(),
    grantMode: text('grant_mode').notNull().default('below-bot'),
    pingMode: text('ping_mode').notNull().default('below-bot'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('mcp_role_policy_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('mcp_role_policy_grant_mode', sql`${t.grantMode} IN ('below-bot','allowlist')`),
    check('mcp_role_policy_ping_mode', sql`${t.pingMode} IN ('below-bot','allowlist')`),
  ],
);

/**
 * The roles the MCP may ping or (slice 4) grant in `allowlist` mode
 * (ADR 0117 §2). A row names one purpose; a role allowed for both has two.
 * The dangerous-permission floor is checked live at the call, never stored.
 */
export const mcpRoleAllowlist = sqliteTable(
  'mcp_role_allowlist',
  {
    guildId: snowflake('guild_id').notNull(),
    roleId: snowflake('role_id').notNull(),
    purpose: text('purpose').notNull(),
    /** The dashboard account that allowed it — an account id, not a snowflake. */
    addedByAccountId: text('added_by_account_id').notNull(),
    addedAt: integer('added_at').notNull(),
  },
  (t) => [
    unique('mcp_role_allowlist_once').on(t.guildId, t.roleId, t.purpose),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('mcp_role_allowlist_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('mcp_role_allowlist_role_id_snowflake', snowflakeCheck(t.roleId)),
    check('mcp_role_allowlist_purpose', sql`${t.purpose} IN ('grant','ping')`),
  ],
);

/**
 * The private threads the MCP created (ADR 0116 §3, ADR 0115 §1).
 *
 * A row here is what makes the thread readable to later MCP reads without
 * the owner being a member. One row per thread per guild, written in the same
 * transaction as the creating action's completion.
 */
export const mcpPrivateThreads = sqliteTable(
  'mcp_private_threads',
  {
    guildId: snowflake('guild_id').notNull(),
    threadId: snowflake('thread_id').notNull(),
    parentChannelId: snowflake('parent_channel_id').notNull(),
    createdActionId: text('created_action_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    unique('mcp_private_threads_once').on(t.guildId, t.threadId),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('mcp_private_threads_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('mcp_private_threads_thread_id_snowflake', snowflakeCheck(t.threadId)),
    check('mcp_private_threads_parent_channel_id_snowflake', snowflakeCheck(t.parentChannelId)),
  ],
);

/**
 * A stored bulk role-change preview (slice 4, task 1).
 *
 * The preview is the durable half of the preview → confirm handshake: the
 * tool resolves the member set live, stores it here, and hands the caller a
 * random 128-bit token. Storage keeps only `token_hash` = sha256 hex of that
 * token — the token itself is never written — and `findPreviewByToken`
 * hashes its input, so a database read answers nothing about any token.
 * `consumePreview` succeeds once, before `expires_at`, and records the
 * `mcp.bulk_role` job that applies the stored member set.
 */
export const mcpBulkPreviews = sqliteTable(
  'mcp_bulk_previews',
  {
    guildId: snowflake('guild_id').notNull(),
    previewId: text('preview_id').notNull(),
    /** sha256 hex of the confirm token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    actionKind: text('action_kind').notNull(),
    roleId: snowflake('role_id').notNull(),
    argsHash: text('args_hash').notNull(),
    /** The previewed member set as a JSON array of snowflakes. */
    memberIdsJson: text('member_ids_json').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    consumedAt: integer('consumed_at'),
    jobId: integer('job_id'),
  },
  (t) => [
    unique('mcp_bulk_previews_preview_once').on(t.guildId, t.previewId),
    unique('mcp_bulk_previews_token_once').on(t.guildId, t.tokenHash),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('mcp_bulk_previews_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('mcp_bulk_previews_role_id_snowflake', snowflakeCheck(t.roleId)),
    check('mcp_bulk_previews_action_kind', sql`${t.actionKind} IN ('add','remove')`),
    check('mcp_bulk_previews_expiry_sane', sql`${t.expiresAt} > ${t.createdAt}`),
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
    /** ADR 0120: which search backend answers — `brave` keeps prior behaviour. */
    searchSource: text('search_source').notNull().default('brave'),
    /** ADR 0075: the GitHub token, sealed like `api_key_enc`. */
    githubTokenEnc: text('github_token_enc'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    check('assistant_provider_config_cost_class', sql`${t.costClass} IN ('free','paid','unknown')`),
    check('assistant_provider_config_search_enabled_bool', boolCheck(t.searchEnabled)),
    check('assistant_provider_config_search_source', sql`${t.searchSource} IN ('brave','tavily')`),
    check(
      'assistant_provider_config_provider',
      sql`${t.provider} IN ('off','gemini','openrouter','nvidia-nim')`,
    ),
    check('assistant_provider_config_enabled_bool', boolCheck(t.enabled)),
  ],
);

// Task 6b (ADR 0075 follow-up, owner request 2026-09-24): several sealed keys
// per provider, each with its own owner-chosen label, so the same provider
// account can appear more than once (e.g. two Gemini keys as a fallback pair)
// and keys from the same account can be told apart in the dashboard.
// Instance-level like the table it replaces (`assistant_providers`); terms
// eligibility stays per *provider*, not per key (hard rule 5).
export const assistantProviderKeys = sqliteTable(
  'assistant_provider_keys',
  {
    keyId: text('key_id').primaryKey(),
    provider: text('provider').notNull(),
    /** Owner-chosen, e.g. "Personal Gemini key". Never a secret itself. */
    label: text('label').notNull(),
    apiKeyEnc: text('api_key_enc').notNull(),
    /** The owner's statement of the key's cost (ADR 0061 §2). */
    costClass: text('cost_class').notNull().default('unknown'),
    enabled: integer('enabled').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    check(
      'assistant_provider_keys_provider',
      sql`${t.provider} IN ('gemini','openrouter','nvidia-nim')`,
    ),
    check('assistant_provider_keys_cost_class', sql`${t.costClass} IN ('free','paid','unknown')`),
    check('assistant_provider_keys_enabled_bool', boolCheck(t.enabled)),
    check('assistant_provider_keys_label_length', sql`length(${t.label}) BETWEEN 1 AND 60`),
  ],
);

// Task 6b: the one ordered model chain, at most 6 entries. Each entry names a
// key plus a model — not a provider directly, so the same model can be
// listed twice under two different keys as a fallback pair. Positions are
// dense from 0. The foreign key keeps a chain entry from naming a key that
// does not exist, and removing a key drops its chain rows with it.
// ADR 0081: each entry carries nullable per-model RPM and RPD limits
// (null = no limit), enforced at reserve time against `assistant_model_calls`.
export const assistantModelChain = sqliteTable(
  'assistant_model_chain',
  {
    position: integer('position').primaryKey(),
    keyId: text('key_id').notNull(),
    model: text('model').notNull(),
    rpmLimit: integer('rpm_limit'),
    rpdLimit: integer('rpd_limit'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.keyId], foreignColumns: [assistantProviderKeys.keyId] }).onDelete(
      'cascade',
    ),
    unique('assistant_model_chain_key_model').on(t.keyId, t.model),
    check('assistant_model_chain_position', sql`${t.position} BETWEEN 0 AND 5`),
  ],
);

// ADR 0080: owner-edited instance settings. One row per setting key; the
// value is JSON typed by the registry in `packages/core`, so this table
// stores it opaquely. Instance-level like the provider keys and model chain.
export const instanceSettings = sqliteTable(
  'instance_settings',
  {
    key: text('key').primaryKey(),
    valueJson: text('value_json').notNull(),
    updatedAt: integer('updated_at').notNull(),
    updatedBy: text('updated_by').notNull(),
  },
  (t) => [check('instance_settings_key_length', sql`length(${t.key}) BETWEEN 1 AND 64`)],
);

// ADR 0081: every provider HTTP call is recorded here (key + model + time,
// plus which guild spent the call), so a chain entry at its RPM/RPD limit
// can be skipped before calling. Instance-scoped because the key is shared;
// rows older than 48 h are pruned on reserve.
export const assistantModelCalls = sqliteTable(
  'assistant_model_calls',
  {
    callId: integer('call_id').primaryKey({ autoIncrement: true }),
    keyId: text('key_id').notNull(),
    model: text('model').notNull(),
    at: integer('at').notNull(),
    guildId: snowflake('guild_id').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.keyId], foreignColumns: [assistantProviderKeys.keyId] }).onDelete(
      'cascade',
    ),
    index('assistant_model_calls_key_model_at').on(t.keyId, t.model, t.at),
    check('assistant_model_calls_guild_id_snowflake', snowflakeCheck(t.guildId)),
  ],
);

// ADR 0120: several sealed search keys per source (brave/tavily), tried in the
// owner's order. Instance-level like the provider keys they sit beside; each
// key carries nullable sliding-window limits (null = no limit), enforced at
// reserve time against `assistantSearchCalls`.
export const assistantSearchKeys = sqliteTable(
  'assistant_search_keys',
  {
    keyId: text('key_id').primaryKey(),
    source: text('source').notNull(),
    /** Owner-chosen label. Never a secret itself. */
    label: text('label').notNull(),
    apiKeyEnc: text('api_key_enc').notNull(),
    enabled: integer('enabled').notNull().default(1),
    /** Owner-set order within one source; dense but not unique (see moveSearchKey). */
    position: integer('position').notNull().default(0),
    monthlyLimit: integer('monthly_limit'),
    dailyLimit: integer('daily_limit'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    check('assistant_search_keys_source', sql`${t.source} IN ('brave','tavily')`),
    check('assistant_search_keys_label_length', sql`length(${t.label}) BETWEEN 1 AND 60`),
    check('assistant_search_keys_enabled_bool', boolCheck(t.enabled)),
    check(
      'assistant_search_keys_monthly_limit',
      sql`${t.monthlyLimit} IS NULL OR ${t.monthlyLimit} BETWEEN 1 AND 1000000`,
    ),
    check(
      'assistant_search_keys_daily_limit',
      sql`${t.dailyLimit} IS NULL OR ${t.dailyLimit} BETWEEN 1 AND 1000000`,
    ),
  ],
);

// ADR 0120: every web-search HTTP call is recorded here (key + time, plus
// which guild spent the call), so a key at its daily/monthly limit is skipped
// before calling. Instance-scoped because the key is shared; `guild_id`
// records who spent the call (hard rule 2, as in `assistantModelCalls`);
// rows older than 32 days are pruned on reserve.
export const assistantSearchCalls = sqliteTable(
  'assistant_search_calls',
  {
    callId: integer('call_id').primaryKey({ autoIncrement: true }),
    keyId: text('key_id').notNull(),
    at: integer('at').notNull(),
    guildId: snowflake('guild_id').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.keyId], foreignColumns: [assistantSearchKeys.keyId] }).onDelete(
      'cascade',
    ),
    index('assistant_search_calls_key_at').on(t.keyId, t.at),
    check('assistant_search_calls_guild_id_snowflake', snowflakeCheck(t.guildId)),
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
    // Task 18: the wizard's structured answers as JSON, so the dashboard can
    // reopen them for editing. Null means hand-written or cleared.
    promptWizardJson: text('prompt_wizard_json'),
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
    // Task 19: auto-delete window in days (61/182/365) or NULL for keep
    // forever. The default (6 months) backfills existing rows on migrate.
    conversationRetentionDays: integer('conversation_retention_days').default(182),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('assistant_settings_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('assistant_settings_log_channel_snowflake', nullableSnowflakeCheck(t.logChannelId)),
    check(
      'assistant_settings_conversation_retention_days',
      sql`(${t.conversationRetentionDays} IS NULL OR ${t.conversationRetentionDays} IN (61,182,365))`,
    ),
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
    // Task 17 (ADR 0073): an auto-discovered repo's org resource id, and the
    // GitHub import details as JSON. Both nullable: every pre-existing row
    // reads back with neither, and clearing either on re-put stores NULL.
    // Deliberately no foreign key on `parentId`: deleting a disabled org must
    // never cascade into the children the owner may have edited, and an
    // edited child keeps its (now dangling) parent id as provenance.
    parentId: text('parent_id'),
    metaJson: text('meta_json'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.resourceId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check(
      'assistant_resources_kind',
      sql`${t.kind} IN ('website','document','discord-channel','repository','note','github-repo','github-org')`,
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
    mentionsJson: text('mentions_json')
      .notNull()
      .default('{"userIds":[],"roleIds":[],"everyone":false,"here":false}'),
    recurrenceJson: text('recurrence_json'),
    context: text('context'),
    deliveredCount: integer('delivered_count').notNull().default(0),
    updatedAt: integer('updated_at'),
    // ADR 0119: scheduled MCP sends are reminder rows with `origin='mcp'`.
    // Pre-0095 rows read back as `assistant` through the column default.
    origin: text('origin').notNull().default('assistant'),
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
    check('assistant_reminders_origin', sql`${t.origin} IN ('assistant','mcp')`),
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
    mode: text('mode'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.skillId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('assistant_skill_grants_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check(
      'assistant_skill_grants_mode',
      sql`${t.mode} IS NULL OR ${t.mode} IN ('everyone','roles','owner')`,
    ),
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

// ADR 0129 §6: one row per assistant invocation, updated in place as the run
// moves. Metadata only — never a member's question or answer; the step log
// lives in `assistant_run_events`. Rows die with their conversation through
// the prune job (and the DELETE route and forgetMember), and orphans with no
// conversation are pruned after 30 days.
export const assistantRuns = sqliteTable(
  'assistant_runs',
  {
    guildId: snowflake('guild_id').notNull(),
    runId: text('run_id').notNull(),
    conversationId: text('conversation_id'),
    traceId: text('trace_id'),
    userId: snowflake('user_id').notNull(),
    channelId: text('channel_id'),
    behaviourId: text('behaviour_id').notNull(),
    source: text('source').notNull(),
    state: text('state').notNull(),
    stage: text('stage').notNull(),
    attempt: integer('attempt').notNull().default(1),
    queuedAt: integer('queued_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    retryAt: integer('retry_at'),
    model: text('model'),
    keyLabel: text('key_label'),
    errorCode: text('error_code'),
    totalTokens: integer('total_tokens'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.runId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('assistant_runs_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('assistant_runs_user_id_snowflake', snowflakeCheck(t.userId)),
    check('assistant_runs_channel_id_snowflake', nullableSnowflakeCheck(t.channelId)),
    check(
      'assistant_runs_state',
      sql`${t.state} IN ('queued','running','retry-wait','answered','refused','failed')`,
    ),
    check(
      'assistant_runs_stage',
      sql`${t.stage} IN ('queued','starting','conversation','context','calling-model','running-tool','retry-wait','delivering','done')`,
    ),
    check(
      'assistant_runs_source',
      sql`${t.source} IN ('mention','slash-command','dashboard-test')`,
    ),
    index('assistant_runs_state').on(t.guildId, t.state, t.updatedAt),
    index('assistant_runs_conversation').on(t.guildId, t.conversationId),
  ],
);

// ADR 0129 §6: the append-only step log of a run (queued, model call, tool
// call, …). Metadata only — timings, token counts, error codes — never
// message text, tool arguments or tool results. Dies with its run through
// the composite foreign key.
export const assistantRunEvents = sqliteTable(
  'assistant_run_events',
  {
    guildId: snowflake('guild_id').notNull(),
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    at: integer('at').notNull(),
    kind: text('kind').notNull(),
    model: text('model'),
    keyId: text('key_id'),
    ok: integer('ok'),
    code: text('code'),
    ms: integer('ms'),
    tokens: integer('tokens'),
    costUsd: real('cost_usd'),
    dataJson: text('data_json').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.runId, t.seq] }),
    foreignKey({
      columns: [t.guildId, t.runId],
      foreignColumns: [assistantRuns.guildId, assistantRuns.runId],
    }).onDelete('cascade'),
    check('assistant_run_events_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('assistant_run_events_ok', sql`${t.ok} IS NULL OR ${t.ok} IN (0,1)`),
    index('assistant_run_events_kind').on(t.guildId, t.kind, t.at),
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
    // The provider or fetch failure code (e.g. a bot challenge), if any.
    // Null when absent or when the fetch succeeded.
    errorCode: text('error_code'),
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

/**
 * A conversation thread (ADR 0072). `conversationId` is app-generated, not a
 * snowflake. `status` starts `open`; `latestForAuthor` (repos/conversations.ts)
 * only ever considers `open` conversations for the follow-up window.
 */
export const assistantConversations = sqliteTable(
  'assistant_conversations',
  {
    guildId: snowflake('guild_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    channelId: snowflake('channel_id').notNull(),
    behaviourId: text('behaviour_id').notNull(),
    startedBy: snowflake('started_by').notNull(),
    title: text('title').notNull(),
    source: text('source').notNull(),
    status: text('status').notNull().default('open'),
    createdAt: integer('created_at').notNull(),
    lastActivityAt: integer('last_activity_at').notNull(),
    turnCount: integer('turn_count').notNull().default(0),
    // ADR 0091 decision 1: the conversation's summary, deleted with the row.
    // `summaryThroughAt` is the `at` of the newest turn the summary covers;
    // the write is compare-and-set on it and bumps `summaryVersion`.
    summaryJson: text('summary_json'),
    summaryThroughAt: integer('summary_through_at'),
    summaryVersion: integer('summary_version').notNull().default(0),
    summaryUpdatedAt: integer('summary_updated_at'),
    // ADR 0093 decision 1: the rendered summary text, indexed by FTS5
    // (`drizzle/0052_conversation_summary_search.sql`). Set in the same
    // UPDATE that writes `summary_json`.
    summaryText: text('summary_text'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.conversationId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('assistant_conversations_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('assistant_conversations_channel_id_snowflake', snowflakeCheck(t.channelId)),
    check('assistant_conversations_started_by_snowflake', snowflakeCheck(t.startedBy)),
    check('assistant_conversations_source', sql`${t.source} IN ('discord','dashboard-test')`),
    check('assistant_conversations_status', sql`${t.status} IN ('open','ended')`),
    index('assistant_conversations_activity').on(t.guildId, t.lastActivityAt),
    index('assistant_conversations_author').on(
      t.guildId,
      t.channelId,
      t.startedBy,
      t.lastActivityAt,
    ),
  ],
);

/**
 * One turn of a conversation. `authorId` is null for an `assistant` turn, and
 * holds the *quoted* message's author for a `quote` turn — which may or may
 * not be the member who started the conversation. `feedback` is set from a
 * dashboard reaction on the linked message (`setFeedback`), never inferred.
 */
export const assistantConversationTurns = sqliteTable(
  'assistant_conversation_turns',
  {
    guildId: snowflake('guild_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    turnId: text('turn_id').notNull(),
    at: integer('at').notNull(),
    role: text('role').notNull(),
    authorId: snowflake('author_id'),
    authorName: text('author_name').notNull(),
    text: text('text').notNull(),
    traceId: text('trace_id'),
    feedback: text('feedback'),
    joinRule: text('join_rule'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.turnId] }),
    foreignKey({
      columns: [t.guildId, t.conversationId],
      foreignColumns: [assistantConversations.guildId, assistantConversations.conversationId],
    }).onDelete('cascade'),
    check('assistant_conversation_turns_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('assistant_conversation_turns_author_id_snowflake', nullableSnowflakeCheck(t.authorId)),
    check('assistant_conversation_turns_role', sql`${t.role} IN ('user','assistant','quote')`),
    check(
      'assistant_conversation_turns_feedback',
      sql`(${t.feedback} IS NULL OR ${t.feedback} IN ('up','down'))`,
    ),
    check(
      'assistant_conversation_turns_join_rule',
      sql`(${t.joinRule} IS NULL OR ${t.joinRule} IN ('reply-to-bot','reply-to-turn','follow-up','thread','channel-follow-up','quoted-reply','reply-to-unknown-bot-message','new-topic','fresh'))`,
    ),
    index('assistant_conversation_turns_conversation').on(t.guildId, t.conversationId, t.at),
  ],
);

/**
 * Which conversation turn a real Discord message belongs to — how
 * `lookupMessage` answers "is this message known". Only `user` and
 * `assistant` turns are linked here; a `quote` turn's source message is
 * someone else's and is never registered as ours to continue (see
 * `KnownMessage` in `@bananasaurs/core`).
 */
export const assistantConversationMessages = sqliteTable(
  'assistant_conversation_messages',
  {
    guildId: snowflake('guild_id').notNull(),
    messageId: snowflake('message_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    turnId: text('turn_id').notNull(),
    role: text('role').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.messageId] }),
    foreignKey({
      columns: [t.guildId, t.conversationId],
      foreignColumns: [assistantConversations.guildId, assistantConversations.conversationId],
    }).onDelete('cascade'),
    check('assistant_conversation_messages_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('assistant_conversation_messages_message_id_snowflake', snowflakeCheck(t.messageId)),
    check('assistant_conversation_messages_role', sql`${t.role} IN ('user','assistant')`),
  ],
);

export const assistantConversationLinks = sqliteTable(
  'assistant_conversation_links',
  {
    guildId: snowflake('guild_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    linkedConversationId: text('linked_conversation_id').notNull(),
    kind: text('kind').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.conversationId, t.linkedConversationId, t.kind] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    foreignKey({
      columns: [t.guildId, t.conversationId],
      foreignColumns: [assistantConversations.guildId, assistantConversations.conversationId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.guildId, t.linkedConversationId],
      foreignColumns: [assistantConversations.guildId, assistantConversations.conversationId],
    }).onDelete('cascade'),
    check('assistant_conversation_links_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check(
      'assistant_conversation_links_not_self',
      sql`${t.conversationId} <> ${t.linkedConversationId}`,
    ),
    check(
      'assistant_conversation_links_kind',
      sql`${t.kind} IN ('same-channel','thread-parent','recalled')`,
    ),
    index('assistant_conversation_links_linked').on(t.guildId, t.linkedConversationId),
  ],
);

// Task tracking. Every parent/child relation carries the guild partition.
export const taskTeams = sqliteTable(
  'task_teams',
  {
    guildId: snowflake('guild_id').notNull(),
    teamId: text('team_id').notNull(),
    name: text('name').notNull(),
    categoryId: snowflake('category_id').notNull(),
    announcementChannelId: snowflake('announcement_channel_id'),
    leadRoleId: snowflake('lead_role_id'),
    memberRoleId: snowflake('member_role_id'),
    kind: text('kind').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.teamId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    unique('task_teams_category_once').on(t.guildId, t.categoryId),
    check('task_teams_kind', sql`${t.kind} IN ('subteam','exec')`),
    check('task_teams_guild_snowflake', snowflakeCheck(t.guildId)),
    check('task_teams_category_snowflake', snowflakeCheck(t.categoryId)),
    check('task_teams_announcement_snowflake', nullableSnowflakeCheck(t.announcementChannelId)),
    check('task_teams_lead_role_snowflake', nullableSnowflakeCheck(t.leadRoleId)),
    check('task_teams_member_role_snowflake', nullableSnowflakeCheck(t.memberRoleId)),
  ],
);

export const clubTasks = sqliteTable(
  'club_tasks',
  {
    guildId: snowflake('guild_id').notNull(),
    taskId: text('task_id').notNull(),
    teamId: text('team_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').notNull().default('not_started'),
    priority: text('priority').notNull().default('normal'),
    assignmentKind: text('assignment_kind').notNull(),
    assigneeId: snowflake('assignee_id'),
    dueAt: integer('due_at').notNull(),
    timezone: text('timezone').notNull(),
    destinationId: snowflake('destination_id').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    version: integer('version').notNull().default(1),
    archivedAt: integer('archived_at'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.taskId] }),
    foreignKey({
      columns: [t.guildId, t.teamId],
      foreignColumns: [taskTeams.guildId, taskTeams.teamId],
    }).onDelete('restrict'),
    check('club_tasks_guild_snowflake', snowflakeCheck(t.guildId)),
    check('club_tasks_destination_snowflake', snowflakeCheck(t.destinationId)),
    check('club_tasks_assignee_snowflake', nullableSnowflakeCheck(t.assigneeId)),
    check(
      'club_tasks_status',
      sql`${t.status} IN ('not_started','in_progress','awaiting_approval','done')`,
    ),
    check('club_tasks_priority', sql`${t.priority} IN ('normal','urgent')`),
    check('club_tasks_assignment', sql`${t.assignmentKind} IN ('team','individual')`),
    check(
      'club_tasks_assignment_id',
      sql`(${t.assignmentKind} = 'team' AND ${t.assigneeId} IS NULL) OR (${t.assignmentKind} = 'individual' AND ${t.assigneeId} IS NOT NULL)`,
    ),
    check('club_tasks_version_positive', sql`${t.version} > 0`),
  ],
);

/** All named members for an individual task. Kept alongside the legacy
 * assignee_id primary during staged migration. */
export const taskAssignees = sqliteTable(
  'task_assignees',
  {
    guildId: snowflake('guild_id').notNull(),
    taskId: text('task_id').notNull(),
    discordUserId: snowflake('discord_user_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.taskId, t.discordUserId] }),
    foreignKey({
      columns: [t.guildId, t.taskId],
      foreignColumns: [clubTasks.guildId, clubTasks.taskId],
    }).onDelete('cascade'),
    check('task_assignees_guild_snowflake', snowflakeCheck(t.guildId)),
    check('task_assignees_user_snowflake', snowflakeCheck(t.discordUserId)),
  ],
);

/** Task-specific posted message, not merely the shared destination. A reply to
 * this anchor can identify the task without reading model text. */
export const taskMessageAnchors = sqliteTable(
  'task_message_anchors',
  {
    guildId: snowflake('guild_id').notNull(),
    taskId: text('task_id').notNull(),
    channelId: snowflake('channel_id').notNull(),
    messageId: snowflake('message_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.taskId] }),
    foreignKey({
      columns: [t.guildId, t.taskId],
      foreignColumns: [clubTasks.guildId, clubTasks.taskId],
    }).onDelete('cascade'),
    unique('task_anchor_message_once').on(t.guildId, t.messageId),
    check('task_anchor_guild_snowflake', snowflakeCheck(t.guildId)),
    check('task_anchor_channel_snowflake', snowflakeCheck(t.channelId)),
    check('task_anchor_message_snowflake', snowflakeCheck(t.messageId)),
  ],
);

export const taskChildren = sqliteTable(
  'task_children',
  {
    guildId: snowflake('guild_id').notNull(),
    taskId: text('task_id').notNull(),
    childId: text('child_id').notNull(),
    title: text('title').notNull(),
    dueAt: integer('due_at').notNull(),
    status: text('status').notNull().default('not_started'),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.taskId, t.childId] }),
    foreignKey({
      columns: [t.guildId, t.taskId],
      foreignColumns: [clubTasks.guildId, clubTasks.taskId],
    }).onDelete('cascade'),
    check('task_children_guild_snowflake', snowflakeCheck(t.guildId)),
    check('task_children_status', sql`${t.status} IN ('not_started','in_progress','done')`),
  ],
);

export const taskReports = sqliteTable(
  'task_reports',
  {
    guildId: snowflake('guild_id').notNull(),
    taskId: text('task_id').notNull(),
    reportId: text('report_id').notNull(),
    authorId: text('author_id').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.taskId, t.reportId] }),
    foreignKey({
      columns: [t.guildId, t.taskId],
      foreignColumns: [clubTasks.guildId, clubTasks.taskId],
    }).onDelete('cascade'),
    check('task_reports_guild_snowflake', snowflakeCheck(t.guildId)),
  ],
);

export const taskTeamMembers = sqliteTable(
  'task_team_members',
  {
    guildId: snowflake('guild_id').notNull(),
    teamId: text('team_id').notNull(),
    discordUserId: snowflake('discord_user_id').notNull(),
    kind: text('kind').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.teamId, t.discordUserId] }),
    foreignKey({
      columns: [t.guildId, t.teamId],
      foreignColumns: [taskTeams.guildId, taskTeams.teamId],
    }).onDelete('cascade'),
    check('task_member_guild_snowflake', snowflakeCheck(t.guildId)),
    check('task_member_user_snowflake', snowflakeCheck(t.discordUserId)),
    check('task_member_kind', sql`${t.kind} IN ('member','lead')`),
  ],
);

/** A role name is never authority; the owner pins the current Discord role ID per guild. */
export const taskGuildRoles = sqliteTable(
  'task_guild_roles',
  {
    guildId: snowflake('guild_id').notNull(),
    presidentRoleId: snowflake('president_role_id').notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('task_guild_roles_guild_snowflake', snowflakeCheck(t.guildId)),
    check('task_guild_roles_president_snowflake', snowflakeCheck(t.presidentRoleId)),
  ],
);

/** Guild quiet hours (ADR 0109). No row means midnight-8am Pacific applies. */
export const taskQuietHours = sqliteTable(
  'task_quiet_hours',
  {
    guildId: snowflake('guild_id').notNull(),
    /** Minutes after midnight, local to `timezone`; start may exceed end (overnight). */
    startMinute: integer('start_minute').notNull(),
    endMinute: integer('end_minute').notNull(),
    timezone: text('timezone').notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('task_quiet_guild_snowflake', snowflakeCheck(t.guildId)),
    check('task_quiet_start', sql`${t.startMinute} BETWEEN 0 AND 1439`),
    check('task_quiet_end', sql`${t.endMinute} BETWEEN 0 AND 1439`),
    check('task_quiet_distinct', sql`${t.startMinute} <> ${t.endMinute}`),
  ],
);

/** Task nudges are immutable slots; changing a due date supersedes the old slot. */
export const taskNudgeSlots = sqliteTable(
  'task_nudge_slots',
  {
    guildId: snowflake('guild_id').notNull(),
    slotId: text('slot_id').notNull(),
    taskId: text('task_id'),
    teamId: text('team_id'),
    kind: text('kind').notNull(),
    dueAt: integer('due_at').notNull(),
    state: text('state').notNull().default('pending'),
    destinationId: snowflake('destination_id'),
    messageId: snowflake('message_id'),
    payload: text('payload'),
    lastError: text('last_error'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.slotId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('task_nudge_slot_guild', snowflakeCheck(t.guildId)),
    check('task_nudge_slot_destination', nullableSnowflakeCheck(t.destinationId)),
    check('task_nudge_slot_message', nullableSnowflakeCheck(t.messageId)),
    check(
      'task_nudge_slot_kind',
      sql`${t.kind} IN ('pre_due','custom','checkin','digest','followup','announce','review','clarify','evaluate')`,
    ),
    check(
      'task_nudge_slot_state',
      sql`${t.state} IN ('pending','paused','claimed','sent','failed','superseded','planned')`,
    ),
    index('task_nudge_due').on(t.guildId, t.state, t.dueAt),
    index('task_nudge_message').on(t.guildId, t.messageId),
  ],
);

/** Every attempted nudge, including planning-mode and refused sends, is recorded. */
export const taskNudgeDeliveries = sqliteTable(
  'task_nudge_deliveries',
  {
    guildId: snowflake('guild_id').notNull(),
    slotId: text('slot_id').notNull(),
    outcome: text('outcome').notNull(),
    destinationId: snowflake('destination_id'),
    messageId: snowflake('message_id'),
    attemptedAt: integer('attempted_at').notNull(),
    detail: text('detail'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.slotId] }),
    foreignKey({
      columns: [t.guildId, t.slotId],
      foreignColumns: [taskNudgeSlots.guildId, taskNudgeSlots.slotId],
    }).onDelete('cascade'),
    check('task_nudge_delivery_guild', snowflakeCheck(t.guildId)),
    check('task_nudge_delivery_destination', nullableSnowflakeCheck(t.destinationId)),
    check('task_nudge_delivery_message', nullableSnowflakeCheck(t.messageId)),
  ],
);

/** Which open tasks a sent weekly check-in listed, so a reply can be attributed. */
export const taskNudgeSlotTasks = sqliteTable(
  'task_nudge_slot_tasks',
  {
    guildId: snowflake('guild_id').notNull(),
    slotId: text('slot_id').notNull(),
    taskId: text('task_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.slotId, t.taskId] }),
    foreignKey({
      columns: [t.guildId, t.slotId],
      foreignColumns: [taskNudgeSlots.guildId, taskNudgeSlots.slotId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.guildId, t.taskId],
      foreignColumns: [clubTasks.guildId, clubTasks.taskId],
    }).onDelete('cascade'),
    check('task_nudge_slot_task_guild', snowflakeCheck(t.guildId)),
  ],
);

/** A progress reply that matched several tasks, held until its author picks one. */
export const taskReplyChoices = sqliteTable(
  'task_reply_choices',
  {
    guildId: snowflake('guild_id').notNull(),
    messageId: snowflake('message_id').notNull(),
    authorId: snowflake('author_id').notNull(),
    channelId: snowflake('channel_id').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.messageId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('task_reply_choice_guild', snowflakeCheck(t.guildId)),
    check('task_reply_choice_message', snowflakeCheck(t.messageId)),
    check('task_reply_choice_author', snowflakeCheck(t.authorId)),
    check('task_reply_choice_channel', snowflakeCheck(t.channelId)),
    index('task_reply_choice_created').on(t.guildId, t.createdAt),
  ],
);
