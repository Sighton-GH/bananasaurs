# Brief — Dispatch D: Tasks 5, 7 and 8 — `attachment_type`, `invite`, `link_domain`

Work in `/home/bryan/projects/bananasaurs/.claude/worktrees/release2-slices-3-6`.
This is a git worktree. **Do not `cd` to `/home/bryan/projects/bananasaurs`.**

## Your task

Implement **Tasks 5, 7 and 8** from
`docs/superpowers/plans/2026-09-02-slices-3-5-stateless-predicates.md`, in that
order, one commit each.

Read, in this order:

1. `CLAUDE.md` — the hard rules. They override the plan and this brief.
2. The plan's **Global Constraints**, **Verified environment facts** and
   **Plan rulings** — PR-14, PR-15 and PR-16 are yours specifically.
3. The plan's **Task 5**, **Task 7** and **Task 8**, in full.

Do **not** implement Tasks 3 or 4 (`regex`, `caps`, `emoji`) — a different
dispatch owns them and may be running concurrently. **Touch only the files your
three tasks name.** If you need to change a shared file not in your task's file
list, say so in your report instead of doing it.

## What is already done

- Tasks 1–2 (`d48a1c4`, `cd34d0e`): the fixture corpus stores attachment
  filename, content type and size (OD-3), and `predicateInputFrom` reconstructs
  them for a replayed fixture. So `FixtureRecord.attachments` and
  `PredicateInput.attachments` both exist and carry real data.
- Task 6 (`84f4d9e`): `AutomodRule` already has **`inviteAllowlist`**
  (`{ code, label }[]`) and **`linkDomains`** (`{ domain, listType }[]`),
  hydrated from two new tables, and both reach the rule fingerprint.

So every `AutomodRule` literal you write must include all four list fields
(`terms`, `allowlist`, `inviteAllowlist`, `linkDomains`). The plan's code blocks
already do. **If any of those fields does not exist on `AutomodRule`, stop and
say so** — do not delete fields to make it compile.

Baseline: **2174 tests / 102 files**, typecheck and lint clean.

## The obligation Task 5 carries — read this twice

Task 5 is **obligation 3** of `docs/reports/release2-slices-3-5-handoff.md`.

The one-code-path gate (ADR 0041 §3) asserts that the dry-run evaluator and the
live subscriber produce identical matches. It does — but **it is a behavioural
comparison, so it can only detect a divergence in a field some shipped predicate
actually reads.** Until now the only predicate was `keyword_filter`, which reads
`content` and nothing else. A wrong `atMs`, a bypassed cache, and a hand-built
`PredicateInput` that skipped attachment reconstruction all passed it.

**`attachment_type` is the first predicate to read a second field.** Your job is
to make the behavioural gate reach that field.

The plan's Step 5 tells you to prove the widening works by temporarily restoring
`attachments: []` in `predicateInputFrom`'s fixture branch and confirming that
**your new test goes red while the pre-existing `keyword_filter` gate stays
green.** That contrast is the entire point — it demonstrates the gate was blind
and now is not. **Report both halves of what you observed.** If your new test
stays green, the widening did not happen.

## Things that will bite you, specifically

- **`rg` with no path argument is blocked by the sandbox** (it could read
  `.env`). Always give `rg` an explicit file or directory. Never ask for `.env`
  or any credential file — you do not need one, and `npm run test` runs with no
  network and no live Discord by design.
- **`grep` returns false negatives here.** Use `rg` with a path, or `awk`.
- **This shell substitutes backticks inside `git commit -m`.** Avoid them.
- **No migration in this dispatch.** All three tasks are pure `packages/core`
  code plus registry entries. If you think you need a schema change, stop and
  report it — `attachment_type`'s lists live in `mod_rules.config` as JSON
  arrays deliberately (plan ruling PR-16), not in tables.
- **`invite` and `link_domain` use module-level `g`-flagged regexes with
  `matchAll`.** This looks like it contradicts plan ruling PR-13, which refuses
  the `g` flag in the operator-configured `regex` predicate. It does not, and a
  reviewer verified why: **`matchAll` does not mutate the shared regex's
  `lastIndex` across calls**, whereas `.test()`/`.exec()` on a `g` regex do. Keep
  `matchAll`. If you switch either to `.test()` or `.exec()`, you reintroduce a
  bug where the same message gets different answers depending on what preceded
  it. The files' comments say this; do not contradict them.
- **A plan's file list is a lower bound.** Dispatch A found nine call sites the
  plan never named. Run `typecheck` early and often.

## The rule that matters most

**Break it and watch it fail.** Eleven decorative guards have now been found on
this project — ten across Slices 1–2 and one in this plan, caught by the plan
review. The shape is always the same: *a fixture too simple to reach the branch
the test is named after*. A correct assertion on an input where the bug cannot
occur. It passes before the fix and after, so it looks like coverage and is not.

Each of your three tasks names a specific guard to break and watch:

- **Task 5:** restore `attachments: []` in the fixture branch — new gate red,
  old gate green.
- **Task 7:** make the `invite` loop return on the first invite regardless of
  the allowlist — the "fires on the one code that is not allowlisted" test must
  go red. That test has two invites in one message, one allowlisted, precisely
  so it can catch this.
- **Task 8:** replace `hostMatches` with a bare `host.endsWith(entry)` — the
  `notexample.com` test must go red **while the subdomain test stays green**.

Do all three. Report what you saw for each, including which assertion failed and
how. A guard you did not watch fail is a guard you have not tested.

## Also worth knowing about these three predicates

- **`invite` is pattern matching only. No resolution, ever.** Resolving a code to
  a guild id is an outbound API call, which CLAUDE.md rule 8 forbids without an
  explicit instruction, and the owner deliberately withheld one. The known cost
  is that a partner rotating their invite produces one false positive that
  Slice 9 resolves in one click. That is designed for, not a gap to fix.
- **`link_domain` does no fetching, no DNS, no resolution.** Same rule.
- Both of those predicates therefore work with every network unreachable, which
  is CLAUDE.md rule 1's requirement and worth confirming in your report.

## Gates

Before reporting done:

```
npm run typecheck && npm run lint && npm run test
```

All three clean. **No completion claim on code you have not run.** If the test
count drops below 2174 you deleted a test and must say so.

## Deliverable

Write your detail to `docs/reports/slices-3-5-dispatch-d-report.md`:

- What you implemented, per task, one commit each.
- **The three guards you watched fail**, with what went red and how. Task 5's
  needs both halves (new red, old green).
- **Any plan defect you found** — where a test and the plan's code disagree, or
  an assertion that cannot hold. Say it plainly; do not quietly reconcile.
- Confirmation that `predicateFor` now returns a predicate for **seven** of the
  ten kinds if dispatch C has landed, or **five** if it has not, and that the
  absent ones are the window tier (`mention_spam`, `rapid_spam`,
  `duplicate_message`) plus whatever dispatch C still owes.
- Anything you think is wrong that you did not change.

**Return to the coordinator only five lines:** status per task, commit SHAs,
one-line test summary, the guards you watched fail, and any concern.
