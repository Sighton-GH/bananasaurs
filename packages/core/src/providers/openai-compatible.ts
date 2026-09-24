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
import { assertOutboundRequestSafe } from './outbound-safety.js';

const toolCallSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string().optional(),
  }),
});

const responseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable(),
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
 * ADR 0077: OpenRouter's docs give the free-model daily cap and the
 * free-model per-minute cap the same HTTP status (429) and the same
 * `error_type` (`rate_limit_exceeded`) - there is no field that positively
 * distinguishes them. The conservative rule: only a `:free` model, and only
 * when the message itself names the per-day limit.
 */
const DAILY_FREE_QUOTA_MESSAGE = /free[\s\S]{0,40}per[- ]?day|per[- ]?day[\s\S]{0,40}free/i;
const isDailyFreeQuota = (model: string, message: string | undefined): boolean =>
  model.endsWith(':free') && message !== undefined && DAILY_FREE_QUOTA_MESSAGE.test(message);

/**
 * `X-RateLimit-Reset` is not documented for this endpoint (ADR 0077); read
 * defensively. Accepts seconds or milliseconds since epoch (disambiguated by
 * magnitude) and only when finite and strictly in the future.
 */
const parseRateLimitReset = (headers: Headers, nowMs: number): number | undefined => {
  const raw = headers.get('x-ratelimit-reset');
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  const ms = value < 1_000_000_000_000 ? value * 1000 : value;
  return ms > nowMs ? ms : undefined;
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
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Readonly<Record<string, string>>;

  public constructor(options: OpenAiCompatibleProviderOptions) {
    if (options.apiKey.trim() === '') throw new Error(`${options.id} API key must not be empty`);
    this.id = options.id;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
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
      throw new ProviderError(
        timeout ? 'timeout' : 'outage',
        `${this.id} request ${timeout ? 'timed out' : 'failed'}`,
        true,
        { cause: error },
      );
    }
    if (!response.ok) {
      const parsedBody = errorBodySchema.safeParse(await readErrorBody(response));
      const detail = parsedBody.success ? parsedBody.data : undefined;
      const reason = shortReason(detail);
      if (response.status === 429 && isDailyFreeQuota(request.model, detail?.error.message)) {
        const resetAt = parseRateLimitReset(response.headers, Date.now());
        throw new ProviderError(
          'quota',
          reason === undefined
            ? `${this.id} free-model daily limit reached`
            : `${this.id} free-model daily limit reached (${reason})`,
          false,
          { quotaScope: 'daily-free', ...(resetAt === undefined ? {} : { resetAt }) },
        );
      }
      const kind = statusKind(response.status);
      throw new ProviderError(
        kind,
        reason === undefined
          ? `${this.id} request failed with HTTP ${response.status}`
          : `${this.id} request failed with HTTP ${response.status} (${reason})`,
        kind === 'rate-limit' || kind === 'outage',
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
    if (text === '' && toolCalls.length === 0)
      throw new ProviderError('invalid-response', `${this.id} returned no text`, false);
    const usage = parsed.data.usage;
    return {
      text,
      model: parsed.data.model ?? request.model,
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(usage
        ? {
            usage: {
              ...(usage.prompt_tokens !== undefined ? { promptTokens: usage.prompt_tokens } : {}),
              ...(usage.completion_tokens !== undefined
                ? { completionTokens: usage.completion_tokens }
                : {}),
              ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
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
