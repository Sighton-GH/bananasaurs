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
  getGithubTokenEnc,
  getModelChain,
  listProviders,
  removeProvider,
  setGithubTokenEnc,
  setModelChain,
  upsertProvider,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-chain-migration-'));
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

describe('migration 0038 copies the single provider config into the new tables', () => {
  it('copies the provider row and the model plus fallback models as ordered chain entries', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });
    runMigrations(raw, db, migrationsFolderUpTo(36));
    raw
      .prepare(
        `INSERT INTO assistant_provider_config
           (config_id, provider, model, api_key_enc, enabled, cost_class,
            fallback_models_json, search_api_key_enc, search_enabled, updated_at)
         VALUES ('active', 'gemini', 'gemini-2.5-flash', 'sealed', 1, 'free',
           '["gemini-2.5-flash-lite", "gemma-3-27b-it"]', NULL, 0, 7)`,
      )
      .run();

    runMigrations(raw, db, MIGRATIONS_FOLDER);

    expect(
      raw.prepare('SELECT provider, api_key_enc, cost_class, enabled, updated_at FROM assistant_providers').all(),
    ).toEqual([
      { provider: 'gemini', api_key_enc: 'sealed', cost_class: 'free', enabled: 1, updated_at: 7 },
    ]);
    expect(
      raw.prepare('SELECT position, provider, model FROM assistant_model_chain ORDER BY position').all(),
    ).toEqual([
      { position: 0, provider: 'gemini', model: 'gemini-2.5-flash' },
      { position: 1, provider: 'gemini', model: 'gemini-2.5-flash-lite' },
      { position: 2, provider: 'gemini', model: 'gemma-3-27b-it' },
    ]);
    // The old row stays where it was, search columns and all.
    expect(
      raw.prepare('SELECT provider, model, search_enabled FROM assistant_provider_config').all(),
    ).toEqual([{ provider: 'gemini', model: 'gemini-2.5-flash', search_enabled: 0 }]);
    raw.close();
  });

  it('copies nothing when the saved provider is off', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });
    runMigrations(raw, db, migrationsFolderUpTo(36));
    raw
      .prepare(
        `INSERT INTO assistant_provider_config
           (config_id, provider, model, api_key_enc, enabled, cost_class, updated_at)
         VALUES ('active', 'off', NULL, NULL, 0, 'unknown', 7)`,
      )
      .run();

    runMigrations(raw, db, MIGRATIONS_FOLDER);

    expect(raw.prepare('SELECT count(*) AS n FROM assistant_providers').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT count(*) AS n FROM assistant_model_chain').get()).toEqual({ n: 0 });
    raw.close();
  });
});

describe('assistant providers', () => {
  it('round-trips a provider row with defaults for omitted fields', () => {
    const scope = t.scopes.instance();
    upsertProvider(scope, { provider: 'gemini', now: 10 });
    expect(listProviders(scope)).toEqual([
      { provider: 'gemini', apiKeyEnc: null, costClass: 'unknown', enabled: false, updatedAt: 10 },
    ]);
    upsertProvider(scope, {
      provider: 'gemini',
      apiKeyEnc: 'sealed-key',
      costClass: 'free',
      enabled: true,
      now: 11,
    });
    expect(listProviders(scope)).toEqual([
      { provider: 'gemini', apiKeyEnc: 'sealed-key', costClass: 'free', enabled: true, updatedAt: 11 },
    ]);
    upsertProvider(scope, { provider: 'openrouter', apiKeyEnc: 'sealed-or', now: 12 });
    expect(listProviders(scope).map((p) => p.provider).sort()).toEqual(['gemini', 'openrouter']);
  });

  it('removing a provider drops its chain rows with it', () => {
    const scope = t.scopes.instance();
    upsertProvider(scope, { provider: 'gemini', apiKeyEnc: 'sealed', enabled: true, now: 10 });
    upsertProvider(scope, { provider: 'openrouter', apiKeyEnc: 'sealed-or', enabled: true, now: 10 });
    setModelChain(
      scope,
      [
        { provider: 'gemini', model: 'gemini-2.5-flash' },
        { provider: 'openrouter', model: 'or-model' },
      ],
      10,
    );
    removeProvider(scope, 'gemini');
    expect(listProviders(scope).map((p) => p.provider)).toEqual(['openrouter']);
    // The cascade drops gemini's row; the survivor keeps its position.
    expect(getModelChain(scope)).toEqual([{ position: 1, provider: 'openrouter', model: 'or-model' }]);
  });
});

describe('model chain', () => {
  it('starts empty and preserves the order it was given', () => {
    const scope = t.scopes.instance();
    expect(getModelChain(scope)).toEqual([]);
    upsertProvider(scope, { provider: 'gemini', apiKeyEnc: 'sealed', enabled: true, now: 10 });
    upsertProvider(scope, { provider: 'openrouter', apiKeyEnc: 'sealed-or', enabled: true, now: 10 });
    setModelChain(
      scope,
      [
        { provider: 'openrouter', model: 'or-second' },
        { provider: 'gemini', model: 'gemini-first' },
      ],
      11,
    );
    expect(getModelChain(scope)).toEqual([
      { position: 0, provider: 'openrouter', model: 'or-second' },
      { position: 1, provider: 'gemini', model: 'gemini-first' },
    ]);
    // Setting again replaces, not appends.
    setModelChain(scope, [{ provider: 'gemini', model: 'gemini-only' }], 12);
    expect(getModelChain(scope)).toEqual([
      { position: 0, provider: 'gemini', model: 'gemini-only' },
    ]);
  });

  it('refuses more than six entries', () => {
    const scope = t.scopes.instance();
    upsertProvider(scope, { provider: 'gemini', apiKeyEnc: 'sealed', enabled: true, now: 10 });
    expect(() =>
      setModelChain(
        scope,
        Array.from({ length: 7 }, (_, i) => ({ provider: 'gemini' as const, model: `m-${i}` })),
        11,
      ),
    ).toThrow(/at most six/i);
    expect(getModelChain(scope)).toEqual([]);
  });

  it('refuses an entry whose provider has no key row', () => {
    const scope = t.scopes.instance();
    expect(() => setModelChain(scope, [{ provider: 'gemini', model: 'm' }], 10)).toThrow();
    expect(getModelChain(scope)).toEqual([]);
  });
});

describe('github token', () => {
  it('reads absent and round-trips a sealed value without touching provider rows', () => {
    const scope = t.scopes.instance();
    expect(getGithubTokenEnc(scope)).toBeNull();
    setGithubTokenEnc(scope, 'sealed-github-token');
    expect(getGithubTokenEnc(scope)).toBe('sealed-github-token');
    expect(listProviders(scope)).toEqual([]);
    setGithubTokenEnc(scope, null);
    expect(getGithubTokenEnc(scope)).toBeNull();
  });
});
