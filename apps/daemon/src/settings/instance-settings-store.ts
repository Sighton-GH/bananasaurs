import {
  INSTANCE_SETTINGS,
  isInstanceSettingKey,
  safeLogFields,
  settingDefinition,
  type InstanceSettingKey,
  type InstanceSettingValues,
  type Logger,
  type SettingDisplay,
  type SettingGroup,
} from '@bananasaurs/core';
import { instanceSettingsRepo, type InstanceScope } from '@bananasaurs/storage';
import type { z } from 'zod';

export interface InstanceSettingView {
  readonly key: InstanceSettingKey;
  readonly group: SettingGroup;
  readonly label: string;
  readonly help: string;
  readonly display: SettingDisplay;
  readonly bounds?: { min?: number; max?: number; maxItems?: number };
  readonly value: unknown;
  readonly defaultValue: unknown;
  readonly isDefault: boolean;
  readonly updatedAt?: number;
  readonly updatedBy?: string;
}

export type SetResult =
  | { readonly ok: true; readonly before: unknown; readonly after: unknown; readonly view: InstanceSettingView }
  | {
      readonly ok: false;
      readonly code: 'unknown-setting' | 'invalid-setting' | 'provider-secret-store-not-configured';
      readonly error?: z.ZodError;
    };

export interface InstanceSettingsStore {
  get<K extends InstanceSettingKey>(key: K): InstanceSettingValues[K];
  list(): readonly InstanceSettingView[];
  set(key: string, value: unknown, by: string, now: number): SetResult;
  reset(key: string, by: string, now: number): SetResult;
  onChange(listener: (key: InstanceSettingKey) => void): () => void;
}

export const createInstanceSettingsStore = (deps: {
  readonly instance: InstanceScope;
  readonly seal?: (plain: string) => string;
  readonly open?: (sealed: string) => string | undefined;
  readonly logger: Logger;
}): InstanceSettingsStore => {
  const { instance, seal, open, logger } = deps;
  const cache = new Map<string, instanceSettingsRepo.StoredSetting>();
  for (const row of instanceSettingsRepo.listSettings(instance)) cache.set(row.key, row);
  const warned = new Set<string>();
  const listeners = new Set<(key: InstanceSettingKey) => void>();

  const warnOnce = (key: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(
      safeLogFields({ component: 'config', settingKey: key }),
      'stored setting is invalid; using the default',
    );
  };

  /** The plaintext effective value, before the secret-view masking. */
  const effective = (key: InstanceSettingKey): unknown => {
    const def = settingDefinition(key);
    if (def === undefined) return undefined;
    const row = cache.get(key);
    if (row === undefined) return def.defaultValue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.valueJson) as unknown;
    } catch {
      warnOnce(key);
      return def.defaultValue;
    }
    if (def.secret === true) {
      if (typeof parsed !== 'string') {
        warnOnce(key);
        return null;
      }
      // A sealed value that does not open (a rotated secret, a hand-edited
      // row) is not logged: it would warn on every read until fixed, and the
      // value itself must never reach a log line to say more.
      return open?.(parsed) ?? null;
    }
    const checked = def.schema.safeParse(parsed);
    if (!checked.success) {
      warnOnce(key);
      return def.defaultValue;
    }
    return checked.data;
  };

  const viewOf = (key: InstanceSettingKey): InstanceSettingView => {
    const def = settingDefinition(key);
    if (def === undefined) throw new Error(`unknown setting: ${key}`);
    const row = cache.get(key);
    const value = effective(key);
    const isDefault = row === undefined || value === def.defaultValue;
    const secret = def.secret === true;
    return {
      key,
      group: def.group,
      label: def.label,
      help: def.help,
      display: def.display,
      ...(def.bounds === undefined ? {} : { bounds: def.bounds }),
      value: secret ? { configured: value !== null } : value,
      defaultValue: secret ? { configured: false } : def.defaultValue,
      isDefault,
      ...(row === undefined ? {} : { updatedAt: row.updatedAt, updatedBy: row.updatedBy }),
    };
  };

  const notify = (key: InstanceSettingKey): void => {
    for (const listener of listeners) listener(key);
  };

  return {
    get(key) {
      return effective(key) as InstanceSettingValues[typeof key];
    },
    list() {
      return INSTANCE_SETTINGS.map((def) => viewOf(def.key as InstanceSettingKey));
    },
    set(key, value, by, now) {
      if (!isInstanceSettingKey(key)) return { ok: false, code: 'unknown-setting' };
      const def = settingDefinition(key);
      if (def === undefined) return { ok: false, code: 'unknown-setting' };
      const checked = def.schema.safeParse(value);
      if (!checked.success) return { ok: false, code: 'invalid-setting', error: checked.error };
      const before = viewOf(key).value;
      if (def.secret === true) {
        if (checked.data === null) {
          instanceSettingsRepo.deleteSetting(instance, key);
          cache.delete(key);
        } else {
          if (seal === undefined)
            return { ok: false, code: 'provider-secret-store-not-configured' };
          const sealed = seal(checked.data as string);
          const row = { key, valueJson: JSON.stringify(sealed), updatedAt: now, updatedBy: by };
          instanceSettingsRepo.upsertSetting(instance, row);
          cache.set(key, row);
        }
      } else {
        const row = { key, valueJson: JSON.stringify(value), updatedAt: now, updatedBy: by };
        instanceSettingsRepo.upsertSetting(instance, row);
        cache.set(key, row);
      }
      const view = viewOf(key);
      notify(key);
      return { ok: true, before, after: view.value, view };
    },
    reset(key, _by, _now) {
      if (!isInstanceSettingKey(key)) return { ok: false, code: 'unknown-setting' };
      if (settingDefinition(key) === undefined)
        return { ok: false, code: 'unknown-setting' };
      const before = viewOf(key).value;
      instanceSettingsRepo.deleteSetting(instance, key);
      cache.delete(key);
      const view = viewOf(key);
      notify(key);
      return { ok: true, before, after: view.value, view };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
