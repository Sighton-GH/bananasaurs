# Brief — whole-branch review of Slice 6, the release gate

You are reviewing, not implementing. **Change no code.** Produce findings.

This review is deliberately **not run lean**. Slice 6 decides when a bot is
allowed to start deleting real people's messages in a real Discord guild, so it
gets the most careful pass of the release.

## What to read

1. `docs/reports/briefs/SANDBOX_RULES.md` — the command shapes this environment
   refuses. Violating it wastes the dispatch.
2. `docs/reports/slice-6-review-diff.patch` — the whole slice's code diff
   (`e500751..HEAD`, generated migration snapshots excluded as noise). Read the
   files in the tree too where the diff lacks context.
3. `docs/superpowers/plans/2026-09-04-slice-6-release-gate.md` — the plan,
   **including PR-27's transition table at lines 92-120**, which two dispatches
   have now under-read.
4. `docs/decisions/0042-...-enforcement-is-offerable.md`, all of it, Amendment 1
   included.
5. `docs/reports/release2-slices-1-6-ledger.md`, the section "Slice 6 rulings" —
   PR-26 through PR-35, and the narrative findings after the table.
6. `CLAUDE.md`. Rules 1, 2, 3, 6, 8 and 9 are all live in this slice.

## What shipped

Six deliverables, in `e500751..HEAD`:

- **Task 1** — nine additive columns (`mod_rules` ×8, `guilds` ×1) across
  migrations 0015/0016/0017, 0017 being a rebuild of two tables; a
  rebuild-survival test plus a negative control.
- **Tasks 2+3** — `packages/storage/src/repos/enforcement-gate.ts`
  (`enforcementEligibility`, four ordered checks) and `setRuleMode` gating
  `enforce` and owning four of PR-27's five transitions.
- **Task 4** — `countsAsViolation` reaching the subscriber.
- **Task 5** — `automod_testing_mode`, kept off `ModerationSafetyState`.
- **Task 6** — `doctor`'s two checks, `automod ready`, `automod signoff`.

Gates on the current tree: typecheck 0, lint 0, **2380 tests across 114 files**.

## Fixes already applied — do not re-report these as new

Report them only if a fix is *wrong* or *incomplete*:

- The sign-off no longer short-circuits the gate; it clears the low-volume floor
  only, falling through to the zero bar and the rate.
- `reviewed === 0` returns explicitly at the rate check rather than relying on
  `NaN` comparisons.
- `setRuleMode` gained `not_started → observing`, `cutover → rolled_back`,
  `rolled_back → observing`, with the clock stamped only on the first and third.
- The order between `automod_testing_mode` and the `delete_blocked_*` block is
  pinned by test (PR-34).
- `doctor`'s observe-window check filters `enabled = 1`; the sibling
  enforce-state check deliberately does not (PR-35).

## What to look for, in priority order

**1. Can a rule reach `mode = 'enforce'` without having earned it?** This is the
slice's whole purpose. Trace every write path to `mode`, every write path to
`cutover_state`, and every write path to `enforce_signed_off_by`. Include
`makeRuleEnforceableForTest` in that trace: it is exported from production code
and writes both eligibility facts with no precondition. Is anything but a test
able to reach it? Could a future caller?

**2. Can a rollback be undone by retrying?** PR-27 exists for this, and the
property has already been false twice in this slice's history — once in the
plan, once in a brief. Check it end to end now that all five states have writers.

**3. Guild scope (CLAUDE.md rule 2).** Every new query, especially the joins in
`enforcementEligibility` and both `doctor` checks. A query that *can* omit guild
scope is a bug even if every current caller passes it.

**4. Decorative guards.** This project has found seventeen. A test whose fixture
cannot reach the branch it is named after; an assertion that holds under the bug
it claims to catch. The negative control in `schema-invariants.test.ts` and the
`disable-not-rollback` fence are the two most likely candidates — check whether
each can actually go red, and say which mutation you would use.

**5. ADR 0039's shape** — a rule that looks configured and silently does not
fire, or a number that reads as reassuring when it is not. This slice has hit it
five times. Look hardest at: the rate arithmetic and its denominator; what
`doctor` reports and what it stays silent about; the interaction of
`automod_testing_mode` with the other levers; and `observe_started_at` semantics
across the transitions.

**6. Boundaries in both directions.** `max_false_positive_rate` at exactly 5%,
`min_reviewed_matches` at exactly 20, the observe floor at exactly two weeks, and
the CHECK constraints at 0 and 1. For each, is *both* sides pinned, or only the
obviously-invalid one?

**7. The three-migration split.** 0017 rebuilds `guilds` and `mod_rules` and
carries a mid-file `PRAGMA foreign_keys=ON`. Satisfy yourself that the survival
proof proves what it claims and that the negative control fails for the reason
stated, not incidentally.

## What good output looks like

Findings ranked **CRITICAL / IMPORTANT / MINOR**, each with: the file and line,
what breaks, and a **concrete failure scenario** — inputs or state that produce
the wrong outcome. A finding I cannot reproduce from your description is a
finding I cannot act on.

End with a verdict: **SHIP**, **SHIP-WITH-FIXES**, or **DO-NOT-SHIP**.

Two things to be strict with yourself about:

- **Do not pad.** A short list of real defects beats a long list including
  stylistic preferences. If you find nothing critical, say so plainly — a
  reviewer inventing severity to look useful is worse than one reporting clean.
- **Check your premise before reporting.** A previous review on this project
  reported a finding whose premise was false, and it cost a round trip. If a
  claim depends on how a library behaves, verify it against `node_modules`
  rather than from memory; if it depends on what a test does, read the test.
  Say which findings you verified and how.

You may run `npm run test`, `npm run typecheck` and `npm run lint`, and you may
write throwaway probe tests to check a hypothesis — but revert anything you
write, and do not commit.
