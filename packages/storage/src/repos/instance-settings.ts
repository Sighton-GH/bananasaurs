import { asc, eq } from 'drizzle-orm';
import { instanceSettings } from '../schema.js';
import type { InstanceScope } from '../scope.js';
import { readInstance, writeInstance } from '../write.js';

/**
 * Owner-edited instance settings (ADR 0080).
 *
 * Instance-level throughout: settings govern the one process, not a guild,
 * like the provider keys and model chain. The value is JSON typed by the
 * registry in `packages/core`, so this module stores it opaquely and never
 * parses it.
 */

export interface StoredSetting {
  readonly key: string;
  readonly valueJson: string;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

export const listSettings = (scope: InstanceScope): StoredSetting[] =>
  readInstance(scope, (db) =>
    db
      .select({
        key: instanceSettings.key,
        valueJson: instanceSettings.valueJson,
        updatedAt: instanceSettings.updatedAt,
        updatedBy: instanceSettings.updatedBy,
      })
      .from(instanceSettings)
      .orderBy(asc(instanceSettings.key))
      .all(),
  );

export const upsertSetting = (scope: InstanceScope, row: StoredSetting): void =>
  writeInstance(scope, ({ db }) => {
    db.insert(instanceSettings)
      .values(row)
      .onConflictDoUpdate({
        target: instanceSettings.key,
        set: { valueJson: row.valueJson, updatedAt: row.updatedAt, updatedBy: row.updatedBy },
      })
      .run();
  });

export const deleteSetting = (scope: InstanceScope, key: string): void =>
  writeInstance(scope, ({ db }) => {
    db.delete(instanceSettings).where(eq(instanceSettings.key, key)).run();
  });
