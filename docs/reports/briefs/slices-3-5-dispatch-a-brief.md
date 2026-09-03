# Brief — Dispatch A: Tasks 1 and 2, the OD-3 attachment corpus

Work in `/home/bryan/projects/bananasaurs/.claude/worktrees/release2-slices-3-6`.
This is a git worktree. **Do not `cd` to `/home/bryan/projects/bananasaurs`** —
run everything from the worktree.

## Your task

Implement **Task 1 and Task 2 only** from
`docs/superpowers/plans/2026-09-02-slices-3-5-stateless-predicates.md`.

Read, in this order:

1. `CLAUDE.md` — the hard rules. They override the plan and this brief.
2. The plan's **Global Constraints**, **Verified environment facts** and
   **Plan rulings** sections. All of it applies to you.
3. The plan's **Task 1** and **Task 2**, in full.

Do **not** implement Tasks 3–8. Do not start Task 6 even though the dispatch
table now puts it second — that is a later dispatch.

## What this work is

The automod fixture corpus (`automod_fixtures`) stores matched messages so a
human can review whether a rule was right. Owner decision **OD-3** widened it
to also store each attachment's **filename, content type and size**, so the
`attachment_type` predicate can be replayed against real observed traffic
instead of only handwritten cases.

Task 1 is the storage side: a child table, the repository changes, and the
`PRIVACY.md` line. Task 2 is the core side: the field on `FixtureRecord`, the
reconstruction in `predicateInputFrom`, and the `captureFixture` port carrying
attachments through to the wiring.

## Things that will bite you, specifically

- **`rg` with no path argument is blocked by the sandbox** (it could read
  `.env`). Always give `rg` an explicit file or directory:
  `rg -n "pattern" packages/storage/src/repos/automod-fixtures.ts`. Never ask
  for `.env` or any credential file — you do not need one. `npm run test` runs
  with no network and no live Discord by design.
- **`grep` returns false negatives in this sandbox.** Use `rg` with a path, or
  `awk '/pattern/{print FILENAME": "FNR": "$0}'`. A `grep` that finds nothing
  is not evidence.
- **This shell substitutes backticks inside `git commit -m`.** Do not use them
  in commit messages.
- **`npm run db:generate` is the only way to produce a migration.** Never
  hand-write one. After generating, **read the SQL** and confirm it is a pure
  `CREATE TABLE`: no `__new_` table, no `DROP TABLE`, no `RENAME`. Ledger
  ruling R-5 records a reproduced data-loss bug in the table-rebuild path. If
  the generator emits a rebuild, **stop and report it** — working around it is
  not your call.
- **The plan contains a deliberate self-contradiction in Task 1, Step 5**, about
  attachment ordering: the test's expected order and the order the code passes
  them in disagree. Decide which is right, fix it, and **say in your report
  which you changed and why.** There may be others that are not deliberate —
  Slice 2's plan carried eight defects into execution. When a test and the code
  disagree, say so plainly rather than quietly making one match the other.

## The rule that matters most here

**Break it and watch it fail.** Ten decorative guards were found across
Slices 1–2 — tests asserting something true about an input where the bug they
were named after could not occur. The shape is *a fixture too simple to reach
the branch the test is named after*.

Task 1's cascade test is the one that must genuinely work: the whole point of
shipping `deleteObservedFixturesForMember` two releases before `/forgetme`
exists was that the corpus can be un-made. The plan tells you to neutralise the
cascade in the generated migration, watch the orphan assertion go red, and
restore. **Do that, and report exactly what you saw.** A cascade test that
passes without a cascade is worse than no test.

Same for Task 2: the plan's subscriber test must fail if `attachments` is passed
through as `[]`. Verify that by actually doing it.

## Privacy, and why it is in this task rather than a later one

`PRIVACY.md` gains its attachment line **in the same commit as the migration**
(ADR 0041 §1's rule, applied to OD-3). Filenames routinely carry personal
information — `Bryan_resume_2026.pdf`, `medical_letter.docx` — and this stores
them for as long as the corpus keeps the message. The owner was told that before
approving it. A policy that is not true is worse than none, so the sentence and
the table land together. Do not split them into two commits.

Match the document's voice: it is written for club members, plain, one bullet
per thing. Do not add a separate bullet and do not use the word "metadata".

## Gates

Before you report either task done:

```
npm run typecheck && npm run lint && npm run test
```

All three clean. **No completion claim on code you have not run.** The baseline
before you start is **2148 tests / 102 files** — if the count drops, you deleted
a test and must say so.

Commit incrementally, one commit per task, using the messages in the plan
(they already carry the required trailers).

## Deliverable

Write your detail to `docs/reports/slices-3-5-dispatch-a-report.md`:

- What you implemented, per task.
- **The plan defects you found**, including the deliberate ordering one — what
  the plan said, what you did, why.
- **Every guard you watched fail**: which line you neutralised, what went red,
  that you restored it.
- How many pre-existing `FixtureRecord` constructions you had to touch in
  Task 2 Step 6 (the plan asks for this count).
- The generated migration's filename and your confirmation it contains no
  rebuild.
- Anything you think is wrong that you did not change.

**Return to the coordinator only five lines:** status per task, commit SHAs,
one-line test summary (`N tests / M files, typecheck + lint clean`), the guards
you watched fail, and any concern. Everything else goes in the report file.
