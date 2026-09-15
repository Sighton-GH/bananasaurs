/**
 * A fixed-window counter with an injected clock and no global state.
 *
 * One instance guards one endpoint; keys separate callers within it. M3 uses
 * a single global key for `POST /oauth/register` (see the route), but the
 * limiter itself stays general so the independence of keys is testable.
 */
export interface RateLimiter {
  /** Returns true while the key's count in the current window is below `limit`, and increments. */
  check(key: string): boolean;
  /** Test seam: how many keys are currently tracked. */
  _sizeForTests(): number;
}

export const createRateLimiter = (opts: {
  readonly limit: number;
  readonly windowMs: number;
  readonly now: () => number;
}): RateLimiter => {
  const counts = new Map<string, { windowStart: number; count: number }>();

  /** Drops entries whose window ended before `now`, so the map cannot grow without bound. */
  const prune = (now: number): void => {
    for (const [key, entry] of counts) {
      if (entry.windowStart + opts.windowMs <= now) counts.delete(key);
    }
  };

  return {
    check(key: string): boolean {
      const now = opts.now();
      prune(now);
      const entry = counts.get(key);
      if (entry === undefined || entry.windowStart + opts.windowMs <= now) {
        counts.set(key, { windowStart: now, count: 1 });
        return 1 <= opts.limit;
      }
      if (entry.count >= opts.limit) return false;
      entry.count += 1;
      return true;
    },
    _sizeForTests(): number {
      prune(opts.now());
      return counts.size;
    },
  };
};
