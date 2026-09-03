# Release 2, Slices 3 + 5 — the stateless predicates (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the six stateless, single-message predicates — `regex`,
`invite`, `link_domain`, `caps`, `attachment_type`, `emoji` — plus the OD-3
attachment corpus columns that `attachment_type` needs to be dry-run against
observed traffic.

**Architecture:** Six new files in
`packages/core/src/automod/predicates/`, six new registry entries, and nothing
else in `core` changes shape. Two new relational tables carry `invite`'s
labelled code allowlist and `link_domain`'s allow/deny lists (ADR 0040 §3);
one new child table carries OD-3's attachment metadata. The predicate
interface, the subscriber and the evaluator are **not** modified to accommodate
any predicate — if a predicate seems to need that, stop and say so (see Global
Constraint 9).

**Tech Stack:** TypeScript (Node 22, strict) · Zod 3.24 · Drizzle ORM 0.45 +
drizzle-kit 0.31.10 · better-sqlite3 13 · Vitest 2 · `node:vm` (already in
Node) for the regex execution timeout · `Intl.Segmenter` (already in Node) for
emoji grapheme counting. **No new dependency is added by this plan.**

**Spec:**
`docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`
§3 Phase 2 (Slices 3 and 5) and §4's slice-specific gates.

**Handoff:** `docs/reports/release2-slices-3-5-handoff.md` — the obligations
table there binds this plan and is restated in Global Constraints below.

**Ledger:** `docs/reports/release2-slices-1-6-ledger.md` — append rulings and
findings as you go. It is the recovery map, and it outranks anyone's memory.

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **Guild scope is a mandatory partition key** (CLAUDE.md rule 2). Every new
   query signature takes a `GuildScope` first and goes through `scope.only(...)`.
   Every new table carries `guild_id` and every foreign key includes it.
2. **Model output and stored JSON are untrusted input** (CLAUDE.md rule 3).
   `mod_rules.config` is validated by a Zod schema on write **and** on read.
   An operator-supplied regex pattern is untrusted input reaching a compiler.
3. **AI is never in the enforcement path** (CLAUDE.md rule 1). Nothing in this
   slice calls a provider. Every predicate works with every provider
   unreachable, because none of them knows a provider exists.
4. **No new outbound network destination** (CLAUDE.md rule 8). `invite` does
   **not** resolve invite codes. `link_domain` does **not** fetch, resolve or
   do DNS. Both are pattern matching against local lists. This is an owner
   decision recorded in the spec, not an implementation shortcut.
5. **Migrations are additive only.** All three new tables are pure
   `CREATE TABLE`. **No table rebuild** — ruling R-5 in the ledger records a
   reproduced data-loss bug in the rebuild path, and this slice must not go
   near it. After `npm run db:generate`, **read the generated SQL** and confirm
   it contains no `__new_` table, no `DROP TABLE`, and no `RENAME`.
6. **`npm run db:generate` is the only way a migration is produced.** It runs
   `drizzle-kit generate` and then `scripts/strictify.mjs`, which adds
   `STRICT`. Never hand-write a migration file. Run it once per task that
   changes `schema.ts` — R-6 records that a column add and a rebuild in the
   same `generate` call emit invalid SQL.
7. **Pino redaction is an allowlist** (CLAUDE.md rule 4). If you log a new
   field name, it must be added to `LOGGABLE_FIELDS` in
   `packages/core/src/obs/logger.ts` with a comment stating what may flow into
   it. Otherwise `safeLogFields` silently drops it and records
   `droppedFields: 1` — that is ruling R-10, an already-shipped bug of exactly
   this shape.
8. **Break it and watch it fail.** Every guard you write must be watched
   failing before you make it pass: neutralise the line it protects, see red,
   restore, see green. **Ten decorative guards** were found across Slices 1–2 —
   tests asserting something true about an input where the bug they were named
   after could not occur. The shape is *a fixture too simple to reach the
   branch the test is named after*. A test for "picks the right one of several"
   needs several. Say in your report which guards you watched fail and how.
9. **If you find yourself editing `subscriber.ts`, `evaluate.ts` or
   `types.ts`'s `CompiledPredicate` to make a predicate fit — stop and say so.**
   That is the abstraction failing and it is worth a ruling from the
   coordinator, not a workaround. (Tasks 1, 2 and 6 *do* legitimately change
   `types.ts` and the `captureFixture` port — those changes are specified here.
   The prohibition is on unplanned ones.)
10. **This plan will contain defects.** Slice 2's plan carried eight into
    execution. Treat the code below as a strong proposal, not verified truth.
    When a test and the code in this plan disagree, **say so plainly in your
    report** rather than quietly making one match the other — three of Slice 2's
    eight defects were found exactly that way.
11. **Comments are load-bearing claims.** If a comment asserts a library
    behaves a certain way, check it against `node_modules` or a probe before
    repeating it. Two factual errors were corrected in Slice 2 that predated
    it, one already propagated into new files.
12. **`grep` returns false negatives in this sandbox.** Use `rg`, or
    `awk '/pattern/{print FILENAME": "FNR": "$0}'`. A `grep` that finds nothing
    is not evidence.
13. **This shell substitutes backticks inside `git commit -m`.** Do not use
    them in commit messages.
14. Gates: `npm run typecheck && npm run lint && npm run test` must all pass
    before you report a task done. **No completion claim on code you have not
    run.**

---

## Verified environment facts

These were **measured in this worktree on this Node**, not recalled. Do not
contradict them without re-measuring, and do not re-derive them — they cost
probes to establish.

| Fact | Evidence |
| --- | --- |
| `^(a+)+$` against `'a'.repeat(26) + 'b'` takes **3052 ms**. Catastrophic backtracking is real here. | probe |
| **`vm.Script.runInContext(ctx, { timeout })` interrupts catastrophic backtracking.** Threw `Error: Script execution timed out after 200ms` at 204 ms on a 60-character input that would otherwise never finish. | probe |
| The timeout still fires when the `vm.Script` **and** the context are created once and reused — which is what makes this affordable at compile time. | probe |
| A context that has already timed out **remains usable** for later evaluations. | probe |
| Cost: direct `re.exec` = **0.05 µs/call**; via a reused `vm.Script` with a timeout = **120 µs/call**. 0.12 ms per regex rule per message is affordable on this path. | probe, 20 000 iterations |
| `re.exec(input)` run inside a vm context, where `re` was created in the outer realm, returns a **real outer-realm `Array`** with a working `.index` and capture groups (`m instanceof Array === true`). | probe |
| **A `g` or `y` flagged RegExp carries `lastIndex` across calls.** On a *reused compiled* regex `/a/g`: `test('banana')`→true (lastIndex 2), `test('banana')`→true (lastIndex 4), `test('xyz')`→false (lastIndex 0). The same message gets different answers depending on what came before it. | probe |
| `\p{Extended_Pictographic}` with the `u` flag is supported. | probe |
| `new Intl.Segmenter('en', { granularity: 'grapheme' })` counts a ZWJ family `👨‍👩‍👧‍👦` as **1** grapheme. | probe |
| **`\p{Extended_Pictographic}` does NOT match a regional-indicator flag (`🇬🇧`), a keycap (`1️⃣`) or `#️⃣`.** All three are single graphemes but score 0 pictographic. A naive pictographic-only counter silently under-counts. | probe |
| `new URL(u).hostname` lower-cases the host, strips port and userinfo, and preserves punycode: `http://EXAMPLE.com` → `example.com`; `https://user:pw@example.com:8443/x` → `example.com`. | probe |
| `npm ci` inside a git worktree creates the `node_modules/@bananasaurs/*` symlinks pointing at **that worktree's** packages. Gates run without it measure the main checkout's stale `dist` (ledger E-1). Already done for this worktree. | verified |

---

## Plan rulings

Decisions this plan takes that the spec and the ADRs do not name, each with
**what it costs if wrong**. Append these to the ledger. Numbering continues
from Slice 2's PR-1…PR-9.

**PR-10 — the ReDoS defence is a hard per-evaluation timeout via `node:vm`, not
a linear-time engine dependency.** The spec permits either ("a linear-time
engine or a hard per-evaluation timeout is required, not optional"). A
linear-time engine means `re2`, a native module requiring compilation on the
deployment host; the timeout costs no dependency at all and is verified above
to interrupt the catastrophic case. The `vm` context is created once at
`compile` time and reused, which is what keeps it at 120 µs.
*What `vm` is and is not doing here:* it is an **interruptible execution
wrapper**, not a security sandbox. The script inside is the fixed string
`re.exec(input)`; the pattern reaches it as a `RegExp` object built by
`new RegExp(pattern, flags)` in the ordinary realm, which cannot execute
arbitrary code. No operator-supplied *code* is ever evaluated. Say this in the
file, because a reader who sees `node:vm` will reasonably assume otherwise.
*Costs if wrong:* an evaluation costs 120 µs instead of 0.05 µs, and a
pathological pattern burns up to the timeout budget per message rather than
being rejected outright. At the timeout budget below, a message-rate attack
against a bad pattern costs 25 ms of the subscriber's synchronous path per
message — bounded and loud, where today it would be unbounded and silent.

**PR-11 — the regex timeout budget is 25 ms, a module constant, not operator
configuration.** A legitimate pattern completes in well under a microsecond;
25 ms is four orders of magnitude of headroom. It is not configurable because
an operator-tunable timeout is a footgun whose only use is raising it until the
hang returns. *Costs if wrong:* a legitimate but genuinely slow pattern over a
very long message is reported as a timeout. That surfaces as a loud log line
naming the rule, which is the correct outcome for a pattern that slow.

**PR-12 — a regex that times out throws, and is therefore reported through the
existing `EvaluateOutcome.threw` path, once per message.** `evaluateRule`
already catches predicate throws and the subscriber already logs
"the predicate threw; message left unmatched for this rule" with the rule id.
Returning "no match" instead would be silent, which is the ADR 0039 failure
mode this project has now walked into three times. *Costs if wrong:* a
timing-out rule on a busy guild emits one error log per message. That is noisy,
and it is the correct noise — moderation is degraded and the operator needs to
know. It is *not* once-per-fingerprint like a compile failure, because a
timeout is a property of the message as much as of the pattern.

**PR-13 — `g` and `y` flags are rejected by the config schema.** Verified
above: they carry `lastIndex` across calls, and this predicate reuses one
compiled `RegExp` for every message in a rule's lifetime. A rule with `/spam/g`
would match, then not match, then match the same content. Allowed flags are
`i`, `m`, `s`, `u` only. *Costs if wrong:* an operator who typed `g` out of
habit gets a validation error naming the flag instead of a rule that is wrong
one message in two. There is no legitimate use of `g` here — the predicate
wants the first match, and `exec` without `g` gives it.

**PR-14 — `invite`'s allowlist ships with `label`, and `last_matched_at` is
deferred to Slice 9 with the column not created.** The spec asks for a
last-matched timestamp so a stale partner code is visible. Populating it
honestly requires one of two things, and both are worse than the gap: a
**database write on the hot path** for every allowlisted invite in every
message (a single-writer SQLite database that `REVIEW.md` §C12 already warns
about, and a predicate reaching storage, which ADR 0040 §1 forbids by
construction — a predicate is given no database handle), or **widening
`CompiledPredicate.evaluate`'s return type for all ten predicates** so a
non-match can carry observations, which is Global Constraint 9's "the
abstraction failing". So the table ships with `label` and `added_at`, an
operator can read and edit the list, and staleness detection is carried to
Slice 9 where the review surface exists and can derive it from match history
instead. **Flag this to the owner in the closing handoff** — it is a named
spec feature being deliberately deferred, and the owner should know it moved
rather than discover it missing. *Costs if wrong:* a partner code that has
rotated sits in the allowlist unnoticed until someone reads the list. The
label is what makes that readable, and the label ships.

**PR-15 — `link_domain` matches by label-wise suffix, not by computing a
registrable domain, and takes no Public Suffix List dependency.** An entry
`example.com` matches host `example.com` and any subdomain of it
(`gist.example.com`), compared label by label so `notexample.com` does **not**
match. Computing a true registrable domain (eTLD+1) requires the Public Suffix
List — a dependency, and a data file that goes stale. The suffix rule is
strictly more precise than eTLD+1 matching for both list types and needs no
external data. *Costs if wrong:* an operator who puts a public suffix
(`co.uk`) on the deny list denies every domain under it. That is visible in the
list, reads as deliberate, and for a *deny* list is arguably what they meant.

**PR-16 — `attachment_type`'s blocked extensions and content types live in
`mod_rules.config` as JSON arrays, not in relational tables.** ADR 0040 §3
names the relational ones explicitly — `invite`'s allowlist and
`link_domain`'s lists — and does not name `attachment_type`. The ADR's
*justification* for relational is per-item metadata (`invite`'s label) and
Slice 9's per-item one-click suppression; an extension list has neither — it
has no per-item metadata and its natural suppression ("stop blocking this
type") is a list edit either way. Config also inherits the fingerprint for
free, where a relational list has to be carried into it deliberately, which is
the exact bug obligation 2 exists to prevent. *Costs if wrong:* if Slice 9
later wants per-type metadata, it needs an additive migration. Additive
migrations are cheap; the rebuild path is the expensive one, and this avoids it.

**PR-17 — `caps` measures the ratio of upper-case letters among *letters*, and
strips fenced and inline code spans before measuring.** Counting upper-case
against *all* characters would let punctuation and digits dilute the ratio, so
`"HELLO!!!!!!!!!"` would score below a threshold that `"HELLO"` exceeds.
Stripping code spans directly addresses one of the three false-positive sources
the spec names for this predicate ("acronyms, short messages, code snippets");
the minimum-length floor, which the spec requires, addresses the second.
*Costs if wrong:* a message that is entirely a shouted code block is not
caught. That is the safe direction for the predicate the spec singles out as
carrying the tier's false-positive risk, and `caps` is also the rule the spec
expects to ship delete-only under `counts_as_violation` (Slice 6).

**PR-18 — `emoji` counts emoji *graphemes*, using `Intl.Segmenter` plus a
pictographic-or-regional-indicator-or-keycap test.** Verified above: counting
code points reports 6 for a string a human reads as 3 emoji, and
`\p{Extended_Pictographic}` alone misses flags, keycaps and `#️⃣`. Discord
custom emoji (`<:name:id>` and animated `<a:name:id>`) are counted separately
by pattern, and removed from the text before grapheme counting so they are not
also counted as their literal characters. *Costs if wrong:* a novel emoji
sequence Unicode adds later is counted as more than one. The failure is a
slight over-count on exotic input, in a predicate whose threshold is an
operator-set number.

---

## File structure

**New files**

| File | Responsibility |
| --- | --- |
| `packages/core/src/automod/predicates/regex.ts` | the `regex` predicate and its config schema |
| `packages/core/src/automod/predicates/regex.test.ts` | its tests, including the ReDoS gate |
| `packages/core/src/automod/predicates/caps.ts` + `.test.ts` | the `caps` predicate |
| `packages/core/src/automod/predicates/emoji.ts` + `.test.ts` | the `emoji` predicate |
| `packages/core/src/automod/predicates/attachment-type.ts` + `.test.ts` | the `attachment_type` predicate |
| `packages/core/src/automod/predicates/invite.ts` + `.test.ts` | the `invite` predicate |
| `packages/core/src/automod/predicates/link-domain.ts` + `.test.ts` | the `link_domain` predicate |
| `packages/storage/src/repos/automod-rule-lists.ts` + `.test.ts` | the two relational list tables' repository |

**Modified files**

| File | Change |
| --- | --- |
| `packages/storage/src/schema.ts` | three new tables |
| `drizzle/00NN_*.sql` | generated, twice (Task 1, Task 6) |
| `packages/storage/src/repos/automod-fixtures.ts` | attachments on capture, list and the fixture shape |
| `packages/storage/src/repos/automod-rules.ts` | `hydrate` loads the two new lists onto `StoredAutomodRule` |
| `packages/core/src/automod/predicates/types.ts` | `FixtureRecord.attachments`; `AutomodRule.inviteAllowlist` / `.linkDomains` |
| `packages/core/src/automod/evaluate.ts` | the fixture branch reconstructs attachments |
| `packages/core/src/automod/fingerprint.ts` | canonicalise the two new list fields |
| `packages/core/src/automod/subscriber.ts` | the `captureFixture` port carries attachments |
| `apps/daemon/src/automod/wiring.ts` | passes attachments through |
| `packages/core/src/automod/predicates/registry.ts` | six new entries |
| `packages/core/src/automod/dry-run.test.ts` | the widened one-code-path gate |
| `PRIVACY.md` | the attachment line (Task 1, same commit as the migration) |

---

## Task order and dispatch batching

Batched 2–3 tasks per implementer dispatch, per the handoff's lean protocol.

| Dispatch | Tasks | Why together |
| --- | --- | --- |
| A | 1, 2 | OD-3 end to end: storage, then core. Task 2 consumes Task 1's shape. |
| B | 3, 4 | Pure `core` predicate files, no schema. Disjoint from A. |
| C | 5, 6 | Task 5 needs Tasks 1–2 done; Task 6 is the second migration. |
| D | 7, 8 | Both consume Task 6's hydrated lists. |

---

### Task 1: OD-3 — the attachment child table, and the privacy line with it

**Files:**
- Modify: `packages/storage/src/schema.ts` (add `automodFixtureAttachments`)
- Generate: `drizzle/00NN_*.sql` via `npm run db:generate`
- Modify: `packages/storage/src/repos/automod-fixtures.ts`
- Test: `packages/storage/src/repos/automod-fixtures.test.ts`
- Modify: `PRIVACY.md` — **in this same commit**

**Interfaces:**
- Produces: `FixtureAttachment { fileName: string; contentType: string | undefined; sizeBytes: number }`,
  exported from `automod-fixtures.ts`. `AutomodFixture` gains
  `readonly attachments: readonly FixtureAttachment[]`.
  `CaptureObservedFixtureInput` gains
  `readonly attachments: readonly FixtureAttachment[]`.

**Why a child table rather than columns:** a message can carry several
attachments (up to ten), so filename/type/size cannot be three columns on
`automod_fixtures` without either a JSON blob or an arbitrary cap. OD-3
anticipated this ("most likely a child table keyed `(guild_id, fixture_id)`").

- [ ] **Step 1: Write the failing tests**

In `packages/storage/src/repos/automod-fixtures.test.ts`. Four of them, and
note what each is actually pinning — Global Constraint 8 applies to all four.

```ts
it('round-trips an observed fixture with several attachments', () => {
  const t = openMigratedTestDatabase();
  const scope = t.scopes.forGuild(GUILD_ID);
  seedGuild(t, GUILD_ID); // however this file already seeds; follow the file
  captureObservedFixture(scope, {
    messageId: '900000000000000001',
    content: 'here you go',
    authorId: '800000000000000001',
    createdAt: 1_000,
    attachments: [
      { fileName: 'payload.exe', contentType: 'application/x-msdownload', sizeBytes: 4096 },
      { fileName: 'notes.txt', contentType: undefined, sizeBytes: 12 },
    ],
  });

  const [fixture] = listFixtures(scope);
  // Two attachments, in a deterministic order, with `undefined` preserved
  // rather than flattened to '' — MessageAttachment.contentType is
  // `string | undefined` and "Discord declared none" is a real, different
  // fact from "Discord declared the empty string".
  expect(fixture?.attachments).toEqual([
    { fileName: 'notes.txt', contentType: undefined, sizeBytes: 12 },
    { fileName: 'payload.exe', contentType: 'application/x-msdownload', sizeBytes: 4096 },
  ]);
  t.close();
});
```

```ts
it('keeps each fixture\'s attachments to itself', () => {
  // NOT decorative: two fixtures, each WITH attachments, so an implementation
  // that joined without the fixture_id predicate would hand both lists to
  // both rows and this goes red. One fixture with attachments and one
  // without would pass under that bug.
  const t = openMigratedTestDatabase();
  const scope = t.scopes.forGuild(GUILD_ID);
  seedGuild(t, GUILD_ID);
  captureObservedFixture(scope, {
    messageId: '900000000000000001', content: 'first', authorId: '800000000000000001',
    createdAt: 1_000,
    attachments: [{ fileName: 'a.png', contentType: 'image/png', sizeBytes: 1 }],
  });
  captureObservedFixture(scope, {
    messageId: '900000000000000002', content: 'second', authorId: '800000000000000002',
    createdAt: 2_000,
    attachments: [{ fileName: 'b.pdf', contentType: 'application/pdf', sizeBytes: 2 }],
  });

  const fixtures = listFixtures(scope);
  expect(fixtures.map((f) => f.attachments.map((a) => a.fileName))).toEqual([['a.png'], ['b.pdf']]);
  t.close();
});
```

```ts
it('deleteObservedFixturesForMember removes the member\'s attachments too', () => {
  // OD-3 obligation 3, and the ledger says verify rather than assume: the
  // whole point of shipping deleteObservedFixturesForMember two releases
  // early was that the corpus stays un-makeable.
  const t = openMigratedTestDatabase();
  const scope = t.scopes.forGuild(GUILD_ID);
  seedGuild(t, GUILD_ID);
  captureObservedFixture(scope, {
    messageId: '900000000000000001', content: 'mine', authorId: '800000000000000001',
    createdAt: 1_000,
    attachments: [{ fileName: 'Bryan_resume_2026.pdf', contentType: 'application/pdf', sizeBytes: 9 }],
  });

  expect(deleteObservedFixturesForMember(scope, '800000000000000001')).toBe(1);

  // Asserted against the raw table, not through listFixtures: the parent row
  // is gone either way, so reading through the repository could not tell an
  // orphaned child row from a deleted one. This is the assertion that fails
  // if the cascade is missing.
  const orphans = t.raw
    .prepare('SELECT COUNT(*) AS n FROM automod_fixture_attachments')
    .get() as { n: number };
  expect(orphans.n).toBe(0);
  t.close();
});
```

```ts
it('another member\'s attachments survive a deletion', () => {
  // The ambiguity the previous test lacks: proves the cascade is scoped to
  // the deleted rows rather than emptying the table.
  const t = openMigratedTestDatabase();
  const scope = t.scopes.forGuild(GUILD_ID);
  seedGuild(t, GUILD_ID);
  captureObservedFixture(scope, {
    messageId: '900000000000000001', content: 'mine', authorId: '800000000000000001',
    createdAt: 1_000, attachments: [{ fileName: 'mine.pdf', contentType: undefined, sizeBytes: 1 }],
  });
  captureObservedFixture(scope, {
    messageId: '900000000000000002', content: 'theirs', authorId: '800000000000000002',
    createdAt: 2_000, attachments: [{ fileName: 'theirs.pdf', contentType: undefined, sizeBytes: 2 }],
  });

  deleteObservedFixturesForMember(scope, '800000000000000001');

  const rows = t.raw
    .prepare('SELECT file_name FROM automod_fixture_attachments')
    .all() as { file_name: string }[];
  expect(rows.map((r) => r.file_name)).toEqual(['theirs.pdf']);
  t.close();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/storage/src/repos/automod-fixtures.test.ts`
Expected: FAIL — no such table `automod_fixture_attachments`, and
`captureObservedFixture` rejects the `attachments` property.

- [ ] **Step 3: Add the table to `schema.ts`**

Place it immediately after `automodFixtures`. Follow that table's conventions
exactly (`snowflake`, `snowflakeCheck`, composite FK, `check` names prefixed
with the table name).

```ts
/**
 * One attachment on a corpus message: filename, declared content type, size
 * (OD-3).
 *
 * A child table rather than columns on `automod_fixtures` because a message
 * carries up to ten attachments, and neither a JSON blob nor an arbitrary
 * three-column cap is a schema.
 *
 * **This stores personal information and the owner was told so before
 * approving it.** Filenames routinely carry it — `Bryan_resume_2026.pdf`,
 * `medical_letter.docx` — and this keeps them for as long as the corpus keeps
 * the message. `PRIVACY.md` names attachments in the same commit that created
 * this table, and the `ON DELETE CASCADE` below is what makes `/forgetme`
 * (R3-10) reach them through `deleteObservedFixturesForMember`. That cascade
 * is tested, not assumed.
 *
 * No `attachment_id` from Discord: the corpus is evidence about a message,
 * not a mirror of Discord's own ids, and the ordinal is enough to keep two
 * identically-named files apart.
 */
export const automodFixtureAttachments = sqliteTable(
  'automod_fixture_attachments',
  {
    guildId: snowflake('guild_id').notNull(),
    fixtureId: text('fixture_id').notNull(),
    /** Position on the message, 0-based. Part of the key: two attachments can share a name. */
    ordinal: integer('ordinal').notNull(),
    fileName: text('file_name').notNull(),
    /** Null when Discord declared none. Never flattened to '' — that is a different fact. */
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.fixtureId, t.ordinal] }),
    foreignKey({
      columns: [t.guildId, t.fixtureId],
      foreignColumns: [automodFixtures.guildId, automodFixtures.fixtureId],
    }).onDelete('cascade'),
    check('automod_fixture_attachments_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('automod_fixture_attachments_ordinal_nonnegative', sql`${t.ordinal} >= 0`),
    check('automod_fixture_attachments_size_nonnegative', sql`${t.sizeBytes} >= 0`),
  ],
);
```

- [ ] **Step 4: Generate the migration and read it**

Run: `npm run db:generate`

Then **read the generated file**. Confirm, and say so in your report:
- it is a single `CREATE TABLE` with no `__new_` table, no `DROP`, no `RENAME`
  (Global Constraint 5);
- `strictify.mjs` has appended `STRICT` (Global Constraint 6);
- the `FOREIGN KEY … ON DELETE cascade` clause is present.

If it emitted a rebuild of any table, **stop and report it** — that is the
R-5 hazard and it is not yours to work around.

- [ ] **Step 5: Implement the repository changes**

In `packages/storage/src/repos/automod-fixtures.ts`:

```ts
export interface FixtureAttachment {
  readonly fileName: string;
  /** `undefined` when Discord declared no content type. */
  readonly contentType: string | undefined;
  readonly sizeBytes: number;
}
```

Add `readonly attachments: readonly FixtureAttachment[]` to `AutomodFixture`
and to `CaptureObservedFixtureInput`.

In `captureObservedFixture`, insert the children inside the **same** `write`
callback as the parent, after it. Two details matter and both need a comment:

```ts
// Inserted inside the same write() as the parent so a capture is one
// transaction: a fixture row whose attachments failed to write would be
// evidence that lies by omission, and `attachment_type`'s dry run would
// read it as a message with no files.
//
// `onConflictDoNothing` on the parent means a replayed capture of the same
// message is a no-op (PR-1). The children use the same target so a replay
// does not duplicate them either; the first capture wins for both, which
// keeps parent and children consistent about which capture they describe.
input.attachments.forEach((attachment, ordinal) => {
  db.insert(automodFixtureAttachments)
    .values({
      guildId: scope.guildId,
      fixtureId,
      ordinal,
      fileName: attachment.fileName,
      contentType: attachment.contentType ?? null,
      sizeBytes: attachment.sizeBytes,
    })
    .onConflictDoNothing({
      target: [
        automodFixtureAttachments.guildId,
        automodFixtureAttachments.fixtureId,
        automodFixtureAttachments.ordinal,
      ],
    })
    .run();
});
```

`addHandwrittenFixture` gains an optional `attachments` too — a handwritten
adversarial case for `attachment_type` is exactly the thing that predicate
needs, and without it every `attachment_type` regression case would have to be
an observed one. Default `[]`.

In `listFixtures`, hydrate the children. One query for the whole page, grouped
in code — not one query per fixture:

```ts
// One query for every attachment in scope, grouped in code, rather than one
// query per fixture: `listFixtures` is what the dry run replays, and a
// per-row query would make a 300-fixture corpus 301 queries. Ordered by
// (fixture_id, ordinal) so a replay sees a message's files in the order they
// were posted, deterministically.
```

Order the returned attachments by `ordinal`. The first test above expects
`notes.txt` before `payload.exe` — **that is the ordinal order they were
passed in reversed**, so check it: the test as written passes `payload.exe`
first. Either the test's expectation or the ordering is wrong. **Decide which,
fix it, and say in your report which you changed and why.** (Global Constraint
10: this is a deliberate example of the plan disagreeing with itself, and it is
the kind of thing you should report rather than silently reconcile.)

- [ ] **Step 6: Add the `PRIVACY.md` line — in this commit**

`PRIVACY.md` line 35 currently reads:

```
- Messages an automod rule matched while it was being tested, kept as examples so a human can check whether the rule was right
```

Extend that bullet so it names attachments. Match the document's voice — it is
written for club members, not engineers, and every other bullet is plain. For
example:

```
- Messages an automod rule matched while it was being tested, kept as examples so a human can check whether the rule was right — including the name, type and size of any files attached to them
```

Do not add a separate bullet, and do not use the word "metadata". This is
ADR 0041 §1's rule applied to OD-3: a policy that is not true is worse than
none, so the sentence and the table land together.

- [ ] **Step 7: Run the tests and the gates**

Run: `npx vitest run packages/storage/src/repos/automod-fixtures.test.ts`
Expected: PASS.

Then watch the cascade guard fail on purpose: remove `.onDelete('cascade')`
from the new table, regenerate is not needed — instead temporarily edit the
**generated migration**'s foreign key to drop the cascade, re-run the test,
confirm the orphan assertion goes red, then restore. Report what you saw.

Then: `npm run typecheck && npm run lint && npm run test`

- [ ] **Step 8: Commit**

```bash
git add packages/storage/src/schema.ts packages/storage/src/repos/automod-fixtures.ts packages/storage/src/repos/automod-fixtures.test.ts drizzle PRIVACY.md
git commit -m "feat(automod): the fixture corpus records attachment filename, type and size (OD-3)

The privacy line lands in this commit with the table, per ADR 0041 section 1:
a policy that is not true is worse than none. The ON DELETE CASCADE that makes
/forgetme reach these rows is tested rather than assumed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SAXL4Tpn7zGArAzZs9vKNW"
```

---

### Task 2: OD-3 — attachments reach `PredicateInput` from both directions

**Files:**
- Modify: `packages/core/src/automod/predicates/types.ts`
- Modify: `packages/core/src/automod/evaluate.ts`
- Modify: `packages/core/src/automod/subscriber.ts` (the `captureFixture` port)
- Modify: `apps/daemon/src/automod/wiring.ts`
- Test: `packages/core/src/automod/evaluate.test.ts`,
  `packages/core/src/automod/subscriber.test.ts`

**Interfaces:**
- Consumes: Task 1's `FixtureAttachment` shape (re-declared in `core`, not
  imported — ADR 0014: `core` may not import `@bananasaurs/storage`).
- Produces: `FixtureRecord.attachments: readonly MessageAttachment[]`;
  `captureFixture(input)` gains
  `attachments: readonly MessageAttachment[]`.

**This is the field the one-code-path gate cannot currently see.** Obligation 3
in the handoff: `predicateInputFrom`'s fixture branch returns an empty
`attachments` array today, and no shipped predicate reads it, so a divergence
there is invisible. Task 5 widens the gate; this task makes the field real.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/automod/evaluate.test.ts
it('reconstructs a fixture\'s attachments onto the predicate input', () => {
  const input = predicateInputFrom({
    from: 'fixture',
    guildId: GUILD_ID,
    fixture: {
      fixtureId: '900000000000000001:0123456789abcdef',
      content: 'have a file',
      authorId: '800000000000000001',
      label: 'unlabelled',
      source: 'observed',
      createdAt: 5_000,
      attachments: [
        { fileName: 'payload.exe', contentType: 'application/x-msdownload', sizeBytes: 4096 },
      ],
    },
  });

  expect(input?.attachments).toEqual([
    { fileName: 'payload.exe', contentType: 'application/x-msdownload', sizeBytes: 4096 },
  ]);
});
```

```ts
// packages/core/src/automod/subscriber.test.ts — extend the existing
// capture assertion rather than adding a parallel one.
it('carries the message\'s attachments into the corpus', async () => {
  // The ambiguity that makes this non-decorative: the message has an
  // attachment AND content, so an implementation that passed `[]` through
  // would still capture the fixture and still pass every other assertion in
  // this file. Only this expectation goes red.
  const { calls } = await runSubscriber({
    captureFixtureResult: 'fixture-1',
    // follow this file's existing helper for building a matching message;
    // add attachments to it
    attachments: [{ fileName: 'a.exe', contentType: undefined, sizeBytes: 7 }],
  });

  expect(calls.captureFixture[0]?.attachments).toEqual([
    { fileName: 'a.exe', contentType: undefined, sizeBytes: 7 },
  ]);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/core/src/automod/evaluate.test.ts packages/core/src/automod/subscriber.test.ts`
Expected: FAIL — `attachments` is not a property of `FixtureRecord`, and the
captured input has no `attachments`.

- [ ] **Step 3: Widen `FixtureRecord`**

In `types.ts`, add to `FixtureRecord`:

```ts
  /**
   * Filename, declared content type and size for each file on the message
   * (OD-3).
   *
   * `MessageAttachment` is the same shape the live path carries, deliberately:
   * `attachment_type` must not be able to tell a replayed fixture from a live
   * message, because the one-code-path invariant (ADR 0041 section 3) is only
   * worth something if the input it produces is the same on both sides.
   *
   * Empty for a handwritten fixture that names no files, and for every
   * fixture captured before the OD-3 migration — those rows are real evidence
   * about a message whose attachments were never recorded, and an empty list
   * is the honest representation of that.
   */
  readonly attachments: readonly MessageAttachment[];
```

- [ ] **Step 4: Reconstruct them in `predicateInputFrom`**

In `evaluate.ts`'s fixture branch, replace `attachments: []` with
`attachments: fixture.attachments`.

**Rewrite the stale doc comment above it.** It currently says attachments "are
metadata the corpus does not hold — so `attachments` is empty for every
fixture, and Slice 5's `attachment_type` predicate therefore cannot be dry-run
against observed traffic." That was plan ruling PR-3 and **OD-3 superseded it**;
leaving it would be a load-bearing comment that is now false (Global Constraint
11). Replace with something that says: the corpus records attachment filename,
type and size since OD-3, so `attachment_type` *can* be replayed against
observed traffic; a fixture captured before that migration has none, and an
empty list is the honest representation rather than a gap being papered over.

- [ ] **Step 5: Carry attachments through the `captureFixture` port**

In `subscriber.ts`, add to the port's input type:

```ts
    /** Filename, declared content type and size for each file (OD-3). */
    attachments: readonly MessageAttachment[];
```

and pass `attachments: input.attachments` at the call site (around line 320).

In `apps/daemon/src/automod/wiring.ts`, pass them into
`captureObservedFixture`. The `MessageAttachment` shape and Task 1's
`FixtureAttachment` are field-for-field identical, which is what lets this be a
direct pass-through; say so in a comment so a future reader does not assume a
mapping was forgotten.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run packages/core/src/automod packages/storage/src/repos/automod-fixtures.test.ts`
Expected: PASS.

**Every other construction of a `FixtureRecord` in the test suite now fails to
typecheck** because the field is required. That is intended — it is how the
compiler proves there is no second construction site that would quietly carry
an empty list. Fix them by adding `attachments: []`, and **report how many you
had to touch**; a surprisingly large number is worth the coordinator knowing.

- [ ] **Step 7: Gates and commit**

Run: `npm run typecheck && npm run lint && npm run test`

```bash
git add -A packages/core packages/storage apps/daemon
git commit -m "feat(automod): attachments reach PredicateInput from a fixture as well as a live message

Supersedes plan ruling PR-3, which recorded that attachment_type could not be
dry-run against observed traffic. OD-3 made the corpus record them, so it can.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SAXL4Tpn7zGArAzZs9vKNW"
```

---

### Task 3: the `regex` predicate and the ReDoS gate

**Files:**
- Create: `packages/core/src/automod/predicates/regex.ts`
- Create: `packages/core/src/automod/predicates/regex.test.ts`
- Modify: `packages/core/src/automod/predicates/registry.ts`

**Interfaces:**
- Produces: `regexPredicate: Predicate<RegexConfig>`, `regexConfig` (the Zod
  schema), `REGEX_TIMEOUT_MS`.

**Read `docs/reports/release2-slices-3-5-handoff.md`'s obligation 1 before
starting.** This predicate is the one that can take moderation down for the
whole guild, and the operator has no way to know they did it.

**The verified facts in this plan's table are not negotiable and not
re-derivable cheaply.** In particular: the `vm` timeout works, it costs 120 µs,
and `g`/`y` flags carry `lastIndex` across calls on a reused regex.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { compileRule } from './registry.js';
import { regexConfig, REGEX_TIMEOUT_MS } from './regex.js';
import type { AutomodRule, PredicateInput } from './types.js';

const rule = (config: string): AutomodRule => ({
  ruleId: 'r1', kind: 'regex', mode: 'test', config,
  terms: [], allowlist: [], inviteAllowlist: [], linkDomains: [],
});

const message = (content: string): PredicateInput => ({
  guildId: '100000000000000001', channelId: '200000000000000001',
  messageId: '300000000000000001', authorId: '400000000000000001',
  eventKind: 'messageCreate', content, rawContent: content,
  mentionedUserIds: [], mentionedRoleIds: [], mentionsEveryone: false,
  attachments: [], atMs: 1_000,
});

describe('the regex predicate', () => {
  it('matches, and traces the configured pattern rather than the matched text', () => {
    const compiled = compileRule(rule('{"pattern":"buy \\\\w+ now"}'));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const match = compiled.compiled.evaluate(message('please buy crypto now friends'));

    expect(match?.snippet).toBe('buy crypto now');
    // matchedOn is the CONFIGURED thing, not the matched text — ruling R-8:
    // a field whose job is "which configured thing matched" that duplicates
    // the snippet beside it carries no information, and Slice 9's
    // suppression reads it.
    expect(match?.trace.matchedOn).toBe('buy \\w+ now');
    expect(match?.trace.matchedOn).not.toBe(match?.snippet);
  });

  it('points the span at the occurrence that actually matched', () => {
    // The ambiguity ruling R-9 was written about: the term appears twice, so
    // an implementation using indexOf on the matched text rather than the
    // engine's own index picks the wrong one and this goes red.
    const compiled = compileRule(rule('{"pattern":"n[o0]w"}'));
    if (!compiled.ok) throw new Error('should compile');
    const content = 'now or n0w';
    const match = compiled.compiled.evaluate(message(content));
    // 'n0w' at index 7 is what the pattern's second alternative matched...
    // except 'now' at index 0 matches first. Assert the FIRST match's span,
    // and pick a fixture where the two are genuinely distinguishable.
    expect(match?.trace.span).toEqual([0, 3]);
    expect(content.slice(0, 3)).toBe('now');
  });

  it('rejects a pattern that does not compile', () => {
    const result = compileRule(rule('{"pattern":"([unclosed"}'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('compile-failed');
  });

  it('rejects the g and y flags, which carry lastIndex across messages', () => {
    // Verified behaviour, not a theory: /a/g answers true, true, then false
    // for the same content on a reused regex. This predicate reuses one
    // compiled regex for a rule's whole lifetime.
    for (const flags of ['g', 'y', 'gi']) {
      const result = compileRule(rule(JSON.stringify({ pattern: 'spam', flags })));
      expect(result.ok, `flags ${flags} must be refused`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-config');
    }
  });

  it('accepts the flags that are safe to reuse', () => {
    const result = compileRule(rule('{"pattern":"SPAM","flags":"i"}'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.evaluate(message('spam'))).toBeDefined();
  });

  it('caps the pattern length', () => {
    const result = compileRule(rule(JSON.stringify({ pattern: 'a'.repeat(1_001) })));
    expect(result.ok).toBe(false);
  });

  // ── The gate the spec names (section 4, Slice 3) ──────────────────────
  it('survives a catastrophic-backtracking pattern within the timeout', () => {
    // ^(a+)+$ against 'a'*26 + 'b' was measured at 3052 ms in this Node.
    // 60 a's would not finish in the lifetime of this project. The
    // assertion is that the predicate returns control, and does so within a
    // small multiple of the budget rather than hanging the subscriber.
    const compiled = compileRule(rule('{"pattern":"^(a+)+$"}'));
    if (!compiled.ok) throw new Error('should compile: the pattern is valid, only slow');

    const started = Date.now();
    expect(() => compiled.compiled.evaluate(message('a'.repeat(60) + 'b'))).toThrow(
      /timed out/i,
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(REGEX_TIMEOUT_MS * 8);
  }, 20_000);

  it('a rule whose pattern timed out still evaluates the next message', () => {
    // The context is reused, so a timeout must not poison it. Verified
    // behaviour, pinned here because it is the difference between one bad
    // message and a rule that is dead until restart.
    const compiled = compileRule(rule('{"pattern":"^(a+)+$"}'));
    if (!compiled.ok) throw new Error('should compile');
    expect(() => compiled.compiled.evaluate(message('a'.repeat(60) + 'b'))).toThrow();
    expect(compiled.compiled.evaluate(message('aaa'))).toBeDefined();
  }, 20_000);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/core/src/automod/predicates/regex.test.ts`
Expected: FAIL — no module `./regex.js`.

- [ ] **Step 3: Implement the predicate**

```ts
import { createContext, Script, type Context } from 'node:vm';
import { z } from 'zod';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

/**
 * How long one pattern may run against one message before it is abandoned
 * (plan ruling PR-11).
 *
 * A legitimate pattern completes in well under a microsecond — a direct
 * `exec` was measured at 0.05 microseconds — so this is four orders of
 * magnitude of headroom. Deliberately not operator-configurable: the only
 * use for raising it is to make a hanging pattern hang for longer.
 */
export const REGEX_TIMEOUT_MS = 25;

/** Flags that are safe on a regex reused for a rule's whole lifetime. */
const ALLOWED_FLAGS = ['i', 'm', 's', 'u'] as const;

/**
 * `g` and `y` are refused, and this is measured behaviour rather than
 * caution (plan ruling PR-13). Both keep `lastIndex` on the RegExp object
 * between calls, and this predicate compiles one RegExp and reuses it for
 * every message the rule ever sees. A probe on this Node: `/a/g` answered
 * `test('banana')` true (lastIndex 2), then true (lastIndex 4), then
 * `test('xyz')` false (lastIndex reset to 0). The same message would get
 * different answers depending on what was posted before it, which is a
 * moderation rule that is wrong roughly half the time and looks fine in
 * every test that evaluates one message.
 */
export const regexConfig = z
  .object({
    pattern: z.string().min(1).max(1_000),
    flags: z
      .string()
      .max(ALLOWED_FLAGS.length)
      .refine(
        (value) => [...value].every((flag) => (ALLOWED_FLAGS as readonly string[]).includes(flag)),
        {
          message:
            'only the i, m, s and u flags are allowed; g and y carry lastIndex between messages',
        },
      )
      .optional(),
  })
  .strict();

export type RegexConfig = z.infer<typeof regexConfig>;

/**
 * The regex predicate, with a hard per-evaluation timeout (spec section 3,
 * Slice 3; the gate is named in section 4).
 *
 * **Why `node:vm` is here, and what it is not doing.** It is an
 * *interruptible execution wrapper*, not a security sandbox. V8 cannot
 * abandon a runaway regex from ordinary JavaScript — there is no
 * `RegExp` timeout — but `vm`'s watchdog terminates execution inside a
 * context, and a probe on this Node confirmed it interrupts catastrophic
 * backtracking that would otherwise never return (it threw at 204 ms on a
 * 200 ms budget, against a pattern measured at 3052 ms for a 26-character
 * input).
 *
 * The script inside the context is the fixed string below. The operator's
 * pattern reaches it as a `RegExp` object built by `new RegExp` in the
 * ordinary realm; `new RegExp` cannot execute arbitrary code, so no
 * operator-supplied *code* is ever evaluated. A reader who sees `node:vm`
 * will reasonably assume a sandbox, which is why this says otherwise.
 *
 * The alternative the spec also permits — a linear-time engine — means
 * `re2`, a native module that must compile on the deployment host. The
 * timeout costs no dependency (plan ruling PR-10).
 */
export const regexPredicate: Predicate<RegexConfig> = {
  kind: 'regex',
  config: regexConfig,
  compile(_rule: AutomodRule, config: RegexConfig): CompiledPredicate {
    // Throws on an invalid pattern, which `compileRule` turns into
    // `compile-failed` — inert and loud (ADR 0040 section 4), never a crash.
    const pattern = new RegExp(config.pattern, config.flags ?? '');

    // Context and Script are built once, here, not per message: that is what
    // keeps an evaluation at ~120 microseconds instead of paying for context
    // creation every time. A probe confirmed the timeout still fires when
    // both are reused, and that a context which has already timed out stays
    // usable for later messages.
    const context: Context = createContext({ pattern, input: '' });
    const script = new Script('pattern.exec(input)');

    return {
      evaluate(messageInput) {
        (context as { input: string }).input = messageInput.content;

        // A timeout throws, and that is deliberate (plan ruling PR-12):
        // `evaluateRule` catches it and the subscriber logs "the predicate
        // threw", naming the rule. Returning "no match" would be silent,
        // which is the ADR 0039 failure this project has walked into three
        // times — a rule that looks configured and quietly does nothing.
        const found = script.runInContext(context, { timeout: REGEX_TIMEOUT_MS }) as
          | RegExpExecArray
          | null;
        if (found === null) return undefined;

        const matched = found[0];
        return {
          // No categories on this predicate, so the kind is the category —
          // the convention `PredicateMatch.categoryId` documents.
          categoryId: 'regex',
          snippet: matched,
          trace: {
            kind: 'regex',
            // The configured pattern, not the text it matched (ruling R-8).
            // Slice 9's suppression for this predicate is "narrow the
            // pattern", and it needs to know which pattern.
            matchedOn: config.pattern,
            // The engine's own index, not indexOf on the matched text —
            // ruling R-9 records a shipped bug from exactly that shortcut,
            // where a repeated term produced a span over the wrong
            // occurrence.
            span: [found.index, found.index + matched.length],
            normalisations: ['zero-width stripped'],
            detail: {
              flags: config.flags ?? '',
              patternLength: config.pattern.length,
            },
          },
        };
      },
    };
  },
};
```

- [ ] **Step 4: Register it**

In `registry.ts`, add `regex: regexPredicate` to `PREDICATES` and the import.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/core/src/automod/predicates/regex.test.ts`
Expected: PASS.

**Then break the gate and watch it fail.** Change `timeout: REGEX_TIMEOUT_MS`
to run the regex directly (`pattern.exec(messageInput.content)`), re-run the
ReDoS test, and confirm it **hangs** rather than passing — that is the
20-second vitest timeout firing. Restore. **Report exactly what you observed**,
because a ReDoS test that passes against an unprotected implementation is the
most expensive decorative guard this project could ship.

- [ ] **Step 6: Gates and commit**

Run: `npm run typecheck && npm run lint && npm run test`

```bash
git add packages/core/src/automod/predicates
git commit -m "feat(automod): the regex predicate, with a hard per-evaluation timeout

Obligation 1 of the slices 3-5 handoff. node:vm is used as an interruptible
execution wrapper, not a sandbox; g and y flags are refused because they carry
lastIndex across messages on a reused regex.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SAXL4Tpn7zGArAzZs9vKNW"
```

---

### Task 4: the `caps` and `emoji` predicates

**Files:**
- Create: `packages/core/src/automod/predicates/caps.ts` + `.test.ts`
- Create: `packages/core/src/automod/predicates/emoji.ts` + `.test.ts`
- Modify: `packages/core/src/automod/predicates/registry.ts`

**Interfaces:**
- Produces: `capsPredicate: Predicate<CapsConfig>`,
  `emojiPredicate: Predicate<EmojiConfig>`.

Both are whole-message properties, so **`MatchTrace.span` is `undefined`** for
both — the interface documents that case explicitly and it is the right answer
here, not a shortcut.

- [ ] **Step 1: Write the failing `caps` tests**

```ts
describe('the caps predicate', () => {
  it('does not fire below the minimum length', () => {
    // The spec names short messages as one of this predicate's three
    // false-positive sources, and requires a floor.
    const compiled = compile('{"minLength":10,"maxRatio":0.7}');
    expect(compiled.evaluate(message('OK FINE'))).toBeUndefined();
  });

  it('fires on a long shout', () => {
    const compiled = compile('{"minLength":10,"maxRatio":0.7}');
    const match = compiled.evaluate(message('EVERYONE COME AND LOOK AT THIS NOW'));
    expect(match?.trace.detail.ratio).toBeGreaterThan(0.7);
    expect(match?.trace.span).toBeUndefined();
  });

  it('measures capitals against letters, not against every character', () => {
    // The ambiguity: punctuation would dilute the ratio under a
    // count-everything implementation, so 'HELLO!!!!!!!!!!!!!!!' would score
    // about 0.5 and pass a 0.7 threshold that plain 'HELLO' exceeds. Same
    // letters, same shout, opposite verdict.
    const compiled = compile('{"minLength":10,"maxRatio":0.7}');
    expect(compiled.evaluate(message('HELLO!!!!!!!!!!!!!!!'))).toBeDefined();
  });

  it('ignores fenced and inline code', () => {
    // The third false-positive source the spec names. A message that is a
    // shouted SQL snippet is not shouting at anyone.
    const compiled = compile('{"minLength":10,"maxRatio":0.7}');
    expect(
      compiled.evaluate(message('here you go ```SELECT * FROM MOD_RULES WHERE ENABLED = 1```')),
    ).toBeUndefined();
  });

  it('does not divide by zero on a message with no letters', () => {
    const compiled = compile('{"minLength":3,"maxRatio":0.7}');
    expect(compiled.evaluate(message('12345 !!!! ????'))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Write the failing `emoji` tests**

```ts
describe('the emoji predicate', () => {
  it('counts a ZWJ sequence as one emoji', () => {
    // Verified: Intl.Segmenter reports the family as 1 grapheme, while a
    // code-point scan reports 4 (plus joiners). A code-point implementation
    // fires here and this goes red.
    const compiled = compile('{"maxCount":3}');
    expect(compiled.evaluate(message('👨‍👩‍👧‍👦 👨‍👩‍👧‍👦 👨‍👩‍👧‍👦'))).toBeUndefined();
  });

  it('counts flags and keycaps, which are not Extended_Pictographic', () => {
    // Verified: '🇬🇧' and '1️⃣' both score 0 under \p{Extended_Pictographic}
    // while being one grapheme each. A pictographic-only implementation
    // counts zero here and this goes red.
    const compiled = compile('{"maxCount":3}');
    expect(compiled.evaluate(message('🇬🇧 🇬🇧 1️⃣ 2️⃣'))).toBeDefined();
  });

  it('counts a Discord custom emoji once, not as its literal characters', () => {
    // '<:party:123456789012345678>' is 26 characters of ordinary text. An
    // implementation that counted the pattern AND left it in the string for
    // grapheme counting would still report 1 here; one that forgot the
    // pattern entirely reports 0. Four of them against a threshold of 3 is
    // what separates the two.
    const compiled = compile('{"maxCount":3}');
    const custom = '<:party:123456789012345678>';
    expect(compiled.evaluate(message(custom.repeat(4)))).toBeDefined();
    expect(compiled.evaluate(message(custom.repeat(3)))).toBeUndefined();
  });

  it('counts an animated custom emoji too', () => {
    const compiled = compile('{"maxCount":1}');
    expect(compiled.evaluate(message('<a:spin:123456789012345678><a:spin:123456789012345679>')))
      .toBeDefined();
  });

  it('leaves ordinary text alone', () => {
    const compiled = compile('{"maxCount":3}');
    expect(compiled.evaluate(message('good morning everyone, meeting at four'))).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run both and watch them fail**

Run: `npx vitest run packages/core/src/automod/predicates/caps.test.ts packages/core/src/automod/predicates/emoji.test.ts`
Expected: FAIL — no such modules.

- [ ] **Step 4: Implement `caps.ts`**

```ts
import { z } from 'zod';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

/**
 * Fenced blocks first, then inline spans (plan ruling PR-17).
 *
 * Order matters: an inline-span pattern run first would eat the ``` fences
 * from the inside out and leave the block's contents behind, which is the
 * opposite of the intent.
 */
const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;

export const capsConfig = z
  .object({
    /**
     * Below this many characters the rule does not fire at all. The spec
     * requires a floor: 'OK' is 100% capitals and is not shouting.
     */
    minLength: z.number().int().min(1).max(4_000),
    /** Fires when the ratio of upper-case letters to letters exceeds this. */
    maxRatio: z.number().gt(0).lte(1),
  })
  .strict();

export type CapsConfig = z.infer<typeof capsConfig>;

export const capsPredicate: Predicate<CapsConfig> = {
  kind: 'caps',
  config: capsConfig,
  compile(_rule: AutomodRule, config: CapsConfig): CompiledPredicate {
    return {
      evaluate(input) {
        // Code is not shouting (plan ruling PR-17) — one of the three
        // false-positive sources the spec names for this predicate.
        const prose = input.content.replace(FENCED_CODE, ' ').replace(INLINE_CODE, ' ');
        if (prose.length < config.minLength) return undefined;

        // Measured against letters, not against every character: otherwise
        // punctuation and digits dilute the ratio and a longer shout scores
        // lower than a short one.
        const letters = [...prose].filter((c) => /\p{L}/u.test(c));
        if (letters.length === 0) return undefined;
        const upper = letters.filter((c) => /\p{Lu}/u.test(c)).length;
        const ratio = upper / letters.length;
        if (ratio <= config.maxRatio) return undefined;

        return {
          categoryId: 'caps',
          // The whole message is the evidence; there is no span to point at.
          snippet: input.content.slice(0, 200),
          trace: {
            kind: 'caps',
            matchedOn: `ratio > ${config.maxRatio}`,
            // A property of the whole message, not a span of it — the case
            // `MatchTrace.span` documents as `undefined`.
            span: undefined,
            normalisations: ['zero-width stripped', 'code spans removed'],
            detail: {
              ratio: Number(ratio.toFixed(3)),
              letters: letters.length,
              upper,
              minLength: config.minLength,
              maxRatio: config.maxRatio,
            },
          },
        };
      },
    };
  },
};
```

- [ ] **Step 5: Implement `emoji.ts`**

```ts
import { z } from 'zod';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

/** `<:name:id>` and the animated `<a:name:id>`. Ordinary text to a grapheme counter. */
const CUSTOM_EMOJI = /<a?:[A-Za-z0-9_]{2,32}:\d{17,20}>/g;

/**
 * What counts as one emoji, given a single grapheme.
 *
 * `\p{Extended_Pictographic}` alone is not enough, and this is measured, not
 * cautious: on this Node a regional-indicator flag (`🇬🇧`), a keycap (`1️⃣`)
 * and `#️⃣` are each exactly one grapheme and each score **zero**
 * pictographic characters. A pictographic-only counter silently under-counts
 * every flag and every keycap in the message.
 */
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;
const KEYCAP = /⃣/u;

/**
 * Created once at module load rather than per evaluation: constructing a
 * segmenter is not free and it holds no per-call state.
 */
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

export const emojiConfig = z
  .object({
    /** Fires when the message carries more than this many emoji. */
    maxCount: z.number().int().min(1).max(200),
  })
  .strict();

export type EmojiConfig = z.infer<typeof emojiConfig>;

export const emojiPredicate: Predicate<EmojiConfig> = {
  kind: 'emoji',
  config: emojiConfig,
  compile(_rule: AutomodRule, config: EmojiConfig): CompiledPredicate {
    return {
      evaluate(input) {
        // Counted by pattern and then *removed*, so the 26 ordinary
        // characters of '<:party:123456789012345678>' are not also counted
        // as themselves by the grapheme pass below.
        const custom = input.content.match(CUSTOM_EMOJI)?.length ?? 0;
        const withoutCustom = input.content.replace(CUSTOM_EMOJI, ' ');

        // Graphemes, not code points: a ZWJ family is four code points and
        // one emoji, and Intl.Segmenter is what knows the difference.
        let unicode = 0;
        for (const { segment } of GRAPHEMES.segment(withoutCustom)) {
          if (
            PICTOGRAPHIC.test(segment) ||
            REGIONAL_INDICATOR.test(segment) ||
            KEYCAP.test(segment)
          ) {
            unicode += 1;
          }
        }

        const total = custom + unicode;
        if (total <= config.maxCount) return undefined;

        return {
          categoryId: 'emoji',
          snippet: input.content.slice(0, 200),
          trace: {
            kind: 'emoji',
            matchedOn: `more than ${config.maxCount} emoji`,
            span: undefined,
            normalisations: ['zero-width stripped', 'grapheme segmented'],
            detail: { total, custom, unicode, maxCount: config.maxCount },
          },
        };
      },
    };
  },
};
```

- [ ] **Step 6: Register both, run the tests, and break them**

Add `caps: capsPredicate` and `emoji: emojiPredicate` to `PREDICATES`.

Run: `npx vitest run packages/core/src/automod/predicates`
Expected: PASS.

Watch two guards fail:
- **caps:** change `letters.length` to `prose.length` (count everything) and
  confirm the punctuation test goes red.
- **emoji:** drop `REGIONAL_INDICATOR` and `KEYCAP` from the condition and
  confirm the flags/keycaps test goes red; separately, replace the grapheme
  loop with a code-point scan and confirm the ZWJ test goes red.

Restore after each. Report what you saw.

- [ ] **Step 7: Gates and commit**

Run: `npm run typecheck && npm run lint && npm run test`

```bash
git add packages/core/src/automod/predicates
git commit -m "feat(automod): the caps and emoji predicates

caps measures capitals against letters and ignores code spans; emoji counts
graphemes, including flags and keycaps that Extended_Pictographic does not
match.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SAXL4Tpn7zGArAzZs9vKNW"
```

---

### Task 5: `attachment_type`, and widening the one-code-path gate

**Files:**
- Create: `packages/core/src/automod/predicates/attachment-type.ts` + `.test.ts`
- Modify: `packages/core/src/automod/predicates/registry.ts`
- Modify: `packages/core/src/automod/dry-run.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 (`FixtureRecord.attachments`, and
  `predicateInputFrom` reconstructing them).
- Produces: `attachmentTypePredicate: Predicate<AttachmentTypeConfig>`.

**This task carries obligation 3 from the handoff.** The one-code-path gate is
a *behavioural* comparison, so it only detects divergences in fields a shipped
predicate reads — and `keyword_filter` reads only `content`. **`attachment_type`
is the first predicate to read a second field**, so the behavioural gate is
extended here.

- [ ] **Step 1: Write the failing predicate tests**

The spec is explicit: match on declared content type **and** file extension,
"since either alone is trivially spoofed". That means a hit on *either* list is
a match — the two lists are belt and braces, not a conjunction.

```ts
describe('the attachment_type predicate', () => {
  const config = '{"blockedExtensions":["exe","scr"],"blockedContentTypes":["application/x-msdownload"]}';

  it('matches on the extension when the content type is innocent', () => {
    // The spoof the spec names: a real executable declared as text/plain.
    const match = compile(config).evaluate(
      withAttachments([{ fileName: 'setup.exe', contentType: 'text/plain', sizeBytes: 10 }]),
    );
    expect(match?.trace.detail.matchedOn).toBe('extension');
  });

  it('matches on the content type when the extension is innocent', () => {
    // The other half of the same spoof, and the reason the spec says "and".
    const match = compile(config).evaluate(
      withAttachments([
        { fileName: 'holiday.jpg', contentType: 'application/x-msdownload', sizeBytes: 10 },
      ]),
    );
    expect(match?.trace.detail.matchedOn).toBe('contentType');
  });

  it('names the offending file, not the first file', () => {
    // The ambiguity: three attachments and only the third is blocked, so an
    // implementation reporting attachments[0] goes red. A single-attachment
    // fixture could not tell the two apart.
    const match = compile(config).evaluate(
      withAttachments([
        { fileName: 'a.png', contentType: 'image/png', sizeBytes: 1 },
        { fileName: 'b.txt', contentType: 'text/plain', sizeBytes: 2 },
        { fileName: 'c.scr', contentType: 'text/plain', sizeBytes: 3 },
      ]),
    );
    expect(match?.snippet).toBe('c.scr');
  });

  it('is case-insensitive about both the extension and the content type', () => {
    const match = compile(config).evaluate(
      withAttachments([{ fileName: 'SETUP.EXE', contentType: 'TEXT/PLAIN', sizeBytes: 10 }]),
    );
    expect(match).toBeDefined();
  });

  it('ignores a content type parameter', () => {
    // Discord can declare 'application/x-msdownload; charset=binary'.
    const match = compile(config).evaluate(
      withAttachments([
        { fileName: 'x.bin', contentType: 'application/x-msdownload; charset=binary', sizeBytes: 1 },
      ]),
    );
    expect(match).toBeDefined();
  });

  it('does not match a file whose name merely contains the extension', () => {
    // 'exeter-notes.pdf' contains 'exe'. Matching on the final segment after
    // the last dot is what stops that.
    expect(
      compile(config).evaluate(
        withAttachments([{ fileName: 'exeter-notes.pdf', contentType: 'application/pdf', sizeBytes: 1 }]),
      ),
    ).toBeUndefined();
  });

  it('does not match a message with no attachments', () => {
    expect(compile(config).evaluate(withAttachments([]))).toBeUndefined();
  });

  it('handles a file with no extension and no declared type', () => {
    expect(
      compile(config).evaluate(
        withAttachments([{ fileName: 'README', contentType: undefined, sizeBytes: 1 }]),
      ),
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/core/src/automod/predicates/attachment-type.test.ts`
Expected: FAIL — no such module.

- [ ] **Step 3: Implement it**

```ts
import { z } from 'zod';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

/**
 * Both lists live in `mod_rules.config` rather than in tables (plan ruling
 * PR-16). ADR 0040 section 3 names the relational cases explicitly —
 * `invite`'s labelled allowlist and `link_domain`'s allow/deny lists — and
 * does not name this one: an extension list has no per-item metadata and no
 * per-item suppression target, which is what the relational shape exists for.
 * Config also reaches the rule fingerprint for free, where a relational list
 * has to be carried into it deliberately.
 *
 * Extensions are stored without a leading dot and matched case-insensitively.
 */
export const attachmentTypeConfig = z
  .object({
    blockedExtensions: z.array(z.string().min(1).max(20)).max(100).default([]),
    blockedContentTypes: z.array(z.string().min(1).max(255)).max(100).default([]),
  })
  .strict()
  .refine(
    (value) => value.blockedExtensions.length > 0 || value.blockedContentTypes.length > 0,
    {
      // A rule with both lists empty compiles cleanly and can never match —
      // the ADR 0039 shape, and the same failure `no-terms` closes for
      // `keyword_filter` (registry.ts). Refused at validation instead, so
      // `doctor` reports it as an invalid config rather than a clean rule.
      message: 'an attachment_type rule needs at least one blocked extension or content type',
    },
  );

export type AttachmentTypeConfig = z.infer<typeof attachmentTypeConfig>;

/** The final dot-separated segment, lower-cased. '' when there is no dot. */
const extensionOf = (fileName: string): string => {
  const dot = fileName.lastIndexOf('.');
  // `dot <= 0` also rejects a dotfile like '.env', whose name is not an
  // extension. Matching on the last segment rather than a substring is what
  // stops 'exeter-notes.pdf' matching a blocked 'exe'.
  return dot <= 0 ? '' : fileName.slice(dot + 1).toLowerCase();
};

/** 'application/pdf; charset=x' -> 'application/pdf'. Discord sends parameters. */
const bareContentType = (contentType: string | undefined): string =>
  (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

export const attachmentTypePredicate: Predicate<AttachmentTypeConfig> = {
  kind: 'attachment_type',
  config: attachmentTypeConfig,
  compile(_rule: AutomodRule, config: AttachmentTypeConfig): CompiledPredicate {
    const extensions = new Set(
      config.blockedExtensions.map((e) => e.replace(/^\./, '').toLowerCase()),
    );
    const contentTypes = new Set(config.blockedContentTypes.map((t) => t.trim().toLowerCase()));

    return {
      evaluate(input) {
        for (const attachment of input.attachments) {
          // Either list is enough. The spec's reasoning: a content type is
          // declared by the uploader and an extension is chosen by the
          // uploader, so each alone is trivially spoofed and the pair is
          // checked rather than one being trusted.
          const extension = extensionOf(attachment.fileName);
          const contentType = bareContentType(attachment.contentType);
          const byExtension = extension !== '' && extensions.has(extension);
          const byContentType = contentType !== '' && contentTypes.has(contentType);
          if (!byExtension && !byContentType) continue;

          return {
            categoryId: 'attachment_type',
            // The filename, which is what a reviewer needs to see. The
            // owner was told filenames carry personal information when they
            // approved OD-3; this is the same fact appearing in a trace.
            snippet: attachment.fileName,
            trace: {
              kind: 'attachment_type',
              matchedOn: byExtension ? extension : contentType,
              // A property of a file on the message, not a span of its text.
              span: undefined,
              normalisations: [],
              detail: {
                matchedOn: byExtension ? 'extension' : 'contentType',
                fileName: attachment.fileName,
                declaredContentType: contentType,
                sizeBytes: attachment.sizeBytes,
                attachmentCount: input.attachments.length,
              },
            },
          };
        }
        return undefined;
      },
    };
  },
};
```

- [ ] **Step 4: Widen the behavioural one-code-path gate**

In `dry-run.test.ts`, beside the existing gate. The existing one compares a
`keyword_filter` match built from a message against one built from a fixture;
it passes today even if the fixture branch skipped attachment reconstruction,
because nothing read that field.

```ts
it('the dry run and the live subscriber agree on a message with attachments', () => {
  // Obligation 3 of the slices 3-5 handoff. The existing gate is a
  // behavioural comparison, so it can only see a divergence in a field some
  // shipped predicate reads — and keyword_filter reads only `content`. A
  // hand-built PredicateInput skipping attachment reconstruction was
  // invisible to it. attachment_type is the first predicate to read a
  // second field, so the gate reaches that field from here.
  const rule: AutomodRule = {
    ruleId: 'attachments', kind: 'attachment_type', mode: 'test',
    config: '{"blockedExtensions":["exe"]}',
    terms: [], allowlist: [], inviteAllowlist: [], linkDomains: [],
  };
  const attachments = [
    { fileName: 'setup.exe', contentType: 'text/plain', sizeBytes: 4096 },
  ];

  const live = predicateInputFrom({
    from: 'message',
    event: messageEvent({ content: 'have a look', attachments }),
  });
  const replayed = predicateInputFrom({
    from: 'fixture',
    guildId: GUILD_ID,
    fixture: {
      fixtureId: '900000000000000001:0123456789abcdef',
      content: 'have a look',
      authorId: '800000000000000001',
      label: 'unlabelled', source: 'observed', createdAt: 1_000,
      attachments,
    },
  });

  const cache = createPredicateCache();
  expect(evaluateRule(cache, rule, live!)).toEqual(evaluateRule(createPredicateCache(), rule, replayed!));
  // And it is a real match on both sides, not two identical nothings — a
  // comparison of two undefineds would pass under every implementation.
  expect(evaluateRule(cache, rule, live!).kind).toBe('match');
});
```

- [ ] **Step 5: Run the tests, and break the widened gate**

Run: `npx vitest run packages/core/src/automod`
Expected: PASS.

**Then prove the widened gate can fail:** temporarily restore
`attachments: []` in `predicateInputFrom`'s fixture branch and confirm the new
test goes red **while the pre-existing keyword_filter gate stays green** — that
contrast is the whole point of the obligation, and it is what your report
should say. Restore.

- [ ] **Step 6: Register, gates, commit**

Add `attachment_type: attachmentTypePredicate` to `PREDICATES`.

Run: `npm run typecheck && npm run lint && npm run test`

```bash
git add packages/core/src/automod
git commit -m "feat(automod): the attachment_type predicate, and the one-code-path gate reaches a second field

Obligation 3 of the slices 3-5 handoff: the behavioural gate could only see
divergences in fields a shipped predicate reads, and keyword_filter reads only
content. attachment_type is the first to read a second field.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SAXL4Tpn7zGArAzZs9vKNW"
```

---

### Task 6: the relational lists for `invite` and `link_domain`

**Files:**
- Modify: `packages/storage/src/schema.ts` (two new tables)
- Generate: `drizzle/00NN_*.sql` via `npm run db:generate`
- Create: `packages/storage/src/repos/automod-rule-lists.ts` + `.test.ts`
- Modify: `packages/storage/src/repos/automod-rules.ts` (`hydrate`,
  `StoredAutomodRule`)
- Modify: `packages/core/src/automod/predicates/types.ts` (`AutomodRule`)
- Modify: `packages/core/src/automod/fingerprint.ts`
- Test: `packages/core/src/automod/fingerprint.test.ts`,
  `packages/storage/src/repos/automod-rules.test.ts`

**Interfaces:**
- Produces:
  - `AutomodRule.inviteAllowlist: readonly { code: string; label: string }[]`
  - `AutomodRule.linkDomains: readonly { domain: string; listType: 'allow' | 'deny' }[]`
  - and the same two fields on storage's `StoredAutomodRule`.
  - Repository: `listInviteAllowlist(scope, ruleId)`,
    `addInviteAllowlistEntry(scope, input)`,
    `removeInviteAllowlistEntry(scope, ruleId, code)`,
    `listLinkDomains(scope, ruleId)`, `addLinkDomain(scope, input)`,
    `removeLinkDomain(scope, ruleId, domain)`.

**This task carries obligation 2 from the handoff.** Slice 1's fingerprint is
exclusion-based, so it hashes new `AutomodRule` fields automatically — but
**verify the allowlist actually reaches the fingerprint**, or an allowlist edit
will not invalidate the compiled artifact. That is ADR 0039's bug wearing a new
coat.

`last_matched_at` is **not** part of this table — see plan ruling PR-14, and
carry the deferral into the ledger.

- [ ] **Step 1: Write the failing fingerprint test first**

This is the obligation, so it goes first.

```ts
// packages/core/src/automod/fingerprint.test.ts
it('an invite allowlist edit changes the fingerprint', () => {
  // Obligation 2 of the slices 3-5 handoff. The digest is exclusion-based,
  // so this should hold without anyone editing fingerprint.ts — but "should"
  // is what ADR 0039 was about. If this ever goes green with the field
  // excluded, an operator adding a partner code sees the rule keep firing on
  // it until the daemon restarts.
  const base = ruleWith({ inviteAllowlist: [{ code: 'clubhouse', label: 'our server' }] });
  const edited = ruleWith({
    inviteAllowlist: [
      { code: 'clubhouse', label: 'our server' },
      { code: 'sisterclub', label: 'sister club, added 2026-09' },
    ],
  });
  expect(ruleFingerprint(edited)).not.toBe(ruleFingerprint(base));
});

it('a label edit changes the fingerprint too', () => {
  // The label does not change matching, so this over-invalidates by one
  // recompile. That asymmetry is deliberate and R-11 argues it: over-
  // invalidation costs a recompile and fails loudly, under-invalidation
  // costs correctness and fails silently.
  expect(
    ruleFingerprint(ruleWith({ inviteAllowlist: [{ code: 'x', label: 'before' }] })),
  ).not.toBe(ruleFingerprint(ruleWith({ inviteAllowlist: [{ code: 'x', label: 'after' }] })));
});

it('the order rows come back in does not change the fingerprint', () => {
  // Row order is the query planner's business, not a rule change — the same
  // reason `terms` and `allowlist` are sorted before hashing.
  const a = ruleWith({
    linkDomains: [
      { domain: 'example.com', listType: 'deny' },
      { domain: 'club.org', listType: 'allow' },
    ],
  });
  const b = ruleWith({
    linkDomains: [
      { domain: 'club.org', listType: 'allow' },
      { domain: 'example.com', listType: 'deny' },
    ],
  });
  expect(ruleFingerprint(a)).toBe(ruleFingerprint(b));
});

it('a domain moving from allow to deny changes the fingerprint', () => {
  // The ambiguity a sort-only test would miss: same domain, same position,
  // opposite meaning. An implementation that canonicalised to the domain
  // list alone and dropped listType would pass the previous test and fail
  // this one.
  expect(
    ruleFingerprint(ruleWith({ linkDomains: [{ domain: 'example.com', listType: 'allow' }] })),
  ).not.toBe(
    ruleFingerprint(ruleWith({ linkDomains: [{ domain: 'example.com', listType: 'deny' }] })),
  );
});
```

- [ ] **Step 2: Run and watch them fail**

Expected: FAIL — `inviteAllowlist` is not a property of `AutomodRule`.

- [ ] **Step 3: Add the two tables to `schema.ts`**

```ts
/**
 * `invite`'s allowlist: the club's own invite codes plus partner and
 * sister-club codes, each with a human label (spec section 3, Slice 3).
 *
 * Relational rather than JSON in `mod_rules.config`, per ADR 0040 section 3:
 * the label is per-item metadata, and Slice 9's one-click suppression for
 * this predicate is "add this code to the allowlist", which is a row.
 *
 * **No `last_matched_at`, deliberately** (plan ruling PR-14). The spec asks
 * for one so a stale partner code is visible, but writing it means either a
 * database write on the hot path for every allowlisted invite in every
 * message, or widening every predicate's return type so a non-match can
 * carry observations. Carried to Slice 9, where the review surface can
 * derive staleness from match history instead. The label is what keeps the
 * list readable until then.
 */
export const automodInviteAllowlist = sqliteTable(
  'automod_invite_allowlist',
  {
    guildId: snowflake('guild_id').notNull(),
    ruleId: text('rule_id').notNull(),
    /** The invite code as it appears after `discord.gg/`. Case-preserving; matched case-insensitively. */
    code: text('code').notNull(),
    /** Why this code is allowed, for the human reading the list a year from now. */
    label: text('label').notNull(),
    addedAt: integer('added_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.ruleId, t.code] }),
    foreignKey({
      columns: [t.guildId, t.ruleId],
      foreignColumns: [modRules.guildId, modRules.ruleId],
    }).onDelete('cascade'),
    check('automod_invite_allowlist_guild_id_snowflake', snowflakeCheck(t.guildId)),
  ],
);

/**
 * `link_domain`'s allow and deny lists (spec section 3, Slice 3).
 *
 * One table with a `list_type` rather than two tables: the two lists are the
 * same shape and are always read together, and a domain that appears on both
 * is a configuration error the primary key makes impossible to express.
 *
 * Matching is label-wise suffix, not registrable-domain (plan ruling PR-15):
 * `example.com` matches `example.com` and `gist.example.com` but not
 * `notexample.com`. No Public Suffix List, and therefore no dependency and no
 * data file to go stale.
 */
export const automodLinkDomains = sqliteTable(
  'automod_link_domains',
  {
    guildId: snowflake('guild_id').notNull(),
    ruleId: text('rule_id').notNull(),
    /** Stored lower-cased, without a scheme, port or path. */
    domain: text('domain').notNull(),
    listType: text('list_type').notNull(),
    addedAt: integer('added_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.ruleId, t.domain] }),
    foreignKey({
      columns: [t.guildId, t.ruleId],
      foreignColumns: [modRules.guildId, modRules.ruleId],
    }).onDelete('cascade'),
    check('automod_link_domains_guild_id_snowflake', snowflakeCheck(t.guildId)),
    check('automod_link_domains_list_type', sql`${t.listType} IN ('allow','deny')`),
  ],
);
```

- [ ] **Step 4: Generate the migration and read it**

Run: `npm run db:generate`

Same checks as Task 1 Step 4: two `CREATE TABLE`s, `STRICT` appended, no
`__new_`, no `DROP`, no `RENAME`. **Report what you saw.** If a rebuild
appears, stop — that is the R-5 hazard.

- [ ] **Step 5: Write the repository**

`packages/storage/src/repos/automod-rule-lists.ts`. Follow
`automod-fixtures.ts`'s conventions exactly: `GuildScope` first, every query
through `scope.only(...)`, `read`/`write` helpers, `onConflictDoNothing`
targeted at the primary key.

```ts
export interface InviteAllowlistEntry {
  readonly code: string;
  readonly label: string;
}

export interface LinkDomainEntry {
  readonly domain: string;
  readonly listType: 'allow' | 'deny';
}
```

`listInviteAllowlist` orders by `code`; `listLinkDomains` orders by `domain`.
Deterministic order is not cosmetic here — it feeds the rule fingerprint, and a
digest that changed with the query plan would recompile every matcher at
random. (The fingerprint also sorts, so this is belt and braces; say so.)

`addLinkDomain` lower-cases and strips any leading `www.` before storing, so
the list holds one canonical form.

- [ ] **Step 6: Hydrate them onto the rule**

Add both fields to `StoredAutomodRule` and load them in `hydrate`, beside the
word list. Two queries per rule, unconditionally — no branch on `kind`,
matching the comment already in that function ("Every kind but `keyword_filter`
simply has no `word_categories` rows, so `terms`/`allowlist` come back `[]`
naturally"). The same is true here, and a `kind` branch would be a second
place that has to be updated when a kind is added.

Then add the two fields to `core`'s `AutomodRule` in `types.ts`, re-declared
rather than imported (ADR 0014), with a comment naming ADR 0040 §3's split.

- [ ] **Step 7: Canonicalise them in the fingerprint**

In `fingerprint.ts`'s `canonicalise`, add cases for the two new keys, sorting
them the way `terms` is sorted. Extend the function's doc comment to say the
new fields are covered — the existing comment already predicts them ("ADR 0040
§3 already commits a later slice to a relational allowlist field").

- [ ] **Step 8: Run everything, and break the obligation guard**

Run: `npm run test`
Expected: PASS.

**Then watch the obligation guard fail.** Add `'inviteAllowlist'` to
`EXCLUDED_FIELDS` in `fingerprint.ts` — that is precisely the mistake the
obligation exists to catch — confirm the "an invite allowlist edit changes the
fingerprint" test goes red, and restore. **Report it.** If it stays green with
the field excluded, the guard is decorative and the obligation is unmet.

Also add a hydration test to `automod-rules.test.ts` with **two rules, each
with entries**, so an implementation that dropped the `rule_id` predicate hands
both lists to both rules and goes red. One rule with entries and one without
would pass under that bug — the shape `docs/22` records.

- [ ] **Step 9: Gates and commit**

Run: `npm run typecheck && npm run lint && npm run test`

```bash
git add packages/storage packages/core drizzle
git commit -m "feat(automod): relational allowlists for invite and link_domain, and they reach the fingerprint

ADR 0040 section 3's split, and obligation 2 of the slices 3-5 handoff: the
exclusion-based digest hashes the new fields without editing fingerprint.ts,
and a test watched fail with the field excluded proves it.

last_matched_at is deferred to Slice 9 - see plan ruling PR-14.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SAXL4Tpn7zGArAzZs9vKNW"
```

---

### Task 7: the `invite` predicate

**Files:**
- Create: `packages/core/src/automod/predicates/invite.ts` + `.test.ts`
- Modify: `packages/core/src/automod/predicates/registry.ts`

**Interfaces:**
- Consumes: Task 6's `AutomodRule.inviteAllowlist`.
- Produces: `invitePredicate: Predicate<InviteConfig>`.

**Pattern matching only, no resolution** — an owner decision, and CLAUDE.md
rule 8 forbids the outbound call anyway. The predicate detects anything
invite-shaped and checks it against the local allowlist.

- [ ] **Step 1: Write the failing tests**

```ts
describe('the invite predicate', () => {
  const rule = (allowlist: { code: string; label: string }[] = []) => ({
    ruleId: 'r1', kind: 'invite', mode: 'test' as const, config: '{}',
    terms: [], allowlist: [], inviteAllowlist: allowlist, linkDomains: [],
  });

  it.each([
    ['discord.gg/abc123', 'abc123'],
    ['https://discord.gg/abc123', 'abc123'],
    ['http://www.discord.gg/abc123', 'abc123'],
    ['https://discord.com/invite/abc123', 'abc123'],
    ['https://discordapp.com/invite/abc123', 'abc123'],
    ['https://discord.com/invite/a-vanity-name', 'a-vanity-name'],
  ])('detects %s', (text, code) => {
    const match = compile(rule()).evaluate(message(`join us at ${text} today`));
    expect(match?.snippet).toContain(code);
  });

  it('does not fire on an allowlisted code', () => {
    const match = compile(rule([{ code: 'clubhouse', label: 'our own server' }]))
      .evaluate(message('come to discord.gg/clubhouse'));
    expect(match).toBeUndefined();
  });

  it('fires on the one code that is not allowlisted', () => {
    // The ambiguity: two invites in one message, one allowlisted. An
    // implementation that checked only the first invite, or that allowlisted
    // the whole message when any code matched, goes red here. A
    // single-invite fixture could not tell those apart.
    const match = compile(rule([{ code: 'clubhouse', label: 'our own server' }]))
      .evaluate(message('ours is discord.gg/clubhouse but also try discord.gg/spamserver'));
    expect(match?.trace.matchedOn).toBe('spamserver');
  });

  it('matches an allowlisted code case-insensitively', () => {
    expect(
      compile(rule([{ code: 'ClubHouse', label: 'ours' }]))
        .evaluate(message('discord.gg/clubhouse')),
    ).toBeUndefined();
  });

  it('does not fire on ordinary text mentioning discord', () => {
    expect(compile(rule()).evaluate(message('we use discord for meetings'))).toBeUndefined();
  });

  it('reports how many codes were allowlisted, so a reviewer can see the list worked', () => {
    const match = compile(rule([{ code: 'clubhouse', label: 'ours' }]))
      .evaluate(message('discord.gg/clubhouse and discord.gg/other'));
    expect(match?.trace.detail.allowlistSize).toBe(1);
  });
});
```

- [ ] **Step 2: Run and watch fail.** Expected: no such module.

- [ ] **Step 3: Implement it**

```ts
import { z } from 'zod';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

/**
 * Anything invite-shaped: `discord.gg/CODE`, `discord.com/invite/CODE`, and
 * the legacy `discordapp.com` host, with or without a scheme or `www.`.
 *
 * Written to be linear — no nested quantifier, no alternation inside a
 * repetition — because this runs on every message and, unlike the `regex`
 * predicate, it is not behind the `node:vm` timeout. A catastrophic pattern
 * here would be this project's own doing rather than an operator's.
 *
 * `[\w-]{2,64}` is deliberately loose about what a code looks like: Discord
 * vanity URLs allow hyphens, and being generous here costs a false positive
 * that the allowlist resolves in one click, where being strict costs a
 * missed invite. That trade is the spec's, not this file's.
 */
const INVITE =
  /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([\w-]{2,64})/gi;

export const inviteConfig = z.object({}).strict();
export type InviteConfig = z.infer<typeof inviteConfig>;

/**
 * `invite` — pattern matching only, no resolution (spec section 3, Slice 3,
 * and CLAUDE.md rule 8: resolving a code to a guild id is an outbound API
 * call, and the owner chose not to authorise one).
 *
 * **The known failure mode, designed for rather than hoped away.** Pattern
 * matching cannot tell which server a code points at, so when a partner
 * rotates their invite their new code is not on the list and this fires on a
 * legitimate message. It surfaces as exactly one false positive in the
 * Slice 9 review queue, whose suppression for this predicate is "add this
 * code to the allowlist" — one click, and the loop closes.
 */
export const invitePredicate: Predicate<InviteConfig> = {
  kind: 'invite',
  config: inviteConfig,
  compile(rule: AutomodRule): CompiledPredicate {
    // Lower-cased once at compile time, not per message: the allowlist is
    // per-rule and the message is not.
    const allowed = new Set(rule.inviteAllowlist.map((entry) => entry.code.toLowerCase()));

    return {
      evaluate(input) {
        // `matchAll` rather than a shared `exec` loop: INVITE carries the `g`
        // flag, and a module-level regex with `g` reused across calls keeps
        // `lastIndex` between them — the hazard plan ruling PR-13 refuses in
        // the `regex` predicate's own config. `matchAll` requires `g` and
        // does not leak `lastIndex` back to the pattern, which is why it is
        // safe here where a bare `.test()` would not be.
        for (const found of input.content.matchAll(INVITE)) {
          const code = found[1];
          if (code === undefined) continue;
          // Every invite in the message is checked, not just the first: a
          // message pairing the club's own invite with a spam one is the
          // case that matters, and stopping at the first would clear it.
          if (allowed.has(code.toLowerCase())) continue;

          return {
            categoryId: 'invite',
            snippet: found[0],
            trace: {
              kind: 'invite',
              // The code, which is what Slice 9's one-click suppression adds
              // to the allowlist (ruling R-8: matchedOn is the thing a
              // reviewer acts on).
              matchedOn: code,
              span: [found.index, found.index + found[0].length],
              normalisations: ['zero-width stripped'],
              detail: { code, allowlistSize: rule.inviteAllowlist.length },
            },
          };
        }
        return undefined;
      },
    };
  },
};
```

- [ ] **Step 4: Register, run, break**

Add `invite: invitePredicate`. Run the tests.

Watch one guard fail: change the loop to `return` on the first invite
regardless of the allowlist, and confirm "fires on the one code that is not
allowlisted" goes red. Restore. Report it.

- [ ] **Step 5: Gates and commit** (same pattern as the earlier tasks)

---

### Task 8: the `link_domain` predicate

**Files:**
- Create: `packages/core/src/automod/predicates/link-domain.ts` + `.test.ts`
- Modify: `packages/core/src/automod/predicates/registry.ts`

**Interfaces:**
- Consumes: Task 6's `AutomodRule.linkDomains`.
- Produces: `linkDomainPredicate: Predicate<LinkDomainConfig>`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('the link_domain predicate', () => {
  const rule = (domains: { domain: string; listType: 'allow' | 'deny' }[]) => ({
    ruleId: 'r1', kind: 'link_domain', mode: 'test' as const,
    config: '{"mode":"deny"}',
    terms: [], allowlist: [], inviteAllowlist: [], linkDomains: domains,
  });

  it('fires on a denied domain', () => {
    const match = compile(rule([{ domain: 'example.com', listType: 'deny' }]))
      .evaluate(message('look at https://example.com/thing'));
    expect(match?.trace.matchedOn).toBe('example.com');
  });

  it('fires on a subdomain of a denied domain', () => {
    expect(
      compile(rule([{ domain: 'example.com', listType: 'deny' }]))
        .evaluate(message('https://tracking.example.com/x')),
    ).toBeDefined();
  });

  it('does not fire on a domain that merely ends with the same letters', () => {
    // The ambiguity plan ruling PR-15 turns on: 'notexample.com' ends with
    // 'example.com' as a STRING. A suffix check on raw text passes the two
    // tests above and fails this one, which is why all three are here.
    expect(
      compile(rule([{ domain: 'example.com', listType: 'deny' }]))
        .evaluate(message('https://notexample.com/x')),
    ).toBeUndefined();
  });

  it('ignores port, credentials and case', () => {
    expect(
      compile(rule([{ domain: 'example.com', listType: 'deny' }]))
        .evaluate(message('https://user:pw@EXAMPLE.com:8443/x')),
    ).toBeDefined();
  });

  it('in allow mode, fires on anything not on the list', () => {
    const allowOnly = {
      ...rule([{ domain: 'club.org', listType: 'allow' }]),
      config: '{"mode":"allow"}',
    };
    expect(compile(allowOnly).evaluate(message('https://club.org/notes'))).toBeUndefined();
    expect(compile(allowOnly).evaluate(message('https://elsewhere.net/x'))).toBeDefined();
  });

  it('does not fire on a message with no links', () => {
    expect(
      compile(rule([{ domain: 'example.com', listType: 'deny' }]))
        .evaluate(message('no links here, just talk about example.com in passing')),
    ).toBeUndefined();
  });

  it('finds the denied link when an allowed one comes first', () => {
    // Two links, only the second denied: an implementation checking only the
    // first link goes red.
    expect(
      compile(rule([{ domain: 'bad.example', listType: 'deny' }]))
        .evaluate(message('https://club.org/a and https://bad.example/b')),
    ).toBeDefined();
  });
});
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement it**

```ts
import { z } from 'zod';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

/**
 * URL-shaped text. Linear by construction — a character class with a single
 * quantifier, no nesting — because this runs on every message outside the
 * `regex` predicate's timeout.
 *
 * Scheme-ful URLs and bare `www.` hosts only. A bare `example.com` in prose
 * is deliberately not a link: Discord does not linkify it either, and
 * treating every dotted word as a URL is a false-positive machine in a
 * predicate whose whole job is precision.
 */
const URL_LIKE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

export const linkDomainConfig = z
  .object({
    /**
     * `deny` fires on a link whose host is on the deny list. `allow` fires on
     * a link whose host is on neither list — a whitelist for a locked-down
     * channel. Explicit rather than inferred from which rows exist, because
     * inferring it would make deleting the last allow row silently change
     * the rule from a whitelist into a no-op.
     */
    mode: z.enum(['allow', 'deny']),
  })
  .strict();

export type LinkDomainConfig = z.infer<typeof linkDomainConfig>;

/**
 * Label-wise suffix match (plan ruling PR-15): `example.com` matches
 * `example.com` and `gist.example.com`, but not `notexample.com`.
 *
 * Comparing labels rather than raw strings is the whole point — a
 * `host.endsWith(entry)` check says true for `notexample.com`, which is a
 * domain someone else owns.
 */
const hostMatches = (host: string, entry: string): boolean => {
  if (host === entry) return true;
  return host.endsWith(`.${entry}`);
};

export const linkDomainPredicate: Predicate<LinkDomainConfig> = {
  kind: 'link_domain',
  config: linkDomainConfig,
  compile(rule: AutomodRule, config: LinkDomainConfig): CompiledPredicate {
    const listed = rule.linkDomains
      .filter((entry) => entry.listType === config.mode)
      .map((entry) => entry.domain.toLowerCase());

    return {
      evaluate(input) {
        for (const found of input.content.matchAll(URL_LIKE)) {
          const text = found[0];
          let host: string;
          try {
            // `new URL` does the normalisation this predicate would
            // otherwise get wrong by hand: it lower-cases the host and
            // strips the port and any userinfo. Verified on this Node:
            // 'https://user:pw@example.com:8443/x' -> 'example.com'.
            host = new URL(text.startsWith('www.') ? `https://${text}` : text).hostname;
          } catch {
            // Not a URL after all. A message is not malformed for containing
            // 'https://' in prose, so this is a skip, not an error.
            continue;
          }
          const onList = listed.some((entry) => hostMatches(host, entry));
          // deny: fires when the host IS listed. allow: fires when it is not.
          if (config.mode === 'deny' ? !onList : onList) continue;

          return {
            categoryId: 'link_domain',
            snippet: text,
            trace: {
              kind: 'link_domain',
              // The host, which is what an operator adds to a list — not the
              // whole URL, which would never be a list entry (ruling R-8).
              matchedOn: host,
              span: [found.index, found.index + text.length],
              normalisations: ['zero-width stripped'],
              detail: { host, mode: config.mode, listSize: listed.length },
            },
          };
        }
        return undefined;
      },
    };
  },
};
```

- [ ] **Step 4: Register, run, break**

Add `link_domain: linkDomainPredicate`. Run the tests.

Watch one guard fail: replace `hostMatches` with `host.endsWith(entry)` and
confirm the `notexample.com` test goes red while the subdomain test stays
green. Restore. Report it.

- [ ] **Step 5: Gates and commit**

Run: `npm run typecheck && npm run lint && npm run test`

Then confirm, and put in your report: `predicateFor` now returns a predicate
for **seven** of the ten kinds, and the three absent ones are exactly
`mention_spam`, `rapid_spam` and `duplicate_message` — Slice 4's window tier.

---

## Self-review — spec coverage

| Spec requirement | Task |
| --- | --- |
| `regex`: compile-time validity check | 3 (`compile-failed` via `new RegExp`) |
| `regex`: length cap | 3 (`.max(1_000)`) |
| `regex`: execution timeout | 3 (`node:vm`, PR-10/11) |
| §4 gate: ReDoS test with a catastrophic pattern | 3 |
| `invite`: pattern matching only, no resolution | 7 |
| `invite`: allowlist with a human label | 6 (table), 7 (predicate) |
| `invite`: allowlist is relational, not JSON | 6 |
| `invite`: last-matched timestamp | **deferred, PR-14** — flag to owner |
| `link_domain`: URL extraction plus allow/deny | 8 |
| `link_domain`: no fetching, resolution or DNS | 8 |
| `caps`: minimum-length floor | 4 |
| `attachment_type`: content type **and** extension | 5 |
| `emoji`: count | 4 |
| OD-3: additive attachment columns | 1 |
| OD-3: `captureObservedFixture` records them | 1, 2 |
| OD-3: `PRIVACY.md` line, same commit as migration | 1 |
| OD-3: `/forgetme` cascade proven by test | 1 |
| OD-3: `predicateInputFrom` reconstructs them | 2 |
| Obligation 1: the ReDoS gate | 3 |
| Obligation 2: relational lists reach the fingerprint | 6 |
| Obligation 3: widen the one-code-path gate | 5 |
| Obligation 4: break every guard and watch it fail | all |

**Known gap, deliberate and recorded:** `invite`'s `last_matched_at`
(PR-14). Nothing else in the spec's Slice 3 or Slice 5 is unimplemented by
this plan.

**Not in this plan, by design:** `mention_spam`, `rapid_spam` and
`duplicate_message` are Slice 4; `cutover_state`, `counts_as_violation` and
the tiered false-positive gate are Slice 6.
