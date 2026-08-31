import { eq, lte } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { write } from '../write.js';
import { modPendingActions } from '../schema.js';

/**
 * A moderation action awaiting its second confirmation (ADR 0037).
 *
 * The payload shape lives in `@bananasaurs/core`'s `modPendingActionPayload`
 * so the producer (the `/mod` command) and the consumer (the confirm
 * handler) cannot disagree about it; this repo stores and takes the JSON
 * opaquely, the same split `jobs` uses. One-shot semantics live here, at
 * the storage layer: `takePendingAction` reads and deletes in a single
 * `write()`, so a double-tap on Confirm or a replayed component dispatch
 * finds the row already gone — duplicate execution is impossible even
 * before the caller's own checks run.
 *
 * Guild scope is enforced by the composite primary key: an intent is
 * `(guild_id, intent_id)`, so another guild's intent is not "forbidden",
 * it is not there.
 */

export interface PutPendingActionInput {
  readonly intentId: string;
  /** JSON produced by the caller; validated on read by the consumer. */
  readonly payload: string;
  readonly createdBy: string;
  readonly now: number;
  readonly expiresAt: number;
}

export interface PendingActionRow {
  readonly intentId: string;
  readonly payload: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export const putPendingAction = (scope: GuildScope, input: PutPendingActionInput): void =>
  write(scope, ({ db }) => {
    db.insert(modPendingActions)
      .values({
        guildId: scope.guildId,
        intentId: input.intentId,
        payload: input.payload,
        createdBy: input.createdBy,
        createdAt: input.now,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing()
      .run();
  });

/**
 * Takes an unexpired intent: read and delete in one write, or `undefined`
 * when there is nothing to take — never taken, or expired past the
 * interaction-token window.
 */
export const takePendingAction = (
  scope: GuildScope,
  intentId: string,
  now: number,
): PendingActionRow | undefined =>
  write(scope, ({ db }) => {
    const row = db
      .select({
        intentId: modPendingActions.intentId,
        payload: modPendingActions.payload,
        createdBy: modPendingActions.createdBy,
        createdAt: modPendingActions.createdAt,
        expiresAt: modPendingActions.expiresAt,
      })
      .from(modPendingActions)
      .where(scope.only(modPendingActions, eq(modPendingActions.intentId, intentId)))
      .get();

    if (!row) return undefined;
    if (row.expiresAt <= now) {
      // Expired: dead as far as the caller is concerned, but delete it so
      // the table does not accumulate intents that can never confirm.
      db.delete(modPendingActions)
        .where(scope.only(modPendingActions, eq(modPendingActions.intentId, intentId)))
        .run();
      return undefined;
    }

    db.delete(modPendingActions)
      .where(scope.only(modPendingActions, eq(modPendingActions.intentId, intentId)))
      .run();
    return row;
  });

/** Deletes every intent that can no longer confirm. Housekeeping, not a gate. */
export const sweepExpiredPendingActions = (scope: GuildScope, now: number): number =>
  write(
    scope,
    ({ db }) =>
      db
        .delete(modPendingActions)
        .where(scope.only(modPendingActions, lte(modPendingActions.expiresAt, now)))
        .run().changes,
  );
