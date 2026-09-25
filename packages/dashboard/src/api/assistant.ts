import type {
  AssistantBehaviour,
  AssistantSkill,
  ClubResource,
  JSONSchema,
  JSONSchemaProperty,
  ReminderStatus,
} from '@bananasaurs/core';

/**
 * The dashboard's side of the assistant API contract. GET /api/assistant
 * aggregates everything the Release 3 pages need; the optional fields are
 * the Release 3 configuration surface and stay absent on server builds that
 * do not expose them yet, in which case the matching controls fail closed
 * (they say so and offer no editing) rather than pretending to work.
 */

export interface ReminderRow {
  readonly id: string;
  readonly text: string;
  readonly dueAt: number;
  readonly destinationId: string;
  readonly status: ReminderStatus;
}

export interface ActivityRow {
  readonly id: string;
  readonly at: number;
  readonly behaviourId: string;
  readonly skillId: string;
  readonly outcome: string;
  readonly detail?: string;
}

/** A role from the live guild directory. Pickers offer these; ids are never typed by hand. */
export interface GuildRoleInfo {
  readonly id: string;
  readonly name: string;
  readonly position: number;
}

/** A channel from the live guild directory, for ticket routing. */
export interface GuildChannelInfo {
  readonly id: string;
  readonly name: string;
}

/** A member from the live guild directory, for grants that name one person. */
export interface GuildMemberInfo {
  readonly id: string;
  /** Display name as operators know the member; the id stays the identity. */
  readonly name: string;
}

/** Who may use one skill, guild-wide. An absent or empty grant fails closed: nobody may use it. */
export interface SkillGrant {
  readonly skillId: string;
  readonly roleIds: readonly string[];
  readonly userIds: readonly string[];
}

export interface AssistantBehaviourView extends Omit<AssistantBehaviour, 'callerRoleIds'> {
  /**
   * Roles whose members may invoke this behaviour by tag or direct command.
   * `undefined` means the server build does not expose the allowlist yet;
   * an empty array fails closed (the tag answers nobody).
   */
  readonly callerRoleIds?: readonly string[];
  /**
   * Ticket escalation for behaviours that hand requests to humans (today:
   * @it-services). `undefined` means the server build does not expose ticket
   * routing yet; a present value with no channelId fails closed (no ticket
   * is created until a channel is chosen).
   */
  readonly ticket?: {
    readonly channelId?: string;
    readonly reviewerRoleIds?: readonly string[];
  };
}

/** A /decision or /review-plan record. Drafts are analysis, not club policy, until confirmed and saved. */
export interface DecisionRow {
  readonly id: string;
  readonly kind: 'decision' | 'review-plan' | 'memory';
  readonly summary: string;
  readonly status: 'draft' | 'reviewed' | 'saved';
  /** Who asked, and where the content came from, so a draft never reads as policy. */
  readonly requesterId: string;
  readonly provenance: string;
  readonly at: number;
}

/** One escalation ticket created in Discord for IT members to review. */
export interface TicketRow {
  readonly id: string;
  readonly behaviourId: string;
  readonly channelId: string;
  readonly requesterId: string;
  readonly summary: string;
  readonly status: 'open' | 'claimed' | 'resolved';
  readonly at: number;
}

export interface AssistantData {
  readonly behaviours: readonly AssistantBehaviourView[];
  readonly resources: readonly ClubResource[];
  readonly reminders: readonly ReminderRow[];
  readonly skills: readonly AssistantSkill[];
  readonly activity: readonly ActivityRow[];
  readonly roles?: readonly GuildRoleInfo[];
  readonly members?: readonly GuildMemberInfo[];
  readonly channels?: readonly GuildChannelInfo[];
  readonly skillGrants?: readonly SkillGrant[];
  readonly tickets?: readonly TicketRow[];
  readonly decisions?: readonly DecisionRow[];
  readonly serverCard?: string;
  readonly memories?: readonly {
    id: string;
    section: string;
    content: string;
    subjectId?: string;
  }[];
  readonly aiStatus?: AiStatus;
  readonly setup?: AssistantSetup;
  readonly providerTerms?: ProviderTerms | null;
  readonly viewerIsOwner?: boolean;
  /** ADR 0065: guild-wide assistant settings. */
  readonly settings?: { readonly logChannelId?: string };
}

export const ASSISTANT_URL = '/api/assistant';
export type ProviderId = 'off' | 'gemini' | 'openrouter' | 'nvidia-nim';
export interface AiStatus {
  readonly provider: string;
  readonly model?: string;
  readonly enabled: boolean;
  readonly modelConfigured: boolean;
  readonly keyConfigured: boolean;
  readonly keyReadable: boolean;
  readonly costClass: 'free' | 'paid' | 'unknown';
  readonly secretSource: 'env' | 'file' | 'missing';
  readonly secretProblem?: 'key-file-permissions' | 'key-file-invalid' | 'readonly-no-key-file';
  /** ADR 0068: up to two more models, tried in order when the one before is busy. */
  readonly fallbackModels?: readonly string[];
  /** ADR 0066. Absent while no Brave key is saved and search is off. */
  readonly webSearch?: { readonly keyConfigured: boolean; readonly enabled: boolean };
}
export type SetupStepId = 'connect' | 'terms' | 'cost' | 'who' | 'skills' | 'on';
export interface SetupStep {
  readonly id: SetupStepId;
  /** `warning` counts as complete: it works, with a caveat the owner accepted (ADR 0062). */
  readonly state: 'done' | 'todo' | 'blocked' | 'warning';
  readonly detail: string;
}
export interface AssistantSetup {
  readonly steps: readonly SetupStep[];
  readonly answering: boolean;
}
export interface ProviderTerms {
  readonly provider: string;
  readonly trainsOnInput: 'no' | 'yes' | 'unknown';
  readonly evidenceUrl: string;
  readonly evidenceClause?: string;
  readonly productionUseAllowed: boolean;
  readonly reviewedAt: number;
}
/** Display names and links; the only place a provider id is turned into words. */
export const PROVIDERS: readonly {
  readonly id: Exclude<ProviderId, 'off'>;
  readonly name: string;
  readonly summary: string;
  readonly termsUrl: string;
  readonly keyUrl: string;
  readonly modelHint: string;
}[] = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    summary: 'Sends member questions and allowed server context to Google.',
    termsUrl: 'https://ai.google.dev/gemini-api/terms',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    modelHint: 'For example gemini-2.5-flash',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    summary:
      'Sends member questions and allowed server context through OpenRouter to the model you name.',
    termsUrl: 'https://openrouter.ai/terms',
    keyUrl: 'https://openrouter.ai/settings/keys',
    modelHint: 'The model id from OpenRouter, for example a model ending in :free',
  },
  {
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    summary: 'Sends member questions and allowed server context to NVIDIA.',
    termsUrl: 'https://www.nvidia.com/en-us/data-center/products/nvidia-ai-enterprise/eula/',
    keyUrl: 'https://build.nvidia.com/',
    modelHint: 'The model id from build.nvidia.com',
  },
];
export const providerName = (id: string): string =>
  PROVIDERS.find((p) => p.id === id)?.name ?? (id === 'off' ? 'None' : 'Unknown service');
export const PROVIDER_URL = '/api/assistant/provider';
/** ADR 0068: the models a pasted or saved key can use. */
export const PROVIDER_MODELS_URL = '/api/assistant/provider/models';
export interface ModelInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}
export const providerTermsUrl = (provider: string) =>
  `/api/providers/${encodeURIComponent(provider)}/terms`;
/** Task 8: several labelled keys across several providers, one ordered model chain. */
export const ASSISTANT_PROVIDERS_URL = '/api/assistant/providers';
export const ASSISTANT_KEYS_URL = '/api/assistant/keys';
export const assistantKeyUrl = (keyId: string) =>
  `/api/assistant/keys/${encodeURIComponent(keyId)}`;
export const MODEL_CHAIN_URL = '/api/assistant/model-chain';
export const MODEL_CHAIN_TEST_URL = '/api/assistant/model-chain/test';
export const GITHUB_TOKEN_URL = '/api/assistant/github-token';
export type SetupEligibility = 'eligible' | 'may-train' | 'ineligible' | 'unverified';
export type ChainStatus =
  | 'ready'
  | 'no-key'
  | 'key-unreadable'
  | 'disabled'
  | 'ineligible'
  | 'unverified'
  | 'allowance-used';
export interface SetupProviderRow {
  readonly provider: string;
  readonly eligibility: SetupEligibility;
  readonly supportsTools: boolean;
  readonly keyCount: number;
}
export interface SetupKeyRow {
  readonly keyId: string;
  readonly provider: string;
  readonly label: string;
  readonly costClass: 'free' | 'paid' | 'unknown';
  readonly enabled: boolean;
  readonly readable: boolean;
  readonly allowanceResetsAt?: number;
}
export interface SetupChainRow {
  readonly position: number;
  readonly keyId: string;
  readonly keyLabel: string;
  readonly provider: string;
  readonly model: string;
  readonly status: ChainStatus;
  readonly allowanceResetsAt?: number;
}
export interface AssistantSetupData {
  readonly providers: readonly SetupProviderRow[];
  readonly keys: readonly SetupKeyRow[];
  readonly chain: readonly SetupChainRow[];
  readonly webSearch: { readonly keyConfigured: boolean; readonly enabled: boolean };
  readonly github: { readonly tokenConfigured: boolean };
}
/** ADR 0063: which behaviour answers a tag of the bot user itself. */
export const BOT_TAG_URL = '/api/assistant/bot-tag';
/** ADR 0065: the AI log channel. */
export const LOG_CHANNEL_URL = '/api/assistant/log-channel';
export const behaviourUrl = (id: string) => `/api/assistant/behaviours/${encodeURIComponent(id)}`;
/** `GET /api/assistant/behaviours/:id/preview` (Task 18): the full compiled prompt with sizes. */
export const behaviourPreviewUrl = (id: string) =>
  `/api/assistant/behaviours/${encodeURIComponent(id)}/preview`;
/** `GET /api/assistant/safety-suffix` (Task 18): the locked suffix the wizard shows read-only. */
export const SAFETY_SUFFIX_URL = '/api/assistant/safety-suffix';

export interface PreviewSection {
  readonly name: string;
  readonly chars: number;
  readonly estTokens: number;
  readonly text: string;
}

export interface BehaviourPreview {
  readonly sections: readonly PreviewSection[];
  readonly totalChars: number;
  readonly totalEstTokens: number;
}

export interface SafetySuffix {
  readonly version: number;
  readonly text: string;
}
export const reminderCancelUrl = (id: string) =>
  `/api/assistant/reminders/${encodeURIComponent(id)}/cancel`;
export const decisionReviewUrl = (id: string) =>
  `/api/assistant/decisions/${encodeURIComponent(id)}/review`;
export const decisionSaveUrl = (id: string) =>
  `/api/assistant/decisions/${encodeURIComponent(id)}/save`;
export const resourceUrl = (id: string) => `/api/assistant/resources/${encodeURIComponent(id)}`;
/** ADR 0073: cached-document freshness per resource — fetchedAt/chunks/bytes/lastError, one row per resource that has ever been cached. */
export interface ResourceFreshnessRow {
  readonly resourceId: string;
  readonly fetchedAt?: number;
  readonly chunks: number;
  readonly bytes: number;
  readonly lastError?: string;
}
export const RESOURCE_FRESHNESS_URL = '/api/assistant/resources/freshness';
export const resourceRefreshUrl = (id: string) =>
  `/api/assistant/resources/${encodeURIComponent(id)}/refresh`;
export const RESOURCE_REFRESH_ALL_URL = '/api/assistant/resources/refresh';
/** Task 17: "Add from GitHub" — preview a repo/org URL, then import it as cached resources. */
export const GITHUB_PREVIEW_URL = '/api/assistant/github/preview';
export const GITHUB_IMPORT_URL = '/api/assistant/github/import';
export type GithubPreviewTarget =
  | { readonly kind: 'org'; readonly owner: string }
  | {
      readonly kind: 'repo';
      readonly owner: string;
      readonly repo: string;
      readonly branch?: string;
    };
export interface GithubPreviewRepo {
  readonly name: string;
  readonly description: string | null;
  readonly fork: boolean;
  readonly archived: boolean;
}
export interface GithubPreview {
  readonly target: GithubPreviewTarget;
  readonly authenticated: boolean;
  readonly repos?: readonly GithubPreviewRepo[];
  readonly truncated?: boolean;
  readonly files?: readonly string[];
}
export interface GithubImportResult {
  readonly created: number;
}
export const skillGrantUrl = (skillId: string) =>
  `/api/assistant/skill-grants/${encodeURIComponent(skillId)}`;
export const STARTER_URL = '/api/assistant/skill-grants/starter';

/** `GET /api/assistant/skills/:skillId` (Task 9): one skill in full. */
export const skillUrl = (skillId: string) => `/api/assistant/skills/${encodeURIComponent(skillId)}`;

export interface SkillBehaviourRow {
  readonly id: string;
  readonly name: string;
  readonly allowed: boolean;
}
export interface SkillCommandOption {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}
export interface SkillCommand {
  readonly name: string;
  readonly options: readonly SkillCommandOption[];
}
/** One property of a tool's parameters, as the daemon declares it. */
export type SkillToolParameter = JSONSchemaProperty;
export interface SkillTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema;
  readonly rounds: 'first' | 'all';
  readonly outputLimit: string;
}
export interface SkillDetail {
  readonly skill: AssistantSkill;
  readonly instructionLine: string;
  readonly behaviours: readonly SkillBehaviourRow[];
  readonly whoCanUse: string;
  readonly tools: readonly SkillTool[];
  readonly command?: SkillCommand;
  readonly recentRuns: readonly ActivityRow[];
}
