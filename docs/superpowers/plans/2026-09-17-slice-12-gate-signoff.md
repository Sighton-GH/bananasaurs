# Slice 12 — Release 2 gate sign-off

**Status: DRAFT.** Written 2026-09-17, ahead of the floor.
**Cannot complete before 2026-09-27T02:49:57.656Z** (the club guild's observe
floor) **and not before the owner has run `automod cutover` on at least one
rule.** Both are facts the clause below checks, and neither can be
manufactured by building something.

The roadmap's description: *"Live smoke tests in the test guild, `doctor`
clean, `docs/SMOKE_TESTS.md` extended for the automod surface, `STATE.md`
updated, ADR tidy, and the 'done when' clause checked line by line."*

## The clause, line by line

`REVIEW.md` §A4: *"Done when: every legacy automod rule has a Bananasaurs
equivalent that ran observe-only for at least two weeks with an acceptable
false-positive rate, cutover happened one rule at a time, and the whole thing
works with every AI provider unreachable."*

| # | Clause | What proves it | Where it is checked |
|---|---|---|---|
| 1 | *every legacy automod rule has a Bananasaurs equivalent* | each `mod_rules` row for the club guild has a non-null `legacy_rule_ref`, and the owner confirms no legacy rule is unaccounted for | `automod` listing + owner statement recorded in the sign-off |
| 2 | *ran observe-only for at least two weeks* | `observe_started_at + OBSERVE_WINDOW_FLOOR_MS ≤ now` on each rule, and the daemon was actually connected for the window — **minus the 2026-09-17 outage of about a day**, which the sign-off must state plainly (the owner accepted the loss) | `doctor` (past-floor check); `docs/STATE.md`'s incident record |
| 3 | *with an acceptable false-positive rate* | ADR 0042's tiered gate: `enforcementEligibility` returned `ok` for the rule at cutover — zero false positives for a counter-feeding rule, or under `max_false_positive_rate` for delete-only, with the low-volume sign-off where used | the `automod.rule.cutover` audit row exists, which `setRuleMode` only writes after the gate passed |
| 4 | *cutover happened one rule at a time* | one `automod.rule.cutover` audit row per rule, each with its own timestamp and attestation; no two share a batch | the audit trail |
| 5 | *the whole thing works with every AI provider unreachable* | the daemon runs with no provider configured or reachable and moderation still evaluates, cases still open, `doctor` still clean | the smoke run (Section E below) with provider env unset |

A line that cannot be ticked is not ticked. The sign-off names which, and
Release 2 is not done until all five are.

## Rulings

**S12-D1 — the outage is stated in the sign-off, not absorbed.** The daemon
was off Discord for about a day inside the window. The owner accepted the
loss of that day's observation on 2026-09-17. The floor is wall-clock and
still elapses on schedule, but line 2's evidence is thinner by a day, and the
sign-off says so rather than pretending the window was continuous.

**S12-D2 — the automod smoke section is run in the dev guild, never the
club.** `docs/SMOKE_TESTS.md` Section E exercises observe, a seeded match, a
review verdict, `ready`, and — on the dev guild only — a real cutover and
rollback, so the commands have been driven end to end before flip day on
the club. Rolling back leaves the dev rule `rolled_back`, which is the
correct end state for a rehearsal.

**S12-D3 — `doctor` clean means clean, including the public surface.** The
M6 probe is part of `doctor` now. A `PROBLEMS FOUND` from a missing Bypass
application is a real problem for the sign-off, because the MCP connector
is part of "the whole thing".

## What can be done before the floor

- `docs/SMOKE_TESTS.md` Section E written (this slice, now).
- The sign-off document skeleton, `docs/reports/release2-gate-signoff.md`,
  with the five-line table above and every cell empty.
- ADR tidy: a list of every ADR touched this release and whether its status
  line is current.

## What cannot

Lines 2, 3 and 4. Those are the floor and the owner's flip-day command.
