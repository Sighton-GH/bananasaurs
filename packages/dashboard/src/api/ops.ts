/**
 * The dashboard's mirror of the operator ops API shapes (ADR 0051 W3).
 *
 * `packages/dashboard` may not import server packages (ADR 0014, ADR 0043 —
 * the dashboard builds to static assets), so these are re-declared by hand
 * from `packages/core/src/ops/ports.ts` (`OpsJobRow`, `OpsAccount`,
 * `OpsMcpClient`, …) and from the route bodies in
 * `packages/http/src/routes/ops-read.ts` / `ops-write.ts`, the same way
 * `api/automod.ts` mirrors the automod shapes. If a route test changes a
 * server shape, update the mirror here and the page that reads it.
 */

// --- shared -----------------------------------------------------------------

/** `GET /api/jobs` and `GET /api/jobs/:id` — mirrors `OpsJobRow`. */
export interface JobRow {
  readonly jobId: number;
  readonly kind: string;
  readonly state: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAfter: number;
  readonly lastError: string | null;
  readonly dedupeKey: string;
}

/** `POST /api/jobs/:id/retry` 409 bodies carry the refusal reason (and detail). */
export type JobRetryRefusal =
  | { readonly error: 'not-failed'; readonly state: string }
  | { readonly error: 'dedupe-blocked'; readonly blockingJobId: number };

// --- doctor -----------------------------------------------------------------

/** One doctor finding — mirrors `DoctorProblem` in core's reads command. */
export interface DoctorProblem {
  readonly title: string;
  readonly impact: string;
  readonly fix: string;
  readonly route?: string;
  readonly details?: string;
}

/** `GET /api/doctor` — mirrors `OpsDoctorReport`. */
export interface DoctorReport {
  readonly ok: boolean;
  readonly text: string;
  readonly data: {
    readonly problems?: readonly DoctorProblem[];
    readonly advisories?: readonly string[];
  };
}

/** `GET /api/doctor/public-surface` — mirrors `OpsPublicSurfaceReport`. */
export interface PublicSurfaceReport {
  /** False when MCP_PUBLIC_URL is unset: nothing was probed and ok is true. */
  readonly probed: boolean;
  readonly ok: boolean;
  readonly text: string;
  readonly data: unknown;
}

// --- backups ----------------------------------------------------------------

/** One row of `GET /api/backups` — mirrors `OpsBackupListing`. */
export interface BackupListing {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly createdAtMs: number;
  readonly hasChecksum: boolean;
}

/** `POST /api/backup-now` success body — the failure arm arrives as a 500. */
export interface BackupRunOutcome {
  readonly ok: true;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly prunedCount: number;
}

// --- providers --------------------------------------------------------------

/** One row of `GET /api/providers/eligibility` — mirrors `OpsEligibilityWarning`. */
export interface EligibilityWarning {
  readonly provider: string;
  readonly reason: 'not-no' | 'stale' | 'not-production' | 'unverified';
  readonly trainsOnInput: string;
  readonly reviewedAt: number;
}

/** `POST /api/providers/:provider/review` — mirrors `OpsProviderReview`. */
export interface ProviderReviewResult {
  readonly provider: string;
  readonly trainsOnInput: 'no' | 'yes' | 'unknown';
  readonly evidenceUrl: string;
  readonly productionUseAllowed: boolean;
  readonly reviewedAt: number;
  readonly previouslyReviewedAt: number;
}

// --- accounts ---------------------------------------------------------------

/** One row of `GET /api/accounts` — mirrors `OpsAccount`. Never a hash. */
export interface Account {
  readonly accountId: string;
  readonly username: string;
  readonly isOwner: boolean;
  readonly disabled: boolean;
  readonly lockedUntil: number | null;
  readonly createdAt: number;
  /** ADR 0070: whether the owner can reveal this account's password. Never the owner's own accounts. */
  readonly revealable: boolean;
}

/** `GET /api/accounts` — the accounts plus, for each, the capabilities it holds in THIS guild. */
export interface AccountsResponse {
  readonly accounts: readonly Account[];
  readonly capabilities: Record<string, readonly string[]>;
}

/** `POST /api/accounts/:username/capabilities` — the grant outcome; 404/409 are refusal answers. */
export type AccountCapabilityOutcome = 'granted' | 'already-held';

/** `POST /api/accounts/:username/disabled` — the success arm of `OpsAccountDisableResult`. */
export interface AccountDisableResult {
  readonly changed: boolean;
  readonly username: string;
  readonly isOwner: boolean;
  /** The state AFTER the write. */
  readonly disabled: boolean;
  readonly lockedUntil: number | null;
  /** Enabled owner accounts remaining AFTER the write. */
  readonly enabledOwnersRemaining: number;
}

/** `DELETE /api/accounts/:username` — the success arm of `OpsAccountDeleteResult`. */
export interface AccountDeleteResult {
  readonly username: string;
  readonly accountId: string;
  readonly wasOwner: boolean;
  readonly tokensRevoked: number;
  readonly codesDeleted: number;
  readonly enabledOwnersRemaining: number;
  /** Rows remaining AFTER the delete: `bootstrap reissue` refuses while ANY row exists. */
  readonly accountsRemaining: number;
}

/** `POST /api/accounts/:username/revoke-credentials` — the success arm of `OpsAccountRevokeResult`. */
export interface AccountRevokeResult {
  readonly username: string;
  readonly accountId: string;
  readonly sessionsRevoked: number;
  readonly tokensRevoked: number;
  readonly codesDeleted: number;
  readonly guildsTouched: number;
  /** `disabled` inverted, read AFTER the writes: this is a rotation, not a lockout. */
  readonly stillEnabled: boolean;
}

/**
 * `POST /api/accounts/:username/password` — the success arm of
 * `OpsAccountSetPasswordResult`. `password` is shown exactly once, in the
 * PrintOnceDialog, and nowhere else: never a toast, never a log line.
 */
/**
 * `POST /api/accounts`'s answer. `password` is shown exactly once, in the
 * PrintOnceDialog; the scope echoes what the form asked for and the route
 * granted.
 */
export interface AccountCreateResult {
  readonly accountId: string;
  readonly username: string;
  readonly password: string;
  readonly guildAccess: boolean;
  readonly capabilities: readonly string[];
}

export interface AccountSetPasswordResult {
  readonly username: string;
  readonly accountId: string;
  readonly password: string;
  readonly sessionsRevoked: number;
  readonly guildsTouched: number;
}

/** `POST /api/accounts/:username/grant-guild` / `revoke-guild` outcomes. */
export type AccountGuildOutcome = 'granted' | 'already-had-it' | 'revoked' | 'did-not-have-it';

/**
 * `POST /api/accounts/:username/reveal-password` (ADR 0070) — the sealed
 * plaintext, shown once in a PrintOnceDialog. Never logged, never audited.
 */
export interface AccountRevealResult {
  readonly username: string;
  readonly password: string;
}

// --- mcp --------------------------------------------------------------------

/** One row of `GET /api/mcp/clients` — mirrors `OpsMcpClient`. Never a secret. */
export interface McpClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly registrationSource: 'dynamic' | 'cli';
  readonly createdAt: number;
  readonly redirectUriCount: number;
}

/** One row of `GET /api/mcp/tokens` — mirrors `OpsMcpToken`. Ids only. */
export interface McpToken {
  readonly tokenId: string;
  readonly kind: 'access' | 'refresh';
  readonly clientId: string;
  readonly accountId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly lastUsedAt: number | null;
}

/** One row of `GET /api/mcp/sends` — mirrors `OpsSendRecord`: ids and outcomes, never content. */
export interface McpSend {
  readonly channelId: string;
  readonly messageId: string | null;
  readonly tokenId: string;
  readonly sentAt: number;
  readonly outcome: 'sent' | 'dry_run';
}

/** One row of `GET /api/send-allowlist` — mirrors `OpsSendAllowlistEntry`. */
export interface SendAllowlistEntry {
  readonly channelId: string;
  /** Absent on servers that predate the threads merge — treat as `channel`. */
  readonly scopeKind?: 'channel' | 'category' | undefined;
  /** Live count of channels a category row currently covers. */
  readonly coverage?: number | undefined;
  readonly addedByAccountId: string;
  readonly addedAt: number;
}

/** `POST /api/send-allowlist` outcomes; `no-such-channel` arrives as a 404. */
export type SendAllowOutcome = 'allowed' | 'already-allowed';

// --- guild ----------------------------------------------------------------

/** One row of `GET /api/guild/channels`'s `channels` — mirrors `OpsGuildChannelInfo`. */
export interface GuildChannelInfo {
  readonly channelId: string;
  readonly name: string;
  readonly kind: string;
  /** The category this channel sits under; absent on servers that predate the field. */
  readonly parentId?: string | undefined;
}

/**
 * One row of `GET /api/guild/roles`'s `roles` — mirrors `OpsGuildRoleInfo`
 * plus the route's `optionable` join: Bananasaurs manages the role and
 * Discord does not, so a panel option may point at it.
 */
/** One row of `GET /api/guild/members`'s `members` — mirrors `OpsGuildMemberInfo`. */
export interface GuildMemberInfo {
  readonly memberId: string;
  readonly username: string;
  readonly displayName: string;
  readonly roleIds: readonly string[];
  readonly joinedAt: number | null;
}

export interface GuildMemberPage {
  readonly members: readonly GuildMemberInfo[];
  readonly nextAfter?: string | undefined;
}

export interface GuildRoleInfo {
  readonly roleId: string;
  readonly name: string;
  readonly colour: number;
  readonly position: number;
  readonly managed: boolean;
  /** Live-hierarchy answer: below the bot's highest role and not integration-owned. */
  readonly manageable: boolean;
  /** Already on the bot's managed-role allowlist. */
  readonly allowlisted: boolean;
  readonly optionable: boolean;
}

// --- archive ----------------------------------------------------------------

export type ArchiveAttachmentPolicy = 'none' | 'bytes';
export type ArchiveBackfillState = 'pending' | 'running' | 'done';

/** One row of `GET /api/archive/status`'s `channels` — mirrors `OpsArchiveChannelStatus`. */
export interface ArchiveChannelStatus {
  readonly channelId: string;
  /**
   * How the row got into scope: an operator-enabled `channel` or `category`,
   * or a channel `derived` from an enabled category. Absent on servers that
   * predate the threads merge — treat as `channel`.
   */
  readonly scopeKind?: 'channel' | 'category' | 'derived' | undefined;
  /** The category a `derived` row was materialised from. */
  readonly derivedFrom?: string | undefined;
  readonly attachmentPolicy: ArchiveAttachmentPolicy;
  readonly enabledAt: number;
  readonly cursorMessageId: string | undefined;
  readonly backfillState: ArchiveBackfillState;
  /** Thread backfill progress; `found` is undefined until the sweep counts them. */
  readonly threadsFound?: number | undefined;
  readonly threadsDone?: number | undefined;
  /** Whether threads under the channel are archived. Absent on older servers — treat as on. */
  readonly includeThreads?: boolean | undefined;
  readonly messageCount: number;
}

/** `GET /api/archive/status`'s `index` — mirrors `archiveIndexHealth()`. */
export interface ArchiveIndexHealth {
  readonly indexed: number;
  readonly rows: number;
}

export interface ArchiveStatus {
  readonly channels: readonly ArchiveChannelStatus[];
  readonly index: ArchiveIndexHealth;
}

/** One hit of `GET /api/archive/search` — mirrors `OpsArchiveSearchHit`. Best match first. */
export interface ArchiveSearchHit {
  readonly messageId: string;
  readonly channelId: string;
  readonly authorId: string | undefined;
  readonly createdAt: number;
  readonly excerpt: string;
}

/**
 * One archived message — mirrors `OpsArchiveMessage`. `content: null` is a
 * purged tombstone: the metadata survives, the text is gone (ADR 0046).
 * `GET /api/archive/channels/:channelId/messages` lists them newest first,
 * paged by `before`; `GET /api/archive/messages/:messageId` reads one.
 */
export interface ArchiveMessage {
  readonly messageId: string;
  readonly channelId: string;
  readonly authorId: string | undefined;
  readonly content: string | null;
  readonly createdAt: number;
  readonly editedAt: number | undefined;
  readonly deletedAt: number | undefined;
}

export interface ArchiveSearchResult {
  readonly hits: readonly ArchiveSearchHit[];
  readonly total: number;
}

/** `DELETE /api/archive/channels/:channelId` — mirrors `OpsArchiveDisableOutcome`. */
export type ArchiveDisableOutcome =
  | { readonly outcome: 'disabled'; readonly messageCount: number }
  | { readonly outcome: 'not-enabled' }
  | { readonly outcome: 'wrong-kind' }
  | { readonly outcome: 'covered-by-category'; readonly categoryId: string };

/** `POST /api/archive/categories`; `no-such-channel` is a 404, `guild-not-archive-enabled` a 409. */
export type ArchiveCategoryEnableOutcome = 'enabled' | 'already-enabled';

/** `POST /api/archive/channels/:channelId/threads`; `not-archived` is a 404, `forum-requires-all` a 409. */
export type ArchiveThreadsValue = 'all' | 'none';

/** `POST /api/archive/messages/:messageId/preserve`; `no-such-message` arrives as a 404. */
export type ArchivePreserveOutcome = 'preserved' | 'already-preserved';

/** `POST /api/archive/link-case` outcomes; the two `no-such-*` refusals are 404s. */
export type ArchiveLinkCaseOutcome = 'linked' | 'already-linked' | 'preserved' | 'case-closed';

/** `POST /api/archive/channels`; `guild-not-archive-enabled` arrives as a 409. */
export type ArchiveEnableOutcome = 'enabled' | 'already-enabled';

// --- panels -----------------------------------------------------------------

/** One row of `GET /api/panels` — mirrors `OpsPanelSummary`. */
export interface PanelSummary {
  readonly panelId: string;
  readonly kind: string;
  readonly component: string;
  readonly behaviour: string;
  readonly status: string;
  readonly messageId: string | undefined;
  readonly optionCount: number;
}

/** `GET /api/panels/:id` — mirrors `OpsPanelDetail`. */
export interface PanelDetail extends PanelSummary {
  readonly channelId: string;
  readonly maxRoles: number | undefined;
  readonly requiredRoleId: string | undefined;
  readonly blockedRoleIds: readonly string[];
  readonly content?: string | undefined;
  readonly adoptionPassState: string;
  readonly adoptionBlockedCount: number;
  readonly options: readonly {
    readonly optionId: string;
    readonly roleId: string;
    readonly emojiKey: string | undefined;
    readonly label: string | undefined;
  }[];
}

/** `POST /api/panels/:id/publish` — mirrors `OpsPublishResult`. */
export interface PublishResult {
  readonly action: 'posted' | 'edited' | 'not-managed';
  readonly messageId: string | undefined;
  readonly reactionsSeeded: number;
  readonly reactionsFailed: readonly { emojiKey: string; error: string }[];
}

/** `POST /api/panels/:id/reconcile` and other enqueue answers — mirrors `OpsEnqueued`. */
export interface Enqueued {
  readonly enqueued: boolean;
  readonly jobId: number | undefined;
}

// --- settings ---------------------------------------------------------------

/** `POST /api/settings` bodies — the discriminated union `ops-write.ts` validates. */
export type SettingBody =
  | { readonly key: 'dry_run'; readonly value: boolean }
  | { readonly key: 'role_rate_per_min'; readonly value: number }
  | { readonly key: 'reconcile_budget'; readonly value: number }
  | { readonly key: 'breaker_threshold'; readonly value: number }
  | { readonly key: 'breaker'; readonly value: 'closed' };

/** `GET /api/config` — `redactedConfig()`: secrets are already `<redacted>` server-side. */
export type RedactedConfig = Readonly<Record<string, unknown>>;

// --- logging ----------------------------------------------------------------

/** One route of `GET /api/log-routes`'s `routes` — mirrors the route shape. */
export interface LogRoute {
  readonly routeId: string;
  readonly name: string;
  readonly channelId: string;
  readonly enabled: boolean;
  readonly includeContent: boolean;
  readonly createdAtMs: number;
  readonly eventKinds: readonly string[];
  readonly excludedChannelIds: readonly string[];
}

export interface LogRoutesResponse {
  readonly routes: readonly LogRoute[];
  /**
   * Absent on servers that predate the exclusions half of `read.ts`; the
   * Logging page falls back to an empty list rather than crashing.
   */
  readonly excludedChannels?: readonly string[];
}
