# 0121 — One automod switch (Off / Watch / On) replaces the staged rollout

Status: Accepted (owner, 2026-09-30)
Supersedes: ADR 0042; ADR 0041's sections on fixtures and the dry-run evaluator; ADR 0051's S11-D6 (CLI-only enforcement); REVIEW.md §A4 per-rule cutover tracking and §E's automod done-when clause.

## Context
Release 2 shipped automod behind a per-rule process: test/observe/enforce
modes, a five-state cutover machine, a 14-day observe floor, a tiered
false-positive gate, ready and owner sign-off, a legacy-rule reference and
attestation, and a corpus of saved member messages (fixtures) for dry-run
replay. The club ran 17 days of observation and the owner reviewed every
match. The owner wants one lever instead.

## Decision
1. `guilds.automod_state` ∈ {off, watch, on}, default off. Off: rules are not
   evaluated, nothing is recorded. Watch: matches recorded as `would_delete`,
   no Discord action. On: delete and escalate, still behind the kill switch,
   breaker and guild dry run.
2. Per-rule `mode`, `cutover_state`, the observe clock, sign-off, legacy ref,
   the false-positive gate thresholds, `automod_testing_mode`, fixtures and
   dry-run replay are removed — code, routes, CLI commands, `doctor`
   findings, dashboard UI and columns/tables.
3. Kept for tuning: match flags (`mod_match_reviews`) and suppress.
4. The switch is set from the dashboard's automod tab with a confirmation;
   moving toward more action needs a fresh password, toward less does not
   (ADR 0029's asymmetry). Audited as `automod.state_set`.
5. REVIEW §A4's no-overlapping-enforcement rule survives as a human check:
   the On confirmation tells the owner to turn off the matching Carl-bot /
   Dyno automod first.

## Consequences
- Dropping fixtures deletes stored copies of member messages (irreversible;
  owner accepted). Retention shrinks.
- Release 2's gate is amended: "automod reaches On via the switch, with an
  audit row", replacing the per-rule observe-floor and cutover rows.
- The unmerged Slice 11 branch (`worktree-slice-11-cutover`) is abandoned.
- AI remains outside the enforcement path (ADR 0002): nothing here involves a
  model.
