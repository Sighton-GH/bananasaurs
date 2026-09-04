# Brief — whole-branch review of Release 2, Slices 3+5

Work in `/home/bryan/projects/bananasaurs/.claude/worktrees/release2-slices-3-6`.
This is a git worktree. **Do not `cd` to `/home/bryan/projects/bananasaurs`.**
**Read only.** The only file you may create is your report.

## Why this review exists, and why it is not ceremony

`docs/22` prices this checkpoint from direct evidence in this repository:

- ADR 0036 exists **because** a whole-branch review of the automod slice found
  three defects that twelve individual per-task reviews had each missed —
  including a guild in dry run really deleting real members' messages.
- Slice 1's whole-branch pass found **four Important findings, every one of them
  cross-task** — an interaction between changes that were each individually
  reviewed and individually sound.
- Slice 2's found **both CRITICALs**, and neither was findable per-task. Both
  were the same shape: *a number or a screen that reads as reassuring when it is
  not.* One showed a human reviewing a moderation match almost no evidence; the
  other printed `41/300 matched · 0 false positive(s)` over a corpus where 296
  rows were unlabelled.

**So the highest-value thing you can do is look for interactions between tasks,
and for output that misleads a human.** Per-task correctness has already been
reviewed. Do not re-derive it.

## What shipped

Six new predicates completing Release 2's stateless tier, plus the storage they
needed. Nine tasks across five dispatches, 12 commits, `f6bddff..HEAD`.

| Task | What | Commit |
| --- | --- | --- |
| 1 | `automod_fixture_attachments` child table, repo changes, `PRIVACY.md` line | `d48a1c4` |
| 2 | attachments reach `PredicateInput` from a fixture as well as a live message | `cd34d0e` |
| 6 | relational `invite` allowlist + `link_domain` lists, `AutomodRule` widening, fingerprint | `84f4d9e` |
| 5 | `attachment_type` predicate, and the one-code-path gate widened | `30fee50` |
| 7 | `invite` predicate | `2f4ca8e` |
| 8 | `link_domain` predicate | `dc9933f` |
| 3 | `regex` predicate with a `node:vm` execution timeout | `9b779fc` |
| 4 | `caps` and `emoji` predicates | `56bd768` |
| 9 | four CLI commands so an operator can edit the two lists | `1963723` |

Current state: **2240 tests / 109 files** (from 2148 at the branch point, none
deleted), typecheck and lint clean. Every gate was run by the coordinator, not
taken on report.

## Read these, in this order

1. `CLAUDE.md` — the hard rules. They override everything.
2. **`docs/reports/slices-3-5-branch.diff.txt`** — the whole diff, generated
   once, excluding `docs/` and `drizzle/meta/`. Read this rather than
   re-deriving it with git commands.
3. `docs/superpowers/plans/2026-09-02-slices-3-5-stateless-predicates.md` —
   the plan, including its **Plan rulings** (PR-10…PR-19) and its
   **Verified environment facts** table.
4. `docs/reports/release2-slices-1-6-ledger.md` — the execution log, R-1…R-15,
   OD-1…OD-3, and every finding from this slice's dispatches. **This is where
   the coordinator's own mistakes are recorded; read them so you do not spend
   effort re-finding them.**
5. `docs/reports/release2-slices-3-5-handoff.md` — the four obligations.
6. `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`
   §3 Phase 2 and §4's gates.

## Specific things to check, in priority order

### 1. Cross-task interactions — the highest-value target

Every task was reviewed alone. Nobody has looked at how they combine. Examples
of the shape (not an exhaustive list — find your own):

- `AutomodRule` gained two fields in Task 6, and Tasks 7–8 read them. Does
  anything **construct** an `AutomodRule` that does not go through `hydrate`?
  If so, it silently carries empty lists, and an `invite` rule built that way
  would fire on allowlisted codes.
- Task 1 made `attachments` required on `CaptureObservedFixtureInput`. Task 2
  made it required on `FixtureRecord`. Nine unrelated call sites had to change.
  Did any of them get `attachments: []` where real data was available?
- The fingerprint is exclusion-based, so it hashes new `AutomodRule` fields
  automatically. Six predicates now read `config`. Is there any field a
  predicate's `compile` reads that the digest does **not** cover?
- `listFixtures` hydrates attachments with one `inArray` query. What happens at
  SQLite's variable limit on a large corpus?

### 2. Output that reads as reassuring when it is not

Both of Slice 2's CRITICALs were this. Concretely here:

- The four new CLI commands in `automod.ts` print text an operator acts on.
  Does any of them report success in a way that overstates what happened —
  `already-present` rendered as if a change was made, a `no-such-rule` that
  reads like a warning rather than a failure, a list printed after a write that
  might not reflect the write?
- `MatchTrace` for the six new predicates is what Slice 9's review screen will
  render. Is any of them missing the thing a human needs to judge the match?
  `caps` and `emoji` have **no span** — is what they do carry enough?
- `attachment_type`'s snippet is a **filename**. Filenames carry personal
  information (that is OD-3's whole caveat). Does it reach anywhere it should
  not — a log line, an audit row, a config export?

### 3. The four obligations — verify, do not accept

| # | Obligation | Where |
| --- | --- | --- |
| 1 | The ReDoS gate holds | `regex.ts`, `regex.test.ts` |
| 2 | An allowlist edit reaches the fingerprint | `fingerprint.ts`, and Task 9's end-to-end test |
| 3 | The one-code-path gate reaches a second field | `dry-run.test.ts` |
| 4 | No decorative guards | everywhere |

The coordinator watched each of the first three fail personally and recorded
exactly how in the ledger. **Your job is not to repeat those experiments — it is
to ask whether they prove what they claim.** In particular:

- `regex`'s timeout is `node:vm`. **Is 25 ms per evaluation actually
  survivable** on the subscriber's synchronous path when several rules and a
  busy channel combine? And is there any path where a `regex` rule's throw
  escapes `evaluateRule`'s catch and reaches the gateway handler?
- Task 9's end-to-end test reuses one predicate cache. Does anything **else** in
  the suite create a fresh cache where reuse was the point?

### 4. Hard rules

One line each, and say which you actually checked:

- every new query signature takes an explicit guild scope (rule 2);
- every boundary — JSON config column, CLI input, model output — passes a Zod
  validator (rule 3);
- nothing new reaches a log, config export or diagnostics bundle that
  `LOGGABLE_FIELDS` has not been extended to permit (rule 4);
- no provider call, and nothing here degrades if every provider is unreachable
  (rule 1);
- no new outbound network destination — `invite` must not resolve codes,
  `link_domain` must not do DNS (rule 8);
- no new dependency (there should be none — `node:vm` and `Intl.Segmenter` ship
  with Node 22);
- every new Discord side effect has a durable idempotency key (rule 6) — note
  that this slice adds **no** new Discord side effects, so say so rather than
  inventing one.

### 5. Two things the coordinator already knows are imperfect

Do not spend effort rediscovering these; do say if they are worse than recorded:

- **`invite`'s `last_matched_at` is deliberately not implemented** (PR-14).
  Deferred to Slice 9 because populating it needs either a hot-path database
  write or a widened predicate return type. A plan reviewer independently
  confirmed no third option exists.
- **Task 6 shipped without the dedicated test file its own plan named.** Four of
  its six repository functions had no coverage until Task 9's commands called
  them. Assess whether that coverage is now genuinely adequate.

## Things that will bite you

- **`grep` returns false negatives in this sandbox.** Use `rg` with an explicit
  path, or `awk '/pattern/{print FILENAME": "FNR": "$0}'`. A `grep` that finds
  nothing is not evidence. Do not request `.env` or any credential file.
- **Comments in this codebase are load-bearing claims.** Several assert measured
  library behaviour. If a comment says a library behaves a certain way, checking
  it against `node_modules` is in scope and welcome — two factual errors were
  corrected in Slice 2 that predated it, one already propagated into new files.
- The plan's **Verified environment facts** table was measured on this machine.
  Do not re-derive it; do flag anything in the *code* that contradicts it.

## Deliverable

Write to `docs/reports/slices-3-5-whole-branch-review.md`:

- **Verdict:** `SHIP`, `SHIP-WITH-FIXES`, or `DO-NOT-SHIP`.
- **Findings**, each as `CRITICAL` / `IMPORTANT` / `MINOR`, with: file and line,
  what is wrong, the concrete failure it causes, and the fix. Order by severity.
  For a cross-task finding, name **both** tasks it spans.
- **Decorative guards** — tests that would stay green against the bug they name.
- **Verified clean** — what you checked and found correct, explicitly. A
  reviewer who reports only problems leaves the coordinator unable to tell
  "checked and fine" from "not checked". This section is as valuable as the
  findings.
- **The hard-rules checklist**, one line each.

**Return to the coordinator only:** the verdict, counts by severity, the single
most serious finding in three sentences, and the report path. Five lines.
Everything else goes in the file.
