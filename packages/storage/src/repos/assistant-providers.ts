import { createHash, randomBytes } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { assistantModelChain, assistantProviderConfig, assistantProviderKeys } from '../schema.js';
import type { InstanceScope } from '../scope.js';
import { readInstance, writeInstance } from '../write.js';

/**
 * Several sealed keys per provider, and one ordered model chain of key +
 * model (Task 6b, ADR 0075 follow-up, owner request 2026-09-24).
 *
 * Instance-level throughout: keys are a fact about the daemon, not a guild.
 * Terms eligibility stays per *provider*, not per key (hard rule 5) — see
 * `eligibility-repo.ts`. The old single-provider row (`assistant-provider.ts`)
 * is no longer read for provider/model/key after the 0037/0038/0039 data
 * copies, but its web-search columns stay in use there — and the GitHub token
 * lives on that same row, reached through this module.
 */

export type ProviderId = 'gemini' | 'openrouter' | 'nvidia-nim';
export type ProviderCostClass = 'free' | 'paid' | 'unknown';

export interface StoredKey {
  readonly keyId: string;
  readonly provider: ProviderId;
  readonly label: string;
  readonly apiKeyEnc: string;
  readonly costClass: ProviderCostClass;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly project: string | null;
  readonly fingerprint: string | null;
}

export interface ChainRow {
  readonly position: number;
  readonly keyId: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly rpmLimit: number | null;
  readonly rpdLimit: number | null;
  readonly pool: 'key' | 'provider';
  readonly tier: 'standard' | 'light';
}

const asProviderId = (value: string): ProviderId => {
  if (value !== 'gemini' && value !== 'openrouter' && value !== 'nvidia-nim')
    throw new Error(`unexpected provider ${JSON.stringify(value)}`);
  return value;
};

const asCostClass = (value: string): ProviderCostClass => {
  if (value !== 'free' && value !== 'paid' && value !== 'unknown')
    throw new Error(`unexpected cost class ${JSON.stringify(value)}`);
  return value;
};

const asPool = (value: string): ChainRow['pool'] => {
  if (value !== 'key' && value !== 'provider')
    throw new Error(`unexpected pool ${JSON.stringify(value)}`);
  return value;
};

const asTier = (value: string): ChainRow['tier'] => {
  if (value !== 'standard' && value !== 'light')
    throw new Error(`unexpected tier ${JSON.stringify(value)}`);
  return value;
};

const assertProject = (project: string | null | undefined): void => {
  if (project !== undefined && project !== null && (project.length < 1 || project.length > 80))
    throw new Error('project label must be between 1 and 80 characters');
};

const toKey = (row: {
  keyId: string;
  provider: string;
  label: string;
  apiKeyEnc: string;
  costClass: string;
  enabled: number;
  createdAt: number;
  updatedAt: number;
  project: string | null;
  fingerprint: string | null;
}): StoredKey => ({
  keyId: row.keyId,
  provider: asProviderId(row.provider),
  label: row.label,
  apiKeyEnc: row.apiKeyEnc,
  costClass: asCostClass(row.costClass),
  enabled: row.enabled === 1,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  project: row.project,
  fingerprint: row.fingerprint,
});

export const listKeys = (scope: InstanceScope): StoredKey[] =>
  readInstance(scope, (db) =>
    db
      .select({
        keyId: assistantProviderKeys.keyId,
        provider: assistantProviderKeys.provider,
        label: assistantProviderKeys.label,
        apiKeyEnc: assistantProviderKeys.apiKeyEnc,
        costClass: assistantProviderKeys.costClass,
        enabled: assistantProviderKeys.enabled,
        createdAt: assistantProviderKeys.createdAt,
        updatedAt: assistantProviderKeys.updatedAt,
        project: assistantProviderKeys.project,
        fingerprint: assistantProviderKeys.fingerprint,
      })
      .from(assistantProviderKeys)
      .orderBy(asc(assistantProviderKeys.keyId))
      .all()
      .map(toKey),
  );

/** `key_` + 16 hex characters, matching the design's key id shape. */
const newKeyId = (): string => `key_${randomBytes(8).toString('hex')}`;

/**
 * Adds a new key and returns its id. `keyId` is normally omitted, and one is
 * generated (`key_` + 16 hex); the legacy single-provider save route
 * (Task 6b fix round 1) passes an explicit `key_<provider>` id so it can find
 * the same key again on the next save, matching the id the 0039 migration
 * gave a provider's key.
 */
export const addKey = (
  scope: InstanceScope,
  input: {
    provider: ProviderId;
    label: string;
    apiKeyEnc: string;
    costClass?: ProviderCostClass;
    enabled?: boolean;
    now: number;
    keyId?: string;
    project?: string | null;
    fingerprint?: string | null;
  },
): string => {
  assertProject(input.project);
  const keyId = input.keyId ?? newKeyId();
  writeInstance(scope, ({ db }) => {
    if (input.fingerprint !== undefined && input.fingerprint !== null) {
      const existing = db
        .select({ keyId: assistantProviderKeys.keyId })
        .from(assistantProviderKeys)
        .where(eq(assistantProviderKeys.fingerprint, input.fingerprint))
        .get();
      if (existing !== undefined) throw new Error('duplicate key fingerprint');
    }
    db.insert(assistantProviderKeys)
      .values({
        keyId,
        provider: input.provider,
        label: input.label,
        apiKeyEnc: input.apiKeyEnc,
        costClass: input.costClass ?? 'unknown',
        enabled: (input.enabled ?? true) ? 1 : 0,
        createdAt: input.now,
        updatedAt: input.now,
        project: input.project ?? null,
        fingerprint: input.fingerprint ?? null,
      })
      .run();
  });
  return keyId;
};

export const updateKey = (
  scope: InstanceScope,
  keyId: string,
  input: {
    label?: string;
    project?: string | null;
    apiKeyEnc?: string;
    costClass?: ProviderCostClass;
    enabled?: boolean;
    now: number;
  },
): void =>
  writeInstance(scope, ({ db }) => {
    assertProject(input.project);
    db.update(assistantProviderKeys)
      .set({
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.apiKeyEnc === undefined ? {} : { apiKeyEnc: input.apiKeyEnc, fingerprint: null }),
        ...(input.project === undefined ? {} : { project: input.project }),
        ...(input.costClass === undefined ? {} : { costClass: input.costClass }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled ? 1 : 0 }),
        updatedAt: input.now,
      })
      .where(eq(assistantProviderKeys.keyId, keyId))
      .run();
  });

/** Removing a key drops its chain rows through the foreign-key cascade. */
export const removeKey = (scope: InstanceScope, keyId: string): void =>
  writeInstance(scope, ({ db }) => {
    db.delete(assistantProviderKeys).where(eq(assistantProviderKeys.keyId, keyId)).run();
  });

export const getModelChain = (scope: InstanceScope): ChainRow[] =>
  readInstance(scope, (db) =>
    db
      .select({
        position: assistantModelChain.position,
        keyId: assistantModelChain.keyId,
        model: assistantModelChain.model,
        rpmLimit: assistantModelChain.rpmLimit,
        rpdLimit: assistantModelChain.rpdLimit,
        pool: assistantModelChain.pool,
        tier: assistantModelChain.tier,
        provider: assistantProviderKeys.provider,
      })
      .from(assistantModelChain)
      .innerJoin(assistantProviderKeys, eq(assistantModelChain.keyId, assistantProviderKeys.keyId))
      .orderBy(asc(assistantModelChain.position))
      .all()
      .map((row) => ({
        position: row.position,
        keyId: row.keyId,
        provider: asProviderId(row.provider),
        model: row.model,
        rpmLimit: row.rpmLimit,
        rpdLimit: row.rpdLimit,
        pool: asPool(row.pool),
        tier: asTier(row.tier),
      })),
  );

/**
 * Replaces the whole chain; positions are dense from 0 in the given order.
 * At most six entries; a repeated (keyId, model) pair in the same call is
 * refused up front rather than left to the unique constraint, so the error
 * names the actual problem.
 */
export const setModelChain = (
  scope: InstanceScope,
  rows: readonly {
    keyId: string;
    model: string;
    rpmLimit?: number | null;
    rpdLimit?: number | null;
    pool?: ChainRow['pool'];
    tier?: ChainRow['tier'];
  }[],
  now: number,
): void => {
  if (rows.length > 6) throw new Error('the model chain holds at most six entries');
  const seen = new Set<string>();
  for (const row of rows) {
    asPool(row.pool ?? 'key');
    asTier(row.tier ?? 'standard');
    const pairKey = `${row.keyId}\u0000${row.model}`;
    if (seen.has(pairKey))
      throw new Error(
        `duplicate (keyId, model) pair in the model chain: ${row.keyId}, ${row.model}`,
      );
    seen.add(pairKey);
  }
  writeInstance(scope, ({ db }) => {
    db.delete(assistantModelChain).run();
    for (const [position, row] of rows.entries()) {
      // An entry naming a key with no row fails here on the foreign key, not
      // later at request time.
      db.insert(assistantModelChain)
        .values({
          position,
          keyId: row.keyId,
          model: row.model,
          rpmLimit: row.rpmLimit ?? null,
          rpdLimit: row.rpdLimit ?? null,
          pool: row.pool ?? 'key',
          tier: row.tier ?? 'standard',
          updatedAt: now,
        })
        .run();
    }
  });
};

/** The sealed GitHub token, or null while none is saved. */
export const getGithubTokenEnc = (scope: InstanceScope): string | null =>
  readInstance(scope, (db) => {
    const row = db
      .select({ githubTokenEnc: assistantProviderConfig.githubTokenEnc })
      .from(assistantProviderConfig)
      .get();
    return row?.githubTokenEnc ?? null;
  });

export const setGithubTokenEnc = (scope: InstanceScope, value: string | null): void =>
  writeInstance(scope, ({ db }) => {
    const updatedAt = Date.now();
    db.insert(assistantProviderConfig)
      .values({ configId: 'active', githubTokenEnc: value, updatedAt })
      .onConflictDoUpdate({
        target: assistantProviderConfig.configId,
        set: { githubTokenEnc: value, updatedAt },
      })
      .run();
  });

/** ADR 0143: SHA-256 hex of a secret, for bulk-paste dedupe. The secret itself never reaches storage. */
export const fingerprintOf = (secret: string): string =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

/** ADR 0143: the ledger bucket a key draws from — shared per project label, private otherwise. */
export const bucketOf = (key: {
  readonly keyId: string;
  readonly project: string | null;
}): string => (key.project === null ? `key:${key.keyId}` : `project:${key.project}`);
