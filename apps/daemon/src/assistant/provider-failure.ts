import {
  ProviderError,
  PROVIDER_FAILURE_CODES,
  PROVIDER_FAILURE_TEXT,
  type AssistantTrace,
} from '@bananasaurs/core';

/**
 * Hard rule 4: the provider's error text can echo request details, so it is
 * never repeated outside the Pino log line (where `safeLogFields` carries
 * the truncated short reason). Trace attempts and the Discord AI log channel
 * get only fixed strings derived from the error's kind or status — the same
 * mapping idea as `chainTestFailure` in the dashboard provider routes.
 */

const statusOf = (err: unknown): number | undefined => {
  if (typeof err !== 'object' || err === null) return undefined;
  if (!('status' in err)) return undefined;
  const status: unknown = err.status;
  return typeof status === 'number' ? status : undefined;
};

/** The trace-attempt reason for a provider failure: a fixed code, never provider text. */
export const attemptReasonFor = (err: unknown): string => {
  const kind = err instanceof ProviderError ? err.kind : undefined;
  const status = statusOf(err);
  if (kind === 'authentication' || status === 401 || status === 403) return 'authentication';
  if (kind === 'timeout' || status === 408 || status === 504) return 'timeout';
  if (kind === 'rate-limit' || status === 429) return 'rate-limit';
  if (kind === 'quota') return 'quota';
  if (kind === 'safety-refusal') return 'safety-refusal';
  if (kind === 'invalid-request' || kind === 'capability-mismatch' || status === 404)
    return 'invalid-request';
  if (kind === 'outage') return 'outage';
  if (kind === 'invalid-response') return 'invalid-response';
  return 'error';
};

/** The AI log channel reason for a failed invoke: one fixed sentence. */
export const PROVIDER_FAILURE_LOG_REASON =
  'The assistant request failed before producing a response.';

const KNOWN_CODES: ReadonlySet<string> = new Set<string>(PROVIDER_FAILURE_CODES);

/**
 * ADR 0129 §3: the AI log channel's failure reason: the last failed attempt's classified title and
 * model, e.g. "This model is not available on this key — stealth/space-bunny-alpha". Never the
 * provider's own text. Falls back to PROVIDER_FAILURE_LOG_REASON when no attempt has a known code.
 */
export const failureLogReason: (
  attempts: readonly AssistantTrace['attempts'][number][],
) => string = (attempts) => {
  const failed = attempts.filter(
    (attempt) => attempt.outcome !== 'ok' && attempt.outcome !== 'skipped',
  );
  const lastFailed = [...failed]
    .reverse()
    .find((attempt) => attempt.code !== undefined && KNOWN_CODES.has(attempt.code));
  if (lastFailed !== undefined && lastFailed.code !== undefined) {
    return `${PROVIDER_FAILURE_TEXT[lastFailed.code as (typeof PROVIDER_FAILURE_CODES)[number]].title} — ${lastFailed.model}`;
  }
  const lastSkipped = [...attempts]
    .reverse()
    .find(
      (attempt) =>
        attempt.outcome === 'skipped' &&
        attempt.code !== undefined &&
        KNOWN_CODES.has(attempt.code),
    );
  if (lastSkipped !== undefined && lastSkipped.code !== undefined) {
    return `${PROVIDER_FAILURE_TEXT[lastSkipped.code as (typeof PROVIDER_FAILURE_CODES)[number]].title} — ${lastSkipped.model}`;
  }
  return PROVIDER_FAILURE_LOG_REASON;
};
