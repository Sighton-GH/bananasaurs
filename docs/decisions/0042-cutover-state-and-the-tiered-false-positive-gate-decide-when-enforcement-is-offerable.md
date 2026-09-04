# 0042 — Cutover state and the tiered false-positive gate together decide when enforcement is offerable

Status: accepted
Date: 2026-09-04
Precedes Slice 6 of
`docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`.
Depends on ADR 0035 (the rule engine and its three modes), ADR 0036 (what the
subscriber records, and `openOrResolveCase`'s `countsAsViolation` parameter),
ADR 0040 (the predicate interface), ADR 0041 (fixtures, verdicts and the
one-code-path invariant — this ADR consumes its `mod_match_reviews` table).
Constrained by `CLAUDE.md` rule 2 (guild scope is a mandatory partition key),
rule 3 (every boundary gets a validator) and rule 8 (no autonomous write
actions).

## Context

Release 2's finish line, in both `REVIEW.md` §E and `docs/08`, is "an acceptable
false-positive rate before enforcement is even offerable". Until this slice that
sentence had **no numerator, no threshold, and no mechanism**. It was a habit.

Three specific things are missing, and they are missing together.

### F1 — nothing stops a rule going straight to `enforce`

`setRuleMode` (`packages/storage/src/repos/automod-rules.ts`) writes
`mod_rules.mode` with no guard beyond the column's CHECK, which permits
`'enforce'` unconditionally. Nothing records that a rule was ever observed, for
how long, or with what result. The documented rollout — ship in `test`, review,
flip to `observe`, review, then `enforce` — is entirely in prose.

`setRuleMode` currently has **no production caller at all**, which is why this
has not yet cost anything. It gains one the moment the dashboard ships (Slice 8),
and flip day is when an operator most wants to move ten rules at once.

### F2 — blast radius is an inference, not a property

Under ADR 0035 every hit deletes the message, and escalation is driven by the
per-member violation counter in `mod_cases`, which is **shared across rules**.
So strictly, any enforcing rule can contribute to a timeout, kick or ban, and
the spec's two-tier threshold would collapse into one tier.

ADR 0036 already introduced the distinction, but as a **call-site parameter**:
`openOrResolveCase(memberId, { countsAsViolation })`, which
`subscriber.ts` hard-codes to `true` on the enforce path and `false` elsewhere.
A rule cannot say "delete the message but do not push this member up the
ladder", so `caps` — the predicate the spec singles out as carrying the shape
tier's false-positive risk — has no way to ship at all: it must clear the
**zero**-false-positive bar meant for counter-feeding rules.

### F3 — testing an automod rule disables the role panels

`guilds.dry_run` is guild-wide (docs/18 Layer 4) and `killswitch` is an
emergency stop. Neither is automod-scoped, so an operator who wants to watch a
new automod rule without acting on it must turn off **every** side effect in the
guild, including reaction-role assignments that have nothing to do with
moderation. This is spec finding F4, and it makes the safe option expensive
enough that the unsafe one gets chosen.

## Decision

### 1. `mod_rules` records where a rule is in its cutover, not just its mode

Three additive columns:

- **`cutover_state`** — `not_started` | `observing` | `ready` | `cutover` |
  `rolled_back`. Distinct from `mode`, deliberately: `mode` is what the engine
  does *now*, `cutover_state` is where the rule is in its journey to being
  trusted. A rule can be in `observe` mode while `not_started` (nobody has
  begun the clock) and the two facts are different.
- **`observe_started_at`** — nullable epoch millis. **The clock, and the reason
  it is a column rather than derived:** `docs/08`'s two-week floor cannot be
  measured from `updated_at`, which any edit moves, and a rule whose observe
  data predates ADR 0039 is worthless (a carried-forward obligation from this
  run's kickoff — the rule was not firing). An explicit, resettable start is
  what lets a clock be restarted honestly.
- **`legacy_rule_ref`** — nullable text naming which Carl-bot, Dyno or native
  rule this replaces. Not decorative: `REVIEW.md` §A4's cutover is a *migration
  off* other bots, and "which of their rules is this?" is the question nobody
  will be able to answer from memory in two weeks.

### 2. `counts_as_violation` becomes a property of the rule

`mod_rules.counts_as_violation`, `NOT NULL DEFAULT 1`. The subscriber passes it
to `openOrResolveCase` instead of hard-coding `true` on the enforce path.

This is what makes the two tiers real rather than a distinction the code cannot
express, and it gives a high-false-positive-risk rule an escape hatch: `caps`
can ship delete-only and be held to the 5% bar rather than failing the zero bar.

**Default `true`, and the default is the safe direction here even though it is
the stricter one:** a rule that feeds the escalation counter is held to the
harsher gate, so a forgotten column makes enforcement *harder* to reach, never
easier. A default of `false` would let a rule quietly escape the bar it should
have been held to.

### 3. The gate is machine-checked at the one write path, and lives in storage

**`setRuleMode` refuses `mode = 'enforce'` unless the rule is eligible.** Not a
lint, not a `doctor` warning, not a convention — a returned refusal at the only
function that can set the column.

The eligibility computation lives in **`packages/storage`**, not `core`, and
this is a deliberate departure from where validation usually goes. The reasons:

- Everything it reads is already SQL — `cutover_state`, `counts_as_violation`,
  and the verdict tallies in `mod_match_reviews` (ADR 0041 §5). Computing it in
  `core` would mean exporting three new queries and a shape for `core` to
  reassemble, which is more surface for the same answer.
- **Placing it at the write path means every future caller inherits it.** The
  dashboard route in Slice 8, a CLI command, a migration script — none of them
  can forget, because none of them can reach the column another way. A check in
  `core` protects only the callers who remember to call it.
- It is a **data invariant**, not model-output validation, so rule 3's "Zod at
  every boundary" is not the relevant rule; rule 3 still governs the *inputs*
  (`cutover_state` is CHECK-constrained, the mode is CHECK-constrained).

`doctor` additionally reports rules already in `enforce` whose state does not
permit it — for rows that predate this slice, or were hand-edited — and rules
in `observe` past their window with an unreviewed backlog. **`doctor` reports;
`setRuleMode` refuses.** Those are different jobs and both are needed.

### 4. The false-positive gate, tiered by blast radius

| The rule's maximum blast radius | Threshold |
| --- | --- |
| Deletes the message only (`counts_as_violation = 0`) | at most **5%** of reviewed matches are false positives |
| Feeds the escalation counter (`counts_as_violation = 1`) | **zero** false positives among reviewed matches |

Four rules, each of which exists because its absence is exploitable:

1. **`unclear` counts as a false positive.** It biases conservative, and it
   gives the reviewer a reason to resolve a verdict rather than leave it
   parked — a queue of `unclear` must not be a way to pass.
2. **Minimum 20 reviewed matches** before a rate means anything. One reviewed
   match at 0% is not a 0% rate.
3. **The low-volume path.** A precise-tier rule may fire zero times in two
   weeks, and 0 of 0 is *no score*, not a passing one. A rule that has not
   reached 20 reviewed matches is gated instead on a clean pass against the
   Slice 2 fixture corpus **plus an explicit owner sign-off recorded on the
   rule** (`enforce_signed_off_by`, `enforce_signed_off_at`). This is what
   `docs/08`'s "may graduate sooner if its false-positive review is clean early"
   means operationally.
4. **The thresholds live on the rule**, beside `cutover_state`, so the refusal
   can read them without a second source of truth. Starting points, not
   measurements — and if a rule fails its bar, **narrow the rule, do not move
   the bar.**

### 5. `guilds.automod_testing_mode` is a third lever

`NOT NULL DEFAULT 0`. When set, automod takes no Discord action while every
other subsystem — role panels above all — keeps working. Distinct from
`killswitch` (emergency, everything) and `dry_run` (guild-wide, everything).

Three levers rather than two because they answer three different questions:
*is something on fire* (killswitch), *is this guild live at all* (dry_run), and
*am I still evaluating this automod rule* (testing mode). Collapsing the third
into the second is what makes the safe choice expensive, which is F3.

## Consequences

- **Enforcement becomes unreachable by accident.** The only path to
  `mode = 'enforce'` runs through a check that reads real reviewed verdicts. A
  rule cannot be enforced because someone was confident.
- **Four additive columns on `mod_rules` and one on `guilds`.** All
  `ALTER TABLE … ADD COLUMN`; **no table rebuild**, which matters because
  ruling R-5 records a reproduced data-loss bug in the rebuild path and
  `mod_rules` owns cascading children.
- **`caps` becomes shippable**, and any future high-risk predicate with it, via
  `counts_as_violation = 0`.
- **A rule that legitimately fires rarely can still be enforced**, through the
  low-volume path — at the cost of an explicit sign-off that is recorded rather
  than remembered.
- **The tests come first.** The spec (§4) names them and requires them written
  *before* the feature, because they are the mechanism the release gate rests
  on: enforce refused for a state that does not permit it; a counter-feeding
  rule with one `false_positive` **or** one `unclear` refused; a delete-only
  rule refused at 6% and allowed at 4%; and a rule with 19 reviewed matches
  falling to the low-volume path rather than passing on a flattering ratio.
- **`setRuleMode`'s signature changes** from returning `void` to returning a
  result, so every caller must handle a refusal. It currently has no production
  caller, which is the cheapest moment this change will ever have.

## Alternatives rejected

**A CHECK constraint instead of a function.** SQLite cannot express "at most 5%
of this rule's reviewed matches in another table are false positives" in a
CHECK. The state machine's transitions could be partly constrained that way, but
splitting the gate across a CHECK and a function would mean two places to read
and one of them incomplete.

**Deriving blast radius from `mode` or from `kind`.** This is what ADR 0036 does
today and it is why the tiers collapse: every enforcing rule can reach the shared
counter, so the inference always says "counter-feeding". A per-rule property is
the only thing that can distinguish them.

**Computing eligibility in `core` and having storage call it.** Rejected on
ADR 0014's direction — storage may not import core — and on the stronger
practical ground in §3: a check at the write path cannot be forgotten, and a
check a caller must remember to make will eventually be forgotten by the
dashboard.

**Letting `doctor` be the whole mechanism.** `doctor` is run by a human who
chooses to run it. `REVIEW.md` §E asks for enforcement not to be *offerable*,
which is a property of the write path, not of a report.

**Deferring `automod_testing_mode` to Release 3.** It is three lines of schema
and it removes the reason an operator would reach for `dry_run` and disable the
role panels during flip week — which is precisely the week they will be testing
most.
