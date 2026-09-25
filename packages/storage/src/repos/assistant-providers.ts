import { asc, eq } from 'drizzle-orm';
import { assistantModelChain, assistantProviderConfig, assistantProviders } from '../schema.js';
import type { InstanceScope } from '../scope.js';
import { readInstance, writeInstance } from '../write.js';

/**
 * Several providers and one ordered model chain (ADR 0075).
 *
 * Instance-level throughout: providers are a fact about the daemon, not a
 * guild. The old single-provider row (`assistant-provider.ts`) is no longer
 * read for provider/model/key after the 0037 data copy, but its web-search
 * columns stay in use there — and the GitHub token lives on that same row,
 * reached through this module.
 */

export type ProviderId = 'gemini' | 'openrouter' | 'nvidia-nim';
export type ProviderCostClass = 'free' | 'paid' | 'unknown';

export interface StoredProvider {
  readonly provider: ProviderId;
  readonly apiKeyEnc: string | null;
  readonly costClass: ProviderCostClass;
  readonly enabled: boolean;
  readonly updatedAt: number;
}

export interface ChainRow {
  readonly position: number;
  readonly provider: ProviderId;
  readonly model: string;
}

const toProvider = (row: {
  provider: string;
  apiKeyEnc: string | null;
  costClass: string;
  enabled: number;
  updatedAt: number;
}): StoredProvider => {
  if (row.provider !== 'gemini' && row.provider !== 'openrouter' && row.provider !== 'nvidia-nim')
    throw new Error(
      `assistant_providers holds unexpected provider ${JSON.stringify(row.provider)}`,
    );
  if (row.costClass !== 'free' && row.costClass !== 'paid' && row.costClass !== 'unknown')
    throw new Error(
      `assistant_providers ${row.provider}: unexpected cost class ${JSON.stringify(row.costClass)}`,
    );
  return {
    provider: row.provider,
    apiKeyEnc: row.apiKeyEnc,
    costClass: row.costClass,
    enabled: row.enabled === 1,
    updatedAt: row.updatedAt,
  };
};

export const listProviders = (scope: InstanceScope): StoredProvider[] =>
  readInstance(scope, (db) =>
    db
      .select({
        provider: assistantProviders.provider,
        apiKeyEnc: assistantProviders.apiKeyEnc,
        costClass: assistantProviders.costClass,
        enabled: assistantProviders.enabled,
        updatedAt: assistantProviders.updatedAt,
      })
      .from(assistantProviders)
      .orderBy(asc(assistantProviders.provider))
      .all()
      .map(toProvider),
  );

export const upsertProvider = (
  scope: InstanceScope,
  p: {
    provider: ProviderId;
    apiKeyEnc?: string | null;
    costClass?: ProviderCostClass;
    enabled?: boolean;
    now: number;
  },
): void =>
  writeInstance(scope, ({ db }) => {
    const values = {
      provider: p.provider,
      apiKeyEnc: p.apiKeyEnc ?? null,
      costClass: p.costClass ?? 'unknown',
      enabled: p.enabled === true ? 1 : 0,
      updatedAt: p.now,
    };
    db.insert(assistantProviders)
      .values(values)
      .onConflictDoUpdate({
        target: assistantProviders.provider,
        set: {
          apiKeyEnc: values.apiKeyEnc,
          costClass: values.costClass,
          enabled: values.enabled,
          updatedAt: values.updatedAt,
        },
      })
      .run();
  });

/** Removing a provider drops its chain rows through the foreign-key cascade. */
export const removeProvider = (scope: InstanceScope, provider: ProviderId): void =>
  writeInstance(scope, ({ db }) => {
    db.delete(assistantProviders).where(eq(assistantProviders.provider, provider)).run();
  });

export const getModelChain = (scope: InstanceScope): ChainRow[] =>
  readInstance(scope, (db) =>
    db
      .select({
        position: assistantModelChain.position,
        provider: assistantModelChain.provider,
        model: assistantModelChain.model,
      })
      .from(assistantModelChain)
      .orderBy(asc(assistantModelChain.position))
      .all()
      .map((row) => {
        if (
          row.provider !== 'gemini' &&
          row.provider !== 'openrouter' &&
          row.provider !== 'nvidia-nim'
        )
          throw new Error(
            `assistant_model_chain holds unexpected provider ${JSON.stringify(row.provider)}`,
          );
        return { position: row.position, provider: row.provider, model: row.model };
      }),
  );

/** Replaces the whole chain; positions are dense from 0 in the given order. */
export const setModelChain = (
  scope: InstanceScope,
  rows: readonly { provider: ProviderId; model: string }[],
  now: number,
): void => {
  if (rows.length > 6) throw new Error('the model chain holds at most six entries');
  writeInstance(scope, ({ db }) => {
    db.delete(assistantModelChain).run();
    for (const [position, row] of rows.entries()) {
      // A chain entry naming a provider with no key row fails here on the
      // foreign key, not later at request time.
      db.insert(assistantModelChain)
        .values({ position, provider: row.provider, model: row.model, updatedAt: now })
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
