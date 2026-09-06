# Brief — Fix wave A: the dry run's reporting, and three predicate defects

Work in `/home/bryan/projects/bananasaurs/.claude/worktrees/release2-slices-3-6`.
This is a git worktree. **Do not `cd` to `/home/bryan/projects/bananasaurs`.**

## Your task

Fix **six findings** from the whole-branch review of Slices 3+5. The review is at
`docs/reports/slices-3-5-whole-branch-review.md` — **read the full text of each
finding you are fixing**; the summaries below are orientation, not the spec.

| Finding | What | Severity |
| --- | --- | --- |
| CRITICAL-1 | `runDryRun` folds `evaluateRule`'s `threw` outcome into a plain non-match, so a rule that timed out on every fixture reports as clean | **CRITICAL** |
| IMPORTANT-5 | `automod dryrun` on a pathological regex blocks the process for `fixtures × 25 ms` | IMPORTANT |
| IMPORTANT-6 | a dry run of `attachment_type` prints `0/N matched` without saying how many fixtures carry attachment metadata at all | IMPORTANT |
| IMPORTANT-3 | `attachment_type` and `link_domain` put member-controlled strings into `MatchTrace.detail`, which is capped at 120 chars and enforced by **throwing** | IMPORTANT |
| IMPORTANT-4 | a filename reaches `mod_case_events`, a record `/forgetme` does not delete — see the ruling below | IMPORTANT |
| Decorative guard 3 | `caps.test.ts`'s "ignores fenced and inline code" passes for two reasons at once | (guard) |

**Do not fix CRITICAL-2, IMPORTANT-1, IMPORTANT-2 or IMPORTANT-7.** A second
dispatch owns those, and it edits the same two files in different places
(`packages/core/src/ops/commands/automod.ts`, `automod.test.ts`). Touch only the
`automod dryrun` command and its tests in those files, never the four
list-editing commands (`invite-allow`, `invite-deny`, `domain-add`, `domain-rm`).

Also leave every MINOR alone.

## Baseline

**2240 tests / 109 files**, typecheck and lint clean, at commit `1963723`. If the
count drops you deleted a test and must say so.

## CRITICAL-1 in detail — the shape this project keeps repeating

`evaluateRule` has four outcomes and `runDryRun`
(`packages/core/src/automod/dry-run.ts:103-112`) handles three, folding `threw`
into `match === undefined`. `failure` stays `undefined`, so `usable` stays
`true`, and `DryRunReport` has no field for a throw. A `should_not_match` fixture
that *threw* is scored `agreement: 'agreed'`.

Task 3's `regex` predicate is the first that throws at evaluate time **by
design** — plan ruling PR-12 chose a throw over a silent non-match precisely
because "returning 'no match' would be silent". The dry run is the caller that
makes PR-12's argument false: it has no logger, by design.

So an operator dry-running a catastrophic pattern over 300 fixtures sees:

```
0/300 matched · 0 false positive(s) of 300 labelled · 0 missed
```

Every evaluation timed out. **This is the fourth appearance of the ADR 0039
shape on this project** — a number that reads as reassuring over a rule that is
not working — and the two guards immediately above it in `automod.ts`
(`!report.usable`, `report.total === 0`) exist to close exactly this.

**The comment in `dry-run.ts` is a load-bearing error and must be corrected, not
just worked around.** It says a throw is fine "the same way it does not end the
live handler". The live handler does not end **but it logs `'the predicate threw;
message left unmatched for this rule'` naming the rule**
(`subscriber.ts:307-317`). Rewrite that comment to say what is actually true.

**The fix:**

1. `DryRunReport` gains `readonly threw: number`, and `DryRunFixtureResult` gains
   `readonly outcome: 'ok' | 'threw'`.
2. `runDryRun` counts throws. A fixture that threw must **not** be scored
   `agreement: 'agreed'` — `'unlabelled'` is the honest value, the same choice
   the `unusable` branch already makes.
3. **Abandon the run after 5 throws** (this is IMPORTANT-5's fix too — see
   below). Report how many fixtures were evaluated versus how many exist.
4. In `automod dryrun` (`packages/core/src/ops/commands/automod.ts:39-74` and
   `:144-153`), treat `threw > 0` the way `!usable` is already treated: **do not
   print a match table under it**, and say `N of M evaluations failed (the
   predicate threw)`. Put it in `data` as well as the text.

## IMPORTANT-5 — why abandoning the run is the right fix

The live subscriber pays 25 ms per timing-out rule per message, bounded by rule
count. That is survivable. The **dry run** is not: it is fully synchronous, one
process (ADR 0006), and replays the whole corpus. 300 fixtures × 25 ms = **7.5 s
of blocked event loop** — no gateway heartbeat, no HTTP, no job worker. The
corpus has no cap and no expiry, so at ~1 700 fixtures the stall passes
Discord's heartbeat interval and forces a reconnect, which replays events
(CLAUDE.md rule 6).

Abandoning after 5 throws bounds it at ~125 ms and fixes CRITICAL-1's reporting
in the same change. Say in the report text that the run was abandoned, not that
it completed.

## IMPORTANT-3 — fix it at the producer AND at the boundary

`matchTraceSchema`'s `detail` values are `z.string().max(120)` and
`serialiseTrace` **throws** on violation (`trace.ts:54`). Filenames run to 255
characters, hostnames to 253, and in `link_domain`'s `allow` mode any host
matches, so a member chooses the value. The result is a **placeholder trace** for
every such match plus a log line blaming our own code.

Do both halves:

- **`serialiseTrace` truncates over-long `detail` strings** (with an ellipsis)
  instead of throwing, so the next predicate carrying member text inherits the
  safety rather than having to remember. Keep throwing for genuinely malformed
  traces — this is a narrowing, not a removal.
- **Truncate at the producers too**, so the stored value is deliberate rather
  than salvaged: `attachment-type.ts` and `link-domain.ts`.

## IMPORTANT-4 — the coordinator's ruling, implement exactly this

**Redact `attachment_type`'s snippet. Do not add a PRIVACY.md line.**

The reviewer offered two fixes. The choice is made, and here is the reasoning so
you do not need to relitigate it:

`attachment_type`'s `snippet` is currently the raw filename, so it lands in
`mod_case_events.matched_snippet` — a **moderation record**, which
`PRIVACY.md` says is kept as long as the server needs it and which
**`/forgetme` does not delete**. OD-3's owner approval was for the *fixture
corpus*, which has its own retention row and is reachable by `/forgetme`.
Putting filenames into moderation records is a widening the owner was never
asked about.

**And redaction is the principled answer, not merely the cautious one: this
predicate matches on content type and extension, never on the name.** The
filename was never the decision basis, so it does not belong in the enforcement
record. `trace.matchedOn` already carries the extension or content type that
actually fired.

So: `snippet` becomes a redacted form naming the **extension, declared content
type and size** — e.g. `*.exe (application/x-msdownload, 4096 bytes)` — and
`detail.fileName` is **removed**. The full filename stays in the corpus
(`automod_fixtures` + `automod_fixture_attachments`), where a human reviewing
rule quality during the observe window can see it and where `/forgetme` reaches
it.

Update the predicate's doc comment to say this and why. Add a test asserting the
snippet contains no filename stem.

## Things that will bite you

- **`rg` needs an explicit path** in this sandbox; a bare-pattern `rg` is
  blocked. `grep` returns false negatives — use `rg <pattern> <path>` or `awk`.
  Never request `.env` or any credential file.
- **Do not use backticks inside `git commit -m`** — this shell substitutes them.
- **Comments here are load-bearing claims.** CRITICAL-1 exists partly *because* a
  comment asserted something false about the live handler. If you change
  behaviour, change the comment that describes it.
- Several changes touch types consumed elsewhere (`DryRunReport`,
  `DryRunFixtureResult`). Run `npm run typecheck` early — a plan's file list is
  a lower bound, and earlier dispatches found unnamed call sites this way.

## The rule that matters most

**Break it and watch it fail.** Twelve decorative guards have been found on this
project. For each fix, write the guard first, watch it go red against the
*current* code, then fix. Specifically:

- CRITICAL-1: a dry run over a fixture set where the predicate throws must
  report `threw > 0` and must **not** print a clean summary. Watch it red first.
- IMPORTANT-3: a 200-character filename must not produce a placeholder trace.
- IMPORTANT-4: assert the snippet does not contain the filename stem.
- Decorative guard 3: `caps.test.ts`'s code-stripping test currently passes for
  two reasons at once (the code is stripped **and** the remaining prose scores
  0.0). Add the assertion that pins the intent — a shout *outside* a fence that
  still fires, so the test distinguishes stripping from the ratio.

## Gates

```
npm run typecheck && npm run lint && npm run test
```

All three clean before you report done. **No completion claim on code you have
not run.**

## Deliverable

Write detail to `docs/reports/slices-3-5-fix-wave-a-report.md`:

- What you changed per finding, and the commit for each (one commit per finding
  is fine, or group the two dry-run ones).
- **Every guard you watched fail**: what you broke, what went red, that you
  restored it.
- Anything in the review's description of these six findings that you found
  **wrong or incomplete** — say so plainly.
- Anything you chose not to change, and why.

**Return only five lines:** status per finding, commit SHAs, one-line test
summary, guards watched fail, and any concern.
