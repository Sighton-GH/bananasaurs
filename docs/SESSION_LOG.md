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

---

## WP2 / correction 3 — what actually enforces a package boundary — 2026-08-23

Bryan asked me to choose between packaging the REST port so only `core/effects` can structurally depend on it, or accepting `dependency-cruiser` as a justified devDependency. I measured the premise first and neither option is the right answer, because the premise — that workspace manifests already enforce the simpler boundaries — is false.

**The measurement.** `packages/core/src/boundary-probe.ts` importing `better-sqlite3`, which `core/package.json` does not list: `npx tsc -p packages/core/tsconfig.json` exits 0. `packages/testkit` importing `@bananasaurs/storage`, which testkit does not list: exits 0. `node_modules/@bananasaurs/` holds a symlink to every workspace package, and external deps are hoisted to the root. **Both Node and TypeScript resolve through the root regardless of any manifest.** WP1 shipped with no boundary enforcement of any kind, and `docs/19` §1 asserted an enforcement mechanism that has never worked.

**Why not a package split.** `package.json` `exports` controls which subpaths are importable, uniformly, by everyone. It has no notion of who is importing. There is no arrangement of packages under npm workspaces in which `core/effects` can reach a module and `http` cannot.

**Why not `dependency-cruiser`.** It would work. It is also a new devDependency and `docs/20` makes that a stop-and-ask, and it is not worth spending that stop when every rule we actually have is a direct-import statement that ESLint already expresses.

**What landed.** ADR 0014, plus per-directory `@typescript-eslint/no-restricted-imports` blocks in `eslint.config.js` covering `core`, `core/src/effects`, `http`, `cli`, `dashboard`, `discord` and `testkit`. Rules for packages that do not exist yet resolve fine and bite the moment the directory appears, which is what Bryan asked for — WP5 inherits enforcement rather than remembering to add it. `packages/discord`'s `exports` will expose exactly `.` and `./rest`, so `exports` handles "no sneaking in by file path" and the lint rule handles "who".

**A regression I nearly shipped, and the test that now catches it.** My first version used the base `no-restricted-imports` rule id for the boundary blocks. Flat config resolves a repeated rule id by last-wins *per rule*, so every per-directory block would have silently replaced the global ADR 0013 `child_process` ban — removing it from exactly the directories that most need it. Switching the boundary rules to the `@typescript-eslint/` rule id keeps both. `packages/core/src/boundaries.test.ts` asserts the process ban survives in four directories that also carry boundary rules.

**Broke, to check the tests.**

5. Removed the REST-port ban from the `packages/http` block → `http cannot import it` failed.
6. Reverted the boundary rules to the base rule id → 28 tests failed, including all four `child_process is still banned in …` assertions. That is the regression above, reproduced deliberately.

Restored from a verified copy; 30 boundary tests green.

**Also corrected in place.** `docs/19` §1's enforcement sentence and §5's fifth layer both described `dependency-cruiser` and manifest-based enforcement. Both now describe what is true and link ADR 0014.

**Scope note.** `apps/daemon` is deliberately *not* restricted from the REST port. The composition root has to know concrete implementations — that is its stated purpose in `docs/19` §1. If WP5 finds the daemon can take a factory from the public entrypoint instead, tighten it then; I am not writing a rule I already expect to need disabling.

143 tests green; typecheck and lint pass.

---

## WP2 / slice 2b — the invariant test first, then the twenty tables — 2026-08-23

Correction 2: the schema invariant test was written and committed **before** any of the tables it governs, against `guilds` alone, and the tables were added in five groups with the test run after each.

**Why the order matters, demonstrated rather than argued.** When the auth group landed, the test failed immediately on `dashboard_sessions` — its primary key is the session token and does not lead with `guild_id`. Written afterwards, that would have been a line in an audit I performed on my own work and could have rationalised. Written first, it stopped the build and forced the exemption to be a deliberate edit with a reason attached: a session is looked up by its token *before* the guild is known, so guild-scoping that index would mean trusting a client-supplied guild in order to authenticate the session. That is the only entry in `UNIQUE_BY_DESIGN`.

**Verified the test catches, before trusting it with twenty tables.** A probe table with no `guild_id`, a unique index led by the wrong column, an unchecked snowflake column, and STRICT stripped from its migration failed four separate assertions. Removed, and the schema regenerated clean.

**The five invariants**, read from the live schema rather than from `schema.ts`: every table STRICT; every guild-partitioned table carries `guild_id TEXT NOT NULL`; every foreign key into a guild-partitioned table includes `guild_id`; every unique index leads with `guild_id`; every snowflake column has a format CHECK. Plus two guards against vacuous success — an empty table list would make every loop trivially true.

**Groups, in order:** panels (`managed_roles`, `panels`, `panel_options`, `panel_blocked_roles`) → 27 green; effects and idempotency (`effect_batches`, `role_effects`, `managed_role_assignments`) → 42; pipeline, jobs and audit (`event_dedupe`, `gateway_gaps`, `jobs`, `audit_events`) → 62; log routing and dashboard auth (`log_routes`, `log_excluded_channels`, `dashboard_accounts`, `account_guild_access`, `dashboard_sessions`, `bootstrap_tokens`, `principals`, `capability_grants`) → 96.

**Three deliberate deviations from the plan's SQL.**

1. `account_guild_access` is keyed `(guild_id, account_id)` rather than `(account_id, guild_id)`, so the partition key leads and no exemption is needed. The reversed order costs nothing: the table holds a handful of rows and the login-time query is not hot.
2. Two constraints added that the plan expressed only in prose. `panels_single_choice_is_managed` enforces collision 1 from §6.3 — `single_choice` cannot work on an adopted panel, because removing another emoji's reaction on someone else's behalf is not possible. `panels_max_roles_positive` rejects a nonsense limit. Both were code-level validations in the plan; a CHECK cannot be forgotten.
3. Two indexes the plan does not name. `role_effects_recent (guild_id, user_id, role_id, completed_at)` supports amendment 5's feedback-loop filter — the `GUILD_MEMBER_UPDATE` handler has to look for a recent effect on that triple, and without an index that is a scan on the busiest table. `dashboard_sessions_by_account (guild_id, account_id)` supports session listing and revocation.

**No foreign key on `event_dedupe` or `gateway_gaps`, deliberately**, matching the plan. Both are written by the pipeline at a point where the `guilds` row may not exist yet — a reconnect delivers events around `GUILD_CREATE` — and a constraint failure there would drop the very event being recorded. `event_dedupe` is bounded by the sweep job instead.

**One migration, not five.** The incremental migrations from each group were consolidated into a single `0000_white_living_lightning.sql`: 20 CREATE TABLE, 20 STRICT. Nothing is deployed, so four intermediate states that have never existed anywhere are noise, and the WP6 restore drill is simpler against one file.

**Verified against a real file database**, not only in-memory: `npm run build && BANANASAURS_DB_PATH=… npm run db:migrate` produces 20 tables, all STRICT, in WAL.

239 tests green; typecheck and lint pass.

---

## WP2 / slice 2b (3/3) — the write() guard and guild-scoped repositories — 2026-08-23

**`write()` makes the dangerous thing unrepresentable rather than discouraged.** The threat is threat B from `docs/19` §6.2, and it is the one neither ADR 0008 nor `docs/02` mentions: better-sqlite3 being synchronous does not protect a transaction that stays open across an `await`. `db.exec('BEGIN')` → `await discord.addRole(...)` → `COMMIT` yields the event loop with the transaction open, and another task's writes land inside it.

The callback's return type is `NotPromise<T>`, so `Promise<T>` resolves to `never` and an async callback is not assignable. There is no runtime check to forget and no lint rule to disable. Verified both ways: `@ts-expect-error` on the async call site, and a second case for a plain function that returns a promise without the `async` keyword — the keyword is not what is caught, the return type is.

**Guild scope is structural in two ways that were not true before.**

1. The database handle is unreachable outside the storage package. `dbOf` is not re-exported from `index.ts`, so `core`, `http` and `cli` can only read a row through a repository function, and every repository function takes a `GuildScope` first. The handle rides on a WeakMap rather than a property, because a property named `db` on the scope would be reachable by anything holding a scope — which is precisely what the boundary exists to prevent.
2. `scope.only(table)` accepts only tables carrying a `guild_id` column, so passing an instance-level table is a compile error rather than a silently unscoped query. Asserted with `@ts-expect-error` against `dashboard_accounts`.

A fabricated scope — a plain object satisfying the interface — throws rather than reaching an arbitrary database.

**Broke, to check the tests.**

7. Removed the readonly check from `write()` → 2 failed.
8. `scope.only()` dropped the guild predicate → 2 failed.
9. `NotPromise<T>` replaced with `T` → typecheck failed on both `@ts-expect-error` directives becoming unused. This is the mutation that matters: the guard is a type, so its test is a typecheck, and it is worth knowing that it fails loudly.
10. `upsertGuild` reset `killswitch`, `dry_run` and `breaker_state` on conflict → 3 failed.

**Mutation 8 found a hole in my own test, which is the point of doing this.** Dropping the guild predicate only broke the calls that passed extra conditions; the isolation test, which passes none, still passed — because `and()` with no arguments returns undefined and fell through to the fallback. So the isolation test was not yet proven to be anything more than decoration. Mutation 8b made `only()` a tautology in every case, and it failed. Recorded because a mutation that only half-fails is a weaker signal than it looks.

**One design note worth keeping.** `upsertGuild`'s conflict clause is deliberately narrow — name and timestamp only. A reconnect replays `GUILD_CREATE` for every guild, so a broad upsert would silently re-enable a bot someone had deliberately kill-switched, on every reconnect. Kill switch, dry-run and breaker state are operator state, not gateway state.

260 tests green; typecheck and lint pass.

---

## WP2 / slice 4a — the event pipeline and the dedupe that could not exist as specified — 2026-08-23

**The most load-bearing error in the planning documents, fixed.** `docs/02`, `docs/08` and `REVIEW.md` C8 all prescribe *"a unique index on `(guild_id, discord_event_id)`"*. That cannot be implemented: **Discord gateway dispatches carry no event ID.** `MESSAGE_REACTION_ADD` has no id field at all, and the `s` sequence number is per-session and resets on reconnect — so it identifies nothing across the reconnect that deduplication exists to survive. Six documents build on this.

What replaced it is a fingerprint derived per event kind, and — for the kinds where no honest fingerprint exists — no deduplication at all.

| Event | Fingerprint |
|---|---|
| `interaction` | the interaction id, a real snowflake |
| `messageUpdate` | sha256(message ‖ editedTimestamp) |
| `messageDelete` | sha256(message) — deletion is terminal |
| `memberAdd` / `memberRemove` | sha256(kind ‖ user ‖ joinedAt, or a one-minute bucket) |
| `roleCreate` / `roleDelete` | sha256(kind ‖ role) — a role id is created and deleted once |
| everything else | **not deduplicated** |

**Reactions are deliberately absent and that is the decision worth defending.** `(message, user, emoji, action)` is not unique over time — a member may add, remove and re-add a reaction, all legitimately. Any time bucket is a guess, and a wrong guess silently drops a real action. So reactions are level-triggered: the event is a hint that state may have changed, and convergence recomputes. `memberUpdate`, `roleUpdate` and `guildCreate` are level-triggered for the same reason — `guildCreate` fires on every reconnect and we *want* the allowlist re-checked each time.

**Gate ordering is load-bearing and is tested as such.** The allowlist runs before deduplication because deduplication *writes*, and writing rows for a guild we are leaving is exactly what the allowlist exists to prevent. A separate test asserts no dedupe row is created for an unlisted guild.

**Two behaviours that are easy to get wrong.** The pipeline leaves an unlisted guild once, not once per event — without that, a busy unlisted guild produces one REST call per dispatch. And the departure set is process-local on purpose, so a failed leave is retried after a restart; a test drives a failing leave followed by a successful one.

**Subscribers are isolated.** The logging module going wrong must not take role panels down with it. A throwing subscriber does not roll back the dedupe row either — retry belongs to the job table, not to redelivery through a subscriber that will probably throw again.

`joinedAtMs` was added to `MemberEvent`, since neither `GUILD_MEMBER_ADD` nor `GUILD_MEMBER_REMOVE` carries an id and the join timestamp is what identifies them. The compiler caught the fake harness immediately, which is the `implements DiscordPort` discipline from slice 3b paying off; `emitMemberAdd` and `emitMemberRemove` were added alongside.

**Broke, to check the tests.**

11. Removed the subscriber try/catch → 3 failed.
12. Dropped the leave-once guard → 1 failed.
13. Invented a reaction fingerprint — the exact "fix" someone would apply → 3 failed across both files.
14. Ran the dedupe gate before the allowlist gate → 6 failed.
15. `recordFirstSight` always returned true → 1 failed.

**A green suite is not evidence, demonstrated on my own work.** My fingerprint test helpers took `Partial<Extract<DomainEvent, { kind: 'memberAdd' }>>`, which looks right and resolves to `never` — `MemberEvent['kind']` is itself a union, so `MemberEvent` is not assignable to `{ kind: 'memberAdd' }`. Vitest ran 21 tests happily against it because types are erased; `tsc` and eslint produced 24 errors between them. Caught only because the protocol runs all three. The helpers now take the concrete interfaces.

307 tests green; typecheck and lint exit 0.

---

## WP2 / slice 4b — the job table, the worker, and the sweep — 2026-08-23

**Two decisions in the job table that are easy to get backwards.**

*`attempts` increments on claim, not on failure.* A job that crashes the process — or is killed mid-run — never reaches a failure handler. Counting on failure means it is retried forever and takes the process down every single time. Counting on claim bounds that at `max_attempts`. `requeueStranded` at startup deliberately leaves the incremented count alone for the same reason, so a job that kills the process on every start still terminates rather than looping.

*A failure that a retry cannot fix is marked permanent immediately.* An unregistered job kind will still be unregistered in a minute, and a payload that does not validate never will. Retrying those to exhaustion burns twenty minutes of backoff to reach the same answer and buries the real error under four duplicates. Everything else gets exponential backoff, capped at five minutes so a poisoned job cannot recede beyond notice. An exhausted job stays in the table as `failed` rather than being deleted — silently dropping work is how an outage becomes invisible.

**The claim is guild-scoped, which changed an index.** The plan's `jobs_claim` index was `(state, run_after)`, shaped for a worker claiming across every guild. A cross-guild claim would be the one query in the system able to omit the partition key, which `CLAUDE.md` rule 2 calls a bug even when every caller behaves. The claim is per-guild and the index is now `(guild_id, state, run_after) WHERE state = 'queued'` — indexing what is actually queried rather than what was once imagined.

**A type I got wrong twice before getting right.** `JobWorkerDeps.handlers` was `readonly JobHandler<never>[]`, which looks like the correct existential and is not: `payload` is `PayloadSchema<T>` whose `parse` returns `T`, so `T` is covariant and `JobHandler<{ x: number }>` is not assignable to `JobHandler<never>`. `AnyJobHandler = JobHandler<unknown>` works in both positions — the return type widens, and `run` is declared as a method so its parameter is bivariant. It also deleted three `as unknown as` casts from the test, which is the tell that the first version was wrong rather than merely awkward.

**The worker owns retry, not scheduling.** There is no timer in `core` — only `runOnce` and `drain`. The daemon decides when to call them. `drain` takes a limit because a handler that enqueues its own successor (a resumable pass) would otherwise spin forever and starve the process.

**Integration, against the real database.** The unit tests use in-memory fakes for both stores, which is right for testing behaviour but proves nothing about the SQL — a fake agreeing with itself is not evidence. `apps/daemon/src/pipeline.integration.test.ts` wires the real pipeline, the real repositories and the real worker, and asserts the three outcomes `docs/19` names for this slice: a duplicate produces one delivery (and still does across a simulated restart, because the fingerprint is durable), a fresh IDENTIFY writes a gap and queues reconciliation while a RESUMED one writes the gap and queues nothing, and the dedupe table is swept by a real job. It lives in the daemon because the composition root is the only package allowed to know both `core` and `storage` (ADR 0014). `@bananasaurs/storage/test-support` became a real subpath export to make that possible.

**A flapping connection queues one pass, not one per reconnect** — but every gap is still recorded, because three outages did happen and claiming otherwise would be a lie.

**Broke, to check the tests.**

16. `attempts` incremented on failure instead of claim → 3 failed.
17. `failJob` ignored the permanent flag → 2 failed, one of them in the integration test.
18. Connection subscriber reconciled even on RESUMED → 1 failed.
19. `enqueue` reported success even when deduped → 1 failed.
20. Worker treated an unregistered kind as retryable → 1 failed.

358 tests green; typecheck and lint exit 0.

---

## WP2 / slice 5 — the effect gateway, the safety layers, audit, batches, undo — 2026-08-23

**One chokepoint, twelve layers, in a deliberate order.** Cheap local refusals come before anything costing a REST call; the hierarchy check comes as late as possible because it must reflect the guild *now*; the idempotency claim comes *before* the Discord call, so a process death between claim and call leaves the effect recorded and a replay skips it — the failure direction that does not double-grant.

**Amendment 3, implemented as the control rather than as a type.** `applyRoleEffect` re-runs `authorize()` against `capability_grants` before acting, so a witness obtained by casting fails at runtime. Verified by mutation: deleting the re-check breaks three tests, including one where the grant is revoked after the witness is issued.

The witness itself is built around a **real runtime symbol**, not `declare const`. That distinction earns its keep: with a declared-only symbol, `authorize` would have had to cast to construct a witness, and the one cast in the codebase would sit in the module whose whole job is to be uncastable. A real, unexported symbol means the witness is built honestly and no other module can produce the shape with an object literal.

**The lint tripwire bites.** With `Authorized` now existing, `{} as unknown as Authorized<'roles.mutate'>` produces the expected `no-restricted-syntax` error. Confirmed directly rather than assumed.

**A cast I wrote and then removed, worth recording.** `undoBatch` first took `Authorized<'undo.execute'>` and cast it to the gateway's parameter type with `as unknown as Parameters<EffectGateway['applyRoleEffect']>[0]`. That form **slips past the lint rule**, which matches a named type reference rather than an indirect cast — a real blind spot in the tripwire. The runtime re-check would still have caught a forged witness, but the honest fix was to model what is actually required: undoing role effects needs the right to undo *and* the right to mutate roles, so `UndoAuthorization` carries both. The undo actor is now read from the undo witness rather than from caller-supplied input, so the audit trail records who was authorized rather than who claimed to be.

**Undo is a replay of the inverse through the same gateway**, not a separate path. The kill switch, breaker, hierarchy check, rate cap and dry-run all apply to an undo exactly as to the action it reverses — an undo that could bypass the kill switch would be a second, unaudited way to change roles. Tested directly.

**`had_role_before` is the whole basis of the inverse**, and the truth table is exported and tested on its own: reverse a grant only if we actually added the role, reverse a revoke only if we actually removed one, and never reverse a dry run, a failure or a skip. The failure it prevents is stripping a role a member has held for a year because an unrelated batch happened to touch it.

**The rate cap and the adoption allowance.** docs/18 Layer 3 as amended: a standing per-source ceiling plus named allowances a human sized and approved for a specific change list. Allowance is spent *before* the standing budget, deliberately — otherwise an approved batch competes with ordinary member activity halfway through and finishes late or not at all. Overflow trips the breaker durably rather than waiting, because overflow is evidence something is wrong.

**A no-op costs nothing.** Convergence runs constantly and is mostly no-ops; charging rate budget for them would exhaust the cap without a single real change. Tested.

**`protected` means two things, and the plan states both without naming the difference.** Both are implemented: as *target*, the bot will not mutate that member or role; as *actor*, that principal holds no capability at all. The second surfaced by failing my own test — marking the acting member protected locked them out before the target check ran. That is the anti-nuke posture working as designed, and also a real footgun if the owner protects their own role. Flagged in the report rather than silently chosen.

**Two test layers, deliberately.** `packages/testkit/src/gateway.integration.test.ts` (46 tests) proves the ordering of the layers with in-memory ports and the fake Discord harness. `apps/daemon/src/effects.integration.test.ts` (16 tests) proves the parts only SQL can: that `role_effects_dedupe` really makes a replay a no-op, that the foreign key into `managed_roles` really is the allowlist, that a cross-guild batch reference really raises `SQLITE_CONSTRAINT_FOREIGNKEY`, and that an audit row is really written. A fake claiming "already claimed" agrees with itself for free; a UNIQUE index either exists or it does not.

**Broke, to check the tests.**

21. Gateway trusted the witness instead of re-verifying → 3 failed.
22. Dry run still made the REST call → 3 failed across both test layers.
23. Idempotency claim moved after the REST call → 2 failed, including the real-SQL one.
24. `inverseOf` ignored `had_role_before` → 4 failed, including "does not strip a role the member already had".
25. Kill switch check removed → 2 failed, one of them the undo path.
26. Rate cap refused without tripping the breaker → 1 failed.

445 tests green; typecheck and lint exit 0.

---

## WP2 / slice 5 addendum — the reconciliation budget — 2026-08-23

**The budget is a count checked before acting; the rate cap is a rate enforced during.** They are easy to conflate and the difference is the point. By the time the rate cap refuses, some actions have already happened. The budget refuses the whole change list before any of it happens.

A reconciliation pass that discovers a thousand drifted members is far more likely to be a bug in our diff, a mid-outage Discord API, or a role deleted and recreated, than a thousand members who each independently changed their mind. Applying the first twenty-five and stopping would leave the guild in a state nobody chose — so an oversized list is refused **outright**. Refusing does not discard the finding: the count is reported so a human can preview it and, if it is genuinely correct, approve it as a named allowance.

`checkReconcileBudget` takes the whole change list rather than a count, so a caller cannot pass a number it computed from something other than the work it is about to do.

**Broke, to check the tests.** 27. Removed the over-budget branch so the check always passed → 2 failed.

**And the slice 3a lesson repeated itself.** `git checkout -- budget.ts` silently did nothing, because the file was untracked and git had nothing to restore. Caught by checking `git status` after the restore rather than trusting the command's exit code. Restoring untracked files needs a real copy, every time.

**Unrelated cleanup found while committing.** Four `tsconfig.tsbuildinfo` files were tracked in git from WP1 — build artifacts that change on every compile. `.gitignore` covers `dist/` but these sit next to `tsconfig.json`. Added `*.tsbuildinfo` and untracked them.

451 tests green; typecheck and lint exit 0.

---

## WP2 boundary follow-up — `protected` is target-only — 2026-08-23

Owner review settled the one decision the WP2 report asked for. `protected` means exactly one thing: the bot will not mutate that member or role. It no longer denies capability to an actor.

**Why it mattered.** The plan stated both readings in different sections and never distinguished them, so WP2 implemented both — and the actor-side one surfaced by failing its own test, because marking the acting member protected denied them capability before the target check ran. The anti-nuke property it provided is real, but so is the footgun: protecting the role you administer the bot through locks you out. A safety flag whose misuse causes an outage is a flag people stop setting.

**What changed.** `anyProtected` is removed from the `AuthzStore` port entirely rather than left unused — a dormant method is something the next person wires back up by accident. `'protected-principal'` is gone from `DenialReason` because nothing produces it. The storage implementation is deleted; `isTargetProtected` stays and is now the only meaning.

**The anti-nuke property is not gone, it moved.** ADR 0012 already means Administrator grants nothing, so a compromised role holds capability only if someone explicitly granted it, and `revokeCapability` removes that in one call with an audit row. Disarming a principal is now a deliberate act rather than a side effect of a flag whose primary meaning is something else. ADR 0015 records that if the flag-based version is ever wanted, it needs its own name.

**Broke, to check the test.** 28. Re-added the actor-side check behind an optional `anyProtected` → the new test ("does NOT deny capability to a protected actor") failed. Restored; md5 verified against the pre-mutation copy.

**Documents corrected in place.** `docs/19` §5's sentence claiming `authorize()` refuses protected principals no longer matched the code and would have misled the next reader.

451 tests green; typecheck and lint exit 0.

---

## WP3 slice 7a — a job dedupe key collapses pending work, not history — 2026-08-23

Found before writing a line of WP3, by probing the queue WP3 was about to build on rather than reading it.

**`jobs_dedupe` was `UNIQUE (guild_id, dedupe_key)` over every state, and job rows are never deleted.** So a dedupe key was single-use for the lifetime of the database:

```
first enqueue                  : {"enqueued":true,"jobId":1}
job state after completion     : done
second enqueue after completion: {"enqueued":false}
```

**What that breaks is exactly WP3's work.** `createConnectionSubscriber` always enqueues with `reconcile_guild:gateway-gap`. The second gateway gap ever would enqueue nothing, and the reaction drift that outage caused would never be repaired — while the log line said `reconcile-already-queued` about a job that finished days ago. The periodic timer pass could run once. The adoption pass could run once per panel, forever.

**The bug was in the index, not the callers.** Every caller is written the way the dedupe key is documented to work, and the failure is silent by construction: `onConflictDoNothing` is how the collapse is implemented, so a collapse and a permanent block are the same `{enqueued: false}` at the call site.

**Fixed as a partial unique index** over `state IN ('queued','running')` — ADR 0016. Second request while queued or running still collapses, which is the property the key exists for; a request for finished, failed or cancelled work enqueues afresh, which is the property the callers assume. Still leads with `guild_id`, so the schema invariant holds.

Shipped as `0001_bright_the_leader.sql` rather than by editing `0000`, which has already been applied to a database.

**Broke, to check the tests.** 29. The mutation was the pre-fix state itself: tests written first against the unconditional index, 3 of 5 failed (`accepts the same work again once the first has completed` / `has permanently failed` / `was cancelled`), and the two asserting the collapse passed throughout — so the tests distinguish the property being kept from the one being fixed, rather than just tracking the change.

456 tests green; typecheck and lint exit 0.

---

## WP3 slice 7b — what a panel is, and where it lives — 2026-08-23

Slice 7 as planned was about 770 lines of implementation. `docs/20` says a slice needing more than roughly 400 means the slice was mis-sized, so it was split rather than written: **7b is the panel model and its storage**, 7c is reaction convergence.

**`PanelConfig` and `panelDefinitionSchema` in `core/src/panels/model.ts`.** One validator every panel definition passes, whether it arrives from the CLI, the dashboard, or a row written by an older version of this process — `CLAUDE.md` rule 3 does not distinguish those.

**Several rules are both a validator and a CHECK, deliberately.** The constraint is the guarantee: it cannot be forgotten by a caller written next year. The validator is the *explanation*. `docs/19` §6.3 asks that `single_choice` + adopted be refused "with a message that says why and points at button panels, rather than failing a constraint with a raw SQL error" — so the message names Manage Messages, says the reaction would stay and the next reconciliation would re-grant the old role, and points at button panels. A test asserts the message content, not just the refusal.

**The repository takes `PanelDefinition`, not an object literal.** That is the Zod *output* type, which carries branded snowflakes and cannot be constructed without parsing. So passing an unvalidated panel to `createPanel` is a compile error rather than a convention.

**`createPanel` is one `write()`.** Not tidiness: a panel visible with two of its three options has a smaller desired set than it should, and convergence would revoke the third role. There is a test that inserts a panel whose last option names a non-allowlisted role and asserts the panel is not visible at all afterwards.

**Reads parse rather than assert.** A snowflake coming back out of SQLite goes through `parseSnowflakeId`, because a row written by an older version is input from outside the function. Casting to `SnowflakeId` is banned by the lint tripwire anyway, and this is exactly the spot where someone would have written one.

**Broke, to check the tests.** 30. Removed `scope.only(...)` from `findPanel`'s WHERE, leaving the bare `panel_id` predicate — the "every current caller passes it" bug `CLAUDE.md` rule 2 describes → 2 failed (`does not find another guild's panel by id`, `permits the same panel id in two guilds`). 31. Disabled the collision-1 refinement → 2 failed, including the one asserting the owner-facing message. Both restored; md5 verified against pre-mutation copies.

512 tests green; typecheck and lint exit 0.

---

## WP3 slice 7c — a reaction becomes a role — 2026-08-23

The convergence core, the reaction subscriber, emoji seeding, and the first end-to-end panel on the fake gateway.

**One convergence function, three callers.** `planConvergence` is pure and takes the panel, the member's selection and the member's **live Discord roles**. Live events, the adoption pass and reconciliation all call it — `docs/19` §4's point that drift repair is the same code path, not a second implementation with its own bugs. Because it is pure, its tests are a table rather than a harness.

**The three behaviours turned out to be one rule with the ends clipped.**

```
toggle       desired = asked
add_only     desired = asked ∪ held    — never revokes
remove_only  desired = asked ∩ held    — never grants
```

Written that way rather than as three branches because the symmetry is the property worth keeping: "add_only un-reacting must not revoke" and "remove_only reacting must not grant" are the same statement, and three branches would let them drift apart.

**Amendment 6 is a parameter, not a special case.** `limitToOptionIds` restricts a pass to the options it actually looked at. A toggle/add_only/remove_only panel without `max_roles` decides each option independently, so a reaction event is limited to the single emoji it carried and costs **no** REST call — a test asserts `fetchReactionUsers` is never called. Without the limit, a reaction on one emoji would compute an empty selection for every *other* option and revoke them all: every reaction would strip every other role on the panel. That is the bug the parameter exists to make impossible, and it has its own test.

**`max_roles` clamps by stability, not by position.** Roles the member already holds and still wants keep their place; the remainder fills in display order. Clamping by position alone would revoke a role held for a month because somebody reacted to an option that sorts earlier. There is a test that runs the pass over its own output and asserts nothing changes — without stability, convergence would flap.

**Panel-level refusals keep what the member already has.** A disabled panel, a missing required role or a blocked role means "this member may not use this panel right now", not "this member should hold nothing from it". Stripping would turn acquiring a blocked role into a silent mass revocation.

**Panels get a narrower Discord port than the gateway does.** `PanelDiscordReader` has `fetchMember`, `fetchMessage`, `createReaction` and `fetchReactionUsers` — and no `addRole` or `removeRole`. `DiscordPort` structurally satisfies it, so the daemon hands over the same object, but the type panel code sees cannot mutate a role. "Panels change roles only through the gateway" becomes a property of the signature rather than a rule to remember, with ADR 0014's lint rule and the gateway's runtime re-verification still underneath.

**The actor for a panel change is `system`, not the member.** A member holds no `roles.mutate` grant and must not need one; requiring it would mean granting every member the capability to change roles. The authorization is the panel — an owner with `panels.manage` created it, enabled it, and chose its roles. Nothing about who acted is lost: the member is the audit row's subject, which for a panel is the same person.

**Memoisation is per pass, and deliberately not shared across live events.** `docs/19` §6.4 asks for memoising so "a burst on the same panel does not refetch". Per pass — adoption or reconciliation walking many members against one snapshot — that is exactly what `ReactionStateCache` does. Carrying it across separate live events would be a correctness bug, not an optimisation: the next event is usually the very member whose reaction is missing from the cached set, and they would be silently denied the role they just asked for.

**Broke, to check the tests.** 32. Made `inScope` return true unconditionally, ignoring `limitToOptionIds` → 3 failed, including the end-to-end "leaves a role from another option alone". 33. Removed the bot-user filter from the subscriber → "ignores our own seeded reaction" failed, which is the bot granting itself a role the moment it seeds a panel. 34. Replaced `currentRoleIds: new Set(member.roleIds)` with an empty set — convergence no longer reading live Discord roles, i.e. amendment 4 undone → 3 failed. All restored; md5 verified against pre-mutation copies, full suite re-run green.

**Worth recording about mutation 34.** "A replayed reaction is free" did *not* fail under it, because that property is enforced by the effect gateway's no-op check rather than by convergence. That is the correct division of labour, but it means the replay tests do not test convergence — the ones that do are the revoke tests.

565 tests green; typecheck and lint exit 0.

---

## WP3 slice 8 — the adoption pass, and a fake that was lying — 2026-08-23

Collision 2 from `docs/19` §6.4, plus the most useful thing the mutation check has found so far.

**The pass computes its whole change list before touching anything.** Existing reactions *are* the intended role state, so adoption pages `fetchReactionUsers` for every mapped emoji, fetches each reactor's live roles, and runs the same `planConvergence` that live events use. Only then does it look at the allowance.

**Without an allowance it does nothing at all** — not "starts and stops", *nothing*. It stores the change list, sets `adoption_pass_state='pending'` and returns. Tests assert zero REST calls, zero effect rows and zero roles changed. An allowance one short of the list is still a refusal.

**The allowance is spent instead of the standing cap**, which is what makes adoption possible under a 20/minute ceiling at all. The test for that started out weak: `available()` reads 20 whether the bucket spent 12 allowance or 12 standing tokens, because it returns tokens + allowance either way. Rewritten to drain the bucket and count — the standing 20 must all still be there.

**Refusing is the finished behaviour for WP3.** The CLI that lets Bryan size and grant the allowance is slice 13 in WP5. No Discord-side confirmation was built, deliberately: a mass-role-grant trigger reachable from Discord is exactly the surface `docs/18` wants smallest.

**ADR 0016 turned out to be load-bearing here too.** The whole cycle is *run → refuse → owner grants → run again*, and the second run is a second job with the same dedupe key. Under the WP2 index that enqueue was a silent no-op, so adoption could never have completed. There is now a test for the full cycle.

### The fake was modelling Discord wrongly, and a decoration test hid it

**Mutation 37 removed the filter that drops the bot's own seeded reactions — and every test still passed.**

Two independent faults, both of which had to be fixed before the mutation would bite:

1. **`FakeDiscord.fetchReactionUsers` filtered out `BOT_USER_ID`**, and WP1 wrote a test asserting it *should*. Discord does no such thing: `GET /reactions` returns every user who reacted, bot accounts included. The harness was doing the application's job, so the application's filter was never exercised. Without it, adopting a panel grants the bot every role it just seeded. Fake corrected, and its test now asserts the bot **is** returned, with the reason written down.

2. **Even against the corrected fake the test still passed**, because it only asserted `memberRoles(BOT_USER_ID) === []`. With the bot counted, the change list became 13 against an allowance of 12, so the pass refused — and refusing also leaves the bot without roles. The test was watching the allowance gate fire and reading it as the filter working. Rewritten to grant a generous allowance and assert `memberCount` and `changeCount` directly.

This is exactly the failure `docs/20` describes: a test that passes regardless of whether the feature works. It took three attempts at the same mutation to get a test that fails for the right reason, and it is worth saying that the first two attempts *looked* fine.

**Broke, to check the tests.** 35. Removed the allowance gate → 5 failed, including the ADR 0016 cycle test. 36. Made `pageReactors` return after the first page → the paging test failed (a real panel would have adopted only its first 100 reactors). 37. Removed the bot filter → passed twice, then failed once the fake and the test were corrected. All restored; md5 verified.

584 tests green; typecheck and lint exit 0.

---

## WP3 slice 9a — what a managed panel looks like on Discord — 2026-08-23

Slice 9 split again on the 400-line rule: 9a is the interaction port, the harness's interaction deadlines, custom ids, component rendering and posting/editing; 9b is the interaction handler itself.

**`InteractionEvent` now carries a `token`, which is a credential.** It is how a response is addressed, it is valid for fifteen minutes, and anyone holding it can act with it. It is deliberately absent from `LOGGABLE_FIELDS`, so `safeLogFields` drops it, and pino's `redact` covers `token` as a second layer. The port takes an `InteractionRef` of `{interactionId, token}` so the token travels only between the adapter and the port.

**The harness now enforces Discord's interaction deadlines**, which `docs/REVIEWING_AGENT_OUTPUT.md` lists as a trap: three seconds to acknowledge, fifteen minutes to follow up, and a missed acknowledgement **discards the token** rather than queueing — the member sees "This interaction failed" whatever the bot does next. The fake refuses a late defer with 10062, refuses an undeferred slow reply, allows a slow follow-up once deferred, and refuses a wrong token. Without this the handler could do the work first and reply second and every test would pass.

**A custom id is a lookup key, never an instruction.** It is the only thing Discord returns from a click, and it comes back *from the client*, so a crafted interaction can carry anything. Parsing is a Zod schema rather than a `split(':')`, and the ids it yields are then looked up in the panel's own configuration — a custom id naming a panel that does not exist resolves to nothing. Tests cover another bot's component, missing segments, empty ids, an over-length id, and an extra segment a crafted payload could append.

**Components are wire shapes, not discord.js builders**, because `core` may not import discord.js (ADR 0014). That also makes a panel's rendering assertable with no client: buttons wrap at five to a row, a select menu gets `min_values: 0` so a choice is not a one-way door, and `single_choice` caps `max_values` at 1. Canonical emoji keys are turned back into what Discord expects — `u:1f9e0` to the character, `c:<id>` to `{id}` — and an option with no emoji omits the field rather than sending null, which Discord rejects.

**Posting and editing prove the asymmetry that justifies two panel kinds.** A bot may edit its own message and no one else's, so `editManagedPanel` refuses an adopted panel with a stated reason rather than letting Discord answer 50013. There is a test at the port level showing Discord's actual refusal, next to the one showing our earlier and clearer one.

**Broke, to check the tests.** 38. Loosened custom id parsing from `parts.length !== 3` to `< 3`, accepting appended segments → the crafted-payload test failed. 39. Removed the three-second check from the fake's `deferInteraction` → the deadline test failed, which matters because that check is what will make 9b's "defer first" testable at all. Both restored; md5 verified.

619 tests green; typecheck and lint exit 0.

---

## WP3 slice 9b — a click becomes a role, and the member is told the truth — 2026-08-23

**Identify, then defer, then work.** Discord gives three seconds to acknowledge and discards the token if it is missed. A role change is a member fetch, a role fetch and a REST call, so acknowledgement cannot wait for it. Identification comes *before* the defer and is entirely in-process — parse the custom id, look the panel up by message — so we never acknowledge an interaction belonging to another bot.

**The message is the authority, not the custom id.** The panel is resolved from `findPanelByMessage`, and the custom id must agree with it. A crafted interaction naming a different panel is logged and dropped. An option the panel no longer offers — a button left on a message from before an edit — is dropped too.

**The confirmation is built from what the gateway did, never from what the plan wanted.** `applyPlan` now returns `appliedChanges`, the intents that actually came back `applied`. Under dry run, a tripped breaker or a hierarchy refusal, the plan is full of intentions and nothing happened; a reply built from the plan would tell a member "You now have @Alpha" while they can see they do not. Two tests assert exactly that, and mutation 41 proved they catch it.

**A managed panel's current selection is the roles the member holds.** There are no reactions to read, so `selectionAfterClick` derives the selection from live roles and flips the clicked option — no REST call beyond the member fetch convergence already needs. `single_choice` is not a toggle: clicking B means "B", not "B as well".

**A select menu speaks for the whole panel**, so its convergence is unlimited and deselecting revokes. A button on an independent-option panel is limited to the option it named (amendment 6). Values arriving from the client are filtered against the panel's own options first.

**Broke, to check the tests.** 40. Moved the defer after the convergence — the classic three-second bug → 2 failed. 41. Built the reply from `plan.grants` instead of `appliedChanges` → the dry-run and gateway-refusal honesty tests failed. Both restored; md5 verified.

**One limitation worth stating.** The fake's clock is manual, so mutation 40 was caught by the explicit ordering assertion rather than by the deadline firing. The harness can prove *that we defer first*; it cannot prove *we are fast enough*, because it does not model latency. That is the right division — real latency is not measurable here — but "the panel responds in time" remains a live smoke test, not a covered one.

637 tests green; typecheck and lint exit 0.

---

## WP3 slice 10 — every behaviour, including its refusal path — 2026-08-23

Almost no new implementation: the behaviours were built in slice 7c as one rule with the ends clipped, and slice 9b covered them on managed panels. This slice is the reaction side end to end, and it is where the design was checked rather than assumed.

**`add_only` makes no REST call for an un-react**, rather than calling and being refused. Worth its own test: "the role stays" is satisfied by both a correct filter and a broken one that calls `removeRole` and gets a 403.

**`remove_only` revokes on un-react and refuses to grant on react.** The symmetry falls out of the direction filter rather than being coded twice.

**`max_roles` on an adopted panel is amendment 6's one expensive path**, and now has an end-to-end test asserting that `fetchReactionUsers` **is** called — the mirror of slice 7c's test asserting it is *not* called for a plain toggle. Between them they pin the amendment down in both directions. There is also a test that a withdrawn reaction frees the slot and the next pass takes it, which only works because convergence reads the whole set.

**Memoisation is asserted by counting**: three mapped emoji, one pass, at most one paged read each. Counting calls rather than trusting the cache means a regression that refetches per emoji per event is a failing test, not a slow log.

**`required_role_id` and blocked roles were exercised across the transitions**, not just in one state: losing the required role stops the panel responding *without stripping* what it already granted, and acquiring a blocked role likewise. That direction matters — the alternative reading would turn a timeout role into a silent mass revocation.

**A panel-level refusal writes no `role_effects` row**, because the refusal happens in convergence before any intent exists. Inventing a row would make that table a log of things that never happened, which is the opposite of what it is for.

**Broke, to check the tests.** 42. Dropped `held` from the `add_only` union, so it began revoking → 3 failed. 43. Disabled the blocked-role gate → 5 failed across the unit and integration suites. Both restored; md5 verified.

655 tests green; typecheck and lint exit 0.

---

## WP3 slice 11 — reconciliation, and two things the tests caught — 2026-08-23

The last WP3 slice: drift repair on the timer and after a gateway gap, the `reconcile_guild` job, and amendment 5's `GUILD_MEMBER_UPDATE` handler. Two of the slice's tests failed on their first run for reasons that were defects rather than wrong expectations, and both are now decisions on the record.

**A pass driven by reactors cannot see a reaction that was withdrawn.** The slice-11 demonstrable is "a 30-minute outage with offline reactions leaves the state correct on return", and half of it failed immediately: a member who un-reacted while the bot was down is in no reaction set, so the pass never visited them and the role stayed. There is no other trace — after a fresh IDENTIFY the dispatch is gone for good. `managed_role_assignments` is the only record that the member ever had the role, and amendment 4 forbids diffing against it. ADR 0017 draws the line the code now follows: the table supplies **the list of members worth looking at**, and nothing else; both sides of the diff are still read live. A stale row makes the pass look at the wrong person, which the gateway's no-op check absorbs for free. It cannot make the pass do the wrong thing.

**The self-mutation filter was too coarse in one direction.** Amendment 5 says to use `effectRepo.wasRecentlyApplied(scope, {userId, roleId, sinceMs})`, and testing it against a real loop — which is what the amendment asked for — showed it answers for the wrong question. Our own grant of a role makes a *removal* of that same role inside the window look like ours too, so a moderator undoing the bot five seconds later was silently ignored until the timer pass. The lookup now takes the direction as well, and the handler carries it with each role in the delta. The loop stays suppressed for the same reason as before (our grant echoes as an addition, and we did grant); the opposite move is visible as the external change it is. Same index, one more predicate.

**The fake now models the echo.** Discord fires `GUILD_MEMBER_UPDATE` for *every* role change, including ones the bot just made over REST — that is the whole reason amendment 5 exists, and a fake that only echoed human changes would have agreed with a broken implementation. `FakeDiscord` queues the dispatch rather than emitting it inline, because the real event arrives over the gateway *after* the REST call returns; emitting synchronously from inside `addRole` would re-enter the pipeline from the middle of the gateway's execute step, an ordering that cannot happen against Discord. `flushMemberUpdates()` drains in a loop, so a runaway shows up as a huge count rather than quietly stopping after one round.

**The budget takes the whole list, before anything.** A pass that finds a thousand drifted members is far likelier to be a bug in our diff, a mid-outage API, or a role deleted and recreated, than a thousand members who each changed their mind. Over budget applies **none** of it, and the job deliberately does not clear the gateway gap it was created for — a guild that needs an owner to look at it must not be hidden behind a job that reported success. Raising the budget takes effect on the next pass with no restart, because the value is read per pass.

**Reconciliation covers adopted panels only.** A managed panel has no independent record of member intent: the only durable trace of a member's last choice *is* the role they hold. Re-adding a role a moderator removed by hand would be the bot overruling a human on the strength of nothing. This is a deliberate narrowing of a `docs/19` §6.3 table cell and is reported in §4 of the WP3 boundary report.

**A panel that can no longer work says so.** A deleted message means no reaction can ever arrive and there is nothing to re-seed, so the panel is disabled by the doctor with a reason and its configuration kept, ready to be pointed at a new message. A deleted role is flagged in `managed_roles` with `unassignable_reason = 'deleted'` — a diagnosis, never a control: the gateway still re-checks hierarchy live before every mutation, and the panel's other options keep working.

**Broke, to check the tests.** 44. Removed the direction predicate from `wasRecentlyApplied` → 3 failed, across the repository test and both repair tests. 45. Dropped the provenance candidates from the reconciliation visit set → 2 failed, including the slice demonstrable. Both restored; md5 verified. (Restoring 44 with `git checkout` also discarded the slice's own edits to that file, which is a mistake worth writing down: mutation restore takes a file copy, not a VCS command.)

**One limitation.** `listManagedRoles` was written and then deleted unused — the doctor that would read it is WP5. Shipping it now would be a speculative export with no caller and no test.

696 tests green; typecheck and lint exit 0.

---

## WP5 slice 6a — packages/discord, client construction, and the ClientOptions assertion — 2026-08-23

The package that has had lint rules waiting for it since ADR 0014 now exists, along with `buildClientOptions` and an assertion that refuses to start on a configuration which would fail silently. `discord.js@14.27.0` is added; ADR 0008 already names it, so no new justification. No connection, no event translation, no REST — those are 6b.

**The assertion reads limits back out of `makeCache`, not out of our own settings object.** `Options.cacheWithLimits` matches a manager **by name** (`node_modules/discord.js/src/util/Options.js:157`), so the settings object is a set of *requests*, not a contract. Asserting on it would agree with a typo. `assertClientOptions` instead calls the configured factory the same way `CachedManager` does and checks the `maxSize` that comes back, so a name discord.js does not recognise shows up as an unlimited `Collection` and fails.

**`client.user` does not exist until READY, so `botUserId` stays a thunk**, and there is now a test that fails if it stops being one: it captures `keepOverLimit` while the id is still `undefined`, then sets it, and asserts the predicate changed its mind. Mutation 48 (reading the id eagerly into a `const`) is invisible to typecheck and to every other test in the file.

**Broke, to check the tests.** 46. Dropped `Partials.Reaction` → 2 failed. 47. Misspelt `ReactionUserManager` as `ReactionUsersManager` → 2 failed, *and* typecheck failed on `CacheSettings`, so that one is caught twice independently. 48. Read `botUserId()` eagerly instead of at call time → 1 failed, the thunk test, alone. 49. Added `GatewayIntentBits.DirectMessages` → 2 failed. All restored by file copy from a backup taken before the first mutation, per the note at the end of slice 11.

735 tests green (696 before this slice); typecheck and lint exit 0.

### Divergences found between the documents, the fake, and real discord.js

These are the point of taking this slice early. Three findings, all measured against the installed 14.27.0 rather than assumed.

**1. `docs/19` §6.1 is wrong about what an unsupported cache limit does, and the truth is worse.** The plan says "a few managers throw when limited". They do not throw. `GuildManager`, `ChannelManager`, `GuildChannelManager`, `RoleManager` and `PermissionOverwriteManager` call `process.emitWarning(..., 'UnsupportedCacheOverwriteWarning')` and then **apply the limit anyway** — measured: a client built with `GuildManager: 5` constructs fine and `client.guilds.cache` is a `LimitedCollection`. So the failure mode is not a crash at startup; it is a bot that runs, looks healthy, and quietly drops guilds, channels and roles out of cache. Worse, three of the five are per-guild managers whose warning does not fire until a guild arrives — after startup, into a process that logs through pino and never reads `process.on('warning')`. `docs/19` §6.1 is amended in place. The five names are exactly the entries commented out of discord.js's own `Caches` interface (`typings/index.d.ts:5976`), so naming one is also a type error; `assertClientOptions` checks it at runtime as well, because the type only helps code that is typechecked.

**2. A cache limit naming a manager that does not exist is silently ignored.** Measured: a client built with `makeCache: Options.cacheWithLimits({ MesageManager: 25 })` constructs with no error and no warning, and gets an unlimited message cache. This is the failure ADR 0008's memory budget is most likely to die of — a rename across a discord.js minor, or a plain typo, neither of which anything in discord.js reports. It is why the assertion resolves names through the library rather than trusting a string literal.

**3. The `MessageManager` limit covers more managers than it names.** `MessageManager`, `GuildMessageManager`, `DMMessageManager` and `PartialGroupDMMessageManager` all resolve to the `MessageManager` setting through `MakeCacheOverrideSymbol` (`src/managers/MessageManager.js:22`), and `ThreadManager` likewise. Worth recording because the obvious reading — that `GuildMessageManager` needs its own entry — would add a settings key that is never consulted, and the assertion in this slice would then correctly reject it.

Nothing here contradicts the fake yet: `FakeDiscord` is a *port*-level fake and has no client options to be wrong about. The fake-versus-real audit proper is slice 6b's and the audit-log work.

---

## WP5 slice 6b-i — the REST port, and what it refuses to do — 2026-08-23

All fourteen `DiscordPort` methods over discord.js's REST client, behind the `@bananasaurs/discord/rest` subpath that `package.json` `exports` and the ADR 0014 lint rules already govern. The port was not widened: fourteen methods in, fourteen methods out.

**ADR 0018 — the port refuses rather than retries or waits.** `@discordjs/rest` defaults to `retries: 3` and `rejectOnRateLimit: null`, so out of the box it does both things `docs/19` §6.1's rule forbids: it retries a 5xx three times against a rate cap that authorised one call, and it *waits out* rate limits rather than reporting them, which the breaker above can never count. Now `retries: 0` and `rejectOnRateLimit: () => true`. The clinching case is the interaction path: a silent four-second wait on the defer costs a dead token and a member-visible "This interaction failed" with nothing in the log to explain it. Set on the client rather than on a REST instance of the port's own, because two REST instances keep separate buckets and would race past Discord's global cap.

**Raw routes, not discord.js structures.** The structure API resolves through the client cache that slice 6a deliberately made tiny, so a structure call can silently become a fetch no rate cap authorised. Raw routes keep every request explicit and make `DiscordAPIError` the single shape to map.

**Tested through the real `@discordjs/rest` stack with only the socket replaced**, via the documented `makeRequest` injection point. Route building, query serialisation, rate-limit accounting and error construction are all the library's own — so the error mapping is tested against discord.js's actual errors rather than against errors we invented, which is the whole job of that module.

**Broke, to check the tests.** 50. Removed `encodeURIComponent` from the emoji route — **and every test still passed.** That is a finding about the tests, not the code: `new URL()` percent-encodes a raw emoji in a path anyway, so the obvious assertion could not fail. The test was decoration and is rewritten to assert the *decoded* path, which catches double encoding — the failure that can actually happen. 50b. Double-encoded instead → 2 failed. 51. Never offered a pagination cursor → 1 failed. 52. Ignored the remembered ephemeral flag on follow-up → 1 failed. 53. Computed the bot's highest role from all roles rather than the ones it holds → 2 failed. 54. Dropped the `RateLimitError` branch from the error mapping → the ADR 0018 test failed. All restored by file copy.

779 tests green; typecheck and lint exit 0.

### Divergences found between the fake and real Discord

**4. `fetchReactionUsers` cannot know it has reached the last page — the fake could, and did.** `GET /reactions` returns users and nothing else: no total, no "has more". So an adapter over the real API must offer a cursor whenever a page comes back *full*, and learn the truth by asking again and getting an empty page. `FakeDiscord` was answering `nextAfter: undefined` as soon as the page exhausted its array, which is knowledge that never arrives on the wire. **Fixed in the fake**, with a test pinning the corrected semantics. Nothing broke, which is the uncomfortable part: the old behaviour was not wrong enough to fail anything, it just let a caller depend on something real Discord does not provide. `pageReactors` already tolerates the extra empty page, so the cost is one extra request on an exactly-100-reactor panel.

**5. The fake enforces guild scope on channel-addressed calls. Discord does not.** `FakeDiscord.check()` throws if the guild id does not match, for every method. But Discord's channel, message and interaction routes carry **no guild id in the URL** — the seven affected port methods take `_guildId` in the adapter because there is nowhere to put it. So a caller that passed a mismatched channel/guild pair would be refused by the fake and *obeyed* by Discord. Guild scope is still enforced where CLAUDE.md rule 2 says to enforce it — the port signature — and the fake's extra strictness is worth keeping precisely because Discord has none. Recorded rather than changed.

**6. `role_update` was undefined, and is now `MemberRoleUpdate` (25), not `RoleUpdate` (31).** Nothing consumed the port's `role_update` action type before this slice, so the mapping was a genuine choice. The other three action types target a member or a message, and `MemberRoleUpdate` targets a user id the same way — "who changed this member's roles", which is what amendment 5's drift detection and WP4's role logging need. `RoleUpdate` targets a *role* and describes its own settings changing, which nothing in Release 1 logs.

### Deferred, with reasons

- **Custom-emoji reaction routes are unverified.** `EmojiKey` carries a custom emoji's id but not its name, and Discord documents the reaction route as `name:id`. The adapter sends `_:<id>`. Discord is understood to key off the id alone, but that cannot be checked without a connection. **On the smoke-test list.**
- **Super (burst) reactions are not fetched.** `GET /reactions` defaults to `type=0` (normal), and burst reactors are a disjoint set. A member who super-reacts to a panel would be seen by the gateway event but *not* by `fetchReactionUsers`, so reconciliation could remove the role it just granted — the role-flicker symptom `docs/21` exercise 4 calls a stop-everything bug. Handling it means a second paged fetch per emoji, doubling the cost of the one expensive path amendment 6 already flags. Not fixed here because it needs the port widened, which this slice must not do. **Belongs in WP4 or a follow-up slice, and is on the smoke-test list.**
