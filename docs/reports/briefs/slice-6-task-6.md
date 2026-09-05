# Brief — Slice 6, Task 6: `doctor`'s two checks, and the CLI surface

**Read first, in this order:**

1. `docs/reports/briefs/SANDBOX_RULES.md` — the command shapes this environment
   refuses. Violating it costs the dispatch.
2. `docs/superpowers/plans/2026-09-04-slice-6-release-gate.md` — **Task 6**, and
   **PR-27's transition table** at lines 92-120. Read the table, not only Task 6:
   the previous dispatch was briefed off the "Interfaces" block alone and shipped
   one of four transitions as a result.
3. `docs/decisions/0042-...-enforcement-is-offerable.md` §3 (`doctor` reports,
   `setRuleMode` refuses) and §4.
4. `CLAUDE.md` rules 1, 2, 8 and 9. Rule 9 especially: nothing here may spawn
   `claude` or reach a provider.

**This is the last task before the whole-branch review. Four deliverables, two
commits** — `doctor`'s checks in one, the two commands in the other.

## Already shipped, do not redo

- Task 1 (`caf4732`): the nine columns. `StoredAutomodRule` carries
  `cutoverState`, `observeStartedAt`, `enforceSignedOffBy`/`_at`,
  `minReviewedMatches`, `maxFalsePositiveRate`, `countsAsViolation`.
- Tasks 2+3 (`efc610d`, `7112c6a`): `packages/storage/src/repos/enforcement-gate.ts`
  (`enforcementEligibility`, `EnforcementRefusal`, `makeRuleEnforceableForTest`),
  and `setRuleMode` gating `enforce` **and owning four of PR-27's five arrows**.
  `not_started → observing` already happens on `setRuleMode(mode: 'observe')`,
  which stamps `observe_started_at`; `rolled_back → observing` resets it;
  `cutover → rolled_back` fires on any non-`enforce` mode. **So `observing` is
  reachable now** — that is what makes `automod ready`'s precondition workable.
- Tasks 4+5 (`0fa32f0`, `5d240f8`, `51bd8ad`): `countsAsViolation` on the
  subscriber, and `automod_testing_mode`.

Baseline on a clean tree at `51bd8ad`: **2345 tests across 114 files**, all
three gates exit 0.

## Patterns to follow, with the exact code already in the repo

- **`doctor`'s shape:** `packages/core/src/ops/commands/reads.ts:37`. Each check
  is a `ctx.ports.listX()` returning an array, then one `lines.push(...)` with a
  clean-case string and a count-plus-detail string. Follow it exactly, including
  the two-space column alignment. Add two ports, name them like
  `listUnusableAutomodRules` and `listKeywordFilterRulesMissingManageMessages`
  already there.
- **A refusal that is a usage answer, not a throw:**
  `packages/core/src/ops/commands/automod.ts:557` (`automod verdict`,
  `outcome === 'no-such-event'`). It returns `text` + `data: { ok: false, reason,
  ... }` **and still writes an audit row**, because "an operator tried to do X
  and was refused" is a fact worth having. Both new commands do the same.
- **Running a dry run from a command:** `automod dryrun` at
  `packages/core/src/ops/commands/automod.ts:198` — `ctx.ports.findAutomodRule`,
  `ctx.ports.listAutomodFixtures`, then `runDryRun({ guildId, rule, fixtures })`.
  `signoff` reuses this; do not write a second corpus path.

## The two `doctor` checks

1. **Rules in `mode = 'enforce'` whose `cutover_state` does not permit it** —
   i.e. not in `('ready','cutover')`. These are rows that predate this slice or
   were hand-edited; `setRuleMode` can no longer create one. Report the rule id
   and the offending state.
2. **Rules in `mode = 'observe'` past their window with an unreviewed backlog.**
   The floor is **two weeks** (`docs/08`, cited in ADR 0042's own justification
   for `observe_started_at` being a column rather than derived). There is no
   existing constant for it in automod — `BULK_DELETE_CEILING_MS` in
   `packages/core/src/mod/purge.ts:188` is `14 * 24 * 60 * 60 * 1000` but is
   about Discord's bulk-delete limit and means something entirely different, so
   **do not import it**; declare your own named constant next to this check with
   a comment saying it is `docs/08`'s floor. A rule with
   `observe_started_at` null has not started its window and is **not** overdue —
   assert that, or every fresh rule is reported forever.
   "Unreviewed backlog" is `mod_case_events` rows for the rule with no
   `mod_match_reviews` row — a LEFT JOIN, guild-scoped on both sides, the same
   join `enforcementEligibility` already uses (PR-28).

## The two commands

### `automod ready <ruleId>`
Sets `cutover_state = 'ready'`. Write plus audit. **It must refuse unless the
rule is currently `observing`**, and the refusal names the actual state.

**The test that matters is `rolled_back` → refused**, and write it first: without
this precondition a rollback can be undone by `ready` then `enforce` without ever
revisiting `observing`, which is the scenario ADR 0042 exists to prevent. Also
cover `not_started` (the operator has not started a window) and `cutover`
(already enforcing). **Watch each refusal fail** against a version with no
precondition.

### `automod signoff <ruleId>`
Records `enforce_signed_off_by` (`cli:<unix user>`, the shape `automod verdict`
already uses at line 568) and `enforce_signed_off_at`. **Per PR-29 it refuses
unless a dry run over the corpus is clean:** `report.usable === true`,
`report.threw === 0`, `report.falsePositives === 0`. Those three field names are
verified against `packages/core/src/automod/dry-run.ts` — `usable` at :57,
`threw` at :65, `falsePositives` at :79.

Write the refusal test for **each of the three conditions separately**. One test
covering "not clean" passes against an implementation checking only one of them.

**Why this command carries the check and the gate does not:** storage may not
import core (ADR 0014), so `enforcementEligibility` cannot run a dry run. This
is the only layer that sees both the rule and the corpus. Say so in a comment —
otherwise the split looks arbitrary and someone will "simplify" it.

## A trap specific to this task

`makeRuleEnforceableForTest` exists (Tasks 2+3) and writes `cutover_state =
'ready'` plus a sign-off with **no preconditions**, for tests about the
subscriber. **Do not use it in Task 6's tests, and do not extend it.** The
commands you are writing are the production writers for exactly those two
facts, and a test that reaches the end state through the shortcut proves
nothing about the command's precondition. Set up state with raw SQL (the
pattern `enforcement-gate.test.ts` uses via its `setCutoverState` helper) or by
driving the real `setRuleMode`.

## Gates

Run each alone, read its **own** exit code. Never pipe a gate through
`tail`/`head`/`grep` and report on the pipeline's status — ruling E-5 is a
coordinator reporting lint green while it had been red for two commits, for
exactly that reason.

```
npm run typecheck
npm run lint
npm run test
```

## Your report

Per commit: what you built, the failing-test output **pasted**, and for each
guard you watched fail, which test went red and that the others stayed green.
Then the three gate exit codes and the final test count, once.

State explicitly: the constant you chose for the two-week floor and where you
put it; whether `observe_started_at` null is treated as not-overdue and which
test proves it; and that you did not use `makeRuleEnforceableForTest`.

Anything you decided that this brief did not settle, say so and say why.
Anything you could not do, say that rather than working around it.
