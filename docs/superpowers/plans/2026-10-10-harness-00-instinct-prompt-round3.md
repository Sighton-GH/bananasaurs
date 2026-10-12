# Prompt for Instinct — round 3 (Slice 4)

Paste everything below the line into Instinct.

---

You are the orchestrator for building the last slice of this release of Bananasaurs, a TypeScript Discord bot. You
plan nothing: the plan is written and was refreshed against the code you will clone. Your job is to dispatch each
plan task to a subagent, have it reviewed, test and merge it, and hand back one git bundle.

Repository: https://github.com/Sighton-GH/bananasaurs — branch `harness-round3-plan`. You can clone it; you cannot
push, and you never need to. That branch already contains rounds 1 and 2 (Slices 6, 2, 3 and 5, merged and fixed).

Read these files on that branch, in this order, before doing anything else:
1. `docs/superpowers/plans/2026-10-10-harness-00-instinct-handoff.md` — your procedure. Follow it exactly.
2. `CLAUDE.md` — project hard rules; binding on every line of code.
3. `docs/superpowers/plans/2026-10-10-harness-00-shared-contracts.md` — numbering and shared names.
4. `docs/superpowers/plans/2026-10-10-harness-slice4-attachments.md` — Slice 4 plan.

This is round 3: build **Slice 4** on one integration branch, `instinct/slice-4`, created from the BASE commit (the
tip of `harness-round3-plan` when you clone).

This slice adds a new network path: downloading attachment bytes from Discord's CDN and sending images and PDFs to
AI providers. Treat every task that touches fetching, hosts, redirects, byte caps, provider request bodies or traces
as security-sensitive.

You have up to 25 subagents. The Waves table limits how many tasks can run at once (no two tasks in a wave share a
file), so use the spare subagents as reviewers: every task gets a fresh reviewer that did not write it, and every
security-sensitive task (above) gets a second independent reviewer. A reviewer checks the task against its plan text
and the hard rules, opens the real source files to confirm each finding, and says what is wrong; it does not rewrite
the task.

Every machine, yours included, has 2 vCPU and 2 GB RAM. Subagents run only their task's own tests
(`npx vitest run <files> --maxWorkers=1`), `npx tsc --build`, and `npx tsc -p tsconfig.all.json --noEmit` when they
changed a test file (`tsc --build` does not type-check tests; split it per package if it runs out of memory). Only
you run the slice gate, one command at a time, with nothing else running: `npm run typecheck`, `npm run lint`,
`npx vitest run --maxWorkers=1` (set `NODE_OPTIONS=--max-old-space-size=1600` if a worker runs out of heap). If the
combined typecheck or lint runs out of memory, run them per package and say so in the report.

Rules learned in rounds 1 and 2:
- The plan's decisions (D1–D17 and the plan's "Plan decisions") are already the owner's decisions. Do not wait for
  or relay approvals; if a task would need a NEW decision about privacy, cost, retention, permissions, a new
  outbound host or a Discord side effect, stop that task and put the question in the report.
- Attachment bytes may come only from `cdn.discordapp.com` and `media.discordapp.net`. No other host, and no
  redirect to another host, ever. PDFs to OpenRouter only with the file-parser plugin pinned to `native`.
- Every in-memory map or cache key that holds guild data includes the guild id (hard rule 2), even when a route
  checks the guild first.
- Report only what you proved. If something was checked by hand and not by a test, or a gate was not re-run after
  the last change, say "not run" or "manual only" — never "verified".
- The slice adds 7 instance settings: the count pins in `packages/core/src/settings/instance-settings.test.ts` and
  `packages/http/src/routes/assistant-tuning.test.ts` go from 34 to 41. This slice ships no migration.
- Run the full suite at every wave gate you can afford, not only at the end; it is the only thing that catches tests
  other tasks broke.

Give every subagent: the plan's header sections (Goal, Global Constraints, Refresh notes, Plan decisions, Review
Focus, Waves), its own task text, and §7 of the handoff file, all verbatim.

When the slice is done, give me:
- `slice-4.bundle` (`git bundle create slice-4.bundle <BASE>..instinct/slice-4`, then `git bundle verify`);
- `slice-4-REPORT.md` in the format in §6 of the handoff file.

If the slice gets stuck, still hand back what was merged, with the report saying what is blocked and why. Do not
weaken or skip tests to finish.
