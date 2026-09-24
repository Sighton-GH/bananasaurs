import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as schema from '../schema.js';
import { runMigrations } from '../db.js';
import {
  MIGRATIONS_FOLDER,
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '../test-support.js';
import {
  addKey,
  getGithubTokenEnc,
  getModelChain,
  listKeys,
  removeKey,
  setGithubTokenEnc,
  setModelChain,
  updateKey,
} from './assistant-providers.js';

let t: MigratedTestDatabase;
beforeEach(() => {
  t = openMigratedTestDatabase();
});
afterEach(() => t.close());

/** Migrations up to and including `lastIdx`, so a seed can run against the old shape. */
const migrationsFolderUpTo = (lastIdx: number): string => {
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { version: string; dialect: string; entries: { idx: number; tag: string }[] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-keys-migration-'));
  fs.mkdirSync(path.join(dir, 'meta'));
  const entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
  fs.writeFileSync(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries)
    fs.copyFileSync(
      path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      path.join(dir, `${entry.tag}.sql`),
    );
  return dir;
};

describe('migration 0039 copies single-key-per-provider data into keyed tables', () => {
  it('turns each provider-with-a-key row into a keys row, and its chain rows into key-id chain rows', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });
    runMigrations(raw, db, migrationsFolderUpTo(38));
    raw
      .prepare(
        `INSERT INTO assistant_providers (provider, api_key_enc, cost_class, enabled, updated_at)
         VALUES ('gemini', 'sealed-gemini', 'free', 1, 7)`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO assistant_model_chain (position, provider, model, updated_at)
         VALUES (0, 'gemini', 'gemini-2.5-flash', 7), (1, 'gemini', 'gemini-2.5-flash-lite', 7)`,
      )
      .run();

    runMigrations(raw, db, MIGRATIONS_FOLDER);

    expect(
      raw
        .prepare(
          'SELECT key_id, provider, label, api_key_enc, cost_class, enabled, created_at, updated_at FROM assistant_provider_keys',
        )
        .all(),
    ).toEqual([
      {
        key_id: 'key_gemini',
        provider: 'gemini',
        label: 'Gemini',
        api_key_enc: 'sealed-gemini',
        cost_class: 'free',
        enabled: 1,
        created_at: 7,
        updated_at: 7,
      },
    ]);
    expect(
      raw.prepare('SELECT position, key_id, model FROM assistant_model_chain ORDER BY position').all(),
    ).toEqual([
      { position: 0, key_id: 'key_gemini', model: 'gemini-2.5-flash' },
      { position: 1, key_id: 'key_gemini', model: 'gemini-2.5-flash-lite' },
    ]);
    // The old provider-level table is gone; nothing left to read from it.
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_providers'",
        )
        .get(),
    ).toBeUndefined();
    raw.close();
  });

  it('drops chain rows for a provider that had no key, since there is nothing to key them to', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });
    runMigrations(raw, db, migrationsFolderUpTo(38));
    raw
      .prepare(
        `INSERT INTO assistant_providers (provider, api_key_enc, cost_class, enabled, updated_at)
         VALUES ('gemini', NULL, 'unknown', 0, 7)`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO assistant_model_chain (position, provider, model, updated_at)
         VALUES (0, 'gemini', 'gemini-2.5-flash', 7)`,
      )
      .run();

    runMigrations(raw, db, MIGRATIONS_FOLDER);

    expect(raw.prepare('SELECT count(*) AS n FROM assistant_provider_keys').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT count(*) AS n FROM assistant_model_chain').get()).toEqual({ n: 0 });
    raw.close();
  });

  it('labels each of the three providers by name and copies nothing when none are keyed', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });
    runMigrations(raw, db, migrationsFolderUpTo(38));
    for (const [provider, key] of [
      ['gemini', 'g'],
      ['openrouter', 'o'],
      ['nvidia-nim', 'n'],
    ] as const)
      raw
        .prepare(
          `INSERT INTO assistant_providers (provider, api_key_enc, cost_class, enabled, updated_at)
           VALUES (?, ?, 'unknown', 1, 5)`,
        )
        .run(provider, key);

    runMigrations(raw, db, MIGRATIONS_FOLDER);

    expect(
      raw
        .prepare('SELECT key_id, label FROM assistant_provider_keys ORDER BY key_id')
        .all(),
    ).toEqual([
      { key_id: 'key_gemini', label: 'Gemini' },
      { key_id: 'key_nvidia-nim', label: 'NVIDIA NIM' },
      { key_id: 'key_openrouter', label: 'OpenRouter' },
    ]);
    raw.close();
  });
});

describe('assistant provider keys', () => {
  it('round-trips a key and lists it back', () => {
    const scope = t.scopes.instance();
    const keyId = addKey(scope, {
      provider: 'gemini',
      label: 'Main key',
      apiKeyEnc: 'sealed',
      costClass: 'free',
      now: 10,
    });
    expect(keyId).toMatch(/^key_[0-9a-f]{16}$/);
    expect(listKeys(scope)).toEqual([
      {
        keyId,
        provider: 'gemini',
        label: 'Main key',
        apiKeyEnc: 'sealed',
        costClass: 'free',
        enabled: true,
        createdAt: 10,
        updatedAt: 10,
      },
    ]);
  });

  it('several keys for the same provider coexist, each with its own label', () => {
    const scope = t.scopes.instance();
    const a = addKey(scope, { provider: 'gemini', label: 'Key A', apiKeyEnc: 'sealed-a', now: 10 });
    const b = addKey(scope, { provider: 'gemini', label: 'Key B', apiKeyEnc: 'sealed-b', now: 10 });
    expect(a).not.toBe(b);
    expect(listKeys(scope).map((k) => k.label).sort()).toEqual(['Key A', 'Key B']);
  });

  it('updateKey changes only the given fields and keeps the rest', () => {
    const scope = t.scopes.instance();
    const keyId = addKey(scope, {
      provider: 'gemini',
      label: 'Old label',
      apiKeyEnc: 'sealed',
      costClass: 'unknown',
      now: 10,
    });
    updateKey(scope, keyId, { label: 'New label', now: 11 });
    expect(listKeys(scope)).toMatchObject([
      { label: 'New label', apiKeyEnc: 'sealed', costClass: 'unknown', enabled: true },
    ]);
    updateKey(scope, keyId, { enabled: false, now: 12 });
    expect(listKeys(scope)).toMatchObject([{ label: 'New label', enabled: false }]);
  });

  it('removeKey cascades its chain rows', () => {
    const scope = t.scopes.instance();
    const gemini = addKey(scope, { provider: 'gemini', label: 'Gemini', apiKeyEnc: 'g', now: 10 });
    const openrouter = addKey(scope, {
      provider: 'openrouter',
      label: 'OpenRouter',
      apiKeyEnc: 'o',
      now: 10,
    });
    setModelChain(
      scope,
      [
        { keyId: gemini, model: 'gemini-model' },
        { keyId: openrouter, model: 'or-model' },
      ],
      10,
    );
    removeKey(scope, gemini);
    expect(listKeys(scope).map((k) => k.keyId)).toEqual([openrouter]);
    // The cascade drops gemini's chain row; the survivor keeps its position.
    expect(getModelChain(scope)).toEqual([
      { position: 1, keyId: openrouter, provider: 'openrouter', model: 'or-model' },
    ]);
  });
});

describe('model chain', () => {
  it('starts empty and preserves the order it was given, joining the provider from the key', () => {
    const scope = t.scopes.instance();
    expect(getModelChain(scope)).toEqual([]);
    const gemini = addKey(scope, { provider: 'gemini', label: 'Gemini', apiKeyEnc: 'g', now: 10 });
    const openrouter = addKey(scope, {
      provider: 'openrouter',
      label: 'OpenRouter',
      apiKeyEnc: 'o',
      now: 10,
    });
    setModelChain(
      scope,
      [
        { keyId: openrouter, model: 'or-second' },
        { keyId: gemini, model: 'gemini-first' },
      ],
      11,
    );
    expect(getModelChain(scope)).toEqual([
      { position: 0, keyId: openrouter, provider: 'openrouter', model: 'or-second' },
      { position: 1, keyId: gemini, provider: 'gemini', model: 'gemini-first' },
    ]);
    // Setting again replaces, not appends.
    setModelChain(scope, [{ keyId: gemini, model: 'gemini-only' }], 12);
    expect(getModelChain(scope)).toEqual([
      { position: 0, keyId: gemini, provider: 'gemini', model: 'gemini-only' },
    ]);
  });

  it('the same model may appear twice in the chain under two different keys', () => {
    const scope = t.scopes.instance();
    const a = addKey(scope, { provider: 'gemini', label: 'Key A', apiKeyEnc: 'a', now: 10 });
    const b = addKey(scope, { provider: 'gemini', label: 'Key B', apiKeyEnc: 'b', now: 10 });
    setModelChain(
      scope,
      [
        { keyId: a, model: 'gemini-2.5-flash' },
        { keyId: b, model: 'gemini-2.5-flash' },
      ],
      10,
    );
    expect(getModelChain(scope)).toEqual([
      { position: 0, keyId: a, provider: 'gemini', model: 'gemini-2.5-flash' },
      { position: 1, keyId: b, provider: 'gemini', model: 'gemini-2.5-flash' },
    ]);
  });

  it('refuses more than six entries', () => {
    const scope = t.scopes.instance();
    const keyId = addKey(scope, { provider: 'gemini', label: 'Gemini', apiKeyEnc: 'g', now: 10 });
    expect(() =>
      setModelChain(
        scope,
        Array.from({ length: 7 }, (_, i) => ({ keyId, model: `m-${i}` })),
        11,
      ),
    ).toThrow(/at most six/i);
    expect(getModelChain(scope)).toEqual([]);
  });

  it('refuses a duplicate (keyId, model) pair in the same call', () => {
    const scope = t.scopes.instance();
    const keyId = addKey(scope, { provider: 'gemini', label: 'Gemini', apiKeyEnc: 'g', now: 10 });
    expect(() =>
      setModelChain(
        scope,
        [
          { keyId, model: 'm' },
          { keyId, model: 'm' },
        ],
        10,
      ),
    ).toThrow(/duplicate/i);
    expect(getModelChain(scope)).toEqual([]);
  });

  it('refuses an entry whose key does not exist', () => {
    const scope = t.scopes.instance();
    expect(() => setModelChain(scope, [{ keyId: 'key_missing', model: 'm' }], 10)).toThrow();
    expect(getModelChain(scope)).toEqual([]);
  });
});

describe('a key never appears outside its own row', () => {
  it('listKeys and getModelChain never surface the raw sealed value beyond api_key_enc itself', () => {
    const scope = t.scopes.instance();
    const keyId = addKey(scope, {
      provider: 'gemini',
      label: 'Gemini',
      apiKeyEnc: 'sealed-not-a-raw-secret',
      now: 10,
    });
    setModelChain(scope, [{ keyId, model: 'm' }], 10);
    const chainJson = JSON.stringify(getModelChain(scope));
    expect(chainJson).not.toContain('sealed-not-a-raw-secret');
  });
});

describe('github token', () => {
  it('reads absent and round-trips a sealed value without touching key rows', () => {
    const scope = t.scopes.instance();
    expect(getGithubTokenEnc(scope)).toBeNull();
    setGithubTokenEnc(scope, 'sealed-github-token');
    expect(getGithubTokenEnc(scope)).toBe('sealed-github-token');
    expect(listKeys(scope)).toEqual([]);
    setGithubTokenEnc(scope, null);
    expect(getGithubTokenEnc(scope)).toBeNull();
  });
});
