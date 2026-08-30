import type { JsonValue } from './protocol.js';
import type { OpsSettingChange } from './settings.js';
/**
 * Everything the operator commands can reach.
 *
 * Two interfaces, split by whether the thing is guild-scoped:
 *
 * - `OpsPorts` — guild-scoped. Every member is supplied by the composition root
 *   as a closure over one `GuildScope`, so there is no parameter through which
 *   a command could name a different guild (`CLAUDE.md` rule 2). The split is
 *   the point: "does every query take a guild id" is answered by *which
 *   interface it is on*, not by reading each signature.
 * - `OpsInstance` — process-level. Uptime, the gateway connection, the
 *   configured mode. None of it is a query against guild data.
 *
 * Both grow one slice at a time, like `PanelStore` and `LoggingPorts` before
 * them.
 */

/**
 * One row for `audit_events`, as the operator surface writes it.
 *
 * `actorId` is absent by construction rather than optional-in-practice: the CLI
 * has no verified identity to put there (ADR 0024), and laundering the claimed
 * Unix name into the column every other actor type fills with a *verified*
 * identity is exactly the mistake amendment 2 exists to prevent. The claim goes
 * in `actorUnixUserClaimed`, whose name carries the caveat.
 */
export interface OpsAuditWrite {
  readonly at: number;
  readonly actorType: 'operator_cli';
  readonly actorId: undefined;
  readonly actorUnixUserClaimed: string | undefined;
  /**
   * `ssh`, per `docs/19` §6.9 — the column's vocabulary is
   * `'ssh' | 'http' | 'gateway'` and predates the distinction between an
   * operator on the box and one over SSH. It means "came in on the operator
   * socket"; `http` is the dashboard and `gateway` is Discord.
   */
  readonly via: 'ssh';
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | undefined;
  readonly before: JsonValue | undefined;
  readonly after: JsonValue | undefined;
  readonly dryRun: boolean;
}

/** One row of the audit trail, as `audit tail` renders it. */
export interface OpsAuditRow {
  readonly auditId: number;
  readonly at: number;
  readonly actorType: string;
  readonly actorId: string | null;
  /** A claim, never a verified identity (amendment 2). Rendered as claimed. */
  readonly actorUnixUserClaimed: string | null;
  readonly via: string | null;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly batchId: string | null;
  readonly dryRun: boolean;
  /** Attribution that came from the Discord audit log rather than the event. */
  readonly inferred: boolean;
}

export interface OpsAuditQuery {
  readonly limit: number;
  /** An absolute timestamp; `--since 2h` is turned into one by the command. */
  readonly sinceMs: number | undefined;
}

/** One job, as `jobs list` renders it. */
export interface OpsJobRow {
  readonly jobId: number;
  readonly kind: string;
  readonly state: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAfter: number;
  readonly lastError: string | null;
  readonly dedupeKey: string;
}

export interface OpsJobQuery {
  readonly failedOnly: boolean;
  readonly limit: number;
}

/** A panel, flattened for listing. `panel show` returns the full config. */
export interface OpsPanelSummary {
  readonly panelId: string;
  readonly kind: string;
  readonly component: string;
  readonly behaviour: string;
  readonly status: string;
  readonly messageId: string | undefined;
  readonly optionCount: number;
}

export interface OpsPanelDetail extends OpsPanelSummary {
  readonly channelId: string;
  readonly maxRoles: number | undefined;
  readonly requiredRoleId: string | undefined;
  readonly blockedRoleIds: readonly string[];
  readonly adoptionPassState: string;
  readonly adoptionBlockedCount: number;
  readonly options: readonly {
    readonly optionId: string;
    readonly roleId: string;
    /** Set on a reaction panel; absent on buttons and select menus. */
    readonly emojiKey: string | undefined;
    /** Set on buttons and select menus; Discord will not render without it. */
    readonly label: string | undefined;
  }[];
}

/** A managed role a live check found unassignable, and why. */
export interface OpsUnassignableRole {
  readonly roleId: string;
  /** `above_bot` | `managed` | `deleted`, or null if none was recorded. */
  readonly reason: string | null;
}

export interface OpsLogRoute {
  readonly eventKind: string;
  readonly channelId: string;
  readonly enabled: boolean;
  readonly includeContent: boolean;
}

/** The guild's row in `guilds`, as the effect gateway reads it. */
export interface OpsSafetyState {
  readonly killswitch: boolean;
  readonly dryRun: boolean;
  readonly breakerOpen: boolean;
  readonly breakerReason: string | null;
  readonly roleRatePerMin: number;
  readonly reconcileBudget: number;
  readonly breakerThreshold: number;
}

export interface OpsPorts {
  /** The guild's display name, or `undefined` before the first `GUILD_CREATE`. */
  guildName(): string | undefined;
  /** `undefined` when the guild has no row at all, which is itself a finding. */
  safetyState(): OpsSafetyState | undefined;
  /** Jobs by state: `queued`, `running`, `done`, `failed`, `cancelled`. */
  jobCounts(): Readonly<Record<string, number>>;
  /**
   * The `run_after` of the oldest queued job already due, or `undefined` when
   * nothing is overdue.
   *
   * This is what makes "scheduler lag" a number rather than a vibe: `now` minus
   * this is how far behind the worker actually is. A queued job scheduled for
   * the future is not lag, so the query filters on due-ness rather than
   * reporting the oldest queued row.
   */
  oldestDueJobAtMs(nowMs: number): number | undefined;
  /**
   * Writes one `audit_events` row.
   *
   * Called by the dispatcher, not by the command, so "every write is audited"
   * is a property of the machinery rather than of each handler remembering.
   */
  recordAudit(input: OpsAuditWrite): void;
  /** `guilds.killswitch`, layer 2 of the effect gateway's twelve. */
  setKillswitch(on: boolean): void;

  // --- read commands (13c) ---------------------------------------------------
  tailAudit(query: OpsAuditQuery): readonly OpsAuditRow[];
  listJobs(query: OpsJobQuery): readonly OpsJobRow[];
  listPanels(): readonly OpsPanelSummary[];
  findPanel(panelId: string): OpsPanelDetail | undefined;
  listUnassignableRoles(): readonly OpsUnassignableRole[];
  listRoutes(): readonly OpsLogRoute[];
  listExcludedChannels(): readonly string[];
  /** One job by id, for the `before` half of `jobs retry`'s audit row. */
  findJob(jobId: number): OpsJobRow | undefined;

  // --- write commands (13d) --------------------------------------------------
  /**
   * Applies one validated setting change (ADR 0025).
   *
   * One port rather than five, and a discriminated union rather than a
   * `(key, value)` pair: the composition root switches on `key`, the value
   * narrows without a cast, and a setting added to `OPS_SETTINGS` with no
   * branch here fails to compile rather than failing at runtime.
   */
  applySetting(change: OpsSettingChange): void;
  /** Points an event kind at a channel, creating or re-pointing the route. */
  setRoute(input: { eventKind: string; channelId: string; includeContent: boolean }): void;
  /** Returns whether there was a route to change. False is a real answer. */
  setRouteEnabled(eventKind: string, enabled: boolean): boolean;
  /** Returns whether the exclusion is new. */
  excludeChannel(channelId: string): boolean;
  /** Returns whether there was an exclusion to remove. */
  unexcludeChannel(channelId: string): boolean;
  retryJob(jobId: number): OpsRetryOutcome;

  // --- write commands that reach Discord (13e, ADR 0026) ---------------------
  /**
   * Posts or edits a managed panel's message and re-seeds its reactions.
   *
   * The **bounded** half of `panel sync`: one message and at most twenty
   * reactions, none of it through the role rate cap. The unbounded half — the
   * reconciliation pass — is a job, because a 250-reactor panel takes twelve
   * minutes at the default cap and the CLI gives up after thirty seconds.
   */
  publishPanel(panelId: string): Promise<OpsPublishResult>;
  /** Queues the reconciliation half. Absent `panelId` would mean every panel. */
  enqueueReconcile(panelId: string): OpsEnqueued;
  /** The batch row, so `undo` can refuse one that does not exist or is done. */
  findBatch(batchId: string): OpsBatchRow | undefined;
  /**
   * How much of a batch can actually be reversed, without reversing it.
   *
   * `hadRoleBefore` is what makes this answerable: an effect that granted a
   * role the member already had changed nothing, and reversing it would strip
   * a role that was never ours to strip.
   */
  countUndoable(batchId: string): OpsUndoableCount;
  enqueueUndo(input: { batchId: string; reason: string }): OpsEnqueued;
  /**
   * Grants an adoption allowance on the **live process's** rate limiter.
   *
   * In-memory and per-process, which is the whole reason ADR 0013 puts the CLI
   * on a socket rather than letting it open the database: a CLI that wrote
   * SQLite could not reach this at all. Lost on restart, and the command says
   * so rather than leaving it to be discovered.
   */
  grantAdoptionAllowance(count: number): void;
  /** Unconsumed approved actions, before and after a grant. */
  adoptionAllowance(): number;
}

/** A job this command queued, or the one already pending that absorbed it. */
export interface OpsEnqueued {
  readonly enqueued: boolean;
  readonly jobId: number | undefined;
}

/** One row of `effect_batches`, as `undo` reads it. */
export interface OpsBatchRow {
  readonly batchId: string;
  readonly source: string;
  readonly actorType: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly undoneAt: number | null;
}

export interface OpsUndoableCount {
  readonly total: number;
  /** Effects that actually landed and changed something, so have an inverse. */
  readonly reversible: number;
}

export interface OpsPublishResult {
  /** `posted`, `edited`, or `not-managed` for an adopted panel we cannot edit. */
  readonly action: 'posted' | 'edited' | 'not-managed';
  readonly messageId: string | undefined;
  readonly reactionsSeeded: number;
  /** Emoji Discord refused, usually a custom emoji from a guild we have left. */
  readonly reactionsFailed: readonly { emojiKey: string; error: string }[];
}

/**
 * What `jobs retry` did, or why it did not.
 *
 * Mirrors `jobRepo.retryJob`'s union across the port boundary rather than
 * flattening it to a boolean, because the three refusals ask the operator for
 * three different things: a different id, patience, or nothing at all.
 */
export type OpsRetryOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not-found' }
  | { readonly ok: false; readonly reason: 'not-failed'; readonly state: string }
  | { readonly ok: false; readonly reason: 'dedupe-blocked'; readonly blockingJobId: number };

/** Whether the gateway is connected, as the daemon's client reports it. */
export interface OpsGatewayState {
  readonly connected: boolean;
  /** Websocket heartbeat round-trip in ms, or `undefined` before the first beat. */
  readonly pingMs: number | undefined;
  /** Guilds the client is actually in, which is not the allowlist. */
  readonly guildCount: number;
}

/** `doctor`'s gateway half, already rendered by the daemon that owns the client. */
export interface OpsDoctorReport {
  readonly ok: boolean;
  readonly text: string;
  readonly data: JsonValue;
}

export interface OpsInstance {
  /** `Date.now()` at process start, for uptime. */
  readonly startedAtMs: number;
  /** `BANANASAURS_READONLY`. Reported, so an operator is never puzzled by a refusal. */
  readonly readonly: boolean;
  readonly env: string;
  gateway(): OpsGatewayState;
  /**
   * Intents, partials, permissions and hierarchy — the half of `doctor` that
   * needs the discord.js client, which lives in `apps/daemon` and cannot be
   * reached from here (ADR 0014). The guild-scoped half is on `OpsPorts`.
   */
  doctor(): OpsDoctorReport;
  /**
   * The configuration with every secret already replaced by `<redacted>`.
   *
   * **Redacted before the command sees it**, not by the command. `config get`
   * therefore has no branch that could forget and no flag that could override
   * (ADR 0013 §4). The real value is not reachable from `core` at all.
   */
  redactedConfig(): Readonly<Record<string, JsonValue>>;
}
