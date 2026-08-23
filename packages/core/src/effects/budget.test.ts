import { describe, expect, it } from 'vitest';
import { checkReconcileBudget } from './budget.js';
import { parseSnowflakeId } from '../ids.js';
import type { RoleIntent } from './gateway.js';

const change = (n: number): RoleIntent => ({
  userId: parseSnowflakeId(String(200000000000000000 + n).padStart(18, '0')),
  roleId: parseSnowflakeId('333333333333333333'),
  action: 'grant',
  panelId: 'panel-1',
  triggerRef: `pass-1:${n}`,
  source: 'reconcile',
  batchId: 'batch-1',
  reason: 'reconciliation',
});

const changes = (count: number): RoleIntent[] =>
  Array.from({ length: count }, (_unused, i) => change(i));

describe('the reconciliation budget refuses before acting, not during', () => {
  it('allows a change list within budget', () => {
    expect(checkReconcileBudget(changes(10), 25)).toEqual({ ok: true, count: 10 });
  });

  it('allows a list exactly at budget', () => {
    expect(checkReconcileBudget(changes(25), 25)).toEqual({ ok: true, count: 25 });
  });

  it('refuses an oversized list outright', () => {
    // Not "applies 25 and stops". A pass that discovers a thousand drifted
    // members is far more likely to be a bug in our diff or a mid-outage
    // Discord API than a thousand independent decisions — and applying the
    // first 25 would leave the guild in a state nobody chose.
    expect(checkReconcileBudget(changes(1000), 25)).toEqual({
      ok: false,
      count: 1000,
      budget: 25,
      reason: 'over-budget',
    });
  });

  it('reports the count so a human can decide whether to approve it', () => {
    // Refusing must not discard the finding. The count is what the owner
    // previews before granting a named allowance.
    const decision = checkReconcileBudget(changes(250), 25);
    expect(decision.count).toBe(250);
  });

  it('allows an empty change list', () => {
    // The overwhelmingly common case: nothing drifted.
    expect(checkReconcileBudget([], 25)).toEqual({ ok: true, count: 0 });
  });

  it('refuses everything when the budget is zero', () => {
    expect(checkReconcileBudget(changes(1), 0)).toMatchObject({ ok: false });
  });
});
