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

/**
 * The purge budget (ADR 0037, `docs/superpowers/specs/2026-08-31-moderation-
 * commands-design.md` §6): a hard ceiling on how many messages one `/mod
 * purge` job may delete, checked twice — once as a preview refusal before a
 * moderator confirms (Task 7), and again by the job itself on every tick.
 *
 * `PURGE_MAX_MESSAGES` is a literal constant, not guild config (`checkPurge
 * Budget`'s own docstring below explains why), which is also why this lives
 * beside `checkReconcileBudget` rather than folding into it: the two guard
 * different kinds of destructive bulk-action, and only one of them is
 * operator-configurable.
 */
export const PURGE_MAX_MESSAGES = 500;

export type PurgeBudgetDecision =
  | { readonly ok: true; readonly count: number }
  | {
      readonly ok: false;
      readonly count: number;
      readonly budget: number;
      readonly reason: 'over-budget';
    };

/**
 * Checks a prospective *cumulative* message count against the purge budget.
 *
 * Shaped like `checkReconcileBudget`'s decision (`ok`/`count`/`budget`/
 * `reason`), but the input is a running total rather than a materialised
 * list. `checkReconcileBudget` can take the whole list because reconciliation
 * computes its entire change plan in one pass before touching anything; a
 * purge cannot — it pages `fetchRecentMessages` a page at a time across many
 * job ticks (`packages/core/src/mod/purge.ts`), so there is no single list to
 * hand this function without first deleting nothing across the whole channel
 * and holding every id in memory, which defeats the point of a bounded,
 * resumable job. The caller instead passes `deletedSoFar + messages this tick
 * would add`, so the ceiling is enforced on the true cumulative total every
 * tick sees, not on any one page in isolation (a channel with five 100-
 * message pages must still refuse at the fifth if the budget is 450, even
 * though every individual page is well under it).
 */
export const checkPurgeBudget = (prospectiveCount: number, budget: number): PurgeBudgetDecision => {
  if (prospectiveCount > budget) {
    return { ok: false, count: prospectiveCount, budget, reason: 'over-budget' };
  }
  return { ok: true, count: prospectiveCount };
};
