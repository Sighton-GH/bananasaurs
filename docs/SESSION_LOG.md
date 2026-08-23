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
