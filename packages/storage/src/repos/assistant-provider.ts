import { assistantProviderConfig } from '../schema.js';
import type { InstanceScope } from '../scope.js';
import { readInstance, writeInstance } from '../write.js';

export interface AssistantProviderConfigRow {
  readonly provider: 'off' | 'gemini' | 'openrouter' | 'nvidia-nim';
  readonly model?: string;
  readonly apiKeyEnc?: string;
  readonly enabled: boolean;
  readonly costClass: 'free' | 'paid' | 'unknown';
  /** ADR 0068: up to two more models, tried in order. */
  readonly fallbackModels?: readonly string[];
  /** ADR 0066: the sealed Brave Search API key. */
  readonly searchApiKeyEnc?: string;
  readonly searchEnabled?: boolean;
  /** ADR 0120 / 0147: Brave, Tavily or Parallel answers; anything unrecognised reads as `'brave'`. */
  readonly searchSource?: 'brave' | 'tavily' | 'parallel';
  readonly updatedAt: number;
}
/** Own prior write, still validated: a malformed list reads as no backups. */
const fallbackModelsOf = (raw: string): { fallbackModels?: readonly string[] } => {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return {};
    const models = value.filter((m): m is string => typeof m === 'string' && m !== '');
    return models.length === 0 ? {} : { fallbackModels: models };
  } catch {
    return {};
  }
};
export const get = (scope: InstanceScope): AssistantProviderConfigRow | undefined =>
  readInstance(scope, (db) => {
    const row = db.select().from(assistantProviderConfig).get();
    return row === undefined
      ? undefined
      : {
          provider: row.provider as AssistantProviderConfigRow['provider'],
          ...(row.model === null ? {} : { model: row.model }),
          ...(row.apiKeyEnc === null ? {} : { apiKeyEnc: row.apiKeyEnc }),
          enabled: row.enabled === 1,
          costClass: row.costClass as AssistantProviderConfigRow['costClass'],
          ...fallbackModelsOf(row.fallbackModelsJson),
          ...(row.searchApiKeyEnc === null ? {} : { searchApiKeyEnc: row.searchApiKeyEnc }),
          searchEnabled: row.searchEnabled === 1,
          searchSource:
            row.searchSource === 'tavily'
              ? 'tavily'
              : row.searchSource === 'parallel'
                ? 'parallel'
                : 'brave',
          updatedAt: row.updatedAt,
        };
  });
export const put = (scope: InstanceScope, input: AssistantProviderConfigRow): void =>
  writeInstance(scope, ({ db }) => {
    db.insert(assistantProviderConfig)
      .values({
        configId: 'active',
        provider: input.provider,
        model: input.model ?? null,
        apiKeyEnc: input.apiKeyEnc ?? null,
        enabled: input.enabled ? 1 : 0,
        costClass: input.costClass,
        fallbackModelsJson: JSON.stringify(input.fallbackModels ?? []),
        searchApiKeyEnc: input.searchApiKeyEnc ?? null,
        searchEnabled: input.searchEnabled === true ? 1 : 0,
        searchSource: input.searchSource ?? 'brave',
        updatedAt: input.updatedAt,
      })
      .onConflictDoUpdate({
        target: assistantProviderConfig.configId,
        set: {
          provider: input.provider,
          model: input.model ?? null,
          apiKeyEnc: input.apiKeyEnc ?? null,
          enabled: input.enabled ? 1 : 0,
          costClass: input.costClass,
          fallbackModelsJson: JSON.stringify(input.fallbackModels ?? []),
          searchApiKeyEnc: input.searchApiKeyEnc ?? null,
          searchEnabled: input.searchEnabled === true ? 1 : 0,
          searchSource: input.searchSource ?? 'brave',
          updatedAt: input.updatedAt,
        },
      })
      .run();
  });
