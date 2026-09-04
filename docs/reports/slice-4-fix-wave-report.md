# Slice 4 fix wave — report

Fixes seven findings from `docs/reports/slice-4-whole-branch-review.md`:
CRITICAL-1, CRITICAL-2, CRITICAL-3, IMPORTANT-3, IMPORTANT-4, IMPORTANT-5,
IMPORTANT-6. IMPORTANT-1, IMPORTANT-2 and all MINORs were left untouched, per
the brief — they travel with Slice 9.

Baseline: 2304 tests / 113 files at `29f1429`, typecheck/lint/test all exit 0.
Final: **2310 tests / 113 files**, typecheck/lint/test all exit 0. Six tests
added, none deleted.

## CRITICAL-1 — `duplicate_message` defeated by one interleaved message

**Fixed.** Commit `bc4b7aa`.

`window.ts` gained `DEFAULT_MAX_EVENTS_PER_MEMBER = 50`, decoupled from
`maxRepeats`, with a doc comment stating why `rapid_spam`'s
`maxMessages + 1` sizing does not carry over (`rapid_spam` counts every event
in its buffer via `countWithin`; `duplicate_message` counts only events
matching one text via `countMatching`, but `record` puts every message into
the same buffer — so a buffer sized off the threshold holds enough events in
total but not enough of one text).

`duplicate-message.ts`'s `compile` now uses `DEFAULT_MAX_EVENTS_PER_MEMBER`
instead of `config.maxRepeats + 1`. The doc comment above the predicate was
rewritten (not just the number) to state the real reasoning and the residual
evasion this leaves: more than `DEFAULT_MAX_EVENTS_PER_MEMBER` distinct
messages between two repeats will still evict the earlier one. As instructed,
the normalised text (or its hash) was **not** added to `WindowKey`.

The existing decorative test ("does not count different messages toward the
repeat" — three messages against a buffer of three, so nothing is evicted)
was left in place (it still asserts something true and harmless) and a new
test was added beside it: `maxRepeats: 1`, sequence `spam` / `filler` / `spam`,
asserting the third message matches. Watched red against the unmodified
code (see "Guards watched failing" below), then green after the fix.

## CRITICAL-2 — absent content matches on the default config

**Fixed.** Commit `bc4b7aa`.

Added `if (normalised.length === 0) return undefined;` in
`duplicate-message.ts`, before the `minLength` comparison, with a comment
naming attachment-only/sticker-only/embed-only messages and citing
`events.ts`'s `?? undefined` mapping as the mechanism. `minLength`'s default
of `0` is untouched, per the brief. New test: two captionless
(`content: ''`) messages on the default config (`maxRepeats: 1`, no
`minLength`), asserting neither matches.

## CRITICAL-3 — windowed dry-run count wrong in both directions, CLI silent

**Fixed.** Commit `606e3ac`.

`ops/commands/automod.ts` gained `WindowedCorpusCaveat` (modelled on the
existing `AttachmentAwareness`), computed for `rapid_spam` and
`duplicate_message` on every branch (mirrors `attachmentAwareness`'s "computed
even when abandoned/empty" treatment) and carried in `data` as
`windowedCorpusCaveat: { editedMessageRows } | null`. `editedMessageRows`
counts observed-fixture rows that share a message id with another row in the
corpus — PR-1's per-edit row, made visible as the over-report term. A text
line is printed beside the summary stating both directions: the corpus holds
only previously-matched messages (under-report; a MISSED is expected, not a
defect), and the named row count is the over-report term.

`evaluate.ts`'s comment on the fixture branch's hard-coded
`eventKind: 'messageCreate'` was corrected: "conservative" holds for content
predicates only, not for the window tier, where PR-1's per-edit rows make it
an over-count. Two new tests in `automod.test.ts`: the caveat's presence (with
the exact `editedMessageRows` count) for a windowed kind, and its absence
(`null`, no caveat text) for a non-windowed kind. Both watched red against the
unmodified command.

## IMPORTANT-3 / IMPORTANT-4 — memory ceiling and retention, one change

**Fixed together, as the brief specifies.** Commit `bc4b7aa`.

`duplicate-message.ts` now stores `sha256(normalised).slice(0, 16)` in the
window instead of the normalised text (`hashNormalised`). `countMatching` only
ever tests equality, so behaviour is unchanged (verified — all existing
behavioural tests pass unmodified). This caps memory per event at a small
constant regardless of message length (settling IMPORTANT-3's ceiling for
this predicate) and means no member-authored text sits in process memory with
no time bound (IMPORTANT-4's retention gap left open by `6bbc60a`'s pruning
deletion). The reasoning is recorded in `hashNormalised`'s own doc comment,
per the brief's "record the reasoning where the deletion is recorded" —
`window.ts`'s pruning-deletion comment block was left as written (still
correct on the two grounds it argues) and the third ground now lives beside
the fix that closes it, with a cross-reference.

`window.ts`'s `DEFAULT_MAX_TRACKED_MEMBERS` comment was rewritten to state the
real ceiling as a product — `(rules) × DEFAULT_MAX_TRACKED_MEMBERS ×
(per-rule per-member cap) × (bytes per event)` — rather than assuming "one
small ring buffer each" for both predicates.

No new guard for these two: they are a memory/retention property, not a
verdict-changing one, and the brief's own analysis (echoing the review) says
no test can observe the difference. Behavioural coverage is the full
`duplicate-message.test.ts` suite passing unchanged after the hash swap.

## IMPORTANT-5 — Task 5b's two gate cases insufficient

**Fixed.** Commit `e93ecc7`.

Added two cases to `dry-run.test.ts`:

- **Case C** (the one named "important"): a live sequence of
  `messageCreate` → `messageUpdate` (same message, unchanged content, so
  PR-1's fixture id coincides and it is present once in the corpus) →
  `messageCreate`, asserting the live and replayed `rapid_spam` match counts
  agree.
- **Case D**: extends the differential trace comparison (previously
  `rapid_spam`-only) to `duplicate_message`, the predicate that exercises
  `countMatching` and the value half of the store — code the gate never
  reached before.

Not done: a case for the handwritten-fixture author collapse or the
`maxMembers` eviction divergence (both named in the finding as further gaps).
The brief scoped this finding to "the third case (`messageUpdate`)" plus
extending one case to `duplicate_message` with a trace comparison — both are
done; the other two divergences the finding names are left for whoever picks
up IMPORTANT-5's remaining scope, since the brief did not ask for them and
they were not in the seven findings to fix.

## IMPORTANT-6 — spurious recompile is now a silent kill switch

**Fixed (documentation only).** Commit `957e5cb`.

Added a paragraph to `fingerprint.ts`'s `EXCLUDED_FIELDS` comment stating the
new hazard since Slice 4 (a field that changes with traffic, not
configuration, now resets a windowed rule's window on every message if not
excluded) and naming PR-14's `last_matched_at` as the concrete case. Added a
note to the ledger's PR-14 row for whoever builds it in Slice 9.

No test was added: `last_matched_at` does not exist on `AutomodRule` yet, so
there is nothing to construct a fingerprint-stability guard against (the
brief itself says this test is "to be written when the field arrives").

## Guards watched failing

- **CRITICAL-1**: new `duplicate-message.test.ts` case (`spam`/`filler`/`spam`,
  `maxRepeats: 1`) — red against the unmodified buffer sizing, green after.
- **CRITICAL-2**: new `duplicate-message.test.ts` case (two captionless
  messages, default config) — red against the unmodified `minLength` check,
  green after.
- **CRITICAL-3**: two new `automod.test.ts` cases (caveat present for
  `rapid_spam`, absent for `keyword_filter`) — both red against the unmodified
  command, green after.
- **IMPORTANT-5, Case C**: temporarily removed `rapid-spam.ts`'s
  `if (input.eventKind !== 'messageCreate') return undefined;` guard (replaced
  with `if (false)`). Re-ran `dry-run.test.ts`: **exactly Case C** went red (17
  passed, 1 failed); reverted, all green again.
- **IMPORTANT-5, Case D**: temporarily moved `subscriber.ts`'s
  `predicateCache` construction from `createAutomodSubscriber`'s closure into
  `handle()` (a fresh cache per message, bypassing the instance-held one).
  Re-ran `dry-run.test.ts`: **Case A, Case C, and Case D** went red (15
  passed, 3 failed) — confirming Case D catches the same bypassed-cache class
  of bug for `duplicate_message` that Case A already caught for `rapid_spam`.
  Reverted, all green again.

Both injected bugs were reverted immediately after observing the failure;
neither is present in any committed diff (verified: `git status` clean of
`rapid-spam.ts`/`subscriber.ts` changes after commit `bc4b7aa`, and the final
gate run below is against the reverted tree).

## Where the review's own analysis needed a correction, or was incomplete

Nothing found. Re-derived each finding's reproduction independently (read
`window.ts`, `duplicate-message.ts`, `rapid-spam.ts`, `evaluate.ts`,
`dry-run.ts`, `automod.ts`, `automod-fixtures.ts`, `fingerprint.ts` and their
tests before touching anything) and every claim held: the interleaved-repeat
arithmetic, the empty-string match, the corpus's two-directional bias, the
retention gap left by `6bbc60a`, the `messageUpdate` blind spot, and the
recompile hazard were all exactly as described, confirmed by watching guards
fail before fixing.

## Chosen not to change

- **The decorative test named in CRITICAL-1** ("does not count different
  messages toward the repeat", three messages against a buffer of three) was
  left in the suite rather than deleted. It still asserts a true, harmless
  fact about the fixed implementation; deleting it would have lowered the
  test count without cause. The brief's "fix the fixture" was read as "add a
  fixture that actually exercises the branch," which the new interleaved case
  does; the old one is now redundant but not wrong.
- **IMPORTANT-5's two other named gaps** (handwritten-fixture author collapse,
  `maxMembers` eviction divergence) — not in the seven findings the brief
  scoped, left for a future pass.
- **IMPORTANT-1, IMPORTANT-2, all MINORs** — explicitly out of scope per the
  brief; not touched.

## Final gates

```
npm run typecheck  → 0
npm run lint       → 0
npm run test       → 0   (2310 tests / 113 files)
```

## Commits

1. `bc4b7aa` — fix(automod): decouple duplicate_message's buffer from its
   threshold, and reject absent content (CRITICAL-1, CRITICAL-2, IMPORTANT-3,
   IMPORTANT-4)
2. `606e3ac` — fix(automod): caveat a windowed rule's dry-run count in both
   directions (CRITICAL-3)
3. `e93ecc7` — test(automod): close the differential gate's messageUpdate and
   duplicate_message gaps (IMPORTANT-5)
4. `957e5cb` — docs(automod): warn EXCLUDED_FIELDS about fields that change
   with traffic (IMPORTANT-6)
