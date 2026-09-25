import { describe, expect, it } from 'vitest';
import { QuotaLedger } from './quota-ledger.js';

describe('QuotaLedger', () => {
  it('reports nothing for a key that was never marked', () => {
    const ledger = new QuotaLedger();
    expect(ledger.exhaustedUntil('key_a', 1_000)).toBeUndefined();
  });

  it('reports the reset time until it passes, then expires', () => {
    const ledger = new QuotaLedger();
    ledger.markExhausted('key_a', 2_000);
    expect(ledger.exhaustedUntil('key_a', 1_999)).toBe(2_000);
    expect(ledger.exhaustedUntil('key_a', 2_000)).toBeUndefined();
    expect(ledger.exhaustedUntil('key_a', 2_001)).toBeUndefined();
  });

  it('keeps keys independent and keeps the later mark', () => {
    const ledger = new QuotaLedger();
    ledger.markExhausted('key_a', 2_000);
    ledger.markExhausted('key_b', 3_000);
    expect(ledger.exhaustedUntil('key_a', 1_000)).toBe(2_000);
    expect(ledger.exhaustedUntil('key_b', 1_000)).toBe(3_000);
    ledger.markExhausted('key_a', 4_000);
    expect(ledger.exhaustedUntil('key_a', 3_000)).toBe(4_000);
  });
});
