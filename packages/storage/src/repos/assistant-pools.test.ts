import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db.js';
import { createScopeFactory } from '../scope.js';
import * as schema from '../schema.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addKey,
  bucketOf,
  fingerprintOf,
  getModelChain,
  listKeys,
  setModelChain,
  updateKey,
} from './assistant-providers.js';
import {
  openMigratedTestDatabase,
  MIGRATIONS_FOLDER,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';

const NOW = 1_790_000_000_000;
let t: MigratedTestDatabase;
beforeEach(() => {
  t = openMigratedTestDatabase();
});
afterEach(() => t.close());

const seedKey = (over: Record<string, unknown> = {}) =>
  addKey(t.scopes.instance(), {
    provider: 'gemini',
    label: 'Gemini 1',
    apiKeyEnc: 'sealed-a',
    costClass: 'free',
    now: NOW,
    ...over,
  });

describe('key pools storage (ADR 0143)', () => {
  it('hashes the secret to a stable fingerprint without keeping the secret', () => {
    expect(fingerprintOf('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(fingerprintOf('AIza-test-one')).toHaveLength(64);
  });
  it('round-trips project and fingerprint, defaulting both to null', () => {
    const a = seedKey({ project: 'Car Team A', fingerprint: fingerprintOf('AIza-test-one') });
    const b = seedKey({ label: 'Gemini 2', apiKeyEnc: 'sealed-b' });
    expect(listKeys(t.scopes.instance()).find((k) => k.keyId === a)).toMatchObject({
      project: 'Car Team A',
      fingerprint: fingerprintOf('AIza-test-one'),
    });
    expect(listKeys(t.scopes.instance()).find((k) => k.keyId === b)).toMatchObject({
      project: null,
      fingerprint: null,
    });
  });
  it('refuses a duplicate fingerprint and a bad project label', () => {
    seedKey({ fingerprint: fingerprintOf('AIza-test-one') });
    expect(() =>
      seedKey({
        label: 'Gemini 2',
        apiKeyEnc: 'sealed-b',
        fingerprint: fingerprintOf('AIza-test-one'),
      }),
    ).toThrow('duplicate key fingerprint');
    expect(() => seedKey({ project: '' })).toThrow('project label');
    expect(() => seedKey({ project: 'x'.repeat(81) })).toThrow('project label');
  });
  it('defaults old chain rows to one-key standard and round-trips pool rows', () => {
    const a = seedKey();
    setModelChain(t.scopes.instance(), [{ keyId: a, model: 'gemini-3.8-flash' }], NOW);
    expect(getModelChain(t.scopes.instance())).toEqual([
      {
        position: 0,
        keyId: a,
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        rpmLimit: null,
        rpdLimit: null,
        pool: 'key',
        tier: 'standard',
      },
    ]);
    setModelChain(
      t.scopes.instance(),
      [{ keyId: a, model: 'gemini-3.8-flash', pool: 'provider', tier: 'light' }],
      NOW,
    );
    expect(getModelChain(t.scopes.instance())[0]).toMatchObject({
      pool: 'provider',
      tier: 'light',
    });
  });
  it('buckets shared project labels together and blank labels apart', () => {
    expect(bucketOf({ keyId: 'key_a', project: 'Car Team A' })).toBe('project:Car Team A');
    expect(bucketOf({ keyId: 'key_a', project: null })).toBe('key:key_a');
    expect(bucketOf({ keyId: 'key_b', project: null })).toBe('key:key_b');
  });
});

describe('key pool upgrade and validation', () => {
  it('preserves populated old rows and applies defaults and cost-class terms', () => {
    const folder = mkdtempSync(join(tmpdir(), 'key-pools-upgrade-'));
    const raw = new Database(':memory:');
    const db = drizzle(raw, { schema });
    try {
      cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
      const journalPath = join(folder, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: { tag: string }[];
      };
      expect(journal.entries.at(-1)?.tag).toBe('0107_key_pools_routing');
      journal.entries.pop();
      writeFileSync(journalPath, JSON.stringify(journal));
      raw.pragma('foreign_keys = ON');
      runMigrations(raw, db, folder);
      raw
        .prepare(
          `INSERT INTO assistant_provider_keys
        (key_id, provider, label, api_key_enc, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('key_old', 'gemini', 'Gemini 1', 'sealed-old', NOW, NOW);
      raw
        .prepare(
          `INSERT INTO assistant_model_chain
        (position, key_id, model, rpm_limit, rpd_limit, updated_at)
        VALUES (0, ?, ?, 5, 20, ?)`,
        )
        .run('key_old', 'gemini-3.8-flash', NOW);
      runMigrations(raw, db, MIGRATIONS_FOLDER);
      const scope = createScopeFactory(db, { readonly: false }).instance();
      expect(listKeys(scope)).toEqual([
        expect.objectContaining({
          keyId: 'key_old',
          apiKeyEnc: 'sealed-old',
          project: null,
          fingerprint: null,
        }),
      ]);
      expect(getModelChain(scope)).toEqual([
        {
          position: 0,
          keyId: 'key_old',
          provider: 'gemini',
          model: 'gemini-3.8-flash',
          rpmLimit: 5,
          rpdLimit: 20,
          pool: 'key',
          tier: 'standard',
        },
      ]);
      expect(
        raw
          .prepare(
            `SELECT provider, trains_on_input, production_use_allowed, reviewed_at
        FROM provider_eligibility WHERE provider IN ('gemini:free', 'gemini:paid')
        ORDER BY provider`,
          )
          .all(),
      ).toEqual([
        {
          provider: 'gemini:free',
          trains_on_input: 'yes',
          production_use_allowed: 1,
          reviewed_at: 1791676800000,
        },
        {
          provider: 'gemini:paid',
          trains_on_input: 'no',
          production_use_allowed: 1,
          reviewed_at: 1791676800000,
        },
      ]);
      expect(raw.pragma('foreign_key_check')).toEqual([]);
      expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      raw.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it('updates projects, rejects bad labels, and invalidates a changed secret fingerprint', () => {
    const scope = t.scopes.instance();
    const keyId = seedKey({ project: 'Car Team A', fingerprint: fingerprintOf('AIza-test-one') });
    updateKey(scope, keyId, { label: 'Gemini 2', now: NOW + 1 });
    expect(listKeys(scope)[0]?.fingerprint).toBe(fingerprintOf('AIza-test-one'));
    expect(() => updateKey(scope, keyId, { project: '', now: NOW + 2 })).toThrow('project label');
    expect(() => updateKey(scope, keyId, { project: 'x'.repeat(81), now: NOW + 2 })).toThrow(
      'project label',
    );
    updateKey(scope, keyId, { project: null, apiKeyEnc: 'sealed-b', now: NOW + 3 });
    expect(listKeys(scope)[0]).toMatchObject({
      project: null,
      fingerprint: null,
      apiKeyEnc: 'sealed-b',
    });
    expect(() => seedKey({ fingerprint: fingerprintOf('AIza-test-one') })).not.toThrow();
  });
  it('rejects invalid pool/tier before replacing the existing chain', () => {
    const scope = t.scopes.instance();
    const keyId = seedKey();
    setModelChain(scope, [{ keyId, model: 'gemini-3.8-flash' }], NOW);
    const before = getModelChain(scope);
    expect(() =>
      setModelChain(scope, [{ keyId, model: 'gemini-3.6-flash', pool: 'other' as 'key' }], NOW),
    ).toThrow('unexpected pool');
    expect(() =>
      setModelChain(scope, [{ keyId, model: 'gemini-3.6-flash', tier: 'other' as 'light' }], NOW),
    ).toThrow('unexpected tier');
    expect(getModelChain(scope)).toEqual(before);
  });
});
