# Session log

Append-only. One entry per slice, per `docs/20_AUTONOMOUS_EXECUTION.md`.

---

## WP1 / slice 1 — workspace, config, logging, CI, systemd — 2026-08-22

**Changed.** npm workspace with `packages/core` and `apps/daemon`. TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Zod config loader that reports every problem at once and never echoes a rejected value. Pino logger with an allowlist projection. ESLint flat config, Prettier, Vitest, GitHub Actions CI, systemd unit.

**Broke, to check the tests.**

1. Turned the allowlist guard in `safeLogFields` into `if (false)` so unknown fields pass through → 3 tests failed, including the one asserting a field nobody thought to ban still gets dropped.
2. Flipped `BANANASAURS_DRY_RUN` default from `'1'` to `'0'` → 2 tests failed.
3. Relaxed `DASHBOARD_SESSION_SECRET` from `.min(32)` to `.min(1)` → 1 test failed.

All three restored; 23 tests green.

**Found by running it.** The startup debug line logged `droppedFields: 17` and nothing else: `redactConfig` emits SCREAMING_CASE env keys while the log allowlist holds camelCase domain fields, so filtering twice dropped everything. Fixed by logging `redactConfig(config)` directly — a bounded key set with secrets already replaced — with a test asserting no secret value reaches the logger. This is the kind of bug the test suite would never have caught, because both halves were individually correct.

**Deferred.** `dependency-cruiser` is not installed; see the decision note below. `packages/testkit`, `storage`, `discord`, `http`, `dashboard`, `cli` do not exist yet — slices 2a and 3 and later packages.

**Decision.** Module boundaries are enforced by workspace manifests rather than `dependency-cruiser`. `packages/core/package.json` depends only on `pino` and `zod`, so importing `discord.js` or `better-sqlite3` from core fails to resolve. That is free, needs no new dependency, and `docs/20` requires a stop before adding one beyond ADR 0008. ESLint `no-restricted-imports` covers the intra-package rules, including a hard ban on `child_process` per ADR 0013. The accepted plan named `dependency-cruiser`; this is a deliberate departure and is cheaper.

---

## WP1 / slice 2a — database plumbing — 2026-08-22

**Changed.** `packages/storage`: better-sqlite3 with WAL, `busy_timeout`, `synchronous=NORMAL`, `foreign_keys=ON`; the two single-writer guards; Drizzle wired to drizzle-kit; the `guilds` table alone so the migration pipeline is demonstrably real. `npm run db:generate` and `npm run db:migrate` both work.

**Broke, to check the tests.** Only mutation 1 of 3 ran before the session was interrupted: inverting the liveness probe in `defaultIsAlive` so a live holder reads as dead. Restored from backup and verified — the probe reads `return true` again and all 47 tests pass. **The two remaining mutations for this slice were not run** (dropping `foreign_keys=ON`, dropping `journal_mode=WAL`). They are the first thing to do on resume; the tests asserting those pragmas exist but have not been shown to fail against a broken implementation.

**Decisions.**

*STRICT tables were dropped.* The plan called for them. drizzle-kit does not emit `STRICT`, and on measurement SQLite's TEXT affinity already coerces an integer to text on insert, so the precision failure STRICT was meant to prevent does not occur. Replaced with a format `CHECK` on every snowflake column — `GLOB '[0-9]*' AND length BETWEEN 17 AND 20` — which is a stronger guarantee than STRICT would have given, because STRICT constrains only the type and would accept the string `'not-an-id'`. Verified: `'12345'`, `'not-an-id'`, and a 25-digit value are all rejected with `SQLITE_CONSTRAINT_CHECK`.

*A malformed lock file is reclaimed, not fatal.* The window between the atomic `O_EXCL` create and the write is microseconds, and the socket bind already guards against a live second daemon. Refusing to start would leave the bot down until someone SSHes in to delete a file, which is a worse failure than the race it prevents. `EPERM` from the liveness probe is treated as alive, because "cannot tell" must fail safe.

*`scripts/` is excluded from ESLint.* `migrate.mjs` is plain JS outside any tsconfig project, and type-aware rules cannot parse it. Prettier still formats it. Twenty lines of build helper is not worth a second parser configuration.

**Verified by running it, not only by tests.** Migration applied to a fresh database and re-applied as a no-op. Two concurrent Node processes: the second was refused with the first's pid and socket path, and the lock freed cleanly when the holder exited.

**Deferred.** Slice 3, the fake Discord harness, is not started. Slice 2b (remaining schema, `write()` guard, guild-scoped repo factory, invariant test) belongs to WP2.
