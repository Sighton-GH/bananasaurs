import { and, eq, sql } from 'drizzle-orm';
import { assistantModelCalls } from '../schema.js';
import type { InstanceScope } from '../scope.js';
import { readInstance, writeInstance } from '../write.js';

/**
 * The per-model provider-call ledger (ADR 0081).
 *
 * Every provider HTTP call is recorded here — key, model, time, and which
 * guild spent the call — so a chain entry at its RPM/RPD limit is skipped
 * before calling instead of after a 429. Instance-scoped because the key is
 * shared; `guild_id` records who spent the call (hard rule 2 keeps the
 * instance scope: this is ledger data about a shared key, not guild state).
 *
 * The reserve is one synchronous `writeInstance` transaction with no `await`
 * inside, so two jobs cannot both take the last slot (ADR 0081 §3). A failed
 * call still counts, as it does at the provider.
 */

export type ReserveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly limit: 'rpm' | 'rpd'; readonly availableAt: number };

export interface ReserveModelCallInput {
  readonly keyId: string;
  readonly model: string;
  readonly guildId: string;
  readonly now: number;
  readonly rpmLimit: number | null;
  readonly rpdLimit: number | null;
  readonly dayStart: number;
  readonly nextDayStart: number;
  /**
   * ADR 0143 follow-up: when the selected key draws from a shared project
   * bucket, the RPM/RPD windows count rows for every key id in the bucket
   * (same model). The row inserted is still for `keyId`.
   */
  readonly bucketKeyIds?: readonly string[] | undefined;
}

export interface ModelUsageInput {
  readonly keyId: string;
  readonly model: string;
  readonly now: number;
  readonly dayStart: number;
}

export interface ModelUsage {
  readonly lastMinute: number;
  readonly today: number;
  readonly oldestInMinute?: number;
}

/** Sliding RPM window, and the age past which rows are pruned on reserve. */
const MINUTE_MS = 60000;
const PRUNE_AFTER_MS = 172800000;

const forKeyModel = (keyId: string, model: string) =>
  and(eq(assistantModelCalls.keyId, keyId), eq(assistantModelCalls.model, model));

const forBucketModel = (keyIds: readonly string[], model: string) =>
  keyIds.length === 1
    ? forKeyModel(keyIds[0]!, model)
    : and(
        sql`${assistantModelCalls.keyId} IN (${sql.join(
          keyIds.map((k) => sql`${k}`),
          sql`, `,
        )})`,
        eq(assistantModelCalls.model, model),
      );

export const reserveModelCall = (
  scope: InstanceScope,
  input: ReserveModelCallInput,
): ReserveResult =>
  writeInstance(scope, ({ db }) => {
    const bucket = input.bucketKeyIds ?? [input.keyId];
    const window = forBucketModel(bucket.length === 0 ? [input.keyId] : bucket, input.model);
    // 1. Prune rows older than 48 h.
    db.delete(assistantModelCalls)
      .where(sql`${assistantModelCalls.at} < ${input.now - PRUNE_AFTER_MS}`)
      .run();
    // 2. Sliding 60 s RPM window.
    if (input.rpmLimit !== null) {
      const minuteRows = db
        .select({ at: assistantModelCalls.at })
        .from(assistantModelCalls)
        .where(
          and(
            window,
            sql`${assistantModelCalls.at} > ${input.now - MINUTE_MS}`,
          ),
        )
        .all();
      if (minuteRows.length >= input.rpmLimit) {
        const oldest = minuteRows.reduce((min, r) => Math.min(min, r.at), Number.POSITIVE_INFINITY);
        return {
          ok: false as const,
          limit: 'rpm' as const,
          availableAt: (oldest === Number.POSITIVE_INFINITY ? input.now : oldest) + MINUTE_MS,
        };
      }
    }
    // 3. RPD window from the provider's day start.
    if (input.rpdLimit !== null) {
      const today = db
        .select({ n: sql<number>`count(*)` })
        .from(assistantModelCalls)
        .where(
          and(
            window,
            sql`${assistantModelCalls.at} >= ${input.dayStart}`,
          ),
        )
        .get()?.n;
      if ((today ?? 0) >= input.rpdLimit) {
        return { ok: false as const, limit: 'rpd' as const, availableAt: input.nextDayStart };
      }
    }
    // 4. The reservation itself.
    db.insert(assistantModelCalls)
      .values({ keyId: input.keyId, model: input.model, at: input.now, guildId: input.guildId })
      .run();
    return { ok: true as const };
  });

export const modelUsage = (scope: InstanceScope, input: ModelUsageInput): ModelUsage =>
  readInstance(scope, (db) => {
    const minuteRows = db
      .select({ at: assistantModelCalls.at })
      .from(assistantModelCalls)
      .where(
        and(
          forKeyModel(input.keyId, input.model),
          sql`${assistantModelCalls.at} > ${input.now - MINUTE_MS}`,
        ),
      )
      .all();
    const today =
      db
        .select({ n: sql<number>`count(*)` })
        .from(assistantModelCalls)
        .where(
          and(
            forKeyModel(input.keyId, input.model),
            sql`${assistantModelCalls.at} >= ${input.dayStart}`,
          ),
        )
        .get()?.n ?? 0;
    return {
      lastMinute: minuteRows.length,
      today: Number(today),
      ...(minuteRows.length === 0
        ? {}
        : {
            oldestInMinute: minuteRows.reduce(
              (min, r) => Math.min(min, r.at),
              Number.POSITIVE_INFINITY,
            ),
          }),
    };
  });

/**
 * ADR 0143: pool selection reads. `lastUsedAt` is the newest call for one key
 * and model (0 when never used); `callsTodayForKeys` counts today's calls for
 * a model across every key in one quota bucket (keys sharing a project label).
 * Read-only; the per-key reserve above is unchanged.
 */
export const lastUsedAt = (
  scope: InstanceScope,
  input: { readonly keyId: string; readonly model: string },
): number =>
  readInstance(scope, (db) => {
    const row = db
      .select({ at: sql<number | null>`max(${assistantModelCalls.at})` })
      .from(assistantModelCalls)
      .where(forKeyModel(input.keyId, input.model))
      .get();
    return Number(row?.at ?? 0);
  });

export const callsTodayForKeys = (
  scope: InstanceScope,
  input: { readonly keyIds: readonly string[]; readonly model: string; readonly dayStart: number },
): number =>
  input.keyIds.length === 0
    ? 0
    : readInstance(scope, (db) => {
        const row = db
          .select({ n: sql<number>`count(*)` })
          .from(assistantModelCalls)
          .where(
            and(
              sql`${assistantModelCalls.keyId} IN (${sql.join(
                input.keyIds.map((k) => sql`${k}`),
                sql`, `,
              )})`,
              eq(assistantModelCalls.model, input.model),
              sql`${assistantModelCalls.at} >= ${input.dayStart}`,
            ),
          )
          .get();
        return Number(row?.n ?? 0);
      });
