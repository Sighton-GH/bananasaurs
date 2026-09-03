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
| 1 — predicate abstraction + `mod_rules.config` | 0040 ✅ | [plan](superpowers/plans/2026-09-01-slice-1-predicate-abstraction-and-config-carrier.md) | **✅ complete** — 7 tasks, whole-branch reviewed, fix wave re-reviewed clean. 2026 tests (from 1953), typecheck + lint clean |
| 2 — fixtures, dry-run evaluator, traces, CLI review | 0041 ✅ | [plan](superpowers/plans/2026-09-02-slice-2-fixtures-dry-run-and-traces.md) | **✅ complete** — 9 tasks, whole-branch reviewed (SHIP-WITH-FIXES), fix wave re-reviewed, residual re-review finding fixed. 2148 tests (from 2026), typecheck + lint clean |
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
