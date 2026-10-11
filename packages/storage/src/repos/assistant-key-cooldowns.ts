import { and, eq } from 'drizzle-orm';
import { assistantKeyCooldowns } from '../schema.js';
import type { InstanceScope } from '../scope.js';
import { readInstance, writeInstance } from '../write.js';

export interface KeyCooldown {
  readonly keyId: string;
  readonly model: string;
  readonly until: number;
  readonly reason: string;
  readonly setAt: number;
  readonly learnedPerDay?: number;
  readonly learnedPerMinute?: number;
}

export interface SetCooldownInput {
  readonly keyId: string;
  readonly model: string;
  readonly until: number;
  readonly reason: string;
  readonly setAt: number;
  readonly learnedPerDay?: number;
  readonly learnedPerMinute?: number;
}

const toCooldown = (row: typeof assistantKeyCooldowns.$inferSelect): KeyCooldown => ({
  keyId: row.keyId,
  model: row.model,
  until: row.untilAt,
  reason: row.reason,
  setAt: row.setAt,
  ...(row.learnedPerDay === null ? {} : { learnedPerDay: row.learnedPerDay }),
  ...(row.learnedPerMinute === null ? {} : { learnedPerMinute: row.learnedPerMinute }),
});

/** An expired row reads as absent; a missing row is absent. */
export const getCooldown = (
  scope: InstanceScope,
  keyId: string,
  model: string,
  now: number,
): KeyCooldown | undefined =>
  readInstance(scope, (db) => {
    const row = db
      .select()
      .from(assistantKeyCooldowns)
      .where(and(eq(assistantKeyCooldowns.keyId, keyId), eq(assistantKeyCooldowns.model, model)))
      .get();
    if (row === undefined || now >= row.untilAt) return undefined;
    return toCooldown(row);
  });

/** Upserts the row for this key and model. */
export const setCooldown = (scope: InstanceScope, input: SetCooldownInput): void =>
  writeInstance(scope, ({ db }) => {
    db.insert(assistantKeyCooldowns)
      .values({
        keyId: input.keyId,
        model: input.model,
        untilAt: input.until,
        reason: input.reason,
        setAt: input.setAt,
        learnedPerDay: input.learnedPerDay ?? null,
        learnedPerMinute: input.learnedPerMinute ?? null,
      })
      .onConflictDoUpdate({
        target: [assistantKeyCooldowns.keyId, assistantKeyCooldowns.model],
        set: {
          untilAt: input.until,
          reason: input.reason,
          setAt: input.setAt,
          learnedPerDay: input.learnedPerDay ?? null,
          learnedPerMinute: input.learnedPerMinute ?? null,
        },
      })
      .run();
  });

export const clearCooldowns = (scope: InstanceScope, keyId: string, model?: string): void =>
  writeInstance(scope, ({ db }) => {
    db.delete(assistantKeyCooldowns)
      .where(
        and(
          eq(assistantKeyCooldowns.keyId, keyId),
          ...(model === undefined ? [] : [eq(assistantKeyCooldowns.model, model)]),
        ),
      )
      .run();
  });

export const listCooldowns = (scope: InstanceScope): KeyCooldown[] =>
  readInstance(scope, (db) => db.select().from(assistantKeyCooldowns).all().map(toCooldown));
