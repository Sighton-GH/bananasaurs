# Fix wave B report — `link_domain`'s empty-list hazard, and the list-editing commands

Baseline: 2250 tests / 109 files at `db0e82c`, typecheck and lint clean.
Final: **2265 tests / 109 files**, typecheck and lint clean. No file count
change, no test deleted; net +15 tests (4 in `link-domain.test.ts`, ~11 across
`automod.test.ts` and `automod-rule-lists.test.ts`).

Commits, in order: `1ee9ad9` (CRITICAL-2), `25b0f9b` (MINOR-2), `7d560d9`
(IMPORTANT-1/2/7), `50b10df` (decorative guard 1).

## CRITICAL-2 — `link_domain`'s empty-list hazard

`packages/core/src/automod/predicates/registry.ts`: generalised `compileRule`'s
`no-terms` guard to `link_domain` — refuses to compile when no row on the
rule's `linkDomains` carries the configured `mode`, closing both directions
(deny-mode-never-matches and the dangerous allow-mode-matches-everything).
Detail text is kind-appropriate rather than reused "no enabled terms" wording.
Added a comment explaining why `invite` gets no equivalent guard (its single
list does not invert meaning when empty).

`packages/core/src/automod/predicates/link-domain.ts`: corrected the
load-bearing comment on `mode` — it previously said deleting the last allow
row "would make the rule a no-op"; it actually makes the rule match
everything. Rewrote to state both failure directions correctly and point at
`compileRule`'s guard.

**Guard 2** (`link-domain.test.ts`): added four tests — `compileRule` refusal
in `deny` mode with no deny rows, in `allow` mode with no allow rows, a
mixed-listType case (a `deny` row does not satisfy an `allow`-mode guard), and
a test that calls `linkDomainPredicate.compile` directly (bypassing
`compileRule`) to keep the "matches everything" hazard documented in the suite
rather than only in a comment.

**Watched fail**: stashed the two source-file fixes (keeping the new tests),
ran `link-domain.test.ts` — 3 of 4 new tests went red (`expected true to be
false`, i.e. `compileRule` returned `ok: true` for both empty-list cases and
the mixed-listType case). The fourth (direct-predicate test) stayed green, as
expected — it exercises the predicate, not the guard. Restored the fix, all 14
tests green.

## MINOR-2 — orphaned doc comment in `ports.ts`

Moved `/** Points an event kind at a channel... */` from between
`recordMatchVerdict` and `addInviteAllowlistEntry` down to directly above
`setRoute`, where it belongs. One-line, no test — a doc comment, not
behaviour.

## IMPORTANT-1, IMPORTANT-2, IMPORTANT-7

**Repository (`packages/storage/src/repos/automod-rule-lists.ts`)**:
- Factored `canonicalDomain` (lower-case, strip leading `www.`) into one
  helper both `addLinkDomain` and `removeLinkDomain` call — previously only
  `addLinkDomain` canonicalised (IMPORTANT-2).
- `addLinkDomain` now returns `{domain, inserted}` instead of `void`, using
  the insert's own `.changes` count, so a caller can find the stored row
  without re-deriving the canonical form.
- `removeInviteAllowlistEntry` now matches case-insensitively (SQL `lower()`)
  to mirror the predicate's case-insensitive match, since codes are stored
  case-preserving (IMPORTANT-2's invite mirror).

**`packages/storage/src/repos/automod-rules.ts`**: added
`findRuleKindAndConfig(scope, ruleId)`, returning `{kind, config} | undefined`
regardless of enabled state — the one new query IMPORTANT-7's kind check and
CRITICAL-2's mode-aware messaging both need.

**`packages/core/src/ops/ports.ts`**: `addInviteAllowlistEntry` /
`removeInviteAllowlistEntry` grow a `'wrong-kind'` string outcome.
`addLinkDomain` / `removeLinkDomain` become discriminated-union objects
(`{outcome, mode?, listType?}`) rather than bare strings, so the stored
`listType` and the rule's `config.mode` travel with the outcome instead of
requiring a second port call.

**`apps/daemon/src/ops/wiring.ts`**: all four write ports now call
`findRuleKindAndConfig` first (existence *and* kind, replacing a bare
`ruleExists`). Added `linkDomainModeOf` — a deliberately tolerant (try/catch,
no Zod) reader of `config.mode` for display purposes only. `addLinkDomain`
uses the repository's own `inserted`/`domain` result instead of a before/after
length comparison, then looks up the stored `listType` by the repository's own
canonical domain (no duplicated canonicalisation).

**`packages/core/src/ops/commands/automod.ts`** (touched only the four
list-editing commands, per the brief): added `wrong-kind` branches to all
four (usage answer, still audited, same treatment as `no-such-rule`). Added
`linkDomainStatusLine` — prints what an empty *active* list means
(inert-and-loud for `deny`, fire-on-everything for `allow`) instead of "domain
lists are now empty". `domain-add`'s already-present message now names the
stored `listType`, with a "remove it first to move it" hint when it differs
from what the operator asked for.

**Port-stub sites touched**: `packages/core/src/ops/test-fixtures.ts` and
`packages/http/src/test-support.ts` needed **zero** changes — both fake every
`OpsPorts` method with a function that always throws (`() => never`), so
widening a return union broke nothing there. Confirmed by grepping the whole
repo for callers of the four methods outside `ports.ts`/`automod.ts`/
`wiring.ts`/tests before starting — none exist.

**Renderer tests (`automod.test.ts`)**: updated all `fakeOpsPorts` outcomes to
the new shapes; added one `wrong-kind` case per command (4 total) and three
CRITICAL-2/IMPORTANT-1 wording tests (stored-listType naming, allow-mode
"matches every link" warning on add, both directions of the warning on
remove).

## Decorative guard 1 — real round-trip coverage

`packages/storage/src/repos/automod-rule-lists.test.ts`: extended `portsFor`'s
inline reimplementations (the file cannot import `apps/daemon`'s `wiring.ts`,
per its own header comment) to mirror the fixed logic — kind check via
`findRuleKindAndConfig`, stored `listType`/`mode` surfaced from the
repository — replacing the old `ruleExists`-only version. Added three tests
against a real migrated database, through `OPERATOR_COMMANDS`:

1. add `example.com` as `deny`, re-add as `allow` → message and `data.listType`
   both name **deny** (the stored one), not the requested `allow` (IMPORTANT-1).
2. add `example.com`, remove `WWW.Example.COM` → row is gone (IMPORTANT-2).
3. `invite-allow` against a `keyword_filter` rule → refused `wrong-kind`,
   allowlist stays empty (IMPORTANT-7).

**Watched fail**, in two passes:
- Reverted `portsFor` to the pre-fix shape (existence-only check, echoed
  requested `listType`, no `mode`) — tests 1 and 3 went red (`ok: true`
  instead of the expected `wrong-kind` refusal; `listType: "allow"` instead of
  the stored `"deny"`). Test 2 stayed green, since its bug lives in the
  repository layer, not the ports layer.
- Restored `portsFor`, then reverted `removeLinkDomain`'s canonicalisation
  (compared verbatim again) — test 2 went red (`removed: false`). Restored;
  all 5 tests green.

## Things the review got right that I'd flag as noteworthy, not wrong

Nothing in this wave's four findings + two guards was wrong or overstated —
each reproduced exactly as described once isolated. One thing worth recording
for whoever reads this next: `addLinkDomain`'s repository-level canonical
lookup in `wiring.ts` (`listLinkDomains(...).find(entry => entry.domain ===
result.domain)`) can in principle miss if two concurrent writers raced the
same domain — documented in a code comment as a fallback to the operator's
requested `listType` rather than throwing, since this port has no way to
observe that race and a single-writer SQLite process (ADR 0004/0006) makes it
unreachable in practice.

## Things I chose not to change

- Did not build a "move domain between lists" command — the brief explicitly
  scoped IMPORTANT-1 to telling the truth and naming the remedy, not a new
  verb.
- Did not touch `automod dryrun` in `automod.ts`/`automod.test.ts` — wave A
  owns it.
- Left MINOR-4 (the wiring layer's real port implementations having no
  dedicated test outside this file) as is; this wave's guard-1 fix adds
  coverage for the *specific bugs* IMPORTANT-1/2/7 named, not a general audit
  of `wiring.ts`.
- Did not add a Zod-validated read of `config.mode` in `wiring.ts`
  (`linkDomainModeOf`); kept it a tolerant, hand-rolled field pluck for a
  display-only value, rather than importing core's predicate schema into the
  composition root for one field.
