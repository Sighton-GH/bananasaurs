import { ProviderError, type AssistantTrace, type ProviderErrorKind } from '@bananasaurs/core';

/**
 * The loop's working state at failure: what the AI saw. Carried on every
 * terminal failure (ADR 0129 §1) so the job can write its trace from it in
 * Task 3. The text is the fixed member-facing reply, never provider prose.
 */
export interface LoopFailureDetail {
  readonly text: string;
  readonly finishReason?: string;
  readonly usage: AssistantTrace['usage'];
  readonly toolCalls: AssistantTrace['toolCalls'];
  readonly guard: AssistantTrace['guard'];
  readonly sections?: AssistantTrace['sections'];
  readonly included?: AssistantTrace['included'];
}

/** The empty failure: a failed run with no sections yet. */
export const emptyLoopFailureDetail: (text: string) => LoopFailureDetail = (text) => ({
  text,
  usage: {},
  toolCalls: [],
  guard: { removed: [] },
});

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

  constructor(
    kind: ProviderErrorKind,
    readonly summary: string,
    retryable: boolean,
    readonly attempts: AssistantTrace['attempts'],
    readonly detail: LoopFailureDetail = emptyLoopFailureDetail(summary),
    options?: ErrorOptions & {
      quotaScope?: 'daily-free';
      resetAt?: number;
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
    super(kind, summary, retryable, options);
    this.name = 'ChainFailedError';
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
