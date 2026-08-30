import {
  authorize,
  inverseOf,
  JOB_KINDS,
  parseSnowflakeId,
  safeLogFields,
  undoBatch,
  undoBatchPayload,
  type Actor,
  type EffectGateway,
  type GuildId,
  type JobHandler,
  type Logger,
  type UndoableEffect,
  type UndoAuthorization,
  type UndoBatchPayload,
  type UndoPorts,
} from '@bananasaurs/core';
import { authzStoreFor, effectRepo, type GuildScope } from '@bananasaurs/storage';

/**
 * Undo, as a job (ADR 0026).
 *
 * A job rather than the socket handler's own work, because reversal goes
 * through the role rate cap sequentially and on purpose: at the default twenty
 * changes a minute, a thirty-effect batch takes ninety seconds and the CLI
 * gives up after thirty. A synchronous undo would time out at the terminal
 * while continuing to reverse grants in the background, which is the one
 * outcome an operator running `undo` during an incident must never get.
 *
 * As a row in `jobs`, it also survives a restart mid-reversal —
 * `requeueStranded` returns it to the queue — and repeating is safe:
 * `undoBatch` derives its own `trigger_ref` per effect (`undo:${effectId}`), so
 * the gateway's idempotency collapses a second run rather than reversing twice.
 */

/**
 * Who undoes, and why it is not `system`.
 *
 * `panels/wiring.ts` runs panel effects as `system`, because the authorization
 * for a panel-driven change is the panel itself and no member holds
 * `roles.mutate`. Undo is the opposite case: a human on the operator socket
 * asked for it by name, and the batch this opens must say so. The claimed Unix
 * user is not carried here — it belongs on the `audit_events` row the
 * dispatcher already wrote when the command was accepted, next to the caveat
 * in its column name (ADR 0024, amendment 2).
 */
const OPERATOR_ACTOR: Actor = { type: 'operator_cli', id: undefined, roleIds: [] };

/**
 * Both witnesses, obtained honestly and never cast.
 *
 * `undoBatch` demands `undo.execute` **and** `roles.mutate` — modelling it with
 * one and casting to the other is the shortcut amendment 3 warns about, and the
 * lint tripwire bans the cast that would do it. `authorize` returns both for
 * `operator_cli` because reaching the socket is the authorization (ADR 0024),
 * not because anything here decided to skip the check.
 */
export const operatorUndoAuthorization = (scope: GuildScope): UndoAuthorization => {
  const input = { store: authzStoreFor(scope), guildId: scope.guildId, actor: OPERATOR_ACTOR };
  const undoResult = authorize(input, 'undo.execute');
  const mutateResult = authorize(input, 'roles.mutate');
  if (!undoResult.ok) throw new Error(`undo could not be authorized: ${undoResult.error.reason}`);
  if (!mutateResult.ok) {
    throw new Error(`undo could not be authorized to mutate roles: ${mutateResult.error.reason}`);
  }
  return { undo: undoResult.value, mutate: mutateResult.value };
};

/**
 * The storage rows, parsed into what the truth table needs.
 *
 * `parseSnowflakeId` at this boundary rather than a cast: the columns are
 * `TEXT` and every row in them came through a parse once, but a value read back
 * out of SQLite is untyped again, and the brand exists to make the parse
 * impossible to forget rather than to be annotated back on.
 */
const undoableEffectsFor = (scope: GuildScope, batchId: string): UndoableEffect[] =>
  effectRepo.effectsInBatch(scope, batchId).map((row) => ({
    effectId: row.effectId,
    userId: parseSnowflakeId(row.userId),
    roleId: parseSnowflakeId(row.roleId),
    // The column is unconstrained `TEXT`; the domain type is a two-value union.
    // Anything else cannot be inverted, and `inverseOf` reads the state first.
    action: row.action === 'grant' ? 'grant' : 'revoke',
    state: row.state,
    hadRoleBefore: row.hadRoleBefore === 1,
    panelId: row.panelId ?? undefined,
  }));

/** Counted without reversing, so `bananasaurs undo` can report the size first. */
export const countUndoable = (
  scope: GuildScope,
  batchId: string,
): { total: number; reversible: number } => {
  const effects = undoableEffectsFor(scope, batchId);
  return {
    total: effects.length,
    // `inverseOf` itself, not a re-derivation of it. It is exported precisely
    // because the truth table is the substance of undo, and a count that
    // disagreed with the run would be worse than no count at all.
    reversible: effects.filter((e) => inverseOf(e) !== undefined).length,
  };
};

export interface UndoHandlerDeps {
  readonly guildId: GuildId;
  readonly gateway: EffectGateway;
  readonly logger: Logger;
  readonly now: () => number;
}

export const undoBatchHandler = (
  scope: GuildScope,
  deps: UndoHandlerDeps,
): JobHandler<UndoBatchPayload> => ({
  kind: JOB_KINDS.undoBatch,
  payload: undoBatchPayload,
  async run(payload) {
    const ports: UndoPorts = {
      guildId: deps.guildId,
      effectsInBatch: (batchId) => undoableEffectsFor(scope, batchId),
      openBatch: (input) =>
        effectRepo.openBatch(scope, {
          source: input.source,
          actorType: input.actorType,
          actorId: input.actorId,
          now: deps.now(),
        }),
      closeBatch: (batchId) => effectRepo.closeBatch(scope, batchId, deps.now()),
      markBatchUndone: (batchId) => effectRepo.markBatchUndone(scope, batchId, deps.now()),
      logger: deps.logger,
    };

    const outcome = await undoBatch(deps.gateway, operatorUndoAuthorization(scope), ports, {
      batchId: payload.batchId,
      source: 'cli',
      reason: payload.reason,
    });

    deps.logger.info(
      safeLogFields({
        component: 'jobs',
        jobKind: JOB_KINDS.undoBatch,
        guildId: scope.guildId,
        batchId: payload.batchId,
        undoBatchId: outcome.undoBatchId,
        applied: outcome.reversed,
        skipped: outcome.nothingToReverse,
        outcome: 'undone',
      }),
      'undo job finished',
    );
  },
});
