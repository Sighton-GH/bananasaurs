import {
  JOB_KINDS,
  reconcileGuild,
  reconcileGuildPayload,
  safeLogFields,
  type JobHandler,
  type ReconcileGuildPayload,
  type ReconcilePorts,
} from '@bananasaurs/core';
import { pipelineRepo, type GuildScope } from '@bananasaurs/storage';

/**
 * Reconciliation, as a job.
 *
 * A job rather than something the connection handler does inline, because a
 * reconnect must be fast and a pass over every adopted panel is not: it pages
 * reactions, fetches a member per reactor, and then applies changes through the
 * rate cap. Doing that on the gateway's thread would delay resuming the very
 * events it exists to catch up on.
 *
 * `markGapReconciled` runs **after** the pass returns, and only then — a gap
 * left unreconciled is a gap the next pass will see again, which is the safe
 * direction to fail. A crash mid-pass therefore repeats work rather than
 * skipping it, and repeating is cheap: convergence is level-triggered and the
 * gateway's no-op check absorbs the second run without spending budget.
 */
export const reconcileGuildHandler = (
  scope: GuildScope,
  ports: ReconcilePorts,
  now: () => number,
): JobHandler<ReconcileGuildPayload> => ({
  kind: JOB_KINDS.reconcileGuild,
  payload: reconcileGuildPayload,
  async run(payload) {
    const outcome = await reconcileGuild(ports, { reason: payload.reason });

    // An over-budget pass repaired nothing, so the gap is still outstanding and
    // must stay that way: clearing it would hide a guild that needs an owner to
    // look at it behind a job that reported success.
    //
    // Over budget is also not an exception. Retrying changes nothing until an
    // operator raises the budget or fixes whatever produced the drift, and a
    // retrying job would re-page every reaction on the backoff schedule.
    if (payload.gapId !== undefined && outcome.status !== 'over-budget') {
      pipelineRepo.markGapReconciled(scope, payload.gapId, now());
    }

    ports.logger.info(
      safeLogFields({
        component: 'jobs',
        jobKind: JOB_KINDS.reconcileGuild,
        guildId: scope.guildId,
        reason: payload.reason,
        gapId: payload.gapId,
        outcome: outcome.status,
        count: outcome.changeCount,
        applied: outcome.applied,
        total: outcome.panelsVisited,
      }),
      'reconciliation job finished',
    );
  },
});
