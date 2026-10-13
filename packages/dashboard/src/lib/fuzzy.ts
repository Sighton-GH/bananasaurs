const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * A positive penalty that grows with `x` but never reaches `max`. The plan's
 * literal `1000 - t.length` went to zero or below for long texts, so a real
 * match read as "no match" (P4 Task 4 deviation 1). Bounded penalties keep
 * every match above 0 and the four categories apart at any length.
 */
const bounded = (x: number, max: number): number => (max * x) / (x + max);

/**
 * 0 = no match. Prefix > word-start > contiguous > subsequence; shorter texts
 * win ties inside a category. Case and accents are ignored. Ranges: prefix
 * (950, 1000), word start (750, 800), contiguous (550, 600), subsequence
 * (150, 200).
 */
export const score = (query: string, text: string): number => {
  const q = fold(query.trim());
  const t = fold(text);
  if (q === '') return 1;
  if (t.startsWith(q)) return 1000 - bounded(t.length, 50);
  if (t.split(/[\s/·_-]+/).some((w) => w.startsWith(q))) return 800 - bounded(t.length, 50);
  const at = t.indexOf(q);
  if (at >= 0) return 600 - bounded(at, 25) - bounded(t.length, 25);
  const queryPoints = [...q];
  let i = 0;
  for (const ch of t) if (ch === queryPoints[i]) i++;
  return i === queryPoints.length ? 200 - bounded(t.length, 50) : 0;
};
