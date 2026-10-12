import { z } from 'zod';
import {
  DIGEST_DEFAULT_HOUR,
  DIGEST_DEFAULT_INPUT_CHARS,
  DIGEST_DEFAULT_MAX_PROPOSALS,
} from '../assistant/digest.js';

export type SettingDisplay =
  | 'seconds'
  | 'milliseconds'
  | 'minutes'
  | 'count'
  | 'text'
  | 'secret'
  | 'seconds-list'
  | 'host-list';
export type SettingGroup =
  | 'Assistant retries'
  | 'Assistant tool loop'
  | 'Assistant context'
  | 'Assistant replies'
  | 'Network'
  | 'Resources'
  | 'MCP connector'
  | 'Assistant attachments';

export interface SettingDefinition<T> {
  readonly key: string;
  readonly group: SettingGroup;
  readonly label: string;
  readonly help: string;
  readonly display: SettingDisplay;
  readonly schema: z.ZodType<T>;
  readonly defaultValue: T;
  readonly bounds?: { readonly min?: number; readonly max?: number; readonly maxItems?: number };
  readonly secret?: true;
}

const RESERVED = new Set([
  'host',
  'authorization',
  'cookie',
  'content-length',
  'content-type',
  'connection',
  'transfer-encoding',
  'if-none-match',
  'if-modified-since',
  'user-agent',
  'accept',
  'accept-encoding',
]);

const retryDelays: SettingDefinition<number[]> = {
  key: 'assistant.retryDelaysMs',
  group: 'Assistant retries',
  label: 'Retry delays',
  help: 'How long to wait before retrying when every AI model was busy or timed out. Up to 4 retries, 3 minutes in total. Leave empty to answer at once without retrying.',
  display: 'seconds-list',
  schema: z
    .array(z.number().int().min(1000).max(180000))
    .max(4)
    .refine((a) => a.reduce((s, x) => s + x, 0) <= 180000, {
      message: 'Retry delays must add up to 3 minutes or less.',
    }),
  defaultValue: [10000, 30000, 90000],
  bounds: { min: 1000, max: 180000, maxItems: 4 },
};

const providerTimeout: SettingDefinition<number> = {
  key: 'assistant.providerTimeoutMs',
  group: 'Assistant retries',
  label: 'Provider request timeout',
  help: 'How long one request to an AI provider may take before it is abandoned.',
  display: 'seconds',
  schema: z.number().int().min(5000).max(120000),
  defaultValue: 60000,
  bounds: { min: 5000, max: 120000 },
};

const providerIdleTimeout: SettingDefinition<number> = {
  key: 'assistant.providerIdleTimeoutMs',
  group: 'Assistant retries',
  label: 'Provider idle timeout',
  help: 'How long one AI answer may go without any data before it is abandoned. Keepalive messages count as data.',
  display: 'seconds',
  schema: z.number().int().min(5000).max(120000),
  defaultValue: 45000,
  bounds: { min: 5000, max: 120000 },
};

const providerMaxCall: SettingDefinition<number> = {
  key: 'assistant.providerMaxCallMs',
  group: 'Assistant retries',
  label: 'Provider max call time',
  help: 'The longest one AI answer may take in total, even when data keeps arriving.',
  display: 'seconds',
  schema: z.number().int().min(60000).max(600000),
  defaultValue: 300000,
  bounds: { min: 60000, max: 600000 },
};

const maxConcurrentRuns: SettingDefinition<number> = {
  key: 'assistant.maxConcurrentRuns',
  group: 'Assistant retries',
  label: 'Questions answered at once',
  help: 'How many questions the assistant may answer at the same time, in different channels. Questions in one channel are always answered one at a time.',
  display: 'count',
  schema: z.number().int().min(1).max(8),
  defaultValue: 4,
  bounds: { min: 1, max: 8 },
};

const maxToolRounds: SettingDefinition<number> = {
  key: 'assistant.maxToolRounds',
  group: 'Assistant tool loop',
  label: 'Max tool rounds',
  help: 'How many rounds of tool use (searching resources, reading pages) one question may take.',
  display: 'count',
  schema: z.number().int().min(1).max(8),
  defaultValue: 4,
  bounds: { min: 1, max: 8 },
};

const maxToolCalls: SettingDefinition<number> = {
  key: 'assistant.maxToolCalls',
  group: 'Assistant tool loop',
  label: 'Max tool calls per question',
  help: 'How many tool calls one question may make in total.',
  display: 'count',
  schema: z.number().int().min(1).max(30),
  defaultValue: 12,
  bounds: { min: 1, max: 30 },
};

const maxOutputTokens: SettingDefinition<number> = {
  key: 'assistant.maxOutputTokens',
  group: 'Assistant tool loop',
  label: 'Max answer length (tokens)',
  help: 'The longest answer a model may write, in tokens (about 4 characters each).',
  display: 'count',
  schema: z.number().int().min(256).max(8192),
  defaultValue: 4096,
  bounds: { min: 256, max: 8192 },
};

const channelContextMessages: SettingDefinition<number> = {
  key: 'assistant.channelContextMessages',
  group: 'Assistant context',
  label: 'Channel messages sent with each question',
  help: 'Recent messages from the channel the bot was tagged in, sent to the AI as background. 0 turns this off.',
  display: 'count',
  schema: z.number().int().min(0).max(50),
  defaultValue: 15,
  bounds: { min: 0, max: 50 },
};

const digestEnabled: SettingDefinition<number> = {
  key: 'assistant.digestEnabled',
  group: 'Assistant context',
  label: 'Daily digest on or off',
  help: '1 runs the daily digest every morning at the hour below; 0 turns it off. The digest summarises that day\u2019s conversations and drafts memory proposals for owner review.',
  display: 'count',
  schema: z.number().int().min(0).max(1),
  defaultValue: 1,
  bounds: { min: 0, max: 1 },
};

const digestHour: SettingDefinition<number> = {
  key: 'assistant.digestHour',
  group: 'Assistant context',
  label: 'Daily digest hour',
  help: 'The local hour (0\u201323) in the club\u2019s time zone when the daily digest may first run. The hourly tick enqueues it the first time it runs at or past this hour.',
  display: 'count',
  schema: z.number().int().min(0).max(23),
  defaultValue: DIGEST_DEFAULT_HOUR,
  bounds: { min: 0, max: 23 },
};

const digestInputChars: SettingDefinition<number> = {
  key: 'assistant.digestInputChars',
  group: 'Assistant context',
  label: 'Daily digest input cap',
  help: 'How many characters of that day\u2019s conversations the digest may send to the AI, newest first. Larger days are trimmed to fit, newest kept, in one AI call.',
  display: 'count',
  schema: z.number().int().min(4_000).max(200_000),
  defaultValue: DIGEST_DEFAULT_INPUT_CHARS,
  bounds: { min: 4_000, max: 200_000 },
};

const digestMaxProposals: SettingDefinition<number> = {
  key: 'assistant.digestMaxProposals',
  group: 'Assistant context',
  label: 'Daily digest max proposals',
  help: 'How many memory proposals one digest may file for owner review. Duplicates of existing memory or pending drafts are dropped first.',
  display: 'count',
  schema: z.number().int().min(1).max(10),
  defaultValue: DIGEST_DEFAULT_MAX_PROPOSALS,
  bounds: { min: 1, max: 10 },
};

/** ADR 0144 defaults, mirroring DEFAULT_ROUTER_RULES so registry and router agree. */
export const DEFAULT_ROUTER_KEYWORDS: readonly string[] = [
  'remind',
  'schedule',
  'task',
  'ping',
  'search',
  'look up',
  'summar',
  'explain',
  'why',
  'how',
  'write',
  'story',
  'code',
  'plan',
  'compare',
  'translate',
  'fix',
];

export const DEFAULT_ROUTER_GREETINGS: readonly string[] = [
  'hi',
  'hello',
  'hey',
  'thanks',
  'thank you',
  'thx',
  'good morning',
  'good night',
];

const routerEnabled: SettingDefinition<number> = {
  key: 'assistant.routerEnabled',
  group: 'Assistant context',
  label: 'Complexity routing on/off',
  help: 'When on, short simple messages try the light tier first so greetings never spend the standard daily quota. 1 is on, 0 is off.',
  display: 'count',
  schema: z.number().int().min(0).max(1),
  defaultValue: 1,
  bounds: { min: 0, max: 1 },
};

const routerMaxChars: SettingDefinition<number> = {
  key: 'assistant.routerMaxChars',
  group: 'Assistant context',
  label: 'Router: longest light message',
  help: 'A message longer than this many characters always uses the standard tier.',
  display: 'count',
  schema: z.number().int().min(10).max(1000),
  defaultValue: 80,
  bounds: { min: 10, max: 1000 },
};

const routerFullModelKeywords: SettingDefinition<string[]> = {
  key: 'assistant.routerFullModelKeywords',
  group: 'Assistant context',
  label: 'Router: full-model keywords',
  help: 'A message containing one of these always uses the standard tier. Shown as an editable chip list.',
  display: 'text',
  schema: z.array(z.string().min(1).max(40)).min(1).max(40),
  defaultValue: [...DEFAULT_ROUTER_KEYWORDS],
  bounds: { maxItems: 40 },
};

const routerGreetingPatterns: SettingDefinition<string[]> = {
  key: 'assistant.routerGreetingPatterns',
  group: 'Assistant context',
  label: 'Router: greeting patterns',
  help: 'Messages matching one of these stay on the light tier even in long conversations. Shown as an editable chip list.',
  display: 'text',
  schema: z.array(z.string().min(1).max(40)).min(1).max(40),
  defaultValue: [...DEFAULT_ROUTER_GREETINGS],
  bounds: { maxItems: 40 },
};

const routerLongThreadTurns: SettingDefinition<number> = {
  key: 'assistant.routerLongThreadTurns',
  group: 'Assistant context',
  label: 'Router: long-thread turns',
  help: 'Past this many earlier turns a plain follow-up uses the standard tier; greetings stay light.',
  display: 'count',
  schema: z.number().int().min(0).max(50),
  defaultValue: 4,
  bounds: { min: 0, max: 50 },
};

const routerEscalateOnTool: SettingDefinition<number> = {
  key: 'assistant.routerEscalateOnTool',
  group: 'Assistant context',
  label: 'Router: escalate on tool use',
  help: 'When on, a light run that calls a tool switches to the standard tier for its next round. 1 is on, 0 is off.',
  display: 'count',
  schema: z.number().int().min(0).max(1),
  defaultValue: 1,
  bounds: { min: 0, max: 1 },
};

const routerSummaryTier: SettingDefinition<'light' | 'standard'> = {
  key: 'assistant.routerSummaryTier',
  group: 'Assistant context',
  label: 'Tier for conversation summaries',
  help: 'Rolling summaries run on this tier so they never spend the standard daily quota unless you ask.',
  display: 'text',
  schema: z.enum(['light', 'standard']),
  defaultValue: 'light',
};

const routerDailyDigestTier: SettingDefinition<'light' | 'standard'> = {
  key: 'assistant.routerDailyDigestTier',
  group: 'Assistant context',
  label: 'Tier for the daily digest',
  help: 'The daily digest runs on this tier, after the midnight quota reset. Slice 5 consumes this key.',
  display: 'text',
  schema: z.enum(['light', 'standard']),
  defaultValue: 'light',
};

const connectFallback: SettingDefinition<number> = {
  key: 'network.connectFallbackMs',
  group: 'Network',
  label: 'Connect fallback wait (IPv4/IPv6)',
  help: "How long to try IPv6 before falling back to IPv4 (or the other way round) when connecting. Node's default is 250 ms, which fails behind a slow VPN. Applies to new connections at once.",
  display: 'milliseconds',
  schema: z.number().int().min(100).max(5000),
  defaultValue: 1000,
  bounds: { min: 100, max: 5000 },
};

const fetchTimeout: SettingDefinition<number> = {
  key: 'resources.fetchTimeoutMs',
  group: 'Resources',
  label: 'Fetch timeout',
  help: 'How long a website or document fetch may take.',
  display: 'seconds',
  schema: z.number().int().min(1000).max(60000),
  defaultValue: 5000,
  bounds: { min: 1000, max: 60000 },
};

const refreshInterval: SettingDefinition<number> = {
  key: 'resources.refreshIntervalMin',
  group: 'Resources',
  label: 'Refresh interval',
  help: 'How often cached resources are refreshed.',
  display: 'minutes',
  schema: z.number().int().min(15).max(1440),
  defaultValue: 60,
  bounds: { min: 15, max: 1440 },
};

const fetchHeaderName: SettingDefinition<string | null> = {
  key: 'resources.fetchHeaderName',
  group: 'Resources',
  label: 'Fetch header name',
  help: "Optional. A header sent with website fetches, so a site's Cloudflare rule can let Bananasaurs through without a challenge.",
  display: 'text',
  schema: z
    .string()
    .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/)
    .refine((n) => !RESERVED.has(n.toLowerCase()), {
      message: 'That header is managed by Bananasaurs.',
    })
    .nullable(),
  defaultValue: null,
};

const fetchHeaderValue: SettingDefinition<string | null> = {
  key: 'resources.fetchHeaderValue',
  group: 'Resources',
  label: 'Fetch header value',
  help: "The header's secret value. Stored encrypted; never shown again.",
  display: 'secret',
  schema: z.string().min(1).max(500).nullable(),
  defaultValue: null,
  secret: true,
};

const fetchHeaderHosts: SettingDefinition<string[]> = {
  key: 'resources.fetchHeaderHosts',
  group: 'Resources',
  label: 'Send the header only to',
  help: 'The header is sent only to these hosts, and never anywhere else.',
  display: 'host-list',
  schema: z
    .array(z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/))
    .max(10),
  defaultValue: [],
  bounds: { maxItems: 10 },
};

const mcpCapMessage: SettingDefinition<number> = {
  key: 'mcp.cap.message',
  group: 'MCP connector',
  label: 'MCP message cap',
  help: 'Maximum send_message, create_forum_post, create_poll and schedule_message posts per rolling hour per guild. Refusals over the cap never trip the breaker.',
  display: 'count',
  schema: z.number().int().min(1).max(10000),
  defaultValue: 300,
  bounds: { min: 1, max: 10000 },
};

const mcpCapEdit: SettingDefinition<number> = {
  key: 'mcp.cap.edit',
  group: 'MCP connector',
  label: 'MCP edit cap',
  help: 'Maximum edit_message, delete_message and update_scheduled (edit or cancel) writes per rolling hour per guild. Refusals over the cap never trip the breaker.',
  display: 'count',
  schema: z.number().int().min(1).max(10000),
  defaultValue: 300,
  bounds: { min: 1, max: 10000 },
};

const mcpCapMemberRole: SettingDefinition<number> = {
  key: 'mcp.cap.member_role',
  group: 'MCP connector',
  label: 'MCP member-role cap',
  help: 'Maximum grant_role, remove_role and bulk role changes per rolling hour per guild, counting each member. Refusals over the cap never trip the breaker.',
  display: 'count',
  schema: z.number().int().min(1).max(10000),
  defaultValue: 1000,
  bounds: { min: 1, max: 10000 },
};

const mcpCapStructure: SettingDefinition<number> = {
  key: 'mcp.cap.structure',
  group: 'MCP connector',
  label: 'MCP structure cap',
  help: 'Maximum create_thread, thread member and state changes, create_role, edit_role, create_event, edit_event and cancel_event writes per rolling hour per guild. Refusals over the cap never trip the breaker.',
  display: 'count',
  schema: z.number().int().min(1).max(10000),
  defaultValue: 100,
  bounds: { min: 1, max: 10000 },
};

const mcpCapPinReact: SettingDefinition<number> = {
  key: 'mcp.cap.pin_react',
  group: 'MCP connector',
  label: 'MCP pin and reaction cap',
  help: 'Maximum set_pin and react writes per rolling hour per guild. Refusals over the cap never trip the breaker.',
  display: 'count',
  schema: z.number().int().min(1).max(10000),
  defaultValue: 300,
  bounds: { min: 1, max: 10000 },
};

const pingMaxMembers: SettingDefinition<number> = {
  key: 'assistant.pingMaxMembers',
  group: 'Assistant replies',
  label: 'Reply pings: max members',
  help: 'How many members one assistant reply may ping. Only people the asker mentioned or named ever ping.',
  display: 'count',
  schema: z.number().int().min(1).max(5),
  defaultValue: 5,
  bounds: { min: 1, max: 5 },
};

const pingMaxRoles: SettingDefinition<number> = {
  key: 'assistant.pingMaxRoles',
  group: 'Assistant replies',
  label: 'Reply pings: max roles',
  help: 'How many roles one assistant reply may ping. Roles still pass the server ping rules.',
  display: 'count',
  schema: z.number().int().min(1).max(3),
  defaultValue: 3,
  bounds: { min: 1, max: 3 },
};

const attachmentTextMaxBytes: SettingDefinition<number> = {
  key: 'assistant.attachments.textMaxBytes',
  group: 'Assistant attachments',
  label: 'Text attachment size limit',
  help: 'The largest text file read from a message, in bytes. Larger files are skipped with a note.',
  display: 'count',
  schema: z.number().int().min(1024).max(1_048_576),
  defaultValue: 262_144,
  bounds: { min: 1024, max: 1_048_576 },
};

const attachmentTextMaxChars: SettingDefinition<number> = {
  key: 'assistant.attachments.textMaxChars',
  group: 'Assistant attachments',
  label: 'Text attachment characters sent',
  help: 'How many characters of each text file are sent to the AI. Longer files are cut with a note.',
  display: 'count',
  schema: z.number().int().min(1000).max(100_000),
  defaultValue: 24_000,
  bounds: { min: 1000, max: 100_000 },
};

const attachmentTextMaxCount: SettingDefinition<number> = {
  key: 'assistant.attachments.textMaxCount',
  group: 'Assistant attachments',
  label: 'Text files read per message',
  help: 'How many text files are read from one message. 0 turns text attachments off.',
  display: 'count',
  schema: z.number().int().min(0).max(10),
  defaultValue: 3,
  bounds: { min: 0, max: 10 },
};

const attachmentImageMaxBytes: SettingDefinition<number> = {
  key: 'assistant.attachments.imageMaxBytes',
  group: 'Assistant attachments',
  label: 'Image size limit',
  help: 'The largest image sent to the AI, in bytes. Larger images are skipped with a note.',
  display: 'count',
  schema: z.number().int().min(1024).max(20_971_520),
  defaultValue: 5_242_880,
  bounds: { min: 1024, max: 20_971_520 },
};

const attachmentImageMaxCount: SettingDefinition<number> = {
  key: 'assistant.attachments.imageMaxCount',
  group: 'Assistant attachments',
  label: 'Images read per message',
  help: 'How many images are sent to the AI from one message. 0 turns image attachments off.',
  display: 'count',
  schema: z.number().int().min(0).max(10),
  defaultValue: 4,
  bounds: { min: 0, max: 10 },
};

const attachmentPdfMaxBytes: SettingDefinition<number> = {
  key: 'assistant.attachments.pdfMaxBytes',
  group: 'Assistant attachments',
  label: 'PDF size limit',
  help: 'The largest PDF sent to the AI, in bytes. Larger PDFs are skipped with a note.',
  display: 'count',
  schema: z.number().int().min(1024).max(31_457_280),
  defaultValue: 10_485_760,
  bounds: { min: 1024, max: 31_457_280 },
};

const attachmentPdfMaxCount: SettingDefinition<number> = {
  key: 'assistant.attachments.pdfMaxCount',
  group: 'Assistant attachments',
  label: 'PDFs read per message',
  help: 'How many PDFs are sent to the AI from one message. 0 turns PDF attachments off.',
  display: 'count',
  schema: z.number().int().min(0).max(10),
  defaultValue: 2,
  bounds: { min: 0, max: 10 },
};

export const INSTANCE_SETTINGS: readonly SettingDefinition<unknown>[] = [
  retryDelays,
  providerTimeout,
  providerIdleTimeout,
  providerMaxCall,
  maxConcurrentRuns,
  maxToolRounds,
  maxToolCalls,
  maxOutputTokens,
  channelContextMessages,
  routerEnabled,
  routerMaxChars,
  routerFullModelKeywords,
  routerGreetingPatterns,
  routerLongThreadTurns,
  routerEscalateOnTool,
  routerSummaryTier,
  routerDailyDigestTier,
  connectFallback,
  fetchTimeout,
  refreshInterval,
  fetchHeaderName,
  fetchHeaderValue,
  fetchHeaderHosts,
  mcpCapMessage,
  mcpCapEdit,
  mcpCapMemberRole,
  mcpCapStructure,
  mcpCapPinReact,
  pingMaxMembers,
  pingMaxRoles,
  digestEnabled,
  digestHour,
  digestInputChars,
  digestMaxProposals,
  attachmentTextMaxBytes,
  attachmentTextMaxChars,
  attachmentTextMaxCount,
  attachmentImageMaxBytes,
  attachmentImageMaxCount,
  attachmentPdfMaxBytes,
  attachmentPdfMaxCount,
];

export interface InstanceSettingValues {
  readonly 'assistant.digestEnabled': number;
  readonly 'assistant.digestHour': number;
  readonly 'assistant.digestInputChars': number;
  readonly 'assistant.digestMaxProposals': number;
  readonly 'assistant.retryDelaysMs': number[];
  readonly 'assistant.providerTimeoutMs': number;
  readonly 'assistant.providerIdleTimeoutMs': number;
  readonly 'assistant.providerMaxCallMs': number;
  readonly 'assistant.maxConcurrentRuns': number;
  readonly 'assistant.maxToolRounds': number;
  readonly 'assistant.maxToolCalls': number;
  readonly 'assistant.maxOutputTokens': number;
  readonly 'assistant.channelContextMessages': number;
  readonly 'assistant.routerEnabled': number;
  readonly 'assistant.routerMaxChars': number;
  readonly 'assistant.routerFullModelKeywords': string[];
  readonly 'assistant.routerGreetingPatterns': string[];
  readonly 'assistant.routerLongThreadTurns': number;
  readonly 'assistant.routerEscalateOnTool': number;
  readonly 'assistant.routerSummaryTier': 'light' | 'standard';
  readonly 'assistant.routerDailyDigestTier': 'light' | 'standard';
  readonly 'network.connectFallbackMs': number;
  readonly 'resources.fetchTimeoutMs': number;
  readonly 'resources.refreshIntervalMin': number;
  readonly 'resources.fetchHeaderName': string | null;
  readonly 'resources.fetchHeaderValue': string | null;
  readonly 'resources.fetchHeaderHosts': string[];
  readonly 'mcp.cap.message': number;
  readonly 'mcp.cap.edit': number;
  readonly 'mcp.cap.member_role': number;
  readonly 'mcp.cap.structure': number;
  readonly 'mcp.cap.pin_react': number;
  readonly 'assistant.pingMaxMembers': number;
  readonly 'assistant.pingMaxRoles': number;
  readonly 'assistant.attachments.textMaxBytes': number;
  readonly 'assistant.attachments.textMaxChars': number;
  readonly 'assistant.attachments.textMaxCount': number;
  readonly 'assistant.attachments.imageMaxBytes': number;
  readonly 'assistant.attachments.imageMaxCount': number;
  readonly 'assistant.attachments.pdfMaxBytes': number;
  readonly 'assistant.attachments.pdfMaxCount': number;
}

export type InstanceSettingKey = keyof InstanceSettingValues;

const BY_KEY = new Map<string, SettingDefinition<unknown>>(
  INSTANCE_SETTINGS.map((def) => [def.key, def]),
);

export const settingDefinition = (key: string): SettingDefinition<unknown> | undefined =>
  BY_KEY.get(key);

export const isInstanceSettingKey = (key: string): key is InstanceSettingKey => BY_KEY.has(key);
