# Slice 6, Dispatch A (Task 1: the columns) — blocked, reverted

**Status: blocked. No changes committed. Working tree is clean and matches
`main` at `f6bddff`.**

## What happened

Following the plan's Task 1 exactly:

1. Wrote the failing tests first, in `automod-rules.test.ts` and
   `guilds.test.ts` — defaults for a freshly created rule
   (`cutoverState: 'not_started'`, `countsAsViolation: true`,
   `maxFalsePositiveRate: 0.05`, `minReviewedMatches: 20`, and the three other
   nullable fields `null`), the CHECK boundary pairs (`max_false_positive_rate`
   accepts 0 and 1, rejects -0.1 and 1.5; `min_reviewed_matches` accepts 0,
   rejects -1), and a guild's `automodTestingMode` default. Ran them: all 7
   failed for the expected reason (`no such column: …`), confirmed by output.
   Two of the CHECK tests (`cutover_state = 'banana'`, `counts_as_violation =
   2`) initially passed *before* the migration existed too — a raw insert
   naming a nonexistent column also throws, so `.toThrow()` alone was a
   trivially-true assertion. Fixed by asserting
   `.toThrow(/CHECK constraint failed/)` instead, which correctly went red
   pre-migration (`no such column`, not `CHECK constraint failed`) and would
   go green only once the real constraint exists.

2. Edited `schema.ts`, run 1: the four plain nullable columns
   (`observe_started_at`, `legacy_rule_ref`, `enforce_signed_off_by`,
   `enforce_signed_off_at`) on `mod_rules`. `npm run db:generate` emitted
   `0015_romantic_krista_starr.sql` — **4 `ALTER TABLE mod_rules ADD COLUMN`
   statements, no `__new_`, no `DROP`, no `RENAME`.** Clean.

3. Edited `schema.ts`, run 2: the five CHECK-constrained columns
   (`mod_rules.cutover_state`, `counts_as_violation`, `max_false_positive_rate`,
   `min_reviewed_matches`, and `guilds.automod_testing_mode`). `npm run
   db:generate` emitted `0016_nappy_overlord.sql` — **a full rebuild of both
   `guilds` and `mod_rules`**: `CREATE TABLE __new_guilds` / `__new_mod_rules`,
   `INSERT INTO __new_… SELECT … FROM …`, `DROP TABLE guilds`, `DROP TABLE
   mod_rules`, two `RENAME`s, bracketed in `PRAGMA foreign_keys=OFF/ON`.

   `mod_rules` owns cascading children (`word_categories`, `word_terms`,
   `word_allowlist`, `mod_rule_exemptions`, `automod_invite_allowlist`,
   `automod_link_domains`, all `ON DELETE CASCADE` into
   `mod_rules(guild_id, rule_id)`). This is precisely R-5's reproduced
   data-loss path: `drizzle-orm`'s migrator runs every pending migration in
   one transaction, `PRAGMA foreign_keys` is a no-op once a transaction is
   open, so the `DROP TABLE mod_rules` would fire every cascade and silently
   delete every rule's word list, exemptions, and allowlists on upgrade.

4. Per the plan's explicit instruction ("If either run emits a rebuild of any
   table, stop and report it… working around it is not your call"), I did
   **not** attempt db:migrate, did not proceed to Step 5, and ran one
   diagnostic to characterize the failure precisely: with *only* `cutover_state`
   added (a single CHECK-constrained column, nothing else), `db:generate`
   **still** emitted a full rebuild of `mod_rules`. So this is not a
   multi-column bundling artifact — **drizzle-kit 0.31.10 rebuilds the whole
   table whenever any new column carries a CHECK constraint, even alone, even
   when the CHECK references only the new column itself and even though
   SQLite's own `ALTER TABLE ADD COLUMN` supports a self-referential CHECK
   without a rebuild.** This is the same drizzle-kit limitation R-6 already
   named for widening an *existing* CHECK, now confirmed to apply equally to
   *adding a new* CHECK-constrained column.

5. Deleted both generated migrations and their snapshots (never applied to
   any database — in-memory test DB only, and only via `db:generate`'s own
   dry SQL generation, never `db:migrate`), reverted `_journal.json` and
   `schema.ts` via `git restore`, reverted the two test files via `git
   restore`. Working tree is clean; `git status --porcelain` is empty.

## Why this blocks Task 1 as specified

ADR 0042's own Consequences section states: "Four additive columns on
`mod_rules` and one on `guilds`. All `ALTER TABLE … ADD COLUMN`; **no table
rebuild**." (The plan corrects "four" to "eight" but repeats "no table
rebuild".) That premise is false for drizzle-kit 0.31.10: five of the eight
`mod_rules` columns this task names — `cutover_state`, `counts_as_violation`,
`max_false_positive_rate`, `min_reviewed_matches` — and `guilds
.automod_testing_mode` all carry a CHECK and each one, alone or together,
forces the rebuild/cascade-delete path. `cutover_state` in particular is the
whole spine of PR-27's state machine; landing the four checkless columns
without it would produce a schema Tasks 2–6 cannot build on, so I did not
land a partial migration either.

This needs a decision above my authority to make unilaterally: e.g., drop the
CHECKs from these columns and validate the five values/ranges in
`packages/storage` code instead (contradicts ADR 0042 §3's "not a lint...
returned refusal" framing only for the *eligibility* check, not for these
input-shape CHECKs — but the five-state/bool/range CHECKs are plain input
validation the ADR itself says belongs at the database); or accept a
hand-verified rebuild migration with an explicit `INSERT…SELECT` audit and a
`PRAGMA foreign_key_check` gate (this is what R-5's fix pattern already
supports for exactly this scenario, and it exists in `scripts/migrate.mjs`
and `test-support.ts` today); or pin a newer drizzle-kit if a later release
fixed this. Ledger-worthy either way — this is a second, independently
reproduced instance of the same drizzle-kit 0.31.10 CHECK/rebuild behavior
R-6 partially characterized, now shown to apply to brand-new columns too, not
only to widening an existing CHECK.

## Gate status (clean tree, no changes)

- `npm run typecheck`: exit 0
- `npm run lint`: exit 0
- `npm run test`: exit 0 — 2312 tests / 113 files, matching the stated
  baseline exactly.

## Files touched then reverted

- `packages/storage/src/schema.ts` (both migration attempts, then diagnostic,
  then reverted)
- `drizzle/0015_romantic_krista_starr.sql`,
  `drizzle/meta/0015_snapshot.json` (safe, additive; deleted anyway since
  `cutover_state` — the essential column — cannot land alongside it)
- `drizzle/0016_nappy_overlord.sql`, `drizzle/0016_harsh_red_shift.sql`,
  their snapshots (the rebuild reproductions; deleted, never migrated)
- `drizzle/meta/_journal.json` (reverted)
- `packages/storage/src/repos/automod-rules.test.ts`,
  `packages/storage/src/repos/guilds.test.ts` (the seven new tests; reverted
  — leaving them in would permanently red the suite since their columns
  cannot land as specified)

Nothing was migrated against any real or test database at any point;
`db:generate` only produces SQL text, never applies it.
