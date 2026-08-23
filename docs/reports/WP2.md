# WP2 boundary report — storage, event pipeline, safety core

Produced 2026-08-23 per `docs/20_AUTONOMOUS_EXECUTION.md`. Nine commits, `aa72be8..4633cbc`, **none pushed**. 451 tests green; `typecheck` and `lint` exit 0.

---

## 0. The three corrections first

Two of them changed what I built, because measuring the premise showed it did not hold.

### Correction 1 — STRICT

You reversed my WP1 decision and offered two options. I built both, for reasons that differ from the ones in the correction.

**STRICT does not reject a number in a TEXT column.** Measured:

```
strict_nocheck  <- number   ACCEPTED  stored {"id":"1.2345678901234568e+18","ty":"text"}
strictly        attempts='lots'  ->  REJECTED  SQLITE_CONSTRAINT_DATATYPE
```

SQLite's STRICT rules permit lossless INTEGER/REAL→TEXT conversion — the same coercion affinity performs. So option (a) alone does not close the snowflake hole.

**What rejected the number in WP1 was the format CHECK, by accident.** better-sqlite3 binds an unsafe JS integer as REAL; REAL→TEXT renders `1.23e+18`, which fails the GLOB. Correct outcome, reasoning I never did.

**The genuinely undetectable path is neither.** `String(Number(1234567890123456789n))` is `"1234567890123456800"` — nineteen digits, digits only, passes every check we could write, wrong id. No constraint can catch it; only a refusal where it was still a number can.

So the layers, weakest last:

| Layer | Where | Catches |
|---|---|---|
| `parseSnowflakeId` / `parseGuildId` | `packages/core/src/ids.ts:57` | a `number` or `bigint` **at the parse boundary**. *The control.* |
| `snowflake()` `toDriver` | `packages/storage/src/columns.ts:49` | a non-string reaching the write path, with a message naming the column |
| format CHECK, tightened | `packages/storage/src/columns.ts:60` | `GLOB '[0-9]*'` anchored only the first char, so `'1234567890123456abc'` passed in WP1. Now `NOT GLOB '*[^0-9]*'` |
| STRICT | `scripts/strictify.mjs`, asserted at `schema-invariants.test.ts:138` | `attempts = 'lots'` in an INTEGER column — the half of the correction that is exactly right |
| eslint `no-loss-of-precision` | already on via `js.configs.recommended` | a snowflake **literal** in source. Found by accident when it fired on my own test fixtures |

STRICT is tooling, not a hand-edit: `scripts/strictify.mjs` rewrites drizzle-kit's output and runs inside `npm run db:generate`. Hand-editing is safe (the migrator gates on `created_at` and never re-hashes an applied migration) but has to be remembered every time. The invariant test makes a regression a build failure.

### Correction 2 — invariant test first

Done exactly as asked, and it earned its keep on the fourth group of tables. The test was committed alone against `guilds` (`ce3f503`), then tables were added in five groups with the test run after each: 7 → 27 → 42 → 62 → 96 assertions.

When the auth group landed it **failed immediately** on `dashboard_sessions`, whose primary key is the session token and does not lead with `guild_id`. Written afterwards, that would have been a line in an audit of my own work that I could have rationalised. Written first, it stopped the build and forced the exemption to be a deliberate edit with a reason attached. It is the only entry in `UNIQUE_BY_DESIGN`.

I also verified the test catches before trusting it with twenty tables: a probe table with no `guild_id`, a unique index led by the wrong column, an unchecked snowflake column and STRICT stripped from its migration failed four separate assertions.

### Correction 3 — the boundary dependency-cruiser was covering

**The premise is false, and I can prove it.** Workspace manifests enforce nothing:

```
packages/core/src/boundary-probe.ts   import Database from 'better-sqlite3'
  npx tsc -p packages/core/tsconfig.json          ->  exit 0
packages/testkit/src/boundary-probe.ts import { openTestDatabase } from '@bananasaurs/storage'
  npx tsc -p packages/testkit/tsconfig.json       ->  exit 0

node_modules/@bananasaurs/:  core -> ../../packages/core   storage -> ../../packages/storage …
```

npm symlinks every workspace package into the root `node_modules` and hoists external deps there, so both Node and TypeScript resolve through the root whatever a manifest says. **WP1 shipped with no boundary enforcement of any kind**, and `docs/19` §1 asserted a mechanism that has never worked.

That kills the package-split option too: `exports` says which subpaths are importable, uniformly, and has no notion of *who* is importing. There is no arrangement of packages under npm workspaces in which `core/effects` can reach a module and `http` cannot.

`dependency-cruiser` would work, but every rule we actually have is a direct-import statement, ESLint already runs in `npm run lint`, and `docs/20` makes a new dependency a stop-and-ask. **Decision recorded in [ADR 0014](decisions/0014-package-boundary-enforcement.md):** per-directory `@typescript-eslint/no-restricted-imports` blocks, covering `core`, `core/src/effects`, `http`, `cli`, `dashboard`, `discord` and `testkit`. Rules for packages that do not exist yet resolve fine and bite the moment the directory appears — **WP5 inherits enforcement rather than remembering to add it**. `packages/discord`'s `exports` will expose exactly `.` and `./rest`, so `exports` handles "no sneaking in by file path" and the lint rule handles "who".

`packages/core/src/boundaries.test.ts` asserts every rule still exists, so deleting one fails the suite rather than only the lint step.

**A regression I nearly shipped.** My first version used the *base* `no-restricted-imports` rule id. Flat config resolves a repeated rule id last-wins, so every per-directory block would have silently replaced the global ADR 0013 `child_process` ban — removing it from exactly the directories that most need it. The boundary rules use the `@typescript-eslint/` id instead, and four tests assert the process ban survives.

`docs/19` §1 and §5 are corrected in place.

---

## 1. What was built

**Snowflake type safety.** A branded `SnowflakeId`/`GuildId` refused at the parse boundary, a drizzle `customType` guarding the write path, a tightened format CHECK, and STRICT restored via post-generate tooling.

**Boundary enforcement.** ADR 0014, per-directory lint rules, and a test that fails if a rule is deleted.

**The schema invariant test**, written first, then the twenty Release 1 tables in five groups. Five invariants read from the live schema: every table STRICT, every guild-partitioned table carries `guild_id TEXT NOT NULL`, every foreign key into one includes `guild_id`, every unique index leads with `guild_id`, every snowflake column has a format CHECK. Two guards against vacuous success, because every loop is over a table list and an empty list makes each invariant trivially true.

**`write()` and guild-scoped repositories.** The callback returns `NotPromise<T>`, so an `async` function is not assignable and an `await` inside a transaction is unrepresentable rather than merely discouraged. The database handle is unreachable outside the storage package, and `scope.only(table)` accepts only tables carrying `guild_id`.

**The event pipeline** — allowlist gate, then dedupe gate, then isolated subscribers — with per-kind derived fingerprints replacing the `(guild_id, discord_event_id)` index that six planning documents specify and that cannot be built.

**The job table and worker**: dedupe keys, capped exponential backoff, permanent-versus-transient failure classification, resumable cursors, startup recovery of stranded jobs, and the `event_dedupe` sweep.

**The safety core**: `authorize()` and the `Authorized<C>` witness, the twelve-layer effect gateway, per-source rate buckets with owner-confirmed allowances, audit rows with before/after and batch ids, undo as a replay of the inverse through the same gateway, and the reconciliation budget.

---

## 2. Verification evidence

```
$ npm run typecheck    exit 0
$ npm run lint         exit 0
$ npm run test
 Test Files  24 passed (24)
      Tests  451 passed (451)
```

Per file: `schema-invariants` 96 · `gateway.integration` 46 · `boundaries` 30 · `jobs` repo 25 · `write` 21 · `fingerprint` 21 · `ids` 19 · `fake-discord` 18 · `worker` 17 · `effects.integration` 16 · `pipeline` repo 14 · `columns` 13 · `db` 13 · `rate-limit` 13 · `config` 13 · `authz` 12 · `pipeline` 12 · `lock` 11 · `emoji` 9 · `logger` 9 · `pipeline.integration` 9 · `assignability.integration` 7 · `budget` 6 · `daemon index` 1.

Also verified against a **real file database**, not only in-memory: `npm run build && BANANASAURS_DB_PATH=… npm run db:migrate` produces 20 tables, all STRICT, in WAL.

### Mutation checks

Twenty-seven, each restored from a verified copy and re-run.

| # | What I broke | What failed |
|---|---|---|
| 1 | `toDriver` returned the value unguarded | 3 (number refused, message names column, bigint) |
| 2 | CHECK reverted to `GLOB '[0-9]*'` | 2 (digits-then-letters, digits-with-space) |
| 3 | STRICT stripped from the migration | 1 (text into INTEGER column) |
| 4 | Number branch removed from the Zod error map | 4, incl. the JSON round-trip test |
| 5 | REST-port ban removed from `packages/http` | 1 |
| 6 | Boundary rules reverted to the base rule id | 28, incl. all four `child_process` assertions |
| 7 | Readonly check removed from `write()` | 2 |
| 8 | `scope.only()` dropped the guild predicate | 2 |
| 8b | `scope.only()` made a tautology outright | 3 — **see below** |
| 9 | `NotPromise<T>` replaced with `T` | typecheck failed on both `@ts-expect-error` directives |
| 10 | `upsertGuild` reset operator state on conflict | 3 |
| 11 | Subscriber try/catch removed | 3 |
| 12 | Leave-once guard dropped | 1 |
| 13 | Invented a reaction fingerprint | 3 across two files |
| 14 | Dedupe gate moved before the allowlist gate | 6 |
| 15 | `recordFirstSight` always returned true | 1 |
| 16 | `attempts` incremented on failure, not claim | 3 |
| 17 | `failJob` ignored the permanent flag | 2, incl. integration |
| 18 | Connection subscriber reconciled on RESUMED | 1 |
| 19 | `enqueue` reported success when deduped | 1 |
| 20 | Worker treated an unknown kind as retryable | 1 |
| 21 | Gateway trusted the witness, no re-verification | 3 |
| 22 | Dry run still made the REST call | 3 across two layers |
| 23 | Idempotency claim moved after the REST call | 2, incl. the real-SQL one |
| 24 | `inverseOf` ignored `had_role_before` | 4 |
| 25 | Kill switch check removed | 2, one of them the undo path |
| 26 | Rate cap refused without tripping the breaker | 1 |
| 27 | Budget's over-budget branch removed | 2 |

**Mutation 8 found a hole in my own test, which is the point of doing this honestly.** Dropping the guild predicate only broke calls that passed *extra* conditions; the isolation test, which passes none, still passed — `and()` with no arguments returns `undefined` and fell through to the fallback. So the isolation test was not yet proven to be more than decoration. Mutation 8b made `only()` a tautology in every case and it failed. A mutation that only half-fails is a weaker signal than it looks.

**The lint tripwire was verified directly**, now that `Authorized` exists:

```
packages/core/src/tripwire-probe.ts
  2:40  error  Casting to an authorization or guild-scope type defeats the check
               it exists to make.  no-restricted-syntax
```

---

## 3. The four questions, with evidence

### Q1 — does every new query take a guild ID, structurally rather than by convention?

**Yes, three independent ways.**

**Signatures.** All 42 exported repository functions across `packages/storage/src/repos/` take `scope: GuildScope` as their first parameter — `guilds.ts` (6), `jobs.ts` (9), `effects.ts` (13), `pipeline.ts` (6), `authz.ts` (7), `job-store.ts` (1). There is no overload without it.

**The handle is unreachable.** `packages/storage/src/scope.ts:52` holds the database on a `WeakMap<GuildScope, ScopeInternals>` rather than a property, and `dbOf` (`scope.ts:80`) is not re-exported from `packages/storage/src/index.ts`. So `core`, `http` and `cli` have no route to a row except a repository function, and ADR 0014's lint rules stop them importing storage at all. A fabricated scope throws (`write.test.ts`, "refuses a fabricated scope rather than reaching an arbitrary database").

**The predicate cannot be built by hand.** `scope.only()` (`scope.ts:39`) takes `GuildPartitionedTable = SQLiteTable & { guildId: SQLiteColumn }` (`scope.ts:27`), so passing an instance-level table is a compile error — asserted with `@ts-expect-error` against `dashboardAccounts` in `write.test.ts`.

**And structurally in SQL underneath all of it.** `packages/storage/src/schema.ts` carries 20 `foreignKey({...})` declarations, 31 of whose column lists lead with `t.guildId`, so a child row physically cannot reference a parent in another guild. `apps/daemon/src/effects.integration.test.ts` proves it rather than asserting it: claiming an effect against a batch belonging to another guild raises `SQLITE_CONSTRAINT_FOREIGNKEY`.

**Enforced for tables that do not exist yet.** `schema-invariants.test.ts:154` (partition key), `:168` (foreign keys carry `guild_id`), `:190` (unique indexes lead with `guild_id`) read the live schema, so the *next* table anyone adds is covered without anyone remembering.

The one deliberate exception is `dashboard_sessions`' primary key, recorded in `UNIQUE_BY_DESIGN` with its reason: a session is looked up by its token *before* the guild is known, so guild-scoping that index would mean trusting a client-supplied guild in order to authenticate the session.

### Q2 — does every new Discord side effect have a durable idempotency key and a unique constraint making double execution impossible?

**Yes.** There is exactly one Discord side effect in WP2 — a role mutation — and it is claimed before the REST call.

**The key** is computed by `dedupeKeyFor` at `packages/core/src/effects/gateway.ts:158`, a pure function rather than a port so callers cannot each get it wrong differently: `sha256(guild ‖ panel ‖ user ‖ role ‖ action ‖ triggerRef)`. `triggerRef` is the interaction id for a button and the convergence pass id for a reaction, which is what separates a *legitimate* repeat (a member toggling a role off and on) from a *replayed* one.

**The constraint** is `uniqueIndex('role_effects_dedupe').on(t.guildId, t.dedupeKey)` at `schema.ts:290`, shipped as real SQL at `drizzle/0000_steep_khan.sql:318`:

```sql
CREATE UNIQUE INDEX `role_effects_dedupe` ON `role_effects` (`guild_id`,`dedupe_key`);
```

**The claim** is `claimEffect` at `packages/storage/src/repos/effects.ts:112` — `INSERT … ON CONFLICT DO NOTHING`, returning `claimed: result.changes === 1`.

**The ordering** is `gateway.ts:284–290`: the claim happens *before* the REST call, and `if (!claim.claimed) return { status: 'skipped', reason: 'already-applied' }`. That direction is deliberate — if the process dies between claim and call the effect is recorded as attempted and a replay skips it, which is the failure that does not double-grant. Mutation 23 moved the claim after the call and two tests failed, one of them the real-SQL one.

**Proved against SQL, not against a fake.** `apps/daemon/src/effects.integration.test.ts` ("makes a replayed effect a no-op") drives the real gateway against the real database: one `addRole` call, one `role_effects` row, second attempt skipped — while a different `triggerRef` produces two of each. The in-memory version of that test would pass whether or not the index exists; a `UNIQUE` index either exists or it does not.

**The other two idempotency keys** follow the same shape: `uniqueIndex('jobs_dedupe').on(t.guildId, t.dedupeKey)` at `schema.ts:440` makes enqueuing the same work twice a no-op (`enqueue`, `repos/jobs.ts:66`), and `primaryKey({ columns: [t.guildId, t.eventKind, t.fingerprint] })` at `schema.ts:376` backs `recordFirstSight` (`repos/pipeline.ts:30`, returning `result.changes === 1` at `:42`).

### Q3 — does any untrusted input reach an execution path without a Zod validator?

No. Job payloads are validated on read at `packages/core/src/jobs/worker.ts:139` — `handler.payload.parse(JSON.parse(job.payload))` — and a payload that does not validate is a **permanent** failure, not a retry, because it will not validate in a minute either. A payload written by an older version of this process is untrusted exactly like a form submission. Snowflakes crossing any boundary go through `snowflakeIdSchema` (`ids.ts:57`), whose error map refuses `number` and `bigint` explicitly (`ids.ts:41`).

The gap worth naming: **no untrusted input reaches an execution path in WP2 because there is no untrusted-input surface yet.** HTTP bodies and CLI arguments arrive in WP5. The validators they will use exist.

### Q4 — would each new test fail if the implementation were broken?

Twenty-seven mutations say yes, and mutation 8 says the question is worth asking properly rather than answering from confidence — one of my tests was not yet proven to be more than decoration until I broke the implementation a second, harder way.

---

## 4. Amendment tracking

| # | Amendment | Package | Status |
|---|---|---|---|
| 1 | `fs.flockSync` does not exist — socket bind + `O_EXCL` PID lockfile keyed to the database path | WP1 | **Done.** `packages/storage/src/lock.ts`, 11 tests |
| 2 | `SO_PEERCRED` not reachable — identity is a claim, column named `actor_unix_user_claimed` | WP2 schema / WP5 rendering | **Column done** (`schema.ts`, `audit_events`), written by `recordAudit`. `audit tail` rendering it *as claimed* is WP5 |
| 3 | A branded type is not a security boundary — runtime re-verification is the control, lint rule is the tripwire | WP2 | **Done.** Re-check at `gateway.ts:221`; tripwire verified firing; mutation 21 breaks 3 tests |
| 4 | Convergence diffs against **live Discord roles**, never `managed_role_assignments` | WP3 | **Groundwork done, convergence outstanding.** The gateway already reads the member's live roles before deciding (`gateway.ts`, the no-op check), and `managed_role_assignments` is documented and implemented as a *provenance* record (`repos/effects.ts`). The convergence loop itself is WP3 |
| 5 | `GUILD_MEMBER_UPDATE` subscribed, with a self-mutation filter to avoid a feedback loop | WP1 types / WP2 storage / WP3 handler / WP5 subscription | **Partly done — see below** |
| 6 | Fetch reaction state only when the behaviour needs it; memoise per pass | WP3 | **Outstanding.** `single_choice` is now constrained to managed panels by a CHECK (`panels_single_choice_is_managed`), which removes one of the two N-fetch cases at the schema level |
| — | `event_dedupe` sweep job (smaller addition) | WP2 | **Done.** `JOB_KINDS.sweepEventDedupe`, handler in `apps/daemon/src/jobs/handlers.ts`, proved end to end |
| — | `DASHBOARD_BIND=127.0.0.1` documented (smaller addition) | WP5 | Outstanding |

### Amendment 5 — is `GUILD_MEMBER_UPDATE` in the DomainEvent types?

**Yes, since WP1.** `packages/core/src/discord/events.ts:51` — `MemberEvent.kind` is `'memberAdd' | 'memberRemove' | 'memberUpdate'`, and `:54` carries `previousRoleIds` specifically so drift detection can diff without a fetch.

WP2 added the rest of the groundwork:

- `joinedAtMs` on `MemberEvent`, because neither member dispatch carries an id of its own and the join timestamp is what fingerprints them. The compiler caught the fake harness immediately — slice 3b's `implements DiscordPort` earning its keep — and `emitMemberAdd`/`emitMemberRemove` were added.
- `memberUpdate` is deliberately **level-triggered** (`fingerprint.ts`), like reactions: a role can be granted and revoked repeatedly, so counting events would drop real ones.
- The self-mutation filter's query exists: `wasRecentlyApplied` (`repos/effects.ts`), backed by a new index `role_effects_recent (guild_id, user_id, role_id, completed_at)` the plan does not name. Without it that lookup is a scan on the busiest table in the schema.

**What remains:** the gateway subscription itself (`GuildMembers` intent + the discord.js listener) is slice 6, which the plan places in WP5; the handler that consumes it and calls `wasRecentlyApplied` is WP3.

---

## 5. Decisions I made that you did not specify

**Both options for correction 1, not one.** You asked me to pick. I built both because measuring showed each closes a different hole and neither closes the other's. Stated up front rather than quietly expanded.

**Neither option for correction 3.** The package split is impossible under npm workspaces and `dependency-cruiser` is a stop-and-ask dependency; ESLint per-directory rules do the same work for the rules we have. Recorded as ADR 0014 rather than decided in a commit message.

**One migration, not five.** The incremental migrations from each table group were consolidated into a single `0000_steep_khan.sql`. Nothing is deployed, so four intermediate states that never existed anywhere are noise. **Consequence: any existing dev database must be deleted and re-migrated** — the migration filename changed twice.

**`account_guild_access` is keyed `(guild_id, account_id)`**, reversing the plan's order, so the partition key leads and no exemption is needed. Costs nothing: a handful of rows, and the login-time query is not hot.

**`jobs_claim` is `(guild_id, state, run_after)`**, not the plan's `(state, run_after)`. The plan's form was shaped for a worker claiming across every guild; a cross-guild claim would be the one query in the system able to omit the partition key, which `CLAUDE.md` rule 2 calls a bug even when every caller behaves. The claim is per-guild and the index matches it.

**Two CHECK constraints for rules the plan left to code.** `panels_single_choice_is_managed` enforces collision 1 from §6.3 — `single_choice` cannot work on an adopted panel because removing another emoji's reaction on someone else's behalf is impossible. `panels_max_roles_positive` rejects a nonsense limit. A CHECK cannot be forgotten; a validation can.

**Two indexes the plan does not name.** `role_effects_recent` for amendment 5's filter, and `dashboard_sessions_by_account` for session revocation.

**No foreign key on `event_dedupe` or `gateway_gaps`**, matching the plan but for a reason it does not state: both are written by the pipeline around `GUILD_CREATE`, when the `guilds` row may not exist yet, and a constraint failure there would drop the very event being recorded.

**`attempts` increments on claim, not on failure.** A job that crashes the process never reaches a failure handler; counting on failure means it retries forever and takes the process down every time.

**Permanent versus transient job failures.** An unregistered kind or an invalid payload fails immediately rather than burning twenty minutes of backoff to reach the same answer.

**The `Authorized` witness uses a real runtime symbol**, not `declare const`. With a declared-only symbol, `authorize` would have had to cast to construct a witness — putting the codebase's one cast in the module whose whole job is to be uncastable.

**`undoBatch` requires both witnesses.** I first wrote it taking `Authorized<'undo.execute'>` and casting to the gateway's parameter type. Recorded in §6 below.

**Allowance is spent before standing budget.** Otherwise an owner-approved batch competes with ordinary member activity halfway through and finishes late or not at all.

**A no-op costs no rate budget.** Convergence runs constantly and is mostly no-ops; charging for them would exhaust the cap without a single real change.

**`packages/storage/test-support` became a real subpath export**, so the daemon's integration tests can build a migrated database without duplicating the migrator wiring.

**`apps/daemon` is not restricted from the REST port.** The composition root has to know concrete implementations — that is its stated purpose. If WP5 finds the daemon can take a factory from the public entrypoint instead, tighten it then; I am not writing a rule I already expect to need disabling.

---

## 6. What I am least confident about

**`protected` means two things and the plan states both without distinguishing them.** As *target*: the bot will not mutate that member or role. As *actor*: that principal holds no capability at all. I implemented both. The second surfaced by **failing my own test** — marking the acting member protected locked them out before the target check ran. That is the anti-nuke posture working as designed, and it is also a real footgun: **if you mark your own role protected, you lock yourself out of the bot.** This is the item most likely to be wrong, and it is a decision about authorisation, so it is yours. Say the word and I will drop the actor-side check in WP3.

**The lint tripwire has a blind spot, and I found it by writing into it.** `undoBatch` first cast its undo witness with `as unknown as Parameters<EffectGateway['applyRoleEffect']>[0]`. That form **slips past** `no-restricted-syntax`, which matches a named type reference rather than an indirect cast. The runtime re-check would still have caught a forged witness — which is exactly amendment 3's point that the type is the weakest layer — but the tripwire is weaker than it reads. I fixed the design rather than broadening the rule, because an indirect cast has infinitely many spellings and chasing them would give false confidence.

**The rate cap and breaker under concurrent load are untested.** Every test drives the gateway sequentially. Node is single-threaded and `write()` forbids an await inside a transaction, so I believe the token bucket cannot be double-spent — but I have not tested two overlapping `applyRoleEffect` calls interleaving at their `await` points, and the bucket's refill arithmetic is time-based.

**`authorize()` returns `ok` unconditionally for `system` and `doctor` actors.** Deliberate — a scheduled pass should not stop repairing drift because a grant was revoked by accident — but it means runtime re-verification is a no-op for those actor types. If a bug ever constructs a `system` actor from untrusted input, that layer is not there.

**The `memberRemove` fingerprint falls back to a one-minute bucket** when Discord omits `joined_at`. A redelivery more than a minute later is treated as a new event. I chose that direction (log a leave twice rather than miss one), but I do not know the real redelivery distribution.

**`countEventDedupe` loads every row to count them.** Fine at Release 1 scale, wasteful later. Named rather than optimised.

---

## 7. Deferred

| Item | Why | Package |
|---|---|---|
| Convergence loop diffing live Discord roles (amendment 4) | Needs panels, which are WP3 | WP3 |
| `GUILD_MEMBER_UPDATE` handler + gateway subscription (amendment 5) | Handler needs panels; subscription needs the real adapter | WP3 / WP5 |
| Conditional reaction-state fetch + memoisation (amendment 6) | Needs the adoption pass | WP3 |
| `audit tail` rendering `actor_unix_user_claimed` as claimed (amendment 2) | Needs the CLI | WP5 |
| `DASHBOARD_BIND` documentation | Needs the dashboard | WP5 |
| `managed_role_assignments` write-through from the gateway | The repo functions exist and are tested; wiring them belongs with the panel that produces the provenance | WP3 |
| Daemon runtime wiring (timer loop, pipeline attachment, worker scheduling) | `core` deliberately has no scheduling; `apps/daemon/src/index.ts` is still the WP1 skeleton | WP5 |
| Cross-guild job claiming | Release 1 has one guild, and the guild-scoped claim preserves the partition-key invariant | Not scheduled |

---

## Before you start WP3

**Delete your dev database if one exists.** The migration was regenerated and renamed twice; `npm run db:migrate` against an old file will not do the right thing. `rm -rf data/` then `npm run build && npm run db:migrate`.

---

## 8. Handoff prompt for WP3

```
WP2 is reviewed and accepted. Begin WP3: role panels.

## Where the repo is

/home/bryan/projects/bananasaurs, branch main, HEAD 4633cbc (or later if you
pushed). npm workspace, Node 22, TypeScript strict. 451 tests green;
`npm run typecheck && npm run lint && npm run test` must all pass before you
claim anything is done.

FIRST, BEFORE ANYTHING ELSE: delete any dev database. The WP2 migration was
regenerated and renamed, so `db:migrate` against an old file will not do the
right thing.

    rm -rf data/ && npm install && npm run build && npm run db:migrate

## Read these, in this order

1. CLAUDE.md — the nine hard rules. Rule 2 (guild scope) and rule 6
   (idempotency) are the ones WP3 will be tempted to bend.
2. docs/reports/WP2.md — what exists and, more usefully, sections 6 and 7:
   what I am least confident about and what I deferred to you.
3. docs/19_RELEASE_0_1_PLAN.md §6.3–6.6 — panels, adoption, reaction drift,
   hierarchy. Also §4 on convergence, and amendments 4, 5 and 6.
4. docs/20_AUTONOMOUS_EXECUTION.md — the protocol: slice, mutation-check,
   four questions, session log, commit per slice, never push, stop at the
   boundary with the seven-part report.
5. docs/decisions/0014-package-boundary-enforcement.md — how boundaries are
   actually enforced, and why it is not what docs/19 originally claimed.

## What WP3 is

Slices 7–11 of docs/19 §7: adopted panels, the adoption pass, managed panels,
the four behaviours with limits and required/blocked roles, and
reconciliation. Done when a panel works end to end against the fake harness
including every failure case in docs/REVIEWING_AGENT_OUTPUT.md.

## What WP2 leaves you, so you do not rebuild it

- `EffectGateway.applyRoleEffect` (packages/core/src/effects/gateway.ts) is
  the ONLY way to change a role. It already does authorization
  re-verification, kill switch, breaker, panel status, allowlist, protected
  target, live hierarchy check, rate cap, idempotency, dry run, execute and
  record. Build intents; do not build a second path.
- `checkReconcileBudget` (effects/budget.ts) refuses an oversized change list
  before acting. Call it with the FULL list, not a count.
- `RateLimiter.grantAllowance` is the owner-confirmed adoption allowance.
- `undoBatch` (effects/undo.ts) and the `inverseOf` truth table.
- Job table + worker: `jobRepo`, `jobStoreFor`, `JobWorker`. Handlers go in
  apps/daemon/src/jobs/, kinds and payload schemas in core/src/jobs/kinds.ts.
- `Pipeline` (core/src/pipeline/pipeline.ts) with allowlist and dedupe gates.
  Reactions and memberUpdate are LEVEL-TRIGGERED and carry no fingerprint —
  that is deliberate, see core/src/pipeline/fingerprint.ts. Do not "fix" it
  by inventing a reaction fingerprint; there is a test that fails if you do.
- Guild-scoped repositories. Every one takes a GuildScope first. You cannot
  reach the database handle from core — that is enforced by lint, and there
  is a test asserting the lint rule still exists.

## The three amendments WP3 owns

4. CONVERGENCE DIFFS AGAINST LIVE DISCORD ROLES, never against
   managed_role_assignments. That table is a PROVENANCE record — which panel
   granted this, when, under which effect. Discord is the source of truth for
   current state. Diffing against our own table means a role removed by hand
   leaves it reading "granted", convergence computes an empty change set, and
   the drift is never repaired. The gateway already fetches the member's live
   roles; use that shape.

5. GUILD_MEMBER_UPDATE handler with a self-mutation filter. The event fires
   for OUR OWN mutations too, so naive repair is a feedback loop. Use
   `effectRepo.wasRecentlyApplied(scope, {userId, roleId, sinceMs})` — it
   exists, it is indexed by role_effects_recent, and it is untested against a
   real loop. Test that. (The gateway subscription itself is slice 6, in WP5;
   drive the handler from the fake harness for now.)

6. Fetch reaction state only when the behaviour needs it, memoised per
   convergence pass. toggle/add_only/remove_only are decidable from the
   single emoji the event carried. single_choice is already constrained to
   managed panels by a CHECK, so the remaining N-fetch case is an adopted
   panel with max_roles.

## One decision I need from you before it hardens

`protected` currently means two things: the bot will not MUTATE a protected
member or role, AND a protected principal holds no capability. The second
means marking your own role protected locks you out of the bot. I implemented
both because the plan states both; see docs/reports/WP2.md §6. If you want
only the target-side meaning, say so and drop the anyProtected() check in
authorize().

## Protocol

Slice by slice. Per slice: typecheck, lint, test with real output; break the
implementation to prove the tests catch it and record what you broke; append
to docs/SESSION_LOG.md; commit. Do not push. Stop at the WP3 boundary with the
seven-part report, the amendment tracking table, and a WP4 handoff prompt.

Answer the four questions with real file:line evidence, not "not applicable".
WP3 is where panels create effects, so questions 1 and 2 are live again.
```
