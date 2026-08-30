import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
import type { Db } from './db.js';
import { createScopeFactory, type ScopeFactory } from './scope.js';

/** Repo-root `drizzle/`. Tests run against the real migrations, never a copy. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));

export interface MigratedTestDatabase {
  db: Db;
  raw: Database.Database;
  scopes: ScopeFactory;
  /**
   * The same database seen through `BANANASAURS_READONLY`.
   *
   * A second factory over one handle rather than a second database, because
   * readonly is a property of the *scope*, not of the file — which is what lets
   * a test seed rows through `scopes` and then prove a command refuses to write
   * through `readonlyScopes`.
   */
  readonlyScopes: ScopeFactory;
  close(): void;
}

/**
 * An in-memory database with every migration applied.
 *
 * Tests run against the migrations that ship, not against `schema.ts`. That
 * distinction matters here: STRICT exists only in the migration SQL, because
 * drizzle-kit cannot emit it and `scripts/strictify.mjs` adds it afterwards. A
 * test built from the schema module would not see it.
 */
export function openMigratedTestDatabase(): MigratedTestDatabase {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    db,
    raw,
    scopes: createScopeFactory(db, { readonly: false }),
    readonlyScopes: createScopeFactory(db, { readonly: true }),
    close: () => raw.close(),
  };
}
