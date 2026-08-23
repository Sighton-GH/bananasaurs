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

---

## WP1 / slice 3b — the fake Discord harness — 2026-08-23

**Changed.** `packages/testkit`: `FakeDiscord`, an in-memory Discord implementing `DiscordPort`, plus `checkRoleAssignable` in core as its first real consumer. 81 tests total.

The fake holds a guild — roles with positions and `managed` flags, members with role sets, messages with ordered reaction lists — and can be told to fail on demand. All six required conditions are driven by tests: duplicate event, reconnect gap with a fresh IDENTIFY, 429 with `retryAfter`, 403/50013, role-hierarchy failure, and a reaction on an uncached message arriving flagged `wasPartial`.

Two behaviours worth calling out because they encode Discord constraints rather than our choices. `fetchReactionUsers` caps a page at 100 regardless of the requested limit, so a 250-reactor panel takes three calls — this is why the adoption pass is a resumable job. And `editMessage` refuses a message the bot did not author, which is the API limit that makes adopted panels reaction-only.

**WP1's gate is met.** `checkRoleAssignable` is production code in core, driven by the fake. Three mutations, each caught by the test written for it:

1. `>=` to `>` on the hierarchy comparison → the at-exactly-bot-position test failed. That off-by-one is the one that breaks panels after a role reorder.
2. Dropped the `managed` branch → the integration-role test failed.
3. Cached roles instead of re-reading per call → 4 tests failed, which is the point of checking immediately before every mutation rather than at startup.

**Two problems found by running it, not by tests.**

*The fake did not implement its own port.* World-building `addRole(role)` collided with the port's `addRole(guildId, userId, roleId)`. Setters are now `defineRole` / `defineMember` / `defineMessage`, and the class carries `implements DiscordPort` so the compiler enforces the contract.

*Vitest was resolving workspace packages to `dist/`.* A newly exported function was invisible to the suite until `npm run build`, and the earlier tests had been running against stale build output without anyone noticing. `vitest.config.ts` now aliases the three packages to `src`. This one is worth remembering: it means a test could have passed against code that no longer existed.

**Deferred.** `require-await` is disabled for testkit — a fake implementing an async port is synchronous underneath, so the async signature is required by the interface and there is nothing to await.

**Size.** `fake-discord.ts` is 531 lines against `docs/20`'s ~400 guidance. Slice 3 was already split into 3a and 3b for this reason; the fake is one cohesive object implementing one interface and splitting it further would produce two halves neither of which works alone. Flagged rather than quietly exceeded.

---

## WP2 / correction 1 — snowflake type safety, and what STRICT actually does — 2026-08-23

Bryan's review reversed my WP1 decision to drop STRICT and gave me two options: hand-edit the migrations, or add a runtime guard plus a branded Zod type. I built both, because measuring first showed each closes a different hole and neither closes the other's.

**What I measured before changing anything.** Three probes against better-sqlite3:

1. **STRICT does not reject a number in a TEXT column.** `INSERT INTO strict_table(text_col) VALUES (<number>)` is ACCEPTED and stored as `"1.2345678901234568e+18"`. SQLite's STRICT rules permit lossless INTEGER/REAL-to-TEXT conversion, which is the same coercion affinity performs. So the stated mechanism for the snowflake half of the correction does not hold.
2. **What actually rejected the number under the WP1 schema was the format CHECK**, and by accident. better-sqlite3 binds an unsafe JS integer as REAL, REAL-to-TEXT renders exponential notation, and that fails the GLOB. Correct outcome, reasoning I never did.
3. **The undetectable path is neither.** `String(Number(1234567890123456789n))` is `"1234567890123456800"` — nineteen digits, digits only, passes every check we could write, and is the wrong id. No constraint can catch it. Only a refusal at the point where the value was still a number can.

**So the layers are, weakest last.**

- `parseSnowflakeId` / `parseGuildId` in `packages/core/src/ids.ts` refuse a `number` or `bigint` at any parse boundary with a message saying the digits are already unrecoverable. **This is the control.** Branded output, so the parse is hard to forget; the brand is not a boundary and the lint rule now bans casts onto `SnowflakeId` alongside `Authorized`, `GuildScope`, `GuildId`.
- The `snowflake()` column is now a drizzle `customType` whose `toDriver` throws `SnowflakeTypeError` naming the column. Defence in depth on the write path, and the useful-message-at-the-call-site property Bryan wanted.
- The format CHECK is tightened. `GLOB '[0-9]*'` anchored only the first character, so `'1234567890123456abc'` and `'123456789012345 78'` both passed it in WP1. Now `NOT GLOB '*[^0-9]*'`.
- STRICT is back, for the reason the correction's second half gives and the first half does not: `attempts = 'lots'` into an INTEGER column was accepted and is now `SQLITE_CONSTRAINT_DATATYPE`.
- A fourth layer found by accident: eslint's `no-loss-of-precision` rejects a snowflake *literal* in source. It fired on my own test fixtures, which is why they now compute the corruption via `Number(REAL)` rather than writing it out. It only sees literals, so it is a bonus, not a control.

**STRICT is tooling, not a hand-edit.** `scripts/strictify.mjs` rewrites drizzle-kit's output after generation and is wired into `npm run db:generate`. Hand-editing works — the drizzle migrator gates on `created_at` from the journal and never re-hashes an applied migration, so an edited file is safe — but it has to be remembered on every future migration. The script makes it the default and the invariant test (next slice) makes a regression a build failure.

**Broke, to check the tests.**

1. `toDriver` returns the value unguarded → 3 tests failed (number refused, message names the column, bigint refused).
2. CHECK reverted to `GLOB '[0-9]*'` → 2 failed (digits-then-letters, digits-with-a-space).
3. STRICT stripped from the migration SQL → 1 failed (text into an INTEGER column).
4. Number branch removed from the Zod error map → 4 failed, including the JSON-payload round-trip test.

Each restored from a verified copy and re-run; md5 checked against the pre-mutation baseline, per the slice 3a lesson.

**One migration, regenerated.** WP1's `0000_flat_orphan.sql` is replaced by a single `0000_cheerful_tyrannus.sql` rather than a follow-up migration. Nothing is deployed, so the incremental record would encode only the order I happened to write things. **Any existing dev database must be deleted and re-migrated** — the migration name changed, so `db:migrate` on an old file will not do the right thing.

**Gotcha worth recording.** `drizzle-kit generate` fails if `drizzle/meta/` exists but is empty; it wants the directory absent or holding a journal. Deleting the journal alone leaves generation broken with an unhelpful `open` error.

113 tests green; typecheck and lint pass.
