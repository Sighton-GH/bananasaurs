import { describe, expect, it } from 'vitest';
import { RateLimiter, TokenBucket } from './rate-limit.js';

const T0 = 1_700_000_000_000;

describe('TokenBucket', () => {
  it('starts full, so a quiet guild is not throttled on the first click', () => {
    const bucket = new TokenBucket({ perMinute: 20, now: T0 });
    expect(bucket.available(T0)).toBe(20);
  });

  it('spends a token per action', () => {
    const bucket = new TokenBucket({ perMinute: 3, now: T0 });
    expect([bucket.take(T0), bucket.take(T0), bucket.take(T0)]).toEqual([true, true, true]);
  });

  it('refuses once the budget is gone', () => {
    const bucket = new TokenBucket({ perMinute: 2, now: T0 });
    bucket.take(T0);
    bucket.take(T0);
    expect(bucket.take(T0)).toBe(false);
  });

  it('refills over time', () => {
    const bucket = new TokenBucket({ perMinute: 60, now: T0 });
    for (let i = 0; i < 60; i += 1) bucket.take(T0);
    expect(bucket.take(T0)).toBe(false);
    // One second at 60/min buys exactly one action.
    expect(bucket.take(T0 + 1_000)).toBe(true);
  });

  it('does not let an idle week buy an unbounded burst', () => {
    // Uncapped refill is how a bot that was offline for a week wakes up and
    // performs ten thousand role changes in a second.
    const bucket = new TokenBucket({ perMinute: 20, now: T0 });
    expect(bucket.available(T0 + 7 * 24 * 60 * 60_000)).toBe(20);
  });
});

describe('the owner-confirmed allowance', () => {
  /**
   * docs/18 Layer 3 as amended. The standing cap and the adoption pass
   * contradict each other — adopting a panel with 250 reactors needs 250 grants
   * and any sane cap refuses that. The allowance is a count a human previewed
   * and approved, not a rate.
   */
  it('lets an approved change list through a cap that would refuse it', () => {
    const bucket = new TokenBucket({ perMinute: 5, now: T0 });
    bucket.grantAllowance(250);

    let performed = 0;
    for (let i = 0; i < 250; i += 1) if (bucket.take(T0)) performed += 1;

    expect(performed).toBe(250);
  });

  it('is consumed and does not renew', () => {
    const bucket = new TokenBucket({ perMinute: 1, now: T0 });
    bucket.grantAllowance(2);
    bucket.take(T0);
    bucket.take(T0);
    bucket.take(T0); // this one spends the single standing token

    // A minute later the standing rate has refilled, but the allowance has not.
    expect(bucket.allowance).toBe(0);
    expect(bucket.available(T0 + 60_000)).toBe(1);
  });

  it('spends allowance before the standing budget', () => {
    // Otherwise an approved batch competes with ordinary member activity
    // halfway through and finishes late or not at all.
    const bucket = new TokenBucket({ perMinute: 10, now: T0 });
    bucket.grantAllowance(3);
    bucket.take(T0);
    expect(bucket.allowance).toBe(2);
    expect(bucket.available(T0)).toBe(12);
  });

  it('refuses a negative allowance rather than quietly reducing the budget', () => {
    const bucket = new TokenBucket({ perMinute: 10, now: T0 });
    expect(() => bucket.grantAllowance(-5)).toThrow(RangeError);
  });

  it('still refuses anything beyond the approved count', () => {
    // Which is what keeps the escape hatch from becoming the default.
    const bucket = new TokenBucket({ perMinute: 1, now: T0 });
    bucket.grantAllowance(2);
    expect([bucket.take(T0), bucket.take(T0), bucket.take(T0), bucket.take(T0)]).toEqual([
      true,
      true,
      true, // the one standing token
      false,
    ]);
  });
});

describe('RateLimiter', () => {
  it('gives each source its own budget', () => {
    // An interaction storm must not exhaust the budget a reconciliation pass
    // needs, and a reconciliation pass must not starve members clicking
    // buttons.
    const limiter = new RateLimiter(2);
    expect(limiter.take('interaction', T0)).toBe(true);
    expect(limiter.take('interaction', T0)).toBe(true);
    expect(limiter.take('interaction', T0)).toBe(false);

    expect(limiter.take('reconcile', T0)).toBe(true);
  });

  it('keeps a bucket across calls rather than making a fresh one each time', () => {
    const limiter = new RateLimiter(1);
    expect(limiter.take('cli', T0)).toBe(true);
    expect(limiter.take('cli', T0)).toBe(false);
  });

  it('grants an allowance to one source only', () => {
    const limiter = new RateLimiter(1);
    limiter.grantAllowance('adoption', 5, T0);
    expect(limiter.bucketFor('adoption', T0).allowance).toBe(5);
    expect(limiter.bucketFor('interaction', T0).allowance).toBe(0);
  });

  it('gives mcp its own bucket, isolated from the other sources', () => {
    // The MCP role gateway spends from the `mcp` bucket, so a moderation
    // storm cannot throttle it and MCP overflow cannot throttle moderation.
    const limiter = new RateLimiter(1);
    expect(limiter.take('mcp', T0)).toBe(true);
    expect(limiter.take('mcp', T0)).toBe(false);
    expect(limiter.take('interaction', T0)).toBe(true);
  });
});
