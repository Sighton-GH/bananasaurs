# Brief — Dispatch E: Task 9, a CLI write path for the two relational lists

Work in `/home/bryan/projects/bananasaurs/.claude/worktrees/release2-slices-3-6`.
This is a git worktree. **Do not `cd` to `/home/bryan/projects/bananasaurs`.**

## Your task

Implement **Task 9 only** from
`docs/superpowers/plans/2026-09-02-slices-3-5-stateless-predicates.md`.

Read, in this order:

1. `CLAUDE.md` — the hard rules. They override the plan and this brief.
2. The plan's **Global Constraints** and **plan ruling PR-19**.
3. The plan's **Task 9**, in full.
4. `packages/core/src/ops/commands/automod.ts` — specifically
   `automodVerdictCommand`, which is the model you are copying. It is the
   existing write command with an audit row, and it already solves the
   "operator mistyped an id" problem the way this task should.

Everything else in Slices 3+5 is done: Tasks 1, 2, 5, 6, 7, 8 (`d48a1c4`,
`cd34d0e`, `30fee50`, `2f4ca8e`, `dc9933f`) and Tasks 3, 4 (`9b779fc`,
`56bd768`). All six predicates ship; seven of the ten kinds are registered.

Baseline: **2221 tests / 108 files**, typecheck and lint clean.

## Why this task exists

Task 6 built repository functions for the `invite` allowlist and the
`link_domain` allow/deny lists — and **nothing outside a test calls them.** An
operator cannot add their own club's invite code.

That is not merely untidy. `observe` mode never touches Discord, so an empty
allowlist harms nobody during the window — but an `invite` rule with an empty
allowlist **fires on the club's own invite links**, every time a member posts
one. Slice 6's release gate demands **zero** false positives for a rule that
feeds the escalation counter, with a 20-match minimum before a rate means
anything at all. So that rule can never pass its gate until the list is
populated, and the spec's pre-flip rehearsal exists precisely so this is found
on the day rather than two weeks into a two-week window.

**Scope discipline matters here.** This is a CLI surface only, following the
precedent of Slice 2's ruling PR-6, which established the `automod` command
namespace (`automod dryrun`, `automod review`, `automod verdict`). **Do not
build any dashboard, HTTP route, or Discord command** — the dashboard is
Slice 8 and Release 2's scope rule (`CLAUDE.md`, "Current release scope")
forbids building ahead. If you find yourself editing anything under
`packages/dashboard`, stop.

## The authority on the repository's signatures

Read the real function names and signatures from
`packages/storage/src/repos/automod-rule-lists.ts`. **Do not trust the plan's
list** — Task 6 may have adjusted names, and the file is the authority. The
plan says so itself. Report any divergence you find.

## Things that will bite you, specifically

- **Adding ports breaks every stub of the ops ports in the repo.** This is the
  known shape: Slice 1 Task 6 had to touch
  `packages/core/src/ops/test-fixtures.ts` **and**
  `packages/http/src/test-support.ts` for exactly this reason. **Run
  `npm run typecheck` immediately after adding the port declarations, before
  writing the wiring** — the compiler is the only reliable way to find them all.
  Dispatch A found nine call sites a plan had not named. **Report how many you
  touched.**
- **`no-such-rule` must be a returned value, not a thrown error.** The composite
  foreign key would otherwise surface an opaque
  `FOREIGN KEY constraint failed` to an operator who simply mistyped a rule id.
  Match `recordMatchVerdict`'s `'no-such-event'` shape: a usage answer, with an
  audit row still written, because "an operator tried to edit a rule that does
  not exist" is a fact worth having.
- **`'already-present'` is a real answer too.** `onConflictDoNothing` makes a
  repeated add a silent no-op; telling the operator "that code was already
  allowed" beats both silence and a fault.
- **`rg` with no path argument is blocked by the sandbox** (it could read
  `.env`). Always give `rg` an explicit file or directory. Never ask for `.env`
  or any credential file — you do not need one, and `npm run test` runs with no
  network and no live Discord by design.
- **`grep` returns false negatives here.** Use `rg` with a path, or `awk`.
- **This shell substitutes backticks inside `git commit -m`.** Avoid them.
- **No migration.** Task 6 created both tables. If you think you need a schema
  change, stop and report it.
- **New log or audit fields need care.** If you log a new *field name*, it must
  be added to `LOGGABLE_FIELDS` in `packages/core/src/obs/logger.ts` with a
  comment saying what may flow into it, or Pino's allowlist silently drops it
  and records `droppedFields: 1` — that is ledger ruling R-10, a shipped bug of
  exactly this shape. Audit rows are a different mechanism; check how
  `automod verdict` does it and follow that.

## The test that makes this task worth having

The plan's third test is the one that matters: **an added code stops the
`invite` predicate firing on it**, end to end — command, then storage, then
hydration, then fingerprint, then predicate.

Two things about it:

- **Reuse the predicate cache across the two evaluations. Do not create a fresh
  one.** Reusing it is the point: it proves the *fingerprint* invalidated the
  stale compiled artifact. A fresh cache would pass even if the fingerprint
  ignored the allowlist entirely, which is the bug obligation 2 exists to
  prevent and would make this test decorative.
- Put it wherever it can genuinely run — if the ops test harness cannot reach
  `listEnabledRules`, it belongs in `packages/core/src/automod/` instead. **Say
  in your report where you put it and why.**

## The rule that matters most

**Break it and watch it fail.** Eleven decorative guards have been found on this
project, one of them in this very plan. The shape is *a fixture too simple to
reach the branch the test is named after*.

The plan names the guard to break here: make the wiring write the code to the
wrong rule id (or without lower-casing it), and confirm the end-to-end test goes
red. Do it, and report what you saw.

## Gates

Before reporting done:

```
npm run typecheck && npm run lint && npm run test
```

All three clean. **No completion claim on code you have not run.** If the count
drops below 2221 you deleted a test and must say so.

## Deliverable

Write your detail to `docs/reports/slices-3-5-dispatch-e-report.md`:

- What you implemented: the four commands, the ports, the wiring.
- **Where you put the end-to-end test and why**, and confirmation that it
  reuses the predicate cache rather than creating a fresh one.
- **The guard you watched fail**, with what went red and how.
- How many ops-port stubs you had to touch, and where.
- Any divergence between the plan's assumed repository signatures and the real
  ones in `automod-rule-lists.ts`.
- **Any plan defect you found.** Say it plainly; do not quietly reconcile.
- Anything you think is wrong that you did not change.

**Return to the coordinator only five lines:** status, commit SHA, one-line test
summary, the guard you watched fail, and any concern.
