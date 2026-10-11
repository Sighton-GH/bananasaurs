import { z } from 'zod';

export interface ParsedGeminiQuota {
  readonly scope: 'day' | 'minute' | undefined;
  readonly retryAfterMs?: number;
  readonly learnedLimit?: { readonly perDay?: number; readonly perMinute?: number };
}

const violationSchema = z.object({
  quotaId: z.string().optional(),
  quotaValue: z.string().optional(),
});

const detailsSchema = z.object({
  error: z
    .object({
      details: z
        .array(
          z.object({
            '@type': z.string(),
            violations: z.array(violationSchema).optional(),
            retryDelay: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

const safeQuotaValue = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000_000) return undefined;
  return value;
};

/** `37s`, `1.5s`: seconds plus fraction, capped to one hour. */
const safeRetryDelayMs = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const match = /^(\d+)(?:\.(\d{1,9}))?s$/.exec(raw);
  if (match === null) return undefined;
  const secondsText = match[1];
  if (secondsText === undefined) return undefined;
  const seconds = Number(secondsText);
  const nanos = Number((match[2] ?? '0').padEnd(9, '0'));
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(nanos)) return undefined;
  return Math.min(seconds * 1000 + Math.floor(nanos / 1_000_000), 3_600_000);
};

/**
 * Pure parse of a Gemini 429 body (ADR 0143). Daily wins when daily and minute violations coexist; a
 * token-per-minute violation is minute scope. Never throws; unknown shapes yield `{ scope: undefined }`.
 */
export const parseGeminiQuotaError = (body: unknown): ParsedGeminiQuota => {
  const parsed = detailsSchema.safeParse(body);
  if (!parsed.success) return { scope: undefined };
  const details = parsed.data.error?.details ?? [];
  let perDay: number | undefined;
  let perMinute: number | undefined;
  let sawDaily = false;
  let sawMinute = false;
  let retryAfterMs: number | undefined;
  for (const detail of details) {
    if (detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo') {
      const delay = safeRetryDelayMs(detail.retryDelay);
      if (delay !== undefined) retryAfterMs = delay;
    }
    if (detail['@type'] !== 'type.googleapis.com/google.rpc.QuotaFailure') continue;
    for (const violation of detail.violations ?? []) {
      const id = violation.quotaId ?? '';
      const value = safeQuotaValue(violation.quotaValue);
      if (/PerDay/i.test(id)) {
        sawDaily = true;
        if (/RequestsPerDay/i.test(id) && value !== undefined) perDay = value;
      } else if (/PerMinute/i.test(id)) {
        sawMinute = true;
        if (/RequestsPerMinute/i.test(id) && value !== undefined) perMinute = value;
      }
    }
  }
  const scope = sawDaily ? 'day' : sawMinute ? 'minute' : undefined;
  if (scope === undefined) return { scope: undefined };
  const learnedLimit =
    perDay !== undefined && perMinute !== undefined
      ? { perDay, perMinute }
      : perDay !== undefined
        ? { perDay }
        : perMinute !== undefined
          ? { perMinute }
          : undefined;
  return {
    scope,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(learnedLimit === undefined ? {} : { learnedLimit }),
  };
};
