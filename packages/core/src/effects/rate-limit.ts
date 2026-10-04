/**
 * The per-source rate cap (docs/18 Layer 3, as amended).
 *
 * Layer 3 was originally "a global ceiling no source may exceed". Collision 2
 * in `docs/19` §6.4 showed that ceiling and the adoption pass contradict each
 * other: adopting a panel with 250 existing reactors needs 250 role grants,
 * which any sane standing cap refuses, and refusing it means adoption cannot
 * work at all.
 *
 * So the layer is now "a global ceiling, **plus named allowances a human sized
 * and approved for a specific change list**". That is a weaker guarantee stated
 * honestly, and it is the only version under which the feature exists. An
 * allowance is granted for an exact count, is consumed, and does not renew.
 *
 * The bucket is per source — an interaction storm cannot exhaust the budget a
 * reconciliation pass needs, and vice versa.
 */

export interface TokenBucketOptions {
  /** Sustained rate. Also the burst size, so a quiet minute buys one minute. */
  readonly perMinute: number;
  readonly now: number;
}

export class TokenBucket {
  #tokens: number;
  #lastRefillMs: number;
  /** Approved for a specific change list. Consumed before refilling tokens. */
  #allowance = 0;

  constructor(private readonly options: TokenBucketOptions) {
    this.#tokens = options.perMinute;
    this.#lastRefillMs = options.now;
  }

  /**
   * Grants a one-off allowance for an exact number of actions.
   *
   * Not a rate: a count. The owner previewed a change list of this size and
   * approved it. Anything beyond it trips the breaker normally, which is what
   * keeps the escape hatch from becoming the default.
   */
  grantAllowance(count: number): void {
    if (count < 0) throw new RangeError('an allowance cannot be negative');
    this.#allowance += count;
  }

  /** Unconsumed approved actions. */
  get allowance(): number {
    return this.#allowance;
  }

  available(nowMs: number): number {
    this.#refill(nowMs);
    return this.#tokens + this.#allowance;
  }

  /**
   * Takes one action's worth of budget.
   *
   * Allowance is spent first, deliberately. Spending the standing budget first
   * would leave a grant-approved batch competing with ordinary member activity
   * halfway through, and the approved list would finish late or not at all.
   */
  take(nowMs: number): boolean {
    this.#refill(nowMs);
    if (this.#allowance > 0) {
      this.#allowance -= 1;
      return true;
    }
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return true;
    }
    return false;
  }

  #refill(nowMs: number): void {
    if (nowMs <= this.#lastRefillMs) return;
    const elapsed = nowMs - this.#lastRefillMs;
    const gained = (elapsed / 60_000) * this.options.perMinute;
    // Capped at `perMinute`, so an idle week does not buy an unbounded burst.
    this.#tokens = Math.min(this.options.perMinute, this.#tokens + gained);
    this.#lastRefillMs = nowMs;
  }
}

export type EffectSource =
  'interaction' | 'reaction' | 'adoption' | 'reconcile' | 'cli' | 'dashboard' | 'mcp';

/**
 * One bucket per source, created lazily at the guild's configured rate.
 *
 * Per source rather than global because the sources have different shapes: a
 * member clicking buttons should never be throttled by a reconciliation pass
 * that is quietly repairing drift, and a reconciliation pass should never be
 * starved by a member clicking buttons.
 */
export class RateLimiter {
  readonly #buckets = new Map<EffectSource, TokenBucket>();

  constructor(private readonly perMinute: number) {}

  bucketFor(source: EffectSource, nowMs: number): TokenBucket {
    const existing = this.#buckets.get(source);
    if (existing) return existing;
    const created = new TokenBucket({ perMinute: this.perMinute, now: nowMs });
    this.#buckets.set(source, created);
    return created;
  }

  take(source: EffectSource, nowMs: number): boolean {
    return this.bucketFor(source, nowMs).take(nowMs);
  }

  /** For the owner-confirmed adoption allowance. */
  grantAllowance(source: EffectSource, count: number, nowMs: number): void {
    this.bucketFor(source, nowMs).grantAllowance(count);
  }
}
