# Brief — Dispatch B: Task 6, the relational lists and the `AutomodRule` widening

Work in `/home/bryan/projects/bananasaurs/.claude/worktrees/release2-slices-3-6`.
This is a git worktree. **Do not `cd` to `/home/bryan/projects/bananasaurs`.**

## Your task

Implement **Task 6 only** from
`docs/superpowers/plans/2026-09-02-slices-3-5-stateless-predicates.md`.

Read, in this order:

1. `CLAUDE.md` — the hard rules. They override the plan and this brief.
2. The plan's **Global Constraints**, **Verified environment facts** and
   **Plan rulings** (especially PR-14 and PR-15). All of it applies to you.
3. The plan's **Task 6**, in full.
4. The plan's **"Task order and dispatch batching"** section, so you understand
   why Task 6 runs before the predicates.

Do **not** implement any other task. In particular do not write the `invite` or
`link_domain` predicates — they are dispatch D. Your job is the two tables, the
repository, the hydration, the `AutomodRule` fields, and the fingerprint.

Tasks 1 and 2 are already done (commits `d48a1c4`, `cd34d0e`), so
`FixtureRecord.attachments` and the attachment child table already exist. You
do not need to touch them.

## Why this task runs before the predicates

Every predicate's test file builds an object annotated `AutomodRule` and passes
it to `compileRule`. You are adding two required fields to that interface. If
the predicates were written first, their literals would either omit two
required fields or name two that do not exist — `typecheck` fails either way.
Doing this first means every later literal is written once against a finished
interface.

**So the shape you produce is the contract four later tasks are written
against.** The plan names it exactly; do not rename these fields:

```ts
readonly inviteAllowlist: readonly { code: string; label: string }[];
readonly linkDomains: readonly { domain: string; listType: 'allow' | 'deny' }[];
```

If you believe a different shape is better, **say so in your report rather than
changing it** — four other task descriptions already reference these names.

## The obligation this task carries

This is **obligation 2** of `docs/reports/release2-slices-3-5-handoff.md`, and
it is the reason the task exists in this form.

Slice 1 made the rule fingerprint **exclusion-based**: `ruleFingerprint` hashes
every key on `AutomodRule` except an explicit exclusion list, so a field added
later is hashed *without anyone editing `fingerprint.ts`*. That design was
chosen specifically so this slice's relational allowlist could not escape the
cache key.

**Verify it, do not assume it.** If an allowlist edit does not change the
fingerprint, the compiled artifact goes stale and an operator who adds a partner
invite code watches the rule keep firing on it until the daemon restarts. That
is ADR 0039's bug — a rule that looks configured and silently misbehaves —
wearing a new coat. It has cost this project two slices already.

The plan's Step 8 tells you to add `'inviteAllowlist'` to `EXCLUDED_FIELDS`,
watch the guard go red, and restore. **Do that literally and report what you
saw.** If the guard stays green with the field excluded, the guard is decorative
and the obligation is unmet — say so loudly rather than moving on.

## `last_matched_at` is deliberately NOT in this table

The spec asks `invite`'s allowlist to carry a last-matched timestamp. **Plan
ruling PR-14 defers it and does not create the column.** Do not add it.

The reasoning, so you do not "helpfully" restore it: populating it honestly
needs either a database write on the predicate's hot path (a single-writer
SQLite database — `REVIEW.md` §C12 — and a predicate is deliberately given no
database handle at all, ADR 0040 §1), or widening
`CompiledPredicate.evaluate`'s return type for all ten predicates so a
*non-match* can carry an observation. An allowlisted invite is a non-match by
construction, so there is no existing side channel. A plan reviewer searched
for a third option and found none. It is carried to Slice 9.

## Things that will bite you, specifically

- **`rg` with no path argument is blocked by the sandbox** (it could read
  `.env`). Always give `rg` an explicit file or directory. Never ask for `.env`
  or any credential file — you do not need one, and `npm run test` runs with no
  network and no live Discord.
- **`grep` returns false negatives here.** Use `rg` with a path, or `awk`.
- **This shell substitutes backticks inside `git commit -m`.** Avoid them.
- **`npm run db:generate` is the only way to produce a migration.** Never
  hand-write one. Afterwards **read the generated SQL** and confirm two pure
  `CREATE TABLE`s with `STRICT`: no `__new_` table, no `DROP TABLE`, no
  `RENAME`. Ledger ruling R-5 records a reproduced data-loss bug in the
  table-rebuild path. If the generator emits a rebuild, **stop and report it.**
- **A plan's file list is a lower bound, not a list.** Dispatch A found nine
  call sites the plan did not name, all broken by making a field required — and
  found them by running `typecheck`, not by reading. You are making *two*
  fields required on `AutomodRule` and on `StoredAutomodRule`. Expect the same,
  run `typecheck` early, and report how many sites you had to touch.
- **`hydrate` runs once per rule per message.** You are adding two queries to
  it. The plan says to do that unconditionally, with no branch on `kind`,
  matching the comment already in that function. Follow the plan, but if the
  cost looks wrong to you, say so in your report.

## The rule that matters most here

**Break it and watch it fail.** Ten decorative guards were found across
Slices 1–2, and the plan review found an eleventh in this very plan. The shape
is *a fixture too simple to reach the branch the test is named after*.

Two guards in this task need that treatment specifically:

1. **The fingerprint guard**, as described above.
2. **The hydration guard.** The plan requires **two rules, each with entries**,
   so an implementation that drops the `rule_id` predicate hands both lists to
   both rules and goes red. One rule with entries and one without would pass
   under that exact bug — that is the shape to avoid.

## Gates

Before reporting done:

```
npm run typecheck && npm run lint && npm run test
```

All three clean. **No completion claim on code you have not run.** The baseline
you start from is **2159 tests / 102 files**. If the count drops, you deleted a
test and must say so. Expect it to rise by more than the tests you write —
`schema-invariants.test.ts` generates five `it.each` cases per new
guild-partitioned table, and you are adding two tables, so ten come for free.

## Deliverable

Write your detail to `docs/reports/slices-3-5-dispatch-b-report.md`:

- What you implemented.
- **The fingerprint guard**: exactly what you did, what went red, that you
  restored it. This is the obligation; it is the most important paragraph.
- **The hydration guard**: same.
- The generated migration's filename and confirmation it contains no rebuild.
- How many pre-existing `AutomodRule` / `StoredAutomodRule` construction sites
  you had to touch, and where.
- **Any plan defect you found**, including anything where a test and the plan's
  code disagree. Say it plainly; do not quietly reconcile them.
- Anything you think is wrong that you did not change.

**Return to the coordinator only five lines:** status, commit SHA, one-line test
summary (`N tests / M files, typecheck + lint clean`), the guards you watched
fail, and any concern.
