# Prompt for Instinct — round 2 (Slices 3 and 5)

Paste everything below the line into Instinct.

---

You are the orchestrator for building two more slices of Bananasaurs, a TypeScript Discord bot. You plan nothing:
the plans are written and were refreshed against the code you will clone. Your job is to dispatch each plan task to
a subagent, have it reviewed, test and merge it, and hand back one git bundle per slice.

Repository: https://github.com/Sighton-GH/bananasaurs — branch `harness-round2-plan`. You can clone it; you cannot
push, and you never need to. That branch already contains round 1 (Slices 6 and 2, merged and fixed).

Read these files on that branch, in this order, before doing anything else:
1. `docs/superpowers/plans/2026-10-10-harness-00-instinct-handoff.md` — your procedure. Follow it exactly.
2. `CLAUDE.md` — project hard rules; binding on every line of code.
3. `docs/superpowers/plans/2026-10-10-harness-00-shared-contracts.md` — numbering and shared names.
4. `docs/superpowers/plans/2026-10-10-harness-slice3-streaming.md` — Slice 3 plan.
5. `docs/superpowers/plans/2026-10-10-harness-slice5-daily-digest.md` — Slice 5 plan.

This is round 2: build **Slice 3 and Slice 5 at the same time**, each on its own integration branch
(`instinct/slice-3`, `instinct/slice-5`), both created from the same BASE commit (the tip of `harness-round2-plan`
when you clone). Do not start Slice 4.

You have up to 25 subagents. The plans' Waves tables limit how many tasks can run at once (no two tasks in a wave
share a file), so use the spare subagents as reviewers: every task gets a fresh reviewer that did not write it, and
any task that touches Discord posting, pings, permissions, idempotency keys, guild scope or the database gets a
second independent reviewer. A reviewer checks the task against its plan text and the hard rules, and says what is
wrong; it does not rewrite the task.

Every machine, yours included, has 2 vCPU and 2 GB RAM. Subagents run only their task's own tests
(`npx vitest run <files> --maxWorkers=1`), `npx tsc --build`, and `npx tsc -p tsconfig.all.json --noEmit` when they
changed a test file (`tsc --build` does not type-check tests). Only you run the slice gate, one command at a time,
with nothing else running: `npm run typecheck`, `npm run lint`, `npx vitest run --maxWorkers=1` (≈17 minutes). If
`npm run typecheck` or `npm run lint` runs out of memory, run them per package as in round 1 and say so in the report.

Rules learned in round 1:
- The plans' decisions (D1–D17 and each plan's "Plan decisions") are already the owner's decisions. Do not wait for
  or relay approvals; if a task would need a NEW decision about privacy, cost, retention, permissions or a Discord
  side effect, stop that task and put the question in the report.
- Build no Discord message, edit, reaction or ping that the plan does not name. Slice 3's progress is shown in the
  dashboard only; on Discord only the typing indicator changes.
- Both slices add instance settings and each pins the exact count in
  `packages/core/src/settings/instance-settings.test.ts` and `packages/http/src/routes/assistant-tuning.test.ts`.
  Each slice sets the count for its own branch (Slice 3: 30, Slice 5: 32); I reconcile them when merging.
- A full-suite run is the only thing that catches tests other tasks broke; run it at every wave gate you can afford,
  not only at the end.

Give every subagent: the plan's header sections (Goal, Global Constraints, Refresh notes, Plan decisions, Waves), its
own task text, and §7 of the handoff file, all verbatim.

When both slices are done, give me:
- `slice-3.bundle` and `slice-5.bundle` (`git bundle create slice-N.bundle <BASE>..instinct/slice-N`, then
  `git bundle verify`);
- `slice-3-REPORT.md` and `slice-5-REPORT.md` in the format in §6 of the handoff file.

If a slice gets stuck, still hand back what was merged, with the report saying what is blocked and why. Do not
weaken or skip tests to finish.
