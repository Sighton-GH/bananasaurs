**Status:** READY. Slices 0, 1 and 2 are merged to `main` and green (2,148 tests). Slice 3 is the precise tier — `regex`, `invite`, `link_domain` — and no ADR is named for it in the roadmap spec's §9, so it goes straight to planning. Slices 3–6 remain before flip day.

# Release 2, Slice 3 — precise tier (`regex`, `invite`, `link_domain`)

## Contents

- [Actions I need from you](#actions-i-need-from-you)
- [Read first, in this order](#read-first-in-this-order)
- [Model and effort](#model-and-effort)
- [Branch](#branch)
- [What you are building](#what-you-are-building)
- [Obligations that bind the remaining slices](#obligations-that-bind-the-remaining-slices)
- [Settled — do not re-litigate](#settled--do-not-re-litigate)
- [Things that will bite you](#things-that-will-bite-you)
- [Protocol](#protocol)
- [Finish by](#finish-by)

## Actions I need from you

Owner actions, none of which block Slice 3 — but items 1 and 2 must happen before flip day.

1. **Announce the `PRIVACY.md` change.** Slice 2 added a retention row for the automod fixture corpus (whole matched messages, kept for review). Your own policy says material changes are announced in the server.
2. **Do not publish `PRIVACY.md` before `/forgetme` exists.** The new row says "`/forgetme` removes yours". The storage function ships and is tested; the Discord command is Release 3 (R3-10). The document already names `/privacy`, `/mydata` and `/forgetme`, none of which are implemented, and it publishes *with* `/privacy` — so the row is true on the day anyone can read it. Publishing early is the one way it becomes false.
3. **`docs/RELEASE1_CONFIG.md` is still a blank slate** (`STATE.md` "Still open" item 3). Does not block coding; must exist before real-guild cutover.
4. ~~**Confirm which database is real.**~~ Settled 2026-09-02: `data/bananasaurs.db` was at migration 5 with no automod tables. Migration 5 → 13 was rehearsed against a full copy including the WAL — 17 tables, zero rows lost, `foreign_key_check` clean.
5. ~~**Restart observe clocks predating ADR 0039.**~~ Settled: no rule has ever run, so there is no clock to restart.

## Read first, in this order

1. `CLAUDE.md` — the hard rules. They override everything below.
2. `docs/reports/release2-slices-1-6-ledger.md` — the running record: every ruling made during Slices 1–2 with its cost if wrong, the ten decorative guards found, and the obligations indexed below.
3. `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md` §3 Slice 3, and §4's slice-specific gates.
4. `docs/22_DELEGATION_AND_CONTEXT.md` — how to delegate without burning context.
5. `packages/core/src/automod/predicates/` — the interface Slice 1 built. `keyword_filter` is the worked example; Slice 3 adds three more entries to `PREDICATES` and, if the abstraction is right, changes nothing else.

## Model and effort

Implementers and task reviewers on **sonnet**. One whole-branch review per slice on the **strongest available model** — that review found both criticals in Slice 2 and is not the place to economise.

## Branch

Work in a worktree off `main`. Do not commit to `main` directly; the owner merges.

## What you are building

Three predicates, per the roadmap spec:

- **`regex`** — an operator-supplied pattern. The dangerous one; see the gate below.
- **`invite`** — Discord invite links, with an allowlist. The allowlist is **list-shaped data and stays relational** (ADR 0040 §3), not JSON in `mod_rules.config`.
- **`link_domain`** — domains, likewise with relational lists.

Each is a `Predicate` in `packages/core/src/automod/predicates/`, a Zod config schema, an entry in the registry, and a `MatchTrace` a human can read. `mod_rules_kind`'s CHECK already permits all three (widened once in Slice 1), so **no migration is needed for the kinds themselves** — only for the relational allowlist tables.

## Obligations that bind the remaining slices

| # | Slice | Obligation |
| --- | --- | --- |
| 1 | **3** | **The ReDoS gate.** The spec names it: a catastrophic-backtracking pattern, asserting the timeout or the linear-time engine holds. Do not ship `regex` without it — a pattern an operator can type that hangs the subscriber takes moderation down for the whole guild, and the operator has no way to know they did it. |
| 2 | **3** | **The relational-list split** (ADR 0040 §3). `invite` and `link_domain` allowlists are tables, not JSON. Slice 1's rule fingerprint is exclusion-based, so it hashes new `AutomodRule` fields automatically — but **verify** the allowlist actually reaches the fingerprint, or an allowlist edit will not invalidate the compiled artifact. That is ADR 0039's bug in a new costume. |
| 3 | **4** | **Widen the one-code-path gate.** It is a behavioural comparison, so it only detects divergences in fields a shipped predicate reads, and `keyword_filter` reads `content`. A wrong `atMs`, a bypassed predicate cache, and a hand-built `PredicateInput` all pass today. The window tier reads the clock and carries state on the compiled artifact, so all three go live in Slice 4. A source-level structural guard in `dry-run.test.ts` holds half the line; the behavioural half is Slice 4's job. |
| 4 | **5** | **Ask the owner about attachment metadata** before writing `attachment_type`. It cannot be dry-run against observed fixtures (ruling PR-3) — the corpus holds text, author and timestamp only. Handwritten cases are the fallback; extending the corpus is a privacy decision, not an engineering one. |
| 5 | **all** | **Ten decorative guards** were found across Slices 1–2 — tests asserting something true about an input where the bug they were named after could not occur. Put "break it and watch it fail" in every implementer and reviewer brief, and treat a guard that stays green when its target is broken as a defect in the test, not a pass. |

## Settled — do not re-litigate

- **The predicate interface** (ADR 0040): two-stage `compile`/`evaluate`, scalar config in `mod_rules.config` as Zod-validated JSON, list-shaped data relational.
- **The one-code-path invariant** (ADR 0041 §3): the dry run and the live subscriber call `predicateInputFrom` and `evaluateRule` and nothing else. Do not build a second construction or evaluation site.
- **A rule that cannot compile is inert and loud** (ADR 0040 §4) — skipped, logged once per fingerprint, reported by `doctor`. "0 matches" must never read like a clean rule.
- **Nine plan rulings from Slice 2 (PR-1…PR-9)**, recorded in the ledger with their costs if wrong. PR-2 (no capture in enforce mode) is the owner's to revisit, not a later slice's.

## Things that will bite you

- **`grep` returns false negatives in this sandbox** on some files. Use `rg`, or `awk '/pattern/{print FILENAME": "FNR": "$0}'`. A `grep` that finds nothing is not evidence.
- **A worktree's gates are meaningless without `node_modules/@bananasaurs/*` symlinks.** Run `npm ci` in it first, or every green result is measuring the main checkout's stale `dist`.
- **This shell substitutes backticks inside `git commit -m`.** Avoid them in commit messages.
- **The plan you write will contain defects.** Eight were found by implementers and reviewers across Slice 2 — a renderer contradicting its own test, an unfalsifiable WHERE clause, a variable-name collision. Tell every implementer to treat plan code as a strong proposal, not verified truth, and to say so when a test and the code disagree.
- **Comments here are load-bearing claims.** Two factual errors were corrected in Slice 2 that predated it, one of which had already propagated into new files. If a comment asserts a library behaves a certain way, check it against `node_modules` before repeating it.

## Protocol

1. ADR first if the spec's §9 names one for the slice. Slice 3: it does not.
2. `superpowers:writing-plans` → a plan in `docs/superpowers/plans/`.
3. `superpowers:subagent-driven-development` → execute, one task at a time.
4. Per-task review after each task; **one whole-branch review at the end of the slice**, on the strongest model.
5. Run `npm run typecheck && npm run lint && npm run test` yourself. Never report a gate you have not run.
6. Append rulings and findings to `docs/reports/release2-slices-1-6-ledger.md` as you go — that file is the running record across all six slices.
7. Update `docs/STATE.md` at the end of the slice, per its own "How to update this file". **Never write "live" or "running" when you mean merged.**
8. Write the next slice's handoff to `docs/reports/release2-slice-<n>-handoff.md`.

## Finish by

Slice 3 complete, reviewed, gates green, ledger updated, `STATE.md` updated, and `docs/reports/release2-slice-4-handoff.md` written. Then continue to Slice 4 — **stop at flip day**, after Slice 6. The owner flips the rules to `observe` and runs the two-week window.
