import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openMigratedTestDatabase } from '@bananasaurs/storage/test-support';
import { parseConfig, redactConfig } from '@bananasaurs/core';

/**
 * The daemon logs `redactConfig(config)` directly rather than through the
 * logger's allowlist, because the two use different key conventions. That is a
 * deliberate exception, so it gets its own test: the object handed to the
 * logger must carry no secret value.
 */
describe('startup config logging', () => {
  it('hands the logger no secret value', () => {
    const token = 'TOKENPART1.TOKENPART2.TOKENPART3';
    const secret = 'SESSIONSECRETSESSIONSECRETSESSION';
    const logged = JSON.stringify(
      redactConfig(
        parseConfig({
          DISCORD_BOT_TOKEN: token,
          DISCORD_APPLICATION_ID: '123456789012345678',
          BANANASAURS_GUILD_ALLOWLIST: '234567890123456789',
          BANANASAURS_OWNER_USER_ID: '345678901234567890',
          DASHBOARD_SESSION_SECRET: secret,
        }),
      ),
    );
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('TOKENPART1');
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain('SESSIONSECRET');
    // and still carries something useful
    expect(logged).toContain('127.0.0.1');
  });
});

describe('assertMigrated (the archive_channels crash loop, 2026-09-17)', () => {
  // A database *behind* its code used to start cleanly and then die at
  // whatever query first touched a table it did not have. A missing
  // `archive_channels` became 15,000 restarts against the archive expiry
  // timer, with the bot off Discord for a day, because the old check only
  // asked whether `guilds` existed — which proved the database had *a*
  // schema, never that the schema matched this build.
  const migrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url));

  const journalEntryCount = (): number => {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    );
    const entries = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) throw new Error('journal has no entries array');
    return entries.length;
  };

  it('the journal is the authoritative count, and a fully migrated database matches it', () => {
    const t = openMigratedTestDatabase();
    try {
      const row = t.raw.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as {
        n: number;
      };
      // If this ever fails, the startup check would refuse a database that is
      // in fact current — so it pins the two sources against each other.
      expect(row.n).toBe(journalEntryCount());
    } finally {
      t.close();
    }
  });

  it('a database behind its build is detectably behind, by count', () => {
    const t = openMigratedTestDatabase();
    try {
      // Simulate the real failure: the schema is present and `guilds` exists,
      // so the old check passed, but the build expects more migrations than
      // the database has applied.
      t.raw
        .prepare(
          'DELETE FROM __drizzle_migrations WHERE rowid = (SELECT MAX(rowid) FROM __drizzle_migrations)',
        )
        .run();
      const applied = (
        t.raw.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number }
      ).n;
      const guilds = t.raw
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'guilds'`)
        .get();

      expect(guilds).toBeDefined(); // the old check would have said "fine"
      expect(applied).toBeLessThan(journalEntryCount()); // the new one does not
    } finally {
      t.close();
    }
  });
});
