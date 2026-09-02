# Release 2, Slices 1–6 — execution ledger

Working ledger for the run that takes Release 2 from Slice 0 (merged) to
**flip day**. Branch `worktree-release2-slices-1-6`. Started 2026-09-01.

Per `docs/22`: conversation memory does not survive compaction. This file is
the recovery map. Every completed task carries its commit SHAs; every ruling
taken on the owner's behalf is recorded here with **what it costs if wrong**.

Scope: Slices 1–6 of
`docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`.
Slices 7–12 are explicitly **not** in this run — the owner flips the rules and
runs the observe window before the dashboard work starts.

## Carried-forward obligations (owner-assigned at kickoff)

1. **The matcher cache never invalidates on term edits.** `subscriber.ts`'s
   module-level `matcherCache` has no eviction; ADR 0039 widened what a stale
   entry gets wrong (collapse thresholds now derive from the word list). Fix it
   in Slice 1 or 2 — whichever touches that file first. → **Slice 1** does.
2. **Do not reorder Slices 1–6 ahead of 7–10.** The dashboard work happens
   *during* the observe window, not before it.
3. **Any rule whose observe data predates ADR 0039 is worthless.** Restart
   those clocks — the rule was not firing.

## Slice status

| Slice | ADR | Plan | Status |
| --- | --- | --- | --- |
| 1 — predicate abstraction + `mod_rules.config` | 0040 | — | not started |
| 2 — fixtures, dry-run evaluator, traces, CLI review | 0041 | — | not started |
| 3 — precise tier (`regex`, `invite`, `link_domain`) | — | — | not started |
| 4 — window tier (`mention_spam`, `rapid_spam`, `duplicate_message`) | — | — | not started |
| 5 — shape tier (`caps`, `attachment_type`, `emoji`) | — | — | not started |
| 6 — cutover tracking, observe gating, automod testing mode | 0042 | — | not started |

## Owner decisions taken during this run

**OD-1 (2026-09-01) — the automod fixture corpus stores the full message and
keeps the author id.** Asked because it changes privacy and retention, which
this run is not authorised to decide. `mod_case_events` stores only a
`matched_snippet` today, and both Slice 2's regression corpus and Slice 9's
false-positive review need more context than that to judge a match. The owner
chose: full message text plus `author_id`, guild-scoped, with `source`
distinguishing `observed` from `handwritten`.

Three obligations follow, and none of them are optional:

1. **`PRIVACY.md` gains a retention row** for the fixture corpus, in Slice 2,
   in the same commit as the table. The policy's own rule is that material
   changes are announced; the owner announces, but the document must be true
   first.
2. **`/forgetme` must be able to delete `source = 'observed'` rows.**
   `/forgetme` is a Release 3 command (R3-10) and does not exist yet, so
   Slice 2's obligation is narrower and concrete: store `author_id` so the
   future command *can* find them, and add a repository function
   `deleteObservedFixturesForMember(scope, memberId)` with a test, so R3-10
   wires up an existing, tested path rather than inventing one. A corpus that
   cannot be un-made is the thing the owner was asked about.
3. `source = 'handwritten'` rows are **not** member data and are never deleted
   by `/forgetme` — they are the adversarial cases the project wrote itself.

**OD-2 (2026-09-01) — the fixture corpus is included in `npm run backup`.**
Backup is a whole-database snapshot (ADR 0034), and excluding one table means a
restore silently loses every reviewed verdict and the whole regression suite.
No change to `backup.ts` is required; this is recorded so that a later reviewer
asking "should this table have been excluded?" finds the answer rather than
re-opening it. Diagnostics bundles are unchanged — they were never a
whole-database dump.

## Rulings

Rulings taken on the owner's behalf, each with what it costs if wrong.

**R-1 — the compiled-predicate cache lives in `createAutomodSubscriber`'s
closure, not in module state.** ADR 0035's spec asked for module state; that
was defensible while the cache was write-once and is not now. Per-instance, it
is bounded by one guild's rules, cannot leak across guilds even in principle,
and needs no test-only reset export. The guild id stays in the key as defence
in depth. *Costs if wrong:* a future caller wanting one process-wide cache
shared across guilds has to reintroduce it — a small change, made safe either
way by ADR 0040 §5's fingerprint. Recorded as an amendment in ADR 0040.

**R-2 — the `mod_rules_kind` CHECK widens to all ten kinds in Slice 1, before
nine of those predicates exist.** A rule naming a kind with no registered
predicate is inert, logged once, and reported by `doctor`. *Costs if wrong:* an
operator can create a rule that cannot yet do anything. Mitigated by the
`doctor` check, which is why that check is in Slice 1 rather than deferred. The
alternative — a migration per predicate slice — buys nothing and costs four
more table rebuilds.

**R-3 — `MessageEvent` gains mention and attachment metadata in Slice 1**,
before Slices 4 and 5 need it, so those slices are pure predicate code.
*Costs if wrong:* a few unused fields ride along on every message event for two
slices. discord.js already holds all of them on the `Message` object, so nothing
new is fetched and no new data leaves the process.

**R-4 — a rule that cannot be compiled is inert, logged once per configuration,
and reported by `doctor`** — not a crash, and not a silent skip. *Costs if
wrong:* nothing; this is the ADR 0039 failure mode being closed rather than
re-opened.

## Deferred minors

_None yet._
