# Dispatch B report — Task 6: the relational lists and the `AutomodRule` widening

## What was implemented

- Two new tables in `packages/storage/src/schema.ts`: `automodInviteAllowlist`
  (`automod_invite_allowlist`) and `automodLinkDomains`
  (`automod_link_domains`), both with composite `(guild_id, rule_id, ...)`
  primary keys, a composite FK to `mod_rules(guild_id, rule_id)` with
  `ON DELETE CASCADE`, and the guild-id snowflake CHECK every table here
  carries. `automod_link_domains` also carries a `list_type IN ('allow',
  'deny')` CHECK.
- Generated migration `drizzle/0014_lethal_xorn.sql` via `npm run db:generate`.
- New repository `packages/storage/src/repos/automod-rule-lists.ts`:
  `listInviteAllowlist`, `addInviteAllowlistEntry`,
  `removeInviteAllowlistEntry`, `listLinkDomains`, `addLinkDomain` (lower-cases
  and strips a leading `www.`), `removeLinkDomain`. Follows
  `automod-fixtures.ts`'s conventions: `GuildScope` first, every query through
  `scope.only(...)`, `onConflictDoNothing` targeted at the primary key.
- `StoredAutomodRule` (`packages/storage/src/repos/automod-rules.ts`) gained
  `inviteAllowlist: readonly InviteAllowlistEntry[]` and
  `linkDomains: readonly LinkDomainEntry[]`. `hydrate` now queries both tables
  unconditionally (no branch on `kind`), ordered by `code`/`domain`
  respectively, beside the existing `terms`/`allowlist` queries.
- `core`'s `AutomodRule` (`packages/core/src/automod/predicates/types.ts`)
  gained the same two fields, in the exact shape named by the brief:
  `inviteAllowlist: readonly { code: string; label: string }[]` and
  `linkDomains: readonly { domain: string; listType: 'allow' | 'deny' }[]`,
  re-declared rather than imported (ADR 0014).
- `fingerprint.ts`'s `canonicalise` gained sort cases for both new keys
  (`inviteAllowlist` sorted by `[code, label]`, `linkDomains` sorted by
  `[domain, listType]` — `listType` is part of the sort key, not just carried
  along, so a domain moving allow→deny at the same position produces a
  different canonical structure).

I did not rename the two field names — they match the brief's contract
exactly, since four other Task 6-dependent test files reference them.

## The fingerprint guard (obligation 2) — the important paragraph

Added `'inviteAllowlist'` to `EXCLUDED_FIELDS` in `fingerprint.ts` and ran
`npx vitest run packages/core/src/automod/fingerprint.test.ts`.

**It went red.** Two tests failed:
- `an invite allowlist edit changes the fingerprint` — both digests came back
  identical (`f69fed52ce...`) instead of different.
- `a label edit changes the fingerprint too` — same failure, same reason.

Restored `EXCLUDED_FIELDS` to `['ruleId', 'mode']`, re-ran the same file: all
17 tests passed. The guard is not decorative — excluding the field visibly
breaks the exact property obligation 2 exists to guarantee, and the fix
restores it.

I also added the four fingerprint tests from the plan's Step 1 verbatim
(adapted to this file's existing `rule(over)` helper rather than a `ruleWith`
free function, since that helper already exists and does the same job) before
running the break/restore cycle above, so the guard I watched fail is the
same one now shipping.

## The hydration guard

Added a new test to `packages/storage/src/repos/automod-rules.test.ts`:
`"keeps each rule's invite allowlist and link domains to itself"` — two rules
(`inv1` with one invite-allowlist entry, `link1` with one link-domain entry),
asserting each rule's *other* list comes back empty.

To watch it fail, I dropped the `eq(automodInviteAllowlist.ruleId, row.ruleId)`
/ `eq(automodLinkDomains.ruleId, row.ruleId)` predicates from `hydrate`'s two
new queries (kept only `scope.only(table)`, i.e. guild scope with no rule
predicate).

**It went red**: `linkRule.inviteAllowlist` was expected `[]` but
`inviteRule.linkDomains` came back `[{ domain: 'example.com', listType:
'deny' }]` — the link-domain row leaked onto the invite rule, exactly the
`docs/22` shape (a fixture too simple to reach the branch, avoided here by
using two rules that both have entries). Restored the `eq(...ruleId...)`
predicates; the full `automod-rules.test.ts` suite (16 tests) passed again.

## The migration

`drizzle/0014_lethal_xorn.sql`. Read in full: two pure `CREATE TABLE`
statements (`automod_invite_allowlist`, `automod_link_domains`), both with
`STRICT` appended by `strictify.mjs`, both with the composite FK to
`mod_rules(guild_id, rule_id) ... ON DELETE cascade`. No `__new_` table, no
`DROP TABLE`, no `RENAME` — no rebuild.

## Pre-existing construction sites touched

`npm run typecheck` found **8 files** whose `AutomodRule` literals needed the
two new required fields added (none needed touching for `StoredAutomodRule`,
since that interface's only literal-construction sites are inside
`automod-rules.ts` itself):

1. `packages/core/src/automod/dry-run.test.ts` — `ruleWith` helper.
2. `packages/core/src/automod/evaluate.test.ts` — `ruleWith` helper.
3. `packages/core/src/automod/fingerprint.test.ts` — `rule` helper (plus a
   pre-existing test discussed below).
4. `packages/core/src/automod/predicates/keyword-filter.test.ts` — `rule`
   helper.
5. `packages/core/src/automod/predicates/registry.test.ts` — `rule` helper.
6. `packages/core/src/automod/subscriber.test.ts` — `rule` helper (`ruleWith`
   in the same file delegates to it, so one fix covered both).
7. `packages/core/src/ops/commands/automod.test.ts` — `ruleWith` helper.

That's 7 distinct helper functions across 6 files (subscriber.test.ts has one
helper delegating to another), plus fingerprint.test.ts's own `rule` helper
already counted in item 3 — 7 files total needed a fix, matching the 7 error
lines `tsc` produced on the first pass. All were the same one-line fix:
`inviteAllowlist: [], linkDomains: [],` added to the object literal's
defaults, mirroring how `allowlist: []` was already there for `keyword_filter`
fixtures of every other kind.

Real (non-test) production call sites needed **no changes**:
`apps/daemon/src/automod/wiring.ts`'s `listRules: () =>
automodRuleRepo.listEnabledRules(scope)` and `apps/daemon/src/ops/wiring.ts`'s
`findAutomodRule`/`listUnusableAutomodRules` all consume `StoredAutomodRule`
structurally through `listEnabledRules`, and since `StoredAutomodRule` itself
gained the two fields in `hydrate`, they satisfy `AutomodRule` automatically.

## A pre-existing test whose premise Task 6 made stale

`fingerprint.test.ts`'s `"changes when a field is added to the rule that the
digest does not name"` test used `inviteAllowlist` as its example of "a field
`AutomodRule`'s type does not have yet" — true when that test was written
(before Task 6), false now that Task 6 has landed the field for real. Left
unfixed, the test would still pass (a 1-element vs. 0-element array still
produces different digests, incidentally, regardless of the field's declared
element type), so `npm run typecheck`/`npm run test` would not have caught the
staleness — only reading the comment against the current type would. I
renamed the example field to `aFieldNoVersionOfAutomodRuleHasEverNamed` and
rewrote the comment to say why, rather than leaving a load-bearing comment
that is now factually wrong (Global Constraint 11).

## Things I did not change, flagged rather than fixed

- The plan's Task 6 file list doesn't mention updating any *production*
  (non-test) call site beyond `automod-rules.ts`, `types.ts`, and
  `fingerprint.ts`. That held exactly — no other production file needed a
  change, unlike dispatch A's nine call sites for a different reason (an
  `AutomodRule`/`StoredAutomodRule` literal only appears in test fixtures and
  in `hydrate` itself; every real caller consumes the interface structurally).
- I did not add `last_matched_at` to either table, per plan ruling PR-14 and
  the brief's explicit instruction. Not restored.
- `listInviteAllowlist`/`listLinkDomains`/`addInviteAllowlistEntry`/etc. are
  written but **nothing in this dispatch calls them yet** — no CLI command,
  no ops port. That's expected: Task 6's brief scopes this to "the two tables,
  the repository, the hydration, the `AutomodRule` fields, and the
  fingerprint," and wiring an operator-facing add/remove command is not named
  here or in Tasks 7/8 as far as I read them. Flagging in case the coordinator
  expected write commands wired into `packages/core/src/ops/commands/` in this
  dispatch — I read the brief as repository-only and did not add that.

## Gates

```
npm run typecheck && npm run lint && npm run test
```

All three clean. Final count: **2174 tests / 102 files** (baseline 2159/102,
+15: 10 free from `schema-invariants.test.ts` for the two new
guild-partitioned tables, 4 new fingerprint tests from the plan's Step 1, and
1 new hydration test from Step 8).
