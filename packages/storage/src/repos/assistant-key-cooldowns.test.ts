import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db.js';
import { createScopeFactory } from '../scope.js';
import * as schema from '../schema.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addKey, removeKey } from './assistant-providers.js';
import {
  clearCooldowns,
  getCooldown,
  listCooldowns,
  setCooldown,
} from './assistant-key-cooldowns.js';
import {
  openMigratedTestDatabase,
  MIGRATIONS_FOLDER,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';

const NOW = 1_790_000_000_000;
const MODEL = 'gemini-3.8-flash';
let t: MigratedTestDatabase;
beforeEach(() => {
  t = openMigratedTestDatabase();
});
afterEach(() => t.close());

describe('assistant key cooldowns (ADR 0143)', () => {
  it('round-trips a cooldown with its learned limits', () => {
    const scope = t.scopes.instance();
    const keyId = addKey(scope, {
      provider: 'gemini',
      label: 'Gemini 1',
      apiKeyEnc: 'sealed-a',
      costClass: 'free',
      now: NOW,
    });
    setCooldown(scope, {
      keyId,
      model: MODEL,
      until: NOW + 3_600_000,
      reason: 'daily-quota',
      setAt: NOW,
      learnedPerDay: 20,
    });
    expect(getCooldown(scope, keyId, MODEL, NOW)).toMatchObject({
      keyId,
      model: MODEL,
      until: NOW + 3_600_000,
      reason: 'daily-quota',
      learnedPerDay: 20,
    });
    expect(listCooldowns(scope)).toHaveLength(1);
  });
  it('expires when now reaches until and rewrites on a second set', () => {
    const scope = t.scopes.instance();
    const keyId = addKey(scope, {
      provider: 'gemini',
      label: 'Gemini 1',
      apiKeyEnc: 'sealed-a',
      costClass: 'free',
      now: NOW,
    });
    setCooldown(scope, {
      keyId,
      model: MODEL,
      until: NOW + 60_000,
      reason: 'minute-quota',
      setAt: NOW,
    });
    expect(getCooldown(scope, keyId, MODEL, NOW + 60_000)).toBeUndefined();
    setCooldown(scope, {
      keyId,
      model: MODEL,
      until: NOW + 120_000,
      reason: 'minute-quota',
      setAt: NOW,
    });
    expect(getCooldown(scope, keyId, MODEL, NOW + 61_000)?.until).toBe(NOW + 120_000);
  });
  it('clears by key or by key and model, and cascades on key deletion', () => {
    const scope = t.scopes.instance();
    const keyId = addKey(scope, {
      provider: 'gemini',
      label: 'Gemini 1',
      apiKeyEnc: 'sealed-a',
      costClass: 'free',
      now: NOW,
    });
    setCooldown(scope, {
      keyId,
      model: MODEL,
      until: NOW + 1_000,
      reason: 'minute-quota',
      setAt: NOW,
    });
    setCooldown(scope, {
      keyId,
      model: 'gemini-3.6-flash',
      until: NOW + 1_000,
      reason: 'minute-quota',
      setAt: NOW,
    });
    clearCooldowns(scope, keyId, MODEL);
    expect(getCooldown(scope, keyId, MODEL, NOW)).toBeUndefined();
    expect(getCooldown(scope, keyId, 'gemini-3.6-flash', NOW)).toBeDefined();
    clearCooldowns(scope, keyId);
    expect(listCooldowns(scope)).toEqual([]);
    setCooldown(scope, {
      keyId,
      model: MODEL,
      until: NOW + 1_000,
      reason: 'minute-quota',
      setAt: NOW,
    });
    removeKey(scope, keyId);
    expect(listCooldowns(scope)).toEqual([]);
  });
});

describe('cooldown durability and write guards', () => {
  it('keeps cooldowns and learned limits after closing and reopening SQLite', () => {
    const folder = mkdtempSync(join(tmpdir(), 'key-cooldown-restart-'));
    const dbPath = join(folder, 'test.db');
    let raw = new Database(dbPath);
    try {
      raw.pragma('foreign_keys = ON');
      let db = drizzle(raw, { schema });
      runMigrations(raw, db, MIGRATIONS_FOLDER);
      const scope = createScopeFactory(db, { readonly: false }).instance();
      const keyId = addKey(scope, {
        provider: 'gemini',
        label: 'Gemini 1',
        apiKeyEnc: 'sealed-a',
        now: NOW,
      });
      const input = {
        keyId,
        model: MODEL,
        until: NOW + 60_000,
        reason: 'minute-quota',
        setAt: NOW,
        learnedPerDay: 20,
        learnedPerMinute: 5,
      };
      setCooldown(scope, input);
      raw.close();
      raw = new Database(dbPath);
      raw.pragma('foreign_keys = ON');
      db = drizzle(raw, { schema });
      runMigrations(raw, db, MIGRATIONS_FOLDER);
      const restarted = createScopeFactory(db, { readonly: false }).instance();
      expect(getCooldown(restarted, keyId, MODEL, NOW + 1)).toEqual(input);
      expect(getCooldown(restarted, keyId, MODEL, NOW + 60_000)).toBeUndefined();
    } finally {
      if (raw.open) raw.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it('isolates keys/models, refuses dangling keys and honours readonly scopes', () => {
    const scope = t.scopes.instance();
    const keyId = addKey(scope, {
      provider: 'gemini',
      label: 'Gemini 1',
      apiKeyEnc: 'sealed-a',
      now: NOW,
    });
    const input = { keyId, model: MODEL, until: NOW + 60_000, reason: 'minute-quota', setAt: NOW };
    setCooldown(scope, input);
    expect(getCooldown(scope, 'key_other', MODEL, NOW)).toBeUndefined();
    expect(getCooldown(scope, keyId, 'other-model', NOW)).toBeUndefined();
    expect(() => setCooldown(scope, { ...input, keyId: 'key_missing' })).toThrow();
    expect(() => setCooldown(t.readonlyScopes.instance(), input)).toThrow('BANANASAURS_READONLY');
    expect(() => clearCooldowns(t.readonlyScopes.instance(), keyId)).toThrow(
      'BANANASAURS_READONLY',
    );
    expect(listCooldowns(t.readonlyScopes.instance())).toEqual([input]);
  });
});
