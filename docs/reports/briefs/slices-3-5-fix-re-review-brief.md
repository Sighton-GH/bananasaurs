# Brief — re-review of the Slices 3+5 fix waves

Work in `/home/bryan/projects/bananasaurs/.claude/worktrees/release2-slices-3-6`.
This is a git worktree. **Do not `cd` to `/home/bryan/projects/bananasaurs`.**
**Read only.** The only file you may create is your report.

## Why this pass exists

**Fixes are not self-verifying.** Slice 2's re-review caught a defect *in the fix
wave itself* that was **worse than the bug it fixed** — and it was a
placeholder-trace bug, in the same `trace.ts` code path wave A has just changed
again. That is the single most relevant precedent for what you are reading.

Your job is not to re-find the original findings. It is to answer three
questions:

1. **Does each fix actually fix what it claims?**
2. **Did any fix introduce something new** — a weakened guard, a widened
   contract, a comment that is now false?
3. **Do the two waves interact?** They ran sequentially and both edited
   `packages/core/src/ops/commands/automod.ts` and `automod.test.ts`, in
   different regions by instruction. Verify that held.

## What was fixed

The findings are in `docs/reports/slices-3-5-whole-branch-review.md`
(verdict SHIP-WITH-FIXES: 2 CRITICAL, 8 IMPORTANT, 7 MINOR).

**Wave A** — `docs/reports/slices-3-5-fix-wave-a-report.md`:

| Commit | Finding |
| --- | --- |
| `d3e1c6e` | CRITICAL-1 (dry run reported a throwing predicate as clean), IMPORTANT-5, IMPORTANT-6 |
| `5986bbd` | IMPORTANT-3 (`serialiseTrace` threw on over-long `detail` strings) |
| `9912a8e` | IMPORTANT-4 (filename in `mod_case_events`) |
| `db0e82c` | decorative guard 3 (`caps`' code-stripping test) |

**Wave B** — `docs/reports/slices-3-5-fix-wave-b-report.md`:

| Commit | Finding |
| --- | --- |
| `1ee9ad9` | CRITICAL-2 (`link_domain`'s empty-list hazard) |
| `25b0f9b` | MINOR-2 |
| `7d560d9` | IMPORTANT-1, IMPORTANT-2, IMPORTANT-7 |
| `50b10df` | decorative guard 1 (CLI suites could not fail for -1, -2, -7) |

Current state: **2265 tests / 109 files** (2240 before the waves), typecheck and
lint clean, every gate run by the coordinator.

## Read these

1. `CLAUDE.md` — the hard rules override everything.
2. **`docs/reports/slices-3-5-fix-wave.diff.txt`** — the whole fix-wave diff
   (`1963723..HEAD`), generated once. Read this rather than re-deriving it.
3. The whole-branch review, for what each finding actually said.
4. Both wave reports, **including their "Things the review got wrong or
   incomplete" sections** — wave A raised two such points and both were
   accepted.

## Specific things to check

### 1. `trace.ts` — the highest-risk change in either wave

`serialiseTrace` used to `throw` on any schema violation. It now **truncates
over-long `detail` strings** and throws on everything else. This is a
deliberate narrowing (IMPORTANT-3), approved by the coordinator.

- Is the narrowing actually as narrow as its comment claims? A non-scalar
  `detail` value, an unknown `kind`, a malformed `span` — do those all still
  throw?
- ADR 0041 §4 says the trace never carries whole-message content, and the
  schema's comment says `detail`'s `.max(120)` "is what actually makes that a
  rule rather than a hope". **Truncation instead of rejection means an
  over-long value now silently becomes a 120-character value.** Does that
  weaken the ADR's guarantee, or is truncation equally faithful to it? Argue it
  either way, but argue it.
- **A known inaccuracy to assess, not to re-find:** `matchedOn` is
  `z.string()` with **no** `.max()`, while the comment quoted above credits
  `detail`'s cap with keeping whole-message content out. Both waves noted
  `matchedOn` cannot trigger the throw. Is the *comment* now overstating its own
  coverage, and could a future predicate put message content in `matchedOn`
  unchecked? Recommend the smallest honest fix (a cap, or a corrected comment —
  note `regex`'s `matchedOn` is the configured pattern, which the config permits
  up to 1000 characters, so a naive cap would break it).

### 2. The pre-existing test wave A modified

`apps/daemon/src/automod/wiring.test.ts`'s placeholder-trace test used an
over-long `detail` string to force a throw — exactly the case that no longer
throws. It was changed to a non-scalar `detail` value with an
`as unknown as MatchTrace` cast.

- Is the guard still testing the same behaviour, or has it been narrowed to a
  case that cannot occur in production? If TypeScript prevents a predicate from
  ever producing a non-scalar `detail`, is the placeholder fallback now
  unreachable except through a cast — and if so, is the test still worth having
  or is it now decorative?

### 3. CRITICAL-1's fix — the reporting must not have a new blind spot

`DryRunReport` gained `threw` and `corpusSize`; `runDryRun` abandons after 5
throws.

- `total` now means "evaluated" and `corpusSize` means "exists". **Is every
  consumer of `total` still correct under that change?** `falsePositives`,
  `falseNegatives`, `matched` and the `agreement` tallies are all computed over
  the abandoned subset. Does any output divide by the wrong denominator, or
  present a rate over 5 fixtures as if it were over 300?
- The abandon path breaks out of the loop. Are the un-evaluated fixtures absent
  from `results`, or present with a misleading `outcome`?
- Slice 6's false-positive gate will read these numbers. Could an abandoned run
  ever be mistaken for a completed one by a *machine* reader, not just a human?

### 4. CRITICAL-2's fix — a compile refusal has consequences elsewhere

`compileRule` now returns `no-terms` for a `link_domain` rule whose configured
mode has no rows.

- `doctor`'s `listUnusableAutomodRules` should now report it. Verify that
  actually happens rather than being assumed.
- **Does anything else break when a rule that used to compile stops
  compiling?** The dry run, the subscriber's once-per-fingerprint logging, the
  four CLI commands, `seedAutomodDefaults`.
- The `invite` asymmetry (no guard, because an empty invite allowlist is
  correct and useful) is a coordinator ruling. Is the comment's reasoning sound?

### 5. IMPORTANT-4's redaction — did it lose evidence a reviewer needs?

`attachment_type`'s snippet is now `*.exe (application/x-msdownload, 4096
bytes)`-shaped and `detail.fileName` is gone. The filename remains in the
corpus.

- After flip day, captures stop for `enforce`-mode rules (plan ruling PR-2). So
  for an enforcing `attachment_type` rule the case event is **all there is**. Is
  the redacted snippet enough for a moderator handling an appeal? Say so
  plainly if you think the ruling is wrong — the coordinator will take it back
  to the owner.

### 6. Wave B's IMPORTANT-2 canonicalisation

`removeLinkDomain` now canonicalises like `addLinkDomain`.

- Are the two canonicalisations **identical**? If they drift by one character
  the bug returns silently. Is the rule in one place or two?
- `removeInviteAllowlistEntry` was also made case-insensitive while codes stay
  stored case-preserving. Does that interact correctly with the predicate, which
  lower-cases the allowlist at compile time?

### 7. Guards

Both waves claim to have watched every guard fail. **Spot-check the claims** —
for each new test, ask whether it would go red against the pre-fix code, and
name any that would not. Wave B's new round-trip tests in
`automod-rule-lists.test.ts` are the ones that matter most, because they exist
specifically to close a decorative guard.

## Things that will bite you

- **`rg` needs an explicit path** here; a bare-pattern `rg` is blocked, and
  `grep` returns false negatives. Never request `.env` or any credential file.
- **Comments in this codebase are load-bearing claims.** Two were corrected in
  this slice for asserting the wrong thing (`dry-run.ts` on the live handler,
  `link-domain.ts` on which direction an empty list fails). If a comment now
  describes behaviour that changed, that is a finding.

## Deliverable

Write to `docs/reports/slices-3-5-fix-re-review.md`:

- **Verdict:** `ADDRESSED` (every fix good, no new defects), `ADDRESSED-WITH-
  RESIDUAL` (fixes good, new issues found), or `NOT-ADDRESSED`.
- **Per finding**: `ADDRESSED` / `PARTIAL` / `NOT-ADDRESSED`, one or two lines.
- **New defects introduced by the fixes**, by severity. This is the section
  that justifies the pass.
- **Decorative guards among the new tests.**
- **Verified clean** — explicitly, so the coordinator can tell "checked" from
  "not checked".

**Return only five lines:** verdict, per-finding tally, any new defect in two
sentences, and the report path.
