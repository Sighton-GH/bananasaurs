import { assistantProviderConfig } from '../schema.js';
import type { InstanceScope } from '../scope.js';
import { readInstance, writeInstance } from '../write.js';

export interface AssistantProviderConfigRow {
  readonly provider: 'off' | 'gemini' | 'openrouter' | 'nvidia-nim';
  readonly model?: string;
  readonly apiKeyEnc?: string;
  readonly enabled: boolean;
  readonly updatedAt: number;
}
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
        updatedAt: input.updatedAt,
      })
      .onConflictDoUpdate({
        target: assistantProviderConfig.configId,
        set: {
          provider: input.provider,
          model: input.model ?? null,
          apiKeyEnc: input.apiKeyEnc ?? null,
          enabled: input.enabled ? 1 : 0,
          updatedAt: input.updatedAt,
        },
      })
      .run();
  });
