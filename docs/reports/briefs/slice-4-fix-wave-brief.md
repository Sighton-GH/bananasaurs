# Brief — Slice 4 fix wave

**Read `docs/reports/briefs/SANDBOX_RULES.md` first.** It is short, it is
binding, and it will save you turns. In particular: never read or ask for
`.env`; always give `rg` an explicit path; check gates by exit code and never
pipe one through `tail`.

Work in `/home/bryan/projects/bananasaurs/.claude/worktrees/release2-slices-3-6`
— a git worktree. Do **not** `cd` to `/home/bryan/projects/bananasaurs`.

## Your task

Fix seven findings from `docs/reports/slice-4-whole-branch-review.md`. **Read
each finding's full text there** — the summaries below are orientation, not the
spec, and the report contains the reproductions and the recommended fixes.

| Finding | One line | Severity |
| --- | --- | --- |
| CRITICAL-1 | `duplicate_message`'s buffer is sized `maxRepeats + 1` by false analogy with `rapid_spam`, so **one interleaved message defeats it at every configuration** | **CRITICAL** |
| CRITICAL-2 | its documented `minLength: 0` default makes **two captionless image posts** a match | **CRITICAL** |
| CRITICAL-3 | a windowed rule's dry-run count is wrong in **both** directions and the CLI says nothing | **CRITICAL** |
| IMPORTANT-4 | store a **hash** of the normalised text in the window, not the text — which also settles IMPORTANT-3 | IMPORTANT |
| IMPORTANT-3 | the real memory ceiling is not the one `DEFAULT_MAX_TRACKED_MEMBERS` documents | IMPORTANT |
| IMPORTANT-5 | Task 5b's two gate cases are not sufficient — add the **`messageUpdate`** case | IMPORTANT |
| IMPORTANT-6 | a spurious recompile is now a silent kill switch; warn in `EXCLUDED_FIELDS` | IMPORTANT |

**Do not fix IMPORTANT-1, IMPORTANT-2, or any MINOR.** They travel with Slice 9,
where the review screen that renders them is built, and the coordinator is
carrying them in the handoff.

## Baseline

**2304 tests / 113 files**, typecheck/lint/test all exit 0, at commit `29f1429`.
If the count drops you deleted a test and must say so.

## CRITICAL-1 — the arithmetic, and why the test could not catch it

`rapid_spam` counts **every** event in its buffer, so `maxMessages + 1` can
always hold the "one too many". `duplicate_message` counts only events whose
value matches *this* message (`countMatching`) — but `record` puts **every**
message in the same buffer. So it needs `maxRepeats + 1` events *of one text*
and is sized for `maxRepeats + 1` events *in total*. Any other message the
member posts evicts a repeat first.

The reviewer ran the built code: interleaved repeats **never fire, at any
configuration**. The evasion is typing `lol` between posts — which is also the
ordinary shape of the spam this predicate exists for.

**The doc comment at `duplicate-message.ts:88-92` asserts the false analogy as
settled reasoning. Rewrite it**, do not just change the number; a comment that
states a wrong conclusion is how this survived per-task review.

Fix as the report specifies: a separate `DEFAULT_MAX_EVENTS_PER_MEMBER`
constant beside `DEFAULT_MAX_TRACKED_MEMBERS`, and document the residual evasion
(more distinct messages between repeats than the buffer holds). **Do not put the
text or its hash in the `WindowKey`** — that would make the 500-member cap a
500-distinct-*texts* cap and put member-authored content in a cache key.

**The existing test named for this behaviour is decorative** — "does not count
different messages toward the repeat" uses three messages against a buffer of
three, so nothing is evicted and it stays green under the bug. Fix the fixture
as well as the code, and watch the new guard (`maxRepeats: 1`, sequence
`spam` / `filler` / `spam`, must match) go red first.

## CRITICAL-2 — absent content, not short content

The plan ruling that set `minLength: 0` stands: refusing to invent a floor is
right. **Matching on the *absence* of content is a different thing**, and the
ruling never considered it. An attachment-only, sticker-only or embed-only
message has `content === ''`, so `''` is recorded as the member's repeated
"text" and two captionless images match on the default config — verified against
the built code, with `snippet=""` and a case opened.

One line, before the `minLength` comparison, with a comment naming
attachment-only messages, plus a test. Do **not** change the default.

## CRITICAL-3 — model the fix on the caveat that already exists

`automodDryRunCommand` already carries `attachmentAwareness`
(`automod.ts:135-152`) because `attachment_type`'s denominator included fixtures
that could not possibly match. **That is a strictly weaker version of this
problem** and is the pattern to copy.

Both directions need saying: the corpus holds only *previously matched* messages,
so the events that built a window count are absent by construction (a working
rule reports `MISSED`), and PR-1 gives each edit its own row that the fixture
branch replays as a create (so an edited message over-counts for a rate rule).
Put the caveat in the text **and** in `data`. Also correct
`evaluate.ts:246-249`'s "conservative" claim — it is conservative for content
predicates only, and this is the load-bearing-comment failure this project keeps
hitting.

## IMPORTANT-4 and IMPORTANT-3 — one change settles both

Store a hash of the normalised text rather than the text itself. Read the
report: it makes the retention argument (the window currently holds
member-authored message text in memory, which the pruning deletion left
unaddressed) and the memory-ceiling argument together. Keep `6bbc60a`'s deletion
— it was correct on the two grounds argued.

## The rule that matters most

**Break it and watch it fail.** Fifteen decorative guards have now been found on
this project, and **one of them is in the code you are fixing** (CRITICAL-1's
test). For each fix: write or fix the guard, watch it red against current code,
then fix the code. Report for each what you broke and what failed.

## Gates

```
npm run typecheck >/dev/null 2>&1; echo "typecheck: $?"
npm run lint      >/dev/null 2>&1; echo "lint: $?"
npm run test      >/dev/null 2>&1; echo "test: $?"
```

All three must print 0. Prefer `npm run lint:fix` over calling prettier.

## Deliverable

Write detail to `docs/reports/slice-4-fix-wave-report.md`:

- What you changed per finding, with commits.
- **Every guard you watched fail**, and what went red.
- **Anything the review got wrong or incomplete** — say it plainly. Previous
  waves found real errors in their reviews twice, and both times the wave was
  right.
- Anything you chose not to change, and why.

**Return only five lines:** status per finding, commit SHAs, one-line test
summary, guards watched fail, and any concern.
