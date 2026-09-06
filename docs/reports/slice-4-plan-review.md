# Review: Slice 4 (window tier) plan vs. spec

**Reviewed:** `docs/superpowers/plans/2026-09-03-slice-4-window-tier.md` against
`docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`
§3 Phase 2 Slice 4/§4, `docs/reports/release2-slice-4-handoff.md`, and the
current code in `packages/core/src/automod/{evaluate,dry-run,fingerprint,matcher,trace}.ts`,
`predicates/{types,registry,caps}.ts`.

## Verdict: EXECUTE-WITH-FIXES

Tasks 1–4 are sound: no new `PredicateInput` fields (removing the exact defect
class the last review found), the window-store interface is used consistently,
and every new predicate's tests are non-decorative on inspection (traced each
one's "if the implementation were wrong, would this go red" — all yes,
including the mention_spam "heretical.com" test, which is a genuine trap for a
content-scanning implementation, not a redundant check). **Task 5, Obligation
1 — the one the handoff itself calls "the important one" — is broken as
written** in a way that would let an implementer follow the recipe exactly,
watch the gate stay green, and not notice, because the plan's own
guard-breaking exercise (Global Constraint 6) is the only thing positioned to
catch it. Both defects are below.

## Blocking findings

### B1 — Task 5 Step 2(1): the "wrong `atMs`" guard cannot go red as specified

Plan text (Task 5, Step 1): build the sequence case with "four messages / four
fixtures at timestamps that make the fourth a match and the first three not."
That phrasing is a **rate-window** shape: for a count-based `rapid_spam` match
to land on the fourth event and not earlier, all four timestamps must fall
inside one shared `windowMs` of each other — that is what "the fourth is one
too many" means structurally.

Step 2(1) then corrupts only the fixture branch: `atMs: fixture.createdAt` →
`atMs: Date.now()`. Every fixture in one `runDryRun` call is processed
synchronously in a tight loop (`dry-run.ts`'s `for (const fixture of ordered)`)
with no timers — the four `Date.now()` calls land within microseconds of each
other, which is trivially inside *any* `windowMs` large enough to be a
plausible rate-limit config. So under the corruption, the four fixtures are
**still** all mutually inside the window — same qualitative outcome
("message four is the one that trips the counter") as the correct case. The
live path is untouched by this corruption (it uses `event.receivedAtMs`
directly), so live still says "matches on 4." Dry run, even broken, also says
"matches on 4." The cross-path comparison the plan specifies ("assert the live
path and the replay agree on which message matched") **passes** — this is
exactly the "fixture too simple to reach the branch the test is named after"
shape Global Constraint 6 warns about, for any timestamps that satisfy the
plan's own stated design.

This isn't a implementer-error risk; it's a mathematical property of the
"fourth matches" shape combined with `Date.now()`-clustering. Fix: use the
**expiration** shape instead — the same one Task 3's own "forgets messages
that fall out of the window" test already uses (e.g. `1_000, 20_000, 40_000,
60_000` against a 10s window, live path shows *no* match anywhere because each
message ages out before the next arrives). Under that shape, the corrupted
dry run's `Date.now()`-clustered fixtures *do* all land inside one window and
*would* wrongly report a match at message 4, while the live path (unaffected)
correctly reports no match — a genuine, catchable divergence. Whoever executes
Task 5 needs this correction before trusting a green result on this guard.

### B2 — Task 5 Step 2(2): corrupting `evaluateRule` breaks the guard's own premise

Plan text: "Make `evaluateRule` compile a fresh artifact on every call (ignore
the cache lookup)." `evaluateRule` (`evaluate.ts`) is the **one** function both
the live subscriber and `runDryRun` call — that's the one-code-path invariant
itself. Corrupting it this way affects both callers identically: every message
on both the live side and the replay side gets a fresh, empty window every
time, so neither side ever accumulates state and neither side ever matches.
The two paths still **agree** (both wrongly say "no match anywhere"), so a
live-vs-replay comparison cannot detect it — a bug in the one shared function
can, by construction, never produce a live/replay *divergence*; it can only
make both sides wrong together, which this style of gate was never able to
see (this is the flip side of the invariant `evaluate.ts`'s own header comment
already documents: the gate proves the two callers are *the same code*, not
that the code is *correct*).

The handoff this plan is bound to says something narrower and correct:
"Watch it fail by ... (b) making the **subscriber** compile a fresh artifact
per message" (`release2-slice-4-handoff.md`, Obligation 1 detail). That is an
asymmetric change — only the live side loses its cache (e.g. construct the
test subscriber so each `.handle()` call uses a throwaway `createPredicateCache()`
instead of the instance-held one) — leaving `runDryRun`'s single, correctly-
reused cache untouched. That asymmetry is what makes the divergence visible:
live never accumulates, replay does, and the two paths disagree on message 4.
The plan substitutes a different (and, per the argument above, non-working)
target for the corruption. Fix: point Step 2(2) at the subscriber's cache
wiring, not at `evaluate.ts`.

Both B1 and B2 are cheap to fix (they change what line gets temporarily
mutated for the "watch it fail" exercise, not the shipped code), but as
written they would let Task 5 report success on Obligation 1 without having
actually exercised it — which is the exact failure mode obligation 1 exists to
prevent.

## Decorative guards

None found in Tasks 1–4. Traced every listed test against "if the
implementation were wrong in the way this test's name describes, would this
go red" and all pass, including the two that look most suspicious at a glance:
- `window.test.ts`'s "takes its clock from the caller, never `Date.now()`"
  test uses timestamps (1_000–2_000ms) so far from a real epoch value
  (~1.7×10¹²ms) that any accidental `Date.now()` leakage into the counted
  result would produce an obviously wrong count, not a coincidentally-right
  one.
- Task 2's "reads Discord's own everyone flag, not the message text" test
  uses `'user@heretical.com'`, which contains the literal substring
  `@here` — a real trap for a naive content-scanning implementation, not a
  no-op check.

## Non-blocking

1. **`maxMembers` has no specified value for Tasks 3/4.** Task 1 gives
   `createWindowStore` two required constructor options; Task 3 says
   `compile` sizes `maxEventsPerMember` from `config.maxMessages`, but neither
   Task 3 nor Task 4 says what to pass for `maxMembers`, and each task creates
   its own store (window state lives per compiled artifact, ruling PR-21), so
   the two predicates could ship with two different, undocumented constants.
   Every other numeric choice in this plan carries a one-line rationale
   (PR-20 through PR-24); this one doesn't. Suggest a single exported
   constant (e.g. `DEFAULT_MAX_TRACKED_MEMBERS` from `window.ts`) both tasks
   import, with a comment noting this is a single-guild club bot (CLAUDE.md
   preamble), so the number can be modest.
2. **PR-20, re-examined as asked:** verified there is no clean third option.
   `obscenity`'s transformer factories (`resolveConfusablesTransformer`,
   `resolveLeetSpeakTransformer`, `toAsciiLowerCaseTransformer`) are exported,
   but the code that actually *runs* them over a string — `TransformerSet`,
   with its character-by-character iteration and simple/stateful dispatch —
   lives in `node_modules/obscenity/dist/transformer/TransformerSet.js` and is
   **not** re-exported from the package index (confirmed by reading
   `dist/index.js`'s export list). Hand-rolling that dispatch loop outside
   `obscenity` would mean depending on an undocumented discriminant shape
   (`'factory' in container` vs. a plain `transform` property) that carries
   no compatibility guarantee, and it would *still* omit
   `collapseDuplicatesTransformer` (whose thresholds are derived from a word
   list `duplicate_message` doesn't have per ADR 0039) — so it wouldn't even
   be "the same code," just a partial, fragile subset of it for real
   engineering cost. PR-20's conclusion holds; only its "Verified facts"
   phrasing ("needs a private deep import. Do not.") slightly overstates
   the case — the real reason to reject the alternative is fragility-for-no-
   full-fidelity, not just "it's a deep import." Worth a one-line addition to
   the ruling so a future reader doesn't re-propose it, but not a plan defect.
3. `duplicate_message`'s `minLength?: number` has no stated default in the
   plan prose; the implementer needs to pick one (0, matching "no floor," is
   the obvious choice) and should say so in the config schema's comment.

## Verified clean

- **Cross-task interface stability:** `PredicateInput` gains no fields this
  slice (checked against `predicates/types.ts` directly) — the exact defect
  class ("a later task adds a field an earlier task's dispatch already
  consumed") that blocked the previous slice's plan cannot recur here, because
  there is nothing new to be out of order about.
- **`matcher.ts` exports:** confirmed exactly `stripZeroWidth`,
  `collapseThresholdsFor`, `buildMatcher` as named function exports (plus two
  type-only interfaces), matching the plan's "Verified facts" row.
- **`createPredicateCache()` freshness:** confirmed `runDryRun` (`dry-run.ts`)
  constructs one cache per call, and `createAutomodSubscriber`
  (`subscriber.ts`) constructs exactly one cache per subscriber instance,
  held across all `.handle()` calls — this is what makes Task 5's sequence
  test constructible at all (state must accumulate within one `runDryRun`
  call and within one subscriber instance's calls).
- **The four `mention_spam`-as-unregistered tests** are at the locations the
  plan names: `registry.test.ts` lines 27, 43/45, 112/113, and
  `reads.test.ts` lines 513–522 and 529–531. `resolveConfig`
  (`registry.ts`) checks `isRuleKind` before `PREDICATES[kind]`, confirming
  the obligation-3 premise (once all ten kinds are registered, `unknown-kind`
  is reachable but `no-predicate` is not, via any string input).
- **Guild scope (rule 2):** `WindowKey.guildId` is a first-class field in
  Task 1's interface and every window test exercises it; no bare
  `(memberId, ruleId)` key is proposed anywhere.
- **Zod/`.strict()`, no migration, no new dependency, LOGGABLE_FIELDS:** the
  three new predicates add no logger calls (consistent with `caps.ts`'s
  pattern — predicates are pure) and no schema change; Global Constraints 2–5
  cover the rest and nothing in Tasks 1–4 contradicts them.
- **PR-22 (evict, not refuse), argued directly:** the eviction is keyed off
  last-record activity per member per rule's own bounded store; a raid large
  enough to thrash the member cap requires that many distinct real Discord
  accounts posting, which is a real cost on a single-club-guild bot
  (CLAUDE.md preamble), not a cheap sybil vector. No defect found; the
  documented cost ("earliest-tracked members' windows forgotten") is the
  correct trade and the ruling's own reasoning holds under scrutiny.
