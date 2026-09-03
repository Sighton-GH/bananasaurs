import type { AutomodRule, FixtureRecord } from '../automod/predicates/types.js';
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
 * One row for `audit_events`, as the operator surface and the dashboard API
 * both write it.
 *
 * `actorId` is `undefined` for `operator_cli` and filled for `dashboard`, and
 * that asymmetry is deliberate rather than an inconsistency (ADR 0031). The CLI
 * has no verified identity to put there (ADR 0024 amendment 2) — laundering the
 * claimed Unix name into the column every other actor type fills with a
 * *verified* identity would make the trail read as stronger evidence than it
 * is, so the claim goes in `actorUnixUserClaimed` instead, whose name carries
 * the caveat. A dashboard session's `accountId` is the reverse: it is the
 * primary key of a row the server created after verifying an Argon2id hash, so
 * it *is* a verified identity and belongs in `actorId`. `actorUnixUserClaimed`
 * stays `undefined` for a dashboard row — there is no Unix user in an HTTP
 * request, and inventing one would be the exact mistake amendment 2 prevents.
 */
export interface OpsAuditWrite {
  readonly at: number;
  readonly actorType: 'operator_cli' | 'dashboard';
  readonly actorId: string | undefined;
  readonly actorUnixUserClaimed: string | undefined;
  /**
   * `docs/19` §6.9 — the column's vocabulary is `'ssh' | 'http' | 'gateway'`.
   * `ssh` means "came in on the operator socket", `http` means the dashboard
   * API (ADR 0031), and `gateway` means Discord.
   */
  readonly via: 'ssh' | 'http';
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

/**
 * One (rule, channel) pair where an enforce-mode `keyword_filter` rule
 * applies but a live check found the bot without `Manage Messages` there.
 *
 * An enforce-mode rule that cannot delete is not a rule quietly doing less —
 * it is a rule doing nothing at all while its mode says otherwise, the same
 * failure `docs/SESSION_LOG.md`'s "a panel with a deleted message says so"
 * precedent exists for (`docs/superpowers/specs/2026-08-30-automod-rule-
 * engine-design.md` §6).
 */
export interface OpsKeywordFilterChannelMissingManageMessages {
  readonly ruleId: string;
  readonly channelId: string;
}

/**
 * An enabled rule the subscriber cannot compile, and therefore one that
 * silently never matches (ADR 0040 §4).
 *
 * Distinct from `listKeywordFilterRulesMissingManageMessages`, which is about
 * a rule that matches correctly and then cannot act. This is a rule that never
 * gets as far as matching.
 */
export interface OpsUnusableAutomodRule {
  readonly ruleId: string;
  readonly kind: string;
  /** `CompileFailure` widened to a string, so `ops` need not import the registry's union. */
  readonly reason: string;
  readonly detail: string;
}

/**
 * One row of the review queue (ADR 0041 §5, §7): a recorded match nobody has
 * ruled on yet, with the evidence `automod review` renders.
 *
 * `actionTaken` is a plain `string`, not storage's `ModCaseActionTaken`
 * union — `ports.ts` may not import `@bananasaurs/storage` (ADR 0014), the
 * same reason `OpsUnusableAutomodRule.reason` widens `CompileFailure` to a
 * string above.
 */
export interface OpsReviewableMatch {
  readonly eventId: string;
  readonly ruleId: string;
  readonly memberId: string;
  readonly at: number;
  readonly matchedCategory: string;
  readonly matchedSnippet: string;
  readonly actionTaken: string;
  /** Raw JSON; `undefined` should not occur given `listUnreviewedMatches`'s own filter, but is not trusted not to. */
  readonly trace: string | undefined;
  /** `undefined` once a member's `/forgetme` has removed the fixture. Never the matched snippet standing in for the whole message. */
  readonly fixtureContent: string | undefined;
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
  /**
   * Every (rule, channel) pair where an enabled, enforce-mode `keyword_filter`
   * rule applies and a live check found the bot without `Manage Messages`.
   */
  listKeywordFilterRulesMissingManageMessages(): readonly OpsKeywordFilterChannelMissingManageMessages[];
  /** Every enabled rule `compileRule` cannot compile, and why. */
  listUnusableAutomodRules(): readonly OpsUnusableAutomodRule[];
  listRoutes(): readonly OpsLogRoute[];
  listExcludedChannels(): readonly string[];
  /** One job by id, for the `before` half of `jobs retry`'s audit row. */
  findJob(jobId: number): OpsJobRow | undefined;
  /**
   * One **enabled** rule by id, hydrated exactly the way the subscriber sees
   * it — `undefined` for a rule that is disabled, as well as for one that
   * does not exist.
   *
   * Enabled-only is the honest thing to dry-run: a disabled rule will not
   * match a message in production either, so replaying it would answer a
   * question nobody asked and report a match count for a rule that cannot
   * produce one. If replaying a disabled rule is ever wanted, it needs a
   * repository function that says so, not a widening of this one.
   *
   * (This comment previously claimed "enabled or disabled", which the wiring
   * never did — `listEnabledRules(...).find(...)`. Corrected after Task 8's
   * review; the contradiction came from the plan, which stated both.)
   */
  findAutomodRule(ruleId: string): AutomodRule | undefined;
  /**
   * The review corpus, oldest first.
   *
   * The whole corpus, not a page: a dry run's numbers are only meaningful
   * over the whole thing, and a truncated replay would report a
   * false-positive count for a subset while looking like one for the corpus.
   * At club volume this is a few thousand rows.
   */
  listAutomodFixtures(filter: {
    readonly source?: 'observed' | 'handwritten';
  }): readonly FixtureRecord[];
  /**
   * Matches nobody has ruled on yet, oldest first (ADR 0041 §5, §7) — the
   * CLI review queue `automod review` renders.
   */
  listUnreviewedMatches(query: {
    readonly ruleId?: string;
    readonly limit: number;
  }): readonly OpsReviewableMatch[];

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
  /**
   * Records a human's verdict on one recorded match (ADR 0041 §5, §7,
   * plan ruling PR-9). `'no-such-event'` is a usage answer, not a fault: an
   * operator typing an event id at a terminal will mistype one.
   */
  recordMatchVerdict(input: {
    readonly eventId: string;
    readonly verdict: 'false_positive' | 'true_positive' | 'unclear';
    readonly reviewedBy: string;
    readonly note?: string;
  }):
    /**
     * `'recorded-with-label-conflict'` is a success, not a failure: the verdict
     * is stored either way. It says the *fixture* this match came from could not
     * be labelled, because another rule's verdict on the same message implies
     * the opposite label and a fixture's label has no rule dimension. The
     * reviewer needs to be told, because from their side nothing looks
     * different — they ruled on one match and the regression corpus quietly
     * gained nothing. See `recordVerdict` in
     * `packages/storage/src/repos/mod-match-reviews.ts` for the full reasoning.
     */
    'recorded' | 'recorded-with-label-conflict' | 'no-such-event';
  /**
   * Adds one code to `ruleId`'s invite allowlist (ADR 0040 §3, plan ruling
   * PR-19). `'already-present'` is a real answer, not a refusal: the
   * repository's `onConflictDoNothing` makes a repeated add a no-op, and
   * telling the operator "that code was already allowed" beats both silence
   * and a fault. `'no-such-rule'` is a usage answer for an operator who
   * mistyped a rule id — the composite foreign key would otherwise surface an
   * opaque `FOREIGN KEY constraint failed`. `'wrong-kind'` (IMPORTANT-7) is
   * the same usage-answer treatment for a rule id that exists but is not an
   * `invite` rule: `ruleExists` alone cannot tell a typo'd-but-real rule id
   * from the operator's intended one, and writing the row anyway would be a
   * write nothing will ever read.
   */
  addInviteAllowlistEntry(input: {
    readonly ruleId: string;
    readonly code: string;
    readonly label: string;
  }): 'added' | 'already-present' | 'no-such-rule' | 'wrong-kind';
  /** `ruleId`'s invite allowlist, ordered by code — for printing after a write. */
  listInviteAllowlist(ruleId: string): readonly { readonly code: string; readonly label: string }[];
  /**
   * Removes one code from `ruleId`'s invite allowlist. `'not-present'` is a
   * real answer, the same shape `unexcludeChannel`'s boolean already uses for
   * "nothing to remove is not a fault". `'wrong-kind'` is the same guard
   * `addInviteAllowlistEntry` carries, for the same reason.
   */
  removeInviteAllowlistEntry(input: {
    readonly ruleId: string;
    readonly code: string;
  }): 'removed' | 'not-present' | 'no-such-rule' | 'wrong-kind';
  /**
   * Adds one domain to `ruleId`'s allow or deny list (ADR 0040 §3, plan
   * ruling PR-19).
   *
   * A discriminated union rather than a bare string, unlike
   * `addInviteAllowlistEntry`: `already-present` on its own would repeat
   * IMPORTANT-1 (review of Slices 3+5) — the primary key is `(guild, rule,
   * domain)`, so re-adding a domain under the *other* `listType` is also a
   * no-op, and a command that could only print the operator's requested
   * `listType` would assert a state that is false. `listType` here is the
   * **stored** one, always, so the message can name it truthfully.
   * `mode` is the rule's own `config.mode`, so the command can say what an
   * empty active list actually means (CRITICAL-2) without a second port
   * call. `'wrong-kind'` is `addInviteAllowlistEntry`'s guard, mirrored for
   * `link_domain` (IMPORTANT-7).
   */
  addLinkDomain(input: {
    readonly ruleId: string;
    readonly domain: string;
    readonly listType: 'allow' | 'deny';
  }):
    | { readonly outcome: 'added'; readonly mode: 'allow' | 'deny' | undefined }
    | {
        readonly outcome: 'already-present';
        readonly listType: 'allow' | 'deny';
        readonly mode: 'allow' | 'deny' | undefined;
      }
    | { readonly outcome: 'no-such-rule' }
    | { readonly outcome: 'wrong-kind' };
  /** `ruleId`'s allow and deny domain lists together, ordered by domain. */
  listLinkDomains(
    ruleId: string,
  ): readonly { readonly domain: string; readonly listType: 'allow' | 'deny' }[];
  /**
   * Removes one domain from either of `ruleId`'s lists.
   *
   * Same discriminated-union shape as `addLinkDomain` and for the same
   * reason: `mode` lets the command say whether the removal just emptied the
   * rule's active list (CRITICAL-2), which it cannot know from `'removed'`
   * alone.
   */
  removeLinkDomain(input: { readonly ruleId: string; readonly domain: string }):
    | { readonly outcome: 'removed'; readonly mode: 'allow' | 'deny' | undefined }
    | { readonly outcome: 'not-present'; readonly mode: 'allow' | 'deny' | undefined }
    | { readonly outcome: 'no-such-rule' }
    | { readonly outcome: 'wrong-kind' };
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

  /**
   * Re-arms the dashboard's first-account setup page (ADR 0012, slice 14).
   *
   * On `OpsInstance` rather than `OpsPorts` because `dashboard_accounts` and
   * `bootstrap_tokens` are instance-level (ADR 0027) — there is no guild in the
   * question and none in the answer. The audit row it produces is still written
   * against the resolved guild, because `audit_events` is guild-partitioned and
   * this instance serves one guild; that is a known seam, and the row's
   * `subject_type` is `instance` so the trail says which kind of thing changed.
   *
   * Synchronous: it writes a hash of a value `randomBytes` produced. Nothing
   * here is Argon2id, so nothing here needs to be async (see `http/secrets.ts`
   * for why a token gets SHA-256 and a password does not).
   */
  reissueBootstrapToken(): OpsBootstrapReissue;

  /**
   * Runs a backup immediately (ADR 0034, `backup now`).
   *
   * On `OpsInstance` for the same reason `reissueBootstrapToken` is: a backup
   * is `VACUUM INTO` against the one database file the whole process shares,
   * not a query scoped to any guild. Safe to run while the daemon is up —
   * that is the entire argument for choosing `VACUUM INTO` in the first
   * place — so unlike restore, this is reachable from the operator socket.
   */
  backupNow(): OpsBackupRunResult;
  /** Every backup on disk, oldest first, for `backup list`. */
  backupList(): readonly OpsBackupListing[];
}

export interface OpsBackupOutcome {
  readonly ok: true;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly prunedCount: number;
}

export interface OpsBackupFailure {
  readonly ok: false;
  readonly error: string;
}

export type OpsBackupRunResult = OpsBackupOutcome | OpsBackupFailure;

export interface OpsBackupListing {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly createdAtMs: number;
  readonly hasChecksum: boolean;
}

/**
 * The outcome of `bootstrap reissue`.
 *
 * A union rather than a nullable token, because the two refusals ask the
 * operator for two different things — delete the accounts you meant to delete,
 * or restart without `BANANASAURS_READONLY` — and a `undefined` return would
 * have made the command guess which.
 */
export type OpsBootstrapReissue =
  | {
      readonly ok: true;
      /** Plaintext, printed once to this operator's terminal. Never stored. */
      readonly token: string;
      readonly expiresAt: number;
      /** `DASHBOARD_PORT`, so the printed URL is the one that actually works. */
      readonly port: number;
    }
  | { readonly ok: false; readonly reason: 'accounts-exist'; readonly accountCount: number }
  | { readonly ok: false; readonly reason: 'readonly' };
