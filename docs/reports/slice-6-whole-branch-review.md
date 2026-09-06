# Slice 6 — whole-branch review (the release gate)

Reviewed `e500751..HEAD` against `docs/reports/slice-6-review-diff.patch`, the
plan (`docs/superpowers/plans/2026-09-04-slice-6-release-gate.md`, PR-27's
table included), ADR 0042 with Amendment 1, and the ledger's Slice 6 rulings
(PR-26…PR-35). No production code changed. Three probe tests were written,
run, and reverted with `git restore`; the working tree is as I found it
(`git status --short` shows only the untracked review diff).

**Gates, each run alone and read by its own exit code:**

```
typecheck: 0
lint: 0
test: 0        # 2380 tests across 114 files
```

**Verdict: SHIP-WITH-FIXES.** Two CRITICAL findings, both small fixes, both in
the specific thing this slice exists to make true — "enforcement is not
offerable until it has been earned". Everything the brief asked me to be
suspicious of in the *gate itself* (check order, boundaries, the state
machine, guild scope, the rebuild proof) I found correct and non-decorative,
and I say so with the mutations I watched go red.

---

## CRITICAL

### CRITICAL-1 — `automod signoff` calls an empty or wholly-unlabelled corpus a "clean pass", so the low-volume path can be satisfied with no evidence at all

**File:** `packages/core/src/ops/commands/automod.ts:735`

```ts
const clean = report.usable && report.threw === 0 && report.falsePositives === 0;
```

**What breaks.** PR-29 splits the low-volume path in two: storage checks that a
sign-off *exists*, and this command is "the layer that can see both the rule
and the corpus", so it is where the spec's "clean pass against the fixture
corpus" is actually enforced. All three fields it checks are vacuously
satisfied by a corpus that contains no evidence:

- `usable` is `failure === undefined` (`packages/core/src/automod/dry-run.ts:196`)
  — it means "the rule compiled", nothing about the corpus.
- `threw` counts fixtures the predicate threw on. Zero fixtures, zero throws.
- `falsePositives` counts only fixtures **labelled `should_not_match`** that
  matched (`dry-run.ts:210`). An unlabelled corpus produces zero by
  construction — which is exactly why `automod dryrun` refuses to print a rate
  when nothing is labelled (its own CRITICAL-1 guard, and the test
  `refuses to print a false-positive rate when nothing in the corpus is
  labelled` in `automod.test.ts`).

So the human-facing surface already knows an unlabelled corpus is meaningless
and says so; the machine-facing gate reads the same `DryRunReport`, ignores
`corpusSize` and `unlabelled`, and records the attestation anyway — the plan's
own Global Constraint 8 ("a human-facing guard is not a machine-facing guard"),
hit again.

**Verified, by probe.** Two throwaway tests appended to
`packages/core/src/ops/commands/automod.test.ts`, run, then reverted:

```
PROBE-A text: rule r1 signed off by cli:bryan (dry run over the fixture corpus was clean)
PROBE-A recorded: {"ruleId":"r1","signedOffBy":"cli:bryan"}     # listAutomodFixtures: () => []

PROBE-B text: rule r1 signed off by cli:bryan (dry run over the fixture corpus was clean)
PROBE-B recorded: {"ruleId":"r1","signedOffBy":"cli:bryan"}     # two fixtures that MATCH, both unlabelled
```

PROBE-B is the realistic one: during the observe window most of the corpus is
unlabelled — `dry-run.ts:28` says so in its own comment — so this is the
ordinary state of a corpus on the day someone reaches for `automod signoff`.

**Reproducible failure scenario, end to end.** A new `caps` rule, `caps` being
the predicate ADR 0042 §F2 names as the one that needs this path:

1. `createRule` — `mode: 'test'`, `cutover_state: 'not_started'`,
   `min_reviewed_matches: 20`, no reviews.
2. `setRuleMode(mode: 'observe')` → `observing`, clock stamped.
3. `bananasaurs automod ready caps-rule --confirm` → `ready`.
4. `bananasaurs automod signoff caps-rule --confirm` → **recorded**, and the
   operator is told "dry run over the fixture corpus was clean" even though
   the corpus is empty (a fresh guild) or entirely unlabelled (the normal
   case). `enforce_signed_off_by = 'cli:bryan'`.
5. `setRuleMode(mode: 'enforce')` → `enforcementEligibility`: state `ready`
   passes check 1; `reviewed (0) < 20` but `enforceSignedOffBy` is non-null so
   check 2 defers; `falsePositives` is 0 so check 3 passes; `reviewed === 0` so
   `enforcement-gate.ts:144` returns `{ ok: true }`. **The rule enforces with
   zero reviewed matches and zero labelled fixtures.**

The gate's remaining checks are not at fault — they are correct given a
sign-off that means what PR-29 says it means. The defect is that the sign-off
does not mean that.

**Suggested fix** (small, and entirely inside this command): refuse unless the
replay actually weighed something — `report.corpusSize > 0` **and** at least
one fixture carries a real label (`unlabelledCount(report) < report.total`, or
a labelled count of its own). Put the counts in the success text, the `data`
and the audit row, so a later reader can see what the attestation was made
against. `unlabelledCount` already exists in this file.

---

### CRITICAL-2 — a `counts_as_violation = 0` rule still times out and kicks, so the 5% tier's blast-radius premise is false

**Files:** `packages/core/src/automod/subscriber.ts:488-518`;
`packages/storage/src/repos/mod-cases.ts:525-533`

**What breaks.** ADR 0042 §4's table admits a rule to the **5%** tier on the
grounds that its maximum blast radius is "Deletes the message only
(`counts_as_violation = 0`)". The enforce path does not implement that. It
reads the counter without incrementing it, and then escalates off it anyway:

```ts
const { caseId, violationCount } = deps.openOrResolveCase(authorId, {
  countsAsViolation: rule.countsAsViolation,   // false → counter unchanged
});
...
const tier = deps.nextEscalationTier(violationCount);   // still sees the counter
if (tier.action === undefined) { record(caseId, 'deleted'); continue; }
const outcome = await deps.moderationGateway.applyAction(...);  // timeout / kick
```

`openOrResolveCase` returns the *existing* `violationCount` when
`countsAsViolation` is false (`mod-cases.ts:148`), and `nextEscalationTier`
uses `>=`, not `===` (`mod-cases.ts:525`: `>= 6` kick, `>= 3` timeout). So a
member whose counter already stands at a tier — put there entirely by *other*,
counter-feeding rules — is timed out or kicked by the delete-only rule that
was let through the looser bar. And because the counter never moves, the same
delete-only rule re-applies the same tier on every subsequent match
(`dedupeKey` includes `messageId`, so each match is a fresh intent).

**Verified, by probe.** A throwaway test appended to
`packages/core/src/automod/subscriber.test.ts` — the existing harness already
has the two knobs needed (`violationCount`, `tier`) — run, then reverted:

```
PROBE-C openOrResolveCase: [{"memberId":"222222222222222222","countsAsViolation":false}]
PROBE-C nextEscalationTier: [3]
PROBE-C applyAction: ["timeout"]
PROBE-C recordCaseEvent: ["deleted_and_escalated"]
```

`deleted_and_escalated`, from a rule whose whole reason for existing is that it
does not escalate.

**Why the existing test does not catch it.** `honours countsAsViolation: false
on the enforce path` (`subscriber.test.ts:345`) is the exact decorative shape
`docs/22` catalogues: its fixture leaves the harness at the default
`tier: { action: undefined }`, so the escalation branch it needs to reach is
unreachable, and its `actionTaken: 'deleted'` assertion confirms that. The test
is correct about what it asserts; the state it asserts it in cannot contain the
bug.

**Reproducible failure scenario.** `caps`, admitted to enforcement under the 5%
tier with `counts_as_violation = 0` and a measured 4% false-positive rate. A
member has three legitimate violations from the keyword filter, so
`mod_cases.violation_count = 3`. They post a message in caps that `caps` gets
wrong — one of the 4% the tier explicitly tolerates. Outcome: the message is
deleted **and the member is timed out for ten minutes**, recorded as
`deleted_and_escalated`. At a counter of 6 the same false positive kicks them.
The 5% allowance was granted on a promise the code does not keep.

**Suggested fix.** Skip the escalation entirely when
`rule.countsAsViolation === false` — record `'deleted'` and `continue` before
`nextEscalationTier`. That is what "deletes the message only" means, and it
makes the tier table true. Add the missing half to the existing test
(`violationCount: 3`, `tier: { action: 'timeout' }`, assert
`applyAction` is empty) so the fixture contains the ambiguity the test name
implies.

---

## IMPORTANT

### IMPORTANT-1 — `makeRuleEnforceableForTest` is in the public package surface, writes both eligibility facts with no precondition, and nothing stops a production caller

**File:** `packages/storage/src/repos/enforcement-gate.ts:313`, re-exported by
`packages/storage/src/index.ts:43` (`export * as enforcementGateRepo`).

**What breaks.** The brief asks directly: is anything but a test able to reach
it? Yes. It is not in a `test-support` module, it is not behind a build flag or
an environment check, and no lint rule fences it: `eslint.config.js` bans
`@bananasaurs/storage` from `core`, `cli`, `dashboard` and `testkit`, but
**not** from `packages/http`, which is where Slice 8's dashboard routes go, and
`apps/daemon` may import storage by design. One line —
`enforcementGateRepo.makeRuleEnforceableForTest(scope, ruleId, Date.now())` —
in a Slice 8 wiring file or route writes `cutover_state = 'ready'` **and** a
sign-off, and the very next `setRuleMode(mode: 'enforce')` then passes a gate
that has read no evidence. The function's own doc comment says it is
"defensible only because its only caller is a test harness"; nothing enforces
that premise.

**Failure scenario.** Slice 8 builds the dashboard's "flip this rule to
enforce" route. `setRuleMode` refuses in the developer's manual test because
the rule is `not_started`; the developer greps for how the existing tests get
past that, finds the exported helper, and calls it from the route handler to
"make the button work". The gate is now a formality for every rule the
dashboard touches, `doctor`'s bad-cutover-state check stays green (the state
really is `ready`), and nothing in review flags it because the call reads like
any other repo call.

**Suggested fix, cheap.** Move it to a module the package index does not
re-export (the pattern `dbOf` already uses — see `scope.ts`'s comment on
exactly this: "not re-exported from `index.ts`, which is what keeps the handle
out of `core`"), and have the three integration tests import it by relative
path. Failing that, add `packages/storage/src/repos/enforcement-gate.js` to a
`no-restricted-imports` group for `packages/http/**` and `apps/daemon/**`
naming the helper.

### IMPORTANT-2 — a rollback does not clear the sign-off, so the low-volume escape hatch survives the decision to stop trusting the rule

**File:** `packages/storage/src/repos/automod-rules.ts:625-673` (`setRuleMode`
writes `mode`, `enabled`, `cutoverState`, `observeStartedAt`, `updatedAt` —
and nothing else); `setRuleConfig` at `:477` likewise.

**What breaks.** PR-27's stated property is that "a rule pulled back from
enforcement has to earn a fresh window". Two things make that weaker than it
reads:

1. `enforce_signed_off_by`/`_at` are **not** cleared on
   `cutover → rolled_back`, nor on `rolled_back → observing`, nor by a config
   edit. The sign-off has no expiry and no linkage to the corpus or the rule
   configuration it attested.
2. The two-week floor is nowhere machine-checked. `setRuleReady` (`:706`) has
   no clock precondition, and `enforcementEligibility` never reads
   `observe_started_at`. Resetting the clock changes only what `doctor`
   *reports*.

So the "fresh window" is a report, and the strongest piece of evidence behind
the low-volume path is a fact from before the rollback.

**Failure scenario.** A delete-only `caps` rule reaches `enforce` through the
low-volume path (sign-off, few reviewed matches). In production it deletes a
run of legitimate messages. The operator rolls it back:
`setRuleMode(mode: 'test')` → `rolled_back`. Nothing was reviewable from that
period — PR-2 captures a fixture only while a rule is in `test`/`observe`, so
the enforce-mode false positives left no corpus rows and no new
`mod_match_reviews` rows. A week later:
`setRuleMode(mode: 'observe')` → `observing` (clock reset, meaning nothing),
`automod ready` → `ready` (no floor check), `setRuleMode(mode: 'enforce')` →
`reviewed` still under 20, `enforce_signed_off_by` still set from before the
rollback, so the volume floor is cleared, `falsePositives` is still 0 because
nobody could review anything, and the rule enforces again. The rollback cost
one command to undo and produced no new evidence.

**Suggested fix.** Null `enforce_signed_off_by`/`_at` in the same write that
sets `cutover_state = 'rolled_back'`, and say why in the comment. (Whether to
also clear it on a config edit is a judgement call; clearing on rollback is
the one PR-27's stated property needs.)

### IMPORTANT-3 — nothing in Release 2 can write `cutover_state = 'observing'`, so `automod ready` can never succeed and one of `doctor`'s two new checks can never fire

**Files:** `packages/core/src/ops/registry.ts:45-87` (no mode command);
`packages/storage/src/repos/automod-rules.ts:625` (`setRuleMode`, zero
production callers).

**What breaks.** `setRuleMode` is the only writer of `mode` and of three of
PR-27's five arrows, and it has **no production caller** — the ADR says so
(§F1) and accepts it, because "it gains one the moment the dashboard ships
(Slice 8)". But Task 6 ships two commands *now* whose preconditions depend on
that writer having run:

- `automod ready` refuses unless `cutover_state = 'observing'`. Nothing an
  operator can run in Release 2 writes `observing`. The command therefore
  always answers `cannot be marked ready from cutover_state not_started`.
- `listObservingRulesPastWindowWithBacklog` keys on
  `cutover_state = 'observing'` (PR-35, correctly reasoned). With no writer for
  that state, `doctor`'s second new check cannot fire in Release 2 — a
  permanently-green line, which is the mirror image of the "cries wolf"
  reasoning the ledger applies to the `enabled` filter.

This is the same shape the ledger already caught once inside this slice
("nothing in the codebase would ever have written `observing`"), fixed at the
storage layer and still open at the command layer.

**Failure scenario.** Flip week. The operator works the handoff checklist,
item 3: "restart the observe clock for any rule whose data predates ADR 0039".
There is no command. They run `bananasaurs automod ready default-word-filter
--confirm` and are told the rule must be `observing`, with no command that can
put it there. The only route is
`UPDATE mod_rules SET cutover_state='observing', observe_started_at=…` by hand
against `data/bananasaurs.db` — an unaudited write of the exact column
`doctor`'s sibling check exists to flag as a hand edit.

**Suggested fix.** Either (a) ship a small `automod mode <ruleId>
<test|observe|enforce>` write command in this slice — it is the natural
first production caller, it makes the whole state machine and the gate
reachable, and its refusal path is already a returned value; or (b) if it is
deliberately deferred to Slice 8, record that in the handoff **and** say in
`automod ready`'s help text and in the ledger that the command cannot succeed
until then, so nobody spends flip day hunting for the missing step.

### IMPORTANT-4 — `automod_testing_mode` has no writer and no report: the F3 fix is unreachable, and if it is set it is invisible

**Files:** `packages/storage/src/repos/guilds.ts` (a read at `:134`, no
setter); `packages/core/src/ops/settings.ts` (not in the enumerated
`config set` keys); `packages/core/src/ops/commands/status.ts:58` and
`reads.ts` (`doctor`) — neither mentions it.

**What breaks.** ADR 0042 §5's justification for the column is that
`dry_run` makes the safe option expensive, so operators pick the unsafe one.
As shipped, turning testing mode **on** requires a hand-edited `UPDATE guilds
SET automod_testing_mode = 1` — strictly more expensive than
`bananasaurs config set dry_run true`, which is the surface it was meant to
replace. `rg` over `packages/core/src/ops` finds `automod_testing_mode`
nowhere: not in `settings.ts`'s closed key list, not in `status`'s safety line
beside `killswitch`/`dry run`, not in `doctor`. PR-34's own cost note leans on
the opposite being true of its sibling lever — "the killswitch is guild-wide
and `doctor` reports it".

**Failure scenario.** An operator does find the column and sets it by SQL
before flip day, to watch a new rule act-free. Two weeks later they flip three
rules to `enforce` and watch the channel: nothing is ever deleted. `status`
says killswitch off, dry run off. `doctor` says every enforcing rule is in a
permitting `cutover_state` and reports no problems. The case events say
`would_delete`, which reads identically to `test` mode. There is no line
anywhere that says why. That is ADR 0039's shape exactly — a rule that looks
configured and silently does not fire — reintroduced by the lever added to
prevent the same class of problem.

**Suggested fix.** A `config set automod_testing_mode` key (the enumerated
list already exists and is the right place) plus one line in `status`'s safety
row and a `doctor` line when it is on. If a setter is deliberately deferred,
the report half is still needed, and is three lines.

### IMPORTANT-5 — the eight new storage columns leak into `ruleFingerprint`, defeating the `mode` exclusion on flip day and making the file's central claim false

**Files:** `packages/core/src/automod/fingerprint.ts:39` and `:112-121`;
`packages/storage/src/repos/automod-rules.ts:78-107`;
`apps/daemon/src/automod/wiring.ts:278`.

**What breaks.** `ruleFingerprint` hashes `Object.keys(rule)` — the runtime
object's keys, not `AutomodRule`'s declared fields — minus
`EXCLUDED_FIELDS = {ruleId, mode}`. Before this slice, `StoredAutomodRule` and
`AutomodRule` were field-for-field identical, so that was harmless. This slice
adds eight columns to `StoredAutomodRule` and only one (`countsAsViolation`) to
`AutomodRule`, and `wiring.ts:278` passes the storage rows straight through
(`listRules: () => automodRuleRepo.listEnabledRules(scope)`). So
`cutoverState`, `observeStartedAt`, `legacyRuleRef`, `maxFalsePositiveRate`,
`minReviewedMatches`, `enforceSignedOffBy` and `enforceSignedOffAt` are all
hashed, invisibly — a reader auditing the digest from `AutomodRule` plus
`EXCLUDED_FIELDS` would count eight hashed fields where there are fifteen.

Two concrete consequences:

1. `mode` is excluded with a stated reason: "a flip-day mode change must not
   throw away every compiled matcher in the guild at the moment that would be
   most expensive to rebuild them". Every mode change that matters now also
   writes a hashed column — `mode: 'observe'` writes `cutover_state` and
   `observe_started_at`, a successful `enforce` writes
   `cutover_state = 'cutover'` — so the exclusion no longer buys what its
   comment says it buys. `evaluate.ts:103` discards the compiled artifact on a
   digest change, and for `rapid_spam`/`duplicate_message` that discards the
   sliding-window store closed over it. One recompile and one window reset per
   flipped rule, not per message: bounded, but not what the comment claims.
2. The file's own warning — "a field that changes with traffic rather than
   with configuration MUST be added here", naming PR-14's deferred
   `invite.last_matched_at` — is now aimed at the wrong type. That column will
   land on `StoredAutomodRule` first, where it enters the digest without ever
   appearing on `AutomodRule`, and the ADR-0039 silent-non-matching bug the
   warning exists to prevent arrives with nothing in `core` to notice it.

**Failure scenario for (2), the one that bites later.** Slice 9 adds
`lastMatchedAt` to `StoredAutomodRule` and has `hydrate` select it. Nothing in
`packages/core` changes, so nobody edits `EXCLUDED_FIELDS`. Every message a
`rapid_spam` rule observes updates that column, changes the digest, recompiles
the predicate and resets its window — so the rule can never accumulate enough
events to fire, with no log line and no `doctor` entry.

**Suggested fix.** Project explicitly at the boundary:
`listRules: () => automodRuleRepo.listEnabledRules(scope).map(toAutomodRule)`,
naming the eight fields `core` actually needs, so the digest's input is the
declared type. That restores both the `mode` exclusion and the "everything
`Predicate.compile` reads, and nothing else" claim, and makes a future storage
column a compile-time decision rather than a silent one. Whichever way it
goes, `fingerprint.ts`'s comments need to match (Global Constraint 9).

---

## MINOR

### MINOR-1 — `doctor` reports a hand-edited `cutover_state` but says nothing about a hand-edited threshold, and `min_reviewed_matches = 0` bypasses the evidence requirement outright

**Files:** `packages/storage/src/repos/enforcement-gate.ts:144`;
`packages/storage/src/schema.ts:701`.

PR-30 keeps the two thresholds off every CLI surface because "narrow the rule,
do not move the bar", and `doctor` gained a check for the one hand-edit the
slice worried about (`mode = 'enforce'` with a non-permitting state). A hand
edit that moves the bar achieves the same end more quietly and is reported
nowhere: `UPDATE mod_rules SET min_reviewed_matches = 0` makes check 2
unreachable, and `enforcement-gate.ts:144`'s `reviewed === 0` early return —
correct as written, and correctly documented — then returns `ok` for a
counter-feeding rule with no reviewed matches and no sign-off at all.
`max_false_positive_rate = 1` is the same trick on the other tier. Both values
are blessed by the CHECK and by a test (`min_reviewed_matches accepts exactly
0`). Cheap mitigation: extend `listEnforceRulesWithBadCutoverState` (or add a
third line) to report any rule whose thresholds differ from the documented
defaults, so a moved bar is visible where a bad state already is.

### MINOR-2 — the release gate has no two-guild test

`packages/storage/src/repos/enforcement-gate.test.ts` opens exactly one scope
(`:30`) and never a second. Every query in `enforcement-gate.ts` does go
through `scope.only`, and the verdict tally's join equates `guild_id` on both
sides, so I found no scope defect — but CLAUDE.md rule 2's stance is that the
constraint belongs in a test as well as a signature, and this project's own
`docs/22` records a two-guild cache-key test that could not fail. One case —
guild B's rule with the same `rule_id` and a corpus of `false_positive`
verdicts, asserting guild A's rule is unaffected and vice versa — closes it.

---

## What I checked and found correct

Stated because a review that only lists defects hides what the slice got
right, and because the brief named most of these specifically.

- **Every write path to `mode`, `cutover_state` and `enforce_signed_off_by`.**
  `createRule` hard-codes `mode: 'test'`; `setRuleMode` is the only `mode`
  writer; `cutover_state` has exactly three writers (`setRuleMode`,
  `setRuleReady`, `makeRuleEnforceableForTest`); nothing else in
  `packages/storage`, `packages/core`, `apps/daemon` or `scripts` touches
  `mod_rules` at all (`rg` over all four). A refusal writes nothing — not the
  mode, not `enabled`, not `updatedAt` — and a test pins it.
- **A rollback cannot be undone by retrying.** `automod ready` refuses from
  `rolled_back`, `enforcementEligibility` refuses `rolled_back` and
  `observing`, and `cutover` + any non-enforce mode lands on `rolled_back`
  rather than stepping straight to `observing`. All five states have a writer.
  The residual weakness is the stale sign-off (IMPORTANT-2), not the arrows.
- **Check order and its contract.** State is checked before the tier, and the
  `observing`-plus-terrible-rate test asserts the *reason*, not just the
  refusal.
- **Boundaries, both directions.** 19 refused / 20 allowed; 6% refused / 5%
  allowed / 4% allowed; CHECK accepts exactly 0 and exactly 1 and rejects
  `-0.1` and `1.5`; `min_reviewed_matches` accepts 0 and rejects `-1`; the
  observe floor reports at exactly `OBSERVE_WINDOW_FLOOR_MS` and stays silent
  one millisecond short. `unclear` has its own test, distinct from
  `false_positive`. `reviewed === 0` returns explicitly rather than through
  `NaN`. Float note: `1/20` and the REAL literal `0.05` are the same double,
  so the exactly-5% test is meaningful rather than accidentally passing.
- **The `disable-not-rollback` fence is not decorative.** I mutated
  `automod-rules.ts:634` from `} else if (input.mode !== undefined) {` to
  `} else {` and watched exactly that test go red
  (`expected 'rolled_back' to be 'cutover'`), 27 of 28 still green; restored
  with `git restore`.
- **The rebuild survival proof and its negative control both measure the
  stated mechanism.** I swapped the negative control's `migrate(db, …)` for
  `runMigrations(raw, db, …)` and watched all five child counts flip from
  `0` to `1` — so the connection-level `foreign_keys = OFF` is precisely the
  discriminating variable, not an incidental one; restored with
  `git restore`. I also confirmed the library claim in `node_modules` rather
  than from memory: `drizzle-orm/sqlite-core/dialect.js:657-671`
  (`SQLiteSyncDialect.migrate`) wraps **every** pending statement across
  **every** `.sql` file in one `BEGIN … COMMIT`, so 0017's in-file
  `PRAGMA foreign_keys=OFF/ON` are the documented no-ops the ledger says they
  are.
- **The three-migration split is right and loses nothing.** 0015 and 0016 are
  plain `ADD COLUMN`; 0017 is the only rebuild, of `guilds` and `mod_rules`,
  and its `INSERT … SELECT` names all fifteen `mod_rules` columns, every one
  of which 0015/0016 had already put on the old table. Both `__new_*` column
  and constraint lists match `schema.ts` field for field, and `rg` over
  `drizzle/` confirms **no** index has ever been created on `guilds` or
  `mod_rules`, so the rebuild drops none. `scripts/migrate.mjs` goes through
  `runMigrations`.
- **Guild scope.** Both `doctor` queries and both halves of the eligibility
  read use `scope.only`; the verdict tally scopes `mod_case_events` and
  equates `guild_id` across the join, so `mod_match_reviews` is scoped
  transitively; `mod_match_reviews`' primary key is `(guild_id, event_id)`, so
  the tally counts distinct events and cannot be inflated by duplicate
  reviews. The `doctor` ports are wired per-scope in
  `apps/daemon/src/ops/wiring.ts:156-204`.
- **`doctor`'s two checks flip `ok` to false** and their asymmetry on
  `enabled` is deliberate, reasoned in both the code and the ledger, and
  tested on both sides.
- **PR-34's ordering** (`automod_testing_mode` ahead of the `delete_blocked_*`
  block) is pinned by a test, and the branch `continue`s before anything reads
  `blocked` — consistent with the ledger's account of the mutation that stayed
  green for the right reason.
- **`countsAsViolation` on the fingerprint** was considered explicitly and
  documented (`predicates/types.ts:63-67`) — the problem is the seven
  *other* fields nobody decided about (IMPORTANT-5).

## Findings the previous rounds already fixed — re-checked, all correct

The sign-off falls through to the zero bar and the rate rather than
short-circuiting (and two tests pin both tiers); `reviewed === 0` returns
explicitly; `setRuleMode` owns four of PR-27's five arrows with the clock
stamped on `not_started → observing` and `rolled_back → observing` only;
PR-34's ordering is tested; the observe-window check filters `enabled = 1`
while its sibling deliberately does not.

---

## Verdict

**SHIP-WITH-FIXES.**

CRITICAL-1 and CRITICAL-2 should land before any rule is flipped in the real
guild — each is a handful of lines, and each falsifies a sentence the release
gate's whole argument rests on ("a clean pass against the fixture corpus", and
"deletes the message only"). IMPORTANT-3 and IMPORTANT-4 are the difference
between a gate that works and a gate an operator can actually drive on flip
day, and they are the two most likely to be discovered at the worst moment.
IMPORTANT-1, -2 and -5 are latent: none breaks today, each is cheap now and
expensive in Slice 8/9.

The gate's own logic — the four ordered checks, the tiers, the thresholds, the
state machine and the migration — is the strongest work in this run. Both
CRITICALs are outside it: one in the command that feeds it evidence, one in the
subscriber that is supposed to honour the tier it grants.
