import type { ModelHealth } from '@bananasaurs/core';

/**
 * The dashboard's side of the model-health contract (ADR 0129 §8): the
 * 24-hour per-model stats behind the Model order columns, the History card
 * and the site-wide persistent-failure banner. Display only — nothing here
 * changes the chain (ADR 0129 §8; hard rule 1).
 */
export const modelHealthUrl = (window: '24h' | '7d' = '24h'): string =>
  `/api/assistant/model-health?window=${window}`;

export interface ModelHealthResponse {
  readonly window: '24h' | '7d';
  readonly models: readonly ModelHealth[];
}

/** `$0.0012` style: 4 decimals under $1, 2 decimals at or above; `$0` for zero. */
export const formatUsd: (value: number) => string = (value) =>
  value === 0 ? '$0' : value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;

/** `97%`, or `—` for null. */
export const formatRate: (rate: number | null) => string = (rate) =>
  rate === null ? '—' : `${String(Math.round(rate * 100))}%`;
