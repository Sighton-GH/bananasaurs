import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedTestDatabase, type MigratedTestDatabase } from '../test-support.js';
import type { InstanceScope } from '../scope.js';
import { deleteSetting, listSettings, upsertSetting } from './instance-settings.js';

let t: MigratedTestDatabase;
let scope: InstanceScope;

beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.instance();
});

afterEach(() => t.close());

describe('instance settings', () => {
  it('upserts then lists a setting back', () => {
    upsertSetting(scope, {
      key: 'assistant.retry_delays',
      valueJson: '[10000,30000]',
      updatedAt: 1000,
      updatedBy: 'owner',
    });
    expect(listSettings(scope)).toEqual([
      {
        key: 'assistant.retry_delays',
        valueJson: '[10000,30000]',
        updatedAt: 1000,
        updatedBy: 'owner',
      },
    ]);
  });

  it('upsert of the same key overwrites the prior row', () => {
    upsertSetting(scope, { key: 'k', valueJson: '1', updatedAt: 1, updatedBy: 'a' });
    upsertSetting(scope, { key: 'k', valueJson: '2', updatedAt: 2, updatedBy: 'b' });
    expect(listSettings(scope)).toEqual([{ key: 'k', valueJson: '2', updatedAt: 2, updatedBy: 'b' }]);
  });

  it('delete removes the key and is a no-op for an unknown key', () => {
    upsertSetting(scope, { key: 'k', valueJson: '1', updatedAt: 1, updatedBy: 'a' });
    deleteSetting(scope, 'missing');
    expect(listSettings(scope)).toHaveLength(1);
    deleteSetting(scope, 'k');
    expect(listSettings(scope)).toEqual([]);
  });

  it('refuses a key longer than 64 characters', () => {
    expect(() =>
      upsertSetting(scope, { key: `k${'x'.repeat(64)}`, valueJson: '1', updatedAt: 1, updatedBy: 'a' }),
    ).toThrow();
    expect(listSettings(scope)).toEqual([]);
  });
});
