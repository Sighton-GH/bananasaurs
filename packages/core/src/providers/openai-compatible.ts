import { z } from 'zod';
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  GenerationMessage,
  ProviderCapability,
  TextProvider,
  ToolCall,
} from './contracts.js';
import { ProviderError, type ProviderErrorKind } from './errors.js';
import { netCodeOf } from './failure.js';
import { assertOutboundRequestSafe } from './outbound-safety.js';

const toolCallSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string().optional(),
  }),
});

/** OpenRouter-only: non-answer reasoning for Responses-API-style providers (ADR 0129 §4). */
const reasoningTextSchema = z.string().nullable().optional();

const responseSchema = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable(),
          reasoning: reasoningTextSchema,
          tool_calls: z.array(toolCallSchema).optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .default([]),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
      completion_tokens_details: z
        .object({ reasoning_tokens: z.number().int().nonnegative().optional() })
        .partial()
        .optional(),
      /** ADR 0129 §8: OpenRouter's per-call cost, only when `usage.include` was requested. */
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});

export interface OpenAiCompatibleProviderOptions {
  readonly id: 'openrouter' | 'nvidia-nim';
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

const statusKind = (status: number): ProviderErrorKind => {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 402) return 'quota';
  if (status === 429) return 'rate-limit';
  if (status === 400 || status === 404) return 'invalid-request';
  if (status >= 500) return 'outage';
  return 'invalid-response';
};

/** ADR 0077: the OpenRouter (and NVIDIA NIM) error body shape. */
const errorBodySchema = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
});

/**
 * Upstream provider the gateway routed the request to
 * (`error.metadata.provider_name`, ADR 0129 §4). Guards the shape so the failure path never
 * crashes on an unexpected metadata entry, and caps the length so a hostile upstream cannot
 * grow the stored trace.
 */
const upstreamFromError = (metadata: Record<string, unknown> | undefined): string | undefined => {
  const providerName = metadata?.['provider_name'];
  return typeof providerName === 'string' && providerName !== ''
    ? providerName.slice(0, 60)
    : undefined;
};

/** Never trust an upstream error body: bounded before it is even parsed. */
const MAX_ERROR_BODY_CHARS = 4_096;

const readErrorBody = async (response: Response): Promise<unknown> => {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text.slice(0, MAX_ERROR_BODY_CHARS)) as unknown;
  } catch {
    return undefined;
  }
};

// eslint-disable-next-line no-control-regex -- deliberately stripping control characters, not matching them by accident.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * The provider's short reason for a non-2xx, safe to log: the error code and
 * up to 160 characters of its message, control characters stripped. Never
 * the request, headers, or key (CLAUDE.md rule 4).
 */
const shortReason = (detail: z.infer<typeof errorBodySchema> | undefined): string | undefined => {
  if (detail === undefined) return undefined;
  const { code, message } = detail.error;
  const cleanMessage =
    message === undefined ? undefined : message.replace(CONTROL_CHARS, '').slice(0, 160);
  const parts = [
    code === undefined ? undefined : `code ${code}`,
    cleanMessage === undefined || cleanMessage === '' ? undefined : cleanMessage,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(': ');
};

/**
 * ADR 0077 fix round 1: OpenRouter's platform 429 (verified against real
 * error reports - github.com/Gitlawb/openclaude/issues/936,
 * github.com/langchain-ai/openwiki/issues/664 - and
 * openrouter.ai/docs/api_reference/limits) carries the rate-limit headers
 * INSIDE the JSON body, at `error.metadata.headers`, not on the HTTP
 * response: `{ "X-RateLimit-Limit": "50", "X-RateLimit-Remaining": "0",
 * "X-RateLimit-Reset": "1777420800000" }`. Values are strings. Read
 * leniently and case-insensitively: any shape mismatch here means "this
 * metadata has no usable headers", never a reason to reject the rest of the
 * error body (the code/message extraction above must keep working).
 */
const metadataHeadersSchema = z.record(z.string(), z.union([z.string(), z.number()]));

const metadataHeaderValue = (
  metadata: Record<string, unknown> | undefined,
  name: string,
): string | number | undefined => {
  if (metadata === undefined) return undefined;
  const parsed = metadataHeadersSchema.safeParse(metadata['headers']);
  if (!parsed.success) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(parsed.data)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
};

/**
 * Accepts seconds or milliseconds since epoch (disambiguated by magnitude)
 * and only when finite and strictly in the future. `X-RateLimit-Reset` is
 * Unix milliseconds per the body shape above, but the HTTP-header fallback
 * below is undocumented for this endpoint, so both units are still accepted
 * defensively.
 */
const toFutureEpochMs = (raw: string | number | undefined, nowMs: number): number | undefined => {
  if (raw === undefined) return undefined;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return undefined;
  const ms = value < 1_000_000_000_000 ? value * 1000 : value;
  return ms > nowMs ? ms : undefined;
};

/**
 * The body's `error.metadata.headers.X-RateLimit-Reset` is the primary
 * source (that is where OpenRouter actually puts it); the HTTP response
 * header is only a fallback for a shape this adapter has not seen.
 */
const resolveResetAt = (
  response: Response,
  metadata: Record<string, unknown> | undefined,
  nowMs: number,
): number | undefined => {
  const fromBody = toFutureEpochMs(metadataHeaderValue(metadata, 'X-RateLimit-Reset'), nowMs);
  if (fromBody !== undefined) return fromBody;
  return toFutureEpochMs(response.headers.get('x-ratelimit-reset') ?? undefined, nowMs);
};

/**
 * ADR 0077: OpenRouter's docs give the free-model daily cap and the
 * free-model per-minute cap the same HTTP status (429) and the same
 * `error_type` (`rate_limit_exceeded`) - there is no field that positively
 * distinguishes them by itself. The conservative rule: only a `:free`
 * model, and only when either (a) the message names the per-day limit, or
 * (b) the body reports zero requests remaining AND the message names a
 * per-day limit. Zero remaining alone is never enough - the per-minute
 * limit reports zero remaining too.
 */
const DAILY_FREE_QUOTA_MESSAGE = /free[\s\S]{0,40}per[- ]?day|per[- ]?day[\s\S]{0,40}free/i;
const PER_DAY_PHRASE = /per[- ]?day/i;

const remainingIsZero = (metadata: Record<string, unknown> | undefined): boolean => {
  const raw = metadataHeaderValue(metadata, 'X-RateLimit-Remaining');
  if (raw === undefined) return false;
  if (typeof raw === 'number') return raw === 0;
  // Number('') and Number(' ') are 0; a blank value is no evidence of anything.
  return raw.trim() !== '' && Number(raw) === 0;
};

const isDailyFreeQuota = (
  model: string,
  message: string | undefined,
  metadata: Record<string, unknown> | undefined,
): boolean => {
  if (!model.endsWith(':free') || message === undefined) return false;
  if (DAILY_FREE_QUOTA_MESSAGE.test(message)) return true;
  return remainingIsZero(metadata) && PER_DAY_PHRASE.test(message);
};

/**
 * A malformed `arguments` string still returns the call with empty args; the
 * tool's Zod schema will refuse it at execution time.
 */
const parseToolArguments = (raw: string | undefined): unknown => {
  if (raw === undefined || raw === '') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
};

const toWireMessage = (
  message: GenerationMessage,
  providerId: 'openrouter' | 'nvidia-nim',
): unknown => {
  if (message.role === 'tool') {
    if (message.toolCallId === undefined)
      throw new ProviderError(
        'invalid-request',
        `${providerId} tool result is missing its tool call id`,
        false,
      );
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.text };
  }
  if (
    message.role === 'assistant' &&
    message.toolCalls !== undefined &&
    message.toolCalls.length > 0
  ) {
    return {
      role: 'assistant',
      content: message.text === '' ? null : message.text,
      tool_calls: message.toolCalls.map((call) => ({
        ...(call.id === undefined ? {} : { id: call.id }),
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      })),
    };
  }
  return { role: message.role, content: message.text };
};

export class OpenAiCompatibleProvider implements TextProvider {
  public readonly capabilities: ReadonlySet<ProviderCapability> = new Set([
    'text',
    'tools',
    'usage',
  ]);
  public readonly id: 'openrouter' | 'nvidia-nim';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly host: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Readonly<Record<string, string>>;

  public constructor(options: OpenAiCompatibleProviderOptions) {
    if (options.apiKey.trim() === '') throw new Error(`${options.id} API key must not be empty`);
    this.id = options.id;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.host = new URL(this.baseUrl).host;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.extraHeaders = options.extraHeaders ?? {};
  }

  public async generateText(request: GenerateTextRequest): Promise<GenerateTextResponse> {
    assertOutboundRequestSafe(request);
    if (request.messages.length === 0)
      throw new ProviderError('invalid-request', 'at least one message is required', false);
    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    // Built before the fetch try block so a malformed tool turn keeps its
    // own error kind instead of being re-wrapped as an outage.
    const body = JSON.stringify({
      model: request.model,
      messages: [
        ...(request.systemInstruction
          ? [{ role: 'system', content: request.systemInstruction }]
          : []),
        ...request.messages.map((message) => toWireMessage(message, this.id)),
      ],
      ...(request.tools !== undefined && request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
      ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      // ADR 0129 §8: OpenRouter reports per-call cost only when asked; NIM
      // has no such field, so its body stays unchanged.
      ...(this.id === 'openrouter' ? { usage: { include: true } } : {}),
    });
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body,
        signal,
      });
    } catch (error) {
      const timeout = error instanceof DOMException && error.name === 'TimeoutError';
      const netCode = netCodeOf(error);
      throw new ProviderError(
        timeout ? 'timeout' : 'outage',
        `${this.id} request ${timeout ? 'timed out' : 'failed'}`,
        true,
        { cause: error, host: this.host, ...(netCode === undefined ? {} : { netCode }) },
      );
    }
    if (!response.ok) {
      const parsedBody = errorBodySchema.safeParse(await readErrorBody(response));
      const detail = parsedBody.success ? parsedBody.data : undefined;
      const metadata = detail?.error.metadata;
      const reason = shortReason(detail);
      if (
        response.status === 429 &&
        isDailyFreeQuota(request.model, detail?.error.message, metadata)
      ) {
        const resetAt = resolveResetAt(response, metadata, Date.now());
        throw new ProviderError(
          'quota',
          reason === undefined
            ? `${this.id} free-model daily limit reached`
            : `${this.id} free-model daily limit reached (${reason})`,
          false,
          {
            quotaScope: 'daily-free',
            status: response.status,
            host: this.host,
            ...(upstreamFromError(metadata) === undefined
              ? {}
              : { upstream: upstreamFromError(metadata) as string }),
            ...(resetAt === undefined ? {} : { resetAt }),
          },
        );
      }
      const kind = statusKind(response.status);
      throw new ProviderError(
        kind,
        reason === undefined
          ? `${this.id} request failed with HTTP ${response.status}`
          : `${this.id} request failed with HTTP ${response.status} (${reason})`,
        kind === 'rate-limit' || kind === 'outage',
        {
          status: response.status,
          host: this.host,
          ...(upstreamFromError(metadata) === undefined
            ? {}
            : { upstream: upstreamFromError(metadata) as string }),
        },
      );
    }
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success)
      throw new ProviderError(
        'invalid-response',
        `${this.id} returned an invalid response`,
        false,
        { cause: parsed.error },
      );
    const choice = parsed.data.choices[0];
    const text = choice?.message.content ?? '';
    const toolCalls: ToolCall[] = (choice?.message.tool_calls ?? []).map((call) => ({
      ...(call.id === undefined ? {} : { id: call.id }),
      name: call.function.name,
      args: parseToolArguments(call.function.arguments),
    }));
    const finishReason =
      choice?.finish_reason === null ||
      choice?.finish_reason === '' ||
      choice?.finish_reason === undefined
        ? undefined
        : choice.finish_reason;
    const upstream = parsed.data.provider;
    const usage = parsed.data.usage;
    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
    const reasoningOnly = (choice?.message.reasoning ?? '') !== '';
    if (text === '' && toolCalls.length === 0)
      throw new ProviderError('invalid-response', `${this.id} returned no text`, false, {
        host: this.host,
        ...(finishReason === undefined ? {} : { finishReason }),
        ...(upstream === undefined ? {} : { upstream }),
        emptyAnswer: {
          ...(usage?.completion_tokens !== undefined
            ? { completionTokens: usage.completion_tokens }
            : {}),
          ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
          reasoningOnly,
        },
      });
    return {
      text,
      model: parsed.data.model ?? request.model,
      ...(finishReason ? { finishReason } : {}),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(upstream === undefined ? {} : { upstream }),
      ...(usage
        ? {
            usage: {
              ...(usage.prompt_tokens !== undefined ? { promptTokens: usage.prompt_tokens } : {}),
              ...(usage.completion_tokens !== undefined
                ? { completionTokens: usage.completion_tokens }
                : {}),
              ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
              ...(reasoningTokens !== undefined ? { thinkingTokens: reasoningTokens } : {}),
              ...(usage.cost !== undefined ? { costUsd: usage.cost } : {}),
            },
          }
        : {}),
    };
  }
}

export const createOpenRouterProvider = (
  options: Omit<OpenAiCompatibleProviderOptions, 'id' | 'baseUrl'> & { readonly baseUrl?: string },
): OpenAiCompatibleProvider =>
  new OpenAiCompatibleProvider({
    ...options,
    id: 'openrouter',
    baseUrl: options.baseUrl ?? 'https://openrouter.ai/api/v1',
  });

export const createNvidiaNimProvider = (
  options: Omit<OpenAiCompatibleProviderOptions, 'id' | 'baseUrl'> & { readonly baseUrl?: string },
): OpenAiCompatibleProvider =>
  new OpenAiCompatibleProvider({
    ...options,
    id: 'nvidia-nim',
    baseUrl: options.baseUrl ?? 'https://integrate.api.nvidia.com/v1',
  });
