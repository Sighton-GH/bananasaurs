# Brief — Slice 6, Tasks 2 + 3: the enforcement gate

**Read first, in this order, and do not skip any of them:**

1. `docs/reports/briefs/SANDBOX_RULES.md` — the command shapes this
   environment refuses, and why. Violating it wastes a dispatch.
2. `docs/superpowers/plans/2026-09-04-slice-6-release-gate.md`, the section
   headed **"Task 2 + Task 3: the gate"**. That section is your specification.
   Its Global Constraints apply to you too.
3. `docs/decisions/0042-cutover-state-and-the-tiered-false-positive-gate-decide-when-enforcement-is-offerable.md`
   — the whole ADR, including **Amendment 1**.
4. `CLAUDE.md`, rules 2 (guild scope) and 6 (idempotency).

**One dispatch, one commit** (plan ruling PR-26). Tests first, and your report
must paste the actual failure output — that is the only evidence they came
first.

## What already exists (Task 1 shipped in `caf4732`)

Do not add columns; they are there. `StoredAutomodRule` already carries:

```ts
readonly cutoverState: CutoverState;   // 'not_started'|'observing'|'ready'|'cutover'|'rolled_back'
readonly observeStartedAt: number | null;
readonly legacyRuleRef: string | null;
readonly countsAsViolation: boolean;   // INTEGER 0/1 in SQLite
readonly maxFalsePositiveRate: number; // REAL, default 0.05
readonly minReviewedMatches: number;   // INTEGER, default 20
readonly enforceSignedOffBy: string | null;
readonly enforceSignedOffAt: number | null;
```

`CutoverState` is exported from `packages/storage/src/repos/automod-rules.ts`.
Import it; do not redeclare the union.

The join you need (plan ruling PR-28), verified against the live schema:
`mod_match_reviews`'s primary key **and** its foreign key are both exactly
`(guild_id, event_id)` onto `mod_case_events(guild_id, event_id)`, and
`mod_case_events.rule_id` is a plain column on the same row. So the tally is
`mod_match_reviews` joined to `mod_case_events` on `(guild_id, event_id)`,
filtered to this `rule_id`. `mod_match_reviews.verdict` is CHECK-constrained to
`('false_positive','true_positive','unclear')`.

`setRuleMode`'s current body, which you are changing:

```ts
export const setRuleMode = (scope: GuildScope, input: SetRuleModeInput): void =>
  write(scope, ({ db }) => {
    db.update(modRules)
      .set({
        mode: input.mode,
        enabled: input.enabled === undefined ? undefined : input.enabled ? 1 : 0,
        updatedAt: input.now,
      })
      .where(scope.only(modRules, eq(modRules.ruleId, input.ruleId)))
      .run();
  });
```

## Ruling PR-31 — decided by the coordinator, not open for you to revisit

`setRuleMode` has no production caller, exactly as ADR 0042 says. It does have
**test** callers that pass `mode: 'enforce'`, and once you gate it they will
break, because `cutover_state` defaults to `not_started`:

- `apps/daemon/src/automod.integration.test.ts:104` (a `setMode` helper) and
  `:286`
- `apps/daemon/src/native-automod.integration.test.ts:97`
- several in `packages/storage/src/repos/automod-rules.test.ts`

Those tests assert real deletions and real case events. If the gate silently
refuses, the rule stays in `test` mode and the assertions fail — and a future
reader would see a broken subscriber where the real cause is an ungranted
sign-off. That is ADR 0039's failure shape.

**The ruling:** those call sites reach enforce mode **through the gate**, not
around it. Add one named helper — put it in
`packages/storage/src/repos/enforcement-gate.ts` and export it, name it
`makeRuleEnforceableForTest` — that writes `cutover_state = 'ready'` and an
`enforce_signed_off_by` / `_at` pair, then let the test call the real
`setRuleMode`. Document on the helper that Task 6's `automod ready` and
`automod signoff` are the production paths and this exists only so a test
about the subscriber does not have to build a 20-match review corpus.

**Rejected alternatives, so you do not re-propose them:** a second write path
to `mode` that skips the gate (re-opens the hole PR-29 exists to close, and
leaves the gate with no exerciser outside its own unit test); making each
integration test seed a real review corpus (couples every automod integration
test to Slice 6's evidence rules, so a later change to the gate breaks tests
that are not about it).

Report **how many call sites you touched.** The plan's file list is a lower
bound.

## What to build

Exactly the interfaces in the plan's Task 2+3 "Interfaces" block. Copy the
signatures verbatim; later tasks are written against them.

Check order is part of the contract and the plan gives it: state first, then
the low-volume path, then the false-positive count, then the rate. A rule in
`observing` with a terrible rate is refused for its **state**, because that is
the fact the operator has to act on first. Say that in a comment.

`setRuleMode` advances `ready → cutover` on a successful enforce, in the same
`write`. A gate that permits enforcement without recording that it happened
leaves `doctor` unable to tell an enforced rule from a merely eligible one.

## Boundaries — both directions, every threshold

Global Constraint 7. The plan's own first draft applied this to one threshold
out of two and the review caught it. There are **two** thresholds and each
needs both sides:

- `max_false_positive_rate`: the spec says "at most 5%", so **exactly 5% is
  allowed** and just above is refused. The 4%/6% pair does not pin this — an
  implementation using `>=` passes both halves of it.
- `min_reviewed_matches`: 20 is the minimum and the rule is "minimum 20
  reviewed matches", so **exactly 20 is enough** and 19 falls to the
  low-volume path. An implementation using `<=` passes the 19 test and refuses
  a rule sitting exactly on its bar.

## Step 5 is not optional: watch four guards fail

Make each mutation, run the suite, record which test went red **and confirm it
was the right one**, then restore. A guard nobody has watched fail is the
decorative shape this project has found sixteen of.

1. Reverse the check order so state is checked last → the `observing`-plus-bad-
   rate test must report the **wrong reason**, not merely fail.
2. Drop `unclear` from the false-positive count → the `unclear` test goes red
   and the `false_positive` test stays green.
3. `>` → `>=` on the rate comparison → the **exactly-5%** test goes red.
4. `<` → `<=` on the reviewed-count comparison → the **exactly-20** test goes
   red and the 19 test stays green.

If a mutation does **not** turn a test red, stop and report it. That is a
missing test, and it is worth more than finishing the task.

## Gates

Run each alone and read its own **exit code**. Never pipe a gate through
`tail`, `head`, or `grep` and then report on the pipeline's status — ruling
E-5 is a coordinator reporting lint green while it had been red for two
commits, for exactly that reason.

```
npm run typecheck
npm run lint
npm run test
```

Baseline on a clean tree at `caf4732`: **2322 tests across 113 files**, all
three gates exit 0.

## Your report — five lines, plus the two required blocks

1. What you built, in one line.
2. The Step 2 failure output, pasted (not summarised).
3. The four Step 5 mutations: for each, which test went red.
4. Call sites touched, counted.
5. The three gate exit codes and the final test count.

Anything you decided that the plan did not specify, say so explicitly and say
why. Anything you could not do, say that instead of working around it.
