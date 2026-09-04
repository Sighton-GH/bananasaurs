# Brief — whole-branch review of Release 2, Slice 4 (the window tier)

Work in `/home/bryan/projects/bananasaurs/.claude/worktrees/release2-slices-3-6`.
A git worktree — do **not** `cd` to `/home/bryan/projects/bananasaurs`.
**Read only.** The only file you may create is your report.

**Never read `.env` or any credential file, and never ask to.** `rg` needs an
explicit path (a bare-pattern `rg` is refused for that reason and the refusal is
correct); `grep` returns false negatives here; `jq` is not installed.

## Why this pass exists

Every previous whole-branch review on this project found defects that per-task
review structurally could not:

- Slice 1: four Important findings, **every one cross-task**.
- Slice 2: both CRITICALs, neither findable per-task. Both were the same shape —
  *a number or a screen that reads as reassuring when it is not.*
- Slice 3+5: both CRITICALs again, both cross-task, both traceable to a
  coordinator ruling or comment that was wrong rather than to sloppy code.

**So look for interactions between tasks, and for output that misleads a human.**
Per-task correctness has been reviewed already; do not re-derive it.

## What shipped

**The last three predicates, and the first state any predicate here has
carried.** All ten kinds `mod_rules_kind` permits now have an implementation.

| Task | What | Commit |
| --- | --- | --- |
| 1 | `window.ts` — bounded, guild-scoped sliding-window store | `7cec46c` |
| 2 | `mention_spam` — deliberately **stateless** (PR-24) | `6dd61da` |
| 5a | the registry seam, so `no-predicate` stays testable | `d906bcc` |
| 3 | `rapid_spam` | `eaf638b` |
| 4 | `duplicate_message` | `3a43ee1` |
| — | deleted the window's age-based pruning (no observable effect) | `6bbc60a` |
| 5b | closed the one-code-path gate's two blind spots | `81466d7` |

**2304 tests / 113 files**, typecheck/lint/test all exit 0, every gate run by the
coordinator by exit code.

## Read these, in this order

1. `CLAUDE.md` — the hard rules override everything.
2. **`docs/reports/slice-4-branch.diff.txt`** — the whole diff, generated once.
   Read this rather than re-deriving it.
3. `docs/superpowers/plans/2026-09-03-slice-4-window-tier.md` — especially
   **rulings PR-20…PR-25**.
4. `docs/reports/release2-slices-1-6-ledger.md` — the Slice 4 section carries the
   rulings, E-5, and the pruning deletion. **The coordinator's own mistakes are
   recorded there; read them so you do not spend effort re-finding them.**
5. `docs/reports/release2-slice-4-handoff.md` — the four obligations.

## Specific things to check, in priority order

### 1. Cross-task interactions — the highest-value target

- **Window state lives on the compiled artifact** (PR-21). The subscriber holds
  one cache per instance, keyed with a content fingerprint. So: does anything
  cause an *unintended* recompile that silently resets a window mid-burst? A
  `mod_rules` row touched by an unrelated write, a fingerprint that includes
  something volatile, a rule read twice per message?
- **Two predicates now build their own store** from the same
  `DEFAULT_MAX_TRACKED_MEMBERS`. If one guild runs several windowed rules, how
  many stores exist and what is the real memory ceiling? Is it what the plan
  claims?
- **`rapid_spam` and `duplicate_message` both ignore `messageUpdate`** (PR-23).
  Is that consistent with what the subscriber does *around* them — could an edit
  still open a case through another path, so the pair disagree about whether an
  edit is an event?
- **The registry seam (5a)** changed `compileRule`'s internals and added
  `compileRuleWith`. Verify the production path still goes through the shipped
  registry and that nothing can accidentally call the seam with an empty one.

### 2. Output that misleads a human

- `MatchTrace` for all three predicates is what Slice 9's review screen renders.
  `rapid_spam` and `duplicate_message` have **no span** — is what they carry
  enough for a human to agree or disagree with the match?
- **Does any trace carry member-authored content?** ADR 0041 §4 forbids
  whole-message content in a trace. `duplicate_message` matches *on* content, so
  it is the one predicate most likely to leak it into `matchedOn` or `detail`.
  `matchedOn` is `z.string()` with **no** `.max()`, so it is each producer's
  responsibility — check all three.
- A dry run of a windowed rule replays a corpus in `created_at` order. Does the
  reported count mean what an operator would assume, given the corpus is a
  *filtered* set of matched messages rather than a complete message history? A
  rate computed over a corpus that only contains matches is not a rate over
  traffic.

### 3. The obligations — verify, do not accept

The coordinator watched these fail personally and recorded how. **Do not repeat
the experiments — ask whether they prove what they claim.**

- **Obligation 1 (Task 5b).** Case A is a clustered burst matching on both
  paths; Case B is spread beyond the window and matches on neither. Corrupting
  the fixture clock reddens B only; a per-`handle` throwaway cache reddens A
  only. **Is that pair actually sufficient?** Name any *third* divergence that
  window state makes possible and neither case would catch.
- **PR-25's claim** that a differential gate cannot see a symmetric bug: is it
  stated correctly in the code, and does any test in the suite implicitly rely
  on the opposite?
- **Obligation 3 (Task 5a).** No test should now depend on a real kind being
  unregistered. Verify with `rg`, and check `automod.integration.test.ts`, which
  was moved to `no-terms` because production wiring has no injection point — is
  that substitution sound, or does it now test something different from what its
  name says?

### 4. The pruning deletion (`6bbc60a`) — was it right?

The coordinator deleted the window's age-based pruning after an implementer
reported its guard could not be made to fail. The argument: `countWithin`
filters by window on every call so correctness never depended on it, and
`maxEventsPerMember` bounds memory on every `record`.

**Argue with this.** Is there any input sequence where the deletion changes
observable behaviour, or where unbounded *time* between events matters even
though the *count* is capped? If the deletion was wrong, say so plainly.

### 5. Hard rules

One line each, and say which you actually checked: guild scope on every new key
and query signature (rule 2, and it names cache keys explicitly — the window key
is a cache key); every boundary Zod-validated (rule 3); nothing new logged
without a `LOGGABLE_FIELDS` entry (rule 4); no provider call (rule 1); no new
outbound destination (rule 8); no new dependency; and note that this slice adds
**no** new Discord side effect, so rule 6 owes nothing — state that rather than
inventing one.

### 6. Known and deliberate — do not re-find

- **PR-20:** `duplicate_message` does *not* reuse the keyword matcher's
  normalisation. Two verified obstacles; a plan reviewer confirmed no third
  option. Assess the normaliser it ships instead on its own merits.
- **PR-24:** `mention_spam` is stateless despite the spec's tier grouping.
- **`invite`'s `last_matched_at`** is deferred to Slice 9 (PR-14).

## Deliverable

Write to `docs/reports/slice-4-whole-branch-review.md`:

- **Verdict:** `SHIP`, `SHIP-WITH-FIXES`, or `DO-NOT-SHIP`.
- **Findings** as `CRITICAL` / `IMPORTANT` / `MINOR`, ordered by severity, each
  with file and line, what is wrong, the concrete failure it causes, and the fix.
  For a cross-task finding, name **both** tasks it spans.
- **Decorative guards** — tests that would stay green against the bug they name.
- **Verified clean** — explicitly, so the coordinator can tell "checked and fine"
  from "not checked". This section is as valuable as the findings.
- **The hard-rules checklist**, one line each.

**Return only five lines:** the verdict, counts by severity, the single most
serious finding in three sentences, and the report path.
