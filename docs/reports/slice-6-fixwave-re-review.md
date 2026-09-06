# Slice 6 — re-review of the fix wave (commit `385859e`)

Reviewed `docs/reports/slice-6-fixwave-diff.patch` (676 lines) against
`docs/reports/slice-6-whole-branch-review.md`, which the brief names as the
specification for what these fixes were supposed to achieve. No production code
changed. Nine throwaway probes and three mutations were written, run and undone
with `git restore`; `git status --short` shows only the four untracked review
documents it showed at the start.

**Gates, each run alone and read by its own exit code:**

```
typecheck: 0
lint: 0
test: 0        # 2385 tests across 114 files
```

**Verdict: SHIP.** All five fixes do what they claim, including the one the
brief flagged as most dangerous — drizzle really does distinguish `undefined`
from `null` in a `.set()`, verified in `node_modules` *and* by probe, so the
rollback fix does not clear sign-offs on unrelated writes. Both CRITICALs are
genuinely closed and both new guards were watched going red. The four findings
below are one real diagnosis bug and three residual gaps; none of them changes
an enforcement decision, and none is a reason to hold the branch.

---

## The five fixes, and what I verified about each

### 1. CRITICAL-2, delete-only escalation — correct

`packages/core/src/automod/subscriber.ts:518`.

- **Still deletes.** The early return sits *after* the `deleteMessage` try/catch
  (`:452-484`), so the deletion happens first and unchanged.
- **Still records a case event.** `record(caseId, 'deleted')`.
- **`delete_failed` still recorded correctly.** The `if (!deleted)` branch
  (`:500`) precedes the new one, so a Discord-refused deletion still lands on
  `delete_failed` and never on `deleted`.
- **No other path to `applyAction`.** `rg` over `subscriber.ts` finds exactly
  one `moderationGateway.applyAction` call (`:532`), downstream of the new
  return. The only other `nextEscalationTier` caller in the tree is
  `packages/core/src/mod/warn.ts`, a human-initiated `/mod warn`, which no
  automod rule reaches.
- **`countsAsViolation` is a required `boolean`** on `AutomodRule`
  (`predicates/types.ts:68`), so `!rule.countsAsViolation` cannot be accidentally
  true for a counter-feeding rule via an absent field.
- **The new test is not decorative.** I replaced the guard's condition with
  `false as boolean` and watched exactly one test fail — *a delete-only rule does
  not escalate, even for a member already on a tier* — 47 of 48 still green;
  restored with `git restore`.

### 2. CRITICAL-1, vacuous sign-off — correct, with a diagnosis bug (IMPORTANT-1)

`packages/core/src/ops/commands/automod.ts:754-777`.

- **Refusal order is right, and the ordering question is moot.** The new branch
  is guarded by `clean && agreed === 0`, so a corpus that is both unlabelled
  *and* dirty falls through to the `!clean` refusal and reports
  `dry-run-not-clean` — the more actionable reason. Placing it first costs
  nothing.
- **The audit row is still written** on the new refusal path, with
  `action: 'automod.enforce_signed_off'` and
  `after.outcome: 'no-corpus-evidence'`, matching the shape the `!clean` refusal
  already used.
- **Guard watched going red.** Mutating `agreed === 0` to `agreed === -1` failed
  exactly the two new tests, 72 of 74 still green; restored.
- **Is `agreed` the right quantity?** Mostly yes, and for a better reason than
  the comment gives: `agreement === 'agreed'` includes a `should_not_match`
  fixture the rule did *not* match, which is precisely the evidence the
  false-positive gate cares about. But the bar is thinner than it reads, in two
  ways the fix does not say out loud. The corpus is guild-wide (`FixtureRecord`
  has no rule id, `listAutomodFixtures({})` takes no rule filter), so "a fixture
  this rule agreed with" is satisfied by one `should_not_match` fixture labelled
  for some *other* rule's review, which a brand-new narrow rule will not match
  either. Probe PROBE-D: a corpus of one `should_not_match` fixture the rule
  never matches → **signed off**, text "dry run over the fixture corpus was
  clean". PROBE-E: 299 unlabelled fixtures plus that one → also signed off. That
  is the "weakest non-vacuous bar" the code comment admits to, so I am not
  calling it a defect — but the corpus being shared across rules means the bar is
  effectively guild-global once any one fixture is labelled, and neither the
  comment nor the ledger says so.

### 3. IMPORTANT-2, rollback withdraws the sign-off — correct, and the drizzle premise holds

`packages/storage/src/repos/automod-rules.ts:661-662`.

**Verified against `node_modules`, twice over, then by probe.**

- `drizzle-orm/utils.js:83-95` (`mapUpdateSet`) filters entries with
  `value !== void 0` and wraps everything else — `null` included — in
  `new Param(value, column)`.
- `drizzle-orm/sqlite-core/dialect.js:65-82` (`buildUpdateSet`) then selects
  column names with `set[colName] !== void 0 || onUpdateFn !== void 0`, so an
  `undefined` field never reaches the SQL at all. (The `??` on `:76` cannot
  misfire on `null`, because `mapUpdateSet` has already boxed it in a truthy
  `Param`.)
- `drizzle-orm/sql/sql.js:141` binds a `Param` whose `.value === null` as SQL
  `NULL`, bypassing `mapToDriverValue`.
- drizzle-orm is pinned at 0.45.2 (`node_modules/drizzle-orm/package.json`).

Probes on the real migrated database (appended to `enforcement-gate.test.ts`,
run, reverted):

| probe | call | result |
| --- | --- | --- |
| PROBE-1 | `ready` + sign-off, `setRuleMode(mode: 'observe')` | `enforce_signed_off_by: 'test-harness'`, `observe_started_at: 4242` — both **untouched** |
| PROBE-2 | `cutover` + sign-off, `setRuleMode({ enabled: false })` | sign-off untouched (the deliberate "a disable is not a rollback") |
| PROBE-3 | `cutover` + sign-off, `setRuleMode(mode: 'test')` | `cutover_state: 'rolled_back'`, both sign-off columns `null`, `observe_started_at` still `4242` |

So `undefined` means "leave alone" in practice as well as in the type, and the
feared failure mode — every unrelated mode change silently nulling the sign-off —
does not happen. Mutating `signedOffBy = null` back to `undefined` failed exactly
the new test, 28 of 29 still green; restored.

**Transitions that clear and do not clear.** `cutover → rolled_back` clears, from
any non-enforce mode. Nothing else clears, and two of those are worth naming:
`setRuleConfig` (MINOR-1 below) and the `ready`-plus-`mode: 'observe'` round trip
(PROBE-4: `cutover_state` stays `ready`, sign-off stays, and
`enforcementEligibility` returns `{ ok: true }` with zero reviewed matches). The
second is pre-existing and defensible — that rule was never enforced, so nothing
was pulled back — and it is documented at `automod-rules.ts:617-619`.

### 4. IMPORTANT-1, `makeRuleEnforceableForTest` moved — moved correctly, claim overstated (MINOR-2)

`packages/storage/src/test-support.ts:74`. Every call site moved: `rg` finds
five, all in `*.test.ts` (`automod.integration.test.ts` ×2,
`native-automod.integration.test.ts`, `automod-rules.test.ts` ×3,
`enforcement-gate.test.ts` ×5), and no production file imports it or the
`test-support` subpath. It is gone from `enforcement-gate.ts` and from
`enforcementGateRepo`'s namespace. See MINOR-2 for what is still open.

### 5. IMPORTANT-5, `toAutomodRule` — correct and complete

`apps/daemon/src/automod/wiring.ts:192`, used at `:312`.

`AutomodRule` declares exactly nine fields (`predicates/types.ts:44-69`:
`ruleId`, `kind`, `mode`, `config`, `terms`, `allowlist`, `inviteAllowlist`,
`linkDomains`, `countsAsViolation`) and the mapping names all nine. **Every one
of them is required**, so today a missing field is a compile error, not a silent
change — the brief's worry about optional fields has no instance yet. The
residual is one step out: if a *future* `AutomodRule` field is added as optional
and `toAutomodRule` does not map it, TypeScript stays quiet and the new
key-set test still passes (the key count is unchanged), so the predicate silently
reads `undefined`. Annotating the return type as
`{ [K in keyof AutomodRule]-?: AutomodRule[K] }` would close that for free.
`fingerprint.ts`'s comments are accurate again now that its only live caller
receives a declared `AutomodRule`. One pass-through remains (MINOR-3).

---

## IMPORTANT

### IMPORTANT-1 — the new sign-off refusal tells an operator to label fixtures that are already labelled, and names a condition that is false

**File:** `packages/core/src/ops/commands/automod.ts:756-777`.

**What breaks.** `agreed === 0` has two very different causes and the refusal
reports only one of them. `agreement` is `'agreed'` only when a fixture is
labelled *and* the rule behaved as the label says. A corpus that is fully
labelled but which the rule **disagrees with everywhere** — every
`should_match` fixture missed — produces `agreed === 0` with zero unlabelled
fixtures, and gets a refusal that says "nothing in the fixture corpus is
labelled either … Label some fixtures with `automod verdict` first", plus
`reason: 'no-corpus-evidence'` for any machine reader. Both are untrue, and the
instruction is the one action that will not help. The real finding — this rule
missed every judged example — is on the report as `falseNegatives` and
`disagreed`, and is reported nowhere.

**Verified, by probe** (PROBE-F, appended to
`packages/core/src/ops/commands/automod.test.ts`, run, reverted). Two
`should_match` fixtures the rule does not match:

```
PROBE-F text: rule r1 cannot be signed off: the dry run raised nothing, but nothing in
the fixture corpus is labelled either (2 fixture(s), 0 the rule agreed with) — …
Label some fixtures with `automod verdict` first.
PROBE-F data: {"ok":false,"reason":"no-corpus-evidence","ruleId":"r1","corpusSize":2,"agreed":0}
```

**Reproducible failure scenario.** The guild's corpus was labelled during the
word filter's observe window, so most labels are `should_match` (those messages
*should* have been caught). Flip week, the operator signs off the new `caps`
rule. `caps` matches none of those fixtures, so `agreed` is 0 and `falsePositives`
is 0. They are told the corpus is unlabelled, go and label more fixtures — the
same `should_match` shape, because that is what a reviewer labels when reviewing
matches — and are refused again with the same sentence. The exit is to label one
`should_not_match` fixture, which satisfies the bar and grants the sign-off; so
the command's advice leads to the *weakest* possible evidence by the longest
route, while never saying that the rule disagreed with every human judgement in
the corpus.

**Concrete fix, three lines.** Split the two cases on a labelled count (the
report already carries every input): `labelled === 0` keeps today's message and a
`no-corpus-labels` reason; `labelled > 0 && agreed === 0` gets its own reason and
a message naming `disagreed`/`falseNegatives`. This is the same defect class the
slice exists to remove — a sentence that reads as one thing while the data says
another — so it is worth the three lines even though nothing enforces wrongly.

### IMPORTANT-2 — the recorded sign-off still does not say what it was made against, which the review's fix explicitly asked for

**File:** `packages/core/src/ops/commands/automod.ts:815-823` (success path);
the same omission in the success `text` and `data` at `:812-814`.

**What breaks.** The review's suggested fix ended: "Put the counts in the success
text, the `data` and the audit row, so a later reader can see what the
attestation was made against." The refusal paths carry `corpusSize`/`agreed`; the
success path carries neither. So the one artefact ADR 0042 §4 says is "recorded
rather than remembered" records only *that* someone signed off, and the audit log
cannot distinguish a sign-off backed by 500 reviewed fixtures from one backed by a
single `should_not_match` label — which is exactly the state the new guard
permits.

**Verified, by probe.** PROBE-D's audit row, on a one-fixture corpus:

```
{"action":"automod.enforce_signed_off","subjectId":"r1",
 "after":{"outcome":"recorded","signedOffBy":"cli:bryan"},"dryRun":false}
```

`corpusSize`, `agreed`, `total` and `matched` are all in scope at that point.

**Reproducible failure scenario.** Six weeks after flip day, a `caps` rule is
deleting legitimate messages. The reviewer opens the audit log to ask what the
sign-off rested on. The row says `outcome: recorded, signedOffBy: cli:bryan` and
the console text said "dry run over the fixture corpus was clean". The corpus has
since grown and been relabelled, so it cannot be reconstructed, and there is no
way to tell whether the attestation was thin or thorough. Adding the three counts
to `text`, `data` and `after` is a one-line change per site.

---

## MINOR

### MINOR-1 — a sign-off still outlives the configuration it attested

**File:** `packages/storage/src/repos/automod-rules.ts:475` (`setRuleConfig`),
and the term/list writers at `:512`/`:532` and in `automod-rule-lists.ts`.

The fix's own justification — "a sign-off attests *I replayed this rule against
the corpus and it was clean*" — applies just as directly to a rule whose terms or
config changed after the sign-off: the replay attested a different rule. Verified
by probe (PROBE-6): sign off, then `setRuleConfig`, and the row still reads
`enforce_signed_off_by: 'test-harness'` with `enforcementEligibility` returning
`{ ok: true }` at zero reviewed matches. The original review called clearing on a
config edit a judgement call and I agree it is not a ship blocker — but it is now
the only remaining way a stale attestation reaches enforcement, and clearing it in
`setRuleConfig` is the same two lines the rollback path uses.

### MINOR-2 — `test-support.ts` says the shortcut is "physically out of production's reach"; it is not

**File:** `packages/storage/src/test-support.ts:64-66`.

Two claims in that comment are false. `packages/storage/tsconfig.json` excludes
only `src/**/*.test.ts`, so `test-support.ts` compiles into `dist/` on every
`npm run build`; and `packages/storage/package.json` publishes it as the
`"./test-support"` subpath export. No lint rule fences it: `eslint.config.js` has
no `no-restricted-imports` entry mentioning `test-support` anywhere. So the
original IMPORTANT-1 failure scenario still runs, one import line different — a
Slice 8 route in `packages/http` writes
`import { makeRuleEnforceableForTest } from '@bananasaurs/storage/test-support'`
and the gate is a formality for every rule the dashboard touches. The move is a
real improvement (it is out of `enforcementGateRepo`, and the specifier now
announces itself in review), but the comment overstates it, and the review's
"failing that" half — a `no-restricted-imports` group — was not done. Cheapest
close: one boundary block banning `@bananasaurs/storage/test-support` with
`ignores: ['**/*.test.ts']`, which would also catch every future test-only helper
added to that file.

### MINOR-3 — `findAutomodRule` still hands a `StoredAutomodRule` to a port typed `AutomodRule`

**File:** `apps/daemon/src/ops/wiring.ts:187-188` (and, harmlessly,
`listUnusableAutomodRules` at `:141`).

The brief asks whether anything else in the daemon still passes a row where an
`AutomodRule` is expected: yes, this one. `findAutomodRule` feeds `runDryRun` →
`evaluateRule` → `ruleFingerprint`, so all fifteen row keys are hashed on the
dry-run path. **No consequence today,** verified by reading `dry-run.ts:105-112`:
each run builds its own `createPredicateCache()` and evaluates one rule object,
so the digest is computed once and nothing is ever invalidated. But it means the
dry run and the live subscriber compute different digests for the same rule — a
crack in the one-code-path invariant — and it is the same silent-widening hole
the fix closed for the subscriber. `.map`/`toAutomodRule` on this line would make
the boundary uniform. (`toAutomodRule` lives in `automod/wiring.ts`; importing it
into `ops/wiring.ts` is fine, both are the composition root.)

### MINOR-4 — the rollback semantics are recorded only in code comments

ADR 0042's §4 describes the sign-off as a fact recorded on the rule and says
nothing about withdrawal (`rg` over
`docs/decisions/0042-cutover-state-and-the-tiered-false-positive-gate-decide-when-enforcement-is-offerable.md`);
`setRuleMode`'s own doc-comment arrows table (`automod-rules.ts:598-624`) lists
what each arrow writes without mentioning the two sign-off columns, and its next
bullet still says, of a disable, "the evidence behind it does not expire" — true
for a disable and now the opposite of what a rollback does, two paragraphs apart.
CLAUDE.md asks for a short ADR before a consequential choice; this is a real
amendment to the state machine's semantics and the next reader will reason from
the ADR, not from the comment. An amendment paragraph on 0042 plus one row in the
arrows table is enough.

---

## On the deliberate omissions

**The missing `automod mode` writer.** Not re-reported, as instructed, but the
brief asks whether the slice can honestly ship without it. Yes — and for a reason
worth writing down rather than merely accepting: with no production caller for
`setRuleMode` (confirmed again by `rg` over `apps/daemon/src`,
`packages/core/src`, `packages/http/src` excluding tests), **no rule can reach
`mode = 'enforce'` in Release 2 at all**, by any command. That is the safest
possible shipping state for a release whose whole subject is when enforcement
becomes offerable. The cost is that `automod ready` can never succeed and
`automod signoff` records an attestation nothing can act on, so the handoff must
say plainly that the cutover cannot be *completed* from the CLI this release —
otherwise flip day is spent hunting for a step that does not exist. Note too that
the rollback fix reviewed above is, today, unreachable in production for the same
reason; it is still right to land now, because Slice 8 is when it starts
mattering and this is the cheapest moment to get it right.

**The two MINORs left unfixed.** I agree with both deferrals. The threshold-hand-
edit `doctor` line is genuinely optional while nothing can flip a rule to enforce
anyway. The two-guild gate test is cheap and this project's own `docs/22` records
a two-guild test that could not fail, so it is worth doing — but every query in
`enforcement-gate.ts` does go through `scope.only`, so it is a test-coverage debt,
not a defect, and not a release gate.

---

## Verdict

**SHIP.**

Both CRITICALs are closed, each with a guard I watched go red. The drizzle
premise behind the rollback fix is correct in the pinned copy in `node_modules`
and correct in practice on the real database. The `toAutomodRule` narrowing is
complete against the declared type. The test-support move is complete at every
call site. Nothing in the fix wave introduced a new behavioural defect, and
nothing in it made a fixed problem worse.

The four findings above are, in order of what I would actually do first:
IMPORTANT-1 (three lines, and it is a wrong sentence on an operator's screen on
flip day), IMPORTANT-2 (three lines, and it is the audit trail the low-volume
path rests on), then the three MINORs, of which MINOR-2's lint fence is the
cheapest permanent one. None blocks the branch.
