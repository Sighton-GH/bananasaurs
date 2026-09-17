# Release 2 gate sign-off

**Status: NOT SIGNED.** Skeleton written 2026-09-17, ahead of the club
guild's observe floor (2026-09-27T02:49:57.656Z). Every cell below is empty
until the thing it names has actually happened. A line that cannot be
ticked is not ticked.

The clause, from `REVIEW.md` §A4: *"Done when: every legacy automod rule
has a Bananasaurs equivalent that ran observe-only for at least two weeks
with an acceptable false-positive rate, cutover happened one rule at a time,
and the whole thing works with every AI provider unreachable."*

## The clause, line by line

| # | Clause | Evidence | Checked by | Date | Ticked |
|---|---|---|---|---|---|
| 1 | every legacy automod rule has a Bananasaurs equivalent | `automod` listing: every club rule's `legacy_rule_ref`; owner's statement that no legacy rule is unaccounted for | | | [ ] |
| 2 | ran observe-only for at least two weeks | `observe_started_at + 14d ≤ now` per rule (`doctor`); **the 2026-09-17 outage of about one day is stated here, not absorbed** — the owner accepted the loss on the day | | | [ ] |
| 3 | with an acceptable false-positive rate | the `automod.rule.cutover` audit row exists for the rule, which `setRuleMode` only writes after `enforcementEligibility` passed | | | [ ] |
| 4 | cutover happened one rule at a time | one `automod.rule.cutover` row per rule, each its own timestamp and attestation | | | [ ] |
| 5 | works with every AI provider unreachable | Section E run with no provider configured; moderation evaluated, cases opened, `doctor` clean | | | [ ] |

## Section E — the cutover rehearsal on the dev guild

(`docs/SMOKE_TESTS.md` Section E, steps 1–11, with timestamps.)

## Section D — the MCP connector over the tunnel

(`docs/SMOKE_TESTS.md` Section D, steps 1–10, with timestamps; or
`docs/reports/mcp-m6-live-run.md` if recorded there.)

## `doctor` at sign-off

(Full output, pasted. Must be `ok`, including `public surface`.)

## ADR tidy

| ADR | Status line current? | Note |
|---|---|---|
| 0042 | | |
| 0044 | | |
| 0045 (Amendments 1–5) | | |
| 0046 | | |
| 0029 (amended) | | |

## Sign-off

Signed by: ____ on ____.
