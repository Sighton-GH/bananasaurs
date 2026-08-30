export {
  configSchema,
  isSecretConfigKey,
  SECRET_CONFIG_KEYS,
  type Config,
  type SecretConfigKey,
} from './config/schema.js';
export { parseConfig, redactConfig, ConfigError } from './config/load.js';
export {
  guildIdSchema,
  isSnowflakeId,
  parseGuildId,
  parseSnowflakeId,
  snowflakeIdSchema,
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
  EmojiKey,
  InteractionRef,
  OutgoingMessage,
  ReactionUserPage,
  Snowflake,
} from './discord/port.js';
export type {
  ConnectionEvent,
  DomainEvent,
  DomainEventKind,
  GuildEvent,
  InteractionEvent,
  MemberEvent,
  MessageEvent,
  ReactionEvent,
  RoleEvent,
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
  type AnyJobHandler,
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
  adoptDedupeKey,
  adoptPanelPayload,
  JOB_KINDS,
  logMessageDeleteDedupeKey,
  logMessageDeletePayload,
  reconcileDedupeKey,
  reconcileGuildPayload,
  sweepDedupeKey,
  sweepEventDedupePayload,
  type AdoptPanelPayload,
  type JobKind,
  type LogMessageDeletePayload,
  type ReconcileGuildPayload,
  type SweepEventDedupePayload,
} from './jobs/kinds.js';
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
} from './logging/format.js';
export { createLoggingSubscriber, type LoggingPorts, type LogRoute } from './logging/subscriber.js';
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
  inverseOf,
  undoBatch,
  type UndoableEffect,
  type UndoAuthorization,
  type UndoInput,
  type UndoPorts,
  type UndoResult,
} from './effects/undo.js';
export { checkReconcileBudget, type BudgetDecision } from './effects/budget.js';
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
  type OpsCommand,
  type OpsCommandResult,
  type OpsContext,
  type OpsFlag,
  type OpsGuildContext,
  type OpsParam,
  type RegisteredCommand,
} from './ops/dispatch.js';
export { OPERATOR_COMMANDS } from './ops/registry.js';
export type { OpsGatewayState, OpsInstance, OpsPorts, OpsSafetyState } from './ops/ports.js';
export { statusCommand, humaniseDuration } from './ops/commands/status.js';
