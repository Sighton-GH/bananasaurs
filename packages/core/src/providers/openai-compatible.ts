import { types as utilTypes } from 'node:util';
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
import { TEXT_AND_TOOLS_ONLY, type ModelCapabilities } from './model-capabilities.js';
import { assertOutboundRequestSafe } from './outbound-safety.js';
import { parseSseStream } from './sse.js';

/** OpenRouter-only: non-answer reasoning for Responses-API-style providers (ADR 0129 §4). */
const reasoningTextSchema = z.string().nullable().optional();

const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
  completion_tokens_details: z
    .object({ reasoning_tokens: z.number().int().nonnegative().optional() })
    .partial()
    .optional(),
  /** ADR 0129 §8: OpenRouter's per-call cost, only when `usage.include` was requested. */
  cost: z.number().nonnegative().optional(),
});

const streamErrorSchema = z.object({
  message: z.string().optional(),
  code: z.union([z.number(), z.string()]).optional(),
});

/**
 * One streamed chunk. Deltas replace the old `message` shape; tool-call
 * arguments arrive fragmented per `index` and are concatenated before they
 * are parsed once at the end.
 */
const streamChunkSchema = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullable().optional(),
            reasoning: reasoningTextSchema,
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().nonnegative().optional(),
                  id: z.string().optional(),
                  type: z.string().optional(),
                  function: z
                    .object({
                      name: z.string().min(1).optional(),
                      arguments: z.string().optional(),
                    })
                    .default({}),
                }),
              )
              .optional(),
          })
          .optional(),
        finish_reason: z.string().nullable().optional(),
        error: streamErrorSchema.nullish(),
      }),
    )
    .default([]),
  /** Top-level error object: some providers fail a 200 stream without any choice. */
  error: streamErrorSchema.nullish(),
  usage: usageSchema.nullish(),
});

export interface OpenAiCompatibleProviderOptions {
  readonly id: 'openrouter' | 'nvidia-nim';
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxCallMs?: number;
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

/** Shared by the fetch catch and the success-body catch: the timeout signal fires in either place. */
const isTimeoutError = (error: unknown): boolean => {
  // Untrusted input: a Proxy trap or a throwing `name` accessor must read as "not a timeout".
  try {
    return (
      !utilTypes.isProxy(error) && error instanceof DOMException && error.name === 'TimeoutError'
    );
  } catch {
    return false;
  }
};

/**
 * An abort reason is untrusted too. Keep a real Error (so a TimeoutError stays classifiable)
 * and replace anything hostile with a plain AbortError without touching it further.
 */
const normalizeAbortReason = (reason: unknown): Error => {
  try {
    if (!utilTypes.isProxy(reason) && reason instanceof Error) return reason;
  } catch {
    // fall through to the plain AbortError
  }
  return new DOMException('aborted', 'AbortError');
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
const upstreamFromError = (
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const providerName = metadata?.['provider_name'];
  return typeof providerName === 'string' && providerName !== ''
    ? redactKey(providerName, key).slice(0, 60)
    : undefined;
};

/** Never trust an upstream error body: bounded before it is even parsed. */
const MAX_ERROR_BODY_CHARS = 4_096;

const readErrorBody = async (response: Response, abortRace: Promise<never>): Promise<unknown> => {
  if (response.body === null) return undefined;
  // undici-types declares `body: ReadableStream` (implicit any payload);
  // the runtime payload is always bytes.
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let text = '';
  try {
    const decoder = new TextDecoder();
    for (;;) {
      const next = reader.read();
      next.catch(() => undefined); // a read that loses to the abort race
      const { done, value } = await Promise.race([next, abortRace]);
      if (done === true) break;
      text += decoder.decode(value, { stream: true });
      if (text.length >= MAX_ERROR_BODY_CHARS) break; // bounded: enough to parse
    }
    text += decoder.decode();
  } catch {
    // Any read failure - including the abort race unblocking a
    // non-cooperative body - maps to "no usable body", exactly as a
    // response.text() failure did before; the status mapping below is
    // byte-identical either way.
    return undefined;
  } finally {
    // Never awaited: a non-cooperative body can leave cancel() pending and
    // the abort path must still settle.
    const cancelled = reader.cancel();
    cancelled.catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return JSON.parse(text.slice(0, MAX_ERROR_BODY_CHARS)) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Percent-encoded spellings of the key (every character, either hex case, and
 * the usual encodeURIComponent form): a URL inside an upstream message can echo it.
 */
const keyForms = (key: string): readonly string[] => {
  const bytes = [...new TextEncoder().encode(key)];
  const hex = (upper: boolean): string =>
    bytes
      .map((byte) =>
        `%${upper ? byte.toString(16).toUpperCase() : byte.toString(16)}`.replace(
          /^%(\d|[a-fA-F])$/,
          '%0$1',
        ),
      )
      .join('');
  return [key, encodeURIComponent(key), hex(true), hex(false)];
};

/**
 * CLAUDE.md rule 4: the key must never appear in an error message, log, or
 * stored trace. Anything upstream-derived can echo it back: a URL inside a
 * fetch TypeError, a nested `Bearer <key>` cause, a short key inside a
 * SyntaxError snippet, a 401 body quoting the authorization header, a
 * percent-encoded copy of the key in a URL.
 */
const redactKey = (text: string, key: string): string => {
  if (key === '') return text;
  const keys = [...new Set([key, key.trim()])].filter((candidate) => candidate !== '');
  let out = text;
  for (const candidate of keys)
    for (const form of keyForms(candidate))
      if (form !== '') out = out.split(form).join('(redacted)');
  const hasKey = (value: string): boolean => keys.some((candidate) => value.includes(candidate));
  // Tolerant decode of the whole string: every valid ASCII %XX is decoded in place, literal
  // characters stay, and a malformed % is left alone, so a mixed literal/encoded spelling of
  // the key is still found.
  const tolerant = out.replace(/%([0-9a-fA-F]{2})/g, (match, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return code < 0x80 ? String.fromCharCode(code) : match;
  });
  if (hasKey(tolerant)) return '(redacted)';
  try {
    if (hasKey(decodeURIComponent(out))) return '(redacted)';
  } catch {
    // Malformed percent-encoding: the tolerant pass above already covered ASCII keys.
  }
  return out.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return hasKey(decodeURIComponent(run)) ? '(redacted)' : run;
    } catch {
      return run;
    }
  });
};

/** Errors this adapter built itself. Anything else that reaches a catch is untrusted input. */
const trustedErrors = new WeakSet<ProviderError>();
const trusted = (...args: ConstructorParameters<typeof ProviderError>): ProviderError => {
  const error = new ProviderError(...args);
  trustedErrors.add(error);
  return error;
};
const isTrusted = (error: unknown): error is ProviderError =>
  typeof error === 'object' && error !== null && trustedErrors.has(error as ProviderError);

const PROVIDER_KINDS: ReadonlySet<string> = new Set<string>([
  'authentication',
  'quota',
  'rate-limit',
  'timeout',
  'safety-refusal',
  'invalid-request',
  'outage',
  'capability-mismatch',
  'invalid-response',
]);
const QUOTA_SCOPES: ReadonlySet<string> = new Set<string>(['daily-free', 'day', 'minute']);

/**
 * Reads an own DATA property of an untrusted value without running getters,
 * proxy traps or toJSON. Any failure reads as "absent".
 */
const readOwn = (target: unknown, name: string): unknown => {
  try {
    if ((typeof target !== 'object' || target === null) && typeof target !== 'function')
      return undefined;
    if (utilTypes.isProxy(target)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    return descriptor !== undefined && 'value' in descriptor
      ? (descriptor.value as unknown)
      : undefined;
  } catch {
    return undefined;
  }
};

/** Network code from the untrusted error or its cause chain, read without executing anything. */
const safeNetCode = (error: unknown): string | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth <= 5; depth += 1) {
    const code = netCodeOf({ code: readOwn(current, 'code') });
    if (code !== undefined) return code;
    current = readOwn(current, 'cause');
  }
  return undefined;
};

/** Copy only safe diagnostics. Never mutate or retain an untrusted cause graph. */
const sanitizeCause = (error: unknown, key: string): Error => {
  const messageOf = (target: unknown): string => {
    const raw = typeof target === 'string' ? target : readOwn(target, 'message');
    return redactKey(typeof raw === 'string' ? raw : 'request failed', key);
  };
  const safeString = (name: string, max: number): string | undefined => {
    const value = readOwn(error, name);
    return typeof value === 'string' ? redactKey(value, key).slice(0, max) : undefined;
  };
  const safeNumber = (name: string): number | undefined => {
    const value = readOwn(error, name);
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  let providerShaped: boolean;
  try {
    providerShaped = !utilTypes.isProxy(error) && error instanceof ProviderError;
  } catch {
    providerShaped = false;
  }
  if (providerShaped) {
    const kindRaw = readOwn(error, 'kind');
    const kind: ProviderErrorKind =
      typeof kindRaw === 'string' && PROVIDER_KINDS.has(kindRaw)
        ? (kindRaw as ProviderErrorKind)
        : 'outage';
    const retryableRaw = readOwn(error, 'retryable');
    const quotaRaw = readOwn(error, 'quotaScope');
    const cause = readOwn(error, 'cause');
    const status = safeNumber('status');
    const retryAfterMs = safeNumber('retryAfterMs');
    const resetAt = safeNumber('resetAt');
    const host = safeString('host', 253);
    const ownNetCode = readOwn(error, 'netCode');
    const netCode =
      (typeof ownNetCode === 'string' ? netCodeOf({ code: ownNetCode }) : undefined) ??
      safeNetCode(error);
    const upstream = safeString('upstream', 60);
    const finishReason = safeString('finishReason', 60);
    const safe = new ProviderError(
      kind,
      messageOf(error),
      typeof retryableRaw === 'boolean' ? retryableRaw : true,
      {
        ...(cause === undefined ? {} : { cause: new Error(messageOf(cause)) }),
        ...(status === undefined ? {} : { status }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        ...(resetAt === undefined ? {} : { resetAt }),
        ...(typeof quotaRaw === 'string' && QUOTA_SCOPES.has(quotaRaw)
          ? { quotaScope: quotaRaw as 'daily-free' | 'day' | 'minute' }
          : {}),
        ...(host === undefined ? {} : { host }),
        ...(netCode === undefined ? {} : { netCode }),
        ...(upstream === undefined ? {} : { upstream }),
        ...(finishReason === undefined ? {} : { finishReason }),
      },
    );
    trustedErrors.add(safe);
    return safe;
  }
  const safe = new Error(messageOf(error));
  const code = readOwn(error, 'code');
  if (typeof code === 'string')
    Object.defineProperty(safe, 'code', { value: redactKey(code, key).slice(0, 64) });
  return safe;
};

// eslint-disable-next-line no-control-regex -- deliberately stripping control characters, not matching them by accident.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * The provider's short reason for a non-2xx, safe to log: the error code and
 * up to 160 characters of its message, control characters stripped. Never
 * the request, headers, or key (CLAUDE.md rule 4).
 */
const shortReason = (
  detail: z.infer<typeof errorBodySchema> | undefined,
  key: string,
): string | undefined => {
  if (detail === undefined) return undefined;
  const { code, message } = detail.error;
  // Redact BEFORE slicing so a key straddling the 160-char cut cannot leak a fragment.
  const cleanMessage =
    message === undefined
      ? undefined
      : redactKey(message.replace(CONTROL_CHARS, ''), key).slice(0, 160);
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

/** HTTP `Retry-After` (delay seconds or HTTP date) in ms, capped to one hour. */
const parseRetryAfterMs = (raw: string | null): number | undefined => {
  if (raw === null || raw.trim() === '') return undefined;
  if (/^\d+$/.test(raw.trim())) return Math.min(Number(raw.trim()) * 1000, 3_600_000);
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(date - Date.now(), 0), 3_600_000);
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
      throw trusted(
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
  private readonly idleTimeoutMs: number;
  private readonly maxCallMs: number;
  private readonly extraHeaders: Readonly<Record<string, string>>;

  public constructor(options: OpenAiCompatibleProviderOptions) {
    if (options.apiKey.trim() === '') throw new Error(`${options.id} API key must not be empty`);
    this.id = options.id;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.host = new URL(this.baseUrl).host;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
    this.maxCallMs = options.maxCallMs ?? 300_000;
    this.extraHeaders = options.extraHeaders ?? {};
  }

  public async generateText(request: GenerateTextRequest): Promise<GenerateTextResponse> {
    assertOutboundRequestSafe(request);
    if (request.messages.length === 0)
      throw trusted('invalid-request', 'at least one message is required', false);
    // Capability gate: a thinking/reasoning parameter is never sent to a
    // model whose capabilities do not support it. Unknown model (no
    // catalogue) falls back to text + tools only, so nothing is sent.
    const capabilities: ModelCapabilities = request.capabilities ?? TEXT_AND_TOOLS_ONLY;
    // Three timers (time-to-first-byte, idle re-armed per byte, absolute
    // ceiling) plus the caller's signal compose through one controller;
    // AbortSignal.timeout alone cannot express that.
    const controller = new AbortController();
    const abortTimeout = (): void => {
      controller.abort(new DOMException(`${this.id} stream timed out`, 'TimeoutError'));
    };
    const timers: ReturnType<typeof setTimeout>[] = [];
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = (): void => {
      while (timers.length > 0) clearTimeout(timers.pop());
      if (idleTimer !== undefined) clearTimeout(idleTimer);
    };
    const rearmIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(abortTimeout, this.idleTimeoutMs);
    };
    // One shared rejection raced against the fetch and against every stream
    // read, so a timer (or caller abort) unblocks a fetch or a mocked stream
    // that never settles. The extra catch marks a losing race as handled.
    const abortRace: Promise<never> = new Promise((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          const reason: unknown = controller.signal.reason;
          reject(normalizeAbortReason(reason));
        },
        { once: true },
      );
    });
    abortRace.catch(() => undefined);
    const callerSignal = request.signal;
    const onCallerAbort = (): void => {
      controller.abort(callerSignal?.reason);
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    // Set only on the success return: error exits abort the controller in
    // the finally so an in-flight fetch or unread body is torn down.
    let completed = false;
    try {
      // A caller signal that is already aborted must never reach fetch.
      if (callerSignal?.aborted === true) {
        const reason: unknown = callerSignal.reason;
        throw trusted('outage', `${this.id} request failed`, true, {
          cause: sanitizeCause(normalizeAbortReason(reason), this.apiKey),
          host: this.host,
        });
      }
      timers.push(setTimeout(abortTimeout, this.maxCallMs)); // hard ceiling
      const firstByteTimer = setTimeout(abortTimeout, this.timeoutMs); // time to first byte
      timers.push(firstByteTimer);
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
        stream: true,
        // Usage arrives in the final chunk. NIM has no usage-include field
        // (see above), so it gets neither streaming-usage option.
        ...(this.id === 'openrouter' ? { stream_options: { include_usage: true } } : {}),
        ...(this.id === 'openrouter' && capabilities.reasoning
          ? { reasoning: { exclude: false } }
          : {}),
      });
      let response: Response;
      try {
        const fetchPromise = this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
            ...this.extraHeaders,
          },
          body,
          signal: controller.signal,
        });
        fetchPromise.catch(() => undefined);
        // A fetch that loses the race to a timer still resolves later; its
        // unread body must be cancelled or the connection lingers.
        fetchPromise
          .then((lateResponse) => {
            if (controller.signal.aborted) {
              const cancelledBody = lateResponse.body?.cancel();
              cancelledBody?.catch(() => undefined);
            }
          })
          .catch(() => undefined);
        response = await Promise.race([fetchPromise, abortRace]);
      } catch (error) {
        // Unchanged mapping: TimeoutError (ours or the caller's deadline) →
        // retryable timeout; anything else → outage. A caller abort surfaces
        // as an AbortError (not TimeoutError) and keeps today's outage mapping.
        const timeout = isTimeoutError(error);
        const netCode = safeNetCode(error);
        throw trusted(
          timeout ? 'timeout' : 'outage',
          `${this.id} request ${timeout ? 'timed out' : 'failed'}`,
          true,
          {
            cause: sanitizeCause(error, this.apiKey),
            host: this.host,
            ...(netCode === undefined ? {} : { netCode }),
          },
        );
      }
      if (!response.ok) {
        const parsedBody = errorBodySchema.safeParse(await readErrorBody(response, abortRace));
        const detail = parsedBody.success ? parsedBody.data : undefined;
        const metadata = detail?.error.metadata;
        const reason = shortReason(detail, this.apiKey);
        const retryAfterMs =
          response.status === 429
            ? parseRetryAfterMs(response.headers.get('retry-after'))
            : undefined;
        if (
          response.status === 429 &&
          isDailyFreeQuota(request.model, detail?.error.message, metadata)
        ) {
          const resetAt = resolveResetAt(response, metadata, Date.now());
          const upstream = upstreamFromError(metadata, this.apiKey);
          throw trusted(
            'quota',
            reason === undefined
              ? `${this.id} free-model daily limit reached`
              : `${this.id} free-model daily limit reached (${reason})`,
            false,
            {
              quotaScope: 'daily-free',
              status: response.status,
              host: this.host,
              ...(upstream === undefined ? {} : { upstream }),
              ...(resetAt === undefined ? {} : { resetAt }),
              ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            },
          );
        }
        const kind = statusKind(response.status);
        const upstream = upstreamFromError(metadata, this.apiKey);
        throw trusted(
          kind,
          reason === undefined
            ? `${this.id} request failed with HTTP ${response.status}`
            : `${this.id} request failed with HTTP ${response.status} (${reason})`,
          kind === 'rate-limit' || kind === 'outage',
          {
            status: response.status,
            host: this.host,
            ...(upstream === undefined ? {} : { upstream }),
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          },
        );
      }
      if (response.body === null)
        throw trusted('invalid-response', `${this.id} returned no body`, false, {
          host: this.host,
        });
      rearmIdle(); // the idle timer owns the body from here; keepalives count as bytes
      let text = '';
      let reasoning = '';
      let model: string | undefined;
      let upstream: string | undefined;
      let finishReason: string | undefined;
      let usage: z.infer<typeof usageSchema> | undefined;
      type ToolFragment = {
        index: number;
        seq: number;
        id?: string;
        name?: string;
        argsText: string;
      };
      const toolFragments: ToolFragment[] = [];
      let toolSeq = 0;
      let answerChars = 0;
      let reasoningChars = 0;
      let keepalives = 0;
      let lastByteAt = Date.now();
      // Own the actual body reader outside the parser so timeout cleanup can
      // cancel a read even if the SSE generator is waiting for another byte.
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let released = false;
      const closeBody = (): void => {
        if (released) return;
        released = true;
        const cancelled = reader.cancel();
        cancelled.catch(() => undefined);
        reader.releaseLock();
      };
      const byteChunks = async function* (): AsyncGenerator<string> {
        const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
        try {
          for (;;) {
            const next = reader.read();
            next.catch(() => undefined);
            const { done, value } = await Promise.race([next, abortRace]);
            if (done) break;
            if (value.byteLength > 0) {
              clearTimeout(firstByteTimer);
              lastByteAt = Date.now();
              rearmIdle();
            }
            yield decoder.decode(value, { stream: true });
          }
          yield decoder.decode();
        } finally {
          closeBody();
        }
      };
      /**
       * Typed void callbacks can still return promises (same as Gemini): observe them, race
       * them against the abort so a slow callback stays inside the ceiling, and sanitise
       * any rejection so it can neither reach the key nor become an unhandled rejection.
       */
      const runCallback = async (call: () => unknown): Promise<void> => {
        let pending: Promise<unknown>;
        try {
          pending = Promise.resolve(call());
        } catch (error) {
          throw sanitizeCause(error, this.apiKey);
        }
        const guarded = pending.then(
          () => undefined,
          (error: unknown) => {
            throw sanitizeCause(error, this.apiKey);
          },
        );
        await Promise.race([guarded, abortRace]);
      };
      let lastEmitAt = 0;
      const emitProgress = async (): Promise<void> => {
        const onProgress = request.onProgress;
        if (onProgress === undefined) return;
        const now = Date.now();
        if (lastEmitAt !== 0 && now - lastEmitAt < 3_000) return; // at most every 3 s
        lastEmitAt = now;
        await runCallback(() =>
          onProgress({
            round: 0, // the tool loop stamps the real round
            answerChars,
            reasoningChars,
            keepalives,
            msSinceLastByte: Math.max(0, now - lastByteAt),
          }),
        );
      };
      const events = parseSseStream(byteChunks());
      // Tracks whether the generator is parked at a yield: only then can
      // events.return() settle (see the catch below).
      let eventsAtYield = false;
      try {
        for (;;) {
          eventsAtYield = false;
          const next = events.next();
          next.catch(() => undefined); // a read that loses to the abort race
          const result = await Promise.race([next, abortRace]);
          eventsAtYield = true;
          if (result.done === true) break;
          const event = result.value;
          if (event.keepalive) {
            keepalives += 1;
            await emitProgress();
            continue;
          }
          if (event.data === '') continue; // bare empty-data event: bytes, not a chunk
          let rawChunk: unknown;
          try {
            rawChunk = JSON.parse(event.data);
          } catch (error) {
            throw trusted('invalid-response', `${this.id} returned an invalid chunk`, false, {
              cause: sanitizeCause(error, this.apiKey),
            });
          }
          const parsed = streamChunkSchema.safeParse(rawChunk);
          if (!parsed.success)
            throw trusted('invalid-response', `${this.id} returned an invalid chunk`, false, {
              cause: sanitizeCause(parsed.error, this.apiKey),
            });
          const chunk = parsed.data;
          if (chunk.model !== undefined) model = redactKey(chunk.model, this.apiKey);
          if (chunk.provider !== undefined) upstream = redactKey(chunk.provider, this.apiKey);
          if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage;
          if (chunk.error != null) {
            // Top-level error object (no choice carries it): the same
            // mid-stream failure as a choice error - retryable, partial
            // text discarded, never delivered, never stored.
            throw trusted('outage', `${this.id} stream failed mid-response`, true, {
              host: this.host,
              finishReason: 'error',
              ...(upstream === undefined ? {} : { upstream }),
            });
          }
          let deltaText = '';
          let deltaReasoning = '';
          for (const choice of chunk.choices) {
            if (choice.error != null || choice.finish_reason === 'error') {
              // Mid-stream failure inside a 200: retryable, partial text
              // discarded — never delivered, never stored.
              throw trusted('outage', `${this.id} stream failed mid-response`, true, {
                host: this.host,
                finishReason: 'error',
                ...(upstream === undefined ? {} : { upstream }),
              });
            }
            if (
              choice.finish_reason !== undefined &&
              choice.finish_reason !== null &&
              choice.finish_reason !== ''
            )
              finishReason = redactKey(choice.finish_reason, this.apiKey);
            const delta = choice.delta;
            if (delta === undefined) continue;
            if (delta.content !== undefined && delta.content !== null) {
              text += delta.content;
              deltaText += delta.content;
              answerChars += delta.content.length;
            }
            if (delta.reasoning !== undefined && delta.reasoning !== null) {
              reasoning += delta.reasoning;
              deltaReasoning += delta.reasoning;
              reasoningChars += delta.reasoning.length;
            }
            for (const call of delta.tool_calls ?? []) {
              const index = call.index ?? 0;
              const sameId =
                call.id === undefined || call.index !== undefined
                  ? undefined
                  : toolFragments.findLast((frag) => frag.id === call.id);
              const open = sameId ?? toolFragments.findLast((frag) => frag.index === index);
              // A reused index with a different id - or, for calls that
              // never send an index, any second name - starts a NEW
              // parallel call rather than continuing the open one:
              // providers may reuse index 0 for every call. Otherwise
              // first-seen id/name win; args concatenate per slot.
              const opensNew =
                open !== undefined &&
                sameId === undefined &&
                ((call.id !== undefined && open.id !== undefined && call.id !== open.id) ||
                  (call.function.name !== undefined &&
                    open.name !== undefined &&
                    (call.function.name !== open.name || call.index === undefined)));
              if (open === undefined || opensNew) {
                toolFragments.push({
                  index,
                  seq: toolSeq,
                  ...(call.id === undefined ? {} : { id: call.id }),
                  ...(call.function.name === undefined ? {} : { name: call.function.name }),
                  argsText: call.function.arguments ?? '',
                });
                toolSeq += 1;
              } else {
                if (open.id === undefined && call.id !== undefined) open.id = call.id;
                if (open.name === undefined && call.function.name !== undefined)
                  open.name = call.function.name;
                open.argsText += call.function.arguments ?? '';
              }
            }
          }
          if (deltaText !== '' || deltaReasoning !== '') {
            const onChunk = request.onChunk;
            if (onChunk !== undefined)
              await runCallback(() => onChunk({ text: deltaText, reasoning: deltaReasoning }));
          }
          await emitProgress();
        }
      } catch (error) {
        closeBody();
        // Tidy the generator on error exits, but only when it is parked at
        // a yield: return() against a generator stuck inside a pending read
        // queues behind that read and never settles (see sse.ts), so that
        // case skips it and the finally's controller.abort() tears the body
        // down instead. Bounded to one macrotask even when at a yield.
        if (eventsAtYield) {
          eventsAtYield = false;
          const returned = events.return(undefined);
          returned.catch(() => undefined);
          await Promise.race([returned, new Promise<void>((resolve) => setTimeout(resolve, 0))]);
        }
        // Our first-byte/idle/ceiling timers abort with TimeoutError →
        // retryable timeout (same mapping as the fetch catch). Errors thrown
        // above (mid-stream outage, invalid chunk) pass through unchanged.
        if (isTrusted(error)) throw error;
        if (isTimeoutError(error))
          throw trusted('timeout', `${this.id} stream timed out`, true, {
            cause: sanitizeCause(error, this.apiKey),
            host: this.host,
          });
        throw trusted('outage', `${this.id} stream failed`, true, {
          cause: sanitizeCause(error, this.apiKey),
          host: this.host,
        });
      } finally {
        closeBody();
      }
      const toolCalls: ToolCall[] = [...toolFragments]
        .sort((a, b) => a.index - b.index || a.seq - b.seq)
        .flatMap((frag) =>
          frag.name === undefined
            ? []
            : [
                {
                  ...(frag.id === undefined ? {} : { id: frag.id }),
                  name: frag.name,
                  args: parseToolArguments(frag.argsText),
                },
              ],
        );
      // A stream that ends cleanly without any finish_reason is truncated,
      // not complete: never return the partial as a success. Detectable
      // here without touching sse.ts.
      if (finishReason === undefined && (text !== '' || reasoning !== '' || toolCalls.length > 0))
        throw trusted('outage', `${this.id} stream ended without a finish reason`, true, {
          host: this.host,
          ...(upstream === undefined ? {} : { upstream }),
        });
      const finish = finishReason === '' || finishReason === undefined ? undefined : finishReason;
      const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
      const reasoningOnly = reasoning !== '';
      if (text === '' && toolCalls.length === 0)
        throw trusted('invalid-response', `${this.id} returned no text`, false, {
          host: this.host,
          ...(finish === undefined ? {} : { finishReason: finish }),
          ...(upstream === undefined ? {} : { upstream }),
          emptyAnswer: {
            ...(usage?.completion_tokens !== undefined
              ? { completionTokens: usage.completion_tokens }
              : {}),
            ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
            reasoningOnly,
          },
        });
      completed = true;
      return {
        text,
        model: model ?? request.model,
        ...(finish ? { finishReason: finish.slice(0, 40) } : {}),
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
        ...(reasoning === '' ? {} : { reasoning }),
        ...(upstream === undefined ? {} : { upstream: upstream.slice(0, 60) }),
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
    } finally {
      clearTimers();
      callerSignal?.removeEventListener('abort', onCallerAbort);
      // Error exits only: cancel any in-flight fetch or unread body so a
      // late or non-cooperative response cannot linger. A success leaves
      // the (consumed) stream alone.
      if (!completed) controller.abort();
    }
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
