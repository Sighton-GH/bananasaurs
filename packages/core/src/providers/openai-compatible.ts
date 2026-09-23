import { z } from 'zod';
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  ProviderCapability,
  TextProvider,
} from './contracts.js';
import { ProviderError, type ProviderErrorKind } from './errors.js';
import { assertOutboundRequestSafe } from './outbound-safety.js';

const responseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
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

export class OpenAiCompatibleProvider implements TextProvider {
  public readonly capabilities: ReadonlySet<ProviderCapability> = new Set(['text', 'usage']);
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
    // No `tools` capability here (ADR 0067): the caller should never offer
    // tools, and a tool turn has no faithful mapping without call ids.
    if (
      (request.tools !== undefined && request.tools.length > 0) ||
      request.messages.some((message) => message.role === 'tool')
    )
      throw new ProviderError(
        'capability-mismatch',
        'this provider does not support tool calls',
        false,
      );
    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify({
          model: request.model,
          messages: [
            ...(request.systemInstruction
              ? [{ role: 'system', content: request.systemInstruction }]
              : []),
            ...request.messages.map((message) => ({ role: message.role, content: message.text })),
          ],
          ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        }),
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
      const kind = statusKind(response.status);
      throw new ProviderError(
        kind,
        `${this.id} request failed with HTTP ${response.status}`,
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
    if (!choice?.message.content)
      throw new ProviderError('invalid-response', `${this.id} returned no text`, false);
    const usage = parsed.data.usage;
    return {
      text: choice.message.content,
      model: parsed.data.model ?? request.model,
      ...(choice.finish_reason ? { finishReason: choice.finish_reason } : {}),
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
