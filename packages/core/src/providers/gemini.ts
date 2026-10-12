import { z } from 'zod';
import { parseSseStream } from './sse.js';
import { geminiCapabilities, type ModelCapabilities } from './model-capabilities.js';
import { parseGeminiQuotaError } from './gemini-quota.js';
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
  readonly idleTimeoutMs?: number;
  readonly maxCallMs?: number;
}

const statusKind = (status: number): ProviderErrorKind => {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate-limit';
  if (status === 400 || status === 404) return 'invalid-request';
  if (status >= 500) return 'outage';
  return 'invalid-response';
};

/** Shared by the fetch catch and the success-body catch: the timeout signal fires in either place. */
const isTimeoutError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'TimeoutError';

const FINISH_REASONS = new Set([
  'FINISH_REASON_UNSPECIFIED',
  'STOP',
  'MAX_TOKENS',
  'SAFETY',
  'RECITATION',
  'LANGUAGE',
  'OTHER',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'MALFORMED_FUNCTION_CALL',
  'IMAGE_SAFETY',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS',
  'MISSING_THOUGHT_SIGNATURE',
]);
const safeFinishReason = (reason: string | undefined): string | undefined =>
  reason !== undefined && FINISH_REASONS.has(reason) ? reason : undefined;

export class GeminiProvider implements TextProvider {
  public readonly id = 'gemini';
  public readonly capabilities: ReadonlySet<ProviderCapability> = new Set([
    'text',
    'streaming',
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
  private readonly idleTimeoutMs: number;
  private readonly maxCallMs: number;

  public constructor(options: GeminiProviderOptions) {
    if (options.apiKey.trim() === '') throw new Error('Gemini API key must not be empty');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.host = new URL(this.baseUrl).host;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
    this.maxCallMs = options.maxCallMs ?? 300_000;
  }

  /** Preserve safe structured evidence, never arbitrary causes or key-bearing fields. */
  private safeError(error: ProviderError): ProviderError {
    const containsKey = (value: unknown): boolean =>
      typeof value === 'string' && value.includes(this.apiKey);
    let serialized: string;
    try {
      serialized = JSON.stringify(error);
    } catch {
      serialized = this.apiKey;
    }
    if (
      error.cause === undefined &&
      !containsKey(serialized) &&
      !containsKey(error.message) &&
      !containsKey(error.stack)
    )
      return error;
    const safeString = (value: string | undefined): string | undefined =>
      containsKey(value) ? undefined : value;
    const host = safeString(error.host);
    const netCode = safeString(error.netCode);
    const upstream = safeString(error.upstream);
    const finishReason = safeFinishReason(error.finishReason);
    return new ProviderError(error.kind, 'Gemini provider failed', error.retryable, {
      ...(error.resetAt === undefined ? {} : { resetAt: error.resetAt }),
      ...(error.quotaScope === undefined ? {} : { quotaScope: error.quotaScope }),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      ...(error.learnedLimit === undefined
        ? {}
        : {
            learnedLimit: {
              ...(error.learnedLimit.perDay === undefined
                ? {}
                : { perDay: error.learnedLimit.perDay }),
              ...(error.learnedLimit.perMinute === undefined
                ? {}
                : { perMinute: error.learnedLimit.perMinute }),
            },
          }),
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(host === undefined ? {} : { host }),
      ...(netCode === undefined ? {} : { netCode }),
      ...(upstream === undefined ? {} : { upstream }),
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(error.emptyAnswer === undefined
        ? {}
        : {
            emptyAnswer: {
              reasoningOnly: error.emptyAnswer.reasoningOnly,
              ...(error.emptyAnswer.completionTokens === undefined
                ? {}
                : { completionTokens: error.emptyAnswer.completionTokens }),
              ...(error.emptyAnswer.reasoningTokens === undefined
                ? {}
                : { reasoningTokens: error.emptyAnswer.reasoningTokens }),
            },
          }),
    });
  }

  public async generateText(request: GenerateTextRequest): Promise<GenerateTextResponse> {
    if (request.signal?.aborted)
      throw new ProviderError('outage', 'Gemini request aborted', true, { host: this.host });
    assertOutboundRequestSafe(request);
    if (request.messages.length === 0) {
      throw new ProviderError('invalid-request', 'at least one message is required', false);
    }

    const controller = new AbortController();
    const signal = controller.signal;
    // Abort must also settle injected fetches and streams that ignore the signal.
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    // A pre-aborted caller can reject before the first race is attached.
    void aborted.catch(() => {});
    const onAbort = (): void => {
      rejectAbort(
        isTimeoutError(signal.reason)
          ? new DOMException('Gemini request timed out', 'TimeoutError')
          : new DOMException('Gemini request aborted', 'AbortError'),
      );
    };
    const checkAbort = (): void => {
      if (signal.aborted)
        throw isTimeoutError(signal.reason)
          ? new DOMException('Gemini request timed out', 'TimeoutError')
          : new DOMException('Gemini request aborted', 'AbortError');
    };
    const cancelBody = (response: Response): void => {
      if (response.body !== null) void response.body.cancel().catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const callerAbort = (): void => {
      controller.abort(request.signal?.reason);
    };
    request.signal?.addEventListener('abort', callerAbort, { once: true });
    if (request.signal?.aborted) callerAbort();
    const expire = (): void => {
      controller.abort(new DOMException('Gemini request timed out', 'TimeoutError'));
    };
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      expire,
      this.timeoutMs,
    );
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const ceilingTimer = setTimeout(expire, this.maxCallMs);
    const noteByte = (): void => {
      clearTimeout(firstByteTimer);
      firstByteTimer = undefined;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(expire, this.idleTimeoutMs);
    };
    const clearTimers = (): void => {
      clearTimeout(firstByteTimer);
      clearTimeout(idleTimer);
      clearTimeout(ceilingTimer);
      request.signal?.removeEventListener('abort', callerAbort);
      signal.removeEventListener('abort', onAbort);
    };
    try {
      const capabilities: ModelCapabilities =
        request.capabilities ?? geminiCapabilities(request.model);
      const wantsTools = request.tools !== undefined && request.tools.length > 0;
      const thinkingLevel = request.thinkingLevel ?? (wantsTools ? 'low' : 'medium');
      const thinkingConfig =
        capabilities.thinking === 'levels'
          ? { thinkingLevel, includeThoughts: true }
          : capabilities.thinking === 'budget' && request.thinkingBudget !== undefined
            ? { thinkingBudget: request.thinkingBudget, includeThoughts: true }
            : undefined;
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
        thinkingConfig !== undefined
          ? {
              generationConfig: {
                ...(request.maxOutputTokens !== undefined
                  ? { maxOutputTokens: request.maxOutputTokens }
                  : {}),
                ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                ...(thinkingConfig === undefined ? {} : { thinkingConfig }),
              },
            }
          : {}),
      };

      let response: Response;
      try {
        checkAbort();
        const fetched = this.fetchImpl(
          `${this.baseUrl}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
            body: JSON.stringify(body),
            signal,
          },
        ).then((result) => {
          if (signal.aborted) {
            cancelBody(result);
            checkAbort();
          }
          return result;
        });
        response = await Promise.race([fetched, aborted]);
        if (signal.aborted) {
          cancelBody(response);
          checkAbort();
        }
      } catch (error) {
        if (error instanceof ProviderError) throw this.safeError(error);
        const timeoutError = isTimeoutError(error);
        const netCode = netCodeOf(error);
        throw new ProviderError(
          timeoutError ? 'timeout' : 'outage',
          timeoutError ? 'Gemini request timed out' : 'Gemini request failed',
          true,
          { host: this.host, ...(netCode === undefined ? {} : { netCode }) },
        );
      }

      if (!response.ok) {
        if (response.status !== 429) cancelBody(response);
        if (response.status === 401 || response.status === 403) {
          throw new ProviderError(
            'authentication',
            `Gemini request failed with HTTP ${response.status}`,
            false,
            { status: response.status, host: this.host },
          );
        }
        if (response.status === 429) {
          let body: unknown;
          const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
          if (reader !== undefined) {
            try {
              const decoder = new TextDecoder();
              let text = '';
              let bytesRead = 0;
              while (bytesRead < 16_384) {
                checkAbort();
                const chunk = await Promise.race([reader.read(), aborted]);
                checkAbort();
                if (chunk.done) break;
                noteByte();
                const available = chunk.value.subarray(0, 16_384 - bytesRead);
                bytesRead += available.byteLength;
                text += decoder.decode(available, { stream: true });
              }
              text += decoder.decode();
              try {
                body = JSON.parse(text) as unknown;
              } catch {
                body = undefined;
              }
            } catch (error) {
              if (error instanceof ProviderError) throw this.safeError(error);
              if (signal.aborted) {
                throw new ProviderError(
                  isTimeoutError(signal.reason) ? 'timeout' : 'outage',
                  isTimeoutError(signal.reason)
                    ? 'Gemini request timed out'
                    : 'Gemini request aborted',
                  true,
                  { host: this.host, status: 429 },
                );
              }
              body = undefined;
            } finally {
              void reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          }
          const quota = parseGeminiQuotaError(body);
          if (quota.scope !== undefined) {
            throw new ProviderError(
              'quota',
              'Gemini request failed with HTTP 429',
              quota.scope !== 'day',
              {
                status: 429,
                host: this.host,
                quotaScope: quota.scope,
                ...(quota.retryAfterMs === undefined ? {} : { retryAfterMs: quota.retryAfterMs }),
                ...(quota.learnedLimit === undefined ? {} : { learnedLimit: quota.learnedLimit }),
              },
            );
          }
          throw new ProviderError('rate-limit', 'Gemini request failed with HTTP 429', true, {
            status: 429,
            host: this.host,
          });
        }
        const kind = statusKind(response.status);
        throw new ProviderError(
          kind,
          `Gemini request failed with HTTP ${response.status}`,
          kind === 'rate-limit' || kind === 'outage',
          { status: response.status, host: this.host },
        );
      }

      if (response.body === null) {
        throw new ProviderError('invalid-response', 'Gemini returned no response body', false);
      }
      let text = '';
      let reasoning = '';
      let finishReason: string | undefined;
      let usage: z.infer<typeof geminiResponseSchema>['usageMetadata'];
      let modelVersion: string | undefined;
      const toolCalls: { id?: string; name: string; args: unknown }[] = [];
      const rawParts: unknown[] = [];
      let keepalives = 0;
      let lastByteAt = Date.now();
      let lastEmitAt: number | undefined;
      const emitProgress = (): void => {
        const now = Date.now();
        if (lastEmitAt !== undefined && now - lastEmitAt < 3_000) return;
        lastEmitAt = now;
        request.onProgress?.({
          round: 0,
          answerChars: text.length,
          reasoningChars: reasoning.length,
          keepalives,
          msSinceLastByte: now - lastByteAt,
        });
      };
      // Observe raw byte arrivals before parsing: fragmented SSE lines count as
      // activity too. The wrapper makes abort independent of source cooperation.
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let exhausted = false;
      const releaseReader = (): void => {
        if (!exhausted) void reader.cancel().catch(() => {});
        reader.releaseLock();
      };
      const bytes = new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            checkAbort();
            const chunk = await Promise.race([reader.read(), aborted]);
            checkAbort();
            if (chunk.done) {
              exhausted = true;
              output.close();
              return;
            }
            if (chunk.value.byteLength > 0) {
              lastByteAt = Date.now();
              noteByte();
            }
            output.enqueue(chunk.value);
          } catch (error) {
            output.error(error);
          }
        },
      });
      try {
        for await (const event of parseSseStream(bytes)) {
          checkAbort();
          if (event.keepalive) {
            keepalives += 1;
            emitProgress();
            continue;
          }
          if (event.data === '') {
            emitProgress();
            continue;
          }
          let rawJson: unknown;
          try {
            rawJson = JSON.parse(event.data) as unknown;
          } catch {
            throw new ProviderError('invalid-response', 'Gemini returned an invalid chunk', false);
          }
          const parsed = geminiResponseSchema.safeParse(rawJson);
          if (!parsed.success)
            throw new ProviderError('invalid-response', 'Gemini returned an invalid chunk', false);
          const candidate = parsed.data.candidates[0];
          if (parsed.data.modelVersion !== undefined) modelVersion = parsed.data.modelVersion;
          if (parsed.data.usageMetadata !== undefined) usage = parsed.data.usageMetadata;
          if (candidate?.finishReason !== undefined)
            finishReason = safeFinishReason(candidate.finishReason);
          let deltaText = '';
          let deltaReasoning = '';
          for (const part of candidate?.content?.parts ?? []) {
            if (part.functionCall !== undefined) {
              toolCalls.push({
                ...(part.functionCall.id === undefined ? {} : { id: part.functionCall.id }),
                name: part.functionCall.name,
                args: part.functionCall.args ?? {},
              });
            } else if (part.thought === true) {
              deltaReasoning += part.text ?? '';
            } else if (part.text !== undefined) deltaText += part.text;
          }
          text += deltaText;
          reasoning += deltaReasoning;
          // Keep signatures and other opaque provider fields unchanged for tool turns.
          const raw = (rawJson as { candidates?: { content?: { parts?: unknown } }[] })
            .candidates?.[0]?.content?.parts;
          if (Array.isArray(raw)) rawParts.push(...(raw as unknown[]));
          if (deltaText !== '' || deltaReasoning !== '')
            request.onChunk?.({ text: deltaText, reasoning: deltaReasoning });
          emitProgress();
          checkAbort();
        }
        checkAbort();
      } catch (error) {
        if (error instanceof ProviderError) throw this.safeError(error);
        if (isTimeoutError(error))
          throw new ProviderError('timeout', 'Gemini stream timed out', true, { host: this.host });
        const netCode = netCodeOf(error);
        throw new ProviderError('outage', 'Gemini stream failed', true, {
          host: this.host,
          ...(netCode === undefined ? {} : { netCode }),
        });
      } finally {
        releaseReader();
      }
      if (text === '' && toolCalls.length === 0) {
        const emptyUsage = usage;
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

      return {
        text,
        model: modelVersion ?? request.model,
        ...(finishReason ? { finishReason } : {}),
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
        ...(rawParts.length === 0 ? {} : { providerParts: rawParts }),
        ...(reasoning === '' ? {} : { reasoning }),
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
    } finally {
      clearTimers();
    }
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
