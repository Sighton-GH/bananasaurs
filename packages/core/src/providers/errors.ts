export type ProviderErrorKind =
  | 'authentication'
  | 'quota'
  | 'rate-limit'
  | 'timeout'
  | 'safety-refusal'
  | 'invalid-request'
  | 'outage'
  | 'capability-mismatch'
  | 'invalid-response';

export class ProviderError extends Error {
  /**
   * When the provider told us when a daily free-model allowance resets
   * (epoch ms). Only set alongside `quotaScope: 'daily-free'` (ADR 0077),
   * and only when the source value was finite and in the future.
   */
  public readonly resetAt?: number;
  /**
   * Set when `kind` is `'quota'` and the cap is a `:free` model's daily
   * request allowance rather than an account credit exhaustion (ADR 0077).
   * A retry never helps this kind of quota error before `resetAt`.
   */
  public readonly quotaScope?: 'daily-free';
  /** HTTP status when a response arrived. */
  public readonly status?: number;
  /** Allowlisted network error code (see failure.ts). */
  public readonly netCode?: string;
  /** From our own base URL, e.g. 'openrouter.ai'. */
  public readonly host?: string;
  /** Provider finish/stop reason, verbatim, capped at 40 characters (ADR 0129). */
  public readonly finishReason?: string;
  /** The upstream provider OpenRouter routed to (`provider` / `error.metadata.provider_name`), capped at 60 characters. */
  public readonly upstream?: string;
  /** Set only on an empty-answer throw: evidence for why the answer had no text. */
  public readonly emptyAnswer?: {
    readonly completionTokens?: number;
    readonly reasoningTokens?: number;
    /** Reasoning text came back but the answer was empty. */
    readonly reasoningOnly: boolean;
  };

  public constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions & {
      resetAt?: number;
      quotaScope?: 'daily-free';
      status?: number;
      netCode?: string;
      host?: string;
      finishReason?: string;
      upstream?: string;
      emptyAnswer?: {
        readonly completionTokens?: number;
        readonly reasoningTokens?: number;
        readonly reasoningOnly: boolean;
      };
    },
  ) {
    super(message, options);
    this.name = 'ProviderError';
    if (options?.resetAt !== undefined) this.resetAt = options.resetAt;
    if (options?.quotaScope !== undefined) this.quotaScope = options.quotaScope;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.netCode !== undefined) this.netCode = options.netCode;
    if (options?.host !== undefined) this.host = options.host;
    if (options?.finishReason !== undefined) this.finishReason = options.finishReason.slice(0, 40);
    if (options?.upstream !== undefined) this.upstream = options.upstream.slice(0, 60);
    if (options?.emptyAnswer !== undefined) this.emptyAnswer = options.emptyAnswer;
  }
}
