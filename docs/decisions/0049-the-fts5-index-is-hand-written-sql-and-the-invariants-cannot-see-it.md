# 0049 — The FTS5 index is hand-written SQL, and the schema invariants cannot see it

Status: accepted
Date: 2026-09-13
Precedes Slice M2 of
`docs/superpowers/plans/2026-09-12-mcp-operator-server-plan.md` (design:
`docs/superpowers/specs/2026-09-12-mcp-operator-server-design.md` §7.3).
Depends on ADR 0046 D6 (search is FTS5 with permission-filtered citations),
ADR 0004 (guild scope is a mandatory partition key), ADR 0008 (SQLite via
better-sqlite3, Drizzle + drizzle-kit, FTS5).
Constrained by `CLAUDE.md` rule 2 and by the M-plan's Global constraint 3,
which this ADR amends.

## Context

M2 needs `archive_messages_fts`. Three facts, each verified against this
tree rather than assumed (research run `20260913T153230`):

1. **FTS5 is compiled in.** `better-sqlite3` 13.0.3 reports
   `ENABLE_FTS5` from `PRAGMA compile_options`, and
   `CREATE VIRTUAL TABLE t USING fts5(x)` succeeds. ADR 0046 D6's
   "verify with `PRAGMA compile_options` before relying on it" is
   discharged.
2. **drizzle-kit cannot generate a virtual table.** Its schema source is
   `packages/storage/src/schema.ts`, which has no way to declare one, and
   the project's own post-processor says so out loud:
   `scripts/strictify.mjs:32` — *"Virtual tables (FTS5) cannot be STRICT"* —
   and skips any `CREATE VIRTUAL TABLE` it meets. So the M-plan's Global
   constraint 3, **"`npm run db:generate` is the only way to produce a
   migration. Never hand-write one"**, cannot be satisfied for this table.
3. **The invariants would reject it.** `schema-invariants.test.ts`
   enumerates `PRAGMA table_list`, excludes only `sqlite_*`/`__drizzle_*`
   (`INTERNAL`) and two instance-level tables, and then requires of every
   survivor: `STRICT`, a `guild_id TEXT NOT NULL`, a composite foreign key
   leading with `guild_id`, and a snowflake CHECK. An FTS5 table can satisfy
   none of these, and it brings four shadow tables
   (`_data`, `_idx`, `_docsize`, `_config`) that satisfy fewer.

The invariants exist because ADR 0004 says caller discipline is not a
partition key — the database must make a cross-guild row impossible. An
exemption is therefore not a formality; it removes the one mechanism that
makes rule 2 structural for this table. This ADR records what replaces it.

## Decision

### D1 — M2's migration is hand-written, and that is a bounded exception

`drizzle/00NN_archive_fts.sql` is written by hand: the virtual table, its
three triggers, and nothing else. The M-plan's Global constraint 3 is
amended to read: *"`npm run db:generate` is the only way to produce a
migration for a table declared in `schema.ts`. A virtual table cannot be
declared there; its migration is hand-written, reviewed as code, and must
name this ADR in a comment at the top of the file."* Every other table in
the release still goes through the generator — this is an exception for
SQLite constructs drizzle-kit does not model, not a new habit.

The file carries its own `-- ADR 0049` header, and `schema.ts` gains a
comment beside `archiveMessages` pointing at it, so a reader of the schema
cannot miss that a table exists which the schema does not describe.

### D2 — The FTS table is external-content, keyed on `rowid`, carrying `guild_id`

`archive_messages` is `STRICT` with a composite text primary key and is
**not** `WITHOUT ROWID` (`drizzle/0018_oval_cammi.sql`), so its implicit
integer `rowid` is stable and usable as the external-content key.

```sql
CREATE VIRTUAL TABLE archive_messages_fts USING fts5(
  content,
  guild_id UNINDEXED,
  channel_id UNINDEXED,
  message_id UNINDEXED,
  content='archive_messages',
  content_rowid='rowid'
);
```

`guild_id` is carried as a stored, unindexed column so that **the guild
predicate is part of the SQL**, not a filter applied to results. A query
that omits it is a bug the same way a missing `scope.only` is.

### D3 — Three triggers, and the purge is one of them

`AFTER INSERT`, `AFTER DELETE`, and `AFTER UPDATE OF content` on
`archive_messages`, in the standard external-content shape (delete-then-
insert on update). The `AFTER UPDATE OF content` trigger is what keeps
ADR 0046 D3's promise: `expireContent` purges by
`UPDATE archive_messages SET content = NULL, content_purged_at = ?`
(`packages/storage/src/repos/archive.ts:429`), so the trigger fires and the
text leaves the index in the same transaction as the purge. A row whose
content is purged keeps its tombstone and stays reachable by id; it is
simply no longer findable by its words. **A test asserts exactly that**:
search finds the message, `expireContent` runs, search finds nothing, and
the tombstone is still there.

### D4 — The invariants gain a named exemption, not a widened rule

> **Superseded by Amendment 1 (below): `PRAGMA table_list` reports the FTS
> table as `virtual` and its shadows as `shadow`, which the invariants never
> enumerate, so no exemption is needed. Kept for the record of what was
> reasoned before the SQL was run.**

`schema-invariants.test.ts` gains one exported constant:

```ts
/**
 * Tables that are SQLite virtual-table machinery, not application tables.
 * They cannot be STRICT and cannot carry the composite foreign key (ADR
 * 0049). `archive_messages_fts` carries `guild_id` as a stored column and
 * every query filters on it; the shadow tables are addressable only
 * through the virtual table. Nothing may be added to this set without an
 * ADR.
 */
const VIRTUAL_TABLE_MACHINERY = new Set([
  'archive_messages_fts',
  'archive_messages_fts_data',
  'archive_messages_fts_idx',
  'archive_messages_fts_docsize',
  'archive_messages_fts_config',
]);
```

Two new tests pay for the exemption rather than merely declaring it:

- **The index cannot outlive its content.** Insert rows in two guilds,
  delete one guild's row, assert the FTS row is gone — proving the triggers
  are attached and the external-content contract holds.
- **The exemption set is exhaustive.** Assert that the only tables the
  enumeration skips are `INTERNAL`, `INSTANCE_LEVEL` and
  `VIRTUAL_TABLE_MACHINERY`, so a future virtual table cannot slip in
  unnamed.

### D5 — Guild scope lives in the repository signature and in one query

`searchMessages(scope, { query, channelIds?, authorId?, before?, after?,
limit })` takes `GuildScope` first like every other repository function.
Because the FTS query cannot go through Drizzle's `scope.only`, the
function is the **only** place in the repository that writes raw SQL
against the index, it is short enough to read in one screen, and its
`WHERE` names `guild_id = ?` and the caller's channel set explicitly. A
two-guild test with colliding message ids asserts that a search under guild
A returns neither guild B's hits nor its count.

### D6 — Citations are filtered in SQL, before the count

ADR 0046 D6 and §7.3: the visibility set filters the **citation list**, and
it does so inside the query, so a channel outside the set contributes to
neither the excerpt list nor `COUNT(*)`. For the MCP operator the set is
every archive-enabled channel in the guild; the type is new
(`VisibilitySet` — nothing like it exists in the tree) and is passed, never
defaulted. The leak test the M2 plan opens with — two channels, one
visible, a term in both, assert one hit and one citation — is written
first and watched failing.

## Consequences

- One hand-written migration, reviewed as code, with an ADR reference in
  its first line. `strictify.mjs` already skips virtual tables, so the
  generator's post-processing is unaffected.
- The invariant test gains five exempted names and two tests that make the
  exemption honest. The partition-key guard is weaker for this one table
  than for the other thirty-odd, and that is stated here rather than
  discovered later.
- `searchMessages` is the project's only raw-SQL repository function. It is
  a deliberate, single, reviewable exception — not a precedent for writing
  raw SQL where Drizzle would do.
- FTS5 adds no dependency (compiled into `better-sqlite3`) and no new job
  kind. Rebuilding the index is
  `INSERT INTO archive_messages_fts(archive_messages_fts) VALUES('rebuild')`,
  offered as `archive reindex --confirm` so a restored backup or a changed
  tokeniser has a documented recovery, with its own audit row.

## Rejected

- **A `content='',` (contentless) or fully external index maintained by the
  repository in TypeScript.** It would keep the schema invariants intact,
  but it moves index consistency into caller discipline — exactly what ADR
  0004 rejects — and the purge path would have to remember to delete. The
  triggers are the mechanism that cannot be forgotten.
- **Widening the invariants to "STRICT unless virtual".** A rule that
  exempts a shape exempts every future table of that shape silently. A
  named set with an ADR gate is the same protection with an audit trail.
- **Deferring search to Release 3 to avoid the hand-written migration.**
  The design pulled search forward because the MCP server has nothing to
  read without it (ADR 0046's Context). The constraint that would be
  honoured by deferring is a plan convention; the one that would be broken
  is the owner's decision D1.

## Amendment 1 — 2026-09-13, at M2 planning, after running the SQL rather than reasoning about it

The plan review asked whether `PRAGMA table_list` even reports an FTS5
table as a `table`. It does not, and that unmakes D4. Probe run in the M1
worktree against the installed `better-sqlite3` 13.0.3 (an in-memory
database, the exact table and trigger shapes D2/D3 specify):

```
table_list: src        type=table    strict=1
            src_fts    type=virtual  strict=0
            src_fts_config|_docsize|_idx|_data  type=shadow  strict=0
```

`schema-invariants.test.ts:114-117` keeps only rows with `type === 'table'`.
**The FTS table and all four shadows are therefore already invisible to
every invariant** — STRICT, the partition key, the composite foreign key,
the snowflake CHECKs. No exemption is needed, and the one D4 specifies
would be dead code guarding nothing; the exhaustiveness test it proposed
would have passed vacuously, which is worse than absent.

### D4 (replaced) — no exemption; two positive tests and one guard

`VIRTUAL_TABLE_MACHINERY` is **not** added. Instead
`schema-invariants.test.ts` gains:

- **The machinery is invisible for the reason we think.** A test asserting
  that `PRAGMA table_list` reports `archive_messages_fts` as `virtual` and
  its four shadows as `shadow` — so if a future SQLite reclassifies them
  into `table`, the suite fails loudly and this ADR is revisited, rather
  than the FTS table silently failing STRICT.
- **The index cannot outlive its content** (unchanged from the original
  D4): two guilds with colliding message ids, delete one, assert that
  row's FTS entry is gone and the other's remains.
- **The index carries its partition key.** A test asserting
  `archive_messages_fts` has a `guild_id` column and that a `MATCH` query
  filtered by `guild_id` returns only that guild's rows — the replacement
  for the schema-level guarantee the invariants cannot give a virtual
  table. This is the test that pays for the gap.

The `guildPartitioned()` and STRICT helpers are **not** touched.

### D5 (amended) — the query form, as executed

Three things the probe settled that the plan had only reasoned about:

- **`MATCH` names the table, not the alias.** `FROM archive_messages_fts f
  … WHERE archive_messages_fts MATCH ?` works; `WHERE f MATCH ?` fails with
  `no such column: f`. The aliased form is correct as written.
- **A malformed query throws.** `MATCH '"unbalanced'` raises
  `SqliteError: unterminated string`, so the catch that turns an operator's
  typo into an empty result is load-bearing, not defensive decoration.
- **`ORDER BY rank` and `snippet(archive_messages_fts, 0, …)` work** against
  the column order D2 fixes, and `bm25()` returns a negative score whose
  ascending order is best-first.

### D7 (new) — `findMessage` is M2's, not M1's

M1 ships no by-id reader (`archive.ts` exports no `findMessage` or
`getMessage`). ADR 0046 D6's promise that purged content "remains
reachable by `getMessage`" therefore has nothing to call. M2 adds
`findMessage(scope, messageId): ArchiveMessage | undefined` to
`packages/storage/src/repos/archive.ts` — one `read` with `scope.only`,
returning the row including a NULL `content` and its `contentPurgedAt` —
and the purge test asserts against it: search finds nothing, `findMessage`
still returns the tombstone.

### D1 (clarified) — what the hand-added journal entry contains

The journal stores no hash: `{ idx, version, when, tag, breakpoints }`, and
the migrator computes a hash at read time without ever comparing it.
`when` must be **strictly greater** than the previous entry's, because the
migrator gates on that millisecond — an entry with an equal or smaller
`when` is silently skipped on a database that has already run `0019`, which
would look exactly like the migration working. The M2 entry is therefore
`{ idx: 20, version: "6", when: <now, > 1789337740258>, tag:
"0020_archive_fts", breakpoints: true }`, and a test asserts the journal's
`when` values are strictly increasing.
