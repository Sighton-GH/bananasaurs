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

**Mutation check completed 2026-08-23.** Results below. Originally only mutation 1 of 3 ran before the session was interrupted: inverting the liveness probe in `defaultIsAlive` so a live holder reads as dead. Restored from backup and verified — the probe reads `return true` again and all 47 tests pass. **The two remaining mutations for this slice were not run** (dropping `foreign_keys=ON`, dropping `journal_mode=WAL`). They are the first thing to do on resume; the tests asserting those pragmas exist but have not been shown to fail against a broken implementation.

**Decisions.**

*STRICT tables were dropped.* The plan called for them. drizzle-kit does not emit `STRICT`, and on measurement SQLite's TEXT affinity already coerces an integer to text on insert, so the precision failure STRICT was meant to prevent does not occur. Replaced with a format `CHECK` on every snowflake column — `GLOB '[0-9]*' AND length BETWEEN 17 AND 20` — which is a stronger guarantee than STRICT would have given, because STRICT constrains only the type and would accept the string `'not-an-id'`. Verified: `'12345'`, `'not-an-id'`, and a 25-digit value are all rejected with `SQLITE_CONSTRAINT_CHECK`.

*A malformed lock file is reclaimed, not fatal.* The window between the atomic `O_EXCL` create and the write is microseconds, and the socket bind already guards against a live second daemon. Refusing to start would leave the bot down until someone SSHes in to delete a file, which is a worse failure than the race it prevents. `EPERM` from the liveness probe is treated as alive, because "cannot tell" must fail safe.

*`scripts/` is excluded from ESLint.* `migrate.mjs` is plain JS outside any tsconfig project, and type-aware rules cannot parse it. Prettier still formats it. Twenty lines of build helper is not worth a second parser configuration.

**Verified by running it, not only by tests.** Migration applied to a fresh database and re-applied as a no-op. Two concurrent Node processes: the second was refused with the first's pid and socket path, and the lock freed cleanly when the holder exited.

**Deferred.** Slice 3, the fake Discord harness, is not started. Slice 2b (remaining schema, `write()` guard, guild-scoped repo factory, invariant test) belongs to WP2.

---

## WP1 / slice 2a — mutation check completed — 2026-08-23

Finishing the two mutations the interrupt cut short, plus one extra.

| Mutation | Result |
|---|---|
| Drop `journal_mode = WAL` | **Caught** — 5 tests failed |
| Weaken the snowflake `CHECK` to `1=1` | **Caught** — including "rejects a guild_id that is not a snowflake" |
| Drop `foreign_keys = ON` | **NOT caught — 13/13 still passed** |

**The foreign-keys test was decoration and has been rewritten.**

It read `expect(raw.pragma('foreign_keys', {simple:true})).toBe(1)` and passed with the pragma line deleted, because **better-sqlite3 enables foreign keys by default** — raw SQLite does not, which is what the code comment claimed and what I assumed. The test was asserting the library's default, so no change to our code could ever have failed it. This is exactly the failure mode `docs/20` describes: green forever, regardless of whether the feature works.

Replaced with a test that asserts the behaviour instead: two tables with a composite `(guild_id, item_id)` foreign key, and a child row referencing the same item id under a *different* guild must be rejected. That is the invariant the whole Release 1 schema rests on, and it holds whatever the cause of a regression — our pragma, a library upgrade changing its default, or a connection opened elsewhere.

Verified the replacement is not itself decoration: forcing `foreign_keys = OFF` makes it fail, and only it. The misleading comment in `db.ts` was corrected to say the pragma is belt-and-braces rather than the thing doing the work.

47 tests green; typecheck and lint pass.

---

## WP1 / slice 3a — DiscordPort, error types, emoji canonicalisation — 2026-08-23

Slice 3 was split. `docs/20` stops at roughly 400 lines of new implementation per slice, and the port plus the fake plus its tests is well past that. 3a is the contract; 3b is the fake that implements it.

**Changed.** `packages/core/src/discord/`: the `DiscordPort` interface covering only what Release 1 needs (roles, members, messages, reactions with pagination, audit log, leave guild); `DomainEvent` types where every event carries `guildId` explicitly, so an event that cannot be attributed to a guild is dropped at the adapter rather than travelling with an optional scope; `DiscordApiError` and `RoleHierarchyError`; and emoji canonicalisation.

**Emoji canonicalisation is the substantive part.** Discord sends unicode reaction emoji as raw characters, and clients differ on whether they append U+FE0F. A member on one platform reacts with `U+2714 U+FE0F` and another with bare `U+2714`; a naive comparison matches one and silently ignores the other, for exactly one person, with no error anywhere. Everything reduces to `u:<codepoints>` or `c:<snowflake>` before storage or comparison. Skin-tone modifiers and ZWJ sequences are deliberately preserved as distinct, because they are distinct reactions on Discord.

`RoleHierarchyError` is kept separate from `DiscordApiError` on purpose. Discord reports both a permission failure and a hierarchy failure as 50013, so the two are indistinguishable in the response. Hierarchy must be checked before acting rather than inferred from an error, and the type makes that split explicit.

**Broke, to check the tests.**

1. Stopped stripping U+FE0F → the variation-selector test failed.
2. Also stripped skin-tone modifiers, i.e. over-normalising → the skin-tone test failed.
3. Dropped the `c:` prefix so custom and unicode keys share a namespace → 2 tests failed.

**A restore that did not restore.** The first attempt used `git checkout -- emoji.ts` on a file that had never been committed, so git had nothing to restore and my `|| true` swallowed the error. The second mutation then ran against an already-broken file and produced a misleading identical result. Rewrote the file, re-ran both mutations against a verified-clean baseline, and switched to a file copy for untracked files. Worth recording because the failure looked like a passing mutation check.

56 tests green; typecheck and lint pass.
