# Brief — re-review of Slice 6's fix wave

You are reviewing a **fix wave**, not the whole slice. Change no code.

## Context

The whole-branch review of Slice 6 returned SHIP-WITH-FIXES: two CRITICALs, five
IMPORTANTs, two MINORs. Its full text is
`docs/reports/slice-6-whole-branch-review.md` — read it first, it is the
specification for what these fixes were supposed to achieve.

The fix wave is commit `385859e`, diff at
`docs/reports/slice-6-fixwave-diff.patch`.

Gates on the current tree: typecheck 0, lint 0, **2385 tests / 114 files**.

## What was fixed, and what to check about each

1. **CRITICAL-2, delete-only escalation.** A `countsAsViolation: false` rule now
   records `deleted` and returns before `nextEscalationTier` is consulted at all.
   Check: does it still delete? Does it still record a case event? Is there any
   *other* path in the subscriber by which such a rule can reach
   `moderationGateway.applyAction`? Is the early return placed such that a
   `delete_failed` outcome is still recorded correctly?

2. **CRITICAL-1, vacuous sign-off.** `automod signoff` now also requires at least
   one fixture with `agreement === 'agreed'`. Check: is `agreed` the right
   quantity, or can a corpus be gamed into producing one agreement without real
   evidence? Does the new refusal precede or follow the `!clean` refusal, and is
   that order right — i.e. does a corpus that is both unlabelled *and* dirty
   report the more useful reason? Is the audit row still written?

3. **IMPORTANT, rollback withdraws the sign-off.** `setRuleMode` now nulls
   `enforce_signed_off_by`/`_at` on `cutover → rolled_back`. Check: is there any
   transition that should clear it and does not? Can a sign-off survive a route
   back to enforcement by some path the new test does not cover? Note the write
   uses `undefined` to mean "leave alone" and `null` to mean "clear" — verify
   drizzle actually distinguishes those two in an `.set()`, against the copy in
   `node_modules`, not from memory. **If drizzle treats `undefined` as "write
   NULL" here, this fix silently clears sign-offs on every unrelated mode change,
   which would be worse than the bug it fixes.**

4. **IMPORTANT, `makeRuleEnforceableForTest` moved** to
   `packages/storage/src/test-support.ts`. Check: is it genuinely unreachable
   from production now? Does `@bananasaurs/storage/test-support` ship in the
   built package in a way production code could still import? Did every call
   site move correctly?

5. **IMPORTANT, `toAutomodRule`.** The subscriber's rule is now narrowed
   explicitly in `apps/daemon/src/automod/wiring.ts`. Check: does the mapping
   name every field `AutomodRule` declares — a *missing* field is now a silent
   behaviour change rather than a compile error only if the field is optional, so
   check each one. Does anything else in the daemon still pass a
   `StoredAutomodRule` where an `AutomodRule` is expected?

## Deliberately not fixed

Nothing in Release 2 writes `cutover_state = 'observing'` or
`automod_testing_mode`: `setRuleMode` has no production caller and no
`automod mode` command exists. Adding one is out of scope (CLAUDE.md rule 8) and
is going to the owner in the handoff. **Do not report this again** — but do say
if you think the slice cannot honestly ship without it.

The two MINORs (no `doctor` check on hand-edited thresholds; no two-guild gate
test) were also left. Say if you disagree.

## What good output looks like

Findings ranked CRITICAL / IMPORTANT / MINOR, each with file, line, what breaks,
and a concrete reproducible failure scenario. Then a verdict: **SHIP** or
**SHIP-WITH-FIXES**.

Two disciplines the earlier review was held to and so are you:

- **Do not pad.** This is a 676-line diff fixing named defects. If the fixes are
  correct, the right answer is a short list or none, and saying so plainly is
  more useful than manufacturing severity.
- **Verify each premise before reporting it.** Library behaviour goes against
  `node_modules`; test behaviour goes against the test. Point 3 above is the one
  where this matters most. Say which findings you verified and how.

You may run the gates and write throwaway probe tests, but revert anything you
write and commit nothing.
