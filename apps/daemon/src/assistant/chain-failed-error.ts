import { ProviderError, type AssistantTrace, type ProviderErrorKind } from '@bananasaurs/core';
import type { AssistantTraceDetail } from './commands.js';

/**
 * A retryable chain failure that carries its attempts (ADR 0079) and its loop
 * detail (ADR 0129 §1).
 *
 * Thrown by `mapLoopFailure` when every entry was tried and the last one was
 * busy/rate-limited/timed out — and, since ADR 0129, for every other chain
 * failure too. The job writes a trace per invocation attempt from `attempts`
 * before retrying or giving up.
 */
export class ChainFailedError extends ProviderError {
  readonly code = 'chain-failed';
  /** ADR 0129 §1: what the model saw before the chain failed; absent on old call sites. */
  readonly detail?: AssistantTraceDetail;

  constructor(
    kind: ProviderErrorKind,
    readonly summary: string,
    retryable: boolean,
    readonly attempts: AssistantTrace['attempts'],
    options?: {
      readonly detail?: AssistantTraceDetail;
      readonly quotaScope?: 'daily-free';
      readonly resetAt?: number;
      readonly cause?: unknown;
    },
  ) {
    super(kind, summary, retryable, {
      ...(options?.quotaScope === undefined ? {} : { quotaScope: options.quotaScope }),
      ...(options?.resetAt === undefined ? {} : { resetAt: options.resetAt }),
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = 'ChainFailedError';
    if (options?.detail !== undefined) this.detail = options.detail;
  }
}

/**
 * One `provider/model: code` segment per failed attempt, joined by `'; '`.
 * The code falls back to the fixed reason, then the outcome — never provider
 * text.
 */
export const summarizeAttempts: (attempts: AssistantTrace['attempts']) => string = (attempts) =>
  attempts
    .filter((attempt) => attempt.outcome !== 'ok')
    .map(
      (attempt) =>
        `${attempt.provider}/${attempt.model}: ${attempt.code ?? attempt.reason ?? attempt.outcome}`,
    )
    .join('; ');
