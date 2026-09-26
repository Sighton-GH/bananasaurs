import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { instanceSettingsRepo } from '@bananasaurs/storage';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';
import { createInstanceSettingsStore } from './instance-settings-store.js';

let t: MigratedTestDatabase;
const warns: { fields: unknown; message: string }[] = [];
const logger = {
  info() {},
  warn(fields: unknown, message: string) {
    warns.push({ fields, message });
  },
  error() {},
  debug() {},
  fatal() {},
  trace() {},
} as never;

beforeEach(() => {
  t = openMigratedTestDatabase();
  warns.length = 0;
});
afterEach(() => {
  t.close();
});

describe('instance settings store', () => {
  it('returns the default with no row', () => {
    const store = createInstanceSettingsStore({ instance: t.scopes.instance(), logger });
    expect(store.get('assistant.maxToolRounds')).toBe(4);
    expect(store.list().find((s) => s.key === 'assistant.maxToolRounds')).toMatchObject({
      isDefault: true,
      value: 4,
    });
  });

  it('set then get returns the value and list shows updatedBy', () => {
    const store = createInstanceSettingsStore({ instance: t.scopes.instance(), logger });
    const result = store.set('assistant.maxToolRounds', 6, 'owner-acct', 1234);
    expect(result.ok).toBe(true);
    expect(store.get('assistant.maxToolRounds')).toBe(6);
    expect(store.list().find((s) => s.key === 'assistant.maxToolRounds')).toMatchObject({
      isDefault: false,
      value: 6,
      updatedBy: 'owner-acct',
    });
  });

  it('rejects an invalid value and leaves the old one', () => {
    const store = createInstanceSettingsStore({ instance: t.scopes.instance(), logger });
    store.set('assistant.maxToolRounds', 6, 'owner-acct', 1);
    const bad = store.set('assistant.maxToolRounds', 99, 'owner-acct', 2);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('invalid-setting');
    expect(store.get('assistant.maxToolRounds')).toBe(6);
  });

  it('falls back to the default on an invalid stored row and warns once', () => {
    const store = createInstanceSettingsStore({ instance: t.scopes.instance(), logger });
    instanceSettingsRepo.upsertSetting(t.scopes.instance(), {
      key: 'assistant.maxToolRounds',
      valueJson: '"oops"',
      updatedAt: 1,
      updatedBy: 'owner-acct',
    });
    // The store cached at creation; rebuild so it reads the bad row.
    const reread = createInstanceSettingsStore({ instance: t.scopes.instance(), logger });
    expect(reread.get('assistant.maxToolRounds')).toBe(4);
    expect(reread.get('assistant.maxToolRounds')).toBe(4);
    expect(warns).toHaveLength(1);
  });

  it('seals the secret and never shows it in views', () => {
    const sealed = new Map<string, string>();
    const store = createInstanceSettingsStore({
      instance: t.scopes.instance(),
      seal: (s) => {
        const v = `sealed:${String(sealed.size)}`;
        sealed.set(v, s);
        return v;
      },
      open: (s) => sealed.get(s),
      logger,
    });
    const result = store.set('resources.fetchHeaderValue', 'plain-SECRET-1', 'owner-acct', 5);
    expect(result.ok).toBe(true);
    const rows = instanceSettingsRepo.listSettings(t.scopes.instance());
    expect(rows.find((r) => r.key === 'resources.fetchHeaderValue')?.valueJson).toContain(
      'sealed:',
    );
    expect(rows.find((r) => r.key === 'resources.fetchHeaderValue')?.valueJson).not.toContain(
      'plain-SECRET-1',
    );
    expect(store.get('resources.fetchHeaderValue')).toBe('plain-SECRET-1');
    expect(
      store.list().find((s) => s.key === 'resources.fetchHeaderValue')?.value,
    ).toEqual({ configured: true });
    expect(JSON.stringify(store.list())).not.toContain('plain-SECRET-1');
  });

  it('refuses a secret write without a sealer', () => {
    const store = createInstanceSettingsStore({ instance: t.scopes.instance(), logger });
    const result = store.set('resources.fetchHeaderValue', 'whatever', 'owner-acct', 5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('provider-secret-store-not-configured');
  });

  it('reset returns to the default and onChange fires', () => {
    const store = createInstanceSettingsStore({ instance: t.scopes.instance(), logger });
    const seen: string[] = [];
    const stop = store.onChange((key) => seen.push(key));
    store.set('assistant.maxToolCalls', 20, 'owner-acct', 1);
    const reset = store.reset('assistant.maxToolCalls', 'owner-acct', 2);
    expect(reset.ok).toBe(true);
    expect(store.get('assistant.maxToolCalls')).toBe(12);
    expect(seen).toEqual(['assistant.maxToolCalls', 'assistant.maxToolCalls']);
    stop();
  });

  it('answers unknown-setting for an unknown key', () => {
    const store = createInstanceSettingsStore({ instance: t.scopes.instance(), logger });
    expect(store.set('nope', 1, 'owner-acct', 1)).toMatchObject({
      ok: false,
      code: 'unknown-setting',
    });
    expect(store.reset('nope', 'owner-acct', 1)).toMatchObject({
      ok: false,
      code: 'unknown-setting',
    });
  });
});
