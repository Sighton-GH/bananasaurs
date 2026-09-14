import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit.js';

describe('createRateLimiter', () => {
  it('passes the limit-th call and fails the next', () => {
    let clock = 1_000;
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => clock });
    expect(limiter.check('k')).toBe(true);
    expect(limiter.check('k')).toBe(true);
    expect(limiter.check('k')).toBe(true);
    expect(limiter.check('k')).toBe(false);
    clock += 1;
    expect(limiter.check('k')).toBe(false);
  });

  it('rolls the window over on the injected clock', () => {
    let clock = 5_000;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => clock });
    expect(limiter.check('k')).toBe(true);
    expect(limiter.check('k')).toBe(false);
    clock += 1_000;
    expect(limiter.check('k')).toBe(true);
  });

  it('keeps two keys independent', () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => clock });
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(false);
    expect(limiter.check('b')).toBe(true);
    expect(limiter.check('b')).toBe(false);
    clock += 1;
    expect(limiter.check('a')).toBe(false);
  });

  it('does not let the map grow without bound across rollovers', () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 5, windowMs: 1_000, now: () => clock });
    for (let i = 0; i < 50; i++) {
      expect(limiter.check(`stale-${String(i)}`)).toBe(true);
    }
    expect(limiter._sizeForTests()).toBe(50);
    clock += 1_001;
    expect(limiter.check('live')).toBe(true);
    // The rollover dropped every stale entry; only the live key remains.
    expect(limiter._sizeForTests()).toBe(1);
  });
});
