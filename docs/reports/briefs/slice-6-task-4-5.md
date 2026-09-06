# Brief — Slice 6, Tasks 4 + 5: the subscriber reads the rule, and the third lever

**Read first, in this order:**

1. `docs/reports/briefs/SANDBOX_RULES.md` — the command shapes this environment
   refuses. Violating it costs the dispatch.
2. `docs/superpowers/plans/2026-09-04-slice-6-release-gate.md`, **Task 4** and
   **Task 5**. Its Global Constraints apply to you.
3. `docs/decisions/0042-cutover-state-and-the-tiered-false-positive-gate-decide-when-enforcement-is-offerable.md`
   §5 (the third lever).
4. `CLAUDE.md` — rule 1 (AI never in the enforcement path), rule 2 (guild
   scope). Both are live here.

**One dispatch, two commits** — one per task, because they are independent and a
reviewer should be able to reject one and keep the other. Tests first in both.

## Already shipped, do not redo

Task 1 (`caf4732`) added the columns. Tasks 2+3 (`efc610d`, `7112c6a`) added
`packages/storage/src/repos/enforcement-gate.ts` and gated `setRuleMode`.
`StoredAutomodRule` already carries `countsAsViolation: boolean`, and
`GuildRow` already carries `automodTestingMode: number`. Neither is read by
anything yet — that is your job.

Baseline on a clean tree at `7112c6a`: **2340 tests across 114 files**, all
three gates exit 0.

---

## Task 4 — `counts_as_violation` reaches the subscriber

`packages/core/src/automod/subscriber.ts:448` hard-codes
`countsAsViolation: true` on the enforce path. Lift it to the rule.

Core's rule shape is `AutomodRule` in
`packages/core/src/automod/predicates/types.ts:44`, and it has eight fields
today, none of them this one. Add `readonly countsAsViolation: boolean` and map
it in `apps/daemon/src/automod/wiring.ts` from the `StoredAutomodRule` the
repository already returns.

**Do not add `countsAsViolation` to `EXCLUDED_FIELDS` in
`packages/core/src/automod/fingerprint.ts`.** That set is `{ruleId, mode}` and
the file's own header says why: the fingerprint iterates the rule's own keys so
a field added later is hashed **by default**, and omitting one is the
deliberate act. A flag an operator flips once, causing one spurious matcher
recompile, is free; a missed recompile is a bug. If a test pins the hashed key
set, update it deliberately and say in the comment that the field is hashed
because the safe default is to hash.

- **Step 1: the failing test.** A rule with `countsAsViolation: false` that
  matches in `enforce` mode **still deletes the message and still records a case
  event**, but calls `openOrResolveCase` with `countsAsViolation: false`.
  Assert the deletion *and* the flag — an implementation that skipped the action
  entirely must also go red. `subscriber.test.ts` already records
  `calls.openOrResolveCase` as `{memberId, countsAsViolation}[]`, so the
  assertion shape exists.
- **Step 2: run it, watch it fail.** Paste the output.
- **Step 3: implement. Step 4: watch it fail by hard-coding `true` again**, and
  confirm the test that goes red is the one you just wrote.
- **Step 5: gates by exit code, then commit.**

---

## Task 5 — `automod_testing_mode`, the third lever

When set, automod takes **no Discord action** and records the match as it would
in `test` mode. **Every other subsystem is unaffected** — that is the entire
point (spec F3), and it is what makes this different from `dry_run`.

### Ruling PR-33 — decided by the coordinator, not open for you to revisit

The plan's Task 5 says "`readSafetyState` returns
`{killswitch, breakerOpen, dryRun}`. Add `automodTestingMode`." Taken
literally that is wrong, and here is the fact the plan missed:

- `packages/storage/src/repos/guilds.ts:98` defines storage's own
  `SafetyState`, seven fields.
- `packages/core/src/effects/moderation-gateway.ts:74` defines
  `ModerationSafetyState`, **exactly three** — `killswitch`, `breakerOpen`,
  `dryRun`.
- Storage's is structurally assignable to core's. The automod subscriber's port
  declares `readSafetyState(): ModerationSafetyState | undefined`, and so does
  `ModerationGatewayDeps.state.read()`. **`purge.ts:575` passes that same state
  to `classifyRefusal`.**

So adding the field to `ModerationSafetyState` hands it to the moderation path,
which must never be gated by it. A comment saying "only automod reads this" is
caller discipline, and CLAUDE.md rule 2's whole stance is that a constraint
belongs in the signature.

**The ruling:**
- Add `automodTestingMode: boolean` to **storage's** `SafetyState` and set it
  from `row.automodTestingMode === 1` in `readSafetyState`. One query, no second
  read per message.
- **Leave `ModerationSafetyState` at its three fields.**
- Give the automod subscriber's port its own return type carrying the extra
  field — an interface in `packages/core/src/automod/` extending
  `ModerationSafetyState` with `readonly automodTestingMode: boolean`. Name it
  for what it is.

Then the moderation gateway and `purge.ts` cannot read the flag because their
type does not declare it. That is the plan's stated guard, made structural
instead of grep-shaped.

- **Step 1: the failing tests.** Two, and the second is the one that matters:
  - (a) with `automodTestingMode` set, a matching rule in `enforce` does **not**
    delete and does **not** count a violation — and *does* still record the
    match, exactly as `test` mode would. Assert the recording too, or the test
    passes against an implementation that simply drops the message.
  - (b) the guard against reimplementing `dry_run` by another name: **a
    role-panel assignment still works** with `automodTestingMode` set. If the
    role-panel path is genuinely unreachable from the harness, say so, and
    substitute a typed guard: a test asserting `ModerationSafetyState` has
    exactly its three fields, so a later widening of it fails the build. State
    which of the two you did and why.
- **Step 2: run, watch fail. Step 3: implement. Step 4: watch it fail** — remove
  the check and confirm (a) goes red.
- **Step 5: gates by exit code, then commit.**

---

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

Per task: what you built, the Step 2 failure output **pasted**, which test the
Step 4 mutation turned red, and the files you touched. Then the three gate exit
codes and the final test count, once, at the end.

For Task 5 also state explicitly which form of guard (b) took.

Anything you decided that these instructions did not settle, say so and say
why. Anything you could not do, say that rather than working around it.
