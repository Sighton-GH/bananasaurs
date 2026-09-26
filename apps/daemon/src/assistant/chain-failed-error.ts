import { ProviderError, type AssistantTrace, type ProviderErrorKind } from '@bananasaurs/core';

/**
 * A retryable chain failure that carries its attempts (ADR 0079).
 *
 * Thrown by `mapLoopFailure` when every entry was tried and the last one was
 * busy/rate-limited/timed out. The job writes a trace per invocation attempt
 * from `attempts` before retrying or giving up.
 */
export class ChainFailedError extends ProviderError {
  readonly code = 'chain-failed';

  constructor(
    kind: ProviderErrorKind,
    readonly summary: string,
    retryable: boolean,
    readonly attempts: AssistantTrace['attempts'],
  ) {
    super(kind, summary, retryable);
    this.name = 'ChainFailedError';
  }
}

/**
 * One `provider/model: code` segment per failed attempt, joined by `'; '`.
 * The code falls back to the fixed reason, then the outcome — never provider
 * text.
 */
export const summarizeAttempts: (
  attempts: AssistantTrace['attempts'],
) => string = (attempts) =>
  attempts
    .filter((attempt) => attempt.outcome !== 'ok')
    .map(
      (attempt) =>
        `${attempt.provider}/${attempt.model}: ${attempt.code ?? attempt.reason ?? attempt.outcome}`,
    )
    .join('; ');
