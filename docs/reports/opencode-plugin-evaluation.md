# Evaluating `opencode-delegate` for implementation and review dispatches

Kept as the work happens, starting 2026-09-12 with Slice 7. Compares the
`opencode-delegate:opencode-driven-development` plugin (v0.3.0, opencode
1.18.30) against the sonnet-subagent protocol that built Slices 0–6
(`docs/22_DELEGATION_AND_CONTEXT.md`). Every entry: what happened, what was
expected, what was done instead, whether it cost a re-dispatch.

## Setup findings (before the first dispatch)

- **Free catalog on 2026-09-12:** seven models with `toolcall=yes` —
  `big-pickle`, `ling-3.0-flash-fin-free`, `mimo-v2.5-free`,
  `muse-spark-1.2-contributor-free`, `muse-spark-1.3-contributor-free`
  (1,048,576 ctx, 2026-09-02), `nemotron-3.5-lightning-free`,
  `nemotron-3-ultra-free`. Implementer and task reviewer:
  `opencode/muse-spark-1.3-contributor-free`, as instructed.
- **Whole-branch review is not an opencode job.** The instruction is
  "strongest model available, whichever tool provides it"; that is Opus via
  the Agent tool, not any free opencode model. The plugin's own final-review
  step is therefore replaced for that one dispatch. Recorded so the comparison
  is honest: the plugin is being evaluated for implementation and task-level
  review, not for the last line of defence.
- **Worktree layering.** This session runs in
  `.claude/worktrees/release2-slices-7-12` (the harness requires it). The
  plugin creates its own worktree under `.oc-worktrees/<branch>` relative to
  the repo it is run in, branching from the current HEAD. Expected to work
  since worktrees share one `.git`; verified below at the first dispatch.
- **Ledger placement.** The plugin wants its ledger at
  `.oc-runs/<slug>/progress.md`, which it gitignores. This project's rule is
  that a ruling living only in an unversioned file is a decision made in
  secret, so every ruling is mirrored into
  `docs/reports/release2-slices-7-12-ledger.md` at slice close. Two ledgers is
  a cost of the plugin, small but real.

## Dispatch log

### D1 — Slice 7 plan review (`--role review`, muse-spark-1.3) — 2m30s, no re-dispatch

- **What happened:** the review agent read the plan, the ADR, `App.tsx`,
  `api.ts`, SANDBOX_RULES, and the type definitions of `wouter`,
  `@radix-ui/react-dialog` and `@types/react` in `node_modules`, and returned
  2 Important + 4 Minor findings. The headline finding — `JSX.Element` is not
  a global under `@types/react` 19 — was verified true
  (`node_modules/@types/react/index.d.ts:4141`, no `declare global`). One
  Minor (shared `useId` in `Field`) led, on verification, to a real test
  failure the reviewer had not named (`getByLabelText` would not match a
  label whose text content included the hint). Rulings PR-36..PR-40.
- **Expected:** a sonnet plan review on Slices 3–6 typically returned 1–3
  findings in 3–5 minutes, and rarely opened `node_modules`.
- **Done instead:** nothing; the review was better than the baseline.
- **Cost:** 2m30s wall clock, zero coordinator context beyond the RESULT
  block. No re-dispatch.
- **Worked well:** the read-only `plan` agent went to the type definitions
  unprompted, which is exactly `docs/22`'s "verify against `node_modules`"
  rule.

### D2 — Slice 7 Task 1 implement (muse-spark-1.3) — 14m44s, no re-dispatch

- **What happened:** thirteen files from a 29 KB brief; five checkpoint
  commits, one per plan step; `DONE_WITH_CONCERNS`. The concerns were real
  and correct: three places where the plan's verbatim code could not compile
  or run under this repo's tooling (`.ts` cannot import from `.tsx` under
  `tsconfig.all.json`; `exactOptionalPropertyTypes`; RTL auto-cleanup needs
  vitest `globals`). It fixed each minimally, commented every deviation in
  the code, changed two config files outside its Files list, and *said so*
  rather than hiding it. Every claim verified by the coordinator.
- **Expected:** a sonnet implementer on Slices 3–6 would have done the same
  in 6–10 minutes and more often asked (NEEDS_CONTEXT) before touching a file
  outside its list.
- **Done instead:** nothing; ruled PR-41 and carried the constraints forward.
- **Cost:** ~15 minutes wall clock — roughly double the sonnet baseline for
  a task of this shape — and the run crossed the Bash tool's 600 s ceiling,
  so its summary arrived through a background notification. Zero
  re-dispatch. Coordinator context: the RESULT block (~40 lines).
- **Model quality (muse-spark-1.3):** good. The deviations were the right
  ones and the explanations were precise (it cited TS6142 by number). It
  wrote `Field` with the `cloneElement` pattern from the plan correctly.

### D3 — Slice 7 Task 1 review (muse-spark-1.3) — 1m33s, no re-dispatch

- **What happened:** Spec FAIL on the two out-of-list files, Quality
  APPROVED, three Minors that restated the implementer's own disclosed
  deviations. "Checked outside the diff: nothing."
- **Expected:** the same verdict from sonnet; a sonnet reviewer would more
  often have opened `tsconfig.all.json` to test the implementer's TS6142
  claim rather than listing it under Cannot verify.
- **Done instead:** the coordinator verified the claim itself (it is true).
- **Cost:** 1m33s. No re-dispatch. The FAIL was procedurally correct and
  substantively moot — a reviewer cannot know a ruling the coordinator has
  not yet written down, which is an argument for putting rulings into the
  review brief when they pre-date it.

### Plugin mechanics found at the first two runs

- **No dependency install in the plugin's worktree.** `oc-task` created
  `.oc-worktrees/oc/slice-7-shell` from the current HEAD with no
  `node_modules`. The review run survived because it only read files; an
  implementer would have failed its first `vitest`. Ran `npm ci` there by
  hand (5 s from the npm cache; 292 top-level entries). A per-plan cost the
  sonnet flow never paid, and one the plugin should do itself or at least
  say it does not.
- **The branch base is pinned at the first run.** The plan review created
  the branch at `6941fa6`; the plan fixes it prompted landed at `f228198` on
  the coordinator branch. Fast-forwarded `oc/slice-7-shell` by hand before
  the first implement dispatch. Harmless here, but a coordinator who did not
  notice would dispatch implementers against a stale base.
- **`oc-task` prints its summary only at exit**, so a run past the Bash
  tool's 600 s ceiling goes to the background with nothing visible until it
  finishes. Task 1 (13 files, ~30 KB brief) crossed that line.
- **Compound shell commands are refused by this harness** when the session
  is worktree-isolated (a heredoc followed by `&&` was refused twice while
  preparing briefs). Not a plugin fault — SANDBOX_RULES already says so — but
  it means brief generation needs a script file, not a one-liner. Wrote
  `.oc-runs/mkbrief.py` for that.

## What worked well

(appended as observed)

## Cost and time versus Slices 0–6

Slices 0–6 with sonnet subagents: a typical implementation dispatch of two to
three tasks returned in 4–12 minutes; a task review in 2–5 minutes; the
coordinator's context cost per dispatch was the five-line report plus the
brief path.

(opencode numbers appended per dispatch)
