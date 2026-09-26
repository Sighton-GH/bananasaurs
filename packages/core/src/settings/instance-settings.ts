import { z } from 'zod';

export type SettingDisplay =
  | 'seconds'
  | 'milliseconds'
  | 'minutes'
  | 'count'
  | 'text'
  | 'secret'
  | 'seconds-list'
  | 'host-list';
export type SettingGroup = 'Assistant retries' | 'Assistant tool loop' | 'Network' | 'Resources';

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
  defaultValue: 30000,
  bounds: { min: 5000, max: 120000 },
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
  defaultValue: 2048,
  bounds: { min: 256, max: 8192 },
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

export const INSTANCE_SETTINGS: readonly SettingDefinition<unknown>[] = [
  retryDelays,
  providerTimeout,
  maxToolRounds,
  maxToolCalls,
  maxOutputTokens,
  connectFallback,
  fetchTimeout,
  refreshInterval,
  fetchHeaderName,
  fetchHeaderValue,
  fetchHeaderHosts,
];

export interface InstanceSettingValues {
  readonly 'assistant.retryDelaysMs': number[];
  readonly 'assistant.providerTimeoutMs': number;
  readonly 'assistant.maxToolRounds': number;
  readonly 'assistant.maxToolCalls': number;
  readonly 'assistant.maxOutputTokens': number;
  readonly 'network.connectFallbackMs': number;
  readonly 'resources.fetchTimeoutMs': number;
  readonly 'resources.refreshIntervalMin': number;
  readonly 'resources.fetchHeaderName': string | null;
  readonly 'resources.fetchHeaderValue': string | null;
  readonly 'resources.fetchHeaderHosts': string[];
}

export type InstanceSettingKey = keyof InstanceSettingValues;

const BY_KEY = new Map<string, SettingDefinition<unknown>>(
  INSTANCE_SETTINGS.map((def) => [def.key, def]),
);

export const settingDefinition = (key: string): SettingDefinition<unknown> | undefined =>
  BY_KEY.get(key);

export const isInstanceSettingKey = (key: string): key is InstanceSettingKey => BY_KEY.has(key);
