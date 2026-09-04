# Release 2, Slice 4 — dispatch B report (Tasks 5a, 3, 4)

Plan: `docs/superpowers/plans/2026-09-03-slice-4-window-tier.md`. Dispatch B
ran strictly sequentially: 5a → 3 → 4, each gated and committed on its own,
per the plan's explicit ordering (5a moved forward to end the four-tests
churn problem before `rapid_spam` could force a fourth repoint).

## Task 5a — the registry seam (obligation 3)

**Chosen approach:** the injectable seam (plan's preferred option), not the
delete-and-comment alternative. `registry.ts` gained `resolveConfigWith`,
`compileRuleWith`, `validateRuleConfigWith`, each taking an explicit
`Partial<Record<RuleKind, AnyPredicate>>`. `compileRule`/`validateRuleConfig`
are now one-line wrappers over the shipped `PREDICATES`. `predicateFor` was
left as-is (no injectable form) since nothing needs one — no-predicate is
reachable through `compileRuleWith`/`validateRuleConfigWith` instead.

Four repointed assertions, one file at a time:

1. `registry.test.ts`'s `predicateFor` test — repointed from `'rapid_spam'` to
   `'telepathy'` (a string that is not a real `RuleKind` at all), since after
   this slice `predicateFor` has no `undefined` case left for a *real*
   permitted kind.
2. `registry.test.ts`'s `compileRule` no-predicate test — repointed to
   `compileRuleWith({}, rule({kind: 'rapid_spam', ...}))`, an explicit empty
   registry.
3. `registry.test.ts`'s `validateRuleConfig` no-predicate test — repointed to
   `validateRuleConfigWith({}, 'rapid_spam', '{}')`.
4. `reads.test.ts`'s doctor-rendering test — this one drives a **fake**
   `OpsPorts.listUnusableAutomodRules`, so it never touched the real registry
   in the first place; swapped its illustrative `kind: 'rapid_spam'` for
   `'unshipped_example'` (not a real `RuleKind`) purely so a future reader
   can't mistake it for registry-dependent.

**`apps/daemon/src/automod.integration.test.ts` needed a different fix than
the plan's literal instruction.** That test drives the *real* production
stack (`opsPortsFor` → `wiring.ts` → the real `compileRule` over `PREDICATES`),
not `compileRuleWith` directly — there is no registry-injection point in
production wiring, and adding one just for this test would be exactly the
kind of unplanned production change the plan warns against. Once this
dispatch finishes (all ten kinds registered), `no-predicate` is genuinely
unreachable through that real stack, so the scenario the test named can no
longer be constructed end-to-end. Repointed it to a `keyword_filter` rule
with zero enabled terms (`no-terms`) instead — a real, end-to-end,
**permanently reachable** unusable-rule case (an operator can always disable
the last term), preserving the test's actual value ("an unusable rule is
inert and loud in doctor") without borrowing a kind that was about to ship.
Documented in the test's own comment.

Confirmed via `rg` that no test in the repository still depends on any real
kind being unregistered.

**Guard watched fail:** reordered `resolveConfigWith` to check the registry
before `isRuleKind`. Both "reports an unknown kind" tests (`compileRule` and
`validateRuleConfig`) went red, misreporting `unknown-kind` as `no-predicate`
— confirming `unknown-kind` and `no-predicate` stay distinguishable only
because of the check order. Restored.

## Task 3 — `rapid_spam`

New `packages/core/src/automod/predicates/rapid-spam.ts` +
`rapid-spam.test.ts` (8 tests). Config `{maxMessages, windowMs}`, `windowMs`
bounded 1 000–600 000. Ring buffer capacity is `maxMessages + 1` (imports
`DEFAULT_MAX_TRACKED_MEMBERS` from `window.ts` per the plan) — a buffer capped
at exactly the threshold could never observe the "one too many" count that
fires the rule. Ignores `messageUpdate` (PR-23). Store built in `compile`'s
closure (PR-21), commented that a config edit resets the window.

**Guard (b) confirmed red:** dropping the `eventKind !== 'messageCreate'`
guard made the third `messageUpdate` mis-fire at count 3. Restored.

**Guard (a) did not reproduce, and I am saying so rather than reconciling
it.** The plan's Step 4(a) says "never prune → the 'forgets messages' test
goes red." I disabled `window.ts`'s `pruneOlderThan` (made it a no-op) and
re-ran both `rapid-spam.test.ts` and `window.test.ts` in full: **all tests
stayed green.** Reason: `countWithin`/`countMatching` independently
re-filter every call to `[atMs - windowMs, atMs]`, so the stored array's age
is irrelevant to any query result — pruning only affects memory footprint,
and even that is already bounded by the unconditional per-member cap that
runs on every `record()` regardless of age. This is a plan-vs-code
disagreement (ruling #10), not a decorative test: the described bug and the
described test genuinely don't correspond in the implementation Task 1
shipped. Restored the no-op change; no functional issue results from this,
since correctness never depended on pruning in the first place.

## Task 4 — `duplicate_message`

New `packages/core/src/automod/predicates/duplicate-message.ts` +
`duplicate-message.test.ts` (12 tests). Config
`{maxRepeats, windowMs, minLength=0}`. Exported, named normaliser
`normaliseForDuplicateCheck` per PR-20: `stripZeroWidth` (imported from
`matcher.ts`, not reimplemented) + lowercase + whitespace collapse. Uses
`countMatching` keyed the same way `rapid_spam` is; ring buffer capacity
`maxRepeats + 1` for the same reason. `minLength` defaults to 0, documented in
the schema per the plan's instruction.

**Test fixture adapted, documented in-line.** The plan's literal zero-width
fixture (`'buy​crypto​now'`) uses U+200B *in place of* the space between
words, with no real spaces at all. `stripZeroWidth` only deletes the
character; it does not insert a space. Deleting a word-separator zero-width
character therefore concatenates the words (`'buycryptonow'`), which does not
equal the space-separated original after whitespace collapse — the plan's
literal fixture cannot pass under the normaliser PR-20 mandates. Replaced it
with a zero-width character inserted *mid-word* (`'buy cry​pto now'`), the
evasion class `stripZeroWidth` actually defends against and the one this
predicate can honestly claim to close. Verified both occurrences land on the
intended codepoint/position with a scratch script before trusting the test.

**Both guards confirmed red:** (a) counting every message via `countWithin`
instead of `countMatching` misfired the "different messages" test at count 3.
(b) dropping `stripZeroWidth` failed both the normaliser unit test and the
predicate's zero-width test. Both restored.

`registry.ts`'s `PREDICATES` map is now complete — all ten `mod_rules_kind`
values have a predicate, which is exactly the state Task 5a's seam was built
to survive.

## Gates, per commit

| Commit | typecheck | lint | test |
| --- | --- | --- | --- |
| `d906bcc` (Task 5a) | exit 0 | exit 0 | 2282/2282, 111 files |
| `eaf638b` (Task 3) | exit 0 | exit 0 | 2290/2290, 112 files |
| `3a43ee1` (Task 4) | exit 0 | exit 0 | 2302/2302, 113 files |

Baseline was 2282/111 at dispatch start — matched exactly before any new
code. Final: 2302 tests / 113 files (+20 tests, +2 files: 8 for
`rapid-spam.test.ts`, 12 for `duplicate-message.test.ts`).

## Did not do

Task 5b (the behavioural gate's two blind spots) is explicitly out of scope
for this dispatch — dispatch C owns it. Did not touch `dry-run.test.ts`,
`evaluate.ts`, `subscriber.ts`, or `predicateInputFrom`.

## Open items for the coordinator

- Plan rulings PR-20 through PR-25 are recorded in the plan file but not yet
  appended to `docs/reports/release2-slices-1-6-ledger.md` — that file has no
  PR-20+ entries as of this dispatch. Someone should append them (and this
  dispatch's two plan-vs-code findings above) before the ledger is treated as
  complete.
- The pruning guard finding (Task 3) is worth a maintainer's judgment call:
  `window.ts`'s lazy prune is currently provably inert for both correctness
  and memory-bounding (the per-member cap already bounds size on every
  `record()` call, independent of age). Not a bug — nothing relies on it
  being anything more than a comment's stated intent — but the plan's own
  guard-break instruction for it doesn't hold, and a future edit to `record()`
  that removed the unconditional cap check would make pruning load-bearing
  in a way no current test would catch.
