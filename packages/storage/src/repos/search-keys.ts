import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db.js';
import { assistantSearchCalls, assistantSearchKeys } from '../schema.js';
import type { InstanceScope } from '../scope.js';
import { readInstance, writeInstance } from '../write.js';

/**
 * Several sealed search keys per source, each with its own sliding-window
 * limits (ADR 0120).
 *
 * Instance-level throughout: keys are a fact about the daemon, not a guild.
 * The calls ledger records which guild spent each call (hard rule 2, as in
 * `model-calls.ts`). The reserve is one synchronous `writeInstance`
 * transaction with no `await` inside, so two jobs cannot both take the last
 * slot; a failed call still counts, as it does at the provider.
 */

export type SearchSource = 'brave' | 'tavily' | 'parallel';

export interface StoredSearchKey {
  readonly keyId: string;
  readonly source: SearchSource;
  readonly label: string;
  readonly apiKeyEnc: string;
  readonly enabled: boolean;
  readonly position: number;
  readonly monthlyLimit: number | null;
  readonly dailyLimit: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A new key's monthly limit when the caller omits one (ADR 0120 §4). */
export const DEFAULT_MONTHLY_LIMIT = 1000;
export const DAY_MS = 86_400_000;
export const MONTH_WINDOW_MS = 31 * DAY_MS;
/** Rows this old or older are pruned on reserve. */
const PRUNE_AFTER_MS = 32 * DAY_MS;

const asSearchSource = (value: string): SearchSource => {
  if (value !== 'brave' && value !== 'tavily' && value !== 'parallel')
    throw new Error(`unexpected search source ${JSON.stringify(value)}`);
  return value;
};

const toKey = (row: {
  keyId: string;
  source: string;
  label: string;
  apiKeyEnc: string;
  enabled: number;
  position: number;
  monthlyLimit: number | null;
  dailyLimit: number | null;
  createdAt: number;
  updatedAt: number;
}): StoredSearchKey => ({
  keyId: row.keyId,
  source: asSearchSource(row.source),
  label: row.label,
  apiKeyEnc: row.apiKeyEnc,
  enabled: row.enabled === 1,
  position: row.position,
  monthlyLimit: row.monthlyLimit,
  dailyLimit: row.dailyLimit,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const keyColumns = {
  keyId: assistantSearchKeys.keyId,
  source: assistantSearchKeys.source,
  label: assistantSearchKeys.label,
  apiKeyEnc: assistantSearchKeys.apiKeyEnc,
  enabled: assistantSearchKeys.enabled,
  position: assistantSearchKeys.position,
  monthlyLimit: assistantSearchKeys.monthlyLimit,
  dailyLimit: assistantSearchKeys.dailyLimit,
  createdAt: assistantSearchKeys.createdAt,
  updatedAt: assistantSearchKeys.updatedAt,
};

/** Ordered by source, then position, then key id. */
export const listSearchKeys = (scope: InstanceScope): StoredSearchKey[] =>
  readInstance(scope, (db) =>
    db
      .select(keyColumns)
      .from(assistantSearchKeys)
      .orderBy(
        asc(assistantSearchKeys.source),
        asc(assistantSearchKeys.position),
        asc(assistantSearchKeys.keyId),
      )
      .all()
      .map(toKey),
  );

/** `skey_` + 16 hex characters, matching the design's key id shape. */
const newKeyId = (): string => `skey_${randomBytes(8).toString('hex')}`;

/**
 * Adds a new key and returns its id. Position is one past the highest
 * position for that source (0 when the source has no keys yet).
 * `monthlyLimit` undefined means the 1,000 default; null means no limit.
 */
export const addSearchKey = (
  scope: InstanceScope,
  input: {
    source: SearchSource;
    label: string;
    apiKeyEnc: string;
    enabled?: boolean;
    monthlyLimit?: number | null;
    dailyLimit?: number | null;
    now: number;
  },
): string => {
  const keyId = newKeyId();
  writeInstance(scope, ({ db }) => {
    const highest = db
      .select({ position: assistantSearchKeys.position })
      .from(assistantSearchKeys)
      .where(eq(assistantSearchKeys.source, input.source))
      .orderBy(desc(assistantSearchKeys.position))
      .limit(1)
      .get();
    db.insert(assistantSearchKeys)
      .values({
        keyId,
        source: input.source,
        label: input.label,
        apiKeyEnc: input.apiKeyEnc,
        enabled: (input.enabled ?? true) ? 1 : 0,
        position: highest === undefined ? 0 : highest.position + 1,
        monthlyLimit: input.monthlyLimit === undefined ? DEFAULT_MONTHLY_LIMIT : input.monthlyLimit,
        dailyLimit: input.dailyLimit ?? null,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .run();
  });
  return keyId;
};

/**
 * Changes only the given fields and bumps `updatedAt`. A null limit clears
 * it. Returns false when the key does not exist.
 */
export const updateSearchKey = (
  scope: InstanceScope,
  keyId: string,
  input: {
    label?: string;
    apiKeyEnc?: string;
    enabled?: boolean;
    monthlyLimit?: number | null;
    dailyLimit?: number | null;
    now: number;
  },
): boolean =>
  writeInstance(scope, ({ db }) => {
    const result = db
      .update(assistantSearchKeys)
      .set({
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.apiKeyEnc === undefined ? {} : { apiKeyEnc: input.apiKeyEnc }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled ? 1 : 0 }),
        ...(input.monthlyLimit === undefined ? {} : { monthlyLimit: input.monthlyLimit }),
        ...(input.dailyLimit === undefined ? {} : { dailyLimit: input.dailyLimit }),
        updatedAt: input.now,
      })
      .where(eq(assistantSearchKeys.keyId, keyId))
      .run();
    return result.changes === 1;
  });

/**
 * Swaps position with the neighbour in the same source (by list order);
 * a no-op returning true at either end. Returns false when the key does
 * not exist. There is no unique index on position, so the swap is two
 * plain updates.
 */
export const moveSearchKey = (
  scope: InstanceScope,
  keyId: string,
  direction: 'up' | 'down',
  now: number,
): boolean =>
  writeInstance(scope, ({ db }) => {
    const current = db
      .select(keyColumns)
      .from(assistantSearchKeys)
      .where(eq(assistantSearchKeys.keyId, keyId))
      .get();
    if (current === undefined) return false;
    const siblings = db
      .select(keyColumns)
      .from(assistantSearchKeys)
      .where(eq(assistantSearchKeys.source, current.source))
      .orderBy(asc(assistantSearchKeys.position), asc(assistantSearchKeys.keyId))
      .all();
    const at = siblings.findIndex((row) => row.keyId === keyId);
    const neighbour = siblings[direction === 'up' ? at - 1 : at + 1];
    if (neighbour === undefined) return true;
    db.update(assistantSearchKeys)
      .set({ position: neighbour.position, updatedAt: now })
      .where(eq(assistantSearchKeys.keyId, keyId))
      .run();
    db.update(assistantSearchKeys)
      .set({ position: current.position, updatedAt: now })
      .where(eq(assistantSearchKeys.keyId, neighbour.keyId))
      .run();
    return true;
  });

/** Cascades its ledger rows. Returns false when the key does not exist. */
export const removeSearchKey = (scope: InstanceScope, keyId: string): boolean =>
  writeInstance(scope, ({ db }) => {
    const result = db.delete(assistantSearchKeys).where(eq(assistantSearchKeys.keyId, keyId)).run();
    return result.changes === 1;
  });

export type SearchReserveResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly limit: 'daily' | 'monthly' | 'missing';
      readonly availableAt: number;
    };

/** How many rows for `keyId` fall in the window starting at `windowStart`. */
const windowCount = (db: Db, keyId: string, windowStart: number): number =>
  db
    .select({ n: sql<number>`count(*)` })
    .from(assistantSearchCalls)
    .where(
      and(eq(assistantSearchCalls.keyId, keyId), sql`${assistantSearchCalls.at} > ${windowStart}`),
    )
    .get()?.n ?? 0;

/**
 * When a window holding `count` rows is at `limit`, the oldest row that
 * still counts frees its slot first — hence the `(count - limit)`-th
 * ascending timestamp plus the window length. One row, not the whole
 * window, so a large window never loads every timestamp into JS.
 */
const windowAvailableAt = (
  db: Db,
  keyId: string,
  windowStart: number,
  count: number,
  limit: number,
  windowMs: number,
): number => {
  const row = db
    .select({ at: assistantSearchCalls.at })
    .from(assistantSearchCalls)
    .where(
      and(eq(assistantSearchCalls.keyId, keyId), sql`${assistantSearchCalls.at} > ${windowStart}`),
    )
    .orderBy(asc(assistantSearchCalls.at))
    .limit(1)
    .offset(count - limit)
    .get();
  return row!.at + windowMs;
};

/**
 * One synchronous transaction: prune rows older than 32 days (all keys),
 * check daily then monthly, insert. A refused reservation inserts nothing.
 */
export const reserveSearchCall = (
  scope: InstanceScope,
  input: {
    keyId: string;
    guildId: string;
    now: number;
    monthlyLimit: number | null;
    dailyLimit: number | null;
  },
): SearchReserveResult =>
  writeInstance(scope, ({ db }) => {
    // 1. The key may have been deleted mid-request: skip it rather than
    // inserting a ledger row its foreign key would reject.
    const stored = db
      .select({ keyId: assistantSearchKeys.keyId })
      .from(assistantSearchKeys)
      .where(eq(assistantSearchKeys.keyId, input.keyId))
      .get();
    if (stored === undefined) {
      return { ok: false as const, limit: 'missing' as const, availableAt: input.now };
    }
    // 2. Prune rows older than 32 days.
    db.delete(assistantSearchCalls)
      .where(sql`${assistantSearchCalls.at} < ${input.now - PRUNE_AFTER_MS}`)
      .run();
    // 3. Sliding 24-hour window.
    if (input.dailyLimit !== null) {
      const dayCount = windowCount(db, input.keyId, input.now - DAY_MS);
      if (dayCount >= input.dailyLimit) {
        return {
          ok: false as const,
          limit: 'daily' as const,
          availableAt: windowAvailableAt(
            db,
            input.keyId,
            input.now - DAY_MS,
            dayCount,
            input.dailyLimit,
            DAY_MS,
          ),
        };
      }
    }
    // 4. Sliding 31-day window.
    if (input.monthlyLimit !== null) {
      const monthCount = windowCount(db, input.keyId, input.now - MONTH_WINDOW_MS);
      if (monthCount >= input.monthlyLimit) {
        return {
          ok: false as const,
          limit: 'monthly' as const,
          availableAt: windowAvailableAt(
            db,
            input.keyId,
            input.now - MONTH_WINDOW_MS,
            monthCount,
            input.monthlyLimit,
            MONTH_WINDOW_MS,
          ),
        };
      }
    }
    // 5. The reservation itself.
    db.insert(assistantSearchCalls)
      .values({ keyId: input.keyId, guildId: input.guildId, at: input.now })
      .run();
    return { ok: true as const };
  });

export interface SearchKeyUsage {
  readonly last24h: number;
  readonly last31d: number;
  readonly availableAt?: number;
}

/** `availableAt` only while a limit is reached (the later of the two when both are). */
export const searchKeyUsage = (
  scope: InstanceScope,
  input: {
    keyId: string;
    now: number;
    monthlyLimit: number | null;
    dailyLimit: number | null;
  },
): SearchKeyUsage =>
  readInstance(scope, (db) => {
    const dayCount = windowCount(db, input.keyId, input.now - DAY_MS);
    const monthCount = windowCount(db, input.keyId, input.now - MONTH_WINDOW_MS);
    const candidates: number[] = [];
    if (input.dailyLimit !== null && dayCount >= input.dailyLimit)
      candidates.push(
        windowAvailableAt(db, input.keyId, input.now - DAY_MS, dayCount, input.dailyLimit, DAY_MS),
      );
    if (input.monthlyLimit !== null && monthCount >= input.monthlyLimit)
      candidates.push(
        windowAvailableAt(
          db,
          input.keyId,
          input.now - MONTH_WINDOW_MS,
          monthCount,
          input.monthlyLimit,
          MONTH_WINDOW_MS,
        ),
      );
    return {
      last24h: dayCount,
      last31d: monthCount,
      ...(candidates.length === 0 ? {} : { availableAt: Math.max(...candidates) }),
    };
  });
