import type { AssistantTrace, DayUsage, TraceSummary } from '@bananasaurs/core';

/**
 * The dashboard's side of the History contract (ADR 0076). The list, one
 * trace and the usage strip each answer from their own endpoint; the older
 * skill-activity rows keep coming from `GET /api/assistant` (`AssistantData`)
 * and are rendered as their own collapsed section, so nothing disappears.
 */

/** Who asked, when live Discord still knows the id; null renders the bare id. */
export interface TraceMember {
  readonly username: string;
  readonly displayName: string;
}

export interface TraceRow extends TraceSummary {
  readonly member: TraceMember | null;
}

export interface TraceListResponse {
  readonly traces: readonly TraceRow[];
  readonly nextBefore?: number;
}

export interface TraceDetailResponse {
  readonly trace: AssistantTrace;
  readonly member: TraceMember | null;
}

/** The usage strip: one entry per day, oldest first, quiet days as zeros. */
export interface UsageResponse {
  readonly days: readonly DayUsage[];
}

export const TRACES_URL = '/api/assistant/traces';
export const USAGE_URL = '/api/assistant/usage';

export interface TraceFilters {
  readonly outcome: '' | 'answered' | 'refused' | 'failed';
  readonly behaviourId: string;
  readonly userId: string;
}

export const EMPTY_TRACE_FILTERS: TraceFilters = { outcome: '', behaviourId: '', userId: '' };

export const traceListUrl = (filters: TraceFilters, before?: number): string => {
  const search = new URLSearchParams();
  search.set('limit', '50');
  if (filters.outcome !== '') search.set('outcome', filters.outcome);
  if (filters.behaviourId.trim() !== '') search.set('behaviourId', filters.behaviourId.trim());
  if (filters.userId.trim() !== '') search.set('userId', filters.userId.trim());
  if (before !== undefined) search.set('before', String(before));
  return `${TRACES_URL}?${search.toString()}`;
};

export const traceUrl = (traceId: string): string =>
  `${TRACES_URL}/${encodeURIComponent(traceId)}`;

export const historyUrl = (traceId: string): string =>
  `/assistant/history/${encodeURIComponent(traceId)}`;

export const usageUrl = (days = 14): string => `${USAGE_URL}?days=${String(days)}`;
