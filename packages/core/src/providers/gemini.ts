import { z } from 'zod';
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  ProviderCapability,
  TextProvider,
} from './contracts.js';
import { ProviderError, type ProviderErrorKind } from './errors.js';
import { assertOutboundRequestSafe } from './outbound-safety.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const geminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z.array(z.object({ text: z.string().optional() })).default([]),
          })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .default([]),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().int().nonnegative().optional(),
      candidatesTokenCount: z.number().int().nonnegative().optional(),
      totalTokenCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
  modelVersion: z.string().optional(),
});

export interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

const statusKind = (status: number): ProviderErrorKind => {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate-limit';
  if (status === 400 || status === 404) return 'invalid-request';
  if (status >= 500) return 'outage';
  return 'invalid-response';
};

export class GeminiProvider implements TextProvider {
  public readonly id = 'gemini';
  public readonly capabilities: ReadonlySet<ProviderCapability> = new Set([
    'text',
    'vision',
    'structured-output',
    'tools',
    'usage',
  ]);

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  public constructor(options: GeminiProviderOptions) {
    if (options.apiKey.trim() === '') throw new Error('Gemini API key must not be empty');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  public async generateText(request: GenerateTextRequest): Promise<GenerateTextResponse> {
    assertOutboundRequestSafe(request);
    if (request.messages.length === 0) {
      throw new ProviderError('invalid-request', 'at least one message is required', false);
    }

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const body = {
      contents: request.messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.text }],
      })),
      ...(request.systemInstruction
        ? { system_instruction: { parts: [{ text: request.systemInstruction }] } }
        : {}),
      ...(request.maxOutputTokens !== undefined || request.temperature !== undefined
        ? {
            generationConfig: {
              ...(request.maxOutputTokens !== undefined
                ? { maxOutputTokens: request.maxOutputTokens }
                : {}),
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            },
          }
        : {}),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/models/${encodeURIComponent(request.model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal,
        },
      );
    } catch (error) {
      const timeoutError = error instanceof DOMException && error.name === 'TimeoutError';
      throw new ProviderError(
        timeoutError ? 'timeout' : 'outage',
        timeoutError ? 'Gemini request timed out' : 'Gemini request failed',
        true,
        { cause: error },
      );
    }

    if (!response.ok) {
      const kind = statusKind(response.status);
      throw new ProviderError(
        kind,
        `Gemini request failed with HTTP ${response.status}`,
        kind === 'rate-limit' || kind === 'outage',
      );
    }

    const parsed = geminiResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ProviderError('invalid-response', 'Gemini returned an invalid response', false, {
        cause: parsed.error,
      });
    }
    const candidate = parsed.data.candidates[0];
    const text = candidate?.content?.parts.flatMap((part) => part.text ?? []).join('') ?? '';
    if (text === '') {
      const kind = candidate?.finishReason === 'SAFETY' ? 'safety-refusal' : 'invalid-response';
      throw new ProviderError(kind, 'Gemini returned no text', false);
    }

    const usage = parsed.data.usageMetadata;
    return {
      text,
      model: parsed.data.modelVersion ?? request.model,
      ...(candidate?.finishReason ? { finishReason: candidate.finishReason } : {}),
      ...(usage
        ? {
            usage: {
              ...(usage.promptTokenCount !== undefined
                ? { promptTokens: usage.promptTokenCount }
                : {}),
              ...(usage.candidatesTokenCount !== undefined
                ? { completionTokens: usage.candidatesTokenCount }
                : {}),
              ...(usage.totalTokenCount !== undefined
                ? { totalTokens: usage.totalTokenCount }
                : {}),
            },
          }
        : {}),
    };
  }
}
