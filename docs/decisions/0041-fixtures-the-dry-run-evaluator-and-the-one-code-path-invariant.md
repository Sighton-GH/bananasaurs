# 0041 — Fixtures, the dry-run evaluator, and the one-code-path invariant

Status: accepted
Date: 2026-09-01
Precedes Slice 2 of
`docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`.
Depends on ADR 0035 (the rule engine), ADR 0036 (what a case event records),
ADR 0038 (native AutoMod decisions are recorded too), ADR 0040 (the predicate
interface, and the `MatchTrace` this ADR fills in).
Constrained by `CLAUDE.md` rule 2 (guild scope), rule 3 (stored JSON is
untrusted), rule 4 (logs and exports are allowlists), and by `PRIVACY.md`.

## Context

Release 2's finish line is "every legacy automod rule has a Bananasaurs
equivalent that ran observe-only against real traffic for an acceptable period,
with an acceptable false-positive rate." Three things stop that being
measurable today.

**There is no numerator.** A match in `test` or `observe` mode writes a
`would_delete` row to `mod_case_events` and nothing else. Nobody has said
whether that match was right. A count of matches is not a false-positive rate;
it is a count.

**There is no evidence.** `mod_case_events` stores `matched_snippet` — the
substring that matched, and nothing around it. A reviewer asked "was this a
false positive?" is being shown `badword` and asked to judge a sentence they
cannot see. The `MatchTrace` ADR 0040 introduced is the other half of the
evidence, and it is currently computed and thrown away.

**There is no regression suite.** Nine more predicates are about to be written.
Each one needs something to be tested against that is not another hand-written
unit test written by the same author on the same afternoon.

And there is a fourth thing, which is why this slice comes *before* the
predicates rather than after: building the harness afterwards means nine
separate retrofits, and retrofitting a trace into nine implementations is
strictly worse than designing one and implementing against it nine times.

## Decision

### 1. A guild-scoped fixture corpus, holding whole messages

A new table, `automod_fixtures`:

| column | why |
| --- | --- |
| `guild_id`, `fixture_id` | primary key; guild scope is a partition key, not a filter (rule 2) |
| `content` | the whole message text |
| `author_id` | so a future `/forgetme` can find and delete it |
| `label` | `should_match` \| `should_not_match` \| `unlabelled` |
| `source` | `observed` \| `handwritten` |
| `note` | why a human labelled it this way; nullable |
| `created_at` | also the replay clock for the window tier (§5) |

**The owner decided the privacy shape of this table**, because it changes what
member data Bananasaurs keeps and `docs/22` reserves that class of decision.
The choice was: full message text, author id kept. Three obligations follow,
and Slice 2 does not ship without them.

1. **`PRIVACY.md` gains a retention row in the same commit as the table.** The
   policy's table currently has no line that covers this, and a policy that is
   not true is worse than no policy.
2. **`deleteObservedFixturesForMember(scope, memberId)` ships in Slice 2, with
   a test**, even though `/forgetme` is a Release 3 command (R3-10). The owner
   authorised a corpus that can be un-made; the way to keep that true is to
   build and test the un-making now, so R3-10 wires up an existing path rather
   than inventing one under time pressure.
3. **`source = 'handwritten'` rows are not member data** and `/forgetme` never
   deletes them. They are the adversarial cases the project wrote itself.

The corpus is included in `npm run backup`, which needs no code change —
backup is a whole-database snapshot (ADR 0034). Recorded so a later reviewer
asking "should this table have been excluded?" finds the answer instead of
re-opening it.

### 2. Only *matched* messages become observed fixtures

This is the load-bearing boundary of the whole slice, and it is not obvious.

A rule in `test` or `observe` that matches a message captures that message as
an `observed`, `unlabelled` fixture. **A message that no rule matched is never
captured.** Release 2 has no archive — `docs/08` puts archive ingestion in
Release 3 under a default-deny channel scope (ADR 0009) — and capturing
non-matching traffic here would build one by the back door, under a decision
the owner made about a *review corpus*.

The corpus therefore holds exactly the messages a human is being asked to
review, and nothing else. That is proportionate, and it is also sufficient:

- `should_match` cases come from reviewed true positives.
- `should_not_match` cases come from reviewed **false positives**, which are by
  definition messages that matched and should not have. This is the case the
  regression suite most needs, and it arrives free.
- Adversarial and edge cases come from handwritten fixtures.

The gap is real and stated rather than hidden: **the corpus contains no true
negatives drawn from real traffic**, so a dry run over it cannot measure how
often a rule correctly stays silent on ordinary conversation. That measurement
comes from the live observe window's match *rate* against message volume, not
from the corpus. Slice 9's review screen must not present a corpus pass as if
it were that measurement.

### 3. One code path, enforced structurally rather than promised

The spec calls this the slice's hard invariant: the dry-run evaluator and the
live subscriber must execute the same predicate code. A parallel evaluator
tests something other than production, and the entire Release 2 gate rests on
the dry run being honest.

A test that merely compares two outputs would pass on the day someone forks the
logic and keeps the behaviour identical for the cases the test happens to
cover. So the sharing is made structural:

- `predicateInputFrom(...)` builds a `PredicateInput`. The subscriber calls it
  with a `MessageEvent`; the evaluator calls it with a fixture row. There is no
  second construction site.
- `evaluateRule(cache, rule, input)` performs fingerprint lookup, compile,
  `evaluate`, and error handling, returning a match or a reason. The subscriber
  calls it. The evaluator calls it. Neither contains a copy.

The behavioural test stays as well, because structure can be refactored apart:
one fixture, run through a subscriber with fake deps and through the evaluator,
asserting an identical `PredicateMatch` including the trace. And per `docs/22`,
that guard is not trusted until it has been watched failing.

### 4. The trace is stored, not recomputed

`mod_case_events` gains a nullable `trace` JSON column, Zod-validated on read
(rule 3, the same treatment `mod_rules.config` gets in ADR 0040).

Storing rather than recomputing is forced by the timeline. Slice 9 renders the
trace of a match that happened up to two weeks earlier, and by then the rule
may have been edited — narrowed, allowlisted, retuned in response to an earlier
review. Recomputing would show what the rule would decide *today* about an old
message, which is a different question from the one the reviewer is answering,
and the difference is invisible on screen. A stored trace is the only honest
option.

**The trace never carries the whole message.** It carries what matched, where,
which normalisations ran, and predicate-specific scalars. Whole-message content
lives in `automod_fixtures` under the owner's explicit decision, and putting a
second copy in `mod_case_events` would put member content somewhere the privacy
answer did not reach.

### 5. Verdicts are their own table

`mod_match_reviews(guild_id, event_id, verdict, reviewed_by, reviewed_at,
note)`, where `verdict` is `false_positive` | `true_positive` | `unclear` and
`event_id` references `mod_case_events`.

Separate from `mod_case_events` rather than a column on it, for one reason that
matters: **a case event is a record of what happened and must never be
rewritten.** ADR 0036 exists because the subscriber was recording punishments
that had not occurred; the fix was to make the event say exactly what happened.
A verdict is a later human judgement *about* that record, made by a named
person at a known time, and possibly revised. Those are different facts with
different lifetimes, and merging them would let a review edit history.

`unclear` counts as a false positive for the Slice 6 gate. That is the spec's
decision 16, enforced there, not here — this slice only has to record the
verdict faithfully.

### 6. The dry run replays deterministically

The window tier (Slice 4) carries mutable sliding-window state on its compiled
artifact, so a dry run's result would otherwise depend on what ran before it.
Two rules make it deterministic:

- Every dry run compiles a **fresh** artifact. State never leaks between runs.
- Fixtures replay in `created_at` order, and `PredicateInput.atMs` comes from
  the fixture's own `created_at`, never from `Date.now()`.

This is also why `PredicateInput.atMs` was defined as an input in ADR 0040
rather than read from a clock inside a predicate.

### 7. A CLI review path ships now; the dashboard supersedes it

`bananasaurs automod dryrun <ruleId>` and `bananasaurs automod review` land in
this slice so false-positive review is possible from the **first day** of the
observe window, rather than only once Slice 9's screen exists. Slices 7–10 run
*during* the window; a gate that cannot be exercised until they land would mean
the first two weeks of data go unreviewed and the clock restarts.

The CLI stays afterwards as the headless path. It is invoked by a human over
SSH and returns output to that human's terminal (ADR 0013, `docs/17`).

## Consequences

- The Release 2 gate becomes measurable: Slice 6 can compute
  false-positives ÷ reviewed-matches per rule, because Slice 2 supplies both.
- Review work stops evaporating. A verdict recorded during the window is a
  labelled fixture afterwards, so the corpus grows exactly where the rules are
  weakest.
- Two migrations' worth of schema (0011: `automod_fixtures`,
  `mod_case_events.trace`, `mod_match_reviews`), all additive.
- `PRIVACY.md` changes, and the owner announces it. That is a real cost of this
  slice and is priced in, not discovered later.
- **Cost if the "only matched messages" boundary is wrong:** the corpus cannot
  measure true-negative behaviour on real traffic, and a rule that is silent
  for the wrong reason looks the same as one that is silent for the right
  reason. Mitigated by handwritten `should_not_match` fixtures and by the live
  match rate. The alternative — capturing everything — is an archive, and
  building one here would route around ADR 0009's default-deny channel scope.
- **Cost if storing the trace is wrong:** `mod_case_events` grows by a small
  JSON object per match. At club volume this is negligible, and the column is
  nullable so pre-Slice-2 rows are untouched.

## Alternatives rejected

- **A verdict column on `mod_case_events`.** Rejected: it makes a human
  judgement editable in the same row as the record of what the bot did, which
  is the property ADR 0036 was written to establish.
- **Recomputing the trace at review time.** Rejected in §4 — it answers a
  different question and looks identical on screen.
- **Fixtures as files on disk** rather than a table. Rejected: they must be
  guild-scoped (rule 2), backed up with everything else (ADR 0034), and
  reachable by `/forgetme`. A directory of JSON satisfies none of those.
- **Capturing every evaluated message as a fixture.** Rejected in §2 — that is
  archive ingestion, which Release 3 gates behind a default-deny channel scope
  the owner configures.
- **Building the review surface only in the dashboard (Slice 9).** Rejected in
  §7: the window starts on flip day and the dashboard lands during it, so the
  first fortnight would produce unreviewed data and the clock would restart.
