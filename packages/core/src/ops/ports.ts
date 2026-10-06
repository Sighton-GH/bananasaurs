import type { RuleKind } from '../automod/predicates/types.js';
import type { Capability } from '../authz.js';
import type { ResolvedLogRouteInput } from '../logging/route-input.js';
import type { PanelDefinition } from '../panels/model.js';
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
  /** The message body a managed panel posts; absent uses the default copy. */
  readonly content?: string | undefined;
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
 * One (rule, channel) pair where an enabled `keyword_filter` rule applies
 * but a live check found the bot without `Manage Messages` there.
 *
 * With automod On (ADR 0121), a rule that cannot delete is not a rule quietly
 * doing less — it is a rule doing nothing at all while the switch says
 * otherwise, the same
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
}

export interface OpsLogRoute {
  readonly routeId: string;
  readonly name: string;
  readonly channelId: string;
  readonly enabled: boolean;
  readonly includeContent: boolean;
  readonly createdAtMs: number;
  readonly eventKinds: readonly string[];
  readonly excludedChannelIds: readonly string[];
}

/** ADR 0121's guild-wide automod switch; re-declared here (ADR 0014). */
export type OpsAutomodState = 'off' | 'watch' | 'on';

/** The guild's row in `guilds`, as the effect gateway reads it. */
export interface OpsSafetyState {
  readonly killswitch: boolean;
  readonly dryRun: boolean;
  readonly breakerOpen: boolean;
  readonly breakerReason: string | null;
  readonly roleRatePerMin: number;
  readonly reconcileBudget: number;
  readonly breakerThreshold: number;
  readonly automodState: OpsAutomodState;
}

// `packages/core` may not import from `@bananasaurs/storage` (ADR 0014;
// `eslint.config.js` boundary rules) — every shape below is re-declared in
// core, the way `AutomodRule` already is, and the daemon
// wiring maps storage rows onto it field by field.

/** How a rule's matches have been flagged (ADR 0121: flags are for tuning). */
export interface OpsVerdictCounts {
  readonly falsePositive: number;
  readonly truePositive: number;
  readonly unclear: number;
}

/** A native Discord AutoMod decision nobody has ruled on — mirror of storage's `NativeHit`, re-declared here (ADR 0014). */
export interface OpsNativeHit {
  readonly eventId: string;
  readonly ruleId: string;
  readonly memberId: string;
  readonly at: number;
  readonly matchedCategory: string;
  readonly matchedSnippet: string;
  readonly actionTaken: string;
}

/**
 * One rule for the dashboard's `/automod` rules list. `matchCount` is every
 * recorded match for the rule; `reviewedCount` is how many of those carry a
 * flag.
 */
export interface OpsAutomodRuleSummary {
  readonly ruleId: string;
  readonly kind: RuleKind;
  readonly name: string;
  readonly enabled: boolean;
  readonly config: string;
  readonly countsAsViolation: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly matchCount: number;
  readonly reviewedCount: number;
  /** The verdict split for this rule — zeros when the rule has none. */
  readonly verdicts: OpsVerdictCounts;
}

/**
 * One rule for the dashboard's `/automod/:ruleId` detail page: the summary
 * row plus everything the page edits — exemptions and the relational lists.
 */
export interface OpsAutomodRuleDetail extends OpsAutomodRuleSummary {
  readonly exemptions: readonly {
    readonly exemptType: 'role' | 'channel';
    readonly exemptId: string;
  }[];
  readonly terms: readonly { readonly text: string; readonly categoryId: string }[];
  readonly allowlist: readonly string[];
  readonly inviteAllowlist: readonly { readonly code: string; readonly label: string }[];
  readonly linkDomains: readonly { readonly domain: string; readonly listType: 'allow' | 'deny' }[];
}

/**
 * One case for the dashboard's `/cases` list and `/members/:memberId`
 * history page.
 */
export interface OpsCase {
  readonly caseId: string;
  readonly memberId: string;
  readonly openedAt: number;
  readonly violationCount: number;
  readonly escalationTier: number;
  readonly status: 'open' | 'closed';
}

/**
 * One case event for the dashboard's `/cases/:caseId` detail page.
 *
 * `actionTaken`, `escalationAction` and `refusalReason` are plain strings,
 * not storage's unions — `ports.ts` may not import `@bananasaurs/storage`
 * (ADR 0014), the same reason `OpsReviewableMatch.actionTaken` is a string
 * above.
 */
export interface OpsCaseEvent {
  readonly eventId: string;
  readonly caseId: string;
  readonly ruleId: string;
  readonly memberId: string;
  readonly at: number;
  readonly matchedCategory: string;
  readonly matchedSnippet: string;
  readonly actionTaken: string;
  readonly escalationAction: string | undefined;
  readonly refusalReason: string | undefined;
  readonly actorId: string | undefined;
  readonly trace: string | undefined;
}

/** One case with its history, as the `/cases/:caseId` detail page renders it. */
export interface OpsCaseDetail {
  readonly case: OpsCase;
  readonly events: readonly OpsCaseEvent[];
}

// Archive shapes (ADR 0046, Slice M1 Task 6), re-declared here rather than
// imported from `@bananasaurs/storage` (ADR 0014) — the same reason
// `OpsUnusableAutomodRule.reason` widens `CompileFailure` to a string above,
// and the same way `AutomodRule` is re-declared at the top of this file.

/** `archive_channels.attachment_policy`: metadata only, or fetched bytes. */
export type ArchiveAttachmentPolicy = 'none' | 'bytes';

/** `archive_channels.backfill_state`: no terminal failure — a failing page throws to the worker, which retries. */
export type ArchiveBackfillState = 'pending' | 'running' | 'done';

/** One enabled archive channel, as `archive status` renders it. */
export interface OpsArchiveChannelStatus {
  readonly channelId: string;
  /**
   * How the row got here (review 2 N2): `channel` and `category` are
   * operator gestures; `derived` is coverage materialised under a category,
   * which the operator never enabled and whose backfill state is not theirs
   * to chase. Listing all three identically invited exactly that confusion.
   */
  readonly scopeKind?: 'channel' | 'category' | 'derived';
  /** The category a `derived` row was materialised from. */
  readonly derivedFrom?: string | undefined;
  readonly attachmentPolicy: ArchiveAttachmentPolicy;
  readonly enabledAt: number;
  readonly cursorMessageId: string | undefined;
  readonly backfillState: ArchiveBackfillState;
  readonly threadsFound?: number | undefined;
  readonly threadsDone?: number;
  /** Whether public threads under the channel are archived; `archive set-threads` flips it. */
  readonly includeThreads?: boolean | undefined;
  /** ADR 0126: false = Archive off (paused, history kept). Absent on older servers — treat as on. */
  readonly collecting?: boolean | undefined;
  readonly messageCount: number;
}

/** An archive-enabled channel the bot cannot read, and why. */
export interface OpsUnreadableArchiveChannel {
  readonly channelId: string;
  readonly reason: 'missing' | 'no-view' | 'no-history';
}

/**
 * What `archive delete-channel` destroyed.
 *
 * A discriminated union rather than a bare `'disabled'` string: disabling
 * cascades away every archived message, edit and attachment for the channel,
 * and the audit row is the only record that destruction happened — so the
 * port names how many messages went with it.
 */
export type OpsArchiveDisableOutcome =
  | { readonly outcome: 'disabled'; readonly messageCount: number }
  | { readonly outcome: 'not-enabled' }
  | { readonly outcome: 'wrong-kind' }
  /**
   * The channel has only a derived row and is still covered by an enabled
   * category, so there is nothing for `delete-channel` to delete: the next
   * message would re-materialise the row. Names the category to act on
   * instead (review 2 N1).
   */
  | { readonly outcome: 'covered-by-category'; readonly categoryId: string };

/**
 * What `archive pause-channel` / `archive pause-category` did (ADR 0126).
 *
 * Pause keeps the row, its cursor and its messages — only `collecting`
 * flips. `'derived'` means the id names coverage, not a grant: pause the
 * category instead. The channel verbs answer `'wrong-kind'` for a category
 * row (the mirror of `archiveDisableChannel`'s refusal); the category verbs
 * answer `'no-such-channel'` for an id that is not a category of this guild
 * (the mirror of `archiveEnableCategory`'s refusal).
 */
export type OpsArchivePauseOutcome = 'paused' | 'already-paused' | 'not-enabled' | 'derived';
export type OpsArchivePauseChannelOutcome = OpsArchivePauseOutcome | 'wrong-kind';
export type OpsArchivePauseCategoryOutcome = OpsArchivePauseOutcome | 'no-such-channel';

/** What `archive resume-channel` / `archive resume-category` did (ADR 0126). */
export type OpsArchiveResumeOutcome = 'resumed' | 'already-collecting' | 'not-enabled' | 'derived';
export type OpsArchiveResumeChannelOutcome = OpsArchiveResumeOutcome | 'wrong-kind';
export type OpsArchiveResumeCategoryOutcome = OpsArchiveResumeOutcome | 'no-such-channel';

/** One archive search hit, as `archive search` renders it. */
export interface OpsArchiveSearchHit {
  readonly messageId: string;
  readonly channelId: string;
  readonly authorId: string | undefined;
  readonly createdAt: number;
  readonly excerpt: string;
}

/**
 * One archived message, as the MCP `get_message` / `read_channel_history`
 * answers render it. `content: null` is a purged tombstone: the metadata
 * survives, the text is gone (ADR 0046).
 */
export interface OpsArchiveMessage {
  readonly messageId: string;
  readonly channelId: string;
  readonly authorId: string | undefined;
  readonly content: string | null;
  readonly createdAt: number;
  readonly editedAt: number | undefined;
  readonly deletedAt: number | undefined;
}

/**
 * A registered OAuth client, as `mcp clients` renders it (ADR 0045).
 *
 * Never a secret: there is none on a client. The client authenticates nothing;
 * the approving account's password at the consent page is what mints a token.
 */
export interface OpsMcpClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly registrationSource: 'dynamic' | 'cli';
  readonly createdAt: number;
  readonly redirectUriCount: number;
}

/**
 * One OAuth token row, as `mcp tokens` renders it (ADR 0045).
 *
 * Ids only — a token VALUE is never retrievable. The repository stores only
 * the hash and the one response that mints a token is the only place the
 * value ever appears, so there is nothing here to print.
 */
export interface OpsMcpToken {
  readonly tokenId: string;
  readonly kind: 'access' | 'refresh';
  readonly clientId: string;
  readonly accountId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly lastUsedAt: number | null;
}

/**
 * One training-eligibility row `doctor` is warning about (ADR 0044 §7).
 *
 * Field by field: the row carries an `evidenceUrl` the operator surface must
 * never log (Pino allowlist), so the shape names exactly what crosses the
 * boundary — provider, verdict, and review date, nothing to click.
 */
export interface OpsEligibilityWarning {
  readonly provider: string;
  /**
   * `unverified` is the configured provider with NO eligibility row at all:
   * the assistant fails closed on every invoke (hard rule 5), so this is the
   * intentionally-disabled state being surfaced, not a promise gone stale.
   */
  readonly reason: 'not-no' | 'stale' | 'not-production' | 'unverified';
  readonly trainsOnInput: string;
  readonly reviewedAt: number;
}

export interface OpsProviderReview {
  readonly provider: string;
  /** What the operator has just confirmed is still true. */
  readonly trainsOnInput: 'no' | 'yes' | 'unknown';
  readonly evidenceUrl: string;
  readonly productionUseAllowed: boolean;
  /** The review timestamp just written. */
  readonly reviewedAt: number;
  /** The timestamp this row carried before. */
  readonly previouslyReviewedAt: number;
}

/** One dashboard account, as the operator CLI shows it. Never a hash. */
export interface OpsAccount {
  readonly accountId: string;
  readonly username: string;
  readonly isOwner: boolean;
  readonly disabled: boolean;
  readonly lockedUntil: number | null;
  readonly createdAt: number;
  /**
   * Whether the owner can reveal this account's password (ADR 0070): a
   * sealed copy exists and the account is not itself an owner — owner
   * accounts never get one, whoever asks. Never the sealed value itself,
   * which stops at `ops/wiring.ts` the same way `passwordHash` does.
   */
  readonly revealable: boolean;
}

/**
 * What `account create` made. The plaintext `password` crosses this boundary
 * exactly once - into the response or terminal line that shows it once. It
 * is never stored, never audited, never in `data`.
 */
export interface OpsAccountCreateResult {
  readonly accountId: string;
  readonly username: string;
  readonly password: string;
  readonly createdAt: number;
}

/**
 * What `account disable|enable` did. `'no-such-account'` is a distinct
 * outcome from `changed: false`: one is a usage mistake, the other is an
 * account that was already in the state asked for, and an operator needs
 * to be told which.
 */
export type OpsAccountDisableResult =
  | 'no-such-account'
  | {
      readonly changed: boolean;
      readonly username: string;
      readonly isOwner: boolean;
      /** The state AFTER the write. */
      readonly disabled: boolean;
      /** A live lockout (ADR 0029) the operator should know about. */
      readonly lockedUntil: number | null;
      /** Enabled owner accounts remaining AFTER the write. */
      readonly enabledOwnersRemaining: number;
    };

/** What `account delete` did. */
export type OpsAccountDeleteResult =
  | 'no-such-account'
  | {
      readonly username: string;
      readonly accountId: string;
      readonly wasOwner: boolean;
      readonly tokensRevoked: number;
      readonly codesDeleted: number;
      /** Enabled owner accounts remaining AFTER the delete. */
      readonly enabledOwnersRemaining: number;
      /**
       * Every account row remaining AFTER the delete. `bootstrap reissue`
       * refuses while ANY row exists — not while any enabled owner exists —
       * so the ownerless warning cannot be written from the owner count
       * alone (ruling M3b-R9).
       */
      readonly accountsRemaining: number;
    };

/** What `account revoke-credentials` did. */
export type OpsAccountRevokeResult =
  | 'no-such-account'
  | {
      readonly username: string;
      readonly accountId: string;
      readonly sessionsRevoked: number;
      readonly tokensRevoked: number;
      /** Unexchanged authorization codes deleted — an unminted token mints after a revoke (ADR 0045 Amendment 4 A3-6). */
      readonly codesDeleted: number;
      /** How many guilds' session tables were swept (M3c-R3). */
      readonly guildsTouched: number;
      /** `disabled` inverted, read AFTER the writes: this is a rotation, not a lockout. */
      readonly stillEnabled: boolean;
    };

/**
 * What `account set-password` did (S13-D3/D4).
 *
 * A success arm beside `'no-such-account'`, like its neighbours: a mistyped
 * name is a usage mistake, not an answer. The success arm carries the
 * generated plaintext — shown once, in `text` only — alongside the session
 * sweep counts that say what died with the old password.
 */
export type OpsAccountSetPasswordResult =
  | 'no-such-account'
  | {
      readonly username: string;
      readonly accountId: string;
      /** Shown once, in `text` only. Never in `data`, never audited, never logged. */
      readonly password: string;
      readonly sessionsRevoked: number;
      readonly guildsTouched: number;
    };

/**
 * What `POST /api/accounts/:username/reveal-password` did (ADR 0070).
 *
 * `'not-revealable'` covers every way the plaintext cannot be recovered —
 * no sealed copy, the vault unavailable, or the sealed value not opening
 * under the current key — deliberately one answer rather than three, so the
 * route never has to explain the vault's internal state to the dashboard.
 * The owner-target refusal (`403 owner-protected`) and the caller's
 * own-capability check (`403 owner-only`) happen at the route layer, before
 * this is called, the same split every other owner-protected account route
 * uses.
 */
export type OpsAccountRevealResult =
  | 'no-such-account'
  | 'not-revealable'
  | {
      readonly username: string;
      /** Shown once, in the response only. Never in the audit row, never logged. */
      readonly password: string;
    };

/** One guild channel as the pickers show it: display name plus the snowflake. */
export interface OpsGuildChannelInfo {
  readonly channelId: string;
  readonly name: string;
  /** Discord's channel kind as a small label: `text`, `announcement`, `forum`. */
  readonly kind: string;
  /**
   * The category this channel sits under, when it does. Lets the
   * Permissions centre show effective state (a channel covered by a
   * category row) without a second guild read. Absent on servers that
   * predate the field.
   */
  readonly parentId?: string | undefined;
}

export interface OpsGuildMemberInfo {
  readonly memberId: string;
  readonly username: string;
  readonly displayName: string;
  /** Excludes `@everyone`, matching the roles list's rule. */
  readonly roleIds: readonly string[];
  /** Unix ms, or null when Discord did not send a join time. */
  readonly joinedAt: number | null;
}

export interface OpsGuildMemberPage {
  readonly members: readonly OpsGuildMemberInfo[];
  /** Pass as `after` for the next page; undefined when this page came back short. */
  readonly nextAfter?: string | undefined;
}

/** `findGuildMessage`'s verdict, in the order the form reports it. */
export type OpsMessageLookup =
  'ok' | 'channel-not-found' | 'not-text-channel' | 'message-not-found';

/** What the builder's live preview shows of an existing message. */
export interface OpsMessagePreview {
  readonly authorName: string;
  /** The message text, cut to Discord's 2000-character limit. */
  readonly content: string;
}

/** One custom emoji of the guild, for the emoji picker and the preview. */
export interface OpsGuildEmojiInfo {
  readonly emojiId: string;
  readonly name: string;
  readonly animated: boolean;
  /** Discord CDN image the dashboard renders. */
  readonly url: string;
}

export interface OpsGuildRoleInfo {
  readonly roleId: string;
  readonly name: string;
  /** Discord's integer colour; 0 is Discord's default (no colour). */
  readonly colour: number;
  /** Discord's hierarchy position; higher outranks. */
  readonly position: number;
  /** Integration- or bot-owned roles cannot be granted by the bot; pickers flag them. */
  readonly managed: boolean;
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
  /** ADR 0121: `guilds.automod_state`. Audited by the caller. */
  setAutomodState(state: OpsAutomodState): void;
  /** The guild's enabled automod rules, for the On confirmation. */
  listEnabledAutomodRuleNames(): readonly { readonly ruleId: string; readonly name: string }[];

  // --- read commands (13c) ---------------------------------------------------
  tailAudit(query: OpsAuditQuery): readonly OpsAuditRow[];
  /**
   * The guild's text-family channels (text, announcement, forum) with their
   * display names, for the named pickers that replace raw-snowflake inputs.
   * From the live gateway cache; empty when the guild is not cached yet,
   * which the picker shows as an honest loading state, never a fake list.
   */
  listGuildChannels(): readonly OpsGuildChannelInfo[];
  /** Live directory lookup for a task destination, including threads omitted by the channel picker.
   * A missing/inaccessible channel returns undefined; callers fail closed. */
  inspectTaskChannel(channelId: string): Promise<
    | {
        channelId: string;
        kind: 'channel' | 'thread';
        parentId: string | null;
        categoryId: string | null;
      }
    | undefined
  >;
  /**
   * The target check for an adopted reaction panel (the builder's
   * self-granted roles flow): does this channel exist in the guild, is it
   * text-based, and does the message exist in it? Live Discord read - the
   * channel from the gateway cache, the message fetched - so the form never
   * attaches to a guessed id.
   */
  findGuildMessage(channelId: string, messageId: string): Promise<OpsMessageLookup>;
  /**
   * The text and author of an existing message, for the builder's preview.
   * Live fetch, same rules as `findGuildMessage`; `undefined` on any miss.
   */
  previewGuildMessage(channelId: string, messageId: string): Promise<OpsMessagePreview | undefined>;
  /**
   * The guild's custom emoji (live REST read), for the emoji picker. Empty
   * when the guild is not cached or the read fails - the picker still offers
   * every Unicode emoji.
   */
  listGuildEmojis(): Promise<readonly OpsGuildEmojiInfo[]>;
  /** Live destinations inside a team category: text and announcement channels plus unarchived, unlocked threads. Private threads are excluded. */
  listTaskDestinations(categoryId: string): Promise<
    readonly {
      channelId: string;
      name: string;
      kind: 'channel' | 'thread';
      parentName?: string | undefined;
    }[]
  >;
  /**
   * The guild's roles (minus `@everyone`) with name, colour and hierarchy
   * position — the role pickers' source, and the dashboard's answer to the
   * MCP `list_roles` tool. From the live gateway cache; empty when the guild
   * is not cached yet, which the picker shows as an honest loading state.
   */
  listGuildRoles(): readonly OpsGuildRoleInfo[];
  /**
   * ADR 0125: what a member's tag of the bot can look like. `roleId` is the
   * role Discord created for the bot on install (a tag of it routes like a
   * tag of the bot user), and `names` are the bot's role, user and nickname
   * names. A desk role may be neither. Undefined when the guild is not cached.
   */
  botMentionIdentity():
    { readonly roleId: string | undefined; readonly names: readonly string[] } | undefined;
  /**
   * The bot's own highest role position in the live hierarchy, from the
   * gateway cache. Discord decides manageability from this number right now
   * — a role is manageable exactly when it sits below it and is not
   * integration-managed — so a remembered flag can never go stale when the
   * owner reorders roles in Discord. Undefined when the guild is not cached.
   */
  botHighestRolePosition(): number | undefined;
  /**
   * The guild's members, one paginated REST page at a time — the member
   * directory's source, and the dashboard's answer to the MCP `list_members`
   * tool. A paginated fetch, not a cache read: the gateway member cache is
   * capped and would silently truncate (ruling M4-D10). Empty page when the
   * guild is unreachable, which the page shows as an honest loading state.
   */
  listGuildMembers(input: {
    after?: string | undefined;
    limit?: number | undefined;
  }): Promise<OpsGuildMemberPage>;
  /**
   * A live lookup of specific members by id, so moderation surfaces (review,
   * cases) can show who a raw member id is. Bulk-fetched from Discord;
   * members who left or ids Discord does not know are simply absent, and
   * callers render the bare id honestly instead of a guess.
   */
  fetchGuildMembers(userIds: readonly string[]): Promise<readonly OpsGuildMemberInfo[]>;
  listJobs(query: OpsJobQuery): readonly OpsJobRow[];
  listPanels(): readonly OpsPanelSummary[];
  findPanel(panelId: string): OpsPanelDetail | undefined;
  listUnassignableRoles(): readonly OpsUnassignableRole[];
  /**
   * Every (rule, channel) pair where an enabled `keyword_filter` rule applies
   * and a live check found the bot without `Manage Messages`. `doctor` asks
   * only while the automod switch is On (ADR 0121).
   */
  listKeywordFilterRulesMissingManageMessages(): readonly OpsKeywordFilterChannelMissingManageMessages[];
  /** Every enabled rule `compileRule` cannot compile, and why. */
  listUnusableAutomodRules(): readonly OpsUnusableAutomodRule[];
  listRoutes(): readonly OpsLogRoute[];
  getRoute(routeId: string): OpsLogRoute | undefined;
  listExcludedChannels(): readonly string[];
  /** One job by id, for the `before` half of `jobs retry`'s audit row. */
  findJob(jobId: number): OpsJobRow | undefined;
  /**
   * Matches nobody has ruled on yet, oldest first (ADR 0041 §5, §7) — the
   * CLI review queue `automod review` renders.
   */
  listUnreviewedMatches(query: {
    readonly ruleId?: string;
    readonly limit: number;
  }): readonly OpsReviewableMatch[];
  /**
   * Native AutoMod decisions (rule_id `native:…`) nobody has ruled on, oldest
   * first (Slice 9, PR-53) — the review queue's native section. Ignores any
   * rule filter: native rule ids are Discord's, not Bananasaurs'.
   */
  listUnreviewedNativeHits(query: { readonly limit: number }): readonly OpsNativeHit[];
  /** How many native decisions that stopped a message this guild has recorded. */
  nativeBlockedCount(): number;
  /**
   * Every rule, enabled or disabled, with its match and flag tallies — the
   * dashboard's `/automod` rules list.
   */
  listAutomodRules(): readonly OpsAutomodRuleSummary[];
  /**
   * One rule with its exemptions and relational lists — the
   * dashboard's `/automod/:ruleId` detail page. `undefined` for a rule id
   * that names no row in this guild.
   */
  findAutomodRuleDetail(ruleId: string): OpsAutomodRuleDetail | undefined;
  /**
   * The newest cases first — the dashboard's `/cases` list page.
   */
  listRecentCases(query: { readonly limit: number }): readonly OpsCase[];
  /**
   * One case with its events — the dashboard's `/cases/:caseId` detail
   * page. `undefined` for a case id that names no row in this guild.
   */
  findCaseDetail(caseId: string): OpsCaseDetail | undefined;
  /**
   * Every case ever opened for one member — the dashboard's
   * `/members/:memberId` history page.
   */
  listCasesForMember(memberId: string): readonly OpsCase[];

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
  }): 'recorded' | 'no-such-event';
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
  removeLinkDomain(input: {
    readonly ruleId: string;
    readonly domain: string;
  }):
    | { readonly outcome: 'removed'; readonly mode: 'allow' | 'deny' | undefined }
    | { readonly outcome: 'not-present'; readonly mode: 'allow' | 'deny' | undefined }
    | { readonly outcome: 'no-such-rule' }
    | { readonly outcome: 'wrong-kind' };
  /**
   * Creates one rule from the dashboard's `/automod` new-rule form, always
   * starting in `mode: 'test'`. `'exists'` is a usage answer for an id that
   * already names a rule — the `INSERT` would otherwise throw on the
   * `(guild_id, rule_id)` primary key.
   */
  createAutomodRule(input: {
    readonly ruleId: string;
    readonly kind: RuleKind;
    readonly name: string;
    readonly config: string;
  }): 'created' | 'exists';
  /**
   * Replaces one rule's config from the `/automod/:ruleId` config editor.
   * The caller validates the config with `validateRuleConfig` first; this is
   * the plain write. `'no-such-rule'` is a usage answer for a mistyped id.
   */
  setAutomodRuleConfig(input: {
    readonly ruleId: string;
    readonly config: string;
  }): 'ok' | 'no-such-rule';
  /**
   * ADR 0121: turns one rule on or off from the `/automod/:ruleId` page.
   * Whether enabled rules act is the guild's automod switch, not this.
   * `'no-such-rule'` is a usage answer for a mistyped id.
   */
  setAutomodRuleEnabled(input: {
    readonly ruleId: string;
    readonly enabled: boolean;
  }): 'ok' | 'no-such-rule';
  /**
   * Exempts one role or channel from one rule, from the `/automod/:ruleId`
   * exemptions section. `'already-present'` is a real answer, not a refusal:
   * the pair is checked before the `INSERT`, so a repeated add never throws.
   * `'no-such-rule'` is a usage answer for a mistyped id.
   */
  addAutomodExemption(input: {
    readonly ruleId: string;
    readonly exemptType: 'role' | 'channel';
    readonly exemptId: string;
  }): 'added' | 'already-present' | 'no-such-rule';
  /**
   * Adds one phrase to a `keyword_filter` rule's allowlist from the review
   * queue (Slice 9). `'no-such-rule'` for a mistyped id; `'wrong-kind'` for a
   * rule that exists but is not a `keyword_filter` rule; `'already-present'`
   * checked before the `INSERT`, which throws on a duplicate.
   *
   * The phrase is stored lower-cased and space-collapsed because obscenity's
   * whitelist matcher searches the lower-cased input for the raw term, so a
   * stored phrase with any uppercase letter could never match.
   */
  addAutomodAllowlistPhrase(input: {
    readonly ruleId: string;
    readonly phrase: string;
  }): 'added' | 'already-present' | 'no-such-rule' | 'wrong-kind';
  /**
   * Removes one role or channel exemption from one rule, from the
   * `/automod/:ruleId` exemptions section. `'not-present'` is a real answer —
   * nothing to remove is not a fault.
   */
  removeAutomodExemption(input: {
    readonly ruleId: string;
    readonly exemptType: 'role' | 'channel';
    readonly exemptId: string;
  }): 'removed' | 'not-present';
  /** Creates a route; the port supplies the creation timestamp. */
  createRoute(input: ResolvedLogRouteInput): OpsLogRoute;
  /** Replaces a route; `undefined` when no route carries that id in this guild. */
  updateRoute(routeId: string, input: ResolvedLogRouteInput): OpsLogRoute | undefined;
  /** Returns whether there was a route to change. False is a real answer. */
  setRouteEnabled(routeId: string, enabled: boolean): boolean;
  /** Deletes a route. Returns whether there was one. */
  deleteRoute(routeId: string): boolean;
  /** Returns whether the exclusion is new. */
  excludeChannel(channelId: string): boolean;
  /** Returns whether there was an exclusion to remove. */
  unexcludeChannel(channelId: string): boolean;
  retryJob(jobId: number): OpsRetryOutcome;

  /**
   * Writes a validated panel definition: the panel, its options and its
   * blocked roles, in one transaction.
   *
   * The definition has already been through `panelDefinitionSchema` and the
   * caller has already checked the id is free, so this port validates nothing
   * itself. Storage only — nothing here reaches Discord. Publishing a built
   * panel stays `publishPanel`'s job, so a half-built panel cannot go live by
   * accident (ADR 0053).
   */
  createPanel(definition: PanelDefinition, newlyAllowlistedRoleIds?: readonly string[]): void;

  /**
   * Whether the role is one Bananasaurs manages — the precondition for making
   * it a panel option. `panel_options` enforces it with a foreign key; the
   * command and the builder refuse cleanly before the database has to.
   */
  isManagedRole(roleId: string): boolean;
  /**
   * Adds a role to the managed allowlist (docs/18 Layer 2). Idempotent. The
   * panel builder calls this for a role the owner just selected, after the
   * live hierarchy check has shown the bot can manage it — the audited
   * dashboard action is the allowlisting intent, and the gateway still
   * re-checks hierarchy before every mutation.
   */
  allowlistRole(roleId: string): void;

  /**
   * Replaces a panel's definition: its scalar fields, its options and its
   * blocked roles, in one transaction.
   *
   * The definition has already been through `panelDefinitionSchema`, the
   * caller has already checked the panel exists and that neither `channelId`
   * nor `kind` changed, so this port validates nothing itself. Storage only —
   * nothing here reaches Discord, and the panel keeps its `message_id` and
   * its `status`: publishing the change stays `publishPanel`'s job, and an
   * edit never re-enables a panel `doctor` took out of service (ADR 0053).
   */
  updatePanel(definition: PanelDefinition, newlyAllowlistedRoleIds?: readonly string[]): void;

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
  /**
   * Deletes a panel's Discord message, then its rows.
   *
   * Only a managed panel with a `messageId` has a message deleted: an adopted
   * panel's message belongs to someone else, and an unposted panel has nothing
   * to remove — both delete their rows only. An already-deleted message
   * (unknown message, 10008/404) counts as success, so retrying is safe; any
   * other Discord error throws with the rows still in place, so a retry can
   * finish. Roles stay in `managed_roles` either way.
   */
  unpublishPanel(panelId: string): Promise<void>;
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

  // --- archive (ADR 0046, Slice M1 Task 6) ------------------------------------
  /**
   * Names a channel whose messages enter the archive. Refused before any
   * write when the guild is not in `BANANASAURS_ARCHIVE_GUILDS` — the
   * composition root closes over that fact, so the command cannot vary it.
   */
  archiveEnableChannel(input: {
    readonly channelId: string;
    readonly attachmentPolicy: ArchiveAttachmentPolicy;
  }): 'enabled' | 'already-enabled' | 'guild-not-archive-enabled';
  /** Removes the channel row; its messages, edits and attachments cascade. */
  archiveDisableChannel(channelId: string): OpsArchiveDisableOutcome;
  archiveCategoryCoverage(channelId: string): {
    readonly channels: number;
    readonly messages: number;
  };
  archiveEnableCategory(input: {
    channelId: string;
    attachmentPolicy: ArchiveAttachmentPolicy;
  }): 'enabled' | 'already-enabled' | 'guild-not-archive-enabled' | 'no-such-channel';
  archiveDisableCategory(channelId: string): OpsArchiveDisableOutcome;
  /** ADR 0126: Archive off pauses recording; the row and its messages are kept. */
  archivePauseChannel(channelId: string): OpsArchivePauseChannelOutcome;
  /** ADR 0126: resume restarts recording; the gap stays a gap (no backfill). */
  archiveResumeChannel(channelId: string): OpsArchiveResumeChannelOutcome;
  /** ADR 0126: pause acting on the category row only. */
  archivePauseCategory(channelId: string): OpsArchivePauseCategoryOutcome;
  /** ADR 0126: resume acting on the category row only. */
  archiveResumeCategory(channelId: string): OpsArchiveResumeCategoryOutcome;
  archiveSetThreads(
    channelId: string,
    include: boolean,
  ): 'updated' | 'not-enabled' | 'forum-requires-all';
  archiveThreads(
    channelId: string,
  ): { readonly found: number | undefined; readonly done: number } | undefined;
  /** Every enabled channel with its backfill cursor and message count. */
  archiveStatus(): readonly OpsArchiveChannelStatus[];
  /** Marks one archived message preserved (the indefinite retention tier). */
  archivePreserve(messageId: string): 'preserved' | 'no-such-message' | 'already-preserved';
  /**
   * Links one archived message to an open moderation case (the `case` tier).
   *
   * `'preserved'` is its own arm, not folded into `'already-linked'`: a
   * preserved message is linked to no case at all, and the audit trail must
   * say so rather than claim a link that does not exist.
   */
  archiveLinkCase(input: {
    readonly messageId: string;
    readonly caseId: string;
  }):
    'linked' | 'no-such-message' | 'no-such-case' | 'case-closed' | 'already-linked' | 'preserved';
  /** Queues one `archive_backfill` job for the channel (dedupe-collapsed). */
  enqueueArchiveBackfill(channelId: string): void;
  /**
   * `doctor`'s archive check: enabled channels the bot cannot read, and why.
   * `missing` means the channel is not in the client's cache at all.
   */
  listUnreadableArchiveChannels(): readonly OpsUnreadableArchiveChannel[];
  /**
   * `doctor`'s archive-index check: the FTS row count beside the
   * `archive_messages` row count, both for this guild. Unequal means the index
   * is stale — a restored database disagrees until `archive reindex` runs.
   */
  archiveIndexHealth(): { readonly indexed: number; readonly rows: number };
  /**
   * Searches the archive. The visibility set is every archive-enabled channel
   * in this guild — the operator sees what the archive holds, nothing wider.
   *
   * `rank` is dropped from this surface (an operator does not need BM25's
   * scale) but the order is kept: best match first, as the repository returns.
   */
  archiveSearch(input: {
    readonly query: string;
    readonly channelId?: string;
    readonly authorId?: string;
    readonly limit?: number;
  }): { readonly hits: readonly OpsArchiveSearchHit[]; readonly total: number };
  /** Rebuilds the FTS index from archive_messages. Returns the indexed row count. */
  archiveReindex(): number;
  /**
   * One channel's archived messages, newest first, paged by a
   * `before` message-id cursor — the MCP `read_channel_history` answer.
   * A channel outside the guild's archive-enabled set returns empty,
   * never an error, so the call cannot reveal whether it exists.
   */
  archiveChannelHistory(input: {
    readonly channelId: string;
    readonly before?: string | undefined;
    readonly limit?: number | undefined;
  }): readonly OpsArchiveMessage[];
  /** One archived message by id — the MCP `get_message` answer. */
  archiveFindMessage(messageId: string): OpsArchiveMessage | undefined;

  /**
   * ADR 0028 / ADR 0045: grant a dashboard account a capability IN THIS
   * GUILD. Returns 'granted', 'already-held', 'no-such-account', or
   * 'no-guild-access' (the account cannot reach this guild, so the FK would
   * refuse — say so rather than throw).
   */
  grantAccountCapability(input: {
    readonly username: string;
    readonly capability: Capability;
    readonly grantedBy: string;
  }): 'granted' | 'already-held' | 'no-such-account' | 'no-guild-access';

  /**
   * ADR 0069: revoke ONE dashboard account capability in THIS guild, the
   * sibling of `grantAccountCapability` above — the edit page's permission
   * section needs it, where today the only revoke removes all server access.
   *
   * `'not-held'` is a real answer, not a refusal: revoking a capability the
   * account does not hold changes nothing, and re-running the revoke must say
   * so rather than fail. `'no-such-account'` is the usage answer for a
   * mistyped name.
   */
  revokeAccountCapability(input: {
    readonly username: string;
    readonly capability: Capability;
  }): 'revoked' | 'not-held' | 'no-such-account';

  /** The capabilities one account holds in THIS guild — the read half of the grant above. */
  listAccountCapabilities(accountId: string): readonly string[];

  /**
   * S13-D1: grants the account access to THIS guild. `--guild` selects what
   * is granted, not merely which audit trail records it — unlike every other
   * account command, whose effect is instance-wide (ADR 0027) while their
   * `--guild` only picks the audit destination.
   *
   * `'already-had-it'` is a real answer, not a refusal: the access row is
   * written `onConflictDoNothing`, so re-running the grant must say so
   * rather than write a duplicate. `'no-such-account'` is the usage answer
   * for a mistyped name.
   */
  accountGrantGuild(username: string): 'granted' | 'already-had-it' | 'no-such-account';
  /**
   * S13-D2: revokes the account's access to THIS guild, the mirror of
   * `accountGrantGuild` above — `--guild` selects what is revoked. The
   * capabilities the account held in this guild cascade away with the access
   * row (ADR 0028).
   *
   * There is deliberately no guard against revoking your own last guild
   * access, following `account delete`'s precedent (ADR 0045 A3-3): the
   * command warns in its output instead, and recovery is delete +
   * re-bootstrap.
   */
  accountRevokeGuild(username: string): 'revoked' | 'did-not-have-it' | 'no-such-account';

  // --- mcp send allowlist (slice M5, ADR 0044 §4) ------------------------------
  /**
   * What `mcp allow-channel` did.
   *
   * Three outcomes, not a boolean: the operator needs to hear which of
   * "allowed", "already allowed" or "no such channel in this guild"
   * happened. `'no-such-channel'` is the allow-time half of C2 — a snowflake
   * that is not a text-capable channel of this guild (including a DM-shaped
   * id) is refused before any row is written.
   */
  allowSendChannel(input: { channelId: string; accountId: string }): OpsAllowSendChannelOutcome;
  allowSendCategory(input: { channelId: string; accountId: string }): OpsAllowSendChannelOutcome;
  disallowSendCategory(channelId: string): OpsDisallowSendOutcome;
  sendScopeCoverage(channelId: string): number;
  disallowSendChannel(channelId: string): OpsDisallowSendOutcome;
  listSendAllowlist(): readonly OpsSendAllowlistEntry[];
  listSends(input: {
    sinceMs?: number | undefined;
    limit?: number | undefined;
  }): readonly OpsSendRecord[];

  // --- read scope (ADR 0126) ---------------------------------------------------
  /**
   * What `scope read enable-channel` / `enable-category` did.
   *
   * The same three-outcome shape `allowSendChannel` uses: the operator needs
   * to hear which of "readable", "already readable" or "no such channel in
   * this guild" happened. `'no-such-channel'` is the allow-time refusal — a
   * snowflake that is not a channel (or, for the category verb, not a
   * category) of this guild is refused before any row is written. Unlike the
   * send allowlist there is no account: the repository stores no adder, only
   * the channel, its kind and when it was added.
   */
  readScopeAllow(input: {
    channelId: string;
    scopeKind: 'channel' | 'category';
  }): OpsReadScopeAllowOutcome;
  /**
   * What `scope read disable-channel` / `disable-category` did — kind-scoped
   * like `disallowSendChannel`, so the wrong verb on the other kind's row is
   * a distinct answer, never a silent delete.
   */
  readScopeDisallow(input: {
    channelId: string;
    scopeKind: 'channel' | 'category';
  }): OpsReadScopeDisallowOutcome;
  /** Every readable channel and category in this guild, oldest grant first. */
  readScopeList(): readonly OpsReadScopeEntry[];
  // --- mcp role policy (slice 5 task 6, ADR 0117 §2) ---------------------------
  /**
   * The guild's role-policy modes. Absent row means both are `below-bot`
   * (ADR 0117, consequences) — the repository answers the default, never
   * `undefined`, so callers never branch on "no row".
   */
  readRolePolicy(): OpsRolePolicy;
  /**
   * Upserts the policy row, keeping the mode no input named. Returns before
   * and after, so the command can audit both halves of the change.
   */
  setRolePolicy(input: {
    readonly grantMode?: OpsRolePolicyMode;
    readonly pingMode?: OpsRolePolicyMode;
  }): { readonly before: OpsRolePolicy; readonly after: OpsRolePolicy };
  /**
   * What `mcp allow-role` did.
   *
   * Five refusals besides the two successes, each distinct: the operator
   * needs to hear which of "allowed", "already allowed", "no such role in
   * this guild", "`@everyone`", "managed", or "dangerous" happened.
   * `'no-such-role'`, `'everyone'`, `'managed'` and `'dangerous'` write
   * nothing — the live Discord check runs before the repository sees the id.
   *
   * Async where `allowSendChannel` is synchronous: the role is fetched live
   * from the guild, not read from the cache alone, and a REST fetch is a
   * promise. Above-bot roles MAY be allowlisted — hierarchy is checked at
   * use time by the grant and ping paths, never here.
   */
  allowRole(input: {
    readonly roleId: string;
    readonly purpose: OpsRoleAllowlistPurpose;
    readonly accountId: string;
  }): Promise<OpsAllowRoleOutcome>;
  /**
   * What `mcp disallow-role` did. `'not-allowed'` is a real answer, the same
   * shape `disallowSendChannel`'s is: nothing to remove is not a fault.
   */
  disallowRole(input: {
    readonly roleId: string;
    readonly purpose: OpsRoleAllowlistPurpose;
  }): 'removed' | 'not-allowed';
  /** Every allowlisted role of this guild. Ids and purposes only — never role names. */
  listRoleAllowlist(): readonly OpsRoleAllowlistEntry[];
}

/** `mcp_role_policy`'s two modes, re-declared here rather than imported (ADR 0014). */
export type OpsRolePolicyMode = 'below-bot' | 'allowlist';

/** `mcp_role_allowlist`'s purpose, re-declared here rather than imported (ADR 0014). */
export type OpsRoleAllowlistPurpose = 'grant' | 'ping';

export interface OpsRolePolicy {
  readonly grantMode: OpsRolePolicyMode;
  readonly pingMode: OpsRolePolicyMode;
}

/** One row of `mcp_role_allowlist`, as `mcp role-policy` renders it. Ids only. */
export interface OpsRoleAllowlistEntry {
  readonly roleId: string;
  readonly purpose: OpsRoleAllowlistPurpose;
  readonly addedByAccountId: string;
  readonly addedAt: number;
}

/**
 * What `mcp allow-role` did: allowed, already allowed, or one of four
 * distinct refusals — unknown role, `@everyone`, managed, dangerous.
 */
export type OpsAllowRoleOutcome =
  'allowed' | 'already-allowed' | 'no-such-role' | 'everyone' | 'managed' | 'dangerous';

/** What `mcp allow-channel` did: allowed, already allowed, or refused. */
export type OpsAllowSendChannelOutcome = 'allowed' | 'already-allowed' | 'no-such-channel';

/**
 * What `mcp disallow-channel` / `mcp disallow-category` did (review S1):
 * kind-scoped, so the wrong verb on the other kind's row is a distinct
 * answer, never a silent delete.
 */
export type OpsDisallowSendOutcome = 'removed' | 'not-allowed' | 'wrong-kind';

export interface OpsSendAllowlistEntry {
  readonly channelId: string;
  readonly scopeKind?: 'channel' | 'category';
  readonly coverage?: number;
  readonly addedByAccountId: string;
  readonly addedAt: number;
}

/** Projected field by field. No content: it is not this surface's business. */
export interface OpsSendRecord {
  readonly channelId: string;
  readonly messageId: string | undefined;
  readonly tokenId: string;
  readonly sentAt: number;
  readonly outcome: 'sent' | 'dry_run';
}

/** What `scope read enable-channel` / `enable-category` did: readable, already readable, or refused. */
export type OpsReadScopeAllowOutcome = 'allowed' | 'already-allowed' | 'no-such-channel';

/**
 * What `scope read disable-channel` / `disable-category` did: kind-scoped, so
 * the wrong verb on the other kind's row is a distinct answer, never a
 * silent delete — the same shape `OpsDisallowSendOutcome` gives the send
 * allowlist.
 */
export type OpsReadScopeDisallowOutcome = 'removed' | 'not-allowed' | 'wrong-kind';

/** One readable channel or category, as `scope read list` renders it. Never content. */
export interface OpsReadScopeEntry {
  readonly channelId: string;
  readonly scopeKind: 'channel' | 'category';
  readonly addedAt: number;
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

/**
 * `doctor`'s public-surface half (ruling M6-D1), already rendered by the
 * daemon that owns the public URL.
 *
 * Re-declared here rather than imported from `apps/daemon` (ADR 0014), the
 * same reason every shape above is re-declared: the rows carry status,
 * content type and `Location` host only, so there is no body here to leak —
 * and the daemon's wiring maps its own report onto this field by field.
 */
export interface OpsPublicSurfaceReport {
  /** False when MCP_PUBLIC_URL is unset: nothing was probed and ok is true. */
  readonly probed: boolean;
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
   * The public-surface probe (ruling M6-D1): the bot's own `MCP_PUBLIC_URL`
   * fetched in both directions, dashboard paths against Access and machine
   * paths against the app.
   *
   * Instance-level beside `doctor()`: the public URL is a fact about the
   * daemon, not a guild. Async where `doctor()` is synchronous, because a
   * fetch is not — five sequential HTTPS round trips behind a short timeout.
   */
  probePublicSurface(): Promise<OpsPublicSurfaceReport>;
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

  /** ADR 0045: registered OAuth clients. Never a secret; there is none on a client. */
  mcpClients(): readonly OpsMcpClient[];
  /** ADR 0045: every token row, live or not. Ids only — a token VALUE is never retrievable. */
  mcpTokens(): readonly OpsMcpToken[];
  /**
   * Revokes the token's whole lineage (every row sharing its
   * `issuedFromCodeHash`), not just the one row: revoking a leaked access
   * token must not leave its sibling refresh token free to mint a new one.
   * `undefined` for an unknown id, otherwise how many rows were revoked.
   */
  mcpRevokeToken(tokenId: string): number | undefined;
  /** Deletes the client and everything issued to it; returns the number of tokens revoked, or undefined if no such client. */
  mcpRevokeClient(clientId: string): number | undefined;
  /**
   * ADR 0044 §7: every eligibility row that is stale (past 90 days) or not 'no'.
   *
   * Instance-level, like `mcpClients` — a provider is a fact about the
   * daemon, not a guild. Takes the review clock as `nowMs`, the same
   * injected-clock shape as every `now` in this tree; `doctor` passes its
   * own tick, so the finding is read at request time, not at startup.
   */
  providerEligibilityWarnings(nowMs: number): readonly OpsEligibilityWarning[];
  /**
   * Records an operator's re-verification of a provider's eligibility row
   * (ruling M4-D20). `'no-such-provider'` when the provider is unknown.
   *
   * Instance-level, like `providerEligibilityWarnings` beside it: a provider is
   * a fact about the daemon, not a guild.
   */
  providerReview(provider: string): OpsProviderReview | 'no-such-provider';
  /**
   * Every dashboard account, oldest first, as `account list` renders it
   * (ADR 0045 D6).
   *
   * On `OpsInstance` for the same reason `reissueBootstrapToken` is:
   * `dashboard_accounts` is instance-level (ADR 0027), so there is no guild
   * to scope by. Field by field rather than a re-export: the row carries a
   * `passwordHash` the operator surface must never see, so the shape names
   * exactly what crosses the boundary.
   */
  accountList(): readonly OpsAccount[];
  /**
   * Creates one NON-owner dashboard account with no guild access and no
   * capabilities - least privilege by construction, so a new account can
   * reach nothing until an explicit, audited grant says otherwise
   * (`accountGrantGuild` / `grantAccountCapability`, the same levers that
   * edit it afterwards). Async like `accountSetPassword`: the generated
   * password is hashed with Argon2id in the wiring, the plaintext is
   * returned exactly once and never stored. `'username-taken'` is the usage
   * answer for a name an existing account already holds.
   *
   * ADR 0069: the dashboard's create page lets the operator choose the
   * password instead of taking a generated one. A provided password is
   * hashed exactly like a generated one; the route refuses short ones
   * (`weak-password`, fewer than 12 characters) before this is called, so
   * the CLI's generate-only path keeps calling with no second argument.
   */
  accountCreate(
    username: string,
    password?: string,
  ): Promise<OpsAccountCreateResult | 'username-taken'>;
  /**
   * Disables or re-enables one dashboard account by username (ADR 0045 D6).
   *
   * Instance-level like `accountList` above — the account predates any guild
   * choice. Takes a username rather than an id because that is what an
   * operator types; resolves it inside. `'no-such-account'` is a usage
   * answer for a mistyped name, distinct from `changed: false` for an
   * account already in the requested state. `lockedUntil` is the lockout
   * the row already carried (ADR 0029 is orthogonal to disablement and is
   * neither cleared nor set here); `enabledOwnersRemaining` is read after
   * the write so the command can warn before the daemon goes ownerless.
   */
  accountSetDisabled(username: string, disabled: boolean): OpsAccountDisableResult;
  /**
   * Deletes one dashboard account by username, revoking its tokens and
   * consent codes in the same transaction (ADR 0045 D6).
   *
   * Instance-level like `accountList` above. `'no-such-account'` is the
   * usage answer for a mistyped name. The counts are the repository's own
   * — how many live tokens were revoked and how many codes removed — and
   * `enabledOwnersRemaining` is read after the delete, the same ownerless
   * warning `accountSetDisabled` carries.
   */
  accountDelete(username: string): OpsAccountDeleteResult;
  /**
   * Revokes every live dashboard session and every live OAuth token for one
   * dashboard account by username, WITHOUT disabling it (M3c).
   *
   * Instance-wide in effect: `dashboard_sessions` is guild-partitioned, so
   * the implementation sweeps every guild scope the daemon serves, while
   * `oauth_tokens` is instance-level (ADR 0027). `disable` pauses,
   * `revoke-credentials` rotates — both together mean locked out *and*
   * rotated (M3c-R1). `'no-such-account'` is the usage answer for a mistyped
   * name. `stillEnabled` is read after the writes, so the command reports
   * what the account is, not what it was.
   */
  accountRevokeCredentials(username: string): OpsAccountRevokeResult;
  /**
   * S13-D3/D4: replaces one dashboard account's password with a generated
   * one, revokes that account's dashboard sessions in every guild, and
   * returns the plaintext exactly once.
   *
   * Instance-level like every other account member: the account predates any
   * guild choice. Async: the implementation hashes with Argon2id, and Argon2id
   * is async by nature — as is the reason `core` never sees the secret
   * primitives at all (ADR 0014 keeps `hashPassword` in `packages/http`, so
   * the hashing lives in the daemon's wiring, never here). The plaintext is
   * returned once and never stored: the command prints it into `text` and
   * keeps it out of `data` and the audit row. Sessions die with the password
   * (trust derived from it); OAuth tokens are bound to the account, not the
   * password, so they survive — `account revoke-credentials` is the command
   * that ends those. `'no-such-account'` is the usage answer for a mistyped
   * name.
   *
   * ADR 0069: the dashboard's password section lets the operator choose the
   * password instead of taking a generated one. A provided password is
   * hashed exactly like a generated one; the route refuses short ones
   * (`weak-password`, fewer than 12 characters) before this is called, so
   * the CLI's generate-only reset keeps calling with no second argument.
   */
  accountSetPassword(username: string, password?: string): Promise<OpsAccountSetPasswordResult>;
  /**
   * Reveals one non-owner account's password from its sealed copy (ADR
   * 0070, spec A4). Synchronous: unlike `accountSetPassword` this never
   * hashes anything, only opens an AES-GCM ciphertext already held.
   *
   * Instance-level like every other account member. `'no-such-account'` is
   * the usage answer for a mistyped name; `'not-revealable'` covers every
   * reason the plaintext cannot come back (no sealed copy, the vault
   * unavailable, or it does not open under the current key) — the route
   * layer has already refused an owner target before this is ever called.
   */
  accountRevealPassword(username: string): OpsAccountRevealResult;
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
