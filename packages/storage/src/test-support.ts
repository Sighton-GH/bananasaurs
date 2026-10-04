import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
import { runMigrations, type Db } from './db.js';
import { createScopeFactory, type ScopeFactory, type GuildScope } from './scope.js';
import { eq } from 'drizzle-orm';
import { write } from './write.js';

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
  runMigrations(raw, db, MIGRATIONS_FOLDER);
  return {
    db,
    raw,
    scopes: createScopeFactory(db, { readonly: false }),
    readonlyScopes: createScopeFactory(db, { readonly: true }),
    close: () => raw.close(),
  };
}

/**
 * Puts a rule in a state `setRuleMode(mode: 'enforce')` will accept, so a test
 * whose subject is something *downstream* of enforcement — the subscriber, the
 * mode-flip mechanics — can get there
 * without first building a twenty-match review corpus it has nothing to do
 * with (plan ruling PR-31).
 *
 * **It lives here, not in `repos/enforcement-gate.ts`, and that move is the
 * point.** It writes both of the facts the gate reads — `cutover_state` and a
 * sign-off — with no precondition whatsoever, which is defensible only for a
 * caller that is a test harness. Exported from the production module it was
 * reachable as `enforcementGateRepo.makeRuleEnforceableForTest` by anything
 * that can import `@bananasaurs/storage`, including `packages/http`, which no
 * boundary rule forbids from doing so.
 *
 * **The move alone did not make it unreachable, and an earlier version of this
 * comment wrongly claimed it did.** This subpath is published in
 * `package.json` and compiles to `dist/`, so production could still have
 * imported it — one import line different from the original hole. What actually
 * closes it is the `no-restricted-imports` pattern in `eslint.config.js`, which
 * bans every `test-support` path outside `*.test.ts`; that rule was watched
 * firing on a real production file before this sentence was written.
 *
 * `automod ready` (refused outside `observing`) and `automod signoff` (refused
 * without a clean, non-vacuous corpus pass) are the production writers for
 * these two facts, and each carries its own precondition. Never reach for this
 * in a test *about* those preconditions — the end state proves nothing about
 * the path to it.
 */
export const makeRuleEnforceableForTest = (
  scope: GuildScope,
  ruleId: string,
  now: number,
): void => {
  write(scope, ({ db }) => {
    db.update(schema.modRules)
      .set({
        cutoverState: 'ready',
        enforceSignedOffBy: 'test-harness',
        enforceSignedOffAt: now,
      })
      .where(scope.only(schema.modRules, eq(schema.modRules.ruleId, ruleId)))
      .run();
  });
};
