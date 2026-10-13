import type { ReactElement } from 'react';

/**
 * A determinate progress bar (docs/28 §7.7). The label is required: the bar is
 * announced by it, since the fill itself means nothing to a screen reader.
 */
export function ProgressBar({
  value,
  max = 100,
  label,
}: {
  readonly value: number;
  readonly max?: number;
  readonly label: string;
}): ReactElement {
  // The announced value stays inside the range the fill can show.
  const clamped = Math.min(max, Math.max(0, value));
  const pct = max > 0 ? (clamped / max) * 100 : 0;
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
      className="h-2 w-full overflow-hidden rounded-full bg-sunk"
    >
      <div className="h-full bg-tone-progress" style={{ width: `${pct}%` }} />
    </div>
  );
}
