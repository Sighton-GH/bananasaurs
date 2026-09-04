**Status:** READY. Slices 0, 1, 2, 3 and 5 are merged and green (**2,267 tests / 109 files**). Seven of the ten predicate kinds have an implementation. This handoff covers **Slice 4, the window tier** — the last three predicates — and then Slice 6, the release gate, as its own unit. **Stop at flip day.**

# Release 2, Slice 4 — the window tier

## Contents

- [Actions the owner owes](#actions-the-owner-owes)
- [What you are building](#what-you-are-building)
- [Obligations that bind this slice](#obligations-that-bind-this-slice)
- [Settled — do not re-litigate](#settled--do-not-re-litigate)
- [Things that will bite you](#things-that-will-bite-you)
- [Protocol](#protocol)

## Actions the owner owes

None block the work. Items 1–3 must happen before flip day.

1. **Announce the `PRIVACY.md` changes.** Two now: Slice 2's fixture-corpus
   retention row, and Slice 3+5's attachment line (OD-3). One announcement
   covers both.
2. **Do not publish `PRIVACY.md` before `/forgetme` exists.** It says
   "`/forgetme` removes yours"; the storage function ships and is tested, the
   Discord command is Release 3 (R3-10). Both land in the same R3 item, so the
   row is true on the day anyone can read it. Publishing early is the one way
   it becomes false.
3. **`docs/RELEASE1_CONFIG.md` is still blank** (`STATE.md` "Still open" 3).
   Does not block coding; must exist before real-guild cutover.
4. **Two decisions the owner may reverse with one word**, both taken
   conservatively so nothing stalled:
   - **OD-3 could still narrow.** Storing only the attachment *extension*, type
     and size — dropping the filename — would let `attachment_type` replay just
     as well. The filename earns its place only if you want to see it while
     reviewing a match. Currently stored.
   - **`attachment_type`'s case-event snippet is redacted** to extension,
     content type and size, so a filename does **not** reach
     `mod_case_events` — a record `/forgetme` does not delete and which OD-3's
     approval did not cover. The filename stays in the corpus, where
     `/forgetme` reaches it. Say the word if you would rather the moderation
     record named the file; that needs a `PRIVACY.md` line and an announcement.
5. **`invite`'s `last_matched_at` was deferred to Slice 9** (plan ruling
   PR-14) — a spec-named feature that moved, so you should know rather than
   discover it. Populating it needs either a database write on the predicate's
   hot path or a widened return type for all ten predicates. A reviewer
   searched for a third option and found none.

## What you are building

Three predicates, all of which carry **sliding-window state** — the first on
this project to carry any state at all:

| Kind | Notes |
| --- | --- |
| `mention_spam` | Counts mentions on **one** message. Reads `mentionedUserIds`, `mentionedRoleIds`, `mentionsEveryone` — all already on `PredicateInput` (ruling R-3). Arguably stateless; grouped here because the spec does. |
| `rapid_spam` | Messages per member per window. Needs the clock and the counter. |
| `duplicate_message` | The same normalised content repeated within a window. |

**In-memory counters, keyed `(guildId, memberId, ruleId)`, as a bounded ring
buffer with an eviction sweep** — an owner decision, recorded in the spec with
its reasoning. **A restart resets the window, and that is accepted and
documented.** The escalation counter is durable in `mod_cases` either way, so a
restart never loses accrued violations, only the sub-minute rate window; and a
spammer whose burst is interrupted by a restart trips on their next one. The
alternative costs a write per evaluated message per windowed rule — up to three
per message — on the hot path of a single-writer SQLite database that gains
archive ingestion in Release 3 (`REVIEW.md` §C12 warns about exactly that).

`duplicate_message`'s normalisation **is the same code the keyword matcher
uses, not a second copy** (spec §3). Find it and call it.

**No migration is needed.** All three kinds are already permitted by
`mod_rules_kind`'s CHECK (widened once in Slice 1, ruling R-2), and all three
predicates' configuration is scalar — thresholds and window lengths — so it
lives in `mod_rules.config` (ADR 0040 §3). If you think you need a schema
change, stop and say so.

## Obligations that bind this slice

| # | Obligation |
| --- | --- |
| 1 | **Extend the *behavioural* one-code-path gate.** This is the obligation Slice 3+5 could only half-discharge, and Slice 4 is where it comes due in full. |
| 2 | **The window key is guild-scoped in its own right** (CLAUDE.md rule 2 names cache keys explicitly). A bare `(memberId, ruleId)` key is a bug even if every current caller passes a guild. |
| 3 | **Decide what to do about `no-predicate`** — see below. Slice 4 makes it unreachable. |
| 4 | **Break it and watch it fail** in every brief. **Fourteen** decorative guards have been found on this project. |

### Obligation 1, in detail — this is the important one

The one-code-path gate (ADR 0041 §3) asserts the dry run and the live
subscriber produce identical matches. It is a **behavioural** comparison, so it
only detects divergence in fields a shipped predicate actually reads. Slice 3+5
widened it to `attachments` when `attachment_type` became the first predicate
to read a second field — and watched it fail to prove the widening was real.

**Two divergences are still invisible, and both go live in this slice:**

| Divergence | Caught today? | Made live by |
| --- | --- | --- |
| Wrong `atMs` | ❌ no — nothing reads the clock yet | `rapid_spam`, `duplicate_message` |
| Predicate cache bypassed entirely | ❌ no — no observable difference with stateless predicates | all three (state lives on the compiled artifact) |

So the gate must grow a case that **compares a sequence** whose result depends
on `atMs` *and* on the compiled artifact's accumulated state — not a single
message. Watch it fail by (a) perturbing `atMs` in one path and (b) making the
subscriber compile a fresh artifact per message. If either leaves the gate
green, the guarantee is still narrower than it reads.

**The structural half is already in place** and must not regress:
`dry-run.test.ts` asserts at source level that `dry-run.ts` builds no
`PredicateInput` of its own and calls `predicateInputFrom`/`evaluateRule`.

### Obligation 3 — Slice 4 makes `no-predicate` unreachable

`compileRule` reports `no-predicate` for a permitted kind whose predicate has
not shipped. **After this slice, all ten kinds have one**, and
`resolveConfig` checks `isRuleKind` *first*, so a made-up string yields
`unknown-kind`, never `no-predicate`. No cast can reach it.

Four tests currently depend on `'mention_spam'` being unregistered
(`predicates/registry.test.ts` ×3, `ops/commands/reads.test.ts`) — they were
repointed there from `'caps'` when Slice 5 shipped, which is the second time
this has happened. **Using a real-but-unshipped kind as a stand-in for
"unregistered" expires on a schedule the test never mentions.**

Choose deliberately, and record which:

1. **Give the registry a test seam** — an injectable `PREDICATES`, or a
   `predicateFor` that can be asked about an empty registry — keeping
   `no-predicate` genuinely tested; or
2. **Delete those assertions and record that the branch is unreachable except
   via a future eleventh kind.** Keep the branch: ruling R-2 widened the SQL
   CHECK to all ten kinds ahead of the predicates precisely so an unshipped
   kind was inert and loud, and an eleventh will arrive the same way.

`doctor`'s unusable-rules check keeps its teeth either way —
`invalid-config`, `compile-failed` and R-12's `no-terms` all stay reachable.

## Settled — do not re-litigate

- **The predicate interface** (ADR 0040): two-stage `compile`/`evaluate`,
  scalar config as Zod-validated JSON in `mod_rules.config`, list-shaped data
  relational. **If you find yourself editing the subscriber or the evaluator to
  make a predicate fit, stop and say so** — that is the abstraction failing and
  it is worth a ruling, not a workaround. It held for all six of Slices 3+5.
- **The one-code-path invariant** (ADR 0041 §3): the dry run and the live
  subscriber call `predicateInputFrom` and `evaluateRule` and nothing else.
- **A rule that cannot compile is inert and loud** (ADR 0040 §4): skipped,
  logged once per fingerprint, reported by `doctor`. **"0 matches" must never
  read like a clean rule** — that confusion has now cost this project four
  times, most recently as CRITICAL-1 of the Slice 3+5 review, where a regex
  that timed out on every fixture reported `0/300 matched · 0 false
  positive(s)`.
- **A fresh `createPredicateCache()` per dry run** (ADR 0041 §6). This exists
  *for* this slice: window state on a reused artifact would make a run's result
  depend on what ran before it. Do not "optimise" it away.
- **Ten plan rulings PR-10…PR-19** from Slices 3+5, in the ledger with costs if
  wrong.
- **The false-positive thresholds** (`STATE.md` "Still open" 7): 5% for
  delete-only rules, zero for rules feeding the escalation counter, 20-match
  minimum. `docs/08` says the window tier is exactly the set that genuinely
  needs the full two-week floor. **If a rule fails its bar, narrow the rule; do
  not move the bar.**

## Things that will bite you

- **A worktree's gates are meaningless without `node_modules/@bananasaurs/*`
  symlinks.** Run `npm ci` inside it — ~5 s warm — and confirm the baseline
  test count matches this handoff before trusting any green result (E-1).
- **`grep` returns false negatives in this sandbox.** Use `rg` with an explicit
  path, or `awk`. A bare-pattern `rg` is refused because it could read `.env`;
  that refusal is correct and must not be approved around (E-4). **`jq` is not
  installed** — an empty result from it is a missing binary, not an empty set.
- **This shell substitutes backticks inside `git commit -m`.**
- **Dispatches must run one at a time.** Every predicate task edits
  `predicates/registry.ts`; concurrent implementers collide there, and commit
  `7be2e4f` records what overlapping work in one worktree already cost.
- **The plan you write will contain defects.** Slices 1–2 carried eight,
  Slice 3+5 carried five — including a cross-task sequencing error that broke
  `typecheck` at a boundary the plan itself named. Tell every implementer to
  treat plan code as a strong proposal and to **say so plainly when a test and
  the code disagree** rather than quietly reconciling them.
- **Comments are load-bearing claims.** Both CRITICALs in Slice 3+5 trace to
  comments asserting something false — one about what the live handler does,
  one about which direction an empty list fails. Check a library claim against
  `node_modules` before repeating it.
- **Verify both directions of a boundary.** Slice 5's `emoji` predicate
  measured that `\p{Extended_Pictographic}` *under*-counts and fixed it; nobody
  checked it also matches `©`, `™`, `▪`, `☑`, so a bulleted list scored as
  emoji. A measurement that confirms what you expected is half a measurement.
- **A human-facing guard is not a machine-facing guard.** The dry run's CLI
  text was protected against a misleading summary; the same wrong number
  survived in `data.falseNegatives`, which Slice 6's gate reads as a machine.

## Protocol

1. ADR first if the spec's §9 names one. **Slice 4: it does not. Slice 6 does —
   ADR 0042.**
2. `superpowers:writing-plans` → a plan in `docs/superpowers/plans/`.
3. **Review the plan against the spec before executing it.** One dispatch,
   cheap/mid model. This found a blocking cross-task defect and a decorative
   guard in Slice 3+5's plan, before any code was written — the cheapest
   findings of the whole slice.
4. `superpowers:subagent-driven-development` → execute, 2–3 tasks per dispatch,
   **strictly sequential**.
5. Whole-branch review at the end, on the strongest available model. It found
   both CRITICALs in Slice 2 and both in Slice 3+5. **Do not economise here.**
6. One fix wave, then **one re-review of the fixes.** The re-review found two
   new defects *in* Slice 3+5's fix wave, one of which the fix wave had itself
   created. Fixes are not self-verifying.
7. Run `npm run typecheck && npm run lint && npm run test` **yourself** at
   every checkpoint. Never report a gate you have not run.
8. Append rulings and findings to
   `docs/reports/release2-slices-1-6-ledger.md` as you go — it is the recovery
   map, and after a compaction it outranks your own recollection.
9. Update `docs/STATE.md` at the end of the slice per its own "How to update
   this file". **Never write "live" or "running" when you mean merged.** No
   rule of any of the seven implemented kinds has ever evaluated a message.
10. Write `docs/reports/release2-slice-6-handoff.md`.

## Finish by

Slice 4 complete, then Slice 6 — each reviewed, gates green, ledger and
`STATE.md` updated. **Slice 6 is the release gate and must not be run lean**;
the spec says its tests are written *before* the feature for that reason.

**Stop at flip day.** The owner flips every rule to `observe` on one day so the
clocks overlap, and runs the two-week window. Do not start Slices 7–12 — the
dashboard work happens *during* the window, not before it.
