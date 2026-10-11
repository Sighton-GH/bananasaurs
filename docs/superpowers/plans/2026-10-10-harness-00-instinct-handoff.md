# Instinct handoff: assistant harness Slices 2–6

> For the Instinct orchestrator. You build one round of slices, review and merge each task yourself, and hand back
> one git bundle per slice. You cannot push; the owner gives your bundles to the controller (Claude), who checks
> them, merges them into `main` and resolves conflicts with other work.

## 0. Read first

1. `CLAUDE.md` — hard rules 1–9 are binding on every line of code.
2. `docs/superpowers/plans/2026-10-10-harness-00-shared-contracts.md` — rounds, ADR and migration numbers, the
   cross-slice type names, and the files more than one slice edits.
3. The plan for each slice in your round:

| Round | Plan files |
|---|---|
| 1 | `2026-10-10-harness-slice6-key-pools-routing.md`, `2026-10-10-harness-slice2-new-abilities.md` |
| 2 | `2026-10-10-harness-slice3-streaming.md`, `2026-10-10-harness-slice5-daily-digest.md` (only when marked READY) |
| 3 | `2026-10-10-harness-slice4-attachments.md` (only when marked READY) |

A plan whose status line says DRAFT is not ready: do not start it.

## 1. Machines

You and every subagent have 2 vCPU, 2 GB RAM, Node 22, x86_64 Linux. Measured on this repo:

| Command | Peak memory | Who runs it |
|---|---|---|
| `npx tsc --build` | ≈0.9 GB | subagents and you |
| `npx vitest run <files> --maxWorkers=1` | small | subagents and you |
| `npm run typecheck` (includes test files) | ≈1.73 GB | you only, nothing else running |
| `npm run lint` | moderate | you only |
| `npx vitest run --maxWorkers=1` (full suite, ~8,600 tests) | ≈1.2 GB, ≈17 min | you only, nothing else running |

Never run the full test suite or `npm run typecheck` in a subagent. Never run two heavy commands at once on one
machine.

## 2. Setup (once per machine)

```bash
git clone <repo url> bananasaurs && cd bananasaurs
git checkout harness-slices-plan
git rev-parse HEAD            # record this as BASE in your report
npm ci --no-audit --no-fund
npx tsc --build               # must exit 0 before you start
git config user.name "Instinct"
git config user.email "instinct@invalid"
```

Do not run `npm audit fix`, `npm install <anything>` or change `package.json` / `package-lock.json`.

## 3. Branches

For each slice N in the round:
- Integration branch `instinct/slice-N`, created from BASE.
- One branch per task, `instinct/sN-t<k>`, created from the integration branch's tip **at the start of that
  task's wave**. All tasks in a wave fork from the same commit.

## 4. The loop, per slice

For each wave, in order:

1. **Dispatch.** One subagent per task in the wave, all at once. Give each subagent:
   - the plan's header sections (Goal, Global Constraints, Plan decisions, Waves table) and its own task text,
     copied verbatim;
   - §7 of this file (rules for subagents), verbatim;
   - its branch name. It clones or checks out that branch, does the task's steps in order and commits.
2. **Check each finished task** before merging it:
   - `git diff --name-only instinct/slice-N...instinct/sN-t<k>` lists only the task's **Owns** files. Anything
     else: send it back.
   - Re-run the task's own test command and `npx tsc --build` yourself. Do not trust the subagent's report.
   - Read the diff against the task text: every step done, the test asserts what the task says, nothing extra.
   - Quality: no `TODO`, `.only`, `.skip` or commented-out tests; no real member names; no secrets; no new
     dependency; no `any` added to silence the type checker; guild id present on every new query, key and job;
     model output and request bodies parsed with Zod.
   - Problems → send the findings back to the same subagent (or a fresh one with the findings and the task text).
     At most 3 fix rounds per task. Still failing after 3: leave it out of the merge, record it under "Blocked" in
     the report, and continue with tasks that do not depend on it.
3. **Merge** the wave's passing task branches into `instinct/slice-N`, one at a time:
   `git checkout instinct/slice-N && git merge --no-ff instinct/sN-t<k> -m "Merge S<N>-T<k>: <name>"`.
   Waves are planned so tasks do not share files; a conflict means a task touched a file it did not own. Send that
   task back rather than resolving it by hand.
4. **Wave gate:** `npx tsc --build`, then `npx vitest run <every test file the wave touched> --maxWorkers=1`. Both
   must pass before the next wave starts. If they fail, find the task responsible and send it back.

After the last wave, the **slice gate** (on the integration branch, one command at a time):

```bash
npm run typecheck
npm run lint
npx vitest run --maxWorkers=1
```

All three must pass. A failing test outside the slice's own files may be a real regression: find the cause. Never
weaken, skip or delete a test to make the gate pass.

## 5. When the plan is wrong

- A typo or a wrong line number in a file the task owns: fix it within the task, and add a `Deviation:` line to the
  commit message saying what differed.
- The fix needs a file the task does not own, or changes an interface another task consumes: stop that task, record
  it under "Plan problems" in the report, and continue with what does not depend on it. Do not redesign.
- Never edit the spec, the contracts file or another slice's plan.

## 6. Handing back

For each slice:

```bash
git bundle create slice-N.bundle <BASE>..instinct/slice-N
git bundle verify slice-N.bundle
```

And `slice-N-REPORT.md`:

```
# Slice N report
BASE: <sha>          TIP: <sha of instinct/slice-N>
Tasks merged: S<N>-T1 … (list)
Blocked: <task — reason — what was tried>, or none
Plan problems: <task — what the plan got wrong>, or none
Deviations: <task — what changed and why>, or none
Slice gate: typecheck <exit>; lint <exit>; tests <passed>/<total>, <failed list or none>
Migration: <generated file name, or none>
Peak memory of the full test run: <from /usr/bin/time -v if available>
Notes for the controller: <anything you were unsure of>
```

Give the owner the bundles and the reports. The controller merges them; you do not need to rebase onto anything.

## 7. Rules for subagents (paste into every dispatch)

- Work only on your branch, and only in the files your task **Owns**. Read anything; edit nothing else.
- Follow the task's steps in order. Write the test first and run it to see it fail before writing the code.
- Run only: `npx vitest run <your test files> --maxWorkers=1`, `npx tsc --build`, `npx prettier --write <your
  files>`, `npx eslint <your files>`, and the task's own commands (for example one `npm run db:generate` in the
  migration task). Never the full test suite, never `npm run typecheck`.
- No new dependencies. Do not change `package.json`, `package-lock.json`, tsconfig files or lint config.
- No network access in tests. No live Discord, no real API keys, no `.env` file.
- Fixtures use invented names (Sam L, Alex P, Car Team A). Never a real person's name, id or message.
- Never skip, delete or weaken a test. If a test outside your files fails, report it; do not edit it.
- Never use `git push`, `git rebase`, `git reset --hard` or `git stash`. Commit with the message the task gives.
- When you finish, reply with: files changed, commits, the exact commands you ran and their results, and anything
  in the task that did not match the code.
