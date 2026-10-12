export {
  configSchema,
  isSecretConfigKey,
  SECRET_CONFIG_KEYS,
  type Config,
  type SecretConfigKey,
} from './config/schema.js';
export { parseConfig, redactConfig, ConfigError } from './config/load.js';
export {
  accountIdSchema,
  guildIdSchema,
  isAccountId,
  isSnowflakeId,
  parseAccountId,
  parseGuildId,
  parseSnowflakeId,
  snowflakeIdSchema,
  type AccountId,
  type GuildId,
  type SnowflakeId,
} from './ids.js';
export { createLogger, safeLogFields, type Logger } from './obs/logger.js';
export { DiscordApiError, DiscordErrorCode, RoleHierarchyError } from './discord/errors.js';
export type {
  AuditLogEntry,
  DiscordMember,
  DiscordMessageRef,
  DiscordPort,
  DiscordRole,
  DiscordThread,
  EmojiKey,
  FetchedMessage,
  InteractionRef,
  OutgoingMessage,
  ReactionUserPage,
  RecentMessage,
  RecentMessagesPage,
  ScheduledEvent,
  Snowflake,
} from './discord/port.js';
export type {
  AuditChangeValue,
  AuditLogChange,
  AuditLogEntryEvent,
  AutoModerationEvent,
  ConnectionEvent,
  DomainEvent,
  DomainEventKind,
  GuildEvent,
  InteractionEvent,
  MemberEvent,
  MessageEvent,
  NativeAutoModAction,
  NativeAutoModTrigger,
  ReactionEvent,
  RoleEvent,
  SlashCommandEvent,
  SlashCommandOption,
} from './discord/events.js';
export {
  customEmojiKey,
  emojiKeyFromGateway,
  isCustomEmojiKey,
  unicodeEmojiChars,
  unicodeEmojiKey,
} from './discord/emoji.js';
export {
  checkRoleAssignable,
  resolveAssignability,
  type Assignability,
} from './discord/assignability.js';
export { fingerprintOf, isLevelTriggered } from './pipeline/fingerprint.js';
export {
  Pipeline,
  type DedupeStore,
  type DispatchOutcome,
  type PipelineDeps,
  type Subscriber,
} from './pipeline/pipeline.js';
export {
  JobWorker,
  RetryAfterError,
  type AnyJobHandler,
  type ClaimFilter,
  type ClaimedJob,
  type FailOptions,
  type JobContext,
  type JobHandler,
  type JobStore,
  type JobWorkerDeps,
  type PayloadSchema,
  type RunOutcome,
} from './jobs/worker.js';
export {
  assistantOrderingKey,
  JOB_LANES,
  kindsInLane,
  laneOf,
  type JobLane,
} from './jobs/lanes.js';
export { LaneScheduler, type LaneConfig } from './jobs/scheduler.js';
export {
  assistantInvokeDedupeKey,
  assistantInvokePayload,
  type AssistantInvokePayload,
  assistantInvokeCursor,
  type AssistantInvokeCursor,
  assistantSummariseDedupeKey,
  assistantSummarisePayload,
  type AssistantSummarisePayload,
  adoptDedupeKey,
  adoptPanelPayload,
  archiveBackfillDedupeKey,
  archiveBackfillPayload,
  archiveExpiryDedupeKey,
  archiveExpiryPayload,
  conversationPruneDedupeKey,
  conversationPrunePayload,
  deliverRemindersDedupeKey,
  assistantDailyDigestDedupeKey,
  assistantDailyDigestPayload,
  deliverRemindersPayload,
  EVENT_DEDUPE_RETENTION_MS,
  JOB_KINDS,
  JOB_RETENTION_MS,
  logMessageDeleteDedupeKey,
  logMessageDeletePayload,
  modPurgeCursorSchema,
  modPurgePayload,
  pruneJobsDedupeKey,
  pruneJobsPayload,
  purgeDedupeKey,
  reconcileDedupeKey,
  reconcileGuildPayload,
  resourceRefreshDedupeKey,
  resourceRefreshPayload,
  sweepDedupeKey,
  sweepEventDedupePayload,
  undoBatchPayload,
  undoDedupeKey,
  type AdoptPanelPayload,
  type AssistantDailyDigestPayload,
  type ArchiveBackfillPayload,
  type ArchiveExpiryPayload,
  type ConversationPrunePayload,
  type DeliverRemindersPayload,
  type JobKind,
  type LogMessageDeletePayload,
  type ModPurgeCursor,
  type ModPurgePayload,
  type PruneJobsPayload,
  type ReconcileGuildPayload,
  type ResourceRefreshPayload,
  type SweepEventDedupePayload,
  type UndoBatchPayload,
} from './jobs/kinds.js';
export { createArchiveSubscriber } from './archive/subscriber.js';
export type { ArchiveAttachmentInput, ArchivePorts, UpsertMessageInput } from './archive/ports.js';
export { archiveBackfillHandler } from './archive/backfill.js';
export type { ArchiveChannel, BackfillPorts, BackfillState } from './archive/backfill.js';
export { archiveExpiryHandler } from './archive/expiry.js';
export type { ExpiryPorts } from './archive/expiry.js';
export {
  createConnectionSubscriber,
  type ConnectionPorts,
} from './pipeline/connection-subscriber.js';
export {
  formatMemberJoin,
  formatMemberLeave,
  formatMessageDelete,
  formatMessageEdit,
  formatRoleCreate,
  formatRoleDelete,
  formatRoleUpdate,
  formatWarn,
} from './logging/format.js';
export {
  createLoggingSubscriber,
  createLogPoster,
  LOG_EVENT_KINDS,
  type LoggingPorts,
  type LogItem,
  type LogRoute,
} from './logging/subscriber.js';
export {
  isSourceExcluded,
  routeAccepts,
  routeDedupeKind,
  type LogSource,
} from './logging/routing.js';
export {
  LOG_ACTION_CATALOG,
  LOG_ACTION_GROUPS,
  logActionInfo,
  type LogActionGroup,
  type LogActionInfo,
} from './logging/catalog.js';
export {
  logEventKindSchema,
  logRouteIdSchema,
  logRouteInputSchema,
  type LogRouteInput,
  type ResolvedLogRouteInput,
} from './logging/route-input.js';
export {
  correlateDeletion,
  MESSAGE_DELETE_ATTRIBUTION_DELAY_MS,
  type CorrelationCandidate,
} from './logging/attribution.js';
export {
  attributeAndLogDeletion,
  type MessageDeleteAttribution,
  type MessageDeleteAttributionPorts,
} from './logging/attribute-deletion.js';
export {
  authorize,
  capabilityOf,
  principalsOf,
  CAPABILITIES,
  type Actor,
  type ActorType,
  type Authorized,
  type AuthorizeInput,
  type AuthzStore,
  type Capability,
  type Denied,
  type DenialReason,
  type PrincipalRef,
  type Result,
} from './authz.js';
export {
  RateLimiter,
  TokenBucket,
  type EffectSource,
  type TokenBucketOptions,
} from './effects/rate-limit.js';
export {
  dedupeKeyFor,
  EffectGateway,
  type AuditInput,
  type ClaimedEffect,
  type EffectGatewayDeps,
  type EffectOutcome,
  type EffectRecordInput,
  type RefusalReason,
  type RoleIntent,
  type SafetyState,
} from './effects/gateway.js';
export {
  contentHashFor,
  DUPLICATE_CONTENT_WINDOW_MS,
  MESSAGE_SEND_RATE_LIMIT,
  MESSAGE_SEND_RATE_WINDOW_MS,
  sendMessageEffect,
  type MessageAuditInput,
  type MessageGatewayDeps,
  type MessageIntent,
  type MessageOutcome,
  type MessageRefusalReason,
  type SafetyStateForSend,
  type SendLedgerRow,
} from './effects/message-gateway.js';
export {
  argsHashFor,
  MCP_ACTION_CAPS,
  MCP_ACTION_DUPLICATE_WINDOW_MS,
  MCP_ACTION_WINDOW_MS,
  runMcpAction,
  type McpActionLedgerRow,
  type McpActionAuditInput,
  type McpActionClaim,
  type McpActionCompletion,
  type McpActionDeps,
  type McpActionIntent,
  type McpActionOutcome,
  type McpActionRefusal,
  type McpCapGroup,
} from './effects/mcp-action-gateway.js';
export {
  inverseOf,
  undoBatch,
  type UndoableEffect,
  type UndoAuthorization,
  type UndoInput,
  type UndoPorts,
  type UndoResult,
} from './effects/undo.js';
export {
  checkPurgeBudget,
  checkReconcileBudget,
  PURGE_MAX_MESSAGES,
  type BudgetDecision,
  type PurgeBudgetDecision,
} from './effects/budget.js';
export {
  ModerationActionGateway,
  type ModerationGatewayDeps,
  type ModerationIntent,
  type ModerationOutcome,
  type ModerationRefusalReason,
  type ModerationSafetyState,
} from './effects/moderation-gateway.js';
export {
  createAutomodSubscriber,
  type AutomodSafetyState,
  type AutomodSubscriberDeps,
  type AutomodSwitchState,
  type ModerationGatewayPort,
} from './automod/subscriber.js';
export { seedDefaultWordList, type SeedPorts } from './automod/seed.js';
export { createNativeAutomodSubscriber } from './automod/native-subscriber.js';
export type { NativeAutomodSubscriberDeps } from './automod/native-subscriber.js';
export {
  isRuleKind,
  RULE_KINDS,
  type AnyPredicate,
  type AutomodRule,
  type CompiledPredicate,
  type ConfigSchema,
  type MatchTrace,
  type Predicate,
  type PredicateInput,
  type PredicateMatch,
  type RuleKind,
} from './automod/predicates/types.js';
export {
  keywordFilterConfig,
  keywordFilterPredicate,
  type KeywordFilterConfig,
} from './automod/predicates/keyword-filter.js';
export {
  compileRule,
  predicateFor,
  validateRuleConfig,
  type CompileFailure,
  type CompileResult,
  type ConfigValidationFailure,
  type ConfigValidationResult,
} from './automod/predicates/registry.js';
export { ruleFingerprint } from './automod/fingerprint.js';
export {
  matchTraceSchema,
  parseMatchTrace,
  renderTrace,
  serialiseTrace,
  type ParseTraceResult,
} from './automod/trace.js';
export {
  createPredicateCache,
  evaluateRule,
  predicateCacheKey,
  predicateInputFrom,
  type CacheEntry,
  type EvaluateOutcome,
  type PredicateCache,
  type PredicateInputSource,
} from './automod/evaluate.js';
export {
  BULK_DELETE_CEILING_MS,
  PURGE_TICK_SPACING_MS,
  runPurgeTick,
  type PurgeCasePorts,
  type PurgePorts,
  type PurgeRefusalReason,
  type PurgeTickInput,
} from './mod/purge.js';
export {
  issueWarn,
  MANUAL_RULE_ID,
  type IssueWarnDeps,
  type IssueWarnInput,
  type IssueWarnResult,
  type WarnCasePorts,
} from './mod/warn.js';
export {
  createModCommandSubscriber,
  MAX_TIMEOUT_MS,
  MOD_COMMAND_NAME,
  type ModCommandCasePorts,
  type ModCommandDeps,
  type NoteEvidenceCasePorts,
} from './mod/commands.js';
export {
  handleHistory,
  type HistoryCase,
  type HistoryCaseEvent,
  type HistoryCasePorts,
  type HistoryDeps,
} from './mod/history.js';
export {
  banConfirmDedupeKey,
  buildConfirmCancelComponents,
  buildModCancelCustomId,
  buildModConfirmCustomId,
  createModConfirmationSubscriber,
  handleBanPreview,
  handlePurgePreview,
  modPendingActionPayload,
  parseModConfirmCustomId,
  PENDING_ACTION_TTL_MS,
  type ModConfirmationCasePorts,
  type ModConfirmationDeps,
  type ModPendingActionPayload,
  type ModPendingActionPorts,
  type ParsedModConfirmCustomId,
  type PendingActionRowLike,
} from './mod/confirmations.js';
export {
  emojiKeySchema,
  optionByEmoji,
  optionById,
  orderedOptions,
  panelDefinitionSchema,
  panelRoleIds,
  ADOPTION_PASS_STATES,
  MAX_PANEL_OPTIONS,
  PANEL_BEHAVIOURS,
  PANEL_COMPONENTS,
  PANEL_KINDS,
  PANEL_STATUSES,
  type AdoptionPassState,
  type PanelBehaviour,
  type PanelComponent,
  type PanelConfig,
  type PanelDefinition,
  type PanelKind,
  type PanelOption,
  type PanelStatus,
} from './panels/model.js';
export {
  intentsFor,
  isEmptyPlan,
  needsFullReactionState,
  planConvergence,
  type ConvergenceInput,
  type ConvergencePlan,
  type DeclinedOption,
  type IntentContext,
  type PanelRefusal,
} from './panels/convergence.js';
export type { PanelDiscordReader, PanelEffects, PanelStore } from './panels/ports.js';
export {
  convergeMember,
  createReactionSubscriber,
  pageReactors,
  ReactionStateCache,
  selectionFromReactions,
  type ConvergeMemberInput,
  type AppliedChange,
  type ConvergeMemberResult,
  type ReactionSubscriberDeps,
} from './panels/reactions.js';
export { seedPanelReactions, type SeedResult } from './panels/seed.js';
export {
  adoptionCursorSchema,
  runAdoptionPass,
  type AdoptionCursor,
  type AdoptionInput,
  type AdoptionOutcome,
  type AdoptionPorts,
  type AdoptionStatus,
} from './panels/adoption.js';
export { applyPlan } from './panels/reactions.js';
export {
  buildComponents,
  buildCustomId,
  buildSelectCustomId,
  CUSTOM_ID_PREFIX,
  isSelectCustomId,
  parseCustomId,
  renderPanelMessage,
  type ParsedCustomId,
} from './panels/components.js';
export {
  createInteractionSubscriber,
  describeResult,
  selectionAfterClick,
  type InteractionSubscriberDeps,
  type PanelResponder,
} from './panels/interactions.js';
export {
  editManagedPanel,
  postManagedPanel,
  type PanelPublisher,
  type PublishDeps,
} from './panels/publish.js';
export {
  createMemberUpdateSubscriber,
  reconcileGuild,
  type MemberUpdatePorts,
  type ReconcileOutcome,
  type ReconcilePorts,
  type ReconcileStatus,
} from './panels/reconcile.js';

// --- the operator surface (ADR 0013, ADR 0024) -------------------------------
export {
  exitCodeFor,
  jsonValueSchema,
  opsRequestSchema,
  opsResponseSchema,
  OPS_ERROR_CODES,
  OPS_MAX_LINE_BYTES,
  OPS_PROTOCOL_VERSION,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  type JsonValue,
  type OpsError,
  type OpsErrorCode,
  type OpsOk,
  type OpsRequest,
  type OpsResponse,
} from './ops/protocol.js';
export {
  createDispatcher,
  defineCommand,
  type Dispatcher,
  type DispatcherDeps,
  type OpsAnyResult,
  type OpsAuditRecord,
  type OpsCommand,
  type OpsCommandResult,
  type OpsContext,
  type OpsFlag,
  type OpsGuildContext,
  type OpsParam,
  type OpsReadCommand,
  type OpsWriteCommand,
  type OpsWriteResult,
  type RegisteredCommand,
} from './ops/dispatch.js';
export { OPERATOR_COMMANDS } from './ops/registry.js';
export { OPS_AUDIT_ACTIONS, type OpsAuditAction } from './ops/audit-actions.js';
export type {
  OpsAuditQuery,
  OpsAuditRow,
  OpsAuditWrite,
  OpsAutomodRuleDetail,
  OpsAutomodRuleSummary,
  OpsBatchRow,
  OpsCase,
  OpsCaseDetail,
  OpsCaseEvent,
  OpsEnqueued,
  OpsGatewayState,
  OpsInstance,
  OpsJobQuery,
  OpsGuildMemberInfo,
  OpsJobRow,
  OpsNativeHit,
  OpsPanelDetail,
  OpsPanelSummary,
  OpsPorts,
  OpsAutomodState,
  OpsPublishResult,
  OpsRetryOutcome,
  OpsSafetyState,
  OpsSendAllowlistEntry,
  OpsSendRecord,
  OpsUndoableCount,
  OpsVerdictCounts,
} from './ops/ports.js';
export {
  findSetting,
  OPS_SETTINGS,
  parseSettingValue,
  type OpsSettingChange,
  type OpsSettingSpec,
} from './ops/settings.js';
export {
  INSTANCE_SETTINGS,
  isInstanceSettingKey,
  settingDefinition,
  type InstanceSettingKey,
  type InstanceSettingValues,
  type SettingDefinition,
  type SettingDisplay,
  type SettingGroup,
} from './settings/instance-settings.js';
export {
  ACCOUNT_ROLES,
  CAPABILITY_INFO,
  roleForCapabilities,
  type AccountRole,
  type AccountRoleId,
  type CapabilityInfo,
} from './account-roles.js';
export { statusCommand, humaniseDuration } from './ops/commands/status.js';
export type { SlashResponder } from './ops/commands/slash-responder.js';
export { killswitchCommand } from './ops/commands/killswitch.js';
export { adoptionAllowCommand, panelSyncCommand, undoCommand } from './ops/commands/effects.js';
export {
  configSetCommand,
  jobsRetryCommand,
  logRoutingCreateCommand,
  logRoutingDeleteCommand,
  logRoutingExcludeCommand,
  logRoutingOffCommand,
  logRoutingOnCommand,
  logRoutingUnexcludeCommand,
  logRoutingUpdateCommand,
} from './ops/commands/writes.js';
export {
  auditTailCommand,
  configGetCommand,
  doctorCommand,
  jobsListCommand,
  logRoutingListCommand,
  panelListCommand,
  panelShowCommand,
  parseDuration,
} from './ops/commands/reads.js';

export { MCP_SCOPE_INFO, mcpScopeLabel } from './ops/mcp-scopes.js';
export { GUIDE_TOPICS, findGuideTopic, type GuideTopic } from './guide/index.js';
export * from './channels/scope.js';
export * from './channels/access.js';
export type {
  GenerateTextRequest,
  GenerateTextResponse,
  GenerationMedia,
  GenerationMessage,
  ProviderCapability,
  ProviderEligibility,
  ProviderUsage,
  StreamChunk,
  StreamProgress,
  TextProvider,
  ToolCall,
  ToolDeclaration,
} from './providers/contracts.js';
export { ProviderError, type ProviderErrorKind } from './providers/errors.js';
export {
  classifyProviderFailure,
  netCodeOf,
  NET_ERROR_CODES,
  PROVIDER_FAILURE_CODES,
  PROVIDER_FAILURE_TEXT,
  type FailureText,
  type NetErrorCode,
  type ProviderFailure,
  type ProviderFailureCode,
} from './providers/failure.js';
export { sanitizeProviderMessage } from './providers/provider-message.js';
export {
  assertProviderEligible,
  providerMayTrain,
  type ProviderAudience,
} from './providers/eligibility.js';
export {
  GeminiProvider,
  listGeminiModels,
  type GeminiModelInfo,
  type GeminiProviderOptions,
} from './providers/gemini.js';
export {
  assertOutboundRequestSafe,
  detectWithheldEvidence,
  redactEvidenceText,
  scanOutboundRequest,
  type OutboundSafetyResult,
  type SafetyFinding,
  type SafetyFindingKind,
} from './providers/outbound-safety.js';
export {
  OpenAiCompatibleProvider,
  createNvidiaNimProvider,
  createOpenRouterProvider,
  type OpenAiCompatibleProviderOptions,
} from './providers/openai-compatible.js';
export { SafeProvider } from './providers/safe-provider.js';
export {
  nextProviderDayStart,
  providerDayStart,
  providerDayZone,
} from './providers/provider-day.js';
export {
  assertSpendAllowed,
  type ProviderCostClass,
  type SpendPolicy,
} from './providers/spend-policy.js';
export * from './assistant/index.js';
export * from './assistant/capabilities.js';
export * from './assistant/run-events.js';
export * from './assistant/live-buffer.js';
export * from './assistant/run-label.js';

export {
  createTaskCommandSubscriber,
  type TaskCommandDeps,
  type TaskCommandRow,
} from './task/commands.js';
export { isValidTimeZone, timeZoneSchema } from './task/timezone.js';
export {
  staleTaskPostsEnvWarning,
  taskPostsBannerText,
  taskPostsMessage,
  taskPostsOffText,
  taskPostsState,
  type TaskPostKind,
  type TaskPostsOffReason,
  type TaskPostsState,
} from './task/posts.js';
export { ACK_PHRASES, isProgressUpdate } from './task/progress.js';
export {
  buildTaskEvaluationInput,
  parseTaskEvaluation,
  TASK_EVALUATION_INSTRUCTION,
  taskEvaluationSchema,
  type TaskEvaluation,
} from './task/evaluate.js';
export {
  buildCompleteSelect,
  buildPickComponents,
  buildReviewComponents,
  buildTaskCustomId,
  parseTaskCustomId,
  TASK_CUSTOM_ID_PREFIX,
  TASK_REPLY_NOTICE,
  type ParsedTaskCustomId,
} from './task/components.js';
export {
  cleanSummary,
  conversationSummarySchema,
  parseSummaryJson,
  renderSummary,
  type ConversationSummary,
} from './assistant/conversation-summary.js';

export {
  ADMINISTRATOR,
  BAN_MEMBERS,
  DANGEROUS_PERMISSION_BITS,
  isDangerousRole,
  KICK_MEMBERS,
  MANAGE_CHANNELS,
  MANAGE_EVENTS,
  MANAGE_GUILD,
  MANAGE_GUILD_EXPRESSIONS,
  MANAGE_MESSAGES,
  MANAGE_ROLES,
  MANAGE_THREADS,
  MANAGE_WEBHOOKS,
  MENTION_EVERYONE,
  MODERATE_MEMBERS,
  rolePingAllowed,
  type RoleFacts,
  type RolePingRefusal,
} from './roles/dangerous.js';
export * from './providers/model-capabilities.js';
export * from './providers/gemini-quota.js';
export * from './assistant/router.js';
