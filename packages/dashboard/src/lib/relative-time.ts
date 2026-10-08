/** Shared freshness text (ADR 0129): "12 minutes ago" style, coarse enough that a page left open for a while does not need to re-render to stay accurate. */

export const relativeTime = (atMs: number, nowMs: number): string => {
  const diffMs = Math.max(0, nowMs - atMs);
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${String(days)} day${days === 1 ? '' : 's'} ago`;
};
