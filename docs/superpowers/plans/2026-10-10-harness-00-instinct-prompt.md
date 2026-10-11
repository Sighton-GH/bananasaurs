# Prompt for Instinct — round 1 (Slices 6 and 2)

Paste everything below the line into Instinct.

---

You are the orchestrator for building two slices of Bananasaurs, a TypeScript Discord bot. You plan nothing: the
plans are written. Your job is to dispatch each plan task to a subagent, review and test each result yourself,
merge it, and hand back one git bundle per slice.

Repository: https://github.com/Sighton-GH/bananasaurs — branch `harness-slices-plan`. You can clone it; you cannot
push, and you never need to.

Read these files on that branch, in this order, before doing anything else:
1. `docs/superpowers/plans/2026-10-10-harness-00-instinct-handoff.md` — your procedure. Follow it exactly.
2. `CLAUDE.md` — project hard rules; binding on every line of code.
3. `docs/superpowers/plans/2026-10-10-harness-00-shared-contracts.md` — numbering and shared names.
4. `docs/superpowers/plans/2026-10-10-harness-slice6-key-pools-routing.md` — Slice 6 plan.
5. `docs/superpowers/plans/2026-10-10-harness-slice2-new-abilities.md` — Slice 2 plan.

This is round 1: build **Slice 6 and Slice 2 at the same time**, each on its own integration branch
(`instinct/slice-6`, `instinct/slice-2`), both created from the same BASE commit (the tip of `harness-slices-plan`
when you clone). Do not start Slices 3, 4 or 5.

Every machine, yours included, has 2 vCPU and 2 GB RAM. Subagents run only their task's own tests
(`npx vitest run <files> --maxWorkers=1`) and `npx tsc --build`. Only you run the slice gate, one command at a time,
with nothing else running: `npm run typecheck`, `npm run lint`, `npx vitest run --maxWorkers=1` (≈17 minutes).

Give every subagent: the plan's header sections (Goal, Global Constraints, Plan decisions, Waves), its own task text,
and §7 of the handoff file, all verbatim.

When both slices are done, give me:
- `slice-6.bundle` and `slice-2.bundle` (`git bundle create slice-N.bundle <BASE>..instinct/slice-N`, then
  `git bundle verify`);
- `slice-6-REPORT.md` and `slice-2-REPORT.md` in the format in §6 of the handoff file.

If a slice gets stuck, still hand back what was merged, with the report saying what is blocked and why. Do not
weaken or skip tests to finish.
