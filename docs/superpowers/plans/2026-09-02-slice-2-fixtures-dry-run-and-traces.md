# Slice 2 — fixtures, the dry-run evaluator, match traces, and a CLI review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Release 2 observe window *reviewable*: capture matched messages as a guild-scoped fixture corpus, store the match trace that explains each match, let a human record a verdict on it, and replay a rule over the corpus through the exact code path production uses.

**Architecture:** Three additive schema changes (`automod_fixtures`, `mod_match_reviews`, two nullable columns on `mod_case_events`) and four new core modules. The subscriber's inline fingerprint-lookup-compile-evaluate block is extracted into `packages/core/src/automod/evaluate.ts` as `predicateInputFrom(...)` and `evaluateRule(...)`; the dry-run evaluator calls the same two functions, so the invariant "the dry run and production share one predicate code path" is structural rather than promised. Traces are stored as JSON text (storage never validates — ADR 0014), parsed by a Zod schema in core on the way out, and rendered for a terminal by the operator CLI.

**Tech Stack:** TypeScript (Node 22, strict, `exactOptionalPropertyTypes`), better-sqlite3 + Drizzle ORM, drizzle-kit migrations, Zod, Vitest, the existing ops-command/CLI surface (`packages/core/src/ops`, `packages/cli`).

**Spec:** `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md` §3 Slice 2, and its slice-specific gate in §4.

**ADR:** `docs/decisions/0041-fixtures-the-dry-run-evaluator-and-the-one-code-path-invariant.md` — accepted, and the binding authority for every decision below. Where this plan adds detail the ADR does not name, the addition is marked as a Plan ruling with its cost if wrong.

---

## Global Constraints

In force from `CLAUDE.md` and the ADRs this slice depends on. Every task's requirements implicitly include this section.

1. **Guild scope is a mandatory partition key** (CLAUDE.md rule 2). Every new query, index, cache key and repo signature takes `GuildScope` first. A function that *can* omit guild scope is a bug even if every current caller passes it.
2. **Stored JSON is untrusted input** (CLAUDE.md rule 3). `mod_case_events.trace` gets a Zod validator on read, not a cast — the same treatment `mod_rules.config` gets in ADR 0040 and `jobs.payload` gets in ADR 0037.
3. **`packages/core` must never import `@bananasaurs/storage`, and vice versa** (ADR 0014). Shapes are re-declared on each side. `packages/core/src/boundaries.test.ts` enforces this and will fail the build.
4. **No secrets, and no member content, in logs** (CLAUDE.md rule 4). Pino redaction is an allowlist: a field not in `LOGGABLE_FIELDS` (`packages/core/src/obs/logger.ts`) is silently dropped. Never add a field that can carry message text.
5. **Every migration in this slice is additive: `CREATE TABLE` and `ALTER TABLE ... ADD COLUMN` only.** No table rebuild. A rebuild inside drizzle-orm's single-transaction migrator cascades child deletes — see `packages/storage/src/db.ts`'s `runMigrations` and the ledger's R-5. Task 1 verifies the generated SQL contains no `DROP TABLE`.
6. **Every table is `STRICT` and carries `guild_id`.** `scripts/strictify.mjs` adds `STRICT` after generation; `packages/storage/src/schema-invariants.test.ts` reads the live schema and fails the build if a table lacks either.
7. **Snowflakes are TEXT** with a `snowflakeCheck` / `nullableSnowflakeCheck` CHECK constraint. Timestamps are INTEGER epoch-millis.
8. **AI is never in the enforcement path** (CLAUDE.md rule 1) and **no `claude` binary is ever spawned from application code** (rule 9). Nothing in this slice goes near either; the CLI is invoked by a human over SSH (ADR 0013, `docs/17`).
9. **Gates:** `npm run typecheck && npm run lint && npm run test` must all pass before any task is reported done. Run them; do not infer them.
10. **`grep` returns false negatives in this sandbox on some files.** Use `rg`, or `awk '/pattern/{print FILENAME": "FNR": "$0}' <files>`, to confirm a string is absent. A `grep` that finds nothing is not evidence.
11. **Verify library behaviour against `node_modules`, not memory.** If a step's expectation depends on what a library does, open the library's source in `node_modules` and confirm before writing the assertion.
12. **A test must be able to fail for the reason its name claims.** Before committing a guard, make it fail on purpose (break the code it guards, watch red, restore, watch green) and say so in the report. Six "decorative guards" — correct assertions on fixtures too simple to reach the branch under test — have shipped on this project already.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `packages/storage/src/repos/automod-fixtures.ts` | The fixture corpus: capture, list, label, delete-for-member. |
| `packages/storage/src/repos/automod-fixtures.test.ts` | Its tests, including guild scope and the `/forgetme` path. |
| `packages/storage/src/repos/mod-match-reviews.ts` | Verdicts on matches, and the fixture label they propagate. |
| `packages/storage/src/repos/mod-match-reviews.test.ts` | Its tests. |
| `packages/core/src/automod/trace.ts` | `matchTraceSchema`, `parseMatchTrace`, `renderTrace`. |
| `packages/core/src/automod/trace.test.ts` | Round-trip, rejection of malformed stored JSON, rendering. |
| `packages/core/src/automod/evaluate.ts` | `predicateInputFrom`, `evaluateRule`, `PredicateCache`. The one code path. |
| `packages/core/src/automod/evaluate.test.ts` | Cache invalidation, compile-failure reporting, `firstSeen`. |
| `packages/core/src/automod/dry-run.ts` | `runDryRun` — deterministic replay of one rule over the corpus. |
| `packages/core/src/automod/dry-run.test.ts` | Determinism, label agreement, and the one-code-path gate. |
| `packages/core/src/ops/commands/automod.ts` | `automod dryrun`, `automod review`, `automod verdict`. |
| `packages/core/src/ops/commands/automod.test.ts` | Their tests. |

**Modified:**

| File | Change |
| --- | --- |
| `packages/storage/src/schema.ts` | `automodFixtures`, `modMatchReviews`; `modCaseEvents.trace` and `.fixtureId`. |
| `packages/storage/src/repos/mod-cases.ts` | `recordCaseEvent` and `ModCaseEvent` carry `trace` and `fixtureId`; a `listUnreviewedMatches` read. |
| `packages/storage/src/index.ts` | Export the two new repos. |
| `packages/core/src/automod/subscriber.ts` | Calls `predicateInputFrom`/`evaluateRule`; captures fixtures; passes the trace through. |
| `packages/core/src/automod/predicates/types.ts` | `FixtureInput` — the fixture-shaped half of `predicateInputFrom`. |
| `packages/core/src/ops/ports.ts` | Ports for dry run, review listing, and verdict recording. |
| `packages/core/src/ops/registry.ts` | Register the three commands. |
| `packages/core/src/ops/test-fixtures.ts` | Stubs for the new ports. |
| `packages/core/src/index.ts` | Export the new core modules. |
| `apps/daemon/src/automod/wiring.ts` | Stop dropping `trace`; wire `captureFixture`. |
| `apps/daemon/src/ops/wiring.ts` | Wire the new ops ports. |
| `PRIVACY.md` | The retention row for the fixture corpus (ADR 0041 §1, obligation 1). |

---

## Plan rulings

Decisions this plan makes that ADR 0041 does not name. Each is reversible; each states what it costs if wrong. The executor records these in `docs/LEDGER_RELEASE2_SLICES_1_6.md` before Task 1 and does not re-open them.

**PR-1 — An observed fixture's id is `<messageId>:<first 16 hex of sha256(content)>`.**
A gateway replay of the identical message must not create a second fixture (CLAUDE.md rule 6 assumes replays). An *edit* that matches again is genuinely different evidence and should be captured separately, so the content hash is in the key rather than the messageId alone. *Cost if wrong:* an edited-then-rematched message yields two corpus rows where one was wanted — visible and deletable, not silent.

**PR-2 — Capture happens only for `test` and `observe` mode matches, exactly as ADR 0041 §2 says; enforce-mode matches are explicitly excluded.**
The tempting extension — capture enforce-mode matches too, since a false positive there is the most costly — is refused: `PRIVACY.md` promises deleted-message content is kept 30 days, and a fixture has no expiry, so capturing the content of a message the bot just deleted would make the policy untrue in the same commit that adds a row claiming it is true. *Cost if wrong:* post-flip false positives are reviewable only through `mod_case_events` (which keeps `matched_snippet` and the trace, not the whole message), so the corpus stops growing after flip day. Raise with the owner if post-flip review proves too thin — it is a privacy decision, not an engineering one.

**PR-3 — A fixture-derived `PredicateInput` reconstructs mentions by parsing the content, leaves `attachments` empty, and uses synthetic channel/message ids.**
Discord mention syntax (`<@id>`, `<@&id>`, `@everyone`) is literally present in message content, so `mention_spam` (Slice 4) replays honestly. Attachments are not recoverable from text. Adding attachment metadata columns to `automod_fixtures` would extend what member data Bananasaurs keeps, and `docs/22` reserves that class of decision for the owner — so it is not taken here. **Consequence carried to Slice 5: `attachment_type` cannot be dry-run against observed fixtures; its regression cases must be handwritten, and whether the corpus should hold attachment metadata is an owner question to raise then.** *Cost if wrong:* one of ten predicates has a weaker regression suite. The Release 2 gate is measured from live-window verdicts, not from corpus passes (ADR 0041 §2), so the gate itself is unaffected.

**PR-4 — `mod_match_reviews` has primary key `(guild_id, event_id)`; a re-review updates the row rather than appending.**
ADR 0041 §5 lists exactly those columns and says a verdict is "possibly revised". The immutability property ADR 0036 establishes belongs to `mod_case_events`, which this does not touch. *Cost if wrong:* the history of a *changed* verdict is lost (the current verdict is not). If that history turns out to matter, the fix is additive — a `mod_match_review_history` table — not a migration of this one.

**PR-5 — `mod_case_events` gains a nullable `fixture_id`, and recording a verdict propagates a label onto the linked fixture** (`true_positive` to `should_match`, `false_positive` to `should_not_match`, `unclear` leaves the fixture `unlabelled`).
ADR 0041's Consequences say "a verdict recorded during the window is a labelled fixture afterwards"; without a link between an event and the fixture captured from the same message, that sentence has no implementation. *Cost if wrong:* one nullable column on an append-only table, written at insert time. If the link proves unwanted, it is ignorable.

**PR-6 — Three CLI commands, not two: `automod dryrun <ruleId>` and `automod review` are reads; `automod verdict <eventId> <verdict>` is a write.**
ADR 0041 §7 names a "CLI review path" and two command names. Recording a verdict changes state, and `OpsWriteCommand` makes `--confirm` and an audit row non-optional — a read command that wrote would not compile. Splitting the listing from the recording is what the existing command surface's own shape requires. *Cost if wrong:* one more command in `--help`.

**PR-7 — A match is reviewable exactly when it has a trace.** `listUnreviewedMatches` filters on `trace IS NOT NULL` rather than on a list of `action_taken` values. Only a predicate match writes a trace, so this excludes manual `/mod` events, native Discord AutoMod events (ADR 0038 — an algorithm nobody can inspect is recorded, never reviewed against our gate), and every row written before this slice. A hand-maintained list of action values would need editing every time the vocabulary grows, and would be wrong quietly. *Cost if wrong:* a genuine match with no trace is invisible to review — which can only happen for pre-Slice-2 rows, whose clocks the owner is restarting anyway.

**PR-8 — Trace serialisation and label propagation are best-effort; neither may cost a moderation record.** If `serialiseTrace` throws (a predicate produced a trace its own schema rejects — a bug in our code), the composition root logs loudly and writes the case event *without* the trace. If the fixture a verdict would label has been deleted by `/forgetme`, the verdict is still recorded. *Cost if wrong:* a field of evidence is missing where a louder failure might have got the bug fixed sooner. The trade is deliberate: `mod_case_events` is the record ADR 0036 exists to guarantee, and losing it to save a field of evidence is the wrong way round.

**PR-9 — `mod_match_reviews.reviewed_by` is plain TEXT, not a snowflake.** Slice 9's dashboard authenticates a Discord user and writes a snowflake; the operator CLI — which ships first and covers the whole first fortnight of the window — has only the Unix user the invocation claimed (ADR 0024) and writes `cli:<user>`. A snowflake CHECK would make the path that exists on flip day impossible to write. The field is provenance, not authorisation: the socket's group permissions are the access control, and the dispatcher's audit row is the authoritative record of who ran the command. *Cost if wrong:* a reviewer identity that is not a snowflake cannot be rendered as a Discord mention, so Slice 9's screen branches on a string prefix.

---

### Task 1: Schema, migration, and the privacy policy row

**Files:**
- Modify: `packages/storage/src/schema.ts` (add `automodFixtures`, `modMatchReviews`; add two columns to `modCaseEvents` at line ~783)
- Create: `drizzle/0012_<generated-name>.sql` (via `npm run db:generate`)
- Modify: `PRIVACY.md:71-80` (the "How long it is kept" table) and `PRIVACY.md:23-46` (the "What Bananasaurs stores" list)
- Test: `packages/storage/src/db.test.ts` (migration safety); `packages/storage/src/schema-invariants.test.ts` runs over the new tables automatically

**Interfaces:**
- Consumes: nothing.
- Produces: the drizzle table objects `automodFixtures` and `modMatchReviews`, and `modCaseEvents.trace` / `modCaseEvents.fixtureId`. Tasks 2, 3 and 7 import them from `../schema.js`.

**Context for the implementer.** `packages/storage/src/schema.ts` is the single schema file. Read `modCaseEvents` (~line 783) and `modRules` (~line 610) first — they are the two closest models for style, CHECK-constraint naming (`<table>_<column>_<rule>`), and doc-comment density. Column helpers come from `./columns.js`: `snowflake(name)` declares a TEXT snowflake column, `snowflakeCheck(col)` / `nullableSnowflakeCheck(col)` produce its CHECK. Drizzle imports (`check`, `foreignKey`, `index`, `integer`, `primaryKey`, `sqliteTable`, `text`) are already at the top of the file.

- [ ] **Step 1: Add the `automod_fixtures` table**

Append after the `modCaseEvents` block in `packages/storage/src/schema.ts`:

```ts
/**
 * The automod review corpus (ADR 0041 §1).
 *
 * Holds whole messages, which is a deliberate, owner-approved extension of
 * what Bananasaurs keeps — `PRIVACY.md`'s retention table carries the
 * matching row, added in the same commit as this table, because a policy
 * that is not true is worse than no policy.
 *
 * Two sources with different rules. An `observed` row is a real member's
 * message, captured because a `test`/`observe` rule matched it, and
 * `deleteObservedFixturesForMember` can remove every one of a member's rows
 * — the path Release 3's `/forgetme` (R3-10) wires up rather than invents.
 * A `handwritten` row is an adversarial case the project wrote itself: not
 * member data, and never deleted by `/forgetme`.
 *
 * `content` is the zero-width-stripped text the predicate actually saw, so a
 * replay reproduces the original evaluation exactly rather than a
 * re-normalised approximation of it.
 */
export const automodFixtures = sqliteTable(
  'automod_fixtures',
  {
    guildId: snowflake('guild_id').notNull(),
    /**
     * For an `observed` fixture, `<messageId>:<first 16 hex of sha256(content)>`
     * (plan ruling PR-1): a gateway replay of the identical message is the
     * same fixture and collapses into one row, while an edit that matches
     * again is different evidence and gets its own. For a `handwritten`
     * fixture, a UUID.
     *
     * TEXT rather than a snowflake column: only half of it is a snowflake,
     * and a handwritten fixture's id is not one at all.
     */
    fixtureId: text('fixture_id').notNull(),
    content: text('content').notNull(),
    /**
     * The message's author, so a member's own rows can be found and removed.
     * Null for `handwritten` fixtures, which have no member behind them.
     */
    authorId: snowflake('author_id'),
    label: text('label').notNull().default('unlabelled'),
    source: text('source').notNull(),
    /** Why a human labelled it this way. Free text, nullable. */
    note: text('note'),
    /**
     * Also the replay clock: `PredicateInput.atMs` comes from here, never
     * from `Date.now()`, which is what makes the window tier's dry run
     * deterministic (ADR 0041 §6).
     */
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.fixtureId] }),
    foreignKey({ columns: [t.guildId], foreignColumns: [guilds.guildId] }).onDelete('cascade'),
    check('automod_fixtures_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('automod_fixtures_author_id_snowflake', nullableSnowflakeCheck(t.authorId)),
    check(
      'automod_fixtures_label',
      sql`${t.label} IN ('should_match','should_not_match','unlabelled')`,
    ),
    check('automod_fixtures_source', sql`${t.source} IN ('observed','handwritten')`),
    /**
     * A `handwritten` fixture has no author and an `observed` one must have
     * one — the invariant `deleteObservedFixturesForMember` depends on. Left
     * to the database rather than the repo, so a row inserted by hand in
     * `sqlite3` cannot break the `/forgetme` promise either.
     */
    check(
      'automod_fixtures_observed_has_author',
      sql`(${t.source} = 'observed' AND ${t.authorId} IS NOT NULL)
        OR (${t.source} = 'handwritten' AND ${t.authorId} IS NULL)`,
    ),
    /** The dry run reads the whole corpus in `created_at` order (ADR 0041 §6). */
    index('automod_fixtures_replay').on(t.guildId, t.createdAt),
    /** `deleteObservedFixturesForMember`'s lookup. */
    index('automod_fixtures_by_author').on(t.guildId, t.authorId),
  ],
);
```

- [ ] **Step 2: Add the `mod_match_reviews` table**

Append after `automodFixtures`:

```ts
/**
 * A human's verdict on one recorded match (ADR 0041 §5).
 *
 * Its own table rather than a column on `mod_case_events`, for the reason
 * ADR 0036 exists: a case event is the record of what happened and must
 * never be rewritten. A verdict is a later judgement *about* that record,
 * made by a named person at a known time — a different fact with a different
 * lifetime. Merging them would let a review edit history.
 *
 * One row per event (plan ruling PR-4): a reviewer who changes their mind
 * updates the verdict rather than appending a second one. The current
 * verdict is the fact Slice 6's gate reads; the history of a *revised*
 * verdict is not something anything needs today, and adding it later is an
 * additive table rather than a migration of this one.
 */
export const modMatchReviews = sqliteTable(
  'mod_match_reviews',
  {
    guildId: snowflake('guild_id').notNull(),
    eventId: text('event_id').notNull(),
    verdict: text('verdict').notNull(),
    /**
     * Who thought this — plain TEXT, deliberately not a snowflake column
     * (plan ruling PR-9).
     *
     * Two reviewers with two kinds of identity write here. Slice 9's
     * dashboard authenticates a Discord user and writes a snowflake; the
     * operator CLI, which ships first and covers the whole first fortnight
     * of the observe window, has only the Unix user the invocation claimed
     * (ADR 0024) and writes `cli:<user>`. A snowflake CHECK would make the
     * path that exists on flip day impossible to write.
     *
     * Provenance, not authorisation: the socket's group permissions are the
     * access control, and the dispatcher's `audit_events` row is the
     * authoritative record of who ran the command.
     */
    reviewedBy: text('reviewed_by').notNull(),
    reviewedAt: integer('reviewed_at').notNull(),
    note: text('note'),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.eventId] }),
    foreignKey({
      columns: [t.guildId, t.eventId],
      foreignColumns: [modCaseEvents.guildId, modCaseEvents.eventId],
    }).onDelete('cascade'),
    check('mod_match_reviews_guild_id_snowflake', snowflakeCheck(t.guildId)),
    /**
     * `unclear` is a real verdict, not a missing one: the spec's decision 16
     * counts it as a false positive for the Slice 6 gate. Recording it
     * faithfully here is this slice's whole job; the counting is Slice 6's.
     */
    check(
      'mod_match_reviews_verdict',
      sql`${t.verdict} IN ('false_positive','true_positive','unclear')`,
    ),
  ],
);
```

- [ ] **Step 3: Add the two columns to `mod_case_events`**

In the `modCaseEvents` column block, after `actorId`:

```ts
    /**
     * Why the rule matched, as JSON (ADR 0041 §4). Nullable — every row
     * written before this slice has none, and a manual `/mod` event never
     * has one.
     *
     * Stored rather than recomputed at review time, because the rule may
     * have been edited in the two weeks between the match and the review:
     * recomputing would answer "what would this rule decide about that
     * message today", which is a different question from the one the
     * reviewer is being asked and looks identical on screen.
     *
     * Storage never validates it (ADR 0014 — the Zod schema lives in
     * `packages/core/src/automod/trace.ts`). It comes back out as raw text
     * and core parses it, the same arrangement `mod_rules.config` has.
     *
     * **Never carries the whole message.** Whole-message content lives in
     * `automod_fixtures` under the owner's explicit decision; a second copy
     * here would put member content somewhere that decision did not reach.
     */
    trace: text('trace'),
    /**
     * The `automod_fixtures` row captured from the same message, when there
     * was one (plan ruling PR-5).
     *
     * This is what makes ADR 0041's "a verdict recorded during the window is
     * a labelled fixture afterwards" an implementation rather than an
     * aspiration: recording a verdict follows this link to set the fixture's
     * label. Null for enforce-mode matches (nothing is captured — PR-2), for
     * manual events, and for every row written before this slice.
     *
     * Deliberately *not* a foreign key. A fixture deleted by `/forgetme`
     * must not cascade into the moderation record, and `ON DELETE SET NULL`
     * would be a write to an append-only table. A dangling id resolves to
     * "no fixture", which is the truthful answer after a deletion.
     */
    fixtureId: text('fixture_id'),
```

- [ ] **Step 4: Generate the migration and read the SQL before trusting it**

Run `npm run db:generate`. Then open the generated `drizzle/0012_*.sql` and confirm, by reading it:

1. It contains `CREATE TABLE ... automod_fixtures` and `CREATE TABLE ... mod_match_reviews`.
2. It contains two `ALTER TABLE ... mod_case_events ... ADD ...` statements.
3. **It contains no `DROP TABLE` and no `__new_` temporary table.** Check with `rg -n 'DROP TABLE|__new_' drizzle/0012_*.sql` — expected: no matches. A match means drizzle-kit chose a table rebuild, which, inside drizzle-orm's single-transaction migrator, cascades `mod_case_events`' children away (ledger R-5). If it happened, stop and report BLOCKED with the SQL; do not quietly hand-edit the generated file.
4. `STRICT` was applied to both new tables (`scripts/strictify.mjs` runs as part of `db:generate`): `rg -n 'STRICT' drizzle/0012_*.sql` — expected: one per new `CREATE TABLE`.

- [ ] **Step 5: Write the migration-safety test**

Add to `packages/storage/src/db.test.ts`. This is the guard that would have caught R-5, so it must be able to fail. **Read the Slice 1 migration test already in that file first and reuse its harness** — do not invent a second one. If it exposes a helper for "migrate to version N, seed, then migrate the rest of the way", use it; if it inlines that, inline it the same way.

```ts
it('migration 0012 adds the fixture corpus without disturbing existing case events', () => {
  // A database migrated to the *previous* state, seeded, then migrated the
  // rest of the way — the shape a real upgrade takes, and the only shape in
  // which a table rebuild's cascade is visible.
  const { raw, db, close } = openDatabaseMigratedTo('0011');
  try {
    seedGuild(raw, GUILD_ID);
    seedCaseWithEvent(raw, GUILD_ID, { caseId: 'c1', eventId: 'e1' });

    runMigrations(raw, db, MIGRATIONS_FOLDER);

    const events = raw.prepare('SELECT event_id, trace, fixture_id FROM mod_case_events').all();
    expect(events).toEqual([{ event_id: 'e1', trace: null, fixture_id: null }]);
    expect(raw.pragma('foreign_key_check')).toEqual([]);
  } finally {
    close();
  }
});
```

- [ ] **Step 6: Watch the test fail**

Temporarily rewrite the generated migration so `mod_case_events` is rebuilt rather than altered — copy the rebuild pattern from `drizzle/0011_high_tyger_tiger.sql`, which is a real one — run the test, and confirm it fails on the surviving-row assertion or on `foreign_key_check`. Restore the generated SQL, re-run, confirm green. **Report both observations.** A migration guard nobody has watched fail is exactly the guard that let R-5 through.

- [ ] **Step 7: Add the `PRIVACY.md` rows**

ADR 0041 §1, obligation 1: this ships in the same commit as the table.

In the "What Bananasaurs stores" list, under **Server-wide**, immediately after the "Automod matches and the action taken" bullet:

```markdown
- Messages an automod rule matched while it was being tested, kept as examples so a human can check whether the rule was right
```

In the "How long it is kept" table (`PRIVACY.md:73`), immediately after the "Moderation records" row:

```markdown
| Automod test examples | Kept while the rule they test is in use, so its accuracy can be checked and improved. `/forgetme` removes yours. |
```

Do not reword the surrounding rows. Plain language, matching the register of the rows around it — this is a document club members read, not a schema comment.

- [ ] **Step 8: Run the gates**

`npm run typecheck && npm run lint && npm run test` — all must pass. If `schema-invariants.test.ts` fails on `guild_id` or `STRICT`, the table declaration is wrong, not the test.

- [ ] **Step 9: Commit**

Stage exactly `packages/storage/src/schema.ts`, `packages/storage/src/db.test.ts`, `drizzle/`, and `PRIVACY.md`. Commit message: `feat(storage): the fixture corpus, match verdicts, and stored traces (ADR 0041)`.

---

### Task 2: The fixture corpus repository

**Files:**
- Create: `packages/storage/src/repos/automod-fixtures.ts`
- Create: `packages/storage/src/repos/automod-fixtures.test.ts`
- Modify: `packages/storage/src/index.ts` (export `automodFixtureRepo`)

**Interfaces:**
- Consumes: `automodFixtures` from Task 1; `GuildScope` from `../scope.js`; `read`/`write` from `../write.js`.
- Produces:
  - `type FixtureLabel = 'should_match' | 'should_not_match' | 'unlabelled'`
  - `type FixtureSource = 'observed' | 'handwritten'`
  - `interface AutomodFixture { fixtureId: string; content: string; authorId: string | undefined; label: FixtureLabel; source: FixtureSource; note: string | undefined; createdAt: number }`
  - `observedFixtureId(messageId: string, content: string): string`
  - `captureObservedFixture(scope, { messageId, content, authorId, createdAt }): string` — returns the fixture id
  - `addHandwrittenFixture(scope, { fixtureId, content, label, note?, createdAt }): void`
  - `listFixtures(scope, filter?: { source?: FixtureSource; label?: FixtureLabel }): readonly AutomodFixture[]` — `created_at` ascending
  - `setFixtureLabel(scope, fixtureId, label, note?): boolean`
  - `deleteObservedFixturesForMember(scope, memberId): number`

**Context for the implementer.** Every function takes `GuildScope` first and reaches the database only through `read(scope, ...)` / `write(scope, ...)`. Read `packages/storage/src/repos/mod-cases.ts` for the established shape, including how `scope.only(table, ...)` composes the guild predicate with the rest of the WHERE clause. Never write a query whose WHERE clause omits `scope.only`.

- [ ] **Step 1: Write the failing tests**

Create `packages/storage/src/repos/automod-fixtures.test.ts`. Model its setup (test database, two guild scopes) on the nearest existing repo test — `packages/storage/src/repos/automod-rules.test.ts` — rather than writing a new harness.

```ts
describe('captureObservedFixture', () => {
  it('is idempotent for a replayed identical message', () => {
    const first = captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'hello badword',
      authorId: '800000000000000001',
      createdAt: 1_000,
    });
    const second = captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'hello badword',
      authorId: '800000000000000001',
      createdAt: 2_000,
    });

    expect(second).toBe(first);
    const rows = listFixtures(scope);
    expect(rows).toHaveLength(1);
    // The first capture wins: the row records when the message was first
    // seen, not when a gateway replay re-delivered it.
    expect(rows[0]?.createdAt).toBe(1_000);
  });

  it('captures an edit of the same message as separate evidence', () => {
    const before = captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'hello badword',
      authorId: '800000000000000001',
      createdAt: 1_000,
    });
    const after = captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'hello worseword',
      authorId: '800000000000000001',
      createdAt: 2_000,
    });

    expect(after).not.toBe(before);
    expect(listFixtures(scope).map((f) => f.content)).toEqual([
      'hello badword',
      'hello worseword',
    ]);
  });

  it('does not leak fixtures between guilds', () => {
    captureObservedFixture(scopeA, {
      messageId: '900000000000000001',
      content: 'guild A only',
      authorId: '800000000000000001',
      createdAt: 1_000,
    });
    expect(listFixtures(scopeB)).toEqual([]);
  });
});

describe('deleteObservedFixturesForMember', () => {
  it('removes that member’s observed rows, and leaves handwritten ones and other members alone', () => {
    captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'mine',
      authorId: '800000000000000001',
      createdAt: 1_000,
    });
    captureObservedFixture(scope, {
      messageId: '900000000000000002',
      content: 'someone else’s',
      authorId: '800000000000000002',
      createdAt: 2_000,
    });
    addHandwrittenFixture(scope, {
      fixtureId: 'adversarial-1',
      content: 'b@dw0rd',
      label: 'should_match',
      note: 'leetspeak evasion',
      createdAt: 3_000,
    });

    const deleted = deleteObservedFixturesForMember(scope, '800000000000000001');

    expect(deleted).toBe(1);
    expect(listFixtures(scope).map((f) => f.content)).toEqual(['someone else’s', 'b@dw0rd']);
  });

  it('does not reach another guild’s rows', () => {
    captureObservedFixture(scopeA, {
      messageId: '900000000000000001',
      content: 'guild A',
      authorId: '800000000000000001',
      createdAt: 1_000,
    });
    captureObservedFixture(scopeB, {
      messageId: '900000000000000002',
      content: 'guild B',
      authorId: '800000000000000001',
      createdAt: 1_000,
    });

    expect(deleteObservedFixturesForMember(scopeA, '800000000000000001')).toBe(1);
    expect(listFixtures(scopeB)).toHaveLength(1);
  });
});

describe('setFixtureLabel', () => {
  it('labels a fixture and reports that it did', () => {
    addHandwrittenFixture(scope, {
      fixtureId: 'f1',
      content: 'ordinary sentence',
      label: 'unlabelled',
      createdAt: 1_000,
    });
    expect(setFixtureLabel(scope, 'f1', 'should_not_match', 'reviewed: false positive')).toBe(true);
    expect(listFixtures(scope)[0]?.label).toBe('should_not_match');
  });

  it('reports false for a fixture that is not there', () => {
    expect(setFixtureLabel(scope, 'no-such-fixture', 'should_match')).toBe(false);
  });

  it('cannot label another guild’s fixture', () => {
    addHandwrittenFixture(scopeA, {
      fixtureId: 'f1',
      content: 'guild A',
      label: 'unlabelled',
      createdAt: 1_000,
    });
    expect(setFixtureLabel(scopeB, 'f1', 'should_match')).toBe(false);
    expect(listFixtures(scopeA)[0]?.label).toBe('unlabelled');
  });
});

describe('listFixtures', () => {
  it('returns rows oldest first, so a replay is deterministic', () => {
    addHandwrittenFixture(scope, {
      fixtureId: 'b',
      content: 'second',
      label: 'unlabelled',
      createdAt: 2_000,
    });
    addHandwrittenFixture(scope, {
      fixtureId: 'a',
      content: 'first',
      label: 'unlabelled',
      createdAt: 1_000,
    });
    expect(listFixtures(scope).map((f) => f.content)).toEqual(['first', 'second']);
  });

  it('orders ties by fixture id rather than leaving them to the planner', () => {
    addHandwrittenFixture(scope, {
      fixtureId: 'b',
      content: 'bee',
      label: 'unlabelled',
      createdAt: 1_000,
    });
    addHandwrittenFixture(scope, {
      fixtureId: 'a',
      content: 'ay',
      label: 'unlabelled',
      createdAt: 1_000,
    });
    expect(listFixtures(scope).map((f) => f.content)).toEqual(['ay', 'bee']);
  });

  it('filters by source', () => {
    captureObservedFixture(scope, {
      messageId: '900000000000000001',
      content: 'observed one',
      authorId: '800000000000000001',
      createdAt: 1_000,
    });
    addHandwrittenFixture(scope, {
      fixtureId: 'h1',
      content: 'handwritten one',
      label: 'should_match',
      createdAt: 2_000,
    });
    expect(listFixtures(scope, { source: 'handwritten' }).map((f) => f.content)).toEqual([
      'handwritten one',
    ]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

`npx vitest run packages/storage/src/repos/automod-fixtures.test.ts` — expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement the repository**

Create `packages/storage/src/repos/automod-fixtures.ts`:

```ts
import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { automodFixtures } from '../schema.js';

/**
 * The automod review corpus (ADR 0041 §1).
 *
 * Every function takes a `GuildScope` first, like every repository here, and
 * every query goes through `scope.only(...)`. There is deliberately no
 * function that can read or delete a fixture without naming a guild.
 */

export type FixtureLabel = 'should_match' | 'should_not_match' | 'unlabelled';
export type FixtureSource = 'observed' | 'handwritten';

export interface AutomodFixture {
  readonly fixtureId: string;
  readonly content: string;
  /** `undefined` for a handwritten fixture, which has no member behind it. */
  readonly authorId: string | undefined;
  readonly label: FixtureLabel;
  readonly source: FixtureSource;
  readonly note: string | undefined;
  readonly createdAt: number;
}

/**
 * `<messageId>:<first 16 hex of sha256(content)>` — plan ruling PR-1.
 *
 * The message id alone would collapse an *edit* into the message's original
 * capture, losing the evidence a reviewer is being asked about; the content
 * hash alone would collapse two different members posting the same text into
 * one row. Together they say "this message, with this text", which is
 * exactly what one piece of evidence is.
 *
 * 16 hex characters (64 bits) is not a security boundary — a collision would
 * need two different texts under the same message id — so a truncated digest
 * keeps the id readable in a terminal without costing anything real.
 */
export const observedFixtureId = (messageId: string, content: string): string =>
  `${messageId}:${createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)}`;

export interface CaptureObservedFixtureInput {
  readonly messageId: string;
  /** Zero-width stripped — what the predicate actually saw. */
  readonly content: string;
  readonly authorId: string;
  readonly createdAt: number;
}

/**
 * Records one matched message as evidence, or does nothing if it is already
 * recorded. Returns the fixture id either way, so the caller can link a case
 * event to it.
 *
 * `onConflictDoNothing` is targeted at the primary key rather than left
 * unqualified: an unqualified `ON CONFLICT DO NOTHING` in SQLite (unlike
 * Postgres) also swallows CHECK violations, which would silently discard a
 * fixture whose `source`/`author_id` pairing is wrong instead of throwing —
 * the same reasoning `recordCaseEvent` records for its own conflict target.
 *
 * The first capture wins, so `created_at` is when the message was first seen
 * rather than when a gateway replay re-delivered it.
 */
export const captureObservedFixture = (
  scope: GuildScope,
  input: CaptureObservedFixtureInput,
): string => {
  const fixtureId = observedFixtureId(input.messageId, input.content);
  write(scope, ({ db }) => {
    db.insert(automodFixtures)
      .values({
        guildId: scope.guildId,
        fixtureId,
        content: input.content,
        authorId: input.authorId,
        label: 'unlabelled',
        source: 'observed',
        note: null,
        createdAt: input.createdAt,
      })
      .onConflictDoNothing({
        target: [automodFixtures.guildId, automodFixtures.fixtureId],
      })
      .run();
  });
  return fixtureId;
};

export interface AddHandwrittenFixtureInput {
  readonly fixtureId: string;
  readonly content: string;
  readonly label: FixtureLabel;
  readonly note?: string;
  readonly createdAt: number;
}

/**
 * Adds an adversarial case the project wrote itself.
 *
 * `author_id` is null by construction — a handwritten fixture is not member
 * data, and `/forgetme` never deletes one (ADR 0041 §1, obligation 3). The
 * schema's `automod_fixtures_observed_has_author` CHECK is what actually
 * enforces that pairing.
 */
export const addHandwrittenFixture = (
  scope: GuildScope,
  input: AddHandwrittenFixtureInput,
): void =>
  write(scope, ({ db }) => {
    db.insert(automodFixtures)
      .values({
        guildId: scope.guildId,
        fixtureId: input.fixtureId,
        content: input.content,
        authorId: null,
        label: input.label,
        source: 'handwritten',
        note: input.note ?? null,
        createdAt: input.createdAt,
      })
      .onConflictDoNothing({
        target: [automodFixtures.guildId, automodFixtures.fixtureId],
      })
      .run();
  });

export interface FixtureFilter {
  readonly source?: FixtureSource;
  readonly label?: FixtureLabel;
}

/**
 * The corpus, oldest first.
 *
 * The order is load-bearing, not cosmetic: the dry run replays fixtures in
 * `created_at` order so the window tier's sliding-window state (Slice 4) sees
 * them in the order they really happened (ADR 0041 §6). `fixture_id` breaks
 * ties — `created_at` can legitimately collide when several messages land in
 * the same millisecond, and without a tiebreaker the replay order would be
 * whatever the planner chose that day, which would make a dry run's result
 * depend on the query plan.
 */
export const listFixtures = (
  scope: GuildScope,
  filter: FixtureFilter = {},
): readonly AutomodFixture[] =>
  read(scope, (db) =>
    db
      .select()
      .from(automodFixtures)
      .where(
        scope.only(
          automodFixtures,
          ...(filter.source === undefined ? [] : [eq(automodFixtures.source, filter.source)]),
          ...(filter.label === undefined ? [] : [eq(automodFixtures.label, filter.label)]),
        ),
      )
      .orderBy(asc(automodFixtures.createdAt), asc(automodFixtures.fixtureId))
      .all()
      .map((row) => ({
        fixtureId: row.fixtureId,
        content: row.content,
        authorId: row.authorId ?? undefined,
        label: row.label as FixtureLabel,
        source: row.source as FixtureSource,
        note: row.note ?? undefined,
        createdAt: row.createdAt,
      })),
  );

/** Returns whether there was a fixture to label. False is a real answer. */
export const setFixtureLabel = (
  scope: GuildScope,
  fixtureId: string,
  label: FixtureLabel,
  note?: string,
): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .update(automodFixtures)
      .set({ label, ...(note === undefined ? {} : { note }) })
      .where(scope.only(automodFixtures, eq(automodFixtures.fixtureId, fixtureId)))
      .run();
    return result.changes > 0;
  });

/**
 * Deletes every `observed` fixture belonging to one member, and returns how
 * many went.
 *
 * Ships in Slice 2 with a test even though `/forgetme` is Release 3 (R3-10),
 * because the owner authorised a corpus that can be un-made and the way to
 * keep that true is to build and test the un-making now — so R3-10 wires up
 * an existing, tested path rather than inventing one under time pressure
 * (ADR 0041 §1, obligation 2).
 *
 * `source = 'observed'` is in the WHERE clause, not left implied by
 * `author_id`: handwritten fixtures are the project's own adversarial cases,
 * not member data, and must survive a member's deletion request (obligation
 * 3). The schema CHECK already makes their `author_id` null, so this
 * predicate is belt and braces — deliberately, because the cost of getting it
 * wrong is silently destroying the regression suite.
 */
export const deleteObservedFixturesForMember = (
  scope: GuildScope,
  memberId: string,
): number =>
  write(scope, ({ db }) => {
    const result = db
      .delete(automodFixtures)
      .where(
        scope.only(
          automodFixtures,
          eq(automodFixtures.authorId, memberId),
          eq(automodFixtures.source, 'observed'),
        ),
      )
      .run();
    return result.changes;
  });
```

If `scope.only`'s signature does not accept a spread of conditions, read `packages/storage/src/scope.ts` and adapt — do not work around it by dropping `scope.only`.

- [ ] **Step 4: Run the tests until green**

`npx vitest run packages/storage/src/repos/automod-fixtures.test.ts`

- [ ] **Step 5: Prove the `/forgetme` guard can fail**

Temporarily remove `eq(automodFixtures.source, 'observed')` from `deleteObservedFixturesForMember` and re-run. The "leaves handwritten ones and other members alone" test must go red. If it stays green, the fixture is decorative — the handwritten row is unreachable by the deletion for some other reason — and the test needs a better fixture, not a pass. Restore, confirm green, and report both observations.

- [ ] **Step 6: Export the repo**

In `packages/storage/src/index.ts`, beside the other `export * as ...Repo` lines:

```ts
export * as automodFixtureRepo from './repos/automod-fixtures.js';
```

- [ ] **Step 7: Gates and commit**

`npm run typecheck && npm run lint && npm run test`. Stage exactly the two new files and `packages/storage/src/index.ts`. Commit message: `feat(storage): the automod fixture corpus repository (ADR 0041)`.

---

### Task 3: The trace contract — schema, parser, renderer

**Files:**
- Create: `packages/core/src/automod/trace.ts`
- Create: `packages/core/src/automod/trace.test.ts`
- Modify: `packages/core/src/index.ts` (export the new module's public names)

**Interfaces:**
- Consumes: `MatchTrace`, `RULE_KINDS` from `./predicates/types.js`.
- Produces:
  - `matchTraceSchema` — the Zod schema
  - `serialiseTrace(trace: MatchTrace): string` — validates, then stringifies
  - `parseMatchTrace(json: string): { ok: true; trace: MatchTrace } | { ok: false; detail: string }`
  - `renderTrace(trace: MatchTrace, content?: string): string`

**Context for the implementer.** `MatchTrace` is already declared in `packages/core/src/automod/predicates/types.ts` — read it first; this task does not change it, it validates and renders it. `RULE_KINDS` is the `as const` tuple of the ten kinds in the same file, and Zod's `z.enum` accepts it directly.

The critical property: **a trace read back from the database is untrusted input** (CLAUDE.md rule 3). It may have been written by an older schema version, or edited by hand in `sqlite3`. `parseMatchTrace` never throws and never casts; it returns a discriminated result the caller must handle, exactly like `compileRule` in `predicates/registry.ts` does. Read that function for the convention.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/automod/trace.test.ts`:

```ts
const TRACE: MatchTrace = {
  kind: 'keyword_filter',
  matchedOn: 'badword',
  span: [6, 13],
  normalisations: ['zero-width stripped', 'lowercased'],
  detail: { categoryId: 'profanity', termCount: 14, allowlisted: false },
};

describe('serialiseTrace / parseMatchTrace', () => {
  it('round-trips a trace', () => {
    const result = parseMatchTrace(serialiseTrace(TRACE));
    expect(result).toEqual({ ok: true, trace: TRACE });
  });

  it('round-trips a trace with no span', () => {
    const spanless: MatchTrace = { ...TRACE, span: undefined };
    const result = parseMatchTrace(serialiseTrace(spanless));
    expect(result.ok).toBe(true);
    // `JSON.stringify` drops an `undefined` property entirely, so the parser
    // has to put it back rather than leaving the key missing — otherwise a
    // `MatchTrace` fails `exactOptionalPropertyTypes` on the way out.
    expect(result.ok && result.trace.span).toBeUndefined();
  });

  it('refuses a trace whose kind is not a rule kind', () => {
    const result = parseMatchTrace('{"kind":"telepathy","matchedOn":"x","normalisations":[],"detail":{}}');
    expect(result.ok).toBe(false);
  });

  it('refuses a trace with an unexpected extra field', () => {
    // `.strict()`, not a bare object: a trace carrying a field nothing
    // declares is a trace written by code that disagrees with this schema,
    // and the review screen would render it as if it were understood.
    const result = parseMatchTrace(
      '{"kind":"keyword_filter","matchedOn":"x","normalisations":[],"detail":{},"messageContent":"the whole message"}',
    );
    expect(result.ok).toBe(false);
  });

  it('refuses text that is not JSON at all, without throwing', () => {
    const result = parseMatchTrace('not json');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail.length).toBeGreaterThan(0);
  });

  it('refuses a detail value that is not a scalar', () => {
    const result = parseMatchTrace(
      '{"kind":"keyword_filter","matchedOn":"x","normalisations":[],"detail":{"nested":{"a":1}}}',
    );
    expect(result.ok).toBe(false);
  });

  it('refuses to serialise a trace that would not parse back', () => {
    const broken = { ...TRACE, kind: 'telepathy' } as unknown as MatchTrace;
    expect(() => serialiseTrace(broken)).toThrow();
  });
});

describe('renderTrace', () => {
  it('names the predicate, what matched, and the normalisations that ran', () => {
    const text = renderTrace(TRACE);
    expect(text).toContain('keyword_filter');
    expect(text).toContain('badword');
    expect(text).toContain('zero-width stripped');
    expect(text).toContain('categoryId');
    expect(text).toContain('profanity');
  });

  it('marks the matched span inside the message when given the content', () => {
    const text = renderTrace(TRACE, 'hello badword everyone');
    expect(text).toContain('hello [badword] everyone');
  });

  it('says so rather than lying when the span does not fit the content', () => {
    // A stored trace is untrusted: its span was computed against the content
    // as it was two weeks ago, and the caller may hand over a different
    // string. Rendering `slice()`'s silent clamp as if it were the match
    // would show a reviewer a highlighted region that is not the match.
    const text = renderTrace(TRACE, 'hi');
    expect(text).not.toContain('[');
    expect(text).toContain('span does not fit');
  });

  it('renders a spanless trace without a message excerpt', () => {
    const text = renderTrace({ ...TRACE, span: undefined }, 'hello badword everyone');
    expect(text).not.toContain('[badword]');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

`npx vitest run packages/core/src/automod/trace.test.ts` — expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/automod/trace.ts`:

```ts
import { z } from 'zod';
import { RULE_KINDS, type MatchTrace } from './predicates/types.js';

/**
 * The stored form of a `MatchTrace` (ADR 0041 §4), and how to read it back
 * safely.
 *
 * `mod_case_events.trace` is JSON text this process wrote, and that does not
 * make it trusted (CLAUDE.md rule 3): a row written by an older schema
 * version, or edited by hand in `sqlite3`, arrives here looking exactly like
 * one this build produced. So it meets a validator, not a cast — the same
 * treatment `mod_rules.config` gets in ADR 0040 and `jobs.payload` gets in
 * ADR 0037.
 *
 * Storage never validates it, because storage may not import `core`
 * (ADR 0014). The column comes back as raw text and this module is the only
 * place that turns it into a `MatchTrace`.
 */

/**
 * `.strict()` throughout, deliberately.
 *
 * A trace carrying a field nothing declares was written by code that
 * disagrees with this schema, and the review screen would render it as if it
 * were understood. The specific failure worth being loud about: a predicate
 * that put the whole message into its trace. ADR 0041 §4 says the trace
 * never carries whole-message content — whole messages live in
 * `automod_fixtures` under the owner's explicit privacy decision — and a
 * strict schema is what makes that a rule rather than a hope.
 */
export const matchTraceSchema = z
  .object({
    kind: z.enum(RULE_KINDS),
    matchedOn: z.string(),
    /**
     * Half-open `[start, end)` into the zero-width-stripped content — the
     * same string `automod_fixtures.content` holds, which is why a fixture
     * can be replayed against a stored span at all.
     *
     * `.optional()` rather than `.nullable()`: `JSON.stringify` drops an
     * `undefined` property rather than writing `null`, so absent is the
     * shape this actually has to accept.
     */
    span: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
    normalisations: z.array(z.string()),
    detail: z.record(z.union([z.string(), z.number(), z.boolean()])),
  })
  .strict();

export type StoredMatchTrace = z.infer<typeof matchTraceSchema>;

/**
 * Validates on the way *in* as well as on the way out (ADR 0040 §2's
 * pattern).
 *
 * Throws, unlike `parseMatchTrace` — the asymmetry is intentional. A trace
 * that fails here was built by a predicate in this build, so it is a bug in
 * our own code and should stop the write loudly. A trace that fails on read
 * is a data problem and must not take the process down.
 */
export const serialiseTrace = (trace: MatchTrace): string =>
  JSON.stringify(matchTraceSchema.parse(trace));

export type ParseTraceResult =
  | { readonly ok: true; readonly trace: MatchTrace }
  | { readonly ok: false; readonly detail: string };

/**
 * Reads a stored trace. Never throws.
 *
 * A malformed trace must not stop a reviewer seeing the rest of a match's
 * record — it is one field of evidence, not the record itself — so the
 * caller gets a reason it can render in place of the trace.
 */
export const parseMatchTrace = (json: string): ParseTraceResult => {
  try {
    const parsed = matchTraceSchema.parse(JSON.parse(json));
    return {
      ok: true,
      // Rebuilt field by field rather than spread: `exactOptionalPropertyTypes`
      // distinguishes an absent `span` from one set to `undefined`, and
      // `MatchTrace` declares the property as present-and-possibly-undefined.
      trace: {
        kind: parsed.kind,
        matchedOn: parsed.matchedOn,
        span: parsed.span ?? undefined,
        normalisations: parsed.normalisations,
        detail: parsed.detail,
      },
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
};

/** How much of the message to show either side of the match. */
const EXCERPT_WINDOW = 60;

/**
 * A trace, as a human reads it (ADR 0041, and the spec's "human-readable
 * match traces").
 *
 * `content` is optional because the two callers have different evidence to
 * hand: the review listing has the fixture's whole message and should show
 * the match in place, while a context without the message still renders
 * everything else. When content *is* given, the span is checked against it
 * rather than trusted — a stored span was computed against the content as it
 * was when the match happened, and `String.prototype.slice` silently clamps
 * an out-of-range index, which would draw a highlight around text that is
 * not the match.
 */
export const renderTrace = (trace: MatchTrace, content?: string): string => {
  const lines = [
    `predicate       ${trace.kind}`,
    `matched on      ${trace.matchedOn}`,
    `normalisations  ${trace.normalisations.length === 0 ? '(none)' : trace.normalisations.join(' -> ')}`,
  ];

  if (trace.span !== undefined) {
    const [start, end] = trace.span;
    lines.push(`span            [${String(start)}, ${String(end)})`);
    if (content !== undefined) {
      if (end > content.length || start > end) {
        lines.push(
          'excerpt         (span does not fit this message; the rule or the message changed)',
        );
      } else {
        const before = content.slice(Math.max(0, start - EXCERPT_WINDOW), start);
        const matched = content.slice(start, end);
        const after = content.slice(end, end + EXCERPT_WINDOW);
        const lead = start - EXCERPT_WINDOW > 0 ? '...' : '';
        const tail = end + EXCERPT_WINDOW < content.length ? '...' : '';
        lines.push(`excerpt         ${lead}${before}[${matched}]${after}${tail}`);
      }
    }
  }

  for (const [key, value] of Object.entries(trace.detail)) {
    lines.push(`${key.padEnd(16)}${String(value)}`);
  }

  return lines.join('\n');
};
```

- [ ] **Step 4: Green, then prove the strictness guard can fail**

Run the tests to green. Then remove `.strict()` from `matchTraceSchema`, re-run, and confirm the "unexpected extra field" test goes red. Restore. **Report both observations** — that test is the only thing standing between a future predicate and putting whole-message content into `mod_case_events`, which ADR 0041 §4 forbids.

- [ ] **Step 5: Export from core**

Add to `packages/core/src/index.ts`, next to the other automod exports:

```ts
export {
  matchTraceSchema,
  parseMatchTrace,
  renderTrace,
  serialiseTrace,
  type ParseTraceResult,
} from './automod/trace.js';
```

- [ ] **Step 6: Gates and commit**

`npm run typecheck && npm run lint && npm run test`. Stage the two new files and `packages/core/src/index.ts`. Commit message: `feat(automod): the stored match trace, its validator, and its renderer (ADR 0041)`.

---

### Task 4: `evaluate.ts` — the one code path

**Files:**
- Create: `packages/core/src/automod/evaluate.ts`
- Create: `packages/core/src/automod/evaluate.test.ts`
- Modify: `packages/core/src/automod/predicates/types.ts` (add `FixtureRecord`)
- Modify: `packages/core/src/automod/subscriber.ts` (replace the inline block with calls)
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `AutomodRule`, `PredicateInput`, `PredicateMatch`, `CompiledPredicate` from `./predicates/types.js`; `compileRule`, `CompileFailure` from `./predicates/registry.js`; `ruleFingerprint` from `./fingerprint.js`; `stripZeroWidth` from `./matcher.js`; `MessageEvent` from `../discord/events.js`.
- Produces:
  - `interface FixtureRecord { fixtureId, content, authorId: string | undefined, label, source, createdAt }` (in `types.ts`)
  - `type PredicateCache = Map<string, CacheEntry>` and `createPredicateCache(): PredicateCache`
  - `predicateCacheKey(guildId: string, ruleId: string): string`
  - `predicateInputFrom(source: PredicateInputSource): PredicateInput | undefined`
  - `evaluateRule(cache: PredicateCache, rule: AutomodRule, input: PredicateInput): EvaluateOutcome`
  - `type EvaluateOutcome` — the four-variant union below

**This task is a behaviour-preserving refactor.** `subscriber.test.ts` must stay green **unmodified**. If a subscriber test needs changing to keep it passing, the extraction changed behaviour and that is a defect, not a test that needs updating — stop and report it.

**Context for the implementer.** Read `packages/core/src/automod/subscriber.ts` lines ~275-340 first: the fingerprint lookup, the `compileRule` call, the once-per-fingerprint error log, and the try-wrapped `evaluate` call. That block is what moves. The log stays in the subscriber, because the evaluator has no logger and must not grow one — a pure function is what lets a dry run call it. The `firstSeen` flag on the `unusable` outcome is how the subscriber keeps logging exactly once per broken configuration without the evaluator knowing what a log is.

- [ ] **Step 1: Add `FixtureRecord` to `predicates/types.ts`**

```ts
/**
 * One corpus row, as `core` sees it.
 *
 * Re-declared here rather than imported from `@bananasaurs/storage`
 * (ADR 0014), the same arrangement `AutomodRule` has. `packages/storage`'s
 * `AutomodFixture` is the authority on the columns; this is the shape the
 * dry-run evaluator needs, which is a subset — `note` is a reviewer's prose
 * and no predicate reads it.
 */
export interface FixtureRecord {
  readonly fixtureId: string;
  /** Zero-width stripped, exactly as the predicate saw it when captured. */
  readonly content: string;
  readonly authorId: string | undefined;
  readonly label: 'should_match' | 'should_not_match' | 'unlabelled';
  readonly source: 'observed' | 'handwritten';
  /** The replay clock. `PredicateInput.atMs` comes from here (ADR 0041 §6). */
  readonly createdAt: number;
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/core/src/automod/evaluate.test.ts`. Build `AutomodRule` fixtures inline; a `keyword_filter` rule with one term is enough for most, and the registry's real `keywordFilterPredicate` is what compiles them (no fakes — the point of this module is that it is the production path).

```ts
const ruleWith = (terms: readonly string[]): AutomodRule => ({
  ruleId: 'r1',
  kind: 'keyword_filter',
  mode: 'test',
  config: '{}',
  terms: terms.map((text) => ({ text, categoryId: 'profanity' })),
  allowlist: [],
});

const inputWith = (content: string): PredicateInput => ({
  guildId: '100000000000000001',
  channelId: '200000000000000001',
  messageId: '300000000000000001',
  authorId: '400000000000000001',
  eventKind: 'messageCreate',
  content,
  rawContent: content,
  mentionedUserIds: [],
  mentionedRoleIds: [],
  mentionsEveryone: false,
  attachments: [],
  atMs: 1_000,
});

describe('evaluateRule', () => {
  it('matches through the real predicate and returns its trace', () => {
    const cache = createPredicateCache();
    const outcome = evaluateRule(cache, ruleWith(['badword']), inputWith('hello badword'));
    expect(outcome.kind).toBe('match');
    expect(outcome.kind === 'match' && outcome.match.trace.matchedOn).toBe('badword');
  });

  it('recompiles when the rule’s terms change, without a restart', () => {
    // The ADR 0039 failure, guarded: the cache used to key on rule id alone,
    // so an edited word list kept matching against the old compiled matcher
    // until the daemon was restarted.
    const cache = createPredicateCache();
    expect(evaluateRule(cache, ruleWith(['badword']), inputWith('hello newword')).kind).toBe(
      'no-match',
    );
    expect(evaluateRule(cache, ruleWith(['newword']), inputWith('hello newword')).kind).toBe(
      'match',
    );
  });

  it('reuses the compiled artifact when nothing changed', () => {
    const cache = createPredicateCache();
    const rule = ruleWith(['badword']);
    evaluateRule(cache, rule, inputWith('hello badword'));
    const sizeAfterFirst = cache.size;
    evaluateRule(cache, rule, inputWith('hello badword again'));
    expect(cache.size).toBe(sizeAfterFirst);
  });

  it('keys the cache by guild as well as rule, so two guilds cannot share a matcher', () => {
    // `daemon.ts` seeds every guild's default rule under the same id, so a
    // bare `ruleId` key would let whichever guild spoke first decide what
    // every other guild was matched against.
    const cache = createPredicateCache();
    const guildA = { ...inputWith('hello badword'), guildId: '100000000000000001' };
    const guildB = { ...inputWith('hello badword'), guildId: '100000000000000002' };
    evaluateRule(cache, ruleWith(['badword']), guildA);
    evaluateRule(cache, ruleWith(['badword']), guildB);
    expect(cache.size).toBe(2);
  });

  it('reports an unusable rule once per fingerprint, and again after an edit', () => {
    const cache = createPredicateCache();
    const empty = ruleWith([]);

    const first = evaluateRule(cache, empty, inputWith('anything'));
    expect(first).toMatchObject({ kind: 'unusable', reason: 'no-terms', firstSeen: true });

    const second = evaluateRule(cache, empty, inputWith('anything else'));
    expect(second).toMatchObject({ kind: 'unusable', reason: 'no-terms', firstSeen: false });

    // A different broken configuration is a different fingerprint, so the
    // operator hears about it rather than being told once ever.
    const alsoEmpty = { ...empty, allowlist: ['harmless'] };
    const third = evaluateRule(cache, alsoEmpty, inputWith('anything'));
    expect(third).toMatchObject({ kind: 'unusable', firstSeen: true });
  });

  it('returns `threw` rather than propagating when a predicate throws', () => {
    // Uses a rule kind with no registered predicate would be `no-predicate`,
    // not `threw` — so this needs a compiled predicate that throws at
    // evaluate time. Build one directly against the CompiledPredicate
    // interface and put it in the cache by hand, which is exactly the state
    // the subscriber would be in after a successful compile.
    const cache = createPredicateCache();
    const rule = ruleWith(['badword']);
    cache.set(predicateCacheKey('100000000000000001', 'r1'), {
      fingerprint: ruleFingerprint(rule),
      compiled: {
        evaluate() {
          throw new Error('predicate exploded');
        },
      },
      failure: undefined,
    });

    const outcome = evaluateRule(cache, rule, inputWith('hello badword'));
    expect(outcome.kind).toBe('threw');
  });
});

describe('predicateInputFrom', () => {
  it('strips zero-width characters from a message’s content but keeps the raw text', () => {
    const input = predicateInputFrom({
      from: 'message',
      event: messageEvent({ content: 'bad​word' }),
    });
    expect(input?.content).toBe('badword');
    expect(input?.rawContent).toBe('bad​word');
  });

  it('returns undefined for a message with no author or no content', () => {
    expect(predicateInputFrom({ from: 'message', event: messageEvent({ content: undefined }) })).toBeUndefined();
    expect(predicateInputFrom({ from: 'message', event: messageEvent({ authorId: undefined }) })).toBeUndefined();
  });

  it('reconstructs mentions from a fixture’s content', () => {
    // Plan ruling PR-3: Discord mention syntax is literally present in the
    // message text, so the window tier can replay honestly from a text-only
    // corpus. Attachments are not recoverable and stay empty.
    const input = predicateInputFrom({
      from: 'fixture',
      guildId: '100000000000000001',
      fixture: {
        fixtureId: '300000000000000001:abcdef0123456789',
        content: 'hey <@400000000000000002> and <@!400000000000000003> and <@&500000000000000001> @everyone',
        authorId: '400000000000000001',
        label: 'unlabelled',
        source: 'observed',
        createdAt: 7_000,
      },
    });

    expect(input?.mentionedUserIds).toEqual(['400000000000000002', '400000000000000003']);
    expect(input?.mentionedRoleIds).toEqual(['500000000000000001']);
    expect(input?.mentionsEveryone).toBe(true);
    expect(input?.attachments).toEqual([]);
  });

  it('takes the replay clock from the fixture, never from the wall clock', () => {
    const input = predicateInputFrom({
      from: 'fixture',
      guildId: '100000000000000001',
      fixture: {
        fixtureId: 'handwritten-1',
        content: 'ordinary',
        authorId: undefined,
        label: 'should_not_match',
        source: 'handwritten',
        createdAt: 7_000,
      },
    });
    expect(input?.atMs).toBe(7_000);
  });

  it('recovers the real message id from an observed fixture’s id', () => {
    const input = predicateInputFrom({
      from: 'fixture',
      guildId: '100000000000000001',
      fixture: {
        fixtureId: '300000000000000001:abcdef0123456789',
        content: 'x',
        authorId: '400000000000000001',
        label: 'unlabelled',
        source: 'observed',
        createdAt: 1,
      },
    });
    expect(input?.messageId).toBe('300000000000000001');
  });
});
```

- [ ] **Step 3: Run and watch them fail**

`npx vitest run packages/core/src/automod/evaluate.test.ts` — expected: FAIL, module not found.

- [ ] **Step 4: Implement `evaluate.ts`**

```ts
import type { MessageEvent } from '../discord/events.js';
import { ruleFingerprint } from './fingerprint.js';
import { stripZeroWidth } from './matcher.js';
import { compileRule, type CompileFailure } from './predicates/registry.js';
import type {
  AutomodRule,
  CompiledPredicate,
  FixtureRecord,
  PredicateInput,
  PredicateMatch,
} from './predicates/types.js';

/**
 * The one predicate code path (ADR 0041 §3).
 *
 * The live subscriber and the dry-run evaluator both build their
 * `PredicateInput` here and both evaluate a rule here. That is the slice's
 * hard invariant, and it is made structural rather than promised: there is
 * no second construction site and no second evaluation site to drift from.
 * A test that merely compared two implementations' outputs would pass on the
 * day someone forked the logic and kept the behaviour identical for the
 * cases the test happened to cover.
 *
 * Deliberately pure: no logger, no clock, no database, no Discord. The
 * subscriber does the logging, using `firstSeen` below to keep saying it
 * once per broken configuration rather than once per message. Giving this
 * module a logger is what would make it un-callable from a dry run.
 */

export interface CacheEntry {
  readonly fingerprint: string;
  /** `undefined` when the rule could not be compiled; `failure` says why. */
  readonly compiled: CompiledPredicate | undefined;
  readonly failure: { readonly reason: CompileFailure; readonly detail: string } | undefined;
}

/**
 * Compiled artifacts, keyed by `<guildId>:<ruleId>` and invalidated by a
 * content fingerprint (ADR 0040 §5).
 *
 * A `Map` the caller owns, rather than module state: the subscriber holds
 * one per instance so two guilds' subscribers cannot share compiled
 * artifacts through a module-level singleton, and a dry run gets a fresh
 * one per invocation so the window tier's mutable state never leaks between
 * runs (ADR 0041 §6).
 */
export type PredicateCache = Map<string, CacheEntry>;

export const createPredicateCache = (): PredicateCache => new Map();

/**
 * Guild-scoped, per CLAUDE.md rule 2 — a bare `ruleId` is not a key.
 * `daemon.ts` seeds every guild's default rule under the same id
 * (`'default-word-filter'`), so with a bare key whichever guild spoke first
 * would decide what every other guild was matched against.
 */
export const predicateCacheKey = (guildId: string, ruleId: string): string =>
  `${guildId}:${ruleId}`;

export type EvaluateOutcome =
  | { readonly kind: 'match'; readonly match: PredicateMatch }
  | { readonly kind: 'no-match' }
  | {
      readonly kind: 'unusable';
      readonly reason: CompileFailure;
      readonly detail: string;
      /**
       * Whether this failure was computed on *this* call rather than read
       * from the cache.
       *
       * The subscriber logs only when it is true, which makes the log once
       * per broken configuration — and again after an operator edits the
       * rule, because an edit changes the fingerprint. That is the ADR 0040
       * §4 behaviour, kept intact while the logger stays out of this module.
       */
      readonly firstSeen: boolean;
    }
  | { readonly kind: 'threw'; readonly error: unknown };

/**
 * Looks up or compiles the rule's artifact, evaluates it, and says what
 * happened. Never throws.
 */
export const evaluateRule = (
  cache: PredicateCache,
  rule: AutomodRule,
  input: PredicateInput,
): EvaluateOutcome => {
  const key = predicateCacheKey(input.guildId, rule.ruleId);
  const fingerprint = ruleFingerprint(rule);
  let entry = cache.get(key);
  let firstSeen = false;

  if (entry === undefined || entry.fingerprint !== fingerprint) {
    firstSeen = true;
    const result = compileRule(rule);
    entry = result.ok
      ? { fingerprint, compiled: result.compiled, failure: undefined }
      : {
          fingerprint,
          compiled: undefined,
          failure: { reason: result.reason, detail: result.detail },
        };
    cache.set(key, entry);
  }

  if (entry.compiled === undefined) {
    const failure = entry.failure ?? {
      reason: 'compile-failed' as const,
      detail: 'the rule has no compiled artifact and no recorded reason',
    };
    return { kind: 'unusable', reason: failure.reason, detail: failure.detail, firstSeen };
  }

  try {
    const match = entry.compiled.evaluate(input);
    return match === undefined ? { kind: 'no-match' } : { kind: 'match', match };
  } catch (error) {
    return { kind: 'threw', error };
  }
};

/**
 * Discord mention syntax, as it appears in message content.
 *
 * `<@123>` and `<@!123>` are user mentions (the `!` form is the legacy
 * nickname variant Discord still delivers), `<@&123>` is a role mention.
 * Verified against a message's raw `content` rather than assumed — this is
 * what makes plan ruling PR-3 work: a text-only fixture can reconstruct the
 * mention lists the window tier reads, because Discord puts them in the text.
 */
const USER_MENTION = /<@!?(\d{17,20})>/g;
const ROLE_MENTION = /<@&(\d{17,20})>/g;

const matchIds = (content: string, pattern: RegExp): string[] =>
  [...content.matchAll(pattern)].map((m) => m[1]).filter((id): id is string => id !== undefined);

export type PredicateInputSource =
  | { readonly from: 'message'; readonly event: MessageEvent }
  | {
      readonly from: 'fixture';
      readonly guildId: string;
      readonly fixture: FixtureRecord;
    };

/**
 * The only place a `PredicateInput` is built (ADR 0041 §3).
 *
 * `undefined` means "this is not a message a predicate can be run against" —
 * a `messageCreate` with no author or no content, which the gateway does
 * deliver (an embed-only system message, a partial the adapter could not
 * resolve). A fixture always produces an input.
 *
 * **What a fixture cannot reproduce**, and why that is recorded here rather
 * than discovered later (plan ruling PR-3): `automod_fixtures` holds text,
 * an author and a timestamp, because that is the shape the owner approved.
 * Mentions come back by parsing the content, since Discord puts them there.
 * Attachments do not — they are metadata the corpus does not hold — so
 * `attachments` is empty for every fixture, and Slice 5's `attachment_type`
 * predicate therefore cannot be dry-run against observed traffic. Its
 * regression cases must be handwritten, and whether the corpus should carry
 * attachment metadata is an owner question for that slice.
 */
export const predicateInputFrom = (source: PredicateInputSource): PredicateInput | undefined => {
  if (source.from === 'message') {
    const { event } = source;
    if (event.authorId === undefined || event.content === undefined) return undefined;
    return {
      guildId: event.guildId,
      channelId: event.channelId,
      messageId: event.messageId,
      authorId: event.authorId,
      eventKind: event.kind,
      content: stripZeroWidth(event.content),
      rawContent: event.content,
      mentionedUserIds: event.mentionedUserIds,
      mentionedRoleIds: event.mentionedRoleIds,
      mentionsEveryone: event.mentionsEveryone,
      attachments: event.attachments,
      atMs: event.receivedAtMs,
    };
  }

  const { fixture } = source;
  // An observed fixture's id is `<messageId>:<contentHash>` (PR-1), so the
  // real message id comes back for free — which matters when a reviewer
  // wants to find the message in Discord. A handwritten fixture has no
  // message behind it and uses its own id.
  const messageId = fixture.source === 'observed' ? (fixture.fixtureId.split(':')[0] ?? fixture.fixtureId) : fixture.fixtureId;
  return {
    guildId: source.guildId,
    // No channel is recorded for a fixture, and inventing a plausible-looking
    // snowflake would be worse than saying so: a predicate that ever branched
    // on it would be silently wrong in a dry run.
    channelId: 'fixture',
    messageId,
    authorId: fixture.authorId ?? 'fixture',
    // A fixture is a message as first posted. Nothing in the corpus records
    // that a message was an edit, so replaying every fixture as a create is
    // the only honest option — and it is the conservative one for Slice 4,
    // where treating an edit as a create counts it once rather than not at all.
    eventKind: 'messageCreate',
    // Already zero-width stripped when captured; stripped again so a
    // handwritten fixture typed with a zero-width character behaves like a
    // captured one rather than like a different kind of input.
    content: stripZeroWidth(fixture.content),
    rawContent: fixture.content,
    mentionedUserIds: matchIds(fixture.content, USER_MENTION),
    mentionedRoleIds: matchIds(fixture.content, ROLE_MENTION),
    mentionsEveryone: fixture.content.includes('@everyone') || fixture.content.includes('@here'),
    attachments: [],
    atMs: fixture.createdAt,
  };
};
```

- [ ] **Step 5: Rewire the subscriber**

In `packages/core/src/automod/subscriber.ts`:

1. Delete the local `CacheEntry` interface and the `matcherCache`/`predicateCache` declaration's type, importing `createPredicateCache`, `evaluateRule`, `predicateInputFrom` and `type PredicateCache` from `./evaluate.js` instead.
2. Replace the `if (event.authorId === undefined || event.content === undefined) return;` guard and the `const normalized = stripZeroWidth(event.content);` line with one call:

```ts
      const input = predicateInputFrom({ from: 'message', event });
      if (input === undefined) return;
      const authorId = input.authorId;
```

Keep this **before** `deps.listRules()`, where the existing guard is — the ordering is a cost decision the current code makes deliberately.

3. Replace the whole inline block (fingerprint lookup, `compileRule`, the error log, the try-wrapped `evaluate`) with:

```ts
        const outcome = evaluateRule(predicateCache, rule, input);
        if (outcome.kind === 'unusable') {
          if (outcome.firstSeen) {
            // Emitted once per broken configuration rather than once per
            // message, and again if the operator edits the rule — an edit
            // changes the fingerprint, which is what `firstSeen` tracks
            // (ADR 0040 §4). `doctor` reports the same rules as a failing
            // check, because a log line nobody is watching is how ADR 0039's
            // silent non-matching survived to production.
            deps.logger.error(
              safeLogFields({
                component: 'automod',
                guildId: event.guildId,
                ruleId: rule.ruleId,
                outcome: outcome.reason,
                compileError: outcome.detail,
              }),
              'the rule could not be compiled; it will not match until it is fixed',
            );
          }
          continue;
        }
        if (outcome.kind === 'threw') {
          deps.logger.error(
            safeLogFields({
              component: 'automod',
              guildId: event.guildId,
              ruleId: rule.ruleId,
              err: outcome.error,
            }),
            'the predicate threw; message left unmatched for this rule',
          );
          continue;
        }
        if (outcome.kind === 'no-match') continue;
        const hit = outcome.match;
```

4. Remove now-unused imports (`stripZeroWidth`, `ruleFingerprint`, `compileRule`, `CompiledPredicate`, `PredicateMatch`) — `npm run lint` will name any you miss.

- [ ] **Step 6: Confirm the refactor changed nothing**

```bash
npx vitest run packages/core/src/automod/subscriber.test.ts
```

Expected: PASS, with **no edits to that file**. Confirm with `git diff --stat packages/core/src/automod/subscriber.test.ts` — expected: empty. If a subscriber test needed changing, the extraction changed behaviour: stop and report it rather than updating the test.

- [ ] **Step 7: Prove the invalidation guard can fail**

Temporarily make `evaluateRule` ignore the fingerprint (`if (entry === undefined)` instead of `if (entry === undefined || entry.fingerprint !== fingerprint)`), run `evaluate.test.ts`, and confirm the "recompiles when the rule's terms change" test goes red. Restore, confirm green, and report both observations. This is the guard on the carried-forward bug that cost ADR 0039 a slice.

- [ ] **Step 8: Export, gates, commit**

Export `createPredicateCache`, `evaluateRule`, `predicateCacheKey`, `predicateInputFrom` and the types from `packages/core/src/index.ts`. Run `npm run typecheck && npm run lint && npm run test`. Stage the new module, its test, `predicates/types.ts`, `subscriber.ts` and `index.ts`. Commit message: `refactor(automod): extract the one predicate code path (ADR 0041 §3)`.

---

### Task 5: Storage — traces on case events, and the verdict repository

**Files:**
- Modify: `packages/storage/src/repos/mod-cases.ts`
- Modify: `packages/storage/src/repos/mod-cases.test.ts` (or create it, if the repo's tests live elsewhere — check first)
- Create: `packages/storage/src/repos/mod-match-reviews.ts`
- Create: `packages/storage/src/repos/mod-match-reviews.test.ts`
- Modify: `packages/storage/src/index.ts`

**Interfaces:**
- Consumes: `modCaseEvents`, `modMatchReviews`, `automodFixtures` from Task 1; the fixture repo's `FixtureLabel` from Task 2.
- Produces:
  - `RecordCaseEventInput` gains `readonly trace?: string` and `readonly fixtureId?: string`
  - `ModCaseEvent` gains `readonly trace: string | undefined` and `readonly fixtureId: string | undefined`
  - `interface ReviewableMatch { eventId, ruleId, memberId, at, matchedCategory, matchedSnippet, actionTaken, trace: string | undefined, fixtureId: string | undefined, fixtureContent: string | undefined }`
  - `listUnreviewedMatches(scope, query: { ruleId?: string; limit: number }): readonly ReviewableMatch[]`
  - `type MatchVerdict = 'false_positive' | 'true_positive' | 'unclear'`
  - `recordVerdict(scope, { eventId, verdict, reviewedBy, reviewedAt, note? }): 'recorded' | 'no-such-event'`
  - `findVerdict(scope, eventId): { verdict: MatchVerdict; reviewedBy: string; reviewedAt: number; note: string | undefined } | undefined`

**Plan ruling PR-7 — a match is reviewable exactly when it has a trace.** `listUnreviewedMatches` filters on `trace IS NOT NULL` rather than on a list of `action_taken` values. Only a predicate match writes a trace, so this excludes manual `/mod` events, native Discord AutoMod events (ADR 0038 — an algorithm nobody can inspect is recorded, never reviewed against our gate), and every row written before this slice. A hand-maintained list of action values would need editing every time the vocabulary grows, and would be wrong quietly. *Cost if wrong:* a genuine match with no trace is invisible to review. Since a trace is written on the same call as the event, that can only happen for pre-Slice-2 rows — which the owner is restarting the clocks on anyway.

**Plan ruling PR-8 — a verdict's label propagation is best-effort and never blocks the verdict.** If the linked fixture is gone (a member used `/forgetme` between the match and the review), `recordVerdict` still records the verdict and reports success. *Cost if wrong:* a corpus row that could have been labelled is not. The verdict — the thing Slice 6's gate counts — is never lost.

- [ ] **Step 1: Extend `recordCaseEvent` and `ModCaseEvent`**

In `packages/storage/src/repos/mod-cases.ts`, add to `RecordCaseEventInput`:

```ts
  /**
   * Why the rule matched, as JSON (ADR 0041 §4). Absent for a manual event
   * and for a native AutoMod event, neither of which came from a predicate.
   *
   * Deliberately a `string`, not a parsed object: `packages/storage` may not
   * import `packages/core` (ADR 0014), and the Zod schema that gives this
   * text meaning lives in `packages/core/src/automod/trace.ts`. The composition
   * root serialises on the way in and `core` validates on the way out — the
   * same arrangement `mod_rules.config` has.
   */
  readonly trace?: string;
  /**
   * The `automod_fixtures` row captured from the same message, if one was
   * (plan ruling PR-5). What lets a verdict recorded during the observe
   * window become a labelled regression fixture afterwards.
   */
  readonly fixtureId?: string;
```

and in the `.values({...})` call:

```ts
        trace: input.trace ?? null,
        fixtureId: input.fixtureId ?? null,
```

Add the matching `trace: row.trace ?? undefined` / `fixtureId: row.fixtureId ?? undefined` fields to `ModCaseEvent` and to `listCaseEvents`' projection.

- [ ] **Step 2: Add `listUnreviewedMatches`**

Still in `mod-cases.ts`:

```ts
export interface ReviewableMatch {
  readonly eventId: string;
  readonly ruleId: string;
  readonly memberId: string;
  readonly at: number;
  readonly matchedCategory: string;
  readonly matchedSnippet: string;
  readonly actionTaken: ModCaseActionTaken;
  /** Raw JSON; `packages/core`'s `parseMatchTrace` is what reads it. */
  readonly trace: string | undefined;
  readonly fixtureId: string | undefined;
  /**
   * The whole message, when the corpus still holds it.
   *
   * `undefined` after a member's `/forgetme` removed the fixture, and for an
   * enforce-mode match, which captures nothing (plan ruling PR-2). A reviewer
   * then judges from the trace and the snippet alone, which is worse but
   * honest — it is the difference between having the evidence and pretending
   * to.
   */
  readonly fixtureContent: string | undefined;
}

/**
 * Matches nobody has ruled on yet, oldest first (ADR 0041 §5, §7).
 *
 * "A match" is defined as "an event with a trace" (plan ruling PR-7): only a
 * predicate match writes one, so this excludes manual `/mod` events and
 * native Discord AutoMod events without a hand-maintained list of
 * `action_taken` values to keep in step with the vocabulary.
 *
 * Two left joins, and both are left joins on purpose: an unreviewed match is
 * precisely one with no `mod_match_reviews` row, and a match whose fixture a
 * member has since deleted must still be reviewable.
 */
export const listUnreviewedMatches = (
  scope: GuildScope,
  query: { readonly ruleId?: string; readonly limit: number },
): readonly ReviewableMatch[] =>
  read(scope, (db) =>
    db
      .select({
        eventId: modCaseEvents.eventId,
        ruleId: modCaseEvents.ruleId,
        memberId: modCaseEvents.memberId,
        at: modCaseEvents.at,
        matchedCategory: modCaseEvents.matchedCategory,
        matchedSnippet: modCaseEvents.matchedSnippet,
        actionTaken: modCaseEvents.actionTaken,
        trace: modCaseEvents.trace,
        fixtureId: modCaseEvents.fixtureId,
        fixtureContent: automodFixtures.content,
      })
      .from(modCaseEvents)
      .leftJoin(
        modMatchReviews,
        and(
          eq(modMatchReviews.guildId, modCaseEvents.guildId),
          eq(modMatchReviews.eventId, modCaseEvents.eventId),
        ),
      )
      .leftJoin(
        automodFixtures,
        and(
          eq(automodFixtures.guildId, modCaseEvents.guildId),
          eq(automodFixtures.fixtureId, modCaseEvents.fixtureId),
        ),
      )
      .where(
        scope.only(
          modCaseEvents,
          isNotNull(modCaseEvents.trace),
          isNull(modMatchReviews.eventId),
          ...(query.ruleId === undefined ? [] : [eq(modCaseEvents.ruleId, query.ruleId)]),
        ),
      )
      .orderBy(asc(modCaseEvents.at), sql`${modCaseEvents.rowid}`)
      .limit(query.limit)
      .all()
      .map((row) => ({
        eventId: row.eventId,
        ruleId: row.ruleId,
        memberId: row.memberId,
        at: row.at,
        matchedCategory: row.matchedCategory,
        matchedSnippet: row.matchedSnippet,
        actionTaken: row.actionTaken as ModCaseActionTaken,
        trace: row.trace ?? undefined,
        fixtureId: row.fixtureId ?? undefined,
        fixtureContent: row.fixtureContent ?? undefined,
      })),
  );
```

If drizzle rejects `modCaseEvents.rowid` (the table has no declared `rowid` column), use the raw `sql\`mod_case_events.rowid\`` form the existing `listCaseEvents` uses, and read that function's docstring for why a `rowid` tiebreaker is needed at all — `at` legitimately ties.

- [ ] **Step 3: Write the verdict repository**

Create `packages/storage/src/repos/mod-match-reviews.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import { automodFixtures, modCaseEvents, modMatchReviews } from '../schema.js';

/**
 * A human's verdict on one recorded match (ADR 0041 §5).
 *
 * Separate from `mod-cases.ts` because it holds a different kind of fact: a
 * case event says what the bot did and is never rewritten (ADR 0036); a
 * verdict is a later judgement about that record, by a named person, at a
 * known time, and revisable.
 */

export type MatchVerdict = 'false_positive' | 'true_positive' | 'unclear';

/**
 * What a verdict means for the regression corpus (plan ruling PR-5).
 *
 * `unclear` deliberately maps to nothing: it is a real verdict for the Slice
 * 6 gate (the spec's decision 16 counts it as a false positive there), but a
 * reviewer who could not decide has not told us what the right answer is, and
 * writing a label from a non-decision would put a wrong expectation into the
 * regression suite.
 */
const LABEL_FOR_VERDICT: Readonly<Record<MatchVerdict, 'should_match' | 'should_not_match' | undefined>> = {
  true_positive: 'should_match',
  false_positive: 'should_not_match',
  unclear: undefined,
};

export interface RecordVerdictInput {
  readonly eventId: string;
  readonly verdict: MatchVerdict;
  readonly reviewedBy: string;
  readonly reviewedAt: number;
  readonly note?: string;
}

/**
 * Records a verdict and, when the verdict says what the right answer was,
 * labels the fixture captured from the same message.
 *
 * One transaction, so a verdict and the label it implies cannot disagree.
 *
 * The fixture update is best-effort (plan ruling PR-8): a member may have
 * used `/forgetme` between the match and the review, and the verdict — the
 * fact Slice 6's gate counts — must not be lost because the evidence behind
 * it was withdrawn.
 *
 * `'no-such-event'` rather than a thrown error: an operator typing an event
 * id at a terminal will mistype one, and that is a usage answer, not a fault.
 */
export const recordVerdict = (
  scope: GuildScope,
  input: RecordVerdictInput,
): 'recorded' | 'no-such-event' =>
  write(scope, ({ db }) => {
    const event = db
      .select({ fixtureId: modCaseEvents.fixtureId })
      .from(modCaseEvents)
      .where(scope.only(modCaseEvents, eq(modCaseEvents.eventId, input.eventId)))
      .get();
    if (event === undefined) return 'no-such-event';

    db.insert(modMatchReviews)
      .values({
        guildId: scope.guildId,
        eventId: input.eventId,
        verdict: input.verdict,
        reviewedBy: input.reviewedBy,
        reviewedAt: input.reviewedAt,
        note: input.note ?? null,
      })
      // A reviewer who changes their mind updates the verdict rather than
      // appending a second one (plan ruling PR-4). Targeted at the primary
      // key, not unqualified: an unqualified conflict clause in SQLite also
      // swallows CHECK violations, which would silently discard an invalid
      // verdict instead of throwing.
      .onConflictDoUpdate({
        target: [modMatchReviews.guildId, modMatchReviews.eventId],
        set: {
          verdict: input.verdict,
          reviewedBy: input.reviewedBy,
          reviewedAt: input.reviewedAt,
          note: input.note ?? null,
        },
      })
      .run();

    const label = LABEL_FOR_VERDICT[input.verdict];
    if (label !== undefined && event.fixtureId !== null) {
      db.update(automodFixtures)
        .set({ label })
        .where(scope.only(automodFixtures, eq(automodFixtures.fixtureId, event.fixtureId)))
        .run();
    }

    return 'recorded';
  });

export interface StoredVerdict {
  readonly verdict: MatchVerdict;
  readonly reviewedBy: string;
  readonly reviewedAt: number;
  readonly note: string | undefined;
}

export const findVerdict = (scope: GuildScope, eventId: string): StoredVerdict | undefined =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(modMatchReviews)
      .where(scope.only(modMatchReviews, eq(modMatchReviews.eventId, eventId)))
      .get();
    return row === undefined
      ? undefined
      : {
          verdict: row.verdict as MatchVerdict,
          reviewedBy: row.reviewedBy,
          reviewedAt: row.reviewedAt,
          note: row.note ?? undefined,
        };
  });
```

- [ ] **Step 4: Write the tests**

Create `packages/storage/src/repos/mod-match-reviews.test.ts`. Each test seeds a guild, a case, and a case event carrying a `trace` and a `fixtureId`, using the fixture repo from Task 2 to create the fixture.

```ts
it('records a verdict and labels the fixture it came from', () => {
  const fixtureId = captureObservedFixture(scope, {
    messageId: '900000000000000001',
    content: 'perfectly ordinary sentence',
    authorId: '800000000000000001',
    createdAt: 1_000,
  });
  seedMatchEvent(scope, { eventId: 'e1', fixtureId, trace: '{"kind":"keyword_filter"}' });

  expect(
    recordVerdict(scope, {
      eventId: 'e1',
      verdict: 'false_positive',
      reviewedBy: '700000000000000001',
      reviewedAt: 5_000,
      note: 'ordinary club chat',
    }),
  ).toBe('recorded');

  expect(listFixtures(scope)[0]?.label).toBe('should_not_match');
});

it('labels a true positive the other way', () => {
  // ... verdict 'true_positive' -> label 'should_match'
});

it('leaves the fixture unlabelled for an unclear verdict', () => {
  // A reviewer who could not decide has not told us the right answer;
  // writing a label from a non-decision would poison the regression suite.
  // ... verdict 'unclear' -> label stays 'unlabelled', verdict still recorded
});

it('replaces a revised verdict rather than appending a second', () => {
  // ... two recordVerdict calls, findVerdict returns the second
});

it('records the verdict even when the fixture has been forgotten', () => {
  const fixtureId = captureObservedFixture(scope, { /* ... */ });
  seedMatchEvent(scope, { eventId: 'e1', fixtureId, trace: '{}' });
  deleteObservedFixturesForMember(scope, '800000000000000001');

  expect(recordVerdict(scope, { eventId: 'e1', verdict: 'true_positive', reviewedBy: '7...', reviewedAt: 5_000 })).toBe('recorded');
  expect(findVerdict(scope, 'e1')?.verdict).toBe('true_positive');
});

it('reports no-such-event for an id that is not there', () => {
  expect(recordVerdict(scope, { eventId: 'nope', verdict: 'unclear', reviewedBy: '7...', reviewedAt: 1 })).toBe('no-such-event');
});

it('cannot record a verdict against another guild’s event', () => {
  seedMatchEvent(scopeA, { eventId: 'e1', fixtureId: undefined, trace: '{}' });
  expect(recordVerdict(scopeB, { eventId: 'e1', verdict: 'true_positive', reviewedBy: '7...', reviewedAt: 1 })).toBe('no-such-event');
});

it('refuses a verdict value the vocabulary does not have', () => {
  // The CHECK constraint is the real enforcement point; this proves it fires
  // rather than being swallowed by the conflict clause.
  seedMatchEvent(scope, { eventId: 'e1', fixtureId: undefined, trace: '{}' });
  expect(() =>
    recordVerdict(scope, { eventId: 'e1', verdict: 'maybe' as MatchVerdict, reviewedBy: '7...', reviewedAt: 1 }),
  ).toThrow();
});
```

And in `mod-cases.test.ts`, for `listUnreviewedMatches`:

```ts
it('lists only matches with a trace, and only unreviewed ones', () => {
  seedMatchEvent(scope, { eventId: 'traced', trace: '{"kind":"keyword_filter"}' });
  seedMatchEvent(scope, { eventId: 'manual', trace: undefined });   // a /mod warn
  seedMatchEvent(scope, { eventId: 'reviewed', trace: '{"kind":"keyword_filter"}' });
  recordVerdict(scope, { eventId: 'reviewed', verdict: 'true_positive', reviewedBy: '7...', reviewedAt: 1 });

  expect(listUnreviewedMatches(scope, { limit: 50 }).map((m) => m.eventId)).toEqual(['traced']);
});

it('brings the whole message along when the corpus still has it', () => { /* fixtureContent set */ });
it('still lists a match whose fixture was forgotten', () => { /* fixtureContent undefined, row present */ });
it('does not list another guild’s matches', () => { /* ... */ });
it('filters by rule id', () => { /* ... */ });
```

- [ ] **Step 5: Prove two guards can fail**

1. Change `isNull(modMatchReviews.eventId)` to `isNotNull(...)` and confirm "only unreviewed ones" goes red. Restore.
2. Change the second `leftJoin` to an inner `innerJoin` and confirm "still lists a match whose fixture was forgotten" goes red. Restore.

**Report both observations.** Guard 2 in particular: an inner join here would make a member's `/forgetme` silently erase matches from the review queue, which would flatter the false-positive rate the Release 2 gate is computed from.

- [ ] **Step 6: Export, gates, commit**

Add `export * as modMatchReviewRepo from './repos/mod-match-reviews.js';` to `packages/storage/src/index.ts`. Run `npm run typecheck && npm run lint && npm run test`. Commit message: `feat(storage): stored traces, reviewable matches, and match verdicts (ADR 0041)`.

---

### Task 6: The subscriber captures fixtures and stores traces

**Files:**
- Modify: `packages/core/src/automod/subscriber.ts`
- Modify: `packages/core/src/automod/subscriber.test.ts`
- Modify: `apps/daemon/src/automod/wiring.ts`
- Modify: `apps/daemon/src/automod/wiring.test.ts` if one exists (check)

**Interfaces:**
- Consumes: `evaluateRule`/`predicateInputFrom` from Task 4; `serialiseTrace` from Task 3; `captureObservedFixture` and `recordCaseEvent`'s new fields from Tasks 2 and 5.
- Produces: `AutomodSubscriberDeps` gains `captureFixture`; its `recordCaseEvent` input gains `fixtureId`.

- [ ] **Step 1: Add the capture port to `AutomodSubscriberDeps`**

```ts
  /**
   * Records this message as review evidence, and returns the fixture id — or
   * `undefined` if nothing was captured.
   *
   * Called only for a match by a rule in `test` or `observe` mode (ADR 0041
   * §2, plan ruling PR-2). Three boundaries meet here and all three are
   * deliberate:
   *
   * - **Only matched messages.** Capturing traffic that matched nothing would
   *   build a message archive by the back door, under a decision the owner
   *   made about a *review corpus* — and Release 3 gates archive ingestion
   *   behind a default-deny channel scope (ADR 0009).
   * - **Not in `enforce` mode.** `PRIVACY.md` promises deleted-message
   *   content is kept 30 days; a fixture has no expiry, so capturing the
   *   content of a message the bot just deleted would make the policy untrue.
   * - **Never fatal.** The implementation swallows its own errors: a corpus
   *   write failing must not stop a deletion or an escalation.
   */
  captureFixture(input: {
    messageId: string;
    /** Zero-width stripped — what the predicate matched against. */
    content: string;
    authorId: string;
    atMs: number;
  }): string | undefined;
```

and add to the `recordCaseEvent` input type:

```ts
    /** The corpus row captured from this message, if there was one (PR-5). */
    fixtureId: string | undefined;
```

- [ ] **Step 2: Call it from the match path**

In `subscriber.ts`, immediately after `const hit = outcome.match;`:

```ts
        // Evidence for the observe window, captured before anything is done
        // about the match — so a review is possible even if the moderation
        // action below fails or is refused.
        const fixtureId =
          rule.mode === 'enforce'
            ? undefined
            : deps.captureFixture({
                messageId: input.messageId,
                content: input.content,
                authorId,
                atMs: input.atMs,
              });
```

and thread `fixtureId` into the `record(...)` helper's `deps.recordCaseEvent({...})` call, alongside the `trace: hit.trace` it already passes.

- [ ] **Step 3: Test it**

Add to `subscriber.test.ts`:

```ts
it('captures a matched message as review evidence in test mode', () => { /* captureFixture called once with the stripped content */ });
it('does not capture in enforce mode', () => {
  // PRIVACY.md keeps deleted-message content for 30 days; a fixture has no
  // expiry, so capturing what the bot just deleted would make the policy
  // untrue. ADR 0041 §2 / plan ruling PR-2.
});
it('does not capture a message no rule matched', () => { /* captureFixture never called */ });
it('records the fixture id and the trace on the case event', () => { /* ... */ });
it('still deletes and escalates when capture throws', () => {
  // The corpus is evidence, not enforcement. A failing corpus write must not
  // become a moderation outage.
});
```

For the last one, the fake `captureFixture` throws; assert the deletion still happened and a case event was still recorded. **This requires `captureFixture`'s *caller* to be safe, not just its implementation** — wrap the call site in `try/catch` in `subscriber.ts` (logging with `safeLogFields`, never the content) so a port implementation that throws cannot take the handler down.

- [ ] **Step 4: Watch two guards fail**

1. Remove the `rule.mode === 'enforce'` condition; confirm "does not capture in enforce mode" goes red. Restore.
2. Remove the `try/catch` around the capture call; confirm "still deletes and escalates when capture throws" goes red. Restore.

Report both.

- [ ] **Step 5: Wire it in the daemon**

In `apps/daemon/src/automod/wiring.ts`:

```ts
    captureFixture: (input) =>
      automodFixtureRepo.captureObservedFixture(scope, {
        messageId: input.messageId,
        content: input.content,
        authorId: input.authorId,
        createdAt: input.atMs,
      }),
```

and replace the `recordCaseEvent: ({ trace: _trace, ...input })` destructure — the comment above it says the trace is "dropped here, deliberately and visibly … until Slice 2 adds the column", and this is that slice. Delete that comment and serialise instead:

```ts
    recordCaseEvent: (input) =>
      modCaseRepo.recordCaseEvent(scope, {
        eventId: randomUUID(),
        at: now(),
        // ... the existing fields, unchanged ...
        ...(input.fixtureId !== undefined && { fixtureId: input.fixtureId }),
        ...(traceJson(input.trace, logger) !== undefined && {
          trace: traceJson(input.trace, logger) as string,
        }),
      }),
```

with a module-level helper — and call it once, not twice, unlike the sketch above:

```ts
/**
 * Serialises a trace, or gives up and says so (plan ruling PR-8).
 *
 * `serialiseTrace` throws when a predicate produced a trace its own schema
 * rejects — a bug in our code, which is why it throws rather than returning a
 * result. But the composition root is not the place to let that bug become a
 * moderation outage: the case event is the record ADR 0036 exists to
 * guarantee, and losing it to save a field of evidence is the wrong trade.
 * So the failure is logged loudly and the event is written without a trace.
 */
const traceJson = (trace: MatchTrace, logger: Logger): string | undefined => {
  try {
    return serialiseTrace(trace);
  } catch (err) {
    logger.error(
      safeLogFields({ component: 'automod', guildId: scope.guildId, err }),
      'the predicate produced a trace that failed validation; the case event was recorded without it',
    );
    return undefined;
  }
};
```

Keep `exactOptionalPropertyTypes` in mind: the existing file already uses the `...(x !== undefined && { x })` spread idiom for exactly this reason. Read it and follow it.

- [ ] **Step 6: Gates and commit**

`npm run typecheck && npm run lint && npm run test`. Commit message: `feat(automod): capture matched messages and store their traces (ADR 0041 §1, §4)`.

---

### Task 7: The dry-run evaluator, and the one-code-path gate

**Files:**
- Create: `packages/core/src/automod/dry-run.ts`
- Create: `packages/core/src/automod/dry-run.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `createPredicateCache`, `evaluateRule`, `predicateInputFrom` from Task 4; `AutomodRule`, `FixtureRecord`, `PredicateMatch` from `./predicates/types.js`.
- Produces:
  - `interface DryRunFixtureResult { fixtureId, label, matched, match: PredicateMatch | undefined, agreement: 'agreed' | 'disagreed' | 'unlabelled' }`
  - `interface DryRunReport { ruleId, kind, usable, failure, total, matched, falsePositives, falseNegatives, results }`
  - `runDryRun(input: { guildId: string; rule: AutomodRule; fixtures: readonly FixtureRecord[] }): DryRunReport`

**This task carries the slice's named gate** (spec §4): "an assertion that the dry-run evaluator and the live subscriber share one predicate code path. If they diverge, the entire Release 2 gate is measuring a fiction."

- [ ] **Step 1: Write the failing tests, gate first**

```ts
describe('the one-code-path invariant', () => {
  it('produces byte-identical matches to the live subscriber, trace included', async () => {
    const rule = ruleWith(['badword']);
    const content = 'hello badword everyone';

    // Live path: a real subscriber, fake ports, one message event.
    const recorded: { trace?: MatchTrace; categoryId?: string; snippet?: string } = {};
    const subscriber = createAutomodSubscriber({
      ...fakeDeps(),
      listRules: () => [rule],
      recordCaseEvent: (input) => {
        recorded.trace = input.trace;
        recorded.categoryId = input.matchedCategory;
        recorded.snippet = input.matchedSnippet;
      },
    });
    await subscriber.handle(messageEvent({ content, receivedAtMs: 1_000 }));

    // Dry-run path: the same text as a fixture, replayed.
    const report = runDryRun({
      guildId: GUILD_ID,
      rule,
      fixtures: [
        {
          fixtureId: '300000000000000001:abcdef0123456789',
          content,
          authorId: '400000000000000001',
          label: 'unlabelled',
          source: 'observed',
          createdAt: 1_000,
        },
      ],
    });

    const replayed = report.results[0]?.match;
    expect(replayed).toBeDefined();
    expect(replayed?.trace).toEqual(recorded.trace);
    expect(replayed?.categoryId).toEqual(recorded.categoryId);
    expect(replayed?.snippet).toEqual(recorded.snippet);
  });
});

describe('runDryRun', () => {
  it('is deterministic across runs, and across a rule that carries state', () => {
    // Every run compiles a fresh artifact (ADR 0041 §6), so the window
    // tier's sliding-window state cannot leak between runs. Two identical
    // runs must give identical reports.
    const args = { guildId: GUILD_ID, rule: ruleWith(['badword']), fixtures: FIXTURES };
    expect(runDryRun(args)).toEqual(runDryRun(args));
  });

  it('replays fixtures oldest first', () => { /* results in created_at order */ });

  it('takes each fixture’s clock from its own created_at', () => { /* atMs threaded through */ });

  it('counts a should_not_match fixture that matched as a false positive', () => { /* ... */ });

  it('counts a should_match fixture that did not match as a false negative', () => { /* ... */ });

  it('marks an unlabelled fixture as neither, rather than guessing', () => {
    // The corpus is mostly unlabelled during the window; counting an
    // unlabelled non-match as a success would make every rule look perfect
    // on day one.
    // ... agreement === 'unlabelled', not counted in either total
  });

  it('reports an unusable rule instead of reporting zero matches', () => {
    // ADR 0040 §4's failure mode, in the dry run: a rule that cannot compile
    // matches nothing, and "0 matches" reads exactly like a well-behaved
    // rule. `usable: false` and the reason are what stop an operator
    // concluding the rule is clean.
    const report = runDryRun({ guildId: GUILD_ID, rule: ruleWith([]), fixtures: FIXTURES });
    expect(report.usable).toBe(false);
    expect(report.failure?.reason).toBe('no-terms');
    expect(report.matched).toBe(0);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement**

```ts
import {
  createPredicateCache,
  evaluateRule,
  predicateInputFrom,
  type EvaluateOutcome,
} from './evaluate.js';
import type { CompileFailure } from './predicates/registry.js';
import type { AutomodRule, FixtureRecord, PredicateMatch } from './predicates/types.js';

/**
 * Replays one rule over the fixture corpus (ADR 0041 §6).
 *
 * The whole point is that it is *not* a second evaluator: it builds its
 * input with `predicateInputFrom` and evaluates with `evaluateRule`, which
 * are the same two functions the live subscriber calls. A parallel
 * implementation would test something other than production, and the entire
 * Release 2 gate rests on this dry run being honest.
 */

export interface DryRunFixtureResult {
  readonly fixtureId: string;
  readonly label: FixtureRecord['label'];
  readonly matched: boolean;
  readonly match: PredicateMatch | undefined;
  /**
   * Whether the rule agreed with the human who labelled this fixture.
   *
   * `'unlabelled'` is a third value rather than a default to `'agreed'`:
   * during the observe window most of the corpus is unlabelled, and counting
   * an unlabelled non-match as a success would make every rule look perfect
   * on the day it shipped.
   */
  readonly agreement: 'agreed' | 'disagreed' | 'unlabelled';
}

export interface DryRunReport {
  readonly ruleId: string;
  readonly kind: string;
  /**
   * False when the rule could not be compiled — the ADR 0040 §4 failure
   * mode, which in a dry run looks exactly like a well-behaved rule that
   * matched nothing. Reported so an operator cannot read "0 matches" as
   * "clean".
   */
  readonly usable: boolean;
  readonly failure: { readonly reason: CompileFailure; readonly detail: string } | undefined;
  readonly total: number;
  readonly matched: number;
  /** `should_not_match` fixtures the rule matched anyway. */
  readonly falsePositives: number;
  /** `should_match` fixtures the rule missed. */
  readonly falseNegatives: number;
  readonly results: readonly DryRunFixtureResult[];
}

export interface RunDryRunInput {
  readonly guildId: string;
  readonly rule: AutomodRule;
  readonly fixtures: readonly FixtureRecord[];
}

export const runDryRun = (input: RunDryRunInput): DryRunReport => {
  // A fresh cache per run, never a shared one: the window tier (Slice 4)
  // carries mutable sliding-window state on its compiled artifact, so a
  // reused artifact would make a run's result depend on what ran before it
  // (ADR 0041 §6).
  const cache = createPredicateCache();

  // Oldest first. The caller is expected to pass them in order, but sorting
  // here means a dry run cannot silently depend on the caller having
  // remembered — the same reasoning `listFixtures` gives for its ORDER BY.
  const ordered = [...input.fixtures].sort(
    (a, b) => a.createdAt - b.createdAt || a.fixtureId.localeCompare(b.fixtureId),
  );

  const results: DryRunFixtureResult[] = [];
  let failure: DryRunReport['failure'];

  for (const fixture of ordered) {
    const predicateInput = predicateInputFrom({
      from: 'fixture',
      guildId: input.guildId,
      fixture,
    });
    // `predicateInputFrom` only returns `undefined` for a message with no
    // author or content; a fixture always produces an input. Handled rather
    // than asserted, because a `!` here would be a cast in the one module
    // whose job is to be trustworthy.
    if (predicateInput === undefined) continue;

    const outcome: EvaluateOutcome = evaluateRule(cache, input.rule, predicateInput);
    if (outcome.kind === 'unusable') {
      failure = { reason: outcome.reason, detail: outcome.detail };
      results.push({
        fixtureId: fixture.fixtureId,
        label: fixture.label,
        matched: false,
        match: undefined,
        agreement: 'unlabelled',
      });
      continue;
    }

    // A predicate that throws on one fixture is recorded as a non-match for
    // that fixture and the replay continues — one malformed message must not
    // end the run, the same way it does not end the live handler.
    const match = outcome.kind === 'match' ? outcome.match : undefined;
    const matched = match !== undefined;
    const agreement =
      fixture.label === 'unlabelled'
        ? ('unlabelled' as const)
        : (fixture.label === 'should_match') === matched
          ? ('agreed' as const)
          : ('disagreed' as const);

    results.push({ fixtureId: fixture.fixtureId, label: fixture.label, matched, match, agreement });
  }

  return {
    ruleId: input.rule.ruleId,
    kind: input.rule.kind,
    usable: failure === undefined,
    failure,
    total: results.length,
    matched: results.filter((r) => r.matched).length,
    falsePositives: results.filter((r) => r.label === 'should_not_match' && r.matched).length,
    falseNegatives: results.filter((r) => r.label === 'should_match' && !r.matched).length,
    results,
  };
};
```

- [ ] **Step 4: Watch the gate fail**

This is the most important "watch it fail" in the slice. Temporarily fork the code path: inside `runDryRun`, replace the `evaluateRule(cache, ...)` call with a direct `compileRule(input.rule)` plus `compiled.evaluate(predicateInput)`, but change *one* thing about the input — pass `fixture.content` rather than the stripped `predicateInput.content`. Run the gate test.

- If it goes red: good. Restore and confirm green.
- **If it stays green, the gate is decorative** and must be strengthened until a real divergence breaks it. Report what you changed and what happened either way.

- [ ] **Step 5: Export, gates, commit**

Export `runDryRun` and its types from `packages/core/src/index.ts`. Run the gates. Commit message: `feat(automod): the dry-run evaluator, sharing one code path with production (ADR 0041 §3, §6)`.

---

### Task 8: `bananasaurs automod dryrun <ruleId>`

**Files:**
- Create: `packages/core/src/ops/commands/automod.ts`
- Create: `packages/core/src/ops/commands/automod.test.ts`
- Modify: `packages/core/src/ops/ports.ts`, `packages/core/src/ops/registry.ts`, `packages/core/src/ops/test-fixtures.ts`
- Modify: `apps/daemon/src/ops/wiring.ts`

**Interfaces:**
- Consumes: `runDryRun` (Task 7), `renderTrace` (Task 3), `defineCommand`/`OpsContext`/`OpsCommandResult` from `../dispatch.js`.
- Produces:
  - `OpsPorts` gains `findAutomodRule(ruleId: string): AutomodRule | undefined` and `listAutomodFixtures(filter: { source?: 'observed' | 'handwritten' }): readonly FixtureRecord[]`
  - `automodDryRunCommand`

**Context for the implementer.** Read `packages/core/src/ops/commands/reads.ts` end to end first — every read command in this project has the same three-part shape (a port call, a projection, a rendering that produces both `text` for a terminal and `data` for `--json`), and this must match it rather than inventing a fourth. `defineCommand` is in `../dispatch.js`; `positional` and `flags` are declared on the command itself so the CLI can parse and `--help` without a daemon (`packages/cli/src/args.ts` reads the same catalogue).

- [ ] **Step 1: Add the two ports**

In `packages/core/src/ops/ports.ts`, on `OpsPorts`, in the read-commands section:

```ts
  /** One enabled or disabled rule by id, hydrated the way the subscriber sees it. */
  findAutomodRule(ruleId: string): AutomodRule | undefined;
  /**
   * The review corpus, oldest first.
   *
   * The whole corpus, not a page: a dry run's numbers are only meaningful
   * over the whole thing, and a truncated replay would report a
   * false-positive count for a subset while looking like one for the corpus.
   * At club volume this is a few thousand rows.
   */
  listAutomodFixtures(filter: {
    readonly source?: 'observed' | 'handwritten';
  }): readonly FixtureRecord[];
```

Add the matching stubs to `packages/core/src/ops/test-fixtures.ts` (returning `undefined` / `[]`), following whatever convention that file already uses.

- [ ] **Step 2: Write the failing tests**

Create `packages/core/src/ops/commands/automod.test.ts`:

```ts
describe('automod dryrun', () => {
  it('refuses a rule id that is not there, without pretending it matched nothing', () => {
    const result = run(automodDryRunCommand, ctxWith({ findAutomodRule: () => undefined }), {
      ruleId: 'no-such-rule',
    });
    expect(result.text).toContain('no rule');
    expect(result.data).toMatchObject({ ok: false });
  });

  it('reports matches, misses, and the label disagreements', () => {
    const result = run(automodDryRunCommand, ctxWith({
      findAutomodRule: () => ruleWith(['badword']),
      listAutomodFixtures: () => [
        fixture({ fixtureId: 'f1', content: 'hello badword', label: 'should_match' }),
        fixture({ fixtureId: 'f2', content: 'ordinary chat', label: 'should_not_match' }),
        fixture({ fixtureId: 'f3', content: 'badword again', label: 'should_not_match' }),
      ],
    }), { ruleId: 'r1' });

    expect(result.data).toMatchObject({
      total: 3,
      matched: 2,
      falsePositives: 1,
      falseNegatives: 0,
    });
  });

  it('says the rule is unusable rather than reporting a clean zero', () => {
    // ADR 0040 §4: a rule that cannot compile matches nothing, and "0
    // matches" reads exactly like a rule behaving perfectly.
    const result = run(automodDryRunCommand, ctxWith({
      findAutomodRule: () => ruleWith([]),
      listAutomodFixtures: () => [fixture({ fixtureId: 'f1', content: 'anything' })],
    }), { ruleId: 'r1' });

    expect(result.text).toContain('cannot be compiled');
    expect(result.data).toMatchObject({ usable: false });
  });

  it('renders each match’s trace against the fixture’s own message', () => {
    const result = run(/* ... a matching fixture ... */);
    expect(result.text).toContain('[badword]');
    expect(result.text).toContain('matched on');
  });

  it('says so plainly when the corpus is empty', () => {
    // The first day of the observe window has no fixtures, and a report of
    // "0 matches, 0 false positives" would read as a passing rule.
    const result = run(automodDryRunCommand, ctxWith({
      findAutomodRule: () => ruleWith(['badword']),
      listAutomodFixtures: () => [],
    }), { ruleId: 'r1' });
    expect(result.text).toContain('corpus is empty');
  });
});
```

- [ ] **Step 3: Implement the command**

```ts
export const automodDryRunCommand = defineCommand<{ ruleId: string; source?: 'observed' | 'handwritten' }>({
  name: 'automod dryrun',
  write: false,
  summary: 'replay one rule over the fixture corpus and report what it would match',
  positional: [{ name: 'ruleId', required: true, describe: 'the rule to replay' }],
  flags: [
    { name: 'source', kind: 'string', describe: 'observed | handwritten (default: both)' },
  ],
  args: z.object({
    ruleId: z.string().min(1),
    source: z.enum(['observed', 'handwritten']).optional(),
  }),
  run(ctx, args): OpsCommandResult {
    const rule = ctx.ports.findAutomodRule(args.ruleId);
    if (rule === undefined) {
      return {
        text: `there is no rule ${args.ruleId} in this guild`,
        data: { ok: false, reason: 'no-such-rule', ruleId: args.ruleId },
      };
    }

    const fixtures = ctx.ports.listAutomodFixtures(
      args.source === undefined ? {} : { source: args.source },
    );
    const report = runDryRun({ guildId: ctx.guildId, rule, fixtures });

    // ... rendering, below ...
  },
});
```

Rendering rules, in order:

1. If `!report.usable`: lead with `rule ${ruleId} (${kind}) cannot be compiled: ${failure.reason} — ${failure.detail}` and stop. A count under an unusable rule is noise at best and misleading at worst.
2. If `report.total === 0`: `the corpus is empty; there is nothing to replay this rule against`. Do not print a table of zeroes.
3. Otherwise a summary line — `${matched}/${total} matched · ${falsePositives} false positive(s) · ${falseNegatives} missed` — then, for each *matched* result, the fixture id, the label, and `renderTrace(result.match.trace, fixtureContent)` indented beneath it. Non-matching fixtures are listed only when they were labelled `should_match` (a miss the operator needs to see); an unlabelled non-match is the ordinary case and printing thousands of them would bury the signal.
4. `data` is the `DryRunReport` itself, minus the per-result `match` objects' non-serialisable parts (there are none — `PredicateMatch` is plain data). Check it satisfies `JsonValue`; if `readonly` arrays fight the type, map to a fresh structure rather than casting.

- [ ] **Step 4: Register and wire**

Add `automodDryRunCommand` to `OPERATOR_COMMANDS` in `packages/core/src/ops/registry.ts`, in the reads block. In `apps/daemon/src/ops/wiring.ts`:

```ts
  findAutomodRule: (ruleId) =>
    automodRuleRepo.listEnabledRules(scope).find((r) => r.ruleId === ruleId),
  listAutomodFixtures: (filter) => automodFixtureRepo.listFixtures(scope, filter),
```

`listEnabledRules` returns only enabled rules — that is the honest thing to dry-run, since a disabled rule is not going to match anything in production either. If a disabled rule needs replaying later, that is a repo function this task does not add.

- [ ] **Step 5: Prove the unusable-rule guard can fail**

Remove the `!report.usable` branch so an unusable rule falls through to the summary rendering, and confirm the "says the rule is unusable" test goes red. Restore. Report the observation. This is the ADR 0039 failure mode in its newest disguise: a rule that reads as clean because it never fired.

- [ ] **Step 6: Gates and commit**

`npm run typecheck && npm run lint && npm run test`. Commit message: `feat(ops): automod dryrun — replay a rule over the corpus (ADR 0041 §7)`.

---

### Task 9: `bananasaurs automod review` and `automod verdict`

**Files:**
- Modify: `packages/core/src/ops/commands/automod.ts`, `packages/core/src/ops/commands/automod.test.ts`
- Modify: `packages/core/src/ops/ports.ts`, `packages/core/src/ops/registry.ts`, `packages/core/src/ops/test-fixtures.ts`
- Modify: `apps/daemon/src/ops/wiring.ts`
- Modify: `docs/17_OPERATOR_CLI.md` if it exists (check; if the file names the command surface, this slice adds three rows to it)

**Interfaces:**
- Consumes: `listUnreviewedMatches` and `recordVerdict` from Task 5; `parseMatchTrace`/`renderTrace` from Task 3.
- Produces:
  - `interface OpsReviewableMatch { eventId, ruleId, memberId, at, matchedCategory, matchedSnippet, actionTaken, trace: string | undefined, fixtureContent: string | undefined }` on `ports.ts`
  - `OpsPorts` gains `listUnreviewedMatches(query: { ruleId?: string; limit: number }): readonly OpsReviewableMatch[]` and `recordMatchVerdict(input: { eventId: string; verdict: 'false_positive' | 'true_positive' | 'unclear'; reviewedBy: string; note?: string }): 'recorded' | 'no-such-event'`
  - `automodReviewCommand` (read), `automodVerdictCommand` (write)

**Plan ruling PR-9 — `mod_match_reviews.reviewed_by` is plain TEXT, not a snowflake.**
Two reviewers exist with two kinds of identity: Slice 9's dashboard authenticates a Discord user and writes a snowflake, while the operator CLI has only the Unix user the invocation claims (ADR 0024) and writes `cli:<unixUserClaimed>`. A snowflake CHECK would make the CLI path — the one that ships *first*, and covers the whole first fortnight of the window — impossible to write.

This field is **provenance, not authorisation**: the socket's group permissions are the access control (ADR 0024, amendment 2), and the audit row the dispatcher writes is the authoritative record of who ran the command. `reviewed_by` exists so a later reader can ask "who thought this?" and get an answer.

**Task 1's schema must therefore declare `reviewedBy: text('reviewed_by').notNull()` with no `snowflakeCheck`.** If Task 1 already shipped it as a snowflake column, this task changes it — and because it is a CHECK removal, drizzle-kit will emit a **table rebuild**, which Global Constraint 5 forbids. In that case: leave the column as it is, write `cli:<user>` only if the CHECK permits it (it will not), and instead report BLOCKED so the coordinator can rule. Do not hand-write a rebuild migration.

*Cost if wrong:* a reviewer identity that is not a Discord snowflake cannot be rendered as a mention, so Slice 9's screen must handle both forms — one branch on a string prefix.

- [ ] **Step 1: Write the failing tests**

```ts
describe('automod review', () => {
  it('lists unreviewed matches with the message and the rendered trace', () => {
    const result = run(automodReviewCommand, ctxWith({
      listUnreviewedMatches: () => [
        {
          eventId: 'e1',
          ruleId: 'r1',
          memberId: '800000000000000001',
          at: 1_700_000_000_000,
          matchedCategory: 'profanity',
          matchedSnippet: 'badword',
          actionTaken: 'would_delete',
          trace: '{"kind":"keyword_filter","matchedOn":"badword","span":[6,13],"normalisations":["lowercased"],"detail":{}}',
          fixtureContent: 'hello badword everyone',
        },
      ],
    }), {});

    expect(result.text).toContain('e1');
    expect(result.text).toContain('hello [badword] everyone');
    expect(result.text).toContain('bananasaurs automod verdict e1');
  });

  it('renders a match whose trace is malformed without hiding the match', () => {
    // A trace read back from the database is untrusted (CLAUDE.md rule 3).
    // A row this build cannot parse is still a match a human must rule on,
    // so the trace is replaced by a reason, not the row by nothing.
    const result = run(automodReviewCommand, ctxWith({
      listUnreviewedMatches: () => [match({ eventId: 'e1', trace: 'not json' })],
    }), {});
    expect(result.text).toContain('e1');
    expect(result.text).toContain('trace could not be read');
  });

  it('renders a match whose fixture has been forgotten', () => {
    // /forgetme removed the message. The match is still reviewable from the
    // trace and the snippet — worse evidence, honestly labelled.
    const result = run(automodReviewCommand, ctxWith({
      listUnreviewedMatches: () => [match({ eventId: 'e1', fixtureContent: undefined })],
    }), {});
    expect(result.text).toContain('message no longer stored');
  });

  it('says so when there is nothing to review', () => {
    const result = run(automodReviewCommand, ctxWith({ listUnreviewedMatches: () => [] }), {});
    expect(result.text).toContain('nothing to review');
  });
});

describe('automod verdict', () => {
  it('records a verdict and returns an audit record naming the event', () => {
    const result = run(automodVerdictCommand, ctxWith({
      recordMatchVerdict: () => 'recorded',
    }), { eventId: 'e1', verdict: 'false_positive', note: 'ordinary club chat' });

    expect(result.audit).toMatchObject({
      action: 'automod.verdict_recorded',
      subjectType: 'mod_case_event',
      subjectId: 'e1',
    });
  });

  it('attributes the verdict to the Unix user the invocation claimed', () => {
    // Provenance, not authorisation (plan ruling PR-9, ADR 0024): the
    // socket's group permissions are the control, and the dispatcher's audit
    // row is the authoritative record of who ran this.
    let seen: string | undefined;
    run(automodVerdictCommand, ctxWith({
      actor: { type: 'operator_cli', unixUserClaimed: 'bryan' },
      recordMatchVerdict: (input) => { seen = input.reviewedBy; return 'recorded'; },
    }), { eventId: 'e1', verdict: 'true_positive' });
    expect(seen).toBe('cli:bryan');
  });

  it('refuses an event id that is not there', () => {
    const result = run(automodVerdictCommand, ctxWith({ recordMatchVerdict: () => 'no-such-event' }), {
      eventId: 'nope',
      verdict: 'unclear',
    });
    expect(result.text).toContain('no match');
  });

  it('refuses a verdict outside the vocabulary at the validator', () => {
    // Untrusted input meets Zod here, same as a form submission.
    const parsed = automodVerdictCommand.runParsed(ctx, { eventId: 'e1', verdict: 'maybe' });
    expect(parsed.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Implement `automod review`**

A read command. Rendering, per match:

```
e1  rule r1  member 800000000000000001  2026-09-15 12:04:11  would_delete
    message   hello [badword] everyone
    predicate       keyword_filter
    matched on      badword
    normalisations  zero-width stripped -> lowercased
    ...
    bananasaurs automod verdict e1 false_positive --confirm
```

Three rules that are not decoration:

- The **next command is printed under each match.** The whole point of shipping this before the dashboard is that a human can review from a terminal on flip day; making them compose the follow-up command by hand is where a review workflow stops being used.
- A trace that `parseMatchTrace` rejects renders as `trace could not be read: <detail>` and the match still appears. The trace is one field of evidence, not the record.
- `fixtureContent === undefined` renders as `message no longer stored (removed at the member's request, or the rule was enforcing)`. Never render the snippet as though it were the message.

Flags: `--rule <ruleId>` and `--limit <n>` (default 20, max 200 — validate with Zod, not with a comment).

- [ ] **Step 3: Implement `automod verdict`**

A `write: true` command, so `--confirm` and an audit record are enforced by the machinery rather than remembered.

```ts
export const automodVerdictCommand = defineCommand<{
  eventId: string;
  verdict: 'false_positive' | 'true_positive' | 'unclear';
  note?: string;
}>({
  name: 'automod verdict',
  write: true,
  summary: 'record whether a recorded match was right',
  positional: [
    { name: 'eventId', required: true, describe: 'the match to rule on (from `automod review`)' },
    { name: 'verdict', required: true, describe: 'false_positive | true_positive | unclear' },
  ],
  flags: [{ name: 'note', kind: 'string', describe: 'why — shown to whoever reads this later' }],
  args: z.object({
    eventId: z.string().min(1),
    verdict: z.enum(['false_positive', 'true_positive', 'unclear']),
    note: z.string().max(1000).optional(),
  }),
  run(ctx, args): OpsWriteResult {
    const reviewedBy = `cli:${ctx.actor.unixUserClaimed ?? 'unknown'}`;
    const outcome = ctx.ports.recordMatchVerdict({
      eventId: args.eventId,
      verdict: args.verdict,
      reviewedBy,
      ...(args.note === undefined ? {} : { note: args.note }),
    });
    // ... text/data/audit, with `audit.action = 'automod.verdict_recorded'`,
    // `subjectType: 'mod_case_event'`, `subjectId: args.eventId`,
    // `after: { verdict: args.verdict }`.
  },
});
```

Read `Actor` in `packages/core/src/authz.ts` for the actual field name before writing `unixUserClaimed` — if the operator actor carries it under a different name, use that one.

An audit record is required even for `'no-such-event'`: the dispatcher writes the row, and "an operator tried to rule on a match that does not exist" is a fact worth having. Set `after` to the outcome rather than to the verdict in that case.

- [ ] **Step 4: Register, wire, document**

Register both commands in `packages/core/src/ops/registry.ts` — `automodReviewCommand` in the reads block, `automodVerdictCommand` in the writes block. Wire in `apps/daemon/src/ops/wiring.ts`:

```ts
  listUnreviewedMatches: (query) => modCaseRepo.listUnreviewedMatches(scope, query),
  recordMatchVerdict: (input) =>
    modMatchReviewRepo.recordVerdict(scope, { ...input, reviewedAt: now() }),
```

Note `reviewedAt` comes from the composition root's clock, not from the command — a command does not get to choose when it happened, the same way it does not get to choose its own audit attribution.

If `docs/17_OPERATOR_CLI.md` exists and enumerates the command surface, add the three new commands to it. A CLI surface documented in one place and implemented in another is the drift `packages/cli/src/args.ts`'s header comment exists to prevent.

- [ ] **Step 5: Prove two guards can fail**

1. Make the malformed-trace path skip the match entirely (return early instead of rendering a reason) and confirm "renders a match whose trace is malformed without hiding the match" goes red. Restore.
2. Change `reviewedBy` to a constant and confirm "attributes the verdict to the Unix user" goes red. Restore.

Report both.

- [ ] **Step 6: Gates and commit**

`npm run typecheck && npm run lint && npm run test`. Commit message: `feat(ops): automod review and verdict — the CLI review path (ADR 0041 §7)`.

---

## Self-review (run by the plan's author, recorded here)

**1. Spec coverage.** Every bullet of the spec's Slice 2 section maps to a task:

| Spec requirement | Task |
| --- | --- |
| A saved-message fixture corpus, guild-scoped, labelled | 1, 2 |
| Hand-written adversarial cases | 2 (`addHandwrittenFixture`) |
| A dry-run evaluator reporting matches, misses, per-message trace | 7, 8 |
| Human-readable traces: predicate, term, span, normalisation | 3 |
| "which exemption did or did not apply" | **gap — see below** |
| "what action would have been taken" | 5, 9 (`actionTaken` on `ReviewableMatch`, rendered in `automod review`) |
| Hard invariant: dry run and subscriber share one code path | 4, 7 (the gate) |
| A minimal operator-CLI review command | 8, 9 |
| ADR 0041 §1 obligation: `PRIVACY.md` row in the same commit | 1 |
| ADR 0041 §1 obligation: `deleteObservedFixturesForMember` + test | 2 |
| ADR 0041 §5: verdicts in their own table | 1, 5 |

**The one gap, stated rather than hidden.** The spec asks a trace to record "which exemption did or did not apply". This plan does not implement it, for a reason the code makes plain: exemptions are checked in `subscriber.ts` *before* a predicate runs (`deps.isExempt(...)`, then `continue`), so an exempted message never produces a `PredicateMatch` and never reaches the trace. A trace saying "no exemption applied" would be true of every trace that exists, which is not information.

Recording the *negative* case — "this member was nearly exempt" — would mean evaluating rules for exempted members purely to log a near-miss, which costs a REST call for role ids on messages the rule will not act on. Deliberately not done. **The reviewable question this leaves open is "why did this rule not fire on that message?", which is `automod dryrun`'s job, not the trace's.** If the observe window shows operators asking it often, the answer is a `--why` flag on `dryrun` that reports the exemption check, and that is a Slice 6-or-later addition. Recorded in the ledger, not silently dropped.

**2. Placeholder scan.** Tasks 1-4 and 7 carry complete code. Tasks 5, 6, 8 and 9 give complete code for every novel or subtle function and describe the mechanical remainder (test bodies that repeat an established shape, rendering that follows `reads.ts`) with its exact requirements and its exact assertions. No step says "add appropriate error handling", "handle edge cases", or "similar to Task N". Every test named has either its body or its exact assertion given.

**3. Type consistency.**
- `FixtureRecord` (core, Task 4) is a strict subset of `AutomodFixture` (storage, Task 2): `note` is storage-only. Checked field by field.
- `FixtureLabel` / `MatchVerdict` string unions are spelled identically in the schema CHECK (Task 1), the storage repos (Tasks 2, 5), core (Task 4), and the ops command's Zod enum (Task 9).
- `MatchTrace.span` is `readonly [number, number] | undefined` in `types.ts` and `.optional()` in the Zod schema; Task 3 Step 3 handles the mismatch explicitly and Task 3's second test pins it.
- `runDryRun` takes `{ guildId, rule, fixtures }` in Task 7 and is called with exactly that in Task 8.
- `recordVerdict` returns `'recorded' | 'no-such-event'` in Task 5 and both branches are handled in Task 9.

**4. Cross-task conflict, found and resolved.** Task 9's `reviewed_by` needs to hold `cli:<user>`, which Task 1's first draft made impossible with a snowflake CHECK. Resolved as plan ruling PR-9, and **Task 1's schema in this plan already reflects it** — `reviewedBy` is plain `text()`. An executor who finds a `snowflakeCheck` on that column has an out-of-date plan.

---

## What this slice does not do

Stated so a reviewer finds the answer rather than re-opening the question.

- **No dashboard.** Slice 9's review screen supersedes the CLI; the CLI stays as the headless path (ADR 0041 §7). Nothing in `apps/dashboard` changes.
- **No `/forgetme` command.** `deleteObservedFixturesForMember` ships tested; wiring it to a Discord command is Release 3's R3-10.
- **No seeding of the corpus from an archive.** There is no archive in Release 2 (ADR 0009 gates ingestion behind a default-deny channel scope in Release 3). The corpus fills from live `test`/`observe` matches and from handwritten fixtures.
- **No false-positive *gate*.** Counting verdicts into a pass/fail threshold is Slice 6, along with `counts_as_violation`, `cutover_state`, and `automod_testing_mode`. This slice records the verdicts that gate will count.
- **No new predicates.** Slices 3-5.

## Carried forward from this slice

For the ledger, and for the flip-day handoff:

1. **`attachment_type` cannot be dry-run against observed fixtures** (PR-3). Slice 5 must write handwritten cases, and should raise with the owner whether the corpus ought to carry attachment metadata.
2. **Capture stops at flip day for any rule moved to `enforce`** (PR-2). Post-flip review reads `mod_case_events` — trace and snippet, not the whole message. If that proves too thin in practice, it is an owner privacy decision, not an engineering one.
3. **The spec's "which exemption applied" trace field is deliberately unimplemented** (self-review §1). The reviewable question it was reaching for is answered by `automod dryrun`.
4. **`PRIVACY.md` changed.** ADR 0041 prices this in: the owner announces it. It is on the handoff checklist.
5. **The observe window is only as good as the review.** `automod review` exists so the first fortnight produces verdicts rather than a backlog. The spec's pre-flip-day gate — "a rehearsal in which every rule's trace is rendered and read" — is exercised by running `automod review` and `automod dryrun` against real rules before the flip.
