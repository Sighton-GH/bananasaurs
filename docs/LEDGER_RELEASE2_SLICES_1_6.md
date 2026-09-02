# Release 2, Slices 1–6 — execution ledger

Working ledger for the run that takes Release 2 from Slice 0 (merged) to
**flip day**. Branch `worktree-release2-slices-1-6`. Started 2026-09-01.

Per `docs/22`: conversation memory does not survive compaction. This file is
the recovery map. Every completed task carries its commit SHAs; every ruling
taken on the owner's behalf is recorded here with **what it costs if wrong**.

Scope: Slices 1–6 of
`docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`.
Slices 7–12 are explicitly **not** in this run — the owner flips the rules and
runs the observe window before the dashboard work starts.

## Carried-forward obligations (owner-assigned at kickoff)

1. **The matcher cache never invalidates on term edits.** `subscriber.ts`'s
   module-level `matcherCache` has no eviction; ADR 0039 widened what a stale
   entry gets wrong (collapse thresholds now derive from the word list). Fix it
   in Slice 1 or 2 — whichever touches that file first. → **Slice 1** does.
2. **Do not reorder Slices 1–6 ahead of 7–10.** The dashboard work happens
   *during* the observe window, not before it.
3. **Any rule whose observe data predates ADR 0039 is worthless.** Restart
   those clocks — the rule was not firing.

## Slice status

| Slice | ADR | Plan | Status |
| --- | --- | --- | --- |
| 1 — predicate abstraction + `mod_rules.config` | 0040 ✅ | [plan](superpowers/plans/2026-09-01-slice-1-predicate-abstraction-and-config-carrier.md) | **in progress** — Task 1 of 7 complete and reviewed clean; Tasks 2–4 in flight |
| 2 — fixtures, dry-run evaluator, traces, CLI review | 0041 ✅ | — | ADR written, plan pending |
| 3 — precise tier (`regex`, `invite`, `link_domain`) | — | — | not started |
| 4 — window tier (`mention_spam`, `rapid_spam`, `duplicate_message`) | — | — | not started |
| 5 — shape tier (`caps`, `attachment_type`, `emoji`) | — | — | not started |
| 6 — cutover tracking, observe gating, automod testing mode | 0042 | — | not started |

## Owner decisions taken during this run

**OD-1 (2026-09-01) — the automod fixture corpus stores the full message and
keeps the author id.** Asked because it changes privacy and retention, which
this run is not authorised to decide. `mod_case_events` stores only a
`matched_snippet` today, and both Slice 2's regression corpus and Slice 9's
false-positive review need more context than that to judge a match. The owner
chose: full message text plus `author_id`, guild-scoped, with `source`
distinguishing `observed` from `handwritten`.

Three obligations follow, and none of them are optional:

1. **`PRIVACY.md` gains a retention row** for the fixture corpus, in Slice 2,
   in the same commit as the table. The policy's own rule is that material
   changes are announced; the owner announces, but the document must be true
   first.
2. **`/forgetme` must be able to delete `source = 'observed'` rows.**
   `/forgetme` is a Release 3 command (R3-10) and does not exist yet, so
   Slice 2's obligation is narrower and concrete: store `author_id` so the
   future command *can* find them, and add a repository function
   `deleteObservedFixturesForMember(scope, memberId)` with a test, so R3-10
   wires up an existing, tested path rather than inventing one. A corpus that
   cannot be un-made is the thing the owner was asked about.
3. `source = 'handwritten'` rows are **not** member data and are never deleted
   by `/forgetme` — they are the adversarial cases the project wrote itself.

**OD-2 (2026-09-01) — the fixture corpus is included in `npm run backup`.**
Backup is a whole-database snapshot (ADR 0034), and excluding one table means a
restore silently loses every reviewed verdict and the whole regression suite.
No change to `backup.ts` is required; this is recorded so that a later reviewer
asking "should this table have been excluded?" finds the answer rather than
re-opening it. Diagnostics bundles are unchanged — they were never a
whole-database dump.

## Rulings

Rulings taken on the owner's behalf, each with what it costs if wrong.

**R-1 — the compiled-predicate cache lives in `createAutomodSubscriber`'s
closure, not in module state.** ADR 0035's spec asked for module state; that
was defensible while the cache was write-once and is not now. Per-instance, it
is bounded by one guild's rules, cannot leak across guilds even in principle,
and needs no test-only reset export. The guild id stays in the key as defence
in depth. *Costs if wrong:* a future caller wanting one process-wide cache
shared across guilds has to reintroduce it — a small change, made safe either
way by ADR 0040 §5's fingerprint. Recorded as an amendment in ADR 0040.

**R-2 — the `mod_rules_kind` CHECK widens to all ten kinds in Slice 1, before
nine of those predicates exist.** A rule naming a kind with no registered
predicate is inert, logged once, and reported by `doctor`. *Costs if wrong:* an
operator can create a rule that cannot yet do anything. Mitigated by the
`doctor` check, which is why that check is in Slice 1 rather than deferred. The
alternative — a migration per predicate slice — buys nothing and costs four
more table rebuilds.

**R-3 — `MessageEvent` gains mention and attachment metadata in Slice 1**,
before Slices 4 and 5 need it, so those slices are pure predicate code.
*Costs if wrong:* a few unused fields ride along on every message event for two
slices. discord.js already holds all of them on the `Message` object, so nothing
new is fetched and no new data leaves the process.

**R-4 — a rule that cannot be compiled is inert, logged once per configuration,
and reported by `doctor`** — not a crash, and not a silent skip. *Costs if
wrong:* nothing; this is the ADR 0039 failure mode being closed rather than
re-opened.

**R-5 — migrations run with foreign keys disabled at the *connection* level,
bracketed by a `PRAGMA foreign_key_check` that fails the migration if it finds
a violation.** This is the fix for a real, reproduced data-loss bug, not a
preference.

*What was found.* Slice 1's `mod_rules` change forces a CHECK widen, which
SQLite cannot do in place, so drizzle-kit emits the table-rebuild dance
(`CREATE __new_mod_rules` → `INSERT…SELECT` → `DROP mod_rules` → `RENAME`).
The generated SQL brackets that in `PRAGMA foreign_keys=OFF; … ON;` — correctly
— but `drizzle-orm`'s migrator wraps *every* pending migration in a single
`BEGIN … COMMIT`, and `PRAGMA foreign_keys` is a documented no-op once a
transaction is open. So enforcement stays on through the `DROP`, and the
`ON DELETE CASCADE` from `word_categories`, `word_allowlist` and
`mod_rule_exemptions` onto `mod_rules(guild_id, rule_id)` fires and silently
deletes every child row. No error is raised.

*Verified by the coordinator, not taken on report.* A standalone reproduction
migrated a database to 0009, inserted one rule with one category, one term, one
allowlist phrase and one exemption, then applied 0010+0011:

```
BEFORE {mod_rules:1, word_categories:1, word_terms:1, word_allowlist:1, mod_rule_exemptions:1}
AFTER  {mod_rules:1, word_categories:0, word_terms:0, word_allowlist:0, mod_rule_exemptions:0}
```

*Why this is not hypothetical.* `seedAutomodDefaults` already created
`default-word-filter` with the seeded word list on the live install. This
migration would delete that rule's entire word list on upgrade and leave a rule
that looks configured and matches nothing — the ADR 0039 failure mode again,
total rather than partial.

*The fix.* SQLite's own documented procedure for this kind of schema change
requires `foreign_keys=OFF` **outside** any transaction. So the `migrate()`
call sites — `scripts/migrate.mjs`, `packages/storage/src/test-support.ts`, and
any other — disable foreign keys on the connection, migrate, run
`PRAGMA foreign_key_check`, and re-enable. The `foreign_key_check` is the part
that stops this being a licence to write broken migrations: enforcement is off
during the rebuild, so a violation introduced by a migration must be caught on
the way out rather than never.

*Rejected alternative:* calling `migrate()` once per migration file. It does
not work — drizzle opens a transaction per call regardless, so the pragma is
still a no-op. Worth recording so nobody tries it.

*Costs if wrong:* foreign-key enforcement is off for the duration of a
migration run. A migration that inserts referentially broken rows would not be
rejected at insert time; `foreign_key_check` catches it immediately afterwards
and fails the run, so the window is one migration batch and the failure is
loud. The alternative — hand-editing each rebuild migration to re-insert
children — is fragile, per-migration, and has to be remembered every time.

**R-6 — the schema change ships as two migrations (0010 `ALTER TABLE … ADD
COLUMN`, 0011 the CHECK-forced rebuild), not one.** drizzle-kit 0.31.10 emits
invalid SQL when a column add and a table rebuild land in the same `generate`
call: the rebuild's `INSERT INTO __new_mod_rules(…, "config", …) SELECT …,
"config", … FROM mod_rules` reads a column the *old* table does not yet have,
so the migration throws `no such column: "config"` and nothing applies.
Confirmed by reading the generated 0011, which is valid only because 0010 added
`config` first. Two sequential `db:generate` runs; both files are pure
drizzle-kit output, neither hand-written. *Costs if wrong:* one extra migration
file in the journal. Nothing else.

**R-7 — `0002_solid_titanium_man.sql` carries the same latent hazard and is
recorded rather than fixed.** It rebuilds `panels`, which owns cascading
children (`panel_options`, `panel_blocked_roles`). It has already been applied
to the live database, so whatever it did is done; R-5 prevents recurrence for
every future rebuild. *Action carried to handoff:* run `PRAGMA
foreign_key_check` on the live database and confirm `panel_options` row counts
look right before the next migration. *Costs if wrong:* if 0002 did destroy
panel options on the live install, they were rebuilt by hand during Release 1
smoke testing and nobody noticed the cause. Worth one look, not a slice.

### R-7 follow-up: the live database, inspected read-only (2026-09-01)

Ran `PRAGMA foreign_key_check` and row counts against
`/home/bryan/projects/bananasaurs/data/bananasaurs.db`, read-only, no writes.

```
foreign_key_check: []          (no violations)
guilds 1 · panels 1 · panel_options 1 · panel_blocked_roles 0
mod_rules … mod_case_events:   tables absent
applied migrations:            5
```

**R-7 is answered for this file: nothing was destroyed.** `panel_options`
survived migration 0002, and there are no foreign-key violations.

**But two things this turned up matter more than the answer.**

1. **This database is at migration 5 and has no automod tables at all** — no
   `mod_rules`, no `mod_cases`, no `mod_case_events`. `STATE.md` describes the
   automod engine, the `/mod` surface and Slice 0 as shipped and live, which
   cannot be true of *this* file. Either the operational database lives
   somewhere else (`BANANASAURS_DB_PATH` overrides the default) or this one is
   a stale artefact from late August (its mtime is 2026-08-30 19:13). **The
   owner should confirm which file is real before running `db:migrate`.**
2. **On whichever database is real, the R-5 bug would not have bitten on this
   particular upgrade anyway** — and it is worth being precise about why,
   rather than claiming a save that did not happen. Applying 0005→0011 in one
   `migrate()` call creates `mod_rules` in an earlier migration and rebuilds it
   in 0011 while it is still empty, so there is nothing for the cascade to
   delete. The bug bites on the *next* rebuild after the daemon has run and
   `seedAutomodDefaults` has populated the word list. The fix is still
   required; it is simply not yet load-bearing on this specific migration path.

## Environment findings

**E-1 — a git worktree here has no workspace symlinks, so cross-package
typechecks silently read the *main checkout's* build.** The worktree's
`node_modules/` contained only `.vite`; Node's resolution walked up to
`/home/bryan/projects/bananasaurs/node_modules/@bananasaurs/*`, every one of
which symlinks into the **main** checkout's `packages/`. So `packages/discord`
in the worktree typechecked against the main checkout's
`packages/core/dist/index.d.ts`, which was stale (built 08:42, before Slice 0's
exports landed) — producing 14 errors about missing `NativeAutoModAction`,
`createNativeAutomodSubscriber` and friends that looked like a broken baseline
and were nothing of the kind.

Fixed for this worktree by creating `node_modules/@bananasaurs/*` symlinks
pointing at the worktree's own packages. After that, `npm run typecheck` shows
only the expected mid-TDD errors.

**This matters beyond this session.** Any future worktree needs the same links
(or an `npm install` inside it) before any gate run there means anything — and
worse, without them a `tsc --build` in a worktree can write into the main
checkout's `dist`. Carried to handoff as a suggested `docs/` note.

## Deferred minors

Raised by review, judged not worth a fix round, carried to the whole-branch
review for triage.

- **Slice 1 Task 1** — `packages/storage/src/repos/automod-rules.ts`,
  `hydrate`: `row.kind as RuleKind` is an unchecked cast. Safe only because the
  `mod_rules_kind` CHECK constrains the value, and it mirrors the pre-existing
  `row.mode as RuleMode` cast on the next line, so it is consistent with the
  file rather than new sloppiness. Worth revisiting only if the CHECK and the
  union ever drift apart — which `packages/core`'s `compileRule` already
  handles by reporting `unknown-kind` rather than trusting the cast.

## Handoff checklist for the owner

Collected as they arise, so the final handoff is not reconstructed from memory.

1. **Confirm which database is real.** `data/bananasaurs.db` is at migration 5
   with no automod tables, which contradicts `STATE.md`. Check
   `BANANASAURS_DB_PATH`. Do this **before** running `npm run db:migrate`.
2. **`PRIVACY.md` changes in Slice 2** — it gains a retention row for the
   fixture corpus. Your own policy says material changes are announced in the
   server. The announcement is yours to make.
3. **Restart the observe clock for any rule whose data predates ADR 0039.**
   Carried forward from the kickoff; the rule was not firing, so its data
   measured nothing.
4. **A worktree needs `npm ci` (or workspace symlinks) before its gates mean
   anything** — see E-1. Worth a line in `docs/` if worktrees become routine.
