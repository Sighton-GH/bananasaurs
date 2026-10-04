# Release 2 gate sign-off

**Status: NOT SIGNED.** Skeleton written 2026-09-17, ahead of the club
guild's observe floor (2026-09-27T02:49:57.656Z). Every cell below is empty
until the thing it names has actually happened. A line that cannot be
ticked is not ticked.

The clause, from `REVIEW.md` §A4: *"Done when: every legacy automod rule
has a Bananasaurs equivalent that ran observe-only for at least two weeks
with an acceptable false-positive rate, cutover happened one rule at a time,
and the whole thing works with every AI provider unreachable."*

Superseded 2026-09-30 by ADR 0121 (owner decision): one guild-wide Off /
Watch / On switch replaces per-rule observe windows and cutover. The rows
below are the clause as it now stands.

## The clause, line by line

| # | Clause | Evidence | Checked by | Date | Ticked |
|---|---|---|---|---|---|
| 1 | automod reached On via the switch | the `automod.state_set` audit row (`before: off` or `watch`, `after: on`) and its timestamp | | | [ ] |
| 2 | works with every AI provider unreachable | Section E run with no provider configured; moderation evaluated, cases opened, `doctor` clean | | | [ ] |

## Section E — the automod switch on the dev guild

(`docs/SMOKE_TESTS.md` Section E, steps 1–6, with timestamps.)

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
| 0121 | | |

## Sign-off

Signed by: ____ on ____.

### 2026-09-20 - thread-aware automod exemptions

The evaluator now checks channel exemptions against the message channel, its parent channel and its category, and records the actual message channel on match events. `mod_rule_exemptions` held zero live rows when this observe-window-safe change was designed, so no collected match was reclassified.
