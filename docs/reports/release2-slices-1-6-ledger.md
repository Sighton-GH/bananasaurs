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

## Start here

**This file is the record. What to do next is in the handoff:
`docs/reports/release2-slice-<n>-handoff.md`** — currently
[`release2-slice-3-handoff.md`](release2-slice-3-handoff.md), which carries the
next slice's scope, the obligations binding Slices 3–6, the owner actions
outstanding, and the protocol.

Kept apart deliberately, and the split is the same one `docs/reports/` already
uses: a handoff is written once for the unit it hands off, and is finished when
that unit starts. This ledger runs across all six slices and is appended to as
they go. Duplicating the obligations into both is how they drift and one copy
becomes wrong.

Below: rulings taken on the owner's behalf with what each costs if wrong, the
per-slice execution log, and the findings worth carrying forward.

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
| 1 — predicate abstraction + `mod_rules.config` | 0040 ✅ | [plan](superpowers/plans/2026-09-01-slice-1-predicate-abstraction-and-config-carrier.md) | **✅ complete** — 7 tasks, whole-branch reviewed, fix wave re-reviewed clean. 2026 tests (from 1953), typecheck + lint clean |
| 2 — fixtures, dry-run evaluator, traces, CLI review | 0041 ✅ | [plan](superpowers/plans/2026-09-02-slice-2-fixtures-dry-run-and-traces.md) | **✅ complete** — 9 tasks, whole-branch reviewed (SHIP-WITH-FIXES), fix wave re-reviewed, residual re-review finding fixed. 2148 tests (from 2026), typecheck + lint clean |
| 3 + 5 — the six stateless predicates, executed as one unit | — (spec §9 names none) | [plan](superpowers/plans/2026-09-02-slices-3-5-stateless-predicates.md) | **✅ complete** — 9 tasks in 5 dispatches, plan reviewed before any code, whole-branch reviewed (SHIP-WITH-FIXES), two fix waves, re-review's two residuals fixed. 2267 tests (from 2148), typecheck + lint clean |
| 4 — window tier (`mention_spam`, `rapid_spam`, `duplicate_message`) | — (spec §9 names none) | [plan](superpowers/plans/2026-09-03-slice-4-window-tier.md) | **✅ complete** — 5 tasks in 3 dispatches, plan reviewed before any code, whole-branch reviewed (SHIP-WITH-FIXES: 3 CRITICAL), fix wave, re-review found a new CRITICAL in the fix, fixed. 2312 tests (from 2267), all gates green by exit code |
| 6 — cutover tracking, observe gating, automod testing mode | 0042 ✅ (+ Amendment 1) | [plan](superpowers/plans/2026-09-04-slice-6-release-gate.md) | **in progress** — plan reviewed (EXECUTE-WITH-FIXES, 3 blocking, all fixed). Tasks 1-5 done: nine columns in three migrations with a rebuild-survival negative control that goes red; the enforcement gate, with a fix wave for a sign-off that cleared the evidence and three missing PR-27 transitions; `countsAsViolation` to the subscriber and `automod_testing_mode` as a third lever kept structurally out of the moderation path. 2345 tests (from 2312), all gates green by exit code. All six tasks done: `doctor`'s two checks plus `automod ready`/`automod signoff`, with a follow-up for an observe-window check that reported disabled rules forever. 2380 tests (from 2312), all gates green by exit code. Whole-branch review in flight |

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

**OD-3 (2026-09-02) — the fixture corpus also stores each attachment's
filename, content type and size.** Asked ahead of Slice 5 rather than at it, so
the run would not stall. This reverses plan ruling PR-3's consequence:
`attachment_type` *can* now be dry-run against observed traffic, and its
regression suite is real rather than hand-written.

It is a widening of what Bananasaurs retains about members, and the owner was
told so before choosing: **filenames routinely carry personal information** —
`Bryan_resume_2026.pdf`, `medical_letter.docx` — and this stores them for as
long as the corpus keeps the message.

Four obligations follow, none of them optional, all in the same slice that adds
the columns:

1. **`PRIVACY.md` gains a line naming attachments**, in the same commit as the
   migration — the rule ADR 0041 §1 set for the corpus itself, for the same
   reason: a policy that is not true is worse than none.
2. **The owner announces it.** Same standing requirement as the Slice 2 privacy
   change; both can go in one announcement if Slice 2's has not happened yet.
3. **`/forgetme` must reach it.** If the columns live on `automod_fixtures`,
   `deleteObservedFixturesForMember` covers them with no code change — **verify
   that with a test rather than assuming it**, because the whole point of
   shipping that function two releases early was that the corpus stays
   un-makeable.
4. **`captureObservedFixture` must record them**, which means the subscriber's
   `captureFixture` port has to carry attachments through. They are already on
   `PredicateInput`; they stop at the corpus boundary today.

**A narrower option the owner may still prefer, recorded because it was not on
the table when the choice was made:** storing only the *extension*, content
type and size — dropping the filename — would let `attachment_type` replay
just as well, since the predicate matches on type rather than name. The
filename earns its place only if a human reviewing a match wants to see it
(`invoice.exe` reads differently from `game_mod.exe`). One word from the owner
narrows this; until then, implement what was approved.

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

**R-5 — migrations run with foreign keys disabled at the *connection* level,
bracketed by a `PRAGMA foreign_key_check` that fails the migration if it finds
a violation.** This is the fix for a real, reproduced data-loss bug, not a
preference.

*What was found.* Slice 1's `mod_rules` change forces a CHECK widen, which
SQLite cannot do in place, so drizzle-kit emits the table-rebuild dance
(`CREATE __new_mod_rules` → `INSERT…SELECT` → `DROP mod_rules` → `RENAME`).
The generated SQL brackets that in `PRAGMA foreign_keys=OFF; … ON;` — correctly
— but `drizzle-orm`'s migrator wraps *every* pending migration in a single
`BEGIN … COMMIT`, and `PRAGMA foreign_keys` is a documented no-op once a
transaction is open. So enforcement stays on through the `DROP`, and the
`ON DELETE CASCADE` from `word_categories`, `word_allowlist` and
`mod_rule_exemptions` onto `mod_rules(guild_id, rule_id)` fires and silently
deletes every child row. No error is raised.

*Verified by the coordinator, not taken on report.* A standalone reproduction
migrated a database to 0009, inserted one rule with one category, one term, one
allowlist phrase and one exemption, then applied 0010+0011:

```
BEFORE {mod_rules:1, word_categories:1, word_terms:1, word_allowlist:1, mod_rule_exemptions:1}
AFTER  {mod_rules:1, word_categories:0, word_terms:0, word_allowlist:0, mod_rule_exemptions:0}
```

*Why this is not hypothetical.* `seedAutomodDefaults` already created
`default-word-filter` with the seeded word list on the live install. This
migration would delete that rule's entire word list on upgrade and leave a rule
that looks configured and matches nothing — the ADR 0039 failure mode again,
total rather than partial.

*The fix.* SQLite's own documented procedure for this kind of schema change
requires `foreign_keys=OFF` **outside** any transaction. So the `migrate()`
call sites — `scripts/migrate.mjs`, `packages/storage/src/test-support.ts`, and
any other — disable foreign keys on the connection, migrate, run
`PRAGMA foreign_key_check`, and re-enable. The `foreign_key_check` is the part
that stops this being a licence to write broken migrations: enforcement is off
during the rebuild, so a violation introduced by a migration must be caught on
the way out rather than never.

*Rejected alternative:* calling `migrate()` once per migration file. It does
not work — drizzle opens a transaction per call regardless, so the pragma is
still a no-op. Worth recording so nobody tries it.

*Costs if wrong:* foreign-key enforcement is off for the duration of a
migration run. A migration that inserts referentially broken rows would not be
rejected at insert time; `foreign_key_check` catches it immediately afterwards
and fails the run, so the window is one migration batch and the failure is
loud. The alternative — hand-editing each rebuild migration to re-insert
children — is fragile, per-migration, and has to be remembered every time.

**R-6 — the schema change ships as two migrations (0010 `ALTER TABLE … ADD
COLUMN`, 0011 the CHECK-forced rebuild), not one.** drizzle-kit 0.31.10 emits
invalid SQL when a column add and a table rebuild land in the same `generate`
call: the rebuild's `INSERT INTO __new_mod_rules(…, "config", …) SELECT …,
"config", … FROM mod_rules` reads a column the *old* table does not yet have,
so the migration throws `no such column: "config"` and nothing applies.
Confirmed by reading the generated 0011, which is valid only because 0010 added
`config` first. Two sequential `db:generate` runs; both files are pure
drizzle-kit output, neither hand-written. *Costs if wrong:* one extra migration
file in the journal. Nothing else.

**R-7 — `0002_solid_titanium_man.sql` carries the same latent hazard and is
recorded rather than fixed.** It rebuilds `panels`, which owns cascading
children (`panel_options`, `panel_blocked_roles`). It has already been applied
to the live database, so whatever it did is done; R-5 prevents recurrence for
every future rebuild. *Action carried to handoff:* run `PRAGMA
foreign_key_check` on the live database and confirm `panel_options` row counts
look right before the next migration. *Costs if wrong:* if 0002 did destroy
panel options on the live install, they were rebuilt by hand during Release 1
smoke testing and nobody noticed the cause. Worth one look, not a slice.

### R-7 follow-up: the live database, inspected read-only (2026-09-01)

Ran `PRAGMA foreign_key_check` and row counts against
`/home/bryan/projects/bananasaurs/data/bananasaurs.db`, read-only, no writes.

```
foreign_key_check: []          (no violations)
guilds 1 · panels 1 · panel_options 1 · panel_blocked_roles 0
mod_rules … mod_case_events:   tables absent
applied migrations:            5
```

**R-7 is answered for this file: nothing was destroyed.** `panel_options`
survived migration 0002, and there are no foreign-key violations.

**But two things this turned up matter more than the answer.**

1. **This database is at migration 5 and has no automod tables at all** — no
   `mod_rules`, no `mod_cases`, no `mod_case_events`. `STATE.md` describes the
   automod engine, the `/mod` surface and Slice 0 as shipped and live, which
   cannot be true of *this* file. Either the operational database lives
   somewhere else (`BANANASAURS_DB_PATH` overrides the default) or this one is
   a stale artefact from late August (its mtime is 2026-08-30 19:13). **The
   owner should confirm which file is real before running `db:migrate`.**
2. **On whichever database is real, the R-5 bug would not have bitten on this
   particular upgrade anyway** — and it is worth being precise about why,
   rather than claiming a save that did not happen. Applying 0005→0011 in one
   `migrate()` call creates `mod_rules` in an earlier migration and rebuilds it
   in 0011 while it is still empty, so there is nothing for the cascade to
   delete. The bug bites on the *next* rebuild after the daemon has run and
   `seedAutomodDefaults` has populated the word list. The fix is still
   required; it is simply not yet load-bearing on this specific migration path.

**R-8 — `MatchTrace.matchedOn` must carry the *configured term*, not the matched
snippet. Deferred to Slice 2, which owns the trace format, and recorded as a
required deliverable there.**

*What is wrong.* `keyword-filter.ts` currently sets `matchedOn: hit.snippet`,
which is the same value as `PredicateMatch.snippet` sitting beside it. A field
whose stated job is "which configured thing matched" that duplicates the field
next to it carries no information at all.

*Why it matters, concretely.* ADR 0041 §5 and the roadmap's Slice 9 both
promise one-click suppression "appropriate to the predicate that fired" — for
`keyword_filter`, that is *allowlist this term*. If the trace names the
snippet, a reviewer suppressing a false positive on `b@dw0rd` would allowlist
that one evasion spelling and leave the underlying term matching everything
else. The suppression would appear to work and would not.

*Why Slice 2 rather than now.* ADR 0041 makes Slice 2 the owner of the trace
format, and Slice 2 is where the trace is first *persisted* — getting it right
before any trace is written to a column is what actually matters, and no trace
is stored until then. Doing it now would churn Task 5's tests for no gain. The
fix is contained: `buildMatcher` already keeps `categoryByTermId`, so it keeps
the term text the same way and `AutomodMatcher`'s return widens by one field.

*Slice 2 must ship a test asserting `matchedOn !== snippet` for a fuzzy
match* — otherwise this regresses silently, which is exactly how it arrived.

*Costs if wrong:* if Slice 2 forgets, Slice 9's suppression is subtly broken in
a way that looks like it works. The test named above is what makes forgetting
impossible.

**R-8 SUPERSEDED by R-9 — fixed in Slice 1 after all, together with a live bug
the task review found.** The deferral above was overtaken within the hour; kept
here rather than deleted so the reasoning that changed is visible.

**R-9 — the keyword filter's trace span pointed at the wrong occurrence of a
repeated term. Fixed in Slice 1, together with R-8, because they are one
edit.**

*What was wrong.* `keyword-filter.ts` computed the span with
`input.content.indexOf(hit.snippet)` — the *first* occurrence of that text,
not the occurrence that actually matched. The task reviewer reproduced it: a
message whose first `badword` is allowlisted and whose second is a real
violation produced a span covering the allowlisted, non-violating text.

*Whose fault, plainly.* Mine. The plan I wrote carried the comment "`indexOf`
on the already-normalised content is exact here: `snippet` was produced by
slicing that same string", which is true only when the term occurs once, and it
justified a bad trade — not widening `AutomodMatcher`'s return "because it
would churn `matcher.test.ts`". `obscenity`'s `RegExpMatcher` already returns
`termId`, `startIndex` and `endIndex` against the original string; the code was
throwing them away and then guessing.

*Why R-8 folds into it.* Both defects are repaired by the same widening —
`match()` returns the configured term text and the real indices. Doing that
once in Slice 1 is cheaper than doing half of it now and half in Slice 2, and
it means no wrong span is ever persisted.

*Costs if wrong:* `matcher.test.ts` churns, which is the cost the plan was
wrongly avoiding. Two new tests pin the behaviour — a repeated-term span with
the first occurrence allowlisted, and `matchedOn !== snippet` on a fuzzy
match — and both must be watched failing first.

*Also noted from the same review:* the original span test was **decorative**
for this bug — its content contained the term only once, so `indexOf` could
not fail in it. It is kept and joined by the repeated-term case. This is the
third decorative-guard finding on this project; the pattern is a test whose
fixture is too simple to exercise the branch it names.

**R-10 — the compile-failure log's `detail` field is silently dropped by the
Pino allowlist. Fix it with a *narrowly named* field, not by allowlisting
`detail`.**

*What is wrong.* `subscriber.ts` logs `detail: result.detail` when a rule
cannot be compiled. `detail` is absent from `LOGGABLE_FIELDS`
(`packages/core/src/obs/logger.ts`), so `safeLogFields` drops it and the log
records only `droppedFields: 1`. The `reason` code survives (`outcome` is
allowlisted), so the operator learns *that* a rule failed to compile and never
*why* — which is precisely the half ADR 0040 §4's "inert **and loud**" exists
to deliver, and precisely the ADR 0039 failure mode it was written to prevent
recurring.

*Why not simply allowlist `detail`.* CLAUDE.md rule 4 says the redaction list
is an allowlist, not a denylist, and every entry in `LOGGABLE_FIELDS` is a
specific semantic concept — `ruleId`, `dedupeKey`, `breakerState`. `detail` is
a generic bag; allowlisting it would let any future call site put arbitrary
content into logs under a name that promises nothing. That is the shape of
mistake the allowlist exists to prevent.

*The fix.* A specifically named field — `compileError` — added to
`LOGGABLE_FIELDS` with a comment stating what may flow into it: a Zod or
`obscenity` error message derived from **operator-authored rule
configuration** (a JSON config blob, a word-list term), never member message
content. That property is worth stating because it is what makes the entry
safe, and a future reader should not have to re-derive it.

*Costs if wrong:* if a predicate is later added whose compile error could embed
member content, this entry would leak it. The mitigation is the comment plus
the narrow name — a predicate author adding such an error has to walk past a
line saying what the field is for.

*Also folded in:* the "logs again after config changes" test uses a `caps` rule,
so it exercises `no-predicate` rather than the `invalid-config` JSON-parse path
its fixture and name imply. The behaviour under test (fingerprint-driven
recompile and re-log) is genuinely exercised, so this is a naming defect rather
than a decorative guard — but it should say what it does.

## Whole-branch review of Slice 1 (2026-09-02) — verdict ship-with-fixes

0 Critical, 4 Important, 7 Minor, 1 decorative guard. Every one of the four
Important findings is **cross-task** — an interaction between changes that were
each individually reviewed and individually sound. This is the second time on
this project that a whole-branch pass has found what per-task review
structurally could not; `docs/22` priced it correctly.

The reviewer verified clean: the enforcement path from the safety-state read
down is byte-identical apart from indentation; the fingerprint covers
everything `compile` reads *today*; `StoredAutomodRule`/`AutomodRule` agree and
drift would be a compile error; `runMigrations` is correct and is the only
migration path. It independently re-derived R-1's and R-5's premises rather
than accepting them, and disagreed with none of R-1 … R-10.

**R-11 — the fingerprint becomes exclusion-based, not an allowlist of fields.**
`ruleFingerprint` hand-enumerates `{kind, config, terms, allowlist}`. ADR 0040
§3 already commits Slice 3 to a *relational* allowlist for `invite` and
`link_domain`; when that field lands, nothing forces it into the digest, and
the stale-artifact bug this slice exists to kill returns for those predicates
alone — silently, which is its whole character. Hash everything on the rule
*except* an explicit exclusion list (`mode`, and `ruleId` which is already in
the cache key). *Costs if wrong:* a future field that legitimately should not
invalidate the cache has to be added to the exclusion list, which is a
one-line change that fails loudly (over-invalidation costs a recompile) rather
than silently (under-invalidation costs correctness). That asymmetry is the
whole argument.

**R-12 — a `keyword_filter` rule with zero enabled terms is unusable, and
`doctor` must say so.** It currently compiles cleanly, so `doctor` reports
"every enabled automod rule compiles" for a rule that cannot match anything.
That is the precise state the R-5 cascade would have left the live guild in —
and the precise shape of ADR 0039. A rule mid-configuration will briefly show
in `doctor`; that is correct, not noise. *Costs if wrong:* an operator adding a
rule before its terms sees one `doctor` finding until they add the first term.

**R-13 — `PredicateInput` gains `eventKind`.** The subscriber evaluates both
`messageCreate` and `messageUpdate`, and a predicate cannot currently tell them
apart. Slice 4's `rapid_spam` and `duplicate_message` would count an edit as a
new message — a member editing a typo three times would trip a rate rule. The
reviewer is right that this is a subscriber-and-interface change far cheaper
here than in Slice 4. *Costs if wrong:* one unused field until Slice 4.

**R-14 — ADR 0040 §2's on-*write* config validation does not exist; build it
rather than amend the ADR.** The read side is validated, so rule 3 holds today
and nothing is currently broken. But `setRuleConfig` is a real writer with no
guard, and storage may not validate (ADR 0014 — the Zod schemas live in core).
Export `validateRuleConfig(kind, configJson)` from core now, with a test, so
Slice 6's and Slice 8's write paths inherit a guard instead of inventing one.
*Costs if wrong:* ~15 lines with one caller for now. The alternative — amending
the ADR to say "validation on read only" — makes the document true by lowering
it, and rule 3 says both directions.

**R-15 — pin the three hand-maintained copies of the kind list against each
other.** `mod_rules_kind`'s SQL CHECK, storage's `RuleKind` and core's
`RULE_KINDS` are three copies that currently agree. A test asserting the SQL
CHECK accepts exactly `RULE_KINDS` and nothing else makes drift a red test
rather than an inert rule. Reviewer's suggestion, accepted.

**Sixth decorative guard, and again one of mine.** The
"keeps a non-keyword_filter rule out of the word-list hydration path" test
(`automod-rules.test.ts`) puts a single `caps` rule in the database, so
`terms`/`allowlist` come back empty under *any* implementation — including one
that leaks another rule's terms, which is what its name claims to guard. It
needs a `keyword_filter` rule **with terms** sitting alongside it.

**Housekeeping:** the decorative-guard table below claims four rows and names
three. Corrected.

### Slice 1 closed (2026-09-02)

All six fix-wave items re-reviewed **ADDRESSED**, no new breakage. Final state:
**2026 tests** (from 1953 at the branch point, none deleted), typecheck and
lint clean, every gate run by the coordinator rather than taken on report.

Two guards the coordinator watched fail personally: the migration's child-row
survival check (neutralised the `foreign_keys = OFF` step — went red, restored,
green) and the kind-list drift pin (added an eleventh kind to `RULE_KINDS` —
went red, restored, green).

The re-review confirmed the exclusion-based digest answers its own purpose: a
field added to `AutomodRule` later is hashed **without anyone editing
`fingerprint.ts`**, because the digest is built by inserting sorted keys rather
than spreading in declaration order. That is what stops Slice 3's relational
`invite`/`link_domain` allowlist from silently escaping the cache key.

## Slice 2 rulings (2026-09-02)

Nine decisions ADR 0041 does not name, taken at plan time so execution does
not stall on them. Full text with costs-if-wrong lives in the plan's **Plan
rulings** section; this is the index. Two more (E-2, E-3) came out of the
pre-flight conflict scan and live in
`.superpowers/sdd/2026-09-02-slice-2-fixtures-dry-run-and-traces/progress.md`.

| # | Ruling | Cost if wrong |
| --- | --- | --- |
| PR-1 | An observed fixture's id is `<messageId>:<first 16 hex of sha256(content)>`. A replay collapses; an edit is separate evidence. | An edited-then-rematched message yields two rows where one was wanted — visible, deletable. |
| PR-2 | Capture happens only for `test`/`observe` matches. Enforce-mode matches are **not** captured. | The corpus stops growing after flip day; post-flip review reads trace + snippet, not the whole message. |
| PR-3 | A fixture-derived `PredicateInput` parses mentions from content, leaves `attachments` empty, uses synthetic channel ids. | `attachment_type` (Slice 5) cannot be dry-run against observed traffic — handwritten cases only. **Carried to Slice 5.** |
| PR-4 | `mod_match_reviews` PK is `(guild_id, event_id)`; a re-review updates. | The history of a *changed* verdict is lost. Additive table fixes it later if needed. |
| PR-5 | `mod_case_events` gains nullable `fixture_id`; a verdict propagates a label onto the linked fixture. | One nullable column on an append-only table, ignorable if unwanted. |
| PR-6 | Three CLI commands: `automod dryrun`, `automod review` (reads), `automod verdict` (write, `--confirm` + audit). | One more command in `--help`. |
| PR-7 | A match is reviewable exactly when it has a trace (`trace IS NOT NULL`), not by an `action_taken` allowlist. | A genuine match with no trace is invisible — only possible for pre-Slice-2 rows, whose clocks are restarting anyway. |
| PR-8 | Trace serialisation and label propagation are best-effort; neither may cost a moderation record. | A field of evidence goes missing where a louder failure might have surfaced the bug sooner. |
| PR-9 | `mod_match_reviews.reviewed_by` is plain TEXT — the CLI writes `cli:<unix user>`, the dashboard a snowflake. | Slice 9's screen branches on a string prefix to render a reviewer. |

### The one-code-path gate has a ceiling, and Slice 4 is where it bites

Slice 2's named gate (spec §4) asserts the dry-run evaluator and the live
subscriber produce byte-identical matches. It does — verified twice, once by
the implementer and once by a reviewer who devised its own divergences.

**But it is a behavioural comparison, so it can only see a divergence in a
field some shipped predicate actually reads.** `keyword_filter` is the only
one, and it reads `content`. The reviewer's probes found three divergences the
gate does **not** catch today:

| Divergence | Caught? | Why |
| --- | --- | --- |
| Mangled `content` | ✅ red | `keyword_filter` reads it |
| Match returned without its trace | ✅ red | compared explicitly |
| Wrong `atMs` | ❌ green | nothing reads the clock yet |
| Predicate cache bypassed entirely | ❌ green | no observable difference with one stateless predicate |
| Hand-built `PredicateInput` skipping mention/attachment reconstruction | ❌ green | no predicate reads those fields yet |

All three become live the moment the window tier ships. `rapid_spam` and
`duplicate_message` carry sliding-window state on the compiled artifact and
read `atMs`; `mention_spam` reads the mention lists.

**Half of this is already closed.** Slice 2 added a *structural* guard beside
the behavioural one: `dry-run.test.ts` asserts at source level that
`dry-run.ts` builds no `PredicateInput` of its own (no `eventKind:`, no
`atMs:`) and calls `predicateInputFrom`/`evaluateRule` rather than
`compileRule`. That holds for fields no predicate has read yet, and it was
watched failing — inlining a construction site turns it red. It follows the
shape `boundaries.test.ts` already established here.

**What Slice 4 must do, and must not skip:** extend the *behavioural* gate the
moment a predicate reads a second field. Concretely — when `mention_spam`
lands, the gate should compare a match on a message with mentions; when
`rapid_spam` lands, it should compare a *sequence* whose result depends on
`atMs` and on the compiled artifact's state. Until then the guarantee is
"identical for content-only predicates", which is true and narrower than it
sounds.

**Why PR-2 is the one to re-examine first.** It is the only ruling here that
narrows what the observe window can measure *after* flip day, and it was
decided on a privacy ground rather than an engineering one: `PRIVACY.md`
promises deleted-message content is kept 30 days, a fixture has no expiry, so
capturing what the bot just deleted would make the policy untrue in the same
commit that adds a row claiming it is true. If post-flip review turns out too
thin in practice, widening it is **the owner's decision**, not a later slice's.

## Slice 2 closed (2026-09-02)

31 commits since Slice 1 closed. **2148 tests / 102 files**, from 2026 at the
branch point — none deleted. Typecheck and lint clean, every gate run by the
coordinator rather than taken on report.

Whole-branch review (strongest model) returned **SHIP-WITH-FIXES**: 2 CRITICAL,
7 IMPORTANT, 7 MINOR. All CRITICAL and IMPORTANT findings fixed, re-reviewed,
and one residual defect found *in the fix wave itself* fixed after that.

**The two criticals were both about the same thing: a number or a screen that
reads as reassuring when it is not.**

- `automod review` showed a human almost no evidence — the message and the
  matched snippet were fetched, carried, and put in the JSON, but never
  printed. A match whose trace failed to parse rendered as an id, a timestamp,
  an error, and an invitation to record a verdict. Every predicate in Slices
  3–5 without a natural span would have produced a queue where no message was
  ever shown, with nothing failing when it happened.
- `automod dryrun` printed `41/300 matched · 0 false positive(s)` over a corpus
  where 296 rows were unlabelled — the ADR 0039 failure shape for a third time,
  in the one place it happens on an ordinary day.

**Decorative guards found and fixed across the slice: ten.** A project record,
and the direct product of putting "break it and watch it fail" in every brief.
Two were caught by implementers before shipping; eight by reviewers. Every one
asserted something true about an input where the bug it was named after could
not occur.

**Two factual errors corrected that were not this slice's to begin with:**
the SQLite `ON CONFLICT` claim (false, and propagating out of pre-existing code
into two new repositories), and ADR 0014's direction, which the plan's own
Global Constraints stated as mutual and all nine briefs inherited.

**Plan defects found by the people implementing it: eight**, one in nearly every
task. The pattern from Slice 1 held — the prose was reliable, the code and the
cross-references were not.

## Slices 3+5 rulings (2026-09-02)

Nine decisions the spec and ADR 0040/0041 do not name, taken at plan time so
execution does not stall on them. Full text with costs-if-wrong lives in
[the plan's **Plan rulings** section](superpowers/plans/2026-09-02-slices-3-5-stateless-predicates.md);
this is the index. Numbering continues from Slice 2's PR-1…PR-9.

| # | Ruling | Cost if wrong |
| --- | --- | --- |
| PR-10 | The ReDoS defence is a hard per-evaluation timeout via `node:vm`, not an `re2` dependency. The spec permits either. | An evaluation costs 120 µs instead of 0.05 µs, and a pathological pattern burns the timeout budget per message rather than being rejected outright — bounded and loud, where today it is unbounded and silent. |
| PR-11 | The timeout budget is 25 ms, a module constant, **not** operator configuration. | A legitimately slow pattern over a very long message is reported as a timeout. The only use for a tunable timeout is raising it until the hang returns. |
| PR-12 | A timed-out regex **throws**, surfacing through the existing `EvaluateOutcome.threw` path, once per message. | One error log per message while a rule is degraded. That is the correct noise; returning "no match" would be the ADR 0039 silent failure for a fourth time. |
| PR-13 | The `g` and `y` flags are **refused** by the config schema. Measured, not cautious — see the facts table below. | An operator who typed `g` from habit gets a validation error naming the flag instead of a rule that is wrong every other message. |
| PR-14 | `invite`'s allowlist ships with `label`; **`last_matched_at` is deferred to Slice 9 and its column is not created.** | A rotated partner code sits unnoticed until someone reads the list. **A named spec feature deliberately deferred — flagged to the owner in the closing handoff.** **Slice 4's whole-branch review (IMPORTANT-6) adds a second cost: `last_matched_at` changes with traffic, not configuration, so if it lands on `AutomodRule` without an `EXCLUDED_FIELDS` entry (`fingerprint.ts`) it recompiles — and resets — every windowed rule's window on every message that rule observes, silently. Whoever builds this in Slice 9 must add it to `EXCLUDED_FIELDS` and a fingerprint-stability test in the same change.** |
| PR-15 | `link_domain` matches by **label-wise suffix**, not by computing a registrable domain, and takes no Public Suffix List dependency. | An operator who deny-lists a public suffix (`co.uk`) denies everything under it. Visible in the list, and for a deny list arguably intended. |
| PR-16 | `attachment_type`'s blocked extensions and content types live in `mod_rules.config`, **not** in relational tables. | If Slice 9 wants per-type metadata it needs an additive migration. Additive is cheap; the rebuild path (R-5) is the expensive one, and this avoids it. |
| PR-17 | `caps` measures capitals against **letters**, and strips fenced and inline code spans first. | A message that is entirely a shouted code block is not caught — the safe direction for the predicate the spec singles out as carrying the tier's false-positive risk. |
| PR-18 | `emoji` counts **graphemes** via `Intl.Segmenter`, testing pictographic *or* regional-indicator *or* keycap. | A novel Unicode sequence is counted as more than one. A slight over-count on exotic input, against an operator-set threshold. |

**Why PR-14 and PR-16 are the two to re-examine first.** PR-14 is the only one
that drops a feature the spec names, and it is dropped because implementing it
honestly requires either a hot-path database write on a single-writer SQLite
(`REVIEW.md` §C12) or widening `CompiledPredicate.evaluate`'s return type for
all ten predicates — which is the handoff's "the abstraction failing" test, and
therefore a ruling rather than a workaround. PR-16 is the only one that departs
from a reading of ADR 0040 §3: the ADR enumerates the relational cases and does
not name `attachment_type`, and the ADR's *justification* for relational
(per-item metadata, per-item suppression) does not apply to an extension list.

### Environment facts measured for this slice, not recalled

Recorded here because they cost probes and because the plan's code depends on
them. Full table in the plan.

- **`vm.Script.runInContext(ctx, { timeout })` interrupts catastrophic
  backtracking on this Node.** `^(a+)+$` against 26 a's takes **3052 ms**
  directly; inside a vm context with a 200 ms budget it threw at 204 ms. The
  timeout still fires when the `Script` *and* the context are created once and
  reused, and a context that has already timed out stays usable. This is what
  makes PR-10 possible without a native dependency.
- **Cost of that wrapper: 120 µs/call** against 0.05 µs for a direct `exec`,
  over 20 000 iterations. Affordable on this path.
- **A `g` or `y` flagged RegExp carries `lastIndex` between calls.** On a reused
  `/a/g`: `test('banana')` → true (lastIndex 2), again → true (lastIndex 4),
  then `test('xyz')` → false (lastIndex 0). The same message gets different
  answers depending on what preceded it — and this predicate reuses one
  compiled regex for a rule's whole lifetime. This is PR-13's whole basis.
- **`\p{Extended_Pictographic}` does not match a regional-indicator flag
  (`🇬🇧`), a keycap (`1️⃣`) or `#️⃣`.** All three are single graphemes scoring
  zero pictographic characters, so a pictographic-only counter silently
  under-counts every flag and keycap. `Intl.Segmenter` counts a ZWJ family
  `👨‍👩‍👧‍👦` as **1** grapheme where a code-point scan reports 4. This is PR-18's
  basis, and it is the shape of bug that ships looking correct.
- **`new URL(u).hostname` lower-cases the host and strips port and userinfo**:
  `http://EXAMPLE.com` → `example.com`;
  `https://user:pw@example.com:8443/x` → `example.com`. PR-15 relies on it.

### Slices 3+5 execution log

**Plan review (2026-09-03) — verdict EXECUTE-WITH-FIXES.** 1 blocking, 1
decorative guard, 6 non-blocking; all eight accepted and fixed before any code
was written. Report: [`slices-3-5-plan-review.md`](slices-3-5-plan-review.md).
Fixes recorded in the plan's own "Plan review, and what it changed" table.

The blocking one is worth remembering because it was structural rather than a
typo: **Tasks 3 and 5 built `AutomodRule` literals containing the two fields
Task 6 adds, while the dispatch table ran Task 3 first** — so `npm run
typecheck` failed at a task boundary the plan itself named. Fixed by moving
Task 6 second, ahead of every predicate, so each literal is written once against
a finished interface. The decorative guard was the regex span test: its fixture
made `indexOf` and the engine's index agree, so it could not fail for the bug it
was named after. **Both were mine, and both are the shapes this run keeps
producing** — a cross-task sequencing error, and a fixture too simple to reach
its own branch.

**Dispatch A (Tasks 1–2, OD-3's attachment corpus) — complete.** Commits
`d48a1c4` (storage) and `cd34d0e` (core). **2159 tests / 102 files** from 2148,
typecheck and lint clean, **gates re-run by the coordinator** rather than taken
on report. The +11 is 6 new tests plus 5 `it.each` cases that
`schema-invariants.test.ts` generates automatically for each new
guild-partitioned table.

Verified personally, not on report: migration `0013_concerned_leo.sql` is a pure
`CREATE TABLE … STRICT` with `ON DELETE cascade` and **no rebuild** (the R-5
hazard is avoided); `PRIVACY.md`'s attachment line is in `d48a1c4`, the *same
commit as the migration*, as OD-3 obligation 1 requires; and the superseded
half of PR-3's comment in `evaluate.ts` was rewritten to name OD-3, while the
half about *mentions* — which still holds — was correctly left alone.

Three findings from this dispatch worth carrying:

1. **The cascade guard fails by a different route than the plan predicted, and
   is still not decorative.** With `foreign_keys = ON`, removing
   `ON DELETE cascade` makes the parent `DELETE` itself throw
   `FOREIGN KEY constraint failed` — the orphan-count assertion is never
   reached. So the assertion's own failure mode is narrower than it looks: it
   fires only if foreign-key enforcement is *off*, which is precisely the state
   R-5 puts a migration run into. It earns its place for that reason, not the
   one the plan gave.
2. **A plan file-list gap: `captureObservedFixture` had nine call sites the
   plan did not name** (`mod-cases.test.ts` ×2, `mod-match-reviews.test.ts` ×6,
   `ops.integration.test.ts` ×1), all broken by making `attachments` required.
   Found by running `typecheck`, not by reading. When a plan makes a field
   required on an existing interface, its file list is a lower bound.
3. **`d48a1c4` on its own does not typecheck** — `wiring.ts`'s port
   implementation is Task 2's to fix, so the storage commit is red in isolation
   and green once `cd34d0e` lands. Not rewritten, following this ledger's own
   precedent for `7be2e4f`: subagent reports already name these SHAs. **The
   lesson for later tasks: an interface change that spans packages belongs in
   one commit**, because a monorepo with a single `typecheck` has no way to make
   the intermediate state green.

**Dispatch B (Task 6, the relational lists) — complete.** Commit `84f4d9e`.
**2174 tests / 102 files** from 2159, typecheck and lint clean, gates re-run by
the coordinator. Migration `0014_lethal_xorn.sql` verified personally: two pure
`CREATE TABLE … STRICT` with cascading composite foreign keys to
`mod_rules(guild_id, rule_id)`, and **no rebuild** — `rg` for
`__new_|DROP TABLE|RENAME` returns nothing.

**Obligation 2 is met, and was watched failing.** Adding `inviteAllowlist` to
`EXCLUDED_FIELDS` turned both invite fingerprint tests red; restored, green.
The hydration guard was watched too: dropping the `rule_id` predicate from the
two new `hydrate` queries leaked a `link_domain` row onto the `invite` rule and
turned the two-rules-each-with-entries test red. Both are real mechanisms, not
tautologies.

One detail in the implementation worth keeping: `canonicalise` makes
`listType` **part of the sort key** for `linkDomains`, not a value carried
alongside it. Without that, a domain moving from `allow` to `deny` would produce
the same canonical structure in a different order and the digest would not
change — a rule whose meaning inverted while its compiled artifact stayed
cached.

**PR-19 (2026-09-03) — the two relational lists get a CLI write path in this
slice, as Task 9.** Dispatch B correctly flagged that it had built repository
functions with no caller: nothing outside a test can add an invite code or a
link domain. Recorded as a ruling because it is a scope decision, not a bug fix.

*Why it cannot wait for the dashboard.* `observe` mode never touches Discord
(`subscriber.ts`: "Non-enforce modes never touch Discord at all"), so an empty
allowlist is harmless during the window — **but it makes the window's data
useless for the one rule it affects.** An `invite` rule with an empty allowlist
fires on the club's own invite links, every time anyone posts one. Slice 6's
gate requires **zero** false positives for a rule that feeds the escalation
counter and a 20-match minimum before a rate means anything, so that rule
cannot pass its gate until the allowlist is populated — and the spec's own
pre-flip rehearsal exists precisely so this is found on the day rather than two
weeks late. A list an operator cannot write to is not a shipped feature.

*Scope.* A CLI surface only, following Slice 2's PR-6 precedent, which already
established the `automod` command namespace (`dryrun`, `review`, `verdict`).
**Not** the dashboard — that is Slice 8 and stays there. *Costs if wrong:* two
more commands in `--help`, which is what PR-6 paid for the same reason.

**Dispatch D (Tasks 5, 7, 8 — `attachment_type`, `invite`, `link_domain`) —
complete.** Commits `30fee50`, `2f4ca8e`, `dc9933f`. **2203 tests / 105 files**
from 2174, typecheck and lint clean, gates re-run by the coordinator.

**Obligation 3 is met, and the coordinator watched it fail personally rather
than taking it on report.** Setting `attachments: []` back in
`predicateInputFrom`'s fixture branch fails **exactly one** of
`dry-run.test.ts`'s ten tests — the new attachment gate,
`expected undefined to be defined` at line 237 — while the other nine, including
the pre-existing `keyword_filter` one-code-path gate, stay green. Restored,
10/10. That contrast *is* the obligation: the behavioural gate was blind to
every field no shipped predicate read, and it no longer is.

**The implementer improved on the plan here and was right to.** The plan's Task 5
snippet called `predicateInputFrom` and `evaluateRule` directly, which
`dry-run.test.ts` does not do — it compares the **live subscriber** against
`runDryRun`. The implementer adapted the new test to the file's real shape, so
the gate now drives `createAutomodSubscriber(...).handle(messageEvent(...))` and
compares its recorded trace, category and snippet against the replay. That is a
stronger comparison than the plan asked for, because it goes through the
subscriber's own path rather than around it.

**A coordinator arithmetic error, corrected by the implementer.** Dispatch D's
brief said `predicateFor` would cover "five of ten kinds if dispatch C has not
landed". It is **four** — `keyword_filter` was the only pre-existing entry, plus
this dispatch's three. The implementer flagged it in its report rather than
quietly reconciling, which is exactly the instruction. Recorded because the
briefs are written from the coordinator's memory of the registry and that memory
was wrong; the count belongs in `rg` output, not in a brief.

**Dispatch C (Tasks 3, 4 — `regex`, `caps`, `emoji`) — complete.** Commits
`9b779fc`, `56bd768`. **2221 tests / 108 files** from 2203, typecheck and lint
clean, gates re-run by the coordinator.

**Obligation 1 is met, and the coordinator watched the ReDoS gate fail
personally — with a result that corrects this plan.** Replacing
`script.runInContext(context, { timeout })` with a direct
`pattern.exec(messageInput.content)` and running `regex.test.ts` produced **no
output at all**: the run hung until an external `timeout 45` killed it
(SIGTERM, exit 143). Restored, 8/8 green.

**The plan predicted the wrong symptom, and the difference matters.** It said
the hang "will be observed as vitest's 20-second per-test timeout firing".
**Vitest's timeout never fires** — catastrophic backtracking is synchronous
CPU-bound work, and it blocks the very event loop vitest's timer needs to
notice. So the failure mode of an unprotected `regex` predicate is not a slow
test, it is a **wedged process**, which is precisely what the handoff meant by
"takes moderation down for the whole guild".

This is also the strongest available argument for PR-10, stronger than the one
the ruling gives: a `vm` watchdog running on its own thread is not merely *a*
way to bound a runaway pattern, it is the **only** mechanism available in
JavaScript that can interrupt one. A `setTimeout`, a promise race, an
`AbortSignal` and vitest's own timeout all lose to the same blocked loop.

**A structural consequence for Slice 4, found here and worth having in advance.**
Registering `caps` broke four pre-existing tests that used `'caps'` as their
"a kind with no registered predicate" fixture; the implementer correctly
repointed them to `'mention_spam'`
(`predicates/registry.test.ts` ×3, `ops/commands/reads.test.ts`, and the
`no-predicate` assertions in each).

**Slice 4 registers the last three kinds, and at that point no real `RuleKind`
value is left to stand for "unregistered".** `resolveConfig` checks
`isRuleKind` *first*, so a made-up string yields `unknown-kind`, never
`no-predicate` — the two failures are deliberately different and a cast cannot
reach the second. So Slice 4 must do one of these, deliberately:

1. give the registry a test seam (a `predicateFor` that can be asked about an
   empty registry, or an injectable `PREDICATES`), keeping `no-predicate`
   tested; or
2. delete those four assertions **and say in the ledger that the branch is now
   unreachable except via a future eleventh kind** — which is a real guard worth
   keeping in the code even with no test, since R-2 widened the SQL CHECK to all
   ten kinds ahead of the predicates precisely so an unshipped kind was inert
   and loud.

Either is defensible; silently discovering four red tests is not. Note that
`doctor`'s unusable-rules check does **not** lose its teeth either way —
`invalid-config`, `compile-failed` and R-12's `no-terms` all remain reachable.

*Second time this shape has bitten.* R-10 already recorded a test whose `caps`
fixture exercised `no-predicate` rather than the `invalid-config` path its name
implied. **Using a real-but-unshipped kind as a stand-in for "unregistered" is
inherently temporary**, and it expires on a schedule the test does not mention.

**One more plan defect from this dispatch:** Task 3's test snippet imported
`regexConfig` without using it, which fails `typecheck` under this repo's
settings. Removed by the implementer.

**Dispatch E (Task 9, the CLI write path) — complete, recovered from the working
tree.** Commit `1963723`. **2240 tests / 109 files** from 2221, typecheck and
lint clean.

**A usage limit killed the implementer at its commit step**, after the code was
written and passing. Recovered rather than re-run, per the handoff's own
instruction — the third time that has paid on this project. What the coordinator
had to finish: `prettier --write` on three files, the break-it-and-watch-it-fail
guard, the gates, and the commit. **Cost of recovery: four commands. Cost of
re-running: a whole dispatch.** Worth stating plainly because the instinct on
seeing a failed agent is to start it again.

**The guard, watched by the coordinator.** Task 9's end-to-end test reuses **one**
predicate cache across both evaluations — which is what makes it prove
fingerprint invalidation rather than working around a cache that was never
populated. Adding `inviteAllowlist` to `EXCLUDED_FIELDS` turns it red with
`Expected "no-match", Received "match"`: the operator adds their own club's
code, the row is in the database, hydration returns it, **and the rule still
fires off the stale compiled artifact.** That is ADR 0039's failure mode
observed from the operator's side rather than at the unit level, and it is the
first test on this project that reaches it end to end. Restored, 2/2 green.

**A coordinator correction, recorded rather than tidied away.** On finding
`automod-rule-lists.test.ts` untracked, the coordinator said dispatch B had
"never committed its test file". That was wrong — the file is dispatch E's, and
nothing of dispatch B's was uncommitted. But checking it turned up a real,
narrower gap:

**Task 6 shipped 171 lines of repository with no dedicated test file**, contrary
to its own file list in the plan (`automod-rule-lists.ts` **+ `.test.ts`**).
Dispatch B put a hydration test in `automod-rules.test.ts` and the fingerprint
guards in `fingerprint.test.ts` — both real, both committed — and those exercise
`addInviteAllowlistEntry` and `addLinkDomain` through the real functions. But
**`listInviteAllowlist`, `listLinkDomains`, `removeInviteAllowlistEntry` and
`removeLinkDomain` had no coverage at all** until Task 9's commands began
calling them.

*How it got past the coordinator:* dispatch B's five-line report was accurate
about what it did, the gates were green, and the missing file was invisible in a
test count that went up by 15. **A plan's file list is a checklist the
coordinator has to tick, not a prediction** — the same lesson as dispatch A's
"file list is a lower bound", running the other way. Carried to the whole-branch
review as a specific thing to look at.

## Slices 3+5 closed (2026-09-03)

**19 commits since Slice 2 closed. 2267 tests / 109 files**, from 2148 at the
branch point — none deleted. Typecheck and lint clean. **Every gate run by the
coordinator, and every obligation guard watched failing by the coordinator
personally**, not taken on report.

Whole-branch review (strongest model) returned **SHIP-WITH-FIXES**: 2 CRITICAL,
8 IMPORTANT, 7 MINOR. All ten CRITICAL and IMPORTANT findings fixed across two
sequential fix waves, three decorative guards closed, one MINOR fixed. The
re-review returned **ADDRESSED-WITH-RESIDUAL** and found **two new defects in
the fixes themselves**; both are fixed (`9c9a52b`).

**Both CRITICALs were the coordinator's, and both were cross-task — invisible to
any per-task review.**

- **CRITICAL-1: ruling PR-12 collided with Slice 2's dry-run reporting.** PR-12
  chose a *throw* over a silent non-match for a timed-out regex, arguing a throw
  is better "because `evaluateRule`'s caller logs it". True of the subscriber.
  **False of the dry run, which has no logger by design** — and `runDryRun`
  folded `threw` into a plain non-match, leaving `usable: true`. So a
  catastrophic pattern over 300 fixtures reported
  `0/300 matched · 0 false positive(s) of 300 labelled · 0 missed` when *every
  evaluation timed out*. **The fourth appearance of the ADR 0039 shape on this
  project.** A ruling that is sound for one caller is not sound for all of them,
  and PR-12 named the wrong reason for being right.
- **CRITICAL-2: a comment in the plan asserted the wrong failure direction.**
  `link_domain` had no empty-list guard, because `compileRule`'s `no-terms`
  check was hard-scoped to `keyword_filter`. With `mode: 'allow'` and no allow
  rows, **every link matched** — in `enforce`, every message containing a link
  deleted. The plan's comment claimed inferring mode from rows "would silently
  change the rule from a whitelist into a no-op". It does not become a no-op; it
  becomes match-everything. Now guarded (inert and loud, reported by `doctor`),
  with the `invite` asymmetry stated in a comment: an empty *invite* allowlist
  is correct and useful, because its single list does not invert on emptiness.

**The most instructive IMPORTANT: I verified a library fact in one direction
only.** IMPORTANT-8 — the plan's own facts table records that
`\p{Extended_Pictographic}` **under**-counts (misses flags, keycaps, `#️⃣`), and
that was measured and fixed. Nobody checked the other direction: it is *also*
true for `©`, `®`, `™`, `‼`, `↔`, `▪`, `☑`, `♀`. So a bulleted list written with
`▪` counted as emoji against a threshold that can be 1 — a false-positive source
inside a predicate, in the slice whose release gate **is** a false-positive rate.
**"Verify, do not assert" has a corollary: verify both directions of a
boundary.** A measurement that confirms what you expected is half a measurement.

**A privacy ruling taken rather than escalated (IMPORTANT-4).**
`attachment_type`'s snippet was the raw filename, so it reached
`mod_case_events.matched_snippet` — a moderation record `/forgetme` does **not**
delete and which OD-3's approval never covered (the owner was asked about the
*corpus*). Rather than widen retention and need a fresh approval, the snippet is
now redacted to extension, content type and size, and the filename stays in the
corpus where `/forgetme` reaches it. **The decisive argument was not caution: the
predicate matches on type and extension, never on the name, so the filename was
never the decision basis and does not belong in the enforcement record.** The
owner can reverse this with one word — see the handoff.

**The re-review's two residuals, and one of them was wrong.**

1. **Valid.** CRITICAL-1's fix hardened `agreement` for a thrown fixture and left
   the sibling `falsePositives`/`falseNegatives` tallies keyed on `matched`, so a
   `should_match` fixture that threw counted as a miss. Watched failing:
   `falseNegatives` was **2** where it should be 0. **The CLI text was already
   protected, which is precisely what would have let the wrong number survive in
   `data.falseNegatives`** — the field Slice 6's gate reads as a machine. A
   human-facing guard is not a machine-facing guard.
2. **Premise false, and now pinned by a test.** It claimed a crafted filename
   writes an unbounded string into `trace.matchedOn`. Matching is **set
   membership against configured values**, so a value the operator did not
   configure never matches and no trace is built; `matchedOn` is bounded by the
   config schema (20 chars for an extension, 255 for a content type) and a member
   cannot lengthen it. Truncating it would have been *harmful*, not merely
   unnecessary — `matchedOn` is the configured thing that matched, which is what
   Slice 9's one-click suppression acts on (ruling R-8 exists because that field
   once carried the wrong thing). **A reviewer's recommendation is a hypothesis;
   this one was checked and rejected with a test recording why.** Its valid half —
   `trace.ts`'s comment crediting `detail`'s `.max(120)` with covering the whole
   trace — is fixed.

**Decorative guards found in this slice: four.** One by the plan review before
any code (the regex span test, whose fixture made `indexOf` and the engine agree),
three by the whole-branch review — the four CLI suites that could not fail for
three of the findings they appeared to cover, `link-domain.test.ts` with no
empty-list case in either mode, and `caps`' code-stripping test passing for two
reasons at once. **Running total on this project: fourteen.**

**Plan defects found by the people implementing it: five** — a cross-task
sequencing error that broke `typecheck` at a boundary the plan itself named, an
unused import, two test helpers called but never defined, an ordering
self-contradiction (deliberate), and a file list that under-named nine call
sites. The Slice 1–2 pattern held again: **the prose was reliable, the code and
the cross-references were not.**

### A second worktree, and E-1 confirmed fixed by `npm ci`

Slices 3–6 run in `.claude/worktrees/release2-slices-3-6` on branch
`worktree-release2-slices-3-6`, branched from `main` at `f6bddff` (the merge of
Slices 1–2). The Slices 1–2 worktree is still locked by a live process, so it
could not be reused.

**E-1's fix is confirmed to be `npm ci` inside the worktree**, which takes ~5 s
against a warm cache and creates `node_modules/@bananasaurs/*` symlinks pointing
at *that worktree's* packages. Verified before any gate was trusted: baseline in
the new worktree is **2148 tests / 102 files, typecheck and lint clean** — which
matches this ledger's Slice 2 close-out exactly, and is what proves the gates
are measuring this worktree rather than the main checkout's `dist`.

## Slice 4 rulings (2026-09-03)

Six decisions the spec does not name, taken at plan time. Full text with
costs-if-wrong in
[the plan](superpowers/plans/2026-09-03-slice-4-window-tier.md); this is the
index. Numbering continues from PR-19.

| # | Ruling | Cost if wrong |
| --- | --- | --- |
| PR-20 | `duplicate_message` gets its **own** documented normalisation — `stripZeroWidth` (imported, not copied) plus lowercase and whitespace collapse — because the spec's "same code the keyword matcher uses" is **not achievable**. | Two members posting the same text with different leetspeak are not treated as duplicates. The safe direction, and widening is additive. |
| PR-21 | Window state lives on the **compiled artifact**, in `compile`'s closure, not module state. | A config edit resets that rule's window — correct, since a changed threshold should not be judged against counts accrued under the old one. Commented, or it reads as a bug. |
| PR-22 | Two independent caps — a per-member ring buffer and a cap on members tracked — and exceeding the member cap **evicts** rather than refuses. | Under a raid larger than the cap, the earliest members' counts restart. Bounded and documented; refusing to track would make the rule stop working under exactly the load it exists for. |
| PR-23 | The window tier counts `messageCreate` only and ignores `messageUpdate` (ruling R-13 exists for this). | A member who edits a message to add spam is not *rated*, though content predicates still fire on the edit. Counting edits would make an ordinary typo-fixer trip a spam rule. |
| PR-24 | `mention_spam` is stateless and never touches the window store, despite the spec's tier grouping. | Nothing. Recorded so a reader comparing spec to code does not think a window was forgotten. |
| PR-25 | **A differential gate detects only *asymmetric* divergence**, so a "break it" target must sit on exactly one side of the comparison. | Task 5b would report Obligation 1 discharged without having exercised it. |

**PR-20's third option was examined and rejected**, and the reason is not the
obvious one. `obscenity` *does* export the transformer factories, so the
dispatch loop could be hand-rolled — but it would depend on an undocumented
container discriminant with no compatibility guarantee **and still omit
`collapseDuplicatesTransformer`**, whose thresholds need a word list this
predicate does not have (ADR 0039). The cost buys a brittle, partial subset of
the matcher's behaviour, which is worse than an honest simple normaliser. Two
obstacles were verified in `node_modules`, not assumed: `TransformerSet` is
absent from the package index, and `matcher.ts` exports no string→string
normaliser.

**PR-25 is the one to remember, and it came from the plan review catching two
guards that could not have gone red.** The one-code-path gate compares the live
subscriber against the dry run, so **a bug in the code they share cannot make
them disagree** — it makes both wrong together and the comparison stays green.
That is what the gate *is*, not a weakness in it: `evaluate.ts`'s own header
already says it proves the two callers are the same code, not that the code is
correct. Both of the first draft's exercises violated it — one corrupted
`evaluateRule` (shared, so symmetric), and one used a clustered burst whose
verdict is unchanged when the replay clock is replaced by `Date.now()` (which
also clusters). **Only a sequence spread *beyond* the window distinguishes a
wrong clock**, and only an asymmetric corruption distinguishes a bypassed cache.

### Slice 4 execution log

**Plan review (2026-09-03) — EXECUTE-WITH-FIXES**, 2 blocking, both in Task 5,
both the coordinator's, both PR-25's mistake. Also three non-blocking fixes
accepted: an exported `DEFAULT_MAX_TRACKED_MEMBERS` so the two windowed
predicates cannot drift to different undocumented caps, `minLength` defaulting
to 0 rather than the plan quietly choosing a false-negative rate on the
operator's behalf, and PR-20's rejection reason corrected from "it's a deep
import" to "it is fragile *and* still unfaithful". **No decorative guards found
in Tasks 1–4.** Report: [`slice-4-plan-review.md`](slice-4-plan-review.md).

**Dispatch A (Tasks 1–2) — complete.** `7cec46c` (window store), `6dd61da`
(`mention_spam`). Four guards watched failing, including dropping `guildId` from
the window key. The implementer caught and fixed a real eviction-design bug
before it shipped.

**Dispatch B (Tasks 5a, 3, 4) — complete.** `d906bcc` (the registry seam),
`eaf638b` (`rapid_spam`), `3a43ee1` (`duplicate_message` — **the tenth and last
predicate kind**). **2302 tests / 113 files.**

**Task 5a was moved to the front of dispatch B by the coordinator**, and the
reason is a churn pattern worth naming. Obligation 3's four placeholder tests
stand a real-but-unshipped kind in for "unregistered", and they had been
repointed **three times** — `caps`, then `mention_spam`, then `rapid_spam` — each
repoint correct in isolation. Dispatch B ships `rapid_spam`, so leaving the seam
until Task 5 would have forced a fourth and then a fifth. The seam is
`compileRuleWith(registry, rule)` with `compileRule` delegating over the shipped
registry, so those tests assert against an **empty** registry and state their own
premise. **A fixture whose validity expires on a schedule the test never
mentions is a decorative guard waiting to happen.**

### E-5 — a gate piped through `tail` reports its own success

**The lint gate was red from `7d560d9` until `c02ea83`, and the coordinator
reported it green twice.** Three files were committed unformatted by fix wave B.

*Cause, which is the method rather than the files.* Gates were being checked as
`npm run typecheck 2>&1 | tail -2 && npm run lint 2>&1 | tail -2 && …`. Piping
through `tail` makes the pipeline's exit status **`tail`'s**, which is 0
whatever npm did, so `&&` chains onward past a failure — and a truncated tail
was being read as a pass.

*The fix, now standing practice:* run each gate separately and check `$?`, or
`>/dev/null 2>&1; echo $?`. **Never chain gates through a pipe.** Carried into
every brief from here on, and it is why dispatch B's brief said so explicitly.

### A mechanism whose guard cannot be written

Dispatch B reported, plainly rather than quietly reconciling it, that the plan's
"never prune" guard **did not reproduce**: disabling the window's age-based
pruning changed nothing any test could observe. That report was correct, and it
condemned the mechanism rather than the test.

`countWithin`/`countMatching` filter by the window on *every* call, so
correctness never came from pruning; and `maxEventsPerMember` is applied on every
`record`, so memory was already bounded. Pruning bought a slightly smaller
steady-state array inside an already-capped buffer, and cost a
`maxObservedWindowMs` field, a `noteWindow` call in both read methods, and a doc
comment arguing that lazily pruning against the largest window ever observed was
safe. **Deleted** (`6bbc60a`).

**The rule this yields: a mechanism whose guard cannot be written is a mechanism
to justify or delete.** "Break it and watch it fail" has been treated as a test
quality check; here it worked as a *design* check, and that is the more valuable
use.

## Slice 4 closed (2026-09-04)

**2312 tests / 113 files**, from 2267 at the slice's start — none deleted.
Typecheck, lint and test all verified by **exit code** by the coordinator.
**All ten predicate kinds `mod_rules_kind` permits now have an implementation.**

Whole-branch review (strongest model) returned **SHIP-WITH-FIXES**: 3 CRITICAL,
6 IMPORTANT, 6 MINOR — and it confirmed all three CRITICALs **by running the
built code**, not by reading it. One fix wave, then a re-review that found a new
CRITICAL *in* the fix wave, then that fix, then one more gap closed. All three
CRITICALs trace to this plan.

**CRITICAL-1 — `duplicate_message` never fired if the member said anything
between repeats.** The plan told Task 4 to size its buffer from its own config
by analogy with `rapid_spam`. **The analogy is false:** `rapid_spam` counts
*every* event in its buffer, so `maxMessages + 1` always holds the "one too
many"; `duplicate_message` counts only events matching *this* text
(`countMatching`) while `record` puts every message in the same buffer. Measured
at four configurations: interleaved repeats fired at index `null` — never. **The
evasion was typing `lol` between posts**, which is also the ordinary shape of the
spam it exists for. And the test named for exactly this used three messages
against a buffer of three, so nothing evicted and it stayed green.

**Then the fix reintroduced the same failure at the other end.** Replacing the
threshold-scaled buffer with a *flat* `DEFAULT_MAX_EVENTS_PER_MEMBER = 50` made
every `maxRepeats >= 50` unreachable — roughly 95% of the range the config
schema permits — silently, with no log line and no `doctor` entry. Caught by the
re-review running 61 consecutive identical messages, the easiest possible case.
**The lesson: the buffer needed a *floor*, not a replacement.**
`Math.max(DEFAULT_MAX_EVENTS_PER_MEMBER, maxRepeats + 1)` — the floor buys
interleaving headroom, the second term keeps the threshold reachable. Both terms
load-bearing; each alone is a total failure at one end.

**CRITICAL-2 — the `minLength: 0` default made two captionless images a match.**
That default came from an accepted plan-review fix, on the reasoning that a
non-zero default would "quietly choose a false-negative rate on the operator's
behalf". Sound, and it considered short text while never considering **absent**
text: an attachment-only message has `content === ''`, so `''` became the
member's repeated "text". `snippet=""`, a case opened, on the default config, in
the most ordinary thing that happens in a club's photo channel. **This is the
"verify both directions of a boundary" rule from this slice's own handoff,
written by the coordinator and then not applied to the coordinator's own
default.** The ruling stands untouched — refusing to invent a floor is not the
same as matching on the absence of content.

**CRITICAL-3 — a windowed rule's dry-run count is wrong in both directions.**
The corpus holds only *already-matched* messages, so the events that built a
window count are absent by construction and a perfectly working rule reports
`0/3 matched · 3 missed`. The dangerous reading arrives at flip day: *"this rule
barely fires over 300 fixtures, it is safe to enforce."* Meanwhile PR-1 gives
each edit its own row that the fixture branch replays as a create, over-counting
rate rules. `automod dryrun` **already carried this exact caveat pattern** for
`attachment_type` — a strictly weaker version of the same problem — and Slice 4
did not extend it. Fixed, both directions, in text and in `data`.

**One more gap closed after the re-review argued it was worse than it looked.**
`predicateInputFrom` maps every handwritten fixture's null author to one literal,
so a windowed rule replayed over handwritten fixtures sees **one member's
burst**. The scenario that bites is the natural pre-flip check — "three different
members each post this phrase once, which must not trip `duplicate_message`" —
which collapses and **matches**. The tool answers the opposite of the truth about
the one property an operator would use it to check, and it takes two rows. The
new guard's own failure output is the evidence: `1/2 matched` for two fixtures
meant to be two different people. **Warned loudly; the real fix needs a way to
express authorship on a handwritten fixture without storing member data — a
migration, carried to Slice 9.**

### What Slice 4 teaches that the earlier slices did not

1. **A false analogy in a comment is worse than no comment.** CRITICAL-1
   survived per-task review because the doc comment *asserted* the sizing
   reasoning as settled. Task 1 reviewed a correct buffer; Task 4 reviewed a
   correct call into it; the defect lived only in the arithmetic relating them,
   and the comment that should have raised it closed the question instead.
2. **Fixing a bound at one end can break it at the other.** Both of
   `duplicate_message`'s buffer defects were "capacity wrong relative to
   threshold", in opposite directions, and the second was introduced *by the fix
   for the first*. When a fix changes a bound, test both ends of its range.
3. **Run the code.** All three CRITICALs were confirmed by executing the built
   predicate at several configurations. Reading found none of them in per-task
   review, and reading would not have found them here either.
4. **"Verify both directions of a boundary" applies to the coordinator's own
   rulings.** It was written into this slice's handoff, and CRITICAL-2 is that
   rule being broken by the person who wrote it, in the same slice.

**Decorative guards found in Slice 4: two** — CRITICAL-1's namesake test, and
one caught by the plan review before any code. **Running total: sixteen.**

**Plan defects found by implementers: four**, including two "break it" exercises
that could not have gone red (PR-25) and a zero-width test fixture whose literal
form could not pass under the normaliser PR-20 mandates — reported plainly rather
than reconciled, which is the instruction working.

## Slice 6 rulings (2026-09-05, in progress)

PR-26…PR-30 were taken at plan time; full text with costs-if-wrong in
[the plan](superpowers/plans/2026-09-04-slice-6-release-gate.md). PR-31 and
PR-32 were taken during execution and are recorded here first. Numbering
continues from PR-30.

| # | Ruling | Cost if wrong |
| --- | --- | --- |
| PR-31 | Test call sites that need enforce mode reach it **through** the gate, via one named `makeRuleEnforceableForTest` helper that writes `cutover_state = 'ready'` and a sign-off — never around it. | If they bypassed `setRuleMode`, the gate would have no exerciser outside its own unit test and a regression in it would surface in production. If instead every integration test seeded a real 20-match review corpus, a later change to the gate would break tests that are not about the gate. |
| PR-32 | This slice's columns take **three** `db:generate` runs, not the two ruling R-6 prescribes: plain nullable columns, then defaulted columns, then the CHECKs alone. | Generating a column together with its CHECK emits a rebuild whose `INSERT … SELECT` reads a column the old table does not have yet — R-6's exact shape. Splitting the adds from the CHECKs is what keeps 0017's fifteen-column `SELECT` valid. |
| PR-33 | `automodTestingMode` goes on **storage's** `SafetyState` and on an automod-specific core type, **not** on `ModerationSafetyState`, which stays at its three fields. | `purge.ts` passes that same state to `classifyRefusal`, so widening the shared type would let the automod lever gate moderation. A comment saying "only automod reads this" is caller discipline; CLAUDE.md rule 2's stance is that the constraint belongs in the signature. |
| PR-34 | `automod_testing_mode` is checked **ahead** of the `delete_blocked_*` block, so with both levers set the event records `would_delete` rather than `delete_blocked_killswitch`. | `delete_blocked_killswitch` means "automod tried to act and an emergency lever stopped it"; under testing mode automod never tried. The wrong order misattributes a deliberate configuration choice to an emergency. The cost — the event row does not show the killswitch was also engaged — is acceptable because the killswitch is guild-wide and `doctor` reports it. |
| PR-35 | `doctor`'s observe-window check keys on `cutover_state = 'observing'`, **not** `mode = 'observe'` as the plan and its brief both said — and filters `enabled = 1`, which the sibling enforce-state check deliberately does not. | Keying on `cutover_state` makes `doctor` report exactly the rules for which `automod ready` is available, and it is self-consistent: the gate refuses `enforce` from `observing`, so an `observing` rule is necessarily in a recording mode. Keying on `mode` would report a rule whose journey has not started. The `enabled` filter is the difference between a workflow prompt and a latent hazard — see below. |

**PR-31 exists because of what `setRuleMode`'s gate does to three integration
test files.** ADR 0042 is right that `setRuleMode` has no production caller —
that is why widening its return type from `void` is cheap. But
`apps/daemon/src/automod.integration.test.ts` (twice),
`apps/daemon/src/native-automod.integration.test.ts` and several tests in
`automod-rules.test.ts` do call it with `mode: 'enforce'`, and they assert real
deletions and real case events. `cutover_state` defaults to `not_started`, so a
gated `setRuleMode` refuses them, the rule stays in `test`, and the assertions
fail **pointing at the subscriber** — while the real cause is an ungranted
sign-off three files away. That is ADR 0039's failure shape (a rule that looks
configured and silently does not fire) reproduced inside the test suite, and it
is the fifth time this run has hit it.

**PR-32 is R-6 confirmed on a second table, and the confirmation cost a
blocked task first.** The Slice 6 plan initially forbade a `mod_rules` rebuild
outright, citing R-5's cascade hazard — a coordinator error already recorded in
ADR 0042's Amendment 1: R-5's *fix* shipped in Slice 1, and `runMigrations`
disables `foreign_keys` at the connection level around the whole run. What
survived the correction is the narrower mechanical point: SQLite cannot add a
CHECK constraint to an existing table at all, so **every** new
CHECK-constrained column forces a rebuild, and the rebuild is only valid if the
columns it selects already exist. Hence three runs.

**Amendment 1's safety claim is now watched, not recalled.**
`schema-invariants.test.ts` gained a negative control: the same migrations
against the same seed, run through `migrate()` directly without
`runMigrations`'s connection-level `foreign_keys = OFF`, and all five child row
sets come back empty. They do. That also settles a question about someone
else's library rather than assuming it — 0017 carries an in-file `PRAGMA
foreign_keys=ON` (drizzle-kit emits one per rebuilt table) which would re-arm
the cascade for the `mod_rules` half if it took effect, and it does not,
because `migrate()` wraps the file in a transaction where SQLite documents that
pragma as a no-op. The plan asked for a revert-and-forget experiment; keeping it
as a test means the survival proof above it can never quietly become vacuous.

**Tasks 2+3 shipped two defects, both caught in coordinator verification rather
than by the dispatch's own gates, and both of a kind the gates cannot catch.**

The first: `enforcementEligibility`'s low-volume check returned `ok` outright
when a rule was under `min_reviewed_matches` and carried a sign-off, skipping
the zero bar and the rate entirely. A rule with five `mod_match_reviews` rows,
every one `false_positive`, plus a sign-off, was eligible to enforce. The
reasoning that fixes it is worth keeping: a sign-off attests a clean dry run
over the **fixture corpus** (PR-29), and a corpus is *authored*, while a verdict
row is a judgement recorded against traffic the rule actually matched. The
weaker evidence may not excuse the stronger. So the sign-off clears the volume
floor and nothing else. Fixing it also made `reviewed === 0` reachable at the
rate check, where `0 / 0` is `NaN` and every comparison against it is false —
passing the gate by accident rather than by decision.

The second: `setRuleMode` owns four of PR-27's five arrows and the dispatch
implemented one. **The brief caused it**, by pointing at the plan's
"Interfaces" block instead of PR-27's table, where `not_started → observing`,
`cutover → rolled_back` and `rolled_back → observing` are all assigned to that
same function. Left alone, nothing in the codebase would ever have written
`observing`, so Task 6's `automod ready` — which refuses unless the rule *is*
`observing` — could never have succeeded, and `rolled_back` would have been
unreachable. **That is the identical defect the plan review already caught in
PR-27's own first draft:** the states unreachable and the safety property false.
Catching the same defect twice in one slice, once in the plan and once in the
brief written from it, says the failure is in how the state machine is
handed over, not in either author.

Three properties of that machine are load-bearing and each now has its own
test. A rule already `observing` does not restart its clock, or `doctor`'s
observe-floor check would read as reassuring while never firing. `cutover` plus
`mode: 'observe'` lands on `rolled_back`, not `observing` — one step to
`observing` would skip the state `automod ready` refuses from, which is the
whole of what stops a rollback being undone by retrying. And a disable is not a
rollback: it requests no mode change, and `cutover` stays true across a pause.

**One of those five tests passed on arrival**, which makes it a regression fence
and not evidence of test-first work. Recorded as such rather than counted as a
guard: a mutation letting a disable enter the state machine turns it red, which
is the only reason it is worth keeping. The distinction matters because sixteen
of this project's decorative guards were tests that passed and were assumed to
mean something.

**A green mutation means one of two things, and this run confused them once.**

Tasks 4+5 came back clean, and the one thing worth a guard was an ordering the
dispatch had chosen well but left untested: `automod_testing_mode` is checked
ahead of the `delete_blocked_*` block, so with both levers set the recorded
action is `would_delete` (PR-34). Nothing would have gone red if a later reader
tidied that branch downwards, so a test went in to pin it.

The first mutation written to check that test moved the branch below the
**computation** of `blocked`, and all 47 tests stayed green. The tempting
reading — the eighteenth decorative guard — was wrong. `blocked` is only
*assigned* at that point; the testing-mode branch still `continue`s before
anything reads it, so the mutation changed no behaviour at all. Moving the
branch below the block that **uses** `blocked` turns exactly the new test red
and leaves the other 46 green.

So the rule to carry forward: **a mutation that stays green means either an
unfalsifiable test or a mutation that changed nothing, and the two demand
opposite responses.** Sixteen decorative guards on this project were found by
mutating and watching nothing happen; the seventeenth was found the same way.
That track record makes "green mutation ⇒ decorative test" a fast and usually
correct inference, which is exactly what makes it dangerous — the one time the
mutation is at fault, the same reflex deletes a working guard. Check that the
mutation moved the behaviour before concluding anything about the test.

**Task 6's two `doctor` checks differ on `enabled`, and the difference is the
whole distinction between a hazard and a chore.**

`listEnforceRulesWithBadCutoverState` ignores `enabled` on purpose. A disabled
`mode = 'enforce'` row is a landmine: `setRuleMode({ enabled: true })` passes no
mode, so it never consults the gate, and the rule resumes enforcing on a
`cutover_state` no writer would have left it in. Reporting it while it sleeps is
the point.

`listObservingRulesPastWindowWithBacklog` shipped with the same omission and it
was a defect there, fixed in a follow-up. That check is a workflow prompt —
"your window is up, go review the backlog so you can decide about enforcement" —
and for a rule an owner has turned off there is no decision waiting, the backlog
has stopped growing, and the only thing that would clear the line is reviewing
matches for a rule nobody uses. It would have sat in `doctor` on every run
forever. **A check that cries wolf is worse than no check**: `doctor` is what an
operator runs to find out whether anything needs them, and a permanent line
nothing can clear teaches them to skim past the ones that fire for a real
reason. That is ADR 0039's reasoning about reassuring numbers, pointed the other
way, and it is the first time this run has hit that direction of it.

**A dispatch reported one of its own code lines decorative, unprompted, and was
right.** The brief asked for the `observe_started_at IS NOT NULL` filter to be
pinned in both directions. The behavioural test passes and matters; the *line*
turned out to be redundant, because SQLite's `NULL <= x` evaluates to NULL and a
`WHERE` treats that as false, so removing it changed no result. It was kept
anyway, with a comment saying exactly that, on the ground that relying on the
NULL-comparison rule implicitly is more fragile than stating the intent. Both
halves of that are the right call, and volunteering the negative result is the
behaviour the "verify, do not assert" rule is trying to buy.

**PR-35 is a case of an implementer improving on the plan.** Both the plan and
the brief written from it said the observe-window check looks for rules in
`mode = 'observe'`. Keying on `cutover_state = 'observing'` instead is better on
two counts: it makes `doctor` report exactly the rules for which `automod ready`
is available, and it cannot go stale, because the gate refuses `enforce` from
`observing`, so an `observing` rule is necessarily in a mode that records
matches rather than acting on them. Accepted as written and recorded here
because it contradicts a document a later reader will find.

**A decorative guard caught in the recovered work, and it was mine to catch.**
Task 1's first dispatch left a `mod_rules`-rebuild-survival test that passed —
against migrations containing no rebuild. The CHECKs were declared in
`schema.ts` and materialised in no migration, so the test asserted survival of
an event that had not happened, and its comment stated as fact that 0015/0016
rebuilt two tables. **Running total: seventeen.**

## A pattern worth adding to `docs/22`

**Four decorative guards in one slice.** `docs/22` already records one from
Slice 0 (a one-element `join` never reads its separator). Slice 1 produced
three more, and all four share a shape precise enough to write down as a rule:

| Guard | Why it could not fail |
| --- | --- |
| Slice 0's byte-level `join` test | a one-element array never uses the separator |
| The span test | its fixture contained the term **once**, so `indexOf` could not pick the wrong one |
| The two-guild cache-key test | the fingerprint made the outcome correct regardless of whether the key carried the guild id |
| The "logs again after config changes" test | its `caps` fixture exercised `no-predicate`, not the `invalid-config` path its name and `'{not json'` fixture implied |
| The non-`keyword_filter` hydration test | a single rule in the database, so `terms` came back empty under any implementation — including one that leaks another rule's terms |

**The shape: a fixture too simple to reach the branch the test is named
after.** Not a wrong assertion — a correct assertion on an input where the bug
cannot occur. It passes before the fix and after, so it looks like coverage and
provides none.

**Two mitigations earned their keep here, and both belong in `docs/22`:**

1. **Watch every guard fail.** Already the rule, and it caught the fingerprint
   and cache-invalidation guards. It is the only mitigation that works
   mechanically.
2. **When a test names a specific failure mode, its fixture must contain the
   *ambiguity* that failure mode needs.** A test for "picks the right one of
   several" needs several. A test for "keeps guilds apart" needs the two guilds
   to actually disagree. Reviewers should be asked this directly — the two
   catches above both came from asking a reviewer "would this go red if the
   implementation were subtly wrong?" rather than "is this correct?".

Carried to handoff as a suggested `docs/22` amendment rather than edited in
mid-run, because `docs/22` is a lessons file and this run is still producing
lessons.

## A coordinator mistake, recorded rather than tidied away

**Commit `7be2e4f` is mislabelled. It says "docs: ruling R-10…" and it also
contains the whole of Slice 1 Task 6** — the `doctor` unusable-rules check
across `ops/ports.ts`, `ops/commands/reads.ts`, `ops/test-fixtures.ts`,
`apps/daemon/src/ops/wiring.ts` and `packages/http/src/test-support.ts`.

*Cause.* The coordinator ran `git add -A` to commit a ledger entry while an
implementer was working uncommitted **in the same worktree**. `git add -A`
stages everything, so the implementer's in-progress Task 6 files were swept
into a documentation commit. The implementer noticed, verified nothing was
lost, re-ran its tests, and flagged it.

*Not fixed by rewriting history*, deliberately. The branch is unpushed and a
rebase would be safe in isolation, but subagent reports already reference these
SHAs, and `docs/22`'s whole argument for the ledger is that **the commits it
names exist in git even when context no longer remembers creating them**. A
rewrite invalidates exactly that. Correcting the record here is the cheaper and
more honest repair: `7be2e4f` is Task 6 plus a ledger entry, and now says so
somewhere a reader will find it.

*Practice changed for the rest of this run:* the coordinator stages explicit
paths (`git add docs/…`) and never `git add -A` while any implementer is live.

*Costs if wrong:* a reader running `git log --oneline` sees one commit whose
subject under-describes it. Contained, and documented here.

## Environment findings

**E-1 — a git worktree here has no workspace symlinks, so cross-package
typechecks silently read the *main checkout's* build.** The worktree's
`node_modules/` contained only `.vite`; Node's resolution walked up to
`/home/bryan/projects/bananasaurs/node_modules/@bananasaurs/*`, every one of
which symlinks into the **main** checkout's `packages/`. So `packages/discord`
in the worktree typechecked against the main checkout's
`packages/core/dist/index.d.ts`, which was stale (built 08:42, before Slice 0's
exports landed) — producing 14 errors about missing `NativeAutoModAction`,
`createNativeAutomodSubscriber` and friends that looked like a broken baseline
and were nothing of the kind.

Fixed for this worktree by creating `node_modules/@bananasaurs/*` symlinks
pointing at the worktree's own packages. After that, `npm run typecheck` shows
only the expected mid-TDD errors.

**This matters beyond this session.** Any future worktree needs the same links
(or an `npm install` inside it) before any gate run there means anything — and
worse, without them a `tsc --build` in a worktree can write into the main
checkout's `dist`. Carried to handoff as a suggested `docs/` note.

**E-4 — a bare-pattern `rg` is blocked by the sandbox, and every dispatch will
hit it.** `rg -n "pattern"` with no path argument can default to searching the
whole tree, which includes `.env`; the permission layer cannot tell from the
outside that a particular invocation was reading piped stdin, so it refuses the
worst case. Two agents in this run hit it within minutes, once as
`sed … | rg -n "pattern"` — a command that genuinely could not have read
`.env`, and was refused anyway, correctly.

This interacts badly with the standing advice in every handoff to prefer `rg`
over `grep` (which returns false negatives here). **The fix is the command's
form: always give `rg` an explicit file or directory.**

```
rg -n "predicateInputFrom|evaluateRule" packages/core/src/automod/dry-run.test.ts
```

*Carried into every brief written from here on*, and worth a line in the
"Things that will bite you" section of the next handoff. Denying these is the
right call and nobody should approve one to unblock an agent — a subagent
reading `.env` is CLAUDE.md rule 4 failing, and the scoped form costs nothing.

## Deferred minors

Raised by review, judged not worth a fix round, carried to the whole-branch
review for triage.

- **Slice 1 Tasks 6-7** — `packages/core/src/ops/commands/reads.ts:78`:
  `doctor`'s rendered line for an unusable rule does not escape delimiters in
  `ruleId` / `kind` / `reason` / `detail`. A rule id containing the separator
  garbles the human-readable CLI output. Deliberately left: this is display
  text, never a cache key, a fingerprint or an equality check, so it cannot
  cause a wrong decision — unlike the fingerprint separator case in Task 4,
  which is why that one got a test and this one gets a line here.
- **Slice 1 Task 1** — `packages/storage/src/repos/automod-rules.ts`,
  `hydrate`: `row.kind as RuleKind` is an unchecked cast. Safe only because the
  `mod_rules_kind` CHECK constrains the value, and it mirrors the pre-existing
  `row.mode as RuleMode` cast on the next line, so it is consistent with the
  file rather than new sloppiness. Worth revisiting only if the CHECK and the
  union ever drift apart — which `packages/core`'s `compileRule` already
  handles by reporting `unknown-kind` rather than trusting the cast.

## Handoff checklist for the owner

Collected as they arise, so the final handoff is not reconstructed from memory.

1. **Confirm which database is real.** `data/bananasaurs.db` is at migration 5
   with no automod tables, which contradicts `STATE.md`. Check
   `BANANASAURS_DB_PATH`. Do this **before** running `npm run db:migrate`.
2. **`PRIVACY.md` changes in Slice 2** — it gains a retention row for the
   fixture corpus. Your own policy says material changes are announced in the
   server. The announcement is yours to make.
3. **Restart the observe clock for any rule whose data predates ADR 0039.**
   Carried forward from the kickoff; the rule was not firing, so its data
   measured nothing.
4. **A worktree needs `npm ci` (or workspace symlinks) before its gates mean
   anything** — see E-1. Worth a line in `docs/` if worktrees become routine.
5. **Decide, before flip day, whether the corpus should keep growing after
   it.** Slice 2 captures a matched message only while its rule is in `test`
   or `observe` (ruling PR-2), because a fixture has no expiry and
   `PRIVACY.md` promises deleted-message content is kept 30 days. The
   consequence is that once you flip a rule to `enforce`, post-flip false
   positives are reviewable from the trace and the matched snippet, not from
   the whole message. If that is too thin for the review you actually want to
   do, widening it is a privacy decision and therefore yours.
6. **`PRIVACY.md`'s new row promises `/forgetme`, which does not exist yet.**
   Caught by Task 1's reviewer, and kept deliberately after adjudication.
   The row reads "`/forgetme` removes yours", and the storage function it
   names (`deleteObservedFixturesForMember`) ships tested in Slice 2 — but
   the Discord command that would call it is Release 3's R3-10. The row is
   consistent with the rest of that document, which already names
   `/privacy`, `/mydata` and `/forgetme`, none of which are implemented:
   `PRIVACY.md` is written as the policy that publishes *with* `/privacy`,
   and `/privacy` and `/forgetme` land in the same Release 3 item. So the
   row is true on the day anyone can read it.
   **The thing to hold onto: do not publish this policy before `/forgetme`
   ships, or reword the row at publication time.** That is the only way the
   claim becomes false, and it would be by accident.
7. **Rehearse a trace before flip day.** The spec's own pre-flip gate: run
   `bananasaurs automod dryrun <ruleId>` and `bananasaurs automod review`
   against each real rule and read the output. A trace nobody can read
   produces an observe window that yields nothing, and that is discovered
   two weeks late rather than on the day.
