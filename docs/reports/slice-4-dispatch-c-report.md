# Slice 4, Task 5b — closing the gate's two blind spots

**Status:** Obligation 1 discharged. Both blind spots named in the Slice 4
handoff are now proven caught by the one-code-path gate, under the asymmetric
corruptions PR-25 requires — not the symmetric ones the plan's first draft
specified (which could not have gone red).

## What changed

`packages/core/src/automod/dry-run.test.ts` gained two permanent tests inside
`describe('the one-code-path invariant', ...)`, both using a `rapid_spam` rule
(`maxMessages: 3`, `windowMs: 10000`):

- **Case A** — a burst clustered inside the window (`1_000, 2_000, 3_000,
  4_000`). Asserts the live subscriber's `recordCaseEvent` fires only on the
  fourth `receivedAtMs` (`liveMatchedAt` equals `[4000]`, not merely
  non-empty), and the dry run's `report.results` matches only at index 3,
  fixture id `rapid-a:4000`. Matches on both paths, and at the same message.
- **Case B** — a sequence spread beyond the window (`1_000, 20_000, 40_000,
  60_000`), each message aging out before the next arrives. Asserts no match
  on either path (`report.matched === 0`, `liveMatched` stays empty). This is
  the only shape that can distinguish a correct replay clock from
  `Date.now()` — a clustered burst produces the same verdict under both.

`predicates/registry.test.ts` and `ops/commands/reads.test.ts` needed no
edits: inspection confirmed Task 5a already ended every dependency on a real
kind standing in for "unregistered" — `compileRuleWith({}, ...)` /
`validateRuleConfigWith({}, ...)` use an explicit empty registry, and
`reads.test.ts` uses the non-`RuleKind` string `'unshipped_example'`. `rg`
confirms no remaining `no-predicate` test depends on a real kind being absent
from `PREDICATES`, which now lists all ten kinds.

## The two corruption exercises (temporary, reverted — no diff remains)

**1. Wrong clock.** In `evaluate.ts`'s `predicateInputFrom`, fixture branch:
changed `atMs: fixture.createdAt` to `atMs: Date.now()`. Ran
`dry-run.test.ts`:

- Case B went **red**: `expected [false,false,false,true] to deeply equal
  [false,false,false,false]` — the replay's four `Date.now()` calls landed
  within microseconds, clustering all four inside one window and firing a
  false match at the fourth fixture, while the live path (using
  `event.receivedAtMs`, untouched) correctly reported none.
- Case A stayed **green** (clustered timestamps are what it already has).
- All 15 other tests in the file stayed green (14 pre-existing + Case A).

Reverted; `git diff` on `evaluate.ts` is empty.

**2. Bypassed cache.** In `subscriber.ts`, replaced the instance-held
`predicateCache` argument to `evaluateRule` inside `handle()` with a
freshly-constructed `createPredicateCache()` on every call (never touching
`evaluateRule`, `compileRule`, or `predicateInputFrom`). Ran
`dry-run.test.ts`:

- Case A went **red**: `expected [] to deeply equal [4000]` — the live side
  never accumulated window state across the four `handle()` calls, so the
  count never reached four and no match ever fired, while the replay's
  correctly-reused cache matched on the fourth fixture as expected.
- Case B stayed **green** (no match is also the correct answer there, so a
  cache that never accumulates state cannot diverge from it).
- 15/16 tests green (14 pre-existing + Case B).

Reverted; `git diff` on `subscriber.ts` is empty.

## PR-25 compliance

Both corruptions are asymmetric (fixture-replay-only, live-subscriber-only
respectively) and neither touches `evaluateRule`, `compileRule`, or the shared
body of `predicateInputFrom`. Both fixture shapes are the sequence PR-25
requires — Case A clustered, Case B spread beyond the window — so a
`Date.now()` corruption and a clustered burst cannot coincidentally agree.

## Gates

`npm run typecheck` — exit 0.
`npm run lint` — exit 0.
`npm run test` — exit 0, **2304 tests / 113 files** (baseline 2302 + the 2 new
sequence tests; no other counts moved).

## Files touched (final diff)

- `packages/core/src/automod/dry-run.test.ts` — two new tests, no other edits.
- No edits landed in `predicates/registry.test.ts`, `reads.test.ts`,
  `evaluate.ts`, or `subscriber.ts` — the latter two were corrupted and fully
  reverted for verification only.
