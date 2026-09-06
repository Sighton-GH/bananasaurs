# Release 2, Slice 6 — the release gate (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "an acceptable false-positive rate before enforcement is even
offerable" from a sentence in `REVIEW.md` into a refusal the code performs.

**Architecture:** **Eight** additive columns on `mod_rules` and **one** on
`guilds` — nine `ADD COLUMN` statements — plus one eligibility function in
`packages/storage` that `setRuleMode` consults before it will write
`mode = 'enforce'`. `doctor` reports what already slipped through;
`setRuleMode` refuses what has not happened yet.

**Tech Stack:** TypeScript (Node 22, strict) · Zod 3.25.76 · Drizzle 0.45.2 ·
better-sqlite3 13 · Vitest 2. **No new dependency.**

**ADR:** `docs/decisions/0042-cutover-state-and-the-tiered-false-positive-gate-decide-when-enforcement-is-offerable.md`
— **read it first.** It carries the reasoning; this plan carries the steps.

**Spec:** `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`
§3 Phase 3 (Slice 6) and §4's Slice 6 gates.

**Handoff:** `docs/reports/release2-slice-6-handoff.md`.

**⚠ This slice is not run lean.** The spec says so, and says why: its tests are
the mechanism the release gate rests on. Per-task review, a whole-branch review
on the strongest model, a fix wave, and a re-review — all of it.

---

## Global Constraints

1. **Read `docs/reports/briefs/SANDBOX_RULES.md`.** Binding, and it will save
   you turns. Never read or ask for `.env`. Always give `rg` an explicit path and
   **never pipe into `rg`**. Check gates by exit code, never through `tail`.
   Undo a break-it experiment with `git restore <path>`, not a `cp` round-trip.
2. **Guild scope is a mandatory partition key** (CLAUDE.md rule 2). Every new
   query takes a `GuildScope` first and goes through `scope.only(...)`.
3. **Nine new columns — eight on `mod_rules`, one on `guilds`** (Task 1's table
   is the authority). **drizzle-kit will rebuild `mod_rules` to add the
   CHECK-constrained ones, and that is expected and safe** — see ADR 0042's
   **Amendment 1**. An earlier version of this plan forbade a rebuild, citing
   ruling R-5; that was wrong, because **R-5 is a hazard *and* its fix, and the
   fix shipped in Slice 1.** `runMigrations` disables `foreign_keys` at the
   *connection* level for the run and brackets it with `PRAGMA
   foreign_key_check`, so the cascade R-5 reproduced cannot fire — and
   `schema-invariants.test.ts` already proves that against `mod_rules` and all
   four of its cascading children, using the real shipped rebuild migrations.
   **What you owe instead of avoiding the rebuild is the same proof for this
   slice's own migration** — Task 1, Step 4b. Do not assume a test written
   earlier covers a migration written later.
4. **`npm run db:generate` is the only way to produce a migration.** Never
   hand-write one.
5. **Pino redaction is an allowlist** (rule 4). A new logged field name needs a
   `LOGGABLE_FIELDS` entry with a comment.
6. **Break it and watch it fail.** **Sixteen** decorative guards have been found
   here. Watch every guard go red before making it pass, and say which line you
   neutralised.
7. **Verify both directions of a boundary.** Slice 4's CRITICAL-2 was a default
   checked for short input and never for absent input. A measurement that
   confirms what you expected is half a measurement. **This slice is full of
   thresholds, so this constraint is the one most likely to catch you.**
8. **A human-facing guard is not a machine-facing guard.** Slice 4 protected a
   CLI summary while the same wrong number survived in `data`, which this slice's
   gate reads as a machine.
9. **Comments are load-bearing claims.** Slice 4's worst defect survived because
   a comment asserted a false analogy as settled. If you change behaviour, change
   the comment.
10. **This plan will contain defects.** Every previous slice's did — eight, five,
    four. When a test and this plan's code disagree, **say so plainly** rather
    than reconciling them quietly.
11. Gates: `npm run typecheck`, `npm run lint`, `npm run test`, each checked by
    exit code. Baseline **2312 tests / 113 files**.

---

## Plan rulings

Numbering continues from PR-25.

**PR-26 — "tests written before the feature" is an authoring-order requirement,
satisfied within a single dispatch, because every commit must leave the gates
green.** The spec requires the gate's tests written first. Landing them as a
failing commit would leave `main` red, which no other slice has done and which
would make `git bisect` useless across this slice. So Tasks 2 and 3 are **one
dispatch**: write the tests, run them, watch them fail for the right reason,
record what the failure said, then implement until they pass, then commit once.
**The report must quote the failure output** — that is the evidence the tests
were written first, and it is the only evidence available once the commit is
green. *Costs if wrong:* nothing, provided the report carries the failures. If it
does not, the requirement was not met and the coordinator cannot tell.

**PR-27 — the state machine, with every transition named and a writer for each.**
**Only `ready` and `cutover` permit `mode = 'enforce'`.**

| From | To | Written by |
| --- | --- | --- |
| `not_started` | `observing` | `setRuleMode(mode: 'observe')` — also sets `observe_started_at = now` |
| `observing` | `ready` | `automod ready` — **refused from any other state** |
| `ready` | `cutover` | a successful `setRuleMode(mode: 'enforce')`, same write |
| `cutover` | `rolled_back` | `setRuleMode` to any non-`enforce` mode while `cutover` |
| `rolled_back` | `observing` | `setRuleMode(mode: 'observe')` — **resets `observe_started_at`** |

- `observing` does **not** permit enforcement, even after two weeks: the clock
  elapsing is not the same as a human having looked.
- `ready` is an explicit human act — "I have reviewed this rule's window and
  believe it is ready". It is the judgement the gate cannot make.
- `rolled_back` does **not** permit enforcement, and **`automod ready` refuses
  from it.** Both halves are needed: without the command's precondition, a
  rollback could be undone by `ready` then `enforce`, never revisiting
  `observing` — which is the exact scenario ADR 0042 exists to prevent. **The
  first draft of this ruling asserted that property and specified neither the
  precondition nor any writer for `rolled_back` or `observing`, so all three
  states were unreachable and the property was false.** The plan review caught
  it.
- **Re-observing resets the clock**, and that is the point: a rule pulled back
  from enforcement has to earn a fresh window, and its old
  `observe_started_at` would let `doctor` think the floor had already elapsed.
  This is the carried-forward obligation from this run's kickoff — "any rule
  whose observe data predates ADR 0039 is worthless; restart those clocks" —
  made mechanical.

*Costs if wrong:* an operator must set `ready` before enforcing, which is one
extra command and is the point; and a rolled-back rule must be re-observed
before it can be enforced again, which is the property this ruling is about.

**PR-28 — a "reviewed match" is a `mod_match_reviews` row whose `event_id` joins
to a `mod_case_events` row for this rule.** Verdicts are keyed by event, and
events carry `rule_id`, so the count is a join — not a column on the rule, which
would be a denormalised tally that can drift from the rows it summarises. The
`unclear` verdict counts as a **false positive** (spec decision 16). *Costs if
wrong:* the gate runs a join per check instead of reading an integer. It is
checked once per enforcement attempt, not per message.

**PR-29 — the low-volume path's machine check is the *presence of a sign-off*;
the clean-corpus requirement is enforced where the sign-off is recorded, not
where enforcement is refused.** The spec gates a rule with fewer than 20 reviewed
matches on "a clean pass against the fixture corpus **plus** an explicit owner
sign-off". A clean corpus pass means `runDryRun`, which lives in `core` — and
`packages/storage` may not import `core` (ADR 0014). So:

- **`setRuleMode`'s check (storage):** fewer than 20 reviewed matches ⇒ require
  `enforce_signed_off_by` to be non-null. Pure SQL, no cross-package import.
- **The sign-off writer (a CLI command, which may reach `core`):** refuses to
  record a sign-off unless a dry run over the corpus is clean — `usable`, zero
  `threw`, zero `falsePositives`.

So the attestation is machine-checked, at the moment it is made, by the layer
that can see the corpus. *Costs if wrong:* a sign-off written directly by SQL
bypasses the corpus check. That is true of every column in this database and is
what the audit row is for; the alternative is storage importing core, which
ADR 0014 forbids and which would make the dependency graph circular.

**PR-30 — the two thresholds are columns on the rule with defaults, not
constants.** `max_false_positive_rate` (default 0.05) and
`min_reviewed_matches` (default 20). ADR 0042 §4 says they live on the rule so
the refusal reads them without a second source of truth. **They are not offered
in any CLI surface this slice ships**, because "narrow the rule, do not move the
bar" is the standing instruction and a command that moves the bar invites moving
it. *Costs if wrong:* changing a threshold needs SQL until a later slice offers
it deliberately. That friction is intentional.

---

## Task order and dispatch batching

**Strictly one dispatch at a time.**

| Dispatch | Tasks | Why |
| --- | --- | --- |
| A | 1 | The migration and schema alone — nothing else can be written against columns that do not exist. |
| B | **2 + 3** | The gate's tests, watched failing, then the implementation. One dispatch, one commit (PR-26). |
| C | 4, 5 | `counts_as_violation` reaching the subscriber; `automod_testing_mode` as a third lever. |
| D | 6 | `doctor`'s two new checks and the CLI surface for `ready`/sign-off. |

---

### Task 1: the columns

**Files:** `packages/storage/src/schema.ts`; generated `drizzle/00NN_*.sql`;
`packages/storage/src/repos/automod-rules.ts` (the read shape);
`packages/storage/src/repos/guilds.ts`; their tests.

On `mod_rules`, all nullable-or-defaulted so existing rows are valid:

| Column | Type | Notes |
| --- | --- | --- |
| `cutover_state` | TEXT NOT NULL DEFAULT `'not_started'` | CHECK the five values (PR-27) |
| `observe_started_at` | INTEGER (nullable) | the clock; resettable |
| `legacy_rule_ref` | TEXT (nullable) | which Carl-bot/Dyno/native rule this replaces |
| `counts_as_violation` | INTEGER NOT NULL DEFAULT 1 | `boolCheck`; **default 1 is the strict direction** |
| `max_false_positive_rate` | REAL NOT NULL DEFAULT 0.05 | CHECK between 0 and 1 |
| `min_reviewed_matches` | INTEGER NOT NULL DEFAULT 20 | CHECK >= 0 |
| `enforce_signed_off_by` | TEXT (nullable) | plain TEXT, same reasoning as `mod_match_reviews.reviewed_by` (PR-9) |
| `enforce_signed_off_at` | INTEGER (nullable) | |

On `guilds`: `automod_testing_mode` INTEGER NOT NULL DEFAULT 0, `boolCheck`.

- [ ] **Step 1: write the failing tests** in `automod-rules.test.ts` and
  `guilds.test.ts`: a rule created today reads back
  `cutover_state: 'not_started'`, `countsAsViolation: true`,
  `maxFalsePositiveRate: 0.05`, `minReviewedMatches: 20`; a raw SQL insert with
  `cutover_state = 'banana'` throws; a raw insert with
  `max_false_positive_rate = 1.5` throws; a guild reads back
  `automodTestingMode: false`.

  **Pin each CHECK at its own boundary, in both directions** — the same
  discipline this plan applies to the gate's thresholds, and the plan review
  noted its absence here. `max_false_positive_rate` must **accept** exactly `0`
  and exactly `1` and reject `-0.1` and `1.5`; `min_reviewed_matches` must accept
  exactly `0` and reject `-1`. A CHECK written with `>` where `>=` was meant
  passes a test that only probes obviously-invalid values.
- [ ] **Step 2: run them, watch them fail** (no such column).
- [ ] **Step 3: add the columns** to `schema.ts`, following the file's
  conventions exactly (`check` names prefixed with the table name, `boolCheck`
  for the two booleans).
- [ ] **Step 4a: `npm run db:generate`, then read the SQL.**

  **A rebuild of `mod_rules` is expected here.** drizzle-kit 0.31.10 rebuilds the
  table for any new CHECK-constrained column — established by Task 1's first
  attempt, which stopped and reported it. **Do not try to avoid it**, and do not
  hand-edit the generated SQL. Read ADR 0042's **Amendment 1** for why it is
  safe: `runMigrations` disables `foreign_keys` at the connection level and
  brackets the run with `PRAGMA foreign_key_check`, so R-5's cascade cannot fire.

  **Generate in two runs, not one** — the plain nullable columns
  (`observe_started_at`, `legacy_rule_ref`, `enforce_signed_off_by`,
  `enforce_signed_off_at`) first, then the CHECK-constrained ones. Ruling R-6
  records drizzle-kit emitting *invalid* SQL when a column add and a rebuild land
  in the same `generate` call: the rebuild's `INSERT … SELECT` read a column the
  old table did not have yet. Two runs is exactly the shape R-6 prescribed for
  Slice 1, and it is what keeps the rebuild's column list correct.

  **What it actually took: three runs (ruling PR-32, recorded after the fact).**
  0015 the four plain nullable columns, 0016 the four defaulted ones — both
  plain `ALTER TABLE ADD COLUMN`, neither a rebuild — and **0017 the CHECKs
  alone**, which is the rebuild, of `guilds` and `mod_rules` both. The two-run
  shape above understated it because it treated "defaulted" and
  "CHECK-constrained" as one group; they are not. Every new CHECK forces a
  rebuild, because SQLite cannot add a CHECK to an existing table at all, and
  the rebuild is valid only because 0015 and 0016 had already put all fifteen
  columns on the old table for its `SELECT` to read.

  Report the statements you actually saw — the count and whether each run
  rebuilt — rather than confirming a number from this plan. An earlier draft said
  "five" while the table listed nine.

- [ ] **Step 4b: prove the children survive *this* migration.**

  This is what the slice owes in place of avoiding the rebuild, and it is not
  satisfied by the existing test. Follow
  `schema-invariants.test.ts`'s pattern exactly: migrate to the **previous**
  migration, insert one `mod_rules` row with a `word_categories` row, a
  `word_terms` row, a `word_allowlist` phrase **and** a `mod_rule_exemptions`
  row, then apply this slice's migration(s) and assert **every child row is
  still readable** and the rule's own columns carry their new defaults.

  `openMigratedTestDatabase()` will **not** do — it applies every migration to an
  empty database, so the rebuild statements never run against data and the test
  proves nothing. That trap is documented in the existing test's own comment;
  read it before writing yours.

  **Then watch it fail:** temporarily edit the generated migration to drop the
  `PRAGMA foreign_keys=OFF` line (or point `runMigrations` at a copy with
  enforcement left on), confirm the child rows vanish, and restore with
  `git restore`. A rebuild-survival test that has never seen the rows disappear
  is the decorative shape this project has found sixteen of.
- [ ] **Step 5: widen the read shapes.** `StoredAutomodRule` gains the new
  fields; `hydrate` selects them. **Expect this to break every construction site
  in the test suite** — run `typecheck` early, and report how many you touched.
  A plan's file list is a lower bound.
- [ ] **Step 6: gates by exit code, then commit.**

---

### Task 2 + Task 3: the gate — tests first, then the refusal

**One dispatch, one commit (PR-26). The report must quote the failures.**

**Files:** create `packages/storage/src/repos/enforcement-gate.ts` + `.test.ts`;
modify `automod-rules.ts` (`setRuleMode`).

**Interfaces:**

```ts
export type EnforcementRefusal =
  /** cutover_state does not permit it (PR-27). */
  | { readonly reason: 'cutover-state'; readonly state: string }
  /** A counter-feeding rule with any false_positive or unclear verdict. */
  | { readonly reason: 'false-positive'; readonly falsePositives: number; readonly reviewed: number }
  /** A delete-only rule above its rate. */
  | { readonly reason: 'rate-too-high'; readonly rate: number; readonly threshold: number }
  /** Fewer than min_reviewed_matches and no sign-off (PR-29). */
  | { readonly reason: 'low-volume-unsigned'; readonly reviewed: number; readonly required: number };

export type EnforcementEligibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: EnforcementRefusal };

export const enforcementEligibility = (
  scope: GuildScope,
  ruleId: string,
): EnforcementEligibility => { /* … */ };
```

`setRuleMode` returns
`{ ok: true } | { ok: false; refusal: EnforcementRefusal }` — **a change from
`void`, so every caller must handle a refusal.** It has no production caller
today, which is why this is the cheapest possible moment (ADR 0042,
Consequences).

- [ ] **Step 1: write the four gates the spec names, plus the state machine**

These are the spec's own words (§4, Slice 6). Write them **first** and run them
**before** writing `enforcement-gate.ts`.

```ts
it('refuses enforce for a rule whose cutover_state does not permit it', () => {
  // Every non-permitting state, not just one — `observing` is the one an
  // operator will actually hit, and `rolled_back` is the one that must not be
  // undoable by retrying the same command (PR-27).
  for (const state of ['not_started', 'observing', 'rolled_back'] as const) {
    // …set the rule to `state`, give it a clean review history…
    const result = setRuleMode(scope, { ruleId: 'r1', mode: 'enforce', now: NOW });
    expect(result.ok, state).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe('cutover-state');
  }
});

it('refuses a counter-feeding rule with a single false_positive verdict', () => {
  // counts_as_violation = 1, 25 reviewed matches, exactly one false positive.
  // The threshold is zero, so 1/25 = 4% must still be refused — a rate that
  // would PASS the delete-only tier. That contrast is the test's point.
});

it('refuses a counter-feeding rule with a single unclear verdict', () => {
  // Spec decision 16: `unclear` counts as a false positive. The separate test
  // is deliberate — an implementation counting only `false_positive` passes
  // the previous test and fails this one.
});

it('refuses a delete-only rule at 6% and allows it at 4%', () => {
  // Both halves in one test, because the pair is the assertion: 3/50 = 6%
  // refused, 2/50 = 4% allowed. A single-sided test passes under a
  // comparison with the wrong strictness or an off-by-one denominator.
});

it('falls to the low-volume path at 19 reviewed matches rather than passing on a flattering ratio', () => {
  // 19 reviewed, ALL true_positive — a 0% false-positive rate, which is
  // exactly the flattering number the minimum exists to reject. Refused with
  // 'low-volume-unsigned' while there is no sign-off; allowed once
  // enforce_signed_off_by is set.
});

it('does NOT fall to the low-volume path at exactly 20 reviewed matches', () => {
  // The other side of the same boundary, and the plan's first draft specified
  // only the 19 case — the identical omission the 5% threshold got caught for
  // two paragraphs below. `min_reviewed_matches` is 20 and the rule is
  // "minimum 20 reviewed matches", so 20 is *enough*: an implementation using
  // `<=` refuses a rule sitting exactly on its bar and passes the 19 test,
  // so only this test distinguishes them.
  //
  // 20 reviewed, all true_positive, NO sign-off — must be allowed, because
  // the sample is now sufficient on its own.
});

it('advances cutover_state from ready to cutover on a successful enforce', () => {
  // PR-27's transition, and the reason it is asserted: a gate that permits
  // enforcement but does not record that it happened leaves `doctor` unable
  // to tell an enforced rule from one merely eligible.
});
```

- [ ] **Step 2: run them and record exactly what failed.** They must fail
  because `enforcement-gate.ts` does not exist and `setRuleMode` returns `void`
  — not because a fixture is wrong. **Paste the failure output into your
  report**; it is the only evidence the tests came first (PR-26).

- [ ] **Step 3: implement `enforcementEligibility`**

Order of checks matters and is part of the contract: **state first**, then the
tier. A rule in `observing` with a terrible false-positive rate should be
refused for its *state*, because that is the fact the operator needs to act on
first. Say so in a comment.

The verdict tally is a join (PR-28): `mod_match_reviews` ⋈ `mod_case_events` on
`(guild_id, event_id)`, filtered to this `rule_id`. Count reviewed rows and
count rows whose verdict is `false_positive` **or** `unclear`.

Then, in order:
1. `cutover_state` not in `('ready', 'cutover')` ⇒ `cutover-state`.
2. `reviewed < min_reviewed_matches` ⇒ `low-volume-unsigned` unless
   `enforce_signed_off_by` is non-null.
3. `counts_as_violation` and `falsePositives > 0` ⇒ `false-positive`.
4. `falsePositives / reviewed > max_false_positive_rate` ⇒ `rate-too-high`.

**Watch the boundary in both directions** (Global Constraint 7): exactly at the
threshold must be *allowed*, and one above refused. The spec says "at most 5%",
so 5% passes. Add a test at exactly 5% — the plan's 4%/6% pair does not pin it,
and an implementation using `>=` would pass both halves of that pair.

- [ ] **Step 4: wire the refusal into `setRuleMode`**, advancing
  `ready → cutover` on success, in the same `write`.

- [ ] **Step 5: watch four guards fail.** Reverse the check order so state is
  checked last (the `observing`-plus-bad-rate test must report the wrong
  reason); drop `unclear` from the false-positive count; change `>` to `>=` on
  the rate comparison (the exactly-5% test must go red); change `<` to `<=` on
  the reviewed-count comparison (the exactly-20 test must go red). Restore each.

  **The last two are the same mutation on the two different thresholds**, and
  the plan's first draft asked for only one of them. Both boundaries need both
  directions — Global Constraint 7, which this plan stated and then applied to
  one threshold out of two.

- [ ] **Step 6: gates by exit code, then commit** — one commit, with the failure
  output from Step 2 in the report.

---

### Task 4: `counts_as_violation` reaches the subscriber

**Files:** `packages/core/src/automod/subscriber.ts`,
`predicates/types.ts` (or wherever the subscriber's rule shape lives),
`apps/daemon/src/automod/wiring.ts`, their tests.

`subscriber.ts:448` hard-codes `countsAsViolation: true` on the enforce path.
Lift it to the rule.

- [ ] **Step 1: write the failing test** — a rule with
  `countsAsViolation: false` that matches in `enforce` mode still deletes the
  message and still records a case event, but calls `openOrResolveCase` with
  `countsAsViolation: false`. **The ambiguity that makes it non-decorative:**
  assert the deletion *and* the flag, so an implementation that skipped the
  action entirely also goes red.
- [ ] **Step 2: run, watch fail. Step 3: implement. Step 4: watch it fail by
  hard-coding `true` again.**
- [ ] **Step 5: gates, commit.**

---

### Task 5: `automod_testing_mode`, the third lever

**Files:** `packages/core/src/automod/subscriber.ts` (the safety-state read),
`packages/storage/src/repos/guilds.ts`, `apps/daemon/src/automod/wiring.ts`,
tests.

`readSafetyState` returns `{ killswitch, breakerOpen, dryRun }`. Add
`automodTestingMode`. When set, automod takes **no Discord action** and records
the match as it would in `test` mode — **and every other subsystem is
unaffected**, which is the whole point (spec F3).

- [ ] **Step 1: write the failing tests.** Two, and the second is the one that
  matters: (a) with `automodTestingMode`, a matching rule in `enforce` does not
  delete and does not count a violation; (b) **a role-panel assignment still
  works** with `automodTestingMode` set — the guard against reimplementing
  `dry_run` by another name. If the role-panel path is not reachable from this
  test's harness, assert instead that `automodTestingMode` appears in **no**
  code path outside `automod/`, with `rg` over the source, and say why.
- [ ] **Step 2: run, watch fail. Step 3: implement. Step 4: watch it fail.**
- [ ] **Step 5: gates, commit.**

---

### Task 6: `doctor`'s two checks, and the CLI surface

**Files:** `packages/core/src/ops/commands/reads.ts` (doctor),
`packages/core/src/ops/commands/automod.ts` (new commands),
`packages/core/src/ops/ports.ts`, `registry.ts`,
`apps/daemon/src/ops/wiring.ts`, tests.

**`doctor` gains two checks** (ADR 0042 §3 — `doctor` reports, `setRuleMode`
refuses):
1. Rules already in `enforce` whose `cutover_state` does not permit it — rows
   that predate this slice or were hand-edited.
2. Rules in `observe` past their window (`observe_started_at` older than the
   floor) with an unreviewed match backlog.

**Two commands:**
- `automod ready <ruleId>` — sets `cutover_state = 'ready'`, write + audit. The
  explicit human act PR-27 requires. **It must refuse unless the rule is
  currently `observing`**, and the refusal is a returned usage answer naming the
  actual state, not a thrown error — the same shape `automod verdict` uses for a
  mistyped event id. **The test that matters here is `rolled_back` → refused**,
  because without it a rollback can be undone by `ready` then `enforce` without
  ever revisiting `observing`, which is the scenario ADR 0042 exists to prevent.
  Write that test and watch it fail against a version with no precondition.
- `automod signoff <ruleId>` — records `enforce_signed_off_by` /
  `_at`. **Per PR-29 this command refuses unless a dry run over the corpus is
  clean** (`usable`, zero `threw`, zero `falsePositives`). It is the layer that
  can see both the corpus and the rule, and it is where the spec's
  "clean pass against the fixture corpus" is actually enforced.

- [ ] **Step 1: write failing tests** for both `doctor` checks and both
  commands, including **`signoff` refused when the dry run is not clean** — the
  guard that makes PR-29 real rather than a comment.
- [ ] **Step 2–4: run, implement, watch each guard fail.**
- [ ] **Step 5: gates, commit.**

---

## Self-review — spec coverage

| Spec requirement | Task |
| --- | --- |
| `legacy_rule_ref`, `cutover_state`, `observe_started_at` | 1 |
| Engine refuses `enforce` unless `cutover_state` permits | 2+3 |
| `guilds.automod_testing_mode` fixing F4 | 5 |
| `doctor`: enforce with a bad state; observe past window with a backlog | 6 |
| 5% for delete-only, zero for counter-feeding | 2+3 |
| `unclear` counts as a false positive | 2+3 |
| Minimum 20 reviewed matches | 2+3 |
| Low-volume path: clean corpus pass **plus** owner sign-off | 2+3 (the check), 6 (the corpus requirement, PR-29) |
| `counts_as_violation` as a rule property | 1 (column), 4 (behaviour) |
| Thresholds and sign-off live on the rule | 1 (PR-30) |
| §4's four named gate tests, written before the feature | 2+3 (PR-26) |

**No deliberate deviations.** Nothing in the spec's Slice 6 is unimplemented by
this plan.
