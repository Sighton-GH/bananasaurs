/**
 * Shared freshness text (ADR 0129): "12 minutes ago" style, coarse enough that a page left open for a while does
 * not need to re-render to stay accurate.
 *
 * Future timestamps (a queued job's run-after, a scheduled time) read "in 3 minutes" / "in 5 hours" / "in 2 days"
 * with the same rounding as the past. Within the same under-a-minute window either side of now it stays "just now",
 * so small clock skew never flips the copy. A non-finite input (NaN, Infinity) returns "unknown time"; no date is
 * invented. The caller always passes `nowMs`.
 */

const unit = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

export const relativeTime = (atMs: number, nowMs: number): string => {
  if (!Number.isFinite(atMs) || !Number.isFinite(nowMs)) return 'unknown time';
  const diffMs = nowMs - atMs;
  const future = diffMs < 0;
  const minutes = Math.round(Math.abs(diffMs) / 60_000);
  if (minutes < 1) return 'just now';
  let text: string;
  if (minutes < 60) text = unit(minutes, 'minute');
  else {
    const hours = Math.round(minutes / 60);
    text = hours < 24 ? unit(hours, 'hour') : unit(Math.round(hours / 24), 'day');
  }
  return future ? `in ${text}` : `${text} ago`;
};
