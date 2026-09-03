**Status:** READY. Slices 0, 1 and 2 are merged to `main` and green (2,148 tests). This handoff covers the roadmap's **Slices 3 and 5 executed as one unit** — the six stateless, single-message predicates — followed by Slice 4 (the window tier) and Slice 6 (the release gate) as their own units. Roadmap slice numbers are kept so the spec still maps.

# Release 2, Slices 3 + 5 — the stateless predicates

## Contents

- [Actions the owner owes](#actions-the-owner-owes)
- [How this run is structured, and why](#how-this-run-is-structured-and-why)
- [Read first, in this order](#read-first-in-this-order)
- [What you are building](#what-you-are-building)
- [Obligations that bind the remaining slices](#obligations-that-bind-the-remaining-slices)
- [Settled — do not re-litigate](#settled--do-not-re-litigate)
- [Things that will bite you](#things-that-will-bite-you)
- [Protocol](#protocol)
- [Finish by](#finish-by)

## Actions the owner owes

None block the work. Items 1 and 2 must happen before flip day.

1. **Announce the `PRIVACY.md` changes** — Slice 2's fixture-corpus retention row, and this slice's attachment line (OD-3). One announcement covers both.
2. **Do not publish `PRIVACY.md` before `/forgetme` exists.** It says "`/forgetme` removes yours"; the storage function ships and is tested, the Discord command is Release 3 (R3-10). The document publishes *with* `/privacy`, and both land in the same R3 item, so the row is true on the day anyone can read it. Publishing early is the one way it becomes false.
3. **`docs/RELEASE1_CONFIG.md` is still blank** (`STATE.md` "Still open" 3). Does not block coding; must exist before real-guild cutover.
4. **Optional, one word:** OD-3 approved storing attachment *filename*, type and size. Storing only extension, type and size would let `attachment_type` replay just as well — the predicate matches on type, not name — and would drop the field that carries personal information. The filename earns its place only if you want to see it while reviewing a match. Say the word and the ledger's OD-3 narrows.

## How this run is structured, and why

**Lean, not minimal.** Slices 1–2 used a per-task review after every task; most found nothing, and the seats that actually caught things were the whole-branch review and the re-review of fixes. So per-slice:

| Step | Model | Why it survives the cut |
| --- | --- | --- |
| 1. Plan review, once, before any code | cheap/mid | Slice 2's plan carried **eight defects** into execution — a renderer contradicting its own test, an unfalsifiable WHERE clause, a name collision. Catching those against the spec costs a fraction of catching them mid-implementation. |
| 2. Implementer, tasks batched 2–3 per dispatch | sonnet | One agent per slice, not per task. Commits incrementally so a rate-limit kill loses nothing. |
| 3. Whole-branch review | **strongest available** | Found both CRITICALs in Slice 2 — a review screen showing a human no evidence, and a summary line that read as reassuring over an unlabelled corpus. Neither was findable per-task. Do not economise here. |
| 4. One fix wave | sonnet | Split across disjoint files if the findings allow it. |
| 5. Re-review of the fix wave | sonnet | Caught a placeholder-trace bug that was **worse than the bug it fixed**. Fixes are not self-verifying. |

Roughly five agent seats per slice instead of twenty. Two things carry the quality regardless of seat count, and neither is optional:

- **"Break it and watch it fail" in every brief.** Ten decorative guards — tests asserting something true about an input where the bug they were named after could not occur — were found across Slices 1–2. Falsifiable experiments catch mechanical errors even in a lean run; re-reading your own work catches nothing.
- **The coordinator runs the gates personally.** Never report `typecheck`/`lint`/`test` you have not run yourself.

**On context.** This is expected to run as one continuous session and will compact several times. That is survivable only because the ledger names commit SHAs: after a compaction, trust `docs/reports/release2-slices-1-6-ledger.md` and `git log` over your own recollection, and never re-dispatch a task the ledger marks complete. If a usage limit kills an agent mid-task, recover its work from the working tree rather than re-running it — that was done twice in Slices 1–2 and saved a full dispatch each time.

## Read first, in this order

1. `CLAUDE.md` — the hard rules; they override everything below.
2. `docs/reports/release2-slices-1-6-ledger.md` — every ruling with its cost if wrong, the owner decisions (OD-1…OD-3), the decorative-guard record.
3. `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md` §3 Slices 3 and 5, plus §4's slice-specific gates.
4. `docs/22_DELEGATION_AND_CONTEXT.md`.
5. `packages/core/src/automod/predicates/` — the interface Slice 1 built. `keyword_filter` is the worked example; if the abstraction is right, six new predicates add six files and six registry entries and change nothing else. **If you find yourself editing the subscriber or the evaluator to make a predicate fit, stop and say so** — that is the abstraction failing, and it is worth a ruling rather than a workaround.

## What you are building

Six predicates, all stateless and single-message:

| Kind | Notes |
| --- | --- |
| `regex` | Operator-supplied pattern. The dangerous one — see the ReDoS gate. |
| `invite` | Discord invite links, with a **relational** allowlist (ADR 0040 §3), not JSON in `mod_rules.config`. |
| `link_domain` | Domains, likewise relational. |
| `caps` | Ratio of capitals; scalar config in `mod_rules.config`. |
| `attachment_type` | Matches on uploaded files. **Needs OD-3's corpus columns first** — see below. |
| `emoji` | Count or ratio; scalar config. |

`mod_rules_kind`'s CHECK already permits all six (widened once in Slice 1), so **no migration is needed for the kinds**. Migrations are needed for two things only: the relational allowlist tables, and OD-3's attachment columns.

**OD-3's work, which belongs in this slice and before `attachment_type`:**

1. Additive columns on `automod_fixtures` for attachment filename, content type and size — a message can carry several, so this is most likely a child table keyed `(guild_id, fixture_id)`. Additive only; no table rebuild (Global Constraint on migrations).
2. `captureObservedFixture` records them, which means the subscriber's `captureFixture` port must carry attachments through. They are already on `PredicateInput` and stop at the corpus boundary today.
3. `PRIVACY.md` gains a line naming attachments, **in the same commit as the migration**.
4. **A test proving `deleteObservedFixturesForMember` removes them.** If they live on a child table with `ON DELETE CASCADE` this is free — verify it rather than assume it. Shipping that function two releases early was pointless if the corpus quietly becomes un-un-makeable.
5. `predicateInputFrom`'s fixture branch stops returning an empty `attachments` array and reconstructs them from the stored rows. This is the field the one-code-path gate cannot currently see — see obligation 3.

## Obligations that bind the remaining slices

| # | Slice | Obligation |
| --- | --- | --- |
| 1 | **3+5** | **The ReDoS gate.** The spec names it: a catastrophic-backtracking pattern, asserting the timeout or the linear-time engine holds. Do not ship `regex` without it — a pattern an operator can type that hangs the subscriber takes moderation down for the whole guild, and they have no way to know they did it. |
| 2 | **3+5** | **The relational-list split** (ADR 0040 §3). `invite` and `link_domain` allowlists are tables, not JSON. Slice 1's rule fingerprint is exclusion-based, so it hashes new `AutomodRule` fields automatically — but **verify the allowlist actually reaches the fingerprint**, or an allowlist edit will not invalidate the compiled artifact. That is ADR 0039's bug wearing a new coat. |
| 3 | **3+5, then 4** | **Widen the one-code-path gate.** It is a behavioural comparison, so it only detects divergences in fields a shipped predicate reads — and `keyword_filter` reads only `content`. A wrong `atMs`, a bypassed predicate cache, and a hand-built `PredicateInput` all pass today. **`attachment_type` is the first predicate to read a second field**, so extend the gate here; the clock and the cache go live in Slice 4. A source-level structural guard in `dry-run.test.ts` holds half the line. |
| 4 | **all** | **Ten decorative guards** were found across Slices 1–2. "Break it and watch it fail" in every implementer and reviewer brief; a guard that stays green when its target is broken is a defect in the test, not a pass. |
| 5 | **6** | Slice 6 **is** the release gate — cutover state, observe-window gating, `counts_as_violation`, `automod_testing_mode`, the tiered false-positive bar. The spec says its tests are written *before* the feature for that reason. Do not run Slice 6 lean. |

## Settled — do not re-litigate

- **The predicate interface** (ADR 0040): two-stage `compile`/`evaluate`, scalar config as Zod-validated JSON in `mod_rules.config`, list-shaped data relational.
- **The one-code-path invariant** (ADR 0041 §3): the dry run and the live subscriber call `predicateInputFrom` and `evaluateRule` and nothing else. No second construction or evaluation site.
- **A rule that cannot compile is inert and loud** (ADR 0040 §4): skipped, logged once per fingerprint, reported by `doctor`. "0 matches" must never read like a clean rule — that confusion has now cost this project twice.
- **Nine plan rulings from Slice 2 (PR-1…PR-9)**, in the ledger with their costs if wrong. PR-2 (no capture in enforce mode) is the owner's to revisit, not a later slice's. **PR-3 is superseded by OD-3** for attachments.
- **The false-positive thresholds** (`STATE.md` "Still open" 7): 5% for delete-only rules, zero for rules feeding the escalation counter, 20-match minimum. Starting points, not measurements — if a rule fails its bar, narrow the rule, do not move the bar.

## Things that will bite you

- **`grep` returns false negatives in this sandbox** on some files. Use `rg`, or `awk '/pattern/{print FILENAME": "FNR": "$0}'`. A `grep` that finds nothing is not evidence.
- **A worktree's gates are meaningless without `node_modules/@bananasaurs/*` symlinks.** Run `npm ci` in it first, or every green result is measuring the main checkout's stale `dist`.
- **This shell substitutes backticks inside `git commit -m`.** Avoid them in commit messages.
- **The plan you write will contain defects** — eight in Slice 2's. Tell every implementer to treat plan code as a strong proposal, not verified truth, and to say so plainly when a test and the code disagree. Three of Slice 2's eight were found that way.
- **Comments here are load-bearing claims.** Two factual errors were corrected in Slice 2 that predated it, one already propagated into new files. If a comment asserts a library behaves a certain way, check it against `node_modules` before repeating it.
- **`regex` is operator input reaching a compiler.** Treat the pattern as untrusted (CLAUDE.md rule 3) — validate on write *and* read, like `mod_rules.config`.

## Protocol

1. ADR first if the spec's §9 names one. Slices 3 and 5: it does not. **Slice 6 does — ADR 0042.**
2. `superpowers:writing-plans` → a plan in `docs/superpowers/plans/`.
3. **Review the plan against the spec before executing it.** One dispatch, cheap model, looking for: steps whose code contradicts their own tests, tests that cannot fail, missing spec requirements, and anything the plan asserts about a library.
4. `superpowers:subagent-driven-development` → execute, tasks batched 2–3 per implementer dispatch.
5. Whole-branch review at the end of the slice, on the strongest available model.
6. One fix wave, then one re-review of the fixes.
7. Run `npm run typecheck && npm run lint && npm run test` yourself at every checkpoint.
8. Append rulings and findings to the ledger as you go — it is the recovery map.
9. Update `docs/STATE.md` at the end of each slice per its own "How to update this file". **Never write "live" or "running" when you mean merged.**
10. Write the next handoff: `docs/reports/release2-slice-4-handoff.md`, then `release2-slice-6-handoff.md`.

## Finish by

Slices 3+5 complete, then Slice 4, then Slice 6 — each reviewed, gates green, ledger and `STATE.md` updated, next handoff written. **Stop at flip day.** The owner flips every rule to `observe` on one day so the clocks overlap, and runs the two-week window. Do not start Slices 7–12; the dashboard work happens *during* the window, not before it.
