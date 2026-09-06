# Review — Slices 3+5 plan (`2026-09-02-slices-3-5-stateless-predicates.md`) against the spec

Reviewed against: `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`
§3 (Slices 3, 5) and §4; `docs/reports/release2-slices-3-5-handoff.md`; `CLAUDE.md`;
and the current state of `packages/core/src/automod/predicates/{types,registry,keyword-filter}.ts`,
`packages/core/src/automod/{evaluate,fingerprint,dry-run,subscriber}.ts`,
`packages/storage/src/repos/{automod-fixtures,automod-rules}.ts`, `packages/storage/src/schema.ts`.

No code was written or edited. Library claims were checked against `node_modules`
and with one-line `node -e` probes (not against the "Verified environment facts"
table, which was taken as given).

## Verdict: EXECUTE-WITH-FIXES

The architecture, the six predicates' designs, the OD-3 child table, and the
relational-list split are all sound and match the spec and the handoff's
obligations. There is one real sequencing defect that will break the stated
execution order, and one decorative guard beyond the one the plan discloses.
Both are narrow and fixable before dispatch; neither calls the plan's
architecture into question.

## Blocking (1)

### B1 — Tasks 3 and 5 use `AutomodRule` fields that do not exist until Task 6

**Location:** Task 3, Step 1 (plan lines ~806–817, the `rule` helper in
`regex.test.ts`); Task 5, Step 4 (plan lines ~1604–1608, the `rule` literal
added to `dry-run.test.ts`).

**What is wrong.** Both helpers construct an object annotated as `AutomodRule`
that includes `inviteAllowlist: []` and `linkDomains: []`:

```ts
const rule = (config: string): AutomodRule => ({
  ruleId: 'r1', kind: 'regex', mode: 'test', config,
  terms: [], allowlist: [], inviteAllowlist: [], linkDomains: [],
});
```

`AutomodRule` (`packages/core/src/automod/predicates/types.ts`, current state)
has only six fields: `ruleId`, `kind`, `mode`, `config`, `terms`, `allowlist`.
`inviteAllowlist`/`linkDomains` are added only in **Task 6, Step 6**. The
plan's own "Task order and dispatch batching" table sequences dispatch B
(Tasks 3, 4) *before* dispatch C (Tasks 5, 6), and within dispatch C lists
Task 5 before Task 6. Under that order, when Task 3's test file is written,
and again when Task 5's is, `AutomodRule` does not yet have those two fields.
TypeScript's excess-property check on a directly-annotated object literal
rejects this outright — confirmed against the live `zod`/`AutomodRule` shapes
in this worktree, not asserted from memory:

```
excess rejected: unrecognized_keys   // analogous check, same mechanism class
```

`npm run typecheck` fails the moment Task 3 (or Task 5, if run before Task 6)
is implemented as written. This is not a subtle logic bug; it is the plan's
own literal code disagreeing with its own stated dispatch order.

**The correction.** Either:

- Reorder the dispatch table so Task 6's schema/type work (or at least Step 6,
  the `AutomodRule` widening) lands before Tasks 3 and 5, or
- Strip `inviteAllowlist: []` / `linkDomains: []` from Task 3's and Task 5's
  literals as written, and add an explicit fixup step to Task 6 — mirroring
  Task 2, Step 6's pattern exactly ("every other construction ... now fails to
  typecheck ... fix them, and report how many you had to touch") — so Task 6
  is the one place that both adds the fields and repairs every literal that
  predates them, including Task 3's and Task 5's.

Either fix is a few lines; the point is that the plan as sequenced does not
compile at the task boundary it names, and an implementer following it
literally will burn a cycle discovering that mid-task rather than being told
up front.

## Decorative guards (1 found beyond the one the plan discloses)

### D1 — Task 3, Step 1: "points the span at the occurrence that actually matched"

```ts
const compiled = compileRule(rule('{"pattern":"n[o0]w"}'));
const content = 'now or n0w';
const match = compiled.compiled.evaluate(message(content));
expect(match?.trace.span).toEqual([0, 3]);
```

The test's own comment claims this catches an implementation that computes
the span with `content.indexOf(matchedText)` instead of the regex engine's
`found.index`. It does not. The two alternatives in the pattern (`now` vs
`n0w`) are two *different* literal strings, each occurring exactly once in
`content`. A leftmost-match regex always returns `'now'` at index 0 here —
and `content.indexOf('now')` also returns 0. The buggy and correct
implementations produce the identical span, so this test cannot go red for
the bug it is named after; it is provably true of any messages that were
checked, but that is exactly the input-too-simple-to-reach-the-branch shape.

**Fix — a fixture where the matched literal repeats and the true match is not
the first occurrence of that substring:**

```ts
const compiled = compileRule(rule('{"pattern":"\\\\bcat\\\\b"}'));
const content = 'concatenate a cat';
const match = compiled.compiled.evaluate(message(content));
expect(match?.trace.span).toEqual([14, 17]); // the real word "cat"
```

Verified with a probe in this worktree: `content.indexOf('cat')` is `3` (the
`cat` embedded in `concatenate`), while `/\bcat\b/.exec(content).index` is
`14` (the real word). An `indexOf`-based implementation now produces a
different, wrong span, and the correct one does not — the fixture the test
needs and did not have.

The plan's disclosed deliberate defect (Task 1, Step 5, the attachment
ordering) is real and was reported as instructed; it is not counted here.

## Non-blocking

1. **Tech Stack line says "Zod 3.24"; the installed version is 3.25.76**
   (`node_modules/zod/package.json`). Not in the "Verified environment facts"
   table (which is about `node:vm`, `Intl.Segmenter`, `URL`, not Zod), so it
   is a stated fact rather than a probed one, and it is stale. Behaviour used
   by the plan (`.strict()`, `.refine()`, `.default()` chaining) was checked
   against 3.25.76 directly and works as the plan assumes — the version
   number is wrong, not the reliance on it.

2. **PR-16's framing of `attachment_type`'s one-click suppression is in slight
   tension with the spec's own tier description.** The spec's Slice 9 section
   says the shape tier's suppression is "a raised threshold or a role/channel
   exemption," but `attachment_type` has no numeric threshold to raise — its
   only sensible one-click suppression is removing the offending extension or
   content type from the list, which is closer to the precise tier's "narrow
   the pattern or domain" shape. PR-16's conclusion (JSON config, not
   relational) still holds on its own terms — editing a JSON array is a list
   edit regardless of storage shape, so the relational-vs-JSON choice does not
   change what Slice 9 can build — but Slice 9's implementer will need to know
   this predicate doesn't fit the tier-level generalisation the spec gives.
   Worth one sentence in PR-16 or the ledger saying so, not a plan change.

3. **PR-14 was argued as instructed and holds.** The two costed alternatives
   (a DB write on the predicate's hot path, or widening
   `CompiledPredicate.evaluate`'s return type for every predicate so a
   non-match can carry an observation) are genuinely exhaustive given the
   current interface: an allowlisted invite is a *non-match* by construction,
   so there is no existing side channel — not even `recordCaseEvent`, which
   only ever fires for an actual match — through which `last_matched_at`
   could be updated without one of those two costs. No third option found.

4. **`caps`'s three named false-positive sources are only two-thirds
   addressed, and the plan says so without noticing the gap is a gap.**
   PR-17's own text: "Stripping code spans directly addresses one of the
   three false-positive sources the spec names ... the minimum-length floor
   ... addresses the second." The spec names three: acronyms, short messages,
   code snippets. Nothing in Task 4 specifically addresses acronyms, and
   nothing flags the omission to the owner the way PR-14 flags the
   `last_matched_at` deferral. In practice the ratio-over-letters measure
   likely suppresses most acronym false positives incidentally (an acronym
   embedded in ordinary lower-case prose does not move the ratio much), but
   that is an argument the plan does not make. Worth a sentence in PR-17
   saying why acronyms are believed covered incidentally, or an explicit
   owner flag if they are not.

5. **Task 4 does not define the `compile`/`message` test helpers its own code
   blocks call.** Task 3 defines `rule`/`message` inline in `regex.test.ts`;
   Task 4's `caps.test.ts`/`emoji.test.ts` call `compile(...)`/`message(...)`
   without ever showing where they come from, and they cannot import Task
   3's (file-local, unexported). Not a correctness defect — the implementer
   will write reasonable equivalents — but it is a gap the plan should not
   have needed to leave for two of eight new test files.

6. **`link_domain`'s `URL_LIKE` extraction has an unhandled trailing-punctuation
   case.** `/\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi` will swallow a trailing
   sentence-ending period into the URL — `'see https://example.com.'` parses
   to hostname `'example.com.'`, which matches neither `example.com` (not
   equal) nor `.example.com` (wrong suffix) under `hostMatches`. This is a
   false-negative in ordinary prose (a denied domain quoted at the end of a
   sentence slips through), not a false-positive, so it is the safe-direction
   failure — but it is untested in either direction and worth one fixture
   (`'blocked at https://example.com.'` should still match `example.com`) if
   the owner cares about that gap in Slice 3 rather than leaving it for the
   observe window to surface.

## Verified clean

- **Self-review table.** Walked every row in the plan's "Self-review — spec
  coverage" table against §3 Slices 3/5 and §4's gates. Every spec bullet has
  a task; the task assignments are accurate (checked against the actual task
  contents, not just the table's say-so). The one named gap (`invite`'s
  `last_matched_at`, PR-14) is real, is the only gap, and is flagged to the
  owner as the plan says.
- **The ReDoS gate (obligation 1).** Task 3's timeout test and its
  "break it and watch it hang" step are correctly wired to the module's own
  `REGEX_TIMEOUT_MS` constant and to `vm.Script.runInContext`'s documented
  timeout behaviour, consistent with the "Verified environment facts" table.
- **Relational lists reach the fingerprint (obligation 2).** `fingerprint.ts`
  is genuinely exclusion-based (`Object.keys(record).sort()` minus
  `EXCLUDED_FIELDS`), confirmed by reading the live file — a field added to
  `AutomodRule` and never mentioned in `fingerprint.ts` is hashed by default.
  Task 6's "add `EXCLUDED_FIELDS` and watch the guard fail" step is a real
  test of a real mechanism, not a tautology.
- **Widening the one-code-path gate (obligation 3).** Confirmed against the
  live `dry-run.test.ts` and `evaluate.ts` that the existing gate is exactly
  the behavioural comparison the handoff describes, and that it is blind to
  `attachments` today because `keyword_filter` never reads that field and the
  fixture branch hard-codes `attachments: []`. Task 5's new test genuinely
  exercises the previously-invisible field once `attachment_type` reads it,
  and the plan's "restore `attachments: []` and watch only the new test go
  red" step is a correct, falsifiable check of the widening.
- **OD-3 mechanics.** `automodFixtures`' existing conventions
  (`snowflake`/`snowflakeCheck`, composite PK, `CHECK` naming, cascade FK to
  `guilds`) match the new `automodFixtureAttachments` table's shape exactly.
  `deleteObservedFixturesForMember`'s existing `source = 'observed'` filter
  and the CASCADE FK correctly compose to make Task 1's cascade tests
  meaningful — deleting a parent row via that function will cascade the
  child rows, and `foreign_keys` is confirmed `ON` in both `db.ts` and
  `test-support.ts`.
- **`MessageAttachment` / `FixtureAttachment` field-for-field identity.**
  Confirmed against `packages/core/src/discord/events.ts`: `fileName`,
  `contentType: string | undefined`, `sizeBytes` on both sides — the
  pass-through claim in Task 2 is true, not asserted.
- **Library claims beyond the verified table.**
  - `drizzle-orm@0.45.2`'s `onConflictDoNothing({ target })` accepts an
    `IndexColumn[]`, matching the plan's three-column composite target for
    the new child table and the two-column targets for the list tables.
  - `matchAll` on a `g`-flagged regex does **not** mutate the shared
    `RegExp.lastIndex` across calls (probed: three sequential `matchAll`
    calls on the same module-level `/a/g` left `lastIndex` at 0 throughout).
    This is the exact claim `invite.ts`'s and `link-domain.ts`'s comments
    make to justify reusing a `g`-flagged pattern despite PR-13 refusing `g`
    in the *operator-configured* `regex` predicate — the two are not
    contradictory, and the comment correctly explains why.
  - `Intl.Segmenter` + the pictographic/regional-indicator/keycap union
    correctly scores the ZWJ family (3), the flags-and-keycaps message (4),
    and a bare `#️⃣` (1) — probed directly against the plan's exact predicate
    logic, not just the underlying primitives.
  - `zod@3.25.76`'s `.strict().refine(...)` chain parses and rejects excess
    keys as the plan's config schemas assume.
- **Hard rules.** Every new repository function takes `GuildScope` first and
  every new table carries `guild_id` with a `snowflakeCheck` (rule 2). Every
  new `mod_rules.config` shape gets a `.strict()` Zod schema validated by the
  existing write/read paths in `registry.ts` (rule 3). Nothing in this slice
  calls a provider (rule 1). `invite` and `link_domain` are confirmed
  pattern-only with no fetch/DNS (rule 8, rule 4's CLAUDE.md instruction).
  No new dependency is introduced — `node:vm` and `Intl.Segmenter` are
  already in Node 22, confirmed by `node -e` requiring nothing extra. No new
  field reaches a logger call the predicates or `evaluate.ts` add — the
  subscriber's existing log calls (`ruleId`, `outcome`, `compileError`, `err`)
  are unchanged by this plan, so `LOGGABLE_FIELDS` needs no new entry.
- **Name/type collisions.** `FixtureAttachment` vs `MessageAttachment`: no
  collision, deliberate parallel declaration per ADR 0014, verified
  identical in shape. The six new `Predicate` exports
  (`regexPredicate`, `capsPredicate`, `emojiPredicate`,
  `attachmentTypePredicate`, `invitePredicate`, `linkDomainPredicate`) map
  1:1 onto `RULE_KINDS`/registry keys with no name reuse. The new repository
  file `automod-rule-lists.ts` does not collide with the existing
  `automod-rules.ts`.
- **Migration hygiene.** Both new-table tasks (1 and 6) instruct reading the
  generated SQL for `__new_`/`DROP`/`RENAME` before proceeding, matching the
  R-5 hazard record; the table definitions as written are pure `CREATE TABLE`
  with no rebuild trigger (no column type change, no constraint change on an
  existing table).
