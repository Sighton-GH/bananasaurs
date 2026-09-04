# Re-review of the Slice 4 fix wave

Re-reviews `docs/reports/slice-4-fix-wave-report.md` against
`docs/reports/slice-4-whole-branch-review.md`'s seven findings, using the
pre-generated diff (`docs/reports/slice-4-fix-wave.diff.txt`) and the current
tree (commits `bc4b7aa`, `606e3ac`, `e93ecc7`, `957e5cb`).

**Gates re-run here:** `npm run build` (rebuilt `dist` before testing the
built code), then `typecheck` → 0, `lint` → 0, `test` → 0, **2310 tests / 113
files** — matches the fix-wave report exactly.

## Verdict: ADDRESSED-WITH-RESIDUAL

All seven findings are genuinely fixed as claimed. The fix wave also
introduced one new CRITICAL-severity defect in the very code CRITICAL-1
touched: `duplicate_message` can now **never fire at all**, under any
sequence, for any rule configured with `maxRepeats` ≥ 50 — roughly 951 of the
1,000 values the schema permits. This is not a corner case; it is a silent,
total failure of a spec-required Zod-valid configuration, of exactly the
ADR-0039 shape IMPORTANT-6 warns about, and no test in the fix wave (or the
suite) exercises `maxRepeats` above 2.

## Per-finding status

| Finding | Status | Notes |
| --- | --- | --- |
| CRITICAL-1 (interleaved evasion) | **Fixed, but see New defect #1** | Adversarial sequence I ran against the built `dist/automod/predicates/duplicate-message.js` confirms all four previously-null configs (maxRepeats 1/2/3/5) now fire under interleaving. |
| CRITICAL-2 (empty-content match) | **Fixed, verified** | Ran two captionless (`content:''`) posts against default config (`maxRepeats:1`) on built code: neither matches. Also confirmed whitespace-only content (`'   '`) is caught identically, because normalisation trims before the length-0 guard runs — no divergent behaviour between "empty" and "whitespace-only". |
| CRITICAL-3 (dry-run count wrong both ways) | **Fixed** | `WindowedCorpusCaveat` computed on every branch, gated on kind, filters `source==='observed'` correctly (verified `FixtureRecord.source: 'observed'\|'handwritten'`), and prints both directions. |
| IMPORTANT-3 (memory ceiling) | **Fixed** | Comment now states the ceiling as a product; correctly notes it no longer applies to `duplicate_message`. |
| IMPORTANT-4 (retention) | **Fixed, verified** | `normalised` (raw text) never leaves the local scope of `evaluate()` — only its `.length` reaches `detail`, and only `hashNormalised(normalised)` reaches the window store. No raw text is stored, compared, or traced anywhere. |
| IMPORTANT-5 (differential-gate gaps) | **Fixed for the named scope (messageUpdate + duplicate_message trace); the other two named gaps are explicitly left open, as scoped** | See "Deliberately left open" below. |
| IMPORTANT-6 (fingerprint kill-switch) | **Fixed (docs only, as scoped)** | `EXCLUDED_FIELDS` comment updated, ledger's PR-14 row carries the warning — confirmed present at `docs/reports/release2-slices-1-6-ledger.md:570`. No code changed, correctly — the hazardous field doesn't exist yet. |

Tally: **6 of 7 cleanly fixed, 1 fixed-but-introduces-a-new-defect.**

## New defects, by severity

**CRITICAL (new).** `duplicate_message` cannot fire for any `maxRepeats ≥ 50`
— confirmed by running the built code:

```
maxRepeats=49 consecutive-only fired=true
maxRepeats=50 consecutive-only fired=false
maxRepeats=60 consecutive-only fired=false
maxRepeats=100 consecutive-only fired=false
maxRepeats=1000 consecutive-only fired=false
```

("consecutive-only" = zero interleaving — the easiest possible case for the
rule to catch.) Root cause: the fix replaced a threshold-scaled buffer
(`config.maxRepeats + 1`, always adequate for a pure flood) with a flat
`DEFAULT_MAX_EVENTS_PER_MEMBER = 50`, without also ensuring the buffer is at
least `maxRepeats + 1`. `countMatching` can never return more than the
buffer's capacity, so once `maxRepeats ≥ maxEventsPerMember`, `count` can
never exceed `config.maxRepeats` and the predicate is dead code for that rule
— every message the member ever posts records, is capped at 50, and
`count <= config.maxRepeats` is always true. An operator who sets
`maxRepeats: 200` intending "block after 200 identical repeats in a
high-traffic channel" gets a rule that reads as enabled and configured and
never once fires, with no log line and no `doctor` entry — this is the exact
failure IMPORTANT-6's new comment describes, produced by a different
mechanism than the one that comment names.

The documented residual evasion is also imprecise in the surviving range
(`maxRepeats < 50`): the doc comment says "more than
`DEFAULT_MAX_EVENTS_PER_MEMBER` distinct messages between two repeats" evades
the rule; measured against the built code, the real cutoff is
`DEFAULT_MAX_EVENTS_PER_MEMBER - (maxRepeats + 1)` — at `maxRepeats: 1`, 49
fillers evict the earlier repeat, not 51:

```
fillerCount=48 matched=true
fillerCount=49 matched=false
```

This second point is minor on its own (off by `maxRepeats + 1`, a few
messages at low thresholds) — it is the same root cause as the CRITICAL item
above and stops mattering once that's fixed by scaling the buffer with
`maxRepeats`. Suggested fix for both: size the buffer
`Math.max(DEFAULT_MAX_EVENTS_PER_MEMBER, config.maxRepeats + 1)`, and correct
the doc comment's arithmetic once fixed.

No other new defects found. Specifically checked and clean: the hash change
(no raw-text leak, `countMatching` semantics unchanged since it only ever
tests equality), the absent-content guard's interaction with whitespace-only
content (identical to empty, because normalisation trims first), and
`rapid_spam` (still scales its buffer off `maxMessages + 1`, unaffected by
this defect's mechanism).

## Decorative guards among the new tests

None found to be decorative. Checked each by reasoning through the pre-fix
code (and, for CRITICAL-1/2, by re-deriving the exact old vs. new buffer
contents by hand):

- **CRITICAL-1's new test** (`spam`/`filler`/`spam`, `maxRepeats: 1`): under
  the old `maxRepeats + 1 = 2`-sized buffer, after `spam`,`filler` the buffer
  is `[spam, filler]` (full); the second `spam` push forces a slice to
  `[filler, spam]`, so `countMatching` for `'spam'` returns 1, not >1 — the
  test would go red against the unfixed code. Genuine.
- **CRITICAL-2's new test** (two captionless messages): under the old code
  (no length-0 guard), the first captionless message records `''` and counts
  1 (no fire, `1 <= maxRepeats(1)`); the second records a second `''` and
  counts 2, which **is** `> maxRepeats(1)` and returns a match — so
  `expect(say(2_000)).toBeUndefined()` would fail against the unfixed code.
  Genuine, and independently reproduced by me against the built code (see
  Verified clean).
- **CRITICAL-3's two new `automod.test.ts` cases**: the caveat fields and
  wording only exist in the new code path; the wave's report records watching
  both go red against the unmodified command, and the logic (`isWindowedKind`
  gate, `countEditedMessageRows`'s `source === 'observed'` filter) has no path
  by which it could pass without the fix. Not independently re-injected by me
  (time-boxed), but the code path is unambiguous — no way to construct
  `windowedCorpusCaveat` without the new code existing.
- **IMPORTANT-5 Case C/D** (`dry-run.test.ts`): the wave's report documents a
  specific bug-injection-and-revert for each (removing the
  `eventKind !== 'messageCreate'` guard reddened exactly Case C; moving the
  predicate cache into `handle()` reddened Case A, C, and D). I re-read the
  logic rather than re-injecting the bugs myself, and it is consistent with
  that account — Case C's assertion (`liveMatchedAt` sees only one fire, at
  the second create) has no way to pass if `messageUpdate` were counted, and
  Case D's `expect(replayed?.trace).toEqual(recorded.trace)` has no way to
  pass if the predicate cache were bypassed (the live and replay windows
  would diverge). Neither test's premise looked stacked in the fixture's
  favour the way `docs/22`'s prior decorative guards were.
- **The old decorative test named by CRITICAL-1** ("does not count different
  messages toward the repeat", 3 messages against a buffer of 3) was
  correctly left in place rather than deleted — it is redundant, not wrong,
  and the wave's report says so accurately.

## What was deliberately not done — IMPORTANT-5's two remaining gaps

The wave closed only the `messageUpdate` gap and the `duplicate_message`
trace gap, leaving the handwritten-fixture author collapse and the
`maxMembers` eviction divergence open, as the brief scoped it.

- **The handwritten-fixture author collapse is more dangerous than it looks.**
  `predicateInputFrom` maps every handwritten fixture's null `authorId` to the
  same literal `'fixture'`, so **any** handwritten corpus for a windowed rule
  is replayed as one member's burst regardless of what the operator intended.
  `automod dryrun --source handwritten` already exists as a command surface,
  and handwritten fixtures are exactly the tool an operator would reach for
  to test cross-member independence before flipping a windowed rule to
  enforce — e.g. "three different members each post this phrase once; that
  must not match `duplicate_message`." Today that scenario silently collapses
  to one member repeating itself three times and **matches**, with no warning
  that authorship was discarded. It takes only two handwritten rows to
  trigger, not 500 members or a raid — the ordinary, low-effort path into this
  bug is also the path the tool most wants operators to use pre-flip.
- **The `maxMembers` eviction divergence is not** more dangerous than it
  looks. It requires 500 simultaneously-tracked members in a single-guild
  club bot that `window.ts`'s own comment already documents as "far beyond a
  realistic burst" for this deployment. Real, but low-probability and already
  flagged as an accepted tradeoff (PR-22) rather than a silent gap.

## Verified clean

- **CRITICAL-1's core claim** — re-run against the rebuilt `dist`: all four
  previously-null interleaved configs (maxRepeats 1/2/3/5) now fire.
- **CRITICAL-2's core claim** — re-run against the rebuilt `dist`: two
  captionless posts no longer match on the default config; whitespace-only
  content behaves identically to empty content (both normalise to `''`
  before the guard runs), so the fix does not introduce an
  empty-vs-whitespace divergence.
- **IMPORTANT-4's raw-text claim** — read `duplicate-message.ts` end to end:
  `normalised` (the raw text) never crosses into the window store or the
  trace; only `.length` and `hashNormalised(normalised)` do.
- **`rapid_spam` is unaffected** by the new CRITICAL defect — its buffer is
  still sized `config.maxMessages + 1`, scaling correctly with its own
  threshold (confirmed in `rapid-spam.ts`).
- **`FixtureRecord.source`** is exactly `'observed' | 'handwritten'`
  (`types.ts:156`), so `countEditedMessageRows`'s filter is correctly scoped
  and cannot double-count a handwritten row.
- **The ledger note for IMPORTANT-6/PR-14** exists as claimed
  (`docs/reports/release2-slices-1-6-ledger.md:570`).
- **Gates**: rebuilt `dist` from current source, then `typecheck`/`lint`/`test`
  each checked by exit code separately — all 0, 2310/113, matching the fix
  wave's own final numbers.

**Not independently re-verified** (relied on the fix wave's own account,
reasoned through rather than re-run): the specific bug-injection/revert
transcripts for IMPORTANT-5 Case C and Case D, and CRITICAL-3's two
`automod.test.ts` cases against the literal unmodified command (time-boxed;
the code paths are unambiguous on inspection, as noted above).
