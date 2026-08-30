import { checkReconcileBudget } from '../effects/budget.js';
import type { RoleIntent } from '../effects/gateway.js';
import type { DiscordMessageRef, DiscordRole, Snowflake } from '../discord/port.js';
import { DiscordApiError } from '../discord/errors.js';
import { isSnowflakeId, type SnowflakeId } from '../ids.js';
import { safeLogFields } from '../obs/logger.js';
import type { Subscriber } from '../pipeline/pipeline.js';
import { isEmptyPlan, planConvergence, type ConvergencePlan } from './convergence.js';
import type { PanelConfig } from './model.js';
import {
  applyPlan,
  convergeMember,
  ReactionStateCache,
  reactorsIsolated,
  type ReactionSubscriberDeps,
} from './reactions.js';

/**
 * Drift repair, by the same code path as a live event.
 *
 * Two things make reaction panels drift, and they are the same shape:
 *
 * - **A gap.** A fresh IDENTIFY means dispatches in the window are gone and are
 *   never replayed, so a reaction added while the bot was down produces no
 *   event at all. `gateway_gaps` records it and enqueues this pass.
 * - **Time.** A periodic run catches anything the gap record missed, including
 *   a reaction removed during a restart that left no trace anywhere.
 *
 * Both call `planConvergence`, which is what makes "reconciliation" a schedule
 * rather than a feature. `docs/19` §4 is explicit about why: drift repair
 * sharing the live path means it does not get its own separate bugs.
 *
 * **The budget is checked against the whole change list, before anything.** A
 * pass that finds a thousand drifted members is far more likely to be a bug in
 * our diff, a mid-outage API, or a role deleted and recreated, than a thousand
 * members who each changed their mind. Applying the first twenty-five and
 * stopping would leave the guild in a state nobody chose.
 *
 * **Adopted panels only, deliberately.** An adopted panel has an independent,
 * member-owned record of intent — the reactions on the message — so "the role
 * does not match the reactions" is unambiguous drift and repairing it restores
 * what the member asked for. A managed panel has no such record: the only
 * durable trace of a member's last choice *is* the role they hold. If a
 * moderator removes it by hand, re-adding it would be the bot overruling a
 * human on the strength of nothing, so a manual change to a managed panel's
 * role stands. `managed_role_assignments` is not consulted for this, because it
 * is provenance and diffing against it is exactly the bug amendment 4 forbids.
 */

export interface ReconcilePorts extends ReactionSubscriberDeps {
  /**
   * Live roles, for the deleted-role diagnosis below.
   *
   * On `ReconcilePorts` rather than on `PanelDiscordReader`, because it is the
   * only caller that needs it and the reader stays as narrow as its job.
   */
  fetchRoles(): Promise<readonly DiscordRole[]>;
  /**
   * `effectRepo.listAssignedUsers`: who this panel has granted a role to.
   *
   * A *candidate* list — see the note above `visit` below, and the long comment
   * on the repository function. It decides who is worth looking at; it never
   * decides what to change.
   */
  assignedMembers(panelId: string): readonly string[];
  /** `guilds.reconcile_budget`. Read per pass, so an operator can change it. */
  reconcileBudget(): number;
  setPanelStatus(panelId: string, status: 'disabled_by_doctor', reason: string): void;
  setRoleMissing(roleId: string): void;
}

export type ReconcileStatus = 'reconciled' | 'over-budget' | 'nothing-to-do';

export interface ReconcileOutcome {
  readonly status: ReconcileStatus;
  readonly panelsVisited: number;
  readonly changeCount: number;
  readonly applied: number;
  readonly skipped: number;
  readonly refused: number;
  /** Panels taken out of service this pass, and why. */
  readonly disabled: readonly { panelId: string; reason: string }[];
}

interface MemberPlan {
  readonly panel: PanelConfig;
  readonly userId: SnowflakeId;
  readonly selectedOptionIds: ReadonlySet<string>;
  readonly plan: ConvergencePlan;
}

const isGone = (err: unknown): boolean => err instanceof DiscordApiError && err.isGone;

export async function reconcileGuild(
  ports: ReconcilePorts,
  input: {
    reason: 'gateway-gap' | 'timer' | 'operator';
    /** One panel, for `bananasaurs panel sync <id>`. Absent means every panel. */
    panelId?: string | undefined;
  },
): Promise<ReconcileOutcome> {
  const panels = ports.store.listAdoptedPanels().filter(
    (p) =>
      (input.panelId === undefined || p.panelId === input.panelId) &&
      p.status === 'enabled' &&
      // ADR 0021: a panel with a blocked adoption backlog is a decision not
      // yet made, not drift to repair — checkReconcileBudget must not
      // silently authorise what runAdoptionPass's allowance gate refused.
      // 'running' is excluded too: an adoption pass owns this panel's
      // convergence while it is in flight. A panel that has never been
      // through runAdoptionPass keeps adoptionBlockedCount at 0 and is
      // untouched by this — ordinary drift-repair still applies to it.
      p.adoptionPassState !== 'running' &&
      p.adoptionBlockedCount === 0,
  );
  const disabled: { panelId: string; reason: string }[] = [];
  const plans: MemberPlan[] = [];

  // Live roles, read once for the whole pass. A panel option whose role has
  // been deleted is flagged rather than attempted — the gateway would refuse it
  // anyway, but a refusal per member per pass is noise that hides real problems.
  const liveRoleIds = new Set((await ports.fetchRoles()).map((r) => r.id));

  for (const panel of panels) {
    if (panel.messageId === undefined) continue;
    const ref: DiscordMessageRef = { channelId: panel.channelId, messageId: panel.messageId };

    // A deleted message means the panel can never work again: no reactions can
    // arrive, and there is nothing to re-seed. Disabling is the honest outcome
    // — the configuration is kept so an owner can point it at a new message.
    try {
      await ports.discord.fetchMessage(ports.guildId, ref);
    } catch (err) {
      if (!isGone(err)) throw err;
      ports.setPanelStatus(panel.panelId, 'disabled_by_doctor', 'the panel message was deleted');
      disabled.push({ panelId: panel.panelId, reason: 'message-deleted' });
      ports.logger.warn(
        safeLogFields({
          component: 'panels',
          guildId: ports.guildId,
          panelId: panel.panelId,
          messageId: panel.messageId,
          outcome: 'panel-disabled',
          reason: 'message-deleted',
        }),
        'the panel message is gone; the panel is disabled and its configuration kept',
      );
      continue;
    }

    for (const option of panel.options) {
      if (!liveRoleIds.has(option.roleId)) {
        ports.setRoleMissing(option.roleId);
        ports.logger.warn(
          safeLogFields({
            component: 'panels',
            guildId: ports.guildId,
            panelId: panel.panelId,
            optionId: option.optionId,
            roleId: option.roleId,
            outcome: 'role-deleted',
          }),
          'a panel offers a role that no longer exists',
        );
      }
    }

    // One cache per panel: every mapped emoji read once, however many members
    // reacted. This is the pass `docs/19` §6.4's memoisation is actually for.
    const cache = new ReactionStateCache(ports.discord, ports.guildId);
    const selections = new Map<string, Set<string>>();
    for (const option of panel.options) {
      if (option.emojiKey === undefined) continue;
      const reactors = await reactorsIsolated(cache, ref, option.emojiKey, (err) => {
        ports.logger.warn(
          safeLogFields({
            component: 'panels',
            guildId: ports.guildId,
            panelId: panel.panelId,
            optionId: option.optionId,
            roleId: option.roleId,
            outcome: 'option-skipped',
            err,
          }),
          'skipping a panel option Discord refused to read reactions for',
        );
      });
      for (const userId of reactors) {
        if (userId === ports.botUserId) continue;
        const existing = selections.get(userId);
        if (existing) existing.add(option.optionId);
        else selections.set(userId, new Set([option.optionId]));
      }
    }

    // Everyone worth looking at: the members reacting *now*, plus the members
    // this panel has granted a role to. The second half is what makes a
    // reaction *withdrawn* during an outage repairable at all — that member is
    // in no reaction set, so a pass driven only by reactors would never visit
    // them and the role would stay for good.
    //
    // This is not the diff amendment 4 forbids. Having decided to look at a
    // member, both sides of the comparison are read live: their Discord roles,
    // and the message's reactions. `managed_role_assignments` contributes a
    // name and nothing else.
    const visit = new Set([...selections.keys(), ...ports.assignedMembers(panel.panelId)]);

    for (const userId of [...visit].sort()) {
      if (!isSnowflakeId(userId)) continue;
      if (userId === ports.botUserId) continue;
      let currentRoleIds: ReadonlySet<string>;
      try {
        const member = await ports.discord.fetchMember(ports.guildId, userId);
        currentRoleIds = new Set(member.roleIds);
      } catch (err) {
        // A reactor who has since left the guild. Not an error for the pass.
        if (isGone(err)) continue;
        throw err;
      }

      const plan = planConvergence({
        panel,
        selectedOptionIds: selections.get(userId) ?? new Set(),
        currentRoleIds,
      });
      if (!isEmptyPlan(plan)) {
        plans.push({
          panel,
          userId,
          selectedOptionIds: selections.get(userId) ?? new Set(),
          plan,
        });
      }
    }
  }

  const changeCount = plans.reduce((n, p) => n + p.plan.grants.length + p.plan.revokes.length, 0);

  if (changeCount === 0) {
    ports.logger.info(
      safeLogFields({
        component: 'panels',
        guildId: ports.guildId,
        reason: input.reason,
        count: 0,
        total: panels.length,
        outcome: 'nothing-to-do',
      }),
      'reconciliation found no drift',
    );
    return {
      status: 'nothing-to-do',
      panelsVisited: panels.length,
      changeCount: 0,
      applied: 0,
      skipped: 0,
      refused: 0,
      disabled,
    };
  }

  // The budget takes the whole list, not a count, so a caller cannot pass a
  // number it computed from something other than the work it is about to do.
  const asIntents: RoleIntent[] = plans.flatMap(({ panel, userId, plan }) =>
    [...plan.revokes, ...plan.grants].map((roleId) => ({
      userId,
      roleId,
      action: plan.grants.includes(roleId) ? ('grant' as const) : ('revoke' as const),
      panelId: panel.panelId,
      triggerRef: 'budget-probe',
      source: 'reconcile' as const,
      batchId: 'budget-probe',
      reason: 'reconciliation',
    })),
  );
  const decision = checkReconcileBudget(asIntents, ports.reconcileBudget());
  if (!decision.ok) {
    ports.logger.error(
      safeLogFields({
        component: 'panels',
        guildId: ports.guildId,
        reason: input.reason,
        count: decision.count,
        budget: decision.budget,
        outcome: 'over-budget',
      }),
      'reconciliation would change more than the budget allows and has done nothing',
    );
    return {
      status: 'over-budget',
      panelsVisited: panels.length,
      changeCount,
      applied: 0,
      skipped: 0,
      refused: 0,
      disabled,
    };
  }

  // One batch for the pass, so an incorrect repair is one `undo` away.
  const batchId = ports.effects.openBatch('reconcile');
  let applied = 0;
  let skipped = 0;
  let refused = 0;

  try {
    for (const { panel, userId, selectedOptionIds, plan } of plans) {
      const result = await applyPlan(ports, {
        panel,
        userId,
        selectedOptionIds,
        source: 'reconcile',
        reason: `reconciling panel ${panel.panelId}`,
        batchId,
        plan,
      });
      applied += result.applied;
      skipped += result.skipped;
      refused += result.refused;
    }
  } finally {
    ports.effects.closeBatch(batchId);
  }

  ports.logger.info(
    safeLogFields({
      component: 'panels',
      guildId: ports.guildId,
      reason: input.reason,
      batchId,
      count: changeCount,
      applied,
      skipped,
      total: panels.length,
      outcome: 'reconciled',
    }),
    'reconciliation complete',
  );

  return {
    status: 'reconciled',
    panelsVisited: panels.length,
    changeCount,
    applied,
    skipped,
    refused,
    disabled,
  };
}

// --- amendment 5: GUILD_MEMBER_UPDATE ---------------------------------------

export interface MemberUpdatePorts extends ReactionSubscriberDeps {
  /**
   * `effectRepo.wasRecentlyApplied`. Backed by the `role_effects_recent` index;
   * without it this is a scan on the busiest table in the schema.
   */
  wasRecentlyApplied(input: {
    userId: string;
    roleId: string;
    sinceMs: number;
    /**
     * Which way *we* moved the role. Passed always, never omitted: without it,
     * our own grant makes a *removal* of the same role inside the window look
     * like ours too, and a moderator undoing the bot seconds later is ignored
     * until the timer pass.
     */
    action: 'grant' | 'revoke';
  }): boolean;
  /** How far back a change still counts as ours. */
  readonly selfMutationWindowMs: number;
}

/**
 * Catches a manual role change promptly, instead of waiting for the timer.
 *
 * **The event fires for our own mutations too**, which is the trap amendment 5
 * exists to name: repair naively and the bot reacts to its own grant, re-grants,
 * and reacts again — a feedback loop that looks like a hung process and burns
 * the rate cap until the breaker trips. Every role in the delta is therefore
 * checked against `role_effects` for a completed effect inside a short window,
 * and only the remainder is treated as external drift.
 *
 * Adopted panels only, for the reason `reconcileGuild` gives above: reactions
 * are an independent record of what the member asked for, and a managed panel
 * has none.
 */
export const createMemberUpdateSubscriber = (deps: MemberUpdatePorts): Subscriber => ({
  name: 'panel-drift',
  async handle(event) {
    if (event.kind !== 'memberUpdate') return;
    if (event.previousRoleIds === undefined) return;
    if (!isSnowflakeId(event.userId)) return;
    const userId = event.userId;

    const before = new Set(event.previousRoleIds);
    const after = new Set(event.roleIds);
    // The direction travels with the role, because it is what the filter below
    // matches on: a role that appeared could be our grant, a role that vanished
    // could be our revoke, and neither answers for the other.
    const delta: { roleId: string; action: 'grant' | 'revoke' }[] = [
      ...[...after]
        .filter((r) => !before.has(r))
        .map((r) => ({ roleId: r, action: 'grant' as const })),
      ...[...before]
        .filter((r) => !after.has(r))
        .map((r) => ({ roleId: r, action: 'revoke' as const })),
    ];
    if (delta.length === 0) return;

    const sinceMs = deps.now() - deps.selfMutationWindowMs;
    const external = delta
      .filter(({ roleId, action }) => !deps.wasRecentlyApplied({ userId, roleId, sinceMs, action }))
      .map(({ roleId }) => roleId);
    if (external.length === 0) {
      deps.logger.debug(
        safeLogFields({
          component: 'panel-drift',
          guildId: deps.guildId,
          userId,
          count: delta.length,
          outcome: 'self-mutation',
        }),
        'ignoring a member update this instance caused',
      );
      return;
    }

    const affected = deps.store
      .listAdoptedPanels()
      .filter(
        (panel) =>
          panel.status === 'enabled' &&
          panel.messageId !== undefined &&
          panel.options.some((option) => external.includes(option.roleId)),
      );
    if (affected.length === 0) return;

    for (const panel of affected) {
      if (panel.messageId === undefined) continue;
      const ref: DiscordMessageRef = { channelId: panel.channelId, messageId: panel.messageId };
      const cache = new ReactionStateCache(deps.discord, deps.guildId);

      const selected = new Set<string>();
      try {
        for (const option of panel.options) {
          if (option.emojiKey === undefined) continue;
          const reactors: readonly Snowflake[] = await cache.reactors(ref, option.emojiKey);
          if (reactors.includes(userId)) selected.add(option.optionId);
        }
      } catch (err) {
        if (isGone(err)) continue; // the message is gone; the timer pass will disable it
        throw err;
      }

      // Limited to the options whose roles actually changed, so repairing a
      // manual removal of one role does not re-derive every other.
      const limitToOptionIds = new Set(
        panel.options.filter((o) => external.includes(o.roleId)).map((o) => o.optionId),
      );

      await convergeMember(deps, {
        panel,
        userId,
        selectedOptionIds: selected,
        limitToOptionIds,
        source: 'reconcile',
        reason: `repairing drift on panel ${panel.panelId}`,
      });
    }
  },
});
