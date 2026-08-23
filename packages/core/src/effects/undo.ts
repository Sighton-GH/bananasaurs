import type { Authorized } from '../authz.js';
import type { GuildId, SnowflakeId } from '../ids.js';
import { safeLogFields, type Logger } from '../obs/logger.js';
import type { EffectGateway, EffectOutcome, RoleIntent } from './gateway.js';

/**
 * Undo, as a replay of the inverse through the same gateway.
 *
 * Undo is not a special path with its own permissions and its own bugs. It
 * builds inverse intents and pushes them through `applyRoleEffect` like
 * anything else, so the kill switch, the breaker, the hierarchy check, the rate
 * cap and dry-run all apply to an undo exactly as they apply to the action it
 * reverses. An undo that could bypass the kill switch would be a second,
 * unaudited way to change roles.
 *
 * **This is what `had_role_before` is for.** Without it, undoing a grant cannot
 * distinguish "we added this role" from "they already had it and we did
 * nothing" — and the naive inverse would strip a role the member had all along.
 */

export interface UndoableEffect {
  readonly effectId: string;
  readonly userId: SnowflakeId;
  readonly roleId: SnowflakeId;
  readonly action: 'grant' | 'revoke';
  readonly state: string;
  /** The member's state before we acted. The whole basis of the inverse. */
  readonly hadRoleBefore: boolean;
  readonly panelId: string | undefined;
}

export interface UndoPorts {
  readonly guildId: GuildId;
  /** Every effect recorded under the batch being undone. */
  effectsInBatch(batchId: string): readonly UndoableEffect[];
  /** A fresh batch, so the undo is itself auditable and itself undoable. */
  openBatch(input: {
    source: 'cli' | 'dashboard';
    actorType: string;
    actorId: string | undefined;
  }): string;
  closeBatch(batchId: string): void;
  markBatchUndone(batchId: string): void;
  readonly logger: Logger;
}

export interface UndoResult {
  readonly undoBatchId: string;
  readonly reversed: number;
  /** Effects that changed nothing, so there is nothing to reverse. */
  readonly nothingToReverse: number;
  readonly outcomes: readonly EffectOutcome[];
}

/**
 * The inverse of an effect, or `undefined` when it changed nothing.
 *
 * Exported because the truth table is the substance of undo, and it deserves
 * to be tested without a gateway, a database or a Discord client.
 */
export const inverseOf = (effect: UndoableEffect): 'grant' | 'revoke' | undefined => {
  // Only an effect that actually landed can be reversed. A refusal, a dry run
  // or a skip changed nothing in Discord.
  if (effect.state !== 'applied') return undefined;

  if (effect.action === 'grant') {
    // We granted a role they already had: we changed nothing, so reversing
    // would remove a role that was never ours to remove.
    return effect.hadRoleBefore ? undefined : 'revoke';
  }
  // We revoked a role they did not have: again, nothing changed.
  return effect.hadRoleBefore ? 'grant' : undefined;
};

export interface UndoInput {
  readonly batchId: string;
  readonly source: 'cli' | 'dashboard';
  readonly reason: string;
}

/**
 * Both witnesses, deliberately.
 *
 * Undoing role effects requires the right to undo *and* the right to mutate
 * roles. Modelling it with one witness and casting to the other is the exact
 * shortcut amendment 3 warns about — and worth naming, because I wrote it
 * first: `as unknown as Parameters<...>[0]` slips past the lint tripwire,
 * which matches a named type reference rather than an indirect cast. The
 * runtime re-check in the gateway would still have caught a forged witness,
 * but the honest fix is to require what is actually required.
 */
export interface UndoAuthorization {
  readonly undo: Authorized<'undo.execute'>;
  readonly mutate: Authorized<'roles.mutate'>;
}

export async function undoBatch(
  gateway: EffectGateway,
  auth: UndoAuthorization,
  ports: UndoPorts,
  input: UndoInput,
): Promise<UndoResult> {
  const effects = ports.effectsInBatch(input.batchId);
  // The actor comes from the undo witness rather than from the caller's input,
  // so the audit trail records who was actually authorized rather than whoever
  // the caller said they were.
  const undoBatchId = ports.openBatch({
    source: input.source,
    actorType: auth.undo.actor.type,
    actorId: auth.undo.actor.id,
  });

  const outcomes: EffectOutcome[] = [];
  let reversed = 0;
  let nothingToReverse = 0;

  for (const effect of effects) {
    const inverse = inverseOf(effect);
    if (!inverse) {
      nothingToReverse += 1;
      continue;
    }

    const intent: RoleIntent = {
      userId: effect.userId,
      roleId: effect.roleId,
      action: inverse,
      panelId: effect.panelId,
      // Derived from the effect being reversed, so the undo gets its own
      // dedupe key. Reusing the original trigger would collide with the effect
      // it is undoing and be skipped as a replay.
      triggerRef: `undo:${effect.effectId}`,
      source: input.source,
      batchId: undoBatchId,
      reason: input.reason,
    };

    // Deliberately sequential. The rate cap is per source, and firing a batch
    // concurrently would exhaust it in a burst and trip the breaker on work the
    // owner explicitly asked for.
    const outcome = await gateway.applyRoleEffect(auth.mutate, intent);
    outcomes.push(outcome);
    if (outcome.status === 'applied' || outcome.status === 'dry-run') reversed += 1;
  }

  ports.closeBatch(undoBatchId);
  ports.markBatchUndone(input.batchId);

  ports.logger.info(
    safeLogFields({
      component: 'effects',
      guildId: ports.guildId,
      batchId: input.batchId,
      count: effects.length,
      applied: reversed,
      skipped: nothingToReverse,
      action: 'batch.undo',
    }),
    'batch undone',
  );

  return { undoBatchId, reversed, nothingToReverse, outcomes };
}
