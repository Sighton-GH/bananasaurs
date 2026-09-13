# 0049 — The FTS5 index is hand-written SQL, and earns a named exemption from the schema invariants

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
