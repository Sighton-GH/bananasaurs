import { z } from 'zod';
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  GenerationMessage,
  ProviderCapability,
  TextProvider,
} from './contracts.js';
import { ProviderError, type ProviderErrorKind } from './errors.js';
import { netCodeOf } from './failure.js';
import { assertOutboundRequestSafe } from './outbound-safety.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const geminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z
              .array(
                z.object({
                  text: z.string().optional(),
                  thought: z.boolean().optional(),
                  functionCall: z
                    .object({
                      name: z.string().min(1),
                      args: z.record(z.string(), z.unknown()).optional(),
                      id: z.string().optional(),
                    })
                    .optional(),
                }),
              )
              .default([]),
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
      thoughtsTokenCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
  modelVersion: z.string().optional(),
});

/**
 * Maps messages to Gemini contents. An assistant turn with `providerParts`
 * is sent back exactly as Gemini returned it, thought signatures included.
 * Adjacent tool results are merged into one user turn: Gemini expects every
 * call of a parallel batch answered together.
 */
const toContents = (messages: readonly GenerationMessage[]): unknown[] => {
  const contents: { role: 'user' | 'model'; parts: unknown[] }[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const part = {
        functionResponse: {
          ...(message.toolCallId === undefined ? {} : { id: message.toolCallId }),
          name: message.toolName ?? 'unknown',
          response: { content: message.text },
        },
      };
      const last = contents.at(-1);
      const lastIsResponses =
        last?.role === 'user' &&
        last.parts.every((p) => typeof p === 'object' && p !== null && 'functionResponse' in p);
      if (last !== undefined && lastIsResponses) last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.providerParts)) {
      contents.push({ role: 'model', parts: message.providerParts as unknown[] });
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.text }],
    });
  }
  return contents;
};

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
  private readonly host: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  public constructor(options: GeminiProviderOptions) {
    if (options.apiKey.trim() === '') throw new Error('Gemini API key must not be empty');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.host = new URL(this.baseUrl).host;
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
      contents: toContents(request.messages),
      ...(request.tools !== undefined && request.tools.length > 0
        ? { tools: [{ functionDeclarations: request.tools }] }
        : {}),
      ...(request.systemInstruction
        ? { system_instruction: { parts: [{ text: request.systemInstruction }] } }
        : {}),
      ...(request.maxOutputTokens !== undefined ||
      request.temperature !== undefined ||
      request.thinkingBudget !== undefined
        ? {
            generationConfig: {
              ...(request.maxOutputTokens !== undefined
                ? { maxOutputTokens: request.maxOutputTokens }
                : {}),
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
              ...(request.thinkingBudget !== undefined
                ? { thinkingConfig: { thinkingBudget: request.thinkingBudget } }
                : {}),
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
      const netCode = netCodeOf(error);
      throw new ProviderError(
        timeoutError ? 'timeout' : 'outage',
        timeoutError ? 'Gemini request timed out' : 'Gemini request failed',
        true,
        { cause: error, host: this.host, ...(netCode === undefined ? {} : { netCode }) },
      );
    }

    if (!response.ok) {
      const kind = statusKind(response.status);
      throw new ProviderError(
        kind,
        `Gemini request failed with HTTP ${response.status}`,
        kind === 'rate-limit' || kind === 'outage',
        { status: response.status, host: this.host },
      );
    }

    const raw: unknown = await response.json();
    const parsed = geminiResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError('invalid-response', 'Gemini returned an invalid response', false, {
        cause: parsed.error,
      });
    }
    const candidate = parsed.data.candidates[0];
    const parts = candidate?.content?.parts ?? [];
    const text = parts.flatMap((part) => (part.thought === true ? [] : (part.text ?? []))).join('');
    const toolCalls = parts.flatMap((part) =>
      part.functionCall === undefined
        ? []
        : [
            {
              ...(part.functionCall.id === undefined ? {} : { id: part.functionCall.id }),
              name: part.functionCall.name,
              args: part.functionCall.args ?? {},
            },
          ],
    );
    // The raw parts, not the parsed ones: Zod drops fields it does not know
    // (thoughtSignature), and Gemini rejects a tool turn echoed without them.
    const rawParts = (raw as { candidates?: { content?: { parts?: unknown } }[] }).candidates?.[0]
      ?.content?.parts;
    if (text === '' && toolCalls.length === 0) {
      const finishReason = candidate?.finishReason;
      const emptyUsage = parsed.data.usageMetadata;
      const emptyEvidence = {
        ...(emptyUsage?.candidatesTokenCount !== undefined
          ? { completionTokens: emptyUsage.candidatesTokenCount }
          : {}),
        ...(emptyUsage?.thoughtsTokenCount !== undefined
          ? { reasoningTokens: emptyUsage.thoughtsTokenCount }
          : {}),
        reasoningOnly: false,
      };
      if (finishReason === 'MAX_TOKENS') {
        throw new ProviderError(
          'invalid-response',
          'Gemini stopped at MAX_TOKENS before answering',
          false,
          { finishReason, emptyAnswer: emptyEvidence },
        );
      }
      if (finishReason === 'SAFETY') {
        throw new ProviderError('safety-refusal', 'Gemini returned no text', false, {
          finishReason,
        });
      }
      throw new ProviderError('invalid-response', 'Gemini returned no text', false, {
        ...(finishReason === undefined ? {} : { finishReason }),
        emptyAnswer: emptyEvidence,
      });
    }

    const usage = parsed.data.usageMetadata;
    return {
      text,
      model: parsed.data.modelVersion ?? request.model,
      ...(candidate?.finishReason ? { finishReason: candidate.finishReason } : {}),
      ...(toolCalls.length === 0 ? {} : { toolCalls, providerParts: rawParts }),
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
              ...(usage.thoughtsTokenCount !== undefined
                ? { thinkingTokens: usage.thoughtsTokenCount }
                : {}),
            },
          }
        : {}),
    };
  }
}

/** One model a Gemini key can call for text answers (ADR 0068). */
export interface GeminiModelInfo {
  /** What requests use, without the `models/` prefix. */
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly inputTokenLimit?: number;
}

const modelListSchema = z.object({
  models: z
    .array(
      z.object({
        name: z.string(),
        displayName: z.string().optional(),
        description: z.string().optional(),
        inputTokenLimit: z.number().int().optional(),
        supportedGenerationMethods: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
});

/** Listed with generateContent, but not text answers the assistant can use. */
const NOT_TEXT = /(tts|image|embedding|aqa|audio|live|robotics|computer-use|veo|imagen)/i;

/**
 * The models this key can see that answer text (`generateContent`). This is
 * what the key can see, not what its tier has quota for: a model with no
 * quota fails like a busy one and the next model in the order is tried.
 */
export const listGeminiModels = async (options: {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}): Promise<readonly GeminiModelInfo[]> => {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const host = new URL(base).host;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const found: GeminiModelInfo[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const url = `${base}/models?pageSize=1000${pageToken === undefined ? '' : `&pageToken=${encodeURIComponent(pageToken)}`}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { 'x-goog-api-key': options.apiKey },
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      const netCode = netCodeOf(error);
      throw new ProviderError('outage', 'Gemini model list request failed', true, {
        cause: error,
        host,
        ...(netCode === undefined ? {} : { netCode }),
      });
    }
    if (!response.ok) {
      const kind = statusKind(response.status);
      throw new ProviderError(
        kind,
        `Gemini model list failed with HTTP ${response.status}`,
        kind === 'rate-limit' || kind === 'outage',
        { status: response.status, host },
      );
    }
    const parsed = modelListSchema.safeParse(await response.json());
    if (!parsed.success)
      throw new ProviderError('invalid-response', 'Gemini returned an invalid model list', false);
    for (const model of parsed.data.models) {
      const id = model.name.replace(/^models\//, '');
      if (!model.supportedGenerationMethods.includes('generateContent') || NOT_TEXT.test(id))
        continue;
      found.push({
        id,
        name: model.displayName ?? id,
        ...(model.description === undefined ? {} : { description: model.description }),
        ...(model.inputTokenLimit === undefined ? {} : { inputTokenLimit: model.inputTokenLimit }),
      });
    }
    pageToken = parsed.data.nextPageToken;
    if (pageToken === undefined || pageToken === '') break;
  }
  return found;
};
