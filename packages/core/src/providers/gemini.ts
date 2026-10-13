import { z } from 'zod';
import { parseSseStream } from './sse.js';
import { invokeStreamCallback } from './callbacks.js';
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
import { types as utilTypes } from 'node:util';
import { netCodeOf } from './failure.js';
import { assertOutboundRequestSafe } from './outbound-safety.js';
import type { Logger } from '../obs/logger.js';

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
const toContents = (messages: readonly GenerationMessage[], caps: ModelCapabilities): unknown[] => {
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
      parts: [
        { text: message.text },
        ...(message.role === 'user' && message.media !== undefined
          ? message.media
              // The request's effective capabilities gate every part: an image
              // or PDF the entry forbids is never sent.
              .filter((m) => (m.kind === 'image' ? caps.image : caps.pdf))
              .map((m) => ({
                inlineData: { mimeType: m.mediaType, data: m.dataBase64 },
              }))
          : []),
      ],
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

/** Cleanup is best-effort, including synchronous throws and rejected promises. */
const bestEffort = (action: () => unknown): void => {
  try {
    void Promise.resolve(action()).catch(() => {});
  } catch {
    // Never replace a primary failure or a completed answer with cleanup errors.
  }
};
const cancelResponse = (response: Response): void => {
  bestEffort(() => response.body?.cancel());
};

// sse.ts exposes bounds as plain Errors. Only recognize these at iterator.next,
// never when an injected source or consumer callback is the origin.
const isSseBoundError = (error: unknown): boolean => {
  try {
    if (utilTypes.isProxy(error) || !utilTypes.isNativeError(error)) return false;
    const message = Object.getOwnPropertyDescriptor(error, 'message')?.value as unknown;
    return (
      message === 'SSE line exceeds 1048576 characters' ||
      message === 'SSE event exceeds 8388608 characters'
    );
  } catch {
    return false;
  }
};

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

  /** Only the exact, validated ProviderError shape can retain its identity. */
  private safeError(error: ProviderError): ProviderError {
    const finite = z.number().finite();
    const cleanString = z.string().refine((value) => !value.includes(this.apiKey));
    const shape = z
      .object({
        kind: z.enum([
          'authentication',
          'quota',
          'rate-limit',
          'timeout',
          'safety-refusal',
          'invalid-request',
          'outage',
          'capability-mismatch',
          'invalid-response',
        ]),
        retryable: z.boolean(),
        name: cleanString.optional(),
        message: cleanString,
        stack: cleanString.optional(),
        cause: z.undefined().optional(),
        resetAt: finite.optional(),
        quotaScope: z.enum(['daily-free', 'day', 'minute']).optional(),
        retryAfterMs: finite.optional(),
        status: finite.optional(),
        learnedLimit: z
          .object({ perDay: finite.optional(), perMinute: finite.optional() })
          .strict()
          .optional(),
        host: cleanString.optional(),
        netCode: cleanString.optional(),
        upstream: cleanString.optional(),
        finishReason: cleanString.refine((value) => FINISH_REASONS.has(value)).optional(),
        emptyAnswer: z
          .object({
            completionTokens: finite.optional(),
            reasoningTokens: finite.optional(),
            reasoningOnly: z.boolean(),
          })
          .strict()
          .optional(),
      })
      .strict();
    // Read data descriptors, never accessors or toJSON. Reject subclasses and
    // extra fields rather than trusting their arbitrary reachable diagnostics.
    if (utilTypes.isProxy(error)) throw new Error('proxy');
    const own: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const allowedKeys = new Set<string>(Object.keys(shape.shape));
    let dataOnly = true;
    for (const key of Reflect.ownKeys(error)) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) {
        dataOnly = false;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      if (
        key === 'stack' &&
        descriptor?.get === Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get
      ) {
        try {
          Object.defineProperty(own, 'stack', { value: error.stack, enumerable: true });
        } catch {
          dataOnly = false;
        }
        continue;
      }
      if (descriptor === undefined || !('value' in descriptor)) {
        dataOnly = false;
        continue;
      }
      Object.defineProperty(own, key, { value: descriptor.value as unknown, enumerable: true });
    }
    const plainNested = (value: unknown, keys: readonly string[]): boolean => {
      if (value === undefined) return true;
      if (
        typeof value !== 'object' ||
        value === null ||
        utilTypes.isProxy(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
      )
        return false;
      return Reflect.ownKeys(value).every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          typeof key === 'string' &&
          keys.includes(key) &&
          descriptor !== undefined &&
          'value' in descriptor
        );
      });
    };
    if (
      dataOnly &&
      Object.getPrototypeOf(error) === ProviderError.prototype &&
      plainNested(own.learnedLimit, ['perDay', 'perMinute']) &&
      plainNested(own.emptyAnswer, ['completionTokens', 'reasoningTokens', 'reasoningOnly']) &&
      shape.safeParse(own).success
    )
      return error;

    // Rebuild only validated primitive evidence, discarding unknown objects,
    // nonenumerable diagnostics, aggregate errors, causes and custom hooks.
    const primitive = <T>(schema: z.ZodType<T>, value: unknown): T | undefined => {
      const result = schema.safeParse(value);
      return result.success ? result.data : undefined;
    };
    const kind = primitive(shape.shape.kind, own.kind) ?? 'outage';
    const retryable = primitive(z.boolean(), own.retryable) ?? true;
    const evidence: Record<string, unknown> = {};
    for (const key of ['resetAt', 'retryAfterMs', 'status'] as const) {
      const value = primitive(finite, own[key]);
      if (value !== undefined) evidence[key] = value;
    }
    for (const key of ['host', 'netCode', 'upstream'] as const) {
      const value = primitive(cleanString, own[key]);
      if (value !== undefined) evidence[key] = value;
    }
    const quotaScope = primitive(z.enum(['daily-free', 'day', 'minute']), own.quotaScope);
    if (quotaScope !== undefined) evidence.quotaScope = quotaScope;
    const finishReason = primitive(shape.shape.finishReason, own.finishReason);
    if (finishReason !== undefined) evidence.finishReason = finishReason;
    const nested = (object: unknown, keys: readonly string[]): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      if (typeof object !== 'object' || object === null || utilTypes.isProxy(object)) return result;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (descriptor === undefined || !('value' in descriptor)) continue;
        const value =
          key === 'reasoningOnly'
            ? primitive(z.boolean(), descriptor.value as unknown)
            : primitive(finite, descriptor.value as unknown);
        if (value !== undefined) result[key] = value;
      }
      return result;
    };
    const learnedLimit = nested(own.learnedLimit, ['perDay', 'perMinute']);
    if (Object.keys(learnedLimit).length > 0) evidence.learnedLimit = learnedLimit;
    const emptyAnswer = nested(own.emptyAnswer, [
      'completionTokens',
      'reasoningTokens',
      'reasoningOnly',
    ]);
    if (typeof emptyAnswer.reasoningOnly === 'boolean') evidence.emptyAnswer = emptyAnswer;
    return new ProviderError(kind, 'Gemini provider failed', retryable, evidence);
  }

  private genericFailure(): ProviderError {
    return new ProviderError('outage', 'Gemini provider failed', true, { host: this.host });
  }

  /** Fail-closed ProviderError identity check: never throws, never leaks inspection errors. */
  private retainedProviderError(error: unknown): ProviderError | undefined {
    try {
      if (utilTypes.isProxy(error)) return this.genericFailure();
      if (!(error instanceof ProviderError)) return undefined;
      return this.safeError(error);
    } catch {
      return this.genericFailure();
    }
  }

  private safeClassify(error: unknown): { timeout: boolean; netCode?: string } {
    if (utilTypes.isProxy(error)) return { timeout: false };
    const timeout = ((): boolean => {
      try {
        return isTimeoutError(error);
      } catch {
        return false;
      }
    })();
    let netCode: string | undefined;
    try {
      netCode = netCodeOf(error);
    } catch {
      netCode = undefined;
    }
    return { timeout, ...(netCode === undefined ? {} : { netCode }) };
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
    let abortReason: DOMException | undefined;
    const onAbort = (): void => {
      abortReason = this.safeClassify(signal.reason).timeout
        ? new DOMException('Gemini request timed out', 'TimeoutError')
        : new DOMException('Gemini request aborted', 'AbortError');
      rejectAbort(abortReason);
    };
    const checkAbort = (): void => {
      if (signal.aborted)
        throw abortReason ?? new DOMException('Gemini request aborted', 'AbortError');
    };
    const cancelBody = cancelResponse;
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
        contents: toContents(request.messages, capabilities),
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
        const retained = this.retainedProviderError(error);
        if (retained !== undefined) throw retained;
        const { timeout: timeoutError, netCode } = this.safeClassify(error);
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
                if (chunk.value.byteLength > 0) noteByte();
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
              const retained = this.retainedProviderError(error);
              if (retained !== undefined) throw retained;
              if (signal.aborted) {
                throw new ProviderError(
                  abortReason?.name === 'TimeoutError' ? 'timeout' : 'outage',
                  abortReason?.name === 'TimeoutError'
                    ? 'Gemini request timed out'
                    : 'Gemini request aborted',
                  true,
                  { host: this.host, status: 429 },
                );
              }
              body = undefined;
            } finally {
              bestEffort(() => reader.cancel());
              bestEffort(() => reader.releaseLock());
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
        // Progress callbacks can never fail the call: fire-and-forget and
        // synchronous, with sync throws and async rejections swallowed, so a
        // broken callback neither aborts the stream nor becomes a ProviderError.
        const onProgress = request.onProgress;
        if (onProgress !== undefined)
          invokeStreamCallback(() =>
            onProgress({
              round: 0,
              answerChars: text.length,
              reasoningChars: reasoning.length,
              keepalives,
              msSinceLastByte: now - lastByteAt,
            }),
          );
      };
      // Observe raw byte arrivals before parsing: fragmented SSE lines count as
      // activity too. The wrapper makes abort independent of source cooperation.
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let exhausted = false;
      const releaseReader = (): void => {
        if (!exhausted) bestEffort(() => reader.cancel());
        bestEffort(() => reader.releaseLock());
      };
      let sourceFailure: unknown;
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
            sourceFailure = error;
            output.error(error);
          }
        },
      });
      const events = async function* () {
        const iterator = parseSseStream(bytes);
        try {
          for (;;) {
            let next: Awaited<ReturnType<typeof iterator.next>>;
            try {
              next = await iterator.next();
            } catch (error) {
              if (error !== sourceFailure && isSseBoundError(error))
                throw new ProviderError('invalid-response', 'Gemini SSE bound exceeded', false);
              throw error;
            }
            if (next.done) return;
            yield next.value;
          }
        } finally {
          await iterator.return(undefined);
        }
      };
      try {
        for await (const event of events()) {
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
          if (deltaText !== '' || deltaReasoning !== '') {
            // Progress callbacks can never fail the call (see callbacks.ts).
            const onChunk = request.onChunk;
            if (onChunk !== undefined)
              invokeStreamCallback(() => onChunk({ text: deltaText, reasoning: deltaReasoning }));
          }
          emitProgress();
          checkAbort();
        }
        checkAbort();
      } catch (error) {
        const retained = this.retainedProviderError(error);
        if (retained !== undefined) throw retained;
        const { timeout: streamTimeout, netCode } = this.safeClassify(error);
        if (streamTimeout)
          throw new ProviderError('timeout', 'Gemini stream timed out', true, { host: this.host });
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
          reasoningOnly: reasoning !== '',
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
    } catch (error) {
      // Covers Response getters, reader setup and all other post-fetch work.
      const retained = this.retainedProviderError(error);
      if (retained !== undefined) throw retained;
      const { timeout, netCode } = this.safeClassify(error);
      throw new ProviderError(
        timeout ? 'timeout' : 'outage',
        timeout ? 'Gemini request timed out' : 'Gemini response handling failed',
        true,
        { host: this.host, ...(netCode === undefined ? {} : { netCode }) },
      );
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
  readonly logger?: Pick<Logger, 'warn'>;
}): Promise<readonly GeminiModelInfo[]> => {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const host = new URL(base).host;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const found: GeminiModelInfo[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const url = `${base}/models?pageSize=1000${pageToken === undefined ? '' : `&pageToken=${encodeURIComponent(pageToken)}`}`;
    const controller = new AbortController();
    const timedOut = new ProviderError('timeout', 'Gemini model list timed out', true, { host });
    let rejectTimeout!: (error: ProviderError) => void;
    const expired = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    void expired.catch(() => {});
    const timer = setTimeout(() => {
      controller.abort();
      rejectTimeout(timedOut);
    }, options.timeoutMs ?? 15_000);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let localFailure: ProviderError | undefined;
    let fetching = true;
    let parsed: z.SafeParseSuccess<z.infer<typeof modelListSchema>>;
    const invalidList = (): never => {
      localFailure = new ProviderError(
        'invalid-response',
        'Gemini returned an invalid model list',
        false,
        { host },
      );
      throw localFailure;
    };
    try {
      const fetched = fetchImpl(url, {
        headers: { 'x-goog-api-key': options.apiKey },
        signal: controller.signal,
      }).then((result) => {
        if (controller.signal.aborted) {
          cancelResponse(result);
          throw timedOut;
        }
        return result;
      });
      response = await Promise.race([fetched, expired]);
      fetching = false;
      if (!response.ok) {
        const status = response.status;
        const kind = statusKind(status);
        localFailure = new ProviderError(
          kind,
          `Gemini model list failed with HTTP ${status}`,
          kind === 'rate-limit' || kind === 'outage',
          { status, host },
        );
        throw localFailure;
      }
      if (response.body === null) invalidList();
      reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = '';
      let bytesRead = 0;
      for (;;) {
        // A body stream that dies mid-read is a transport outage (retryable), not a bad list.
        fetching = true;
        const chunk = await Promise.race([reader.read(), expired]);
        fetching = false;
        if (chunk.done) break;
        bytesRead += chunk.value.byteLength;
        // Generous for 1000 models with descriptions, but never an unbounded read.
        if (bytesRead > 8_388_608) invalidList();
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      let raw: unknown;
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        invalidList();
      }
      const result = modelListSchema.safeParse(raw);
      if (!result.success) invalidList();
      parsed = result as z.SafeParseSuccess<z.infer<typeof modelListSchema>>;
    } catch (error) {
      if (controller.signal.aborted) throw timedOut;
      if (localFailure !== undefined && error === localFailure) throw localFailure;
      let netCode: string | undefined;
      try {
        netCode = netCodeOf(error);
      } catch {
        netCode = undefined;
      }
      throw new ProviderError(
        fetching ? 'outage' : 'invalid-response',
        fetching ? 'Gemini model list request failed' : 'Gemini returned an invalid model list',
        fetching,
        { host, ...(netCode === undefined ? {} : { netCode }) },
      );
    } finally {
      clearTimeout(timer);
      if (reader !== undefined) {
        const cleanupReader = reader;
        bestEffort(() => cleanupReader.cancel());
        bestEffort(() => cleanupReader.releaseLock());
      } else if (response !== undefined) cancelResponse(response);
    }
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
  if (pageToken !== undefined && pageToken !== '')
    options.logger?.warn({ host }, 'Gemini model list stopped at the 10-page bound');
  return found;
};
