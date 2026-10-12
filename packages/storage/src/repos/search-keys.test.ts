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
import { createScopeFactory } from '../scope.js';
import type { InstanceScope } from '../scope.js';
import {
  DAY_MS,
  MONTH_WINDOW_MS,
  addSearchKey,
  listSearchKeys,
  moveSearchKey,
  removeSearchKey,
  reserveSearchCall,
  searchKeyUsage,
  updateSearchKey,
} from './search-keys.js';

const GUILD_ID = '123456789012345678';

let t: MigratedTestDatabase;
let scope: InstanceScope;
beforeEach(() => {
  t = openMigratedTestDatabase();
  scope = t.scopes.instance();
});
afterEach(() => t.close());

/** Migrations up to and including `lastIdx`, so a seed can run against the old shape. */
const migrationsFolderUpTo = (lastIdx: number): string => {
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { version: string; dialect: string; entries: { idx: number; tag: string }[] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-keys-migration-'));
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

describe('listSearchKeys ordering', () => {
  it('orders by source then position (tavily A, brave B, brave C lists as B, C, A)', () => {
    addSearchKey(scope, { source: 'tavily', label: 'A', apiKeyEnc: 'sealed-a', now: 0 });
    addSearchKey(scope, { source: 'brave', label: 'B', apiKeyEnc: 'sealed-b', now: 0 });
    addSearchKey(scope, { source: 'brave', label: 'C', apiKeyEnc: 'sealed-c', now: 0 });
    const listed = listSearchKeys(scope);
    expect(listed.map((k) => k.label)).toEqual(['B', 'C', 'A']);
    expect(listed.map((k) => k.position)).toEqual([0, 1, 0]);
  });
});

describe('addSearchKey limits', () => {
  it('defaults monthlyLimit to 1000, stores explicit null, and defaults dailyLimit to null', () => {
    const defaulted = addSearchKey(scope, {
      source: 'brave',
      label: 'Default',
      apiKeyEnc: 'sealed',
      now: 0,
    });
    const nulled = addSearchKey(scope, {
      source: 'brave',
      label: 'Nulled',
      apiKeyEnc: 'sealed',
      monthlyLimit: null,
      now: 0,
    });
    const byId = new Map(listSearchKeys(scope).map((k) => [k.keyId, k]));
    expect(byId.get(defaulted)?.monthlyLimit).toBe(1000);
    expect(byId.get(defaulted)?.dailyLimit).toBeNull();
    expect(byId.get(nulled)?.monthlyLimit).toBeNull();
  });
});

describe('updateSearchKey', () => {
  it('changes only the given fields, bumps updatedAt, returns false for unknown ids, and null clears a limit', () => {
    const keyId = addSearchKey(scope, {
      source: 'brave',
      label: 'Before',
      apiKeyEnc: 'sealed-before',
      monthlyLimit: 500,
      dailyLimit: 5,
      now: 10,
    });
    expect(updateSearchKey(scope, keyId, { label: 'After', now: 20 })).toBe(true);
    const row = listSearchKeys(scope).find((k) => k.keyId === keyId);
    expect(row).toMatchObject({
      label: 'After',
      apiKeyEnc: 'sealed-before',
      monthlyLimit: 500,
      dailyLimit: 5,
      createdAt: 10,
      updatedAt: 20,
    });
    expect(updateSearchKey(scope, 'skey_missing', { label: 'Nope', now: 30 })).toBe(false);
    expect(updateSearchKey(scope, keyId, { monthlyLimit: null, now: 40 })).toBe(true);
    expect(listSearchKeys(scope).find((k) => k.keyId === keyId)?.monthlyLimit).toBeNull();
  });
});

describe('moveSearchKey', () => {
  it('swaps neighbours in the same source only, no-ops at the ends, and returns false for unknown ids', () => {
    const a = addSearchKey(scope, { source: 'tavily', label: 'A', apiKeyEnc: 'a', now: 0 });
    const b = addSearchKey(scope, { source: 'brave', label: 'B', apiKeyEnc: 'b', now: 0 });
    const c = addSearchKey(scope, { source: 'brave', label: 'C', apiKeyEnc: 'c', now: 0 });
    const labels = () => listSearchKeys(scope).map((k) => k.label);
    expect(moveSearchKey(scope, c, 'up', 1)).toBe(true);
    expect(labels()).toEqual(['C', 'B', 'A']);
    // Moving the first up is a no-op returning true.
    expect(moveSearchKey(scope, c, 'up', 2)).toBe(true);
    expect(labels()).toEqual(['C', 'B', 'A']);
    expect(moveSearchKey(scope, b, 'down', 3)).toBe(true);
    expect(labels()).toEqual(['C', 'B', 'A']);
    expect(moveSearchKey(scope, b, 'up', 4)).toBe(true);
    expect(labels()).toEqual(['B', 'C', 'A']);
    // A lone key in its source never moves.
    expect(moveSearchKey(scope, a, 'up', 5)).toBe(true);
    expect(moveSearchKey(scope, a, 'down', 6)).toBe(true);
    expect(labels()).toEqual(['B', 'C', 'A']);
    expect(moveSearchKey(scope, 'skey_missing', 'up', 7)).toBe(false);
  });
});

describe('removeSearchKey', () => {
  it('cascades its calls and returns false for unknown ids', () => {
    const keyId = addSearchKey(scope, {
      source: 'brave',
      label: 'Gone',
      apiKeyEnc: 'sealed',
      now: 0,
    });
    expect(
      reserveSearchCall(scope, {
        keyId,
        guildId: GUILD_ID,
        now: 0,
        monthlyLimit: null,
        dailyLimit: null,
      }),
    ).toEqual({ ok: true });
    expect(
      reserveSearchCall(scope, {
        keyId,
        guildId: GUILD_ID,
        now: 1,
        monthlyLimit: null,
        dailyLimit: null,
      }),
    ).toEqual({ ok: true });
    expect(removeSearchKey(scope, keyId)).toBe(true);
    expect(
      (
        t.raw
          .prepare('SELECT COUNT(*) AS n FROM assistant_search_calls WHERE key_id = ?')
          .get(keyId) as { n: number }
      ).n,
    ).toBe(0);
    expect(removeSearchKey(scope, 'skey_missing')).toBe(false);
  });
});

describe('reserveSearchCall for a removed key', () => {
  it('returns missing instead of inserting, so the runner skips the key', () => {
    const keyId = addSearchKey(scope, {
      source: 'brave',
      label: 'Gone',
      apiKeyEnc: 'sealed',
      now: 0,
    });
    expect(removeSearchKey(scope, keyId)).toBe(true);
    expect(
      reserveSearchCall(scope, {
        keyId,
        guildId: GUILD_ID,
        now: 1000,
        monthlyLimit: null,
        dailyLimit: null,
      }),
    ).toEqual({ ok: false, limit: 'missing', availableAt: 1000 });
    expect(
      reserveSearchCall(scope, {
        keyId: 'skey_never-existed',
        guildId: GUILD_ID,
        now: 1000,
        monthlyLimit: 1,
        dailyLimit: 1,
      }),
    ).toEqual({ ok: false, limit: 'missing', availableAt: 1000 });
  });
});

describe('reserveSearchCall with no limits', () => {
  it('always succeeds and records the guild id', () => {
    const keyId = addSearchKey(scope, {
      source: 'brave',
      label: 'Free',
      apiKeyEnc: 'sealed',
      now: 0,
    });
    for (let i = 0; i < 5; i += 1) {
      expect(
        reserveSearchCall(scope, {
          keyId,
          guildId: GUILD_ID,
          now: i * 1000,
          monthlyLimit: null,
          dailyLimit: null,
        }),
      ).toEqual({ ok: true });
    }
    expect(t.raw.prepare('SELECT key_id, guild_id, at FROM assistant_search_calls').all()).toEqual([
      { key_id: keyId, guild_id: GUILD_ID, at: 0 },
      { key_id: keyId, guild_id: GUILD_ID, at: 1000 },
      { key_id: keyId, guild_id: GUILD_ID, at: 2000 },
      { key_id: keyId, guild_id: GUILD_ID, at: 3000 },
      { key_id: keyId, guild_id: GUILD_ID, at: 4000 },
    ]);
  });
});

describe('reserveSearchCall daily limit', () => {
  it('refuses the third call within 24 h with availableAt at first call plus DAY_MS', () => {
    const keyId = addSearchKey(scope, {
      source: 'brave',
      label: 'Daily',
      apiKeyEnc: 'sealed',
      now: 0,
    });
    const reserve = (now: number) =>
      reserveSearchCall(scope, {
        keyId,
        guildId: GUILD_ID,
        now,
        monthlyLimit: null,
        dailyLimit: 2,
      });
    expect(reserve(0)).toEqual({ ok: true });
    expect(reserve(1000)).toEqual({ ok: true });
    expect(reserve(2000)).toEqual({ ok: false, limit: 'daily', availableAt: DAY_MS });
    expect(reserve(DAY_MS + 1)).toEqual({ ok: true });
  });
});

describe('reserveSearchCall monthly limit', () => {
  it('uses a sliding 31-day window and frees the slot once the oldest call slides out', () => {
    const keyId = addSearchKey(scope, {
      source: 'tavily',
      label: 'Monthly',
      apiKeyEnc: 'sealed',
      now: 0,
    });
    const reserve = (now: number) =>
      reserveSearchCall(scope, {
        keyId,
        guildId: GUILD_ID,
        now,
        monthlyLimit: 2,
        dailyLimit: null,
      });
    const day10 = 10 * DAY_MS;
    const day20 = 20 * DAY_MS;
    expect(reserve(0)).toEqual({ ok: true });
    expect(reserve(day10)).toEqual({ ok: true });
    expect(reserve(day20)).toEqual({
      ok: false,
      limit: 'monthly',
      availableAt: MONTH_WINDOW_MS,
    });
    expect(reserve(MONTH_WINDOW_MS + 1)).toEqual({ ok: true });
  });
});

describe('reserveSearchCall window edge', () => {
  it('a row exactly 31 days plus 1 ms old does not count toward the monthly window', () => {
    const keyId = addSearchKey(scope, {
      source: 'tavily',
      label: 'Edge',
      apiKeyEnc: 'sealed',
      now: 0,
    });
    expect(
      reserveSearchCall(scope, {
        keyId,
        guildId: GUILD_ID,
        now: 0,
        monthlyLimit: 1,
        dailyLimit: null,
      }),
    ).toEqual({ ok: true });
    expect(
      reserveSearchCall(scope, {
        keyId,
        guildId: GUILD_ID,
        now: MONTH_WINDOW_MS + 1,
        monthlyLimit: 1,
        dailyLimit: null,
      }),
    ).toEqual({ ok: true });
  });
});

describe('reserveSearchCall pruning', () => {
  it('drops rows older than 32 days on reserve', () => {
    const keyId = addSearchKey(scope, {
      source: 'brave',
      label: 'Pruned',
      apiKeyEnc: 'sealed',
      now: 0,
    });
    const reserve = (now: number) =>
      reserveSearchCall(scope, {
        keyId,
        guildId: GUILD_ID,
        now,
        monthlyLimit: null,
        dailyLimit: null,
      });
    expect(reserve(0)).toEqual({ ok: true });
    const later = 33 * DAY_MS;
    expect(reserve(later)).toEqual({ ok: true });
    expect(t.raw.prepare('SELECT at FROM assistant_search_calls').all()).toEqual([{ at: later }]);
  });
});

describe('searchKeyUsage', () => {
  it('counts both windows and reports availableAt only while at a limit', () => {
    const keyId = addSearchKey(scope, {
      source: 'brave',
      label: 'Usage',
      apiKeyEnc: 'sealed',
      now: 0,
    });
    const usageOf = (now: number) =>
      searchKeyUsage(scope, { keyId, now, monthlyLimit: 10, dailyLimit: 2 });
    expect(usageOf(0)).toEqual({ last24h: 0, last31d: 0 });
    reserveSearchCall(scope, {
      keyId,
      guildId: GUILD_ID,
      now: 0,
      monthlyLimit: 10,
      dailyLimit: 2,
    });
    reserveSearchCall(scope, {
      keyId,
      guildId: GUILD_ID,
      now: 1000,
      monthlyLimit: 10,
      dailyLimit: 2,
    });
    // Both calls are in both windows here, and the daily limit is reached.
    const usage = usageOf(1000);
    expect(usage.last24h).toBe(2);
    expect(usage.last31d).toBe(2);
    expect(usage.availableAt).toBe(DAY_MS);
    // A day later the calls count for the month but no longer the day, and
    // no limit is reached so availableAt is absent.
    const old = usageOf(2 * DAY_MS);
    expect(old).toEqual({ last24h: 0, last31d: 2 });
    const empty = usageOf(40 * DAY_MS);
    expect(empty).toEqual({ last24h: 0, last31d: 0 });
  });
});

describe('migration 0108 rebuilds the search-key table without losing history', () => {
  it('keeps every search key and its call rows (the calls cascade on key delete)', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });
    runMigrations(raw, db, migrationsFolderUpTo(107));
    raw
      .prepare(
        `INSERT INTO assistant_search_keys
           (key_id, source, label, api_key_enc, enabled, position, monthly_limit, created_at, updated_at)
         VALUES ('skey_t', 'tavily', 'Tavily key', 'sealed-t', 1, 0, 1000, 5, 5)`,
      )
      .run();
    const insertCall = raw.prepare(
      `INSERT INTO assistant_search_calls (key_id, at, guild_id) VALUES ('skey_t', ?, '234567890123456789')`,
    );
    insertCall.run(10);
    insertCall.run(20);

    runMigrations(raw, db, MIGRATIONS_FOLDER);

    const migrated = createScopeFactory(db, { readonly: false }).instance();
    expect(listSearchKeys(migrated)).toEqual([
      expect.objectContaining({ keyId: 'skey_t', source: 'tavily', apiKeyEnc: 'sealed-t' }),
    ]);
    expect(
      raw.prepare(`SELECT at FROM assistant_search_calls WHERE key_id = 'skey_t' ORDER BY at`).all(),
    ).toEqual([{ at: 10 }, { at: 20 }]);
    raw.close();
  });
});

describe('migration 0090 copies the saved Brave key into search keys', () => {
  it('turns a saved search_api_key_enc row into the first Brave search key', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });
    runMigrations(raw, db, migrationsFolderUpTo(52));
    raw
      .prepare(
        `INSERT INTO assistant_provider_config (config_id, search_api_key_enc, updated_at)
         VALUES ('active', 'sealed-brave', 5)`,
      )
      .run();

    runMigrations(raw, db, MIGRATIONS_FOLDER);

    const migrated = createScopeFactory(db, { readonly: false }).instance();
    expect(listSearchKeys(migrated)).toEqual([
      {
        keyId: 'skey_brave',
        source: 'brave',
        label: 'Brave key',
        apiKeyEnc: 'sealed-brave',
        enabled: true,
        position: 0,
        monthlyLimit: 1000,
        dailyLimit: null,
        createdAt: 5,
        updatedAt: 5,
      },
    ]);
    raw.close();
  });

  it('copies nothing when no Brave key is saved', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = drizzle(raw, { schema });
    runMigrations(raw, db, migrationsFolderUpTo(52));
    raw
      .prepare(
        `INSERT INTO assistant_provider_config (config_id, search_api_key_enc, updated_at)
         VALUES ('active', NULL, 5)`,
      )
      .run();

    runMigrations(raw, db, MIGRATIONS_FOLDER);

    const migrated = createScopeFactory(db, { readonly: false }).instance();
    expect(listSearchKeys(migrated)).toEqual([]);
    raw.close();
  });
});
