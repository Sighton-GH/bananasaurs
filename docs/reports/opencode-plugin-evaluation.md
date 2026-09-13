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

(one entry per dispatch, appended as they happen)

## What worked well

(appended as observed)

## Cost and time versus Slices 0–6

Slices 0–6 with sonnet subagents: a typical implementation dispatch of two to
three tasks returned in 4–12 minutes; a task review in 2–5 minutes; the
coordinator's context cost per dispatch was the five-line report plus the
brief path.

(opencode numbers appended per dispatch)
