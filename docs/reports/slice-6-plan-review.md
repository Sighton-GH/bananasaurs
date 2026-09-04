# Slice 6 plan review — the release gate

Reviewed: `docs/superpowers/plans/2026-09-04-slice-6-release-gate.md` against
ADR 0042, `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`
§3 Phase 3 / §4 Slice 6 gates / §7 decision 16, and the current code in
`packages/storage/src/repos/automod-rules.ts`, `mod-match-reviews.ts`,
`schema.ts`, and `packages/core/src/automod/subscriber.ts`.

## Verdict: EXECUTE-WITH-FIXES

Three blocking findings, all fixable without re-architecting the plan. None of
them touch Tasks 1–5's mechanics; two live in Task 6 (`automod ready`, doctor's
"observing" check) and PR-27's prose, one is an internal arithmetic
inconsistency in Task 1 / Global Constraints.

## Blocking findings

### B1 — a rolled-back rule can be re-enforced by retrying, exactly what PR-27 says must not happen

**Location:** PR-27 (lines 84–99), Task 6's `automod ready` bullet (line 381).

PR-27 states the safety property in prose: *"A rule that was enforced and
pulled back must return to `observing` deliberately, so a rollback cannot be
undone by retrying the same command."* But:

- No task ever writes `cutover_state = 'observing'` or `'rolled_back'`
  anywhere. Grepping the plan for both strings turns up only the CHECK
  constraint (Task 1), the refusal-reason enum (Task 2+3), and this same prose
  paragraph. There is no command, no `setRuleMode` side effect, nothing that
  puts a real rule into either state in production.
- Task 6's `automod ready <ruleId>` is specified as "sets `cutover_state =
  'ready'`, write + audit" — **with no precondition on the rule's current
  state.** Nothing in Task 6's test list ("write failing tests for both
  `doctor` checks and both commands, including `signoff` refused when the dry
  run is not clean") includes a test that `ready` refuses when the rule is
  currently `rolled_back` (or `cutover`).

Put together: an operator rolls a bad rule back (however that column gets set
— today, only by hand in SQL, since no command does it), then runs `automod
ready <ruleId>` — which the plan does not gate on prior state — immediately
followed by `setRuleMode('enforce')`, which only checks `cutover_state IN
('ready','cutover')`. The rollback is undone without ever passing back through
`observing`, which is precisely the scenario PR-27 exists to prevent. This is
this slice's own core safety property, made false by its own Task 6.

A second consequence of the same gap: since nothing ever sets `observing`,
Doctor's check #2 ("rules in `observe` past their window with an unreviewed
backlog") can never find a real row in production — the clock the ADR
justifies at length (`observe_started_at`, resettable, distinct from
`updated_at`) is inert until some other slice sets it, and nothing in this
plan or the spec's later slices names which one does.

**Correction:** give `automod ready` an explicit precondition — refuse unless
`cutover_state IN ('not_started', 'observing')` — and add the refused-test for
`rolled_back` and `cutover`. Add whatever write path is meant to set
`observing` (a plan ruling is missing here: either `setRuleMode(mode:
'observe')` also stamps `cutover_state = 'observing'` / `observe_started_at =
now` on the first such transition, or a dedicated command does it — the plan
must say which) and, separately, a command that is the only way to reach
`rolled_back` (today nothing reaches it outside a test's raw SQL). Without
one of these, "rollback cannot be undone by retrying" is a claim the shipped
code does not make true.

### B2 — the 20-match minimum has no boundary test and no mutation coverage, unlike the 5% boundary the plan itself flagged

**Location:** test 5 (lines 267–272), Step 3's ordering (lines 298–303), Step
5's mutation list (lines 312–316).

The plan is explicit that the 4%/6% pair alone does not pin the rate
comparison's strictness, and adds an exactly-5% test plus a `>` → `>=`
mutation to close that gap (lines 304–307, 315). It does the equivalent
reasoning for the false-positive-count checks (separate `unclear` test,
because "an implementation counting only `false_positive` passes the previous
test and fails this one" — line 258). It does **not** do this for
`min_reviewed_matches`: the only named test uses 19 reviewed matches (below
the floor). There is no test at exactly 20, and Step 5's mutation list
("reverse the check order... drop `unclear`... change `>` to `>=`") does not
include flipping `reviewed < min_reviewed_matches` to `<=`. A test suite built
exactly to this plan's letter would pass unchanged if the implementer wrote
`<=` there — every rule with exactly 20 reviewed matches would incorrectly
fall to the low-volume path (and require a sign-off it should not need) — and
nothing would go red. This is the "19 vs 20" boundary the review brief calls
out by name, and it is the one threshold in this slice the plan did not apply
its own stated boundary-testing discipline to.

**Correction:** add a test asserting exactly 20 reviewed matches (0 false
positives, no sign-off) is evaluated on the normal rate path and passes rather
than falling to `low-volume-unsigned`, and add "`<` → `<=` on
`min_reviewed_matches`" to Step 5's mutation list.

### B3 — the plan's own column count disagrees with its own table

**Location:** line 8 ("Four additive columns on `mod_rules`, one on
`guilds`"), line 38 ("Five `ALTER TABLE … ADD COLUMN`"), Task 1's table (lines
160–171), Step 4 (line 184: "Confirm five `ALTER TABLE … ADD COLUMN`
statements").

Task 1's own table lists eight new columns on `mod_rules` (`cutover_state`,
`observe_started_at`, `legacy_rule_ref`, `counts_as_violation`,
`max_false_positive_rate`, `min_reviewed_matches`, `enforce_signed_off_by`,
`enforce_signed_off_at`) plus one on `guilds`
(`automod_testing_mode`) — nine `ADD COLUMN` statements, not five, and not the
"four... one" the architecture line claims. Step 4 tells the implementer to
verify the generated migration has **five** `ALTER TABLE … ADD COLUMN`
statements. That check will not match what `db:generate` actually produces
against Task 1's real column list. This lands exactly on the moment
CLAUDE.md rule 2 / ruling R-5's anti-rebuild vigilance matters most — an
implementer told to expect "five" who counts nine has no way, from the plan
alone, to know whether the extra four are the expected column growth or a
symptom of a rebuild splitting `ADD COLUMN`s across statements.

**Correction:** fix line 8 to "eight additive columns on `mod_rules`, one on
`guilds`" and line 38 / line 184 to "nine `ALTER TABLE … ADD COLUMN`
statements."

## Non-blocking

- No test pins the exact boundary values of the new CHECK constraints
  themselves (`max_false_positive_rate` at exactly `0` and `1`,
  `min_reviewed_matches` at exactly `0`) — lower stakes than B2 since these are
  CHECK-level, not gate-logic, but the same discipline the plan applies
  elsewhere would catch a `>`/`>=` slip in the CHECK's SQL too.
- Step 4's "if a rebuild appears, stop and report" has no remediation path
  beyond stopping. That is an acceptable and safe fallback given ruling R-5,
  not a defect — noted only because nine CHECK-constrained columns landing in
  one migration make a rebuild materially more likely than the plan's "five
  columns" framing suggests.

## Verified clean

- **PR-28's join** (`mod_match_reviews` ⋈ `mod_case_events` on
  `(guild_id, event_id)`, filtered to `rule_id`): checked against the live
  schema. `mod_match_reviews`'s primary key and foreign key are both exactly
  `(guild_id, event_id)` onto `mod_case_events(guild_id, event_id)`
  (`schema.ts` lines 1126–1130), and `mod_case_events.rule_id` is a plain
  column on the same row (line 859). The join the plan assumes exists exactly
  as described, and is guild-scoped by construction (both tables carry
  `guild_id` and the FK ties them within a guild).
- **PR-29's split**: `setRuleMode`'s check is pure SQL (presence of
  `enforce_signed_off_by`), and the corpus check is described as living only
  in a new CLI command that writes those columns. No other write path to
  `enforce_signed_off_by`/`_at` is specified anywhere in the plan (not in
  `SetRuleModeInput`, not elsewhere), so as specified there is no hole where a
  sign-off is recorded without the corpus check — contingent on the
  implementer not adding a second write path later.
- **The rate-boundary test (5%) and the `unclear`-vs-`false_positive` split**:
  both are specified in a form that can fail for the right reason — the plan
  pre-empts the `>=`-passes-both-halves trap with an explicit exact-5% test
  and a matching mutation, and separates the `unclear` test from the
  `false_positive` test for exactly the stated reason (an implementation
  counting only one passes one and fails the other). No decorative guard
  found among the four named gate tests themselves — the gap is a *missing*
  fifth boundary test (B2), not an unfalsifiable one among the four named.
- **`setRuleMode`'s signature change**: matches ADR 0042's own claim that it
  has no production caller today, so widening `void` to a result type is
  confirmed to have no call site to update outside tests.
- **No new dependency, guild scope on `enforcementEligibility`'s signature,
  Zod-boundary reasoning (PR-29)**: all consistent with CLAUDE.md rules 2, 3
  and 7 as stated.
