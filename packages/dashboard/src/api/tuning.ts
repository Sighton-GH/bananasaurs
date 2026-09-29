/**
 * The dashboard's side of the AI tuning contract (ADR 0080):
 * `GET /api/assistant/tuning` lists every bot-wide setting with its help,
 * current value, default and limits; `PUT` saves one and `DELETE` resets it
 * to its default. Values travel in base units (ms for seconds, milliseconds
 * and seconds-list; minutes for minutes); the page converts to the unit each
 * control shows. A `secret` value is `{ configured: boolean }` — the secret
 * itself never crosses this boundary, so the page never renders it.
 */

export const TUNING_URL = '/api/assistant/tuning';
export const tuningKeyUrl = (key: string): string => `${TUNING_URL}/${encodeURIComponent(key)}`;

export type TuningDisplay =
  | 'seconds'
  | 'milliseconds'
  | 'minutes'
  | 'count'
  | 'text'
  | 'secret'
  | 'seconds-list'
  | 'host-list';

export type TuningGroup =
  'Assistant retries' | 'Assistant tool loop' | 'Assistant context' | 'Network' | 'Resources';

export interface TuningSetting {
  readonly key: string;
  readonly group: TuningGroup;
  readonly label: string;
  readonly help: string;
  readonly display: TuningDisplay;
  readonly bounds?: { readonly min?: number; readonly max?: number; readonly maxItems?: number };
  readonly value: unknown;
  readonly defaultValue: unknown;
  readonly isDefault: boolean;
  readonly updatedAt?: number;
  readonly updatedBy?: string;
}

export interface TuningListResponse {
  readonly settings: readonly TuningSetting[];
}

export interface TuningSetResponse {
  readonly setting: TuningSetting;
}
