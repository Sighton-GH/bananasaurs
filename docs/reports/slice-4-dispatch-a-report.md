# Release 2, Slice 4 — Dispatch A report (Tasks 1 and 2)

Scope: Tasks 1 and 2 only, from
`docs/superpowers/plans/2026-09-03-slice-4-window-tier.md`. Tasks 3, 4, 5 are
explicitly out of scope and untouched — they belong to dispatches B and C.

## Task 1 — the bounded, guild-scoped window store

`packages/core/src/automod/window.ts` + `window.test.ts` (new).

Implemented `createWindowStore`, `WindowKey`, `MemberWindow`, `WindowStore`,
`DEFAULT_MAX_TRACKED_MEMBERS` exactly to the plan's interface. Wrote the 8
tests from the plan verbatim first, watched them fail on "no such module,"
then implemented.

**A real design bug surfaced during implementation, not just in the "break it
and watch it fail" exercise.** My first draft registered a member into the
tracked map (and ran the LRU-eviction check) inside `for()`. Hand-tracing the
plan's own eviction test against that draft showed it fails: after m1 is
evicted (map = `[m2, m3]`), the test's own next line, `store.for(key('m1'))`,
would — under that design — insert an empty placeholder for m1, which at
`maxMembers: 2` requires evicting the new least-recently-active member, which
is now **m2**, not m1. The test's following assertion (`m2`'s count is still
1) would then read 0, and go red for the wrong reason. Fixed by moving
registration/eviction into `record()` only, so a **pure read of an absent or
evicted member never costs a currently-active member their slot.** This is
documented in `createWindowStore`'s doc comment. All 8 tests pass under the
corrected design.

**Guards broken and watched fail, then restored (plan's exact three):**
1. Dropped `guildId` from the map key (`` `${key.memberId}:${key.ruleId}` ``)
   → "keeps two guilds apart even for the same member and rule" went red:
   `expected 2 to be 1`.
2. Neutralised the per-member ring-buffer trim (`if (false) { ...slice... }`)
   → "does not grow past the per-member cap" went red: `expected 50 to be 3`.
3. Neutralised the LRU eviction (`if (false) { ...delete oldest... }`) →
   "evicts the least recently active member past the member cap" went red:
   `expected 3 to be 2`.

All three restored; full suite green afterward.

No `Date.now()` anywhere in `window.ts` — every method takes `atMs` from its
caller, checked by inspection and by the dedicated "takes its clock from the
caller" test.

Committed as `7cec46c`.

## Task 2 — `mention_spam`

`packages/core/src/automod/predicates/mention-spam.ts` + `.test.ts` (new);
`registry.ts` (+1 entry).

Stateless per PR-24 — does not import `window.ts`, and the file's doc comment
says so explicitly, with the reasoning, so a reader comparing the spec's
grouping to the code doesn't conclude a window was forgotten.

Config: `{ maxMentions: number, countEveryoneAs?: number }`, `.strict()`,
`countEveryoneAs` defaulting to 5 and configurable (test: "makes
countEveryoneAs configurable rather than hard-coded"). Total = user mentions +
role mentions + (mentionsEveryone ? countEveryoneAs : 0); fires when total
exceeds `maxMentions` (strictly above, not at). `matchedOn` names the
configured threshold, never message text (ruling R-8). `trace.span` is
`undefined` — a property of the whole message.

Wrote the plan's 5 tests verbatim plus 2 of my own (`countEveryoneAs`
configurability; `.strict()` schema rejection), watched all 7 fail (no such
predicate), implemented, all green.

**Guard broken and watched fail, then restored (the plan's one):** changed the
mention count to `input.mentionedUserIds.length` only (dropping role mentions)
→ "counts user and role mentions together" went red: `expected undefined to
be defined`. Restored; green again.

**A real, predicted consequence, handled the way this codebase already
handles it once.** Registering `mention_spam` in `PREDICATES` breaks the
"kind not shipped yet" placeholder tests that pointed at `mention_spam` as
their example of an unregistered kind — three in `registry.test.ts` and one in
`apps/daemon/src/automod.integration.test.ts` (a fourth site the plan named,
in `reads.test.ts`, turned out to fully mock `listUnusableAutomodRules` and
was never actually exercising the real registry, so it needed no functional
fix — updated its fixture label anyway for consistency). This is exactly what
happened once before in this repo: commit `56bd768` ("feat(automod): the caps
and emoji predicates") repointed these same four sites from `caps` to
`mention_spam` in the same commit that shipped `caps`, with the commit message
explaining why. I repointed all four from `mention_spam` to `rapid_spam` (the
next still-unregistered window-tier kind, shipping in Task 3) in the same
commit that ships `mention_spam`, following that precedent. This is a
deliberate, in-scope maintenance move on pre-existing tests that this
predicate's registration invalidates — not scope creep into Task 5's
Obligation 3, which is a different problem (there being no unregistered kind
left to point at, once all ten ship) that this repointing does not attempt to
solve.

Committed as `6dd61da`.

## Gates

`npm run typecheck && npm run lint && npm run test`, run after each task and
again at the end. Baseline was verified as 2267 tests / 109 files before any
change (matching the dispatcher's stated baseline). After both tasks: **111
files / 2282 tests, all green.** (2267 + 8 window tests + 7 mention_spam
tests = 2282; +2 files.)

**One pre-existing, unrelated lint finding, not touched.** `prettier --check`
fails on three files that were already this way at `HEAD` before either of my
commits: `packages/core/src/ops/ports.ts`,
`packages/storage/src/repos/automod-rule-lists.ts`,
`packages/storage/src/repos/automod-rule-lists.test.ts` (all long-line
wrapping, not correctness). Verified by checking `git status` was clean for
these three both before and after my commits, and that `prettier --check`
still flags them against a clean tree. Out of scope for Tasks 1-2; flagging
rather than silently fixing or silently ignoring it, since running
`npm run lint:fix` naively also reformats these and would otherwise leak
unrelated changes into this dispatch's commits (caught and reverted once
during this session).

## Handoff to dispatch B (Tasks 3, 4)

- `createWindowStore`, `DEFAULT_MAX_TRACKED_MEMBERS` are ready to import from
  `packages/core/src/automod/window.ts`.
- `registry.ts` now has 8 of 10 kinds registered (`rapid_spam` and
  `duplicate_message` remain, and are the placeholder kind the tests just
  repointed to point at — Task 3 will need to repoint them again, this time to
  `duplicate_message`, when `rapid_spam` ships, following the same pattern).
- The pre-existing 3-file prettier drift noted above is untouched and will
  still show up in a repo-wide `npm run lint` for dispatch B; it predates this
  slice.
