# Release 2, Slices 1–6 — execution ledger

Working ledger for the run that takes Release 2 from Slice 0 (merged) to
**flip day**. Branch `worktree-release2-slices-1-6`. Started 2026-09-01.

Per `docs/22`: conversation memory does not survive compaction. This file is
the recovery map. Every completed task carries its commit SHAs; every ruling
taken on the owner's behalf is recorded here with **what it costs if wrong**.

Scope: Slices 1–6 of
`docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`.
Slices 7–12 are explicitly **not** in this run — the owner flips the rules and
runs the observe window before the dashboard work starts.

## Carried-forward obligations (owner-assigned at kickoff)

1. **The matcher cache never invalidates on term edits.** `subscriber.ts`'s
   module-level `matcherCache` has no eviction; ADR 0039 widened what a stale
   entry gets wrong (collapse thresholds now derive from the word list). Fix it
   in Slice 1 or 2 — whichever touches that file first. → **Slice 1** does.
2. **Do not reorder Slices 1–6 ahead of 7–10.** The dashboard work happens
   *during* the observe window, not before it.
3. **Any rule whose observe data predates ADR 0039 is worthless.** Restart
   those clocks — the rule was not firing.

## Slice status

| Slice | ADR | Plan | Status |
| --- | --- | --- | --- |
| 1 — predicate abstraction + `mod_rules.config` | 0040 | — | not started |
| 2 — fixtures, dry-run evaluator, traces, CLI review | 0041 | — | not started |
| 3 — precise tier (`regex`, `invite`, `link_domain`) | — | — | not started |
| 4 — window tier (`mention_spam`, `rapid_spam`, `duplicate_message`) | — | — | not started |
| 5 — shape tier (`caps`, `attachment_type`, `emoji`) | — | — | not started |
| 6 — cutover tracking, observe gating, automod testing mode | 0042 | — | not started |

## Rulings

_None yet._

## Deferred minors

_None yet._
