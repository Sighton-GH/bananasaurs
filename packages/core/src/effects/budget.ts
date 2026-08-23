import type { RoleIntent } from './gateway.js';

/**
 * The reconciliation budget (docs/18 Layer 3, reconciler side).
 *
 * Distinct from the rate cap, and deliberately so. The rate cap is a *rate*
 * enforced inside the gateway, one action at a time; by the time it refuses,
 * some actions have already happened. The budget is a *count* checked before
 * anything happens at all.
 *
 * That ordering is the entire point. A reconciliation pass computes its full
 * change list first, and if the list is larger than the guild's
 * `reconcile_budget` it performs **none** of it. A pass that discovers a
 * thousand drifted members is far more likely to be a bug in our diff, a
 * mid-outage Discord API, or a role that was deleted and recreated, than a
 * thousand members who each independently changed their mind. Applying the
 * first twenty-five and then stopping would leave the guild in a state nobody
 * chose.
 *
 * Refusing does not discard the work: the change list is reported so a human
 * can look at it and, if it is genuinely correct, approve it as a named
 * allowance (see `RateLimiter.grantAllowance`).
 */

export type BudgetDecision =
  | { readonly ok: true; readonly count: number }
  | {
      readonly ok: false;
      readonly count: number;
      readonly budget: number;
      readonly reason: 'over-budget';
    };

/**
 * Checks a complete change list against the guild's budget.
 *
 * Takes the whole list rather than a count, so a caller cannot pass a number it
 * computed from something other than the work it is about to do.
 */
export const checkReconcileBudget = (
  changes: readonly RoleIntent[],
  budget: number,
): BudgetDecision => {
  const count = changes.length;
  if (count > budget) return { ok: false, count, budget, reason: 'over-budget' };
  return { ok: true, count };
};
