# Handoff — Slice 6 closed, flip day next

**Branch:** `worktree-release2-slices-3-6` (worktree
`.claude/worktrees/release2-slices-3-6`)
**Head:** `88d1ab1`
**Gates on a clean tree, each run alone and read by exit code:** `typecheck` 0,
`lint` 0, `test` 0 — **2388 tests across 114 files**.

Slices 3+5, 4 and 6 are all closed on this branch. Slice 6 was the last thing
standing before flip day, and the instruction for this run was to stop here.

## Read these first, in this order

1. `docs/reports/release2-slices-1-6-ledger.md` — the full record. Ten plan
   rulings for this slice (PR-26…PR-35), the review findings, and the close-out.
2. `docs/decisions/0042-...-enforcement-is-offerable.md`, **including both
   amendments**. Amendment 1 is why a table rebuild was safe; Amendment 2 is
   when a sign-off stops being true.
3. `docs/reports/slice-6-whole-branch-review.md` and
   `docs/reports/slice-6-fixwave-re-review.md` — what was found, what was fixed,
   and what was deliberately left.

## Merge

```
git checkout main
git merge --no-ff worktree-release2-slices-3-6
```

Then, before anything else, confirm on `main`:

```
npm run typecheck
npm run lint
npm run test
```

Read each exit code separately. Do not pipe a gate through `tail` — ruling E-5
on this project is a coordinator reporting lint green while it had been red for
two commits, because the pipeline's status was `tail`'s.

## The decision waiting for you

**A cutover cannot be completed from the CLI, and that is by design — but it
means flip day needs Slice 11 before it can finish.**

Nothing writes `cutover_state = 'observing'` or `automod_testing_mode`.
`setRuleMode` has no production caller and there is no `automod mode` command,
so `automod ready` cannot succeed and `doctor`'s new observe-window check cannot
fire. The spec assigns driving the state machine to Slice 11 ("under owner
decision, not a timer") and displaying it to Slice 8's cutover board, so this is
not a gap in Slice 6 — but it does decide what happens next.

The upside is real and worth being explicit about: **nothing can reach
`mode = 'enforce'` at all this release.** That is the safest state available for
a merge, and it is why shipping this way is defensible rather than merely
tolerable.

Your choice is between:

- **Start the observe window by hand.** Apply the migrations to the live
  database, then set `mode = 'observe'` on the rules you want observing via SQL,
  which also stamps nothing — `observe_started_at` is written by `setRuleMode`,
  so a hand-set mode leaves the clock null and `doctor` will never call the
  window complete. If you go this way, set `observe_started_at` in the same
  statement, and note the value you used.
- **Build Slice 11 first**, then start the window through the command that is
  supposed to start it. Slower to begin, and the clock and the audit row are
  correct by construction.

I have not made this choice for you because it changes external side effects and
retention, which is the line at which this project's working style says to ask.

## What is true about the moderation path today

Merged and green. Nothing more.

No migration has been applied to the live database. **No automod rule has
evaluated a single real message, in any mode.** `STATE.md` carries this as a
standing rule and it matters most here: Release 2's gate is written against a
false-positive rate, and a rate can only be measured from rules that have really
been observing. That number does not exist yet and cannot.

Slice 6 also ships a **two-week floor** before `doctor` will call an observe
window complete (`OBSERVE_WINDOW_FLOOR_MS`, `docs/08`). So the shortest possible
path to Release 2's gate is: start the window, wait a fortnight of real traffic,
review the matches that produced, then decide. That fortnight is wall-clock and
no amount of implementation shortens it.

## Where Release 2 stands

Slices 0–6 merged. **Slices 7–12 remain**, and the back half is heavier:

| Slice | Scope |
| --- | --- |
| 7 | The application shell — routing, design tokens, layout, shared components; the five existing sections migrate with no behaviour change |
| 8 | Release 2 pages — automod rules, cases and member history, the cutover board |
| 9 | The false-positive review screen. **The one Release 2's gate depends on** — it supplies the numerator |
| 10 | Release 3 route stubs |
| 11 | Cutover, one rule at a time, atomic |
| 12 | Release 2 gate sign-off — live smoke tests, `doctor` clean, the "done when" clause checked line by line |

Slices 7–10 are what you would build *during* the observe window rather than
after it, which is what the spec's dependency graph shows.

## Carried forward

- **No `doctor` check for hand-edited thresholds.** `min_reviewed_matches = 0`
  bypasses the evidence requirement through a deliberate early return. `doctor`
  reports a hand-edited `cutover_state` but not a hand-edited threshold. Worth a
  check once Slice 8 gives the dashboard a writer for either.
- **No two-guild test on the gate.** Guild scope was verified by reading every
  new query and the schema invariant test covers the partition key, but the gate
  has no test seeding two guilds and proving one cannot see the other's
  evidence. Every other repository here has one.
- **No minimum on sign-off evidence.** The bar is one agreeing fixture — the
  weakest non-vacuous bar. Setting a real number needs someone who has watched a
  real observe window (ADR 0042 Amendment 2).
- **`invite`'s `last_matched_at`** (PR-14) and the **handwritten-fixture
  synthetic author**, both deferred to Slice 9 in earlier slices and still open.

## The next prompt

> Continue Release 2. Read `docs/reports/release2-slice-6-handoff.md` and follow
> it. Decide the observe-window question in it before touching code — the two
> options have different consequences for retention and for how long the gate
> takes. Then build Slice 7, the application shell, following the same protocol:
> ADR first if the spec names one, plan, plan review by a cheap model, execution
> in dispatches of two to three tasks, whole-branch review by the strongest
> model, one fix wave, re-review of the fixes. Invoke the `frontend-design`
> skill — the spec says Slice 7 is when it applies, not before. Do not build any
> part of Slices 8–12.

## A note on method, for whoever runs the next slice

Two of Slice 6's four review rounds found defects in *fixes*, not in original
code — including a fix that overstated its own reach in a comment, which no test
could have caught. The re-review round is not ceremony; it has now earned its
place two slices running. Keep it.

The other thing that paid for itself: briefs that name a specific claim to
verify against `node_modules` rather than from memory. The rollback fix turned
entirely on whether drizzle distinguishes `undefined` from `null` in a `.set()`.
Had it not, the fix would have silently cleared sign-offs on every unrelated
write — worse than the bug. The re-review verified it three ways because the
brief told it to.
