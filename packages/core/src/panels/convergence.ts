import type { SnowflakeId } from '../ids.js';
import type { EffectSource } from '../effects/rate-limit.js';
import type { RoleIntent } from '../effects/gateway.js';
import { orderedOptions, panelRoleIds, type PanelConfig, type PanelOption } from './model.js';

/**
 * The one function that decides what a member's roles should be.
 *
 * Live reaction events, the adoption pass and reconciliation all call this.
 * That is the point of `docs/19` §4: drift repair is not a separate feature
 * with its own separate bugs, it is the same code path running over a different
 * input.
 *
 * **`currentRoleIds` is the member's live Discord roles** — amendment 4. Never
 * `managed_role_assignments`. Diffing against our own record means a role
 * removed by hand still reads "granted", the change set comes out empty, and
 * the drift is never repaired. `managed_role_assignments` answers "which panel
 * granted this"; Discord answers "does this member have it".
 *
 * The function is pure. Everything it needs was fetched by the caller, which is
 * what lets the adoption pass reuse it over 300 members without a REST call per
 * decision, and what lets its tests be a table rather than a harness.
 */

export type PanelRefusal =
  /** The panel is disabled; the gateway would refuse anyway (layer 4). */
  | 'panel-disabled'
  | 'missing-required-role'
  | 'blocked-role'
  | 'max-roles'
  /** Held but not selected, on a panel that may only add. */
  | 'add-only'
  /** Selected but not held, on a panel that may only remove. */
  | 'remove-only';

export interface DeclinedOption {
  readonly optionId: string;
  readonly reason: PanelRefusal;
}

export interface ConvergenceInput {
  readonly panel: PanelConfig;
  /**
   * Options the member has selected: the emoji they have reacted with, or the
   * values an interaction carried.
   */
  readonly selectedOptionIds: ReadonlySet<string>;
  /** The member's **live** Discord roles. Amendment 4. */
  readonly currentRoleIds: ReadonlySet<string>;
  /**
   * Restricts the pass to these options, leaving every other option's role
   * exactly as it is.
   *
   * This is what makes amendment 6 possible. A `toggle`, `add_only` or
   * `remove_only` panel without `max_roles` treats each option independently,
   * so a reaction event is decidable from the single emoji it carried and no
   * REST call is needed to learn the rest. A full pass — adoption,
   * reconciliation, or any panel with `max_roles` — leaves this undefined.
   */
  readonly limitToOptionIds?: ReadonlySet<string> | undefined;
}

export interface ConvergencePlan {
  /** What the member's panel-managed roles should be. */
  readonly desiredRoleIds: ReadonlySet<string>;
  readonly grants: readonly SnowflakeId[];
  readonly revokes: readonly SnowflakeId[];
  /** Set when the panel as a whole did nothing, and why. */
  readonly refusedBecause: PanelRefusal | undefined;
  /** Selections not honoured, for the ephemeral reply on a managed panel. */
  readonly declined: readonly DeclinedOption[];
}

/**
 * Amendment 6, as one predicate.
 *
 * `toggle`, `add_only` and `remove_only` decide each option independently, so
 * one emoji is enough. `max_roles` is a statement about the *set*, so the set
 * has to be known — that is the one case that costs N REST calls, and
 * `single_choice` is not among them because a CHECK constrains it to managed
 * panels, where the interaction carries the whole selection.
 */
export const needsFullReactionState = (panel: PanelConfig): boolean => panel.maxRoles !== undefined;

/** No change, with a reason. Roles already held are kept, never stripped. */
const refuse = (reason: PanelRefusal, heldPanelRoles: ReadonlySet<string>): ConvergencePlan => ({
  desiredRoleIds: heldPanelRoles,
  grants: [],
  revokes: [],
  refusedBecause: reason,
  declined: [],
});

export function planConvergence(input: ConvergenceInput): ConvergencePlan {
  const { panel, selectedOptionIds, currentRoleIds, limitToOptionIds } = input;

  const offered = panelRoleIds(panel);
  const held = new Set([...currentRoleIds].filter((r) => offered.has(r)));

  // --- panel-level gates -------------------------------------------------
  // Each of these means "this member may not use this panel right now", which
  // is different from "this member should hold no roles from it". Somebody who
  // acquires a blocked role keeps what the panel already gave them; the panel
  // simply stops responding to them.
  if (panel.status !== 'enabled') return refuse('panel-disabled', held);

  if (panel.requiredRoleId !== undefined && !currentRoleIds.has(panel.requiredRoleId)) {
    return refuse('missing-required-role', held);
  }

  if (panel.blockedRoleIds.some((roleId) => currentRoleIds.has(roleId))) {
    return refuse('blocked-role', held);
  }

  const ordered = orderedOptions(panel);
  const inScope = (option: PanelOption): boolean =>
    limitToOptionIds === undefined || limitToOptionIds.has(option.optionId);

  // --- 1. what the selection asks for ------------------------------------
  // `single_choice` collapses to the first selected option in display order,
  // so two values arriving in one interaction cannot produce two roles.
  const selectedOptions = ordered.filter((o) => selectedOptionIds.has(o.optionId));
  const asked = new Set<string>(
    panel.behaviour === 'single_choice'
      ? selectedOptions.slice(0, 1).map((o) => o.roleId)
      : selectedOptions.map((o) => o.roleId),
  );

  // --- 2. the direction filter -------------------------------------------
  // The three behaviours are one rule with the grants or the revokes clipped:
  //
  //   toggle      desired = asked
  //   add_only    desired = asked ∪ held    — never revokes
  //   remove_only desired = asked ∩ held    — never grants
  //
  // Written this way rather than as three branches because the symmetry is the
  // property worth preserving: `add_only` un-reacting must not revoke, and
  // `remove_only` reacting must not grant, and those are the same statement.
  const declined: DeclinedOption[] = [];
  let desired: Set<string>;
  switch (panel.behaviour) {
    case 'add_only':
      desired = new Set([...asked, ...held]);
      for (const option of ordered) {
        if (held.has(option.roleId) && !asked.has(option.roleId) && inScope(option)) {
          declined.push({ optionId: option.optionId, reason: 'add-only' });
        }
      }
      break;
    case 'remove_only':
      desired = new Set([...asked].filter((r) => held.has(r)));
      for (const option of ordered) {
        if (asked.has(option.roleId) && !held.has(option.roleId) && inScope(option)) {
          declined.push({ optionId: option.optionId, reason: 'remove-only' });
        }
      }
      break;
    default:
      desired = new Set(asked);
  }

  // --- 3. the max_roles clamp --------------------------------------------
  //
  // Deterministic, and stable across passes: roles the member already holds and
  // still wants keep their place, then the remaining selections in display
  // order. Stability is the point — clamping by display order alone would
  // revoke a role somebody has held for a month because they reacted to an
  // option that sorts earlier.
  if (panel.maxRoles !== undefined && desired.size > panel.maxRoles) {
    const keep = new Set<string>();
    const byPosition = ordered.filter((o) => desired.has(o.roleId));
    for (const option of byPosition) {
      if (keep.size >= panel.maxRoles) break;
      if (held.has(option.roleId)) keep.add(option.roleId);
    }
    for (const option of byPosition) {
      if (keep.size >= panel.maxRoles) break;
      keep.add(option.roleId);
    }
    for (const option of byPosition) {
      if (!keep.has(option.roleId)) {
        declined.push({ optionId: option.optionId, reason: 'max-roles' });
      }
    }
    desired = keep;
  }

  // --- 4. the diff, against live roles -----------------------------------
  const grants: SnowflakeId[] = [];
  const revokes: SnowflakeId[] = [];
  for (const option of ordered) {
    if (!inScope(option)) continue;
    const wanted = desired.has(option.roleId);
    const has = held.has(option.roleId);
    if (wanted && !has) grants.push(option.roleId);
    if (!wanted && has) revokes.push(option.roleId);
  }

  // Out-of-scope options keep whatever the member has now, so a single-emoji
  // pass cannot revoke a role it never looked at.
  const finalDesired = new Set(
    ordered
      .filter((o) => (inScope(o) ? desired.has(o.roleId) : held.has(o.roleId)))
      .map((o) => o.roleId),
  );

  return {
    desiredRoleIds: finalDesired,
    grants,
    revokes,
    refusedBecause: undefined,
    declined,
  };
}

export interface IntentContext {
  readonly panelId: string;
  readonly userId: SnowflakeId;
  /** Interaction id for a button, convergence pass id for a reaction. */
  readonly triggerRef: string;
  readonly source: EffectSource;
  readonly batchId: string;
  readonly reason: string;
}

/**
 * Turns a plan into intents for the effect gateway.
 *
 * Revokes are ordered before grants so a `single_choice` swap frees its slot
 * before filling it — with `max_roles` set, doing it the other way round would
 * trip the panel's own ceiling halfway through its own change.
 */
export const intentsFor = (plan: ConvergencePlan, ctx: IntentContext): RoleIntent[] => [
  ...plan.revokes.map((roleId) => intent(roleId, 'revoke', ctx)),
  ...plan.grants.map((roleId) => intent(roleId, 'grant', ctx)),
];

const intent = (
  roleId: SnowflakeId,
  action: 'grant' | 'revoke',
  ctx: IntentContext,
): RoleIntent => ({
  userId: ctx.userId,
  roleId,
  action,
  panelId: ctx.panelId,
  triggerRef: ctx.triggerRef,
  source: ctx.source,
  batchId: ctx.batchId,
  reason: ctx.reason,
});

export const isEmptyPlan = (plan: ConvergencePlan): boolean =>
  plan.grants.length === 0 && plan.revokes.length === 0;
