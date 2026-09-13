# Slice 9 whole-branch review — Opus, 2026-09-13

Reviewer: Claude Opus 5 via the Agent tool (brief:
`.oc-runs/slice-9-review/final-review-brief.md`; diff:
`.oc-runs/20260913T101930-oc_slice-9-review.branch.diff`, base `4afa404`,
head `0ec5aaa`). 8m33s, 45 tool uses. Reproduced verbatim; the controller's
adjudication follows in the ledger (rulings PR-62..PR-64).

## Verdict
SHIP-WITH-FIXES — the queue, verdicts, tally, guild scope, audit and PR-59 all trace clean, but the one-click suppression only works as one-click for `channel_exemption`: the three prefilled kinds prefill the wrong value and two of the storage paths can write an inert row that is reported as "allowed".

## Findings

- [Important] `packages/http/src/routes/automod.ts:452-460` — `link_domain` suppression always writes `listType: 'allow'`, but a rule in `deny` mode ignores allow rows: `packages/core/src/automod/predicates/link-domain.ts:79-81` does `rule.linkDomains.filter((entry) => entry.listType === config.mode)`. On a deny-mode rule the route inserts a row the predicate never reads, returns `200 { outcome: 'added' }`, the dashboard toasts "Domain allowed", and the match keeps firing. Slice 8's `addLinkDomain` returns `mode` in its result for exactly this reason (`apps/daemon/src/ops/wiring.ts:338-340`); the route reads `result.outcome` and discards `mode`. — Read the predicate and both port implementations. — Fix: when `result.mode === 'deny'`, call `removeLinkDomain({ ruleId, domain, listType: 'deny' })` instead (still strictly narrowing, so PR-59 holds), or refuse with a 409 naming the mode and have the dialog say so. Add a route test that seeds a deny-mode rule.

- [Important] `packages/dashboard/src/pages/review.tsx:129` — the prefill is `match.matchedSnippet`, but the snippet is the matched *span of the message*, not the value the route accepts. `invite`'s snippet is `found[0]` = `discord.gg/abc` (`predicates/invite.ts:19,62`), which fails `INVITE_CODE_PATTERN` (no `.`/`/`) → 400 → "The request failed: bad-request". `link_domain`'s snippet is the whole URL `text` (`predicates/link-domain.ts:116`), which fails `LINK_DOMAIN_PATTERN` (`://`) → 400. `keyword_filter`'s snippet is the raw matched span (`matcher.ts:246`), so for `Assassin`→term `ass` it prefills `Ass`. The stored trace carries `matchedOn` for all three kinds — the code, the host, the configured term — and ruling R-8 and the predicate comments say that is "the thing a reviewer acts on". — Read the three predicates and the route validators; the route tests pass only because they post hand-typed values. — Fix: parse `trace` (it is already a JSON string on the row) and prefill from `matchedOn`, falling back to the snippet when absent; add a review-page test whose match carries an invite trace and asserts the prefilled value is the bare code.

- [Important] `apps/daemon/src/ops/wiring.ts:418-426` and `packages/http/src/test-support.ts:356-364` — `addAutomodAllowlistPhrase` stores the phrase verbatim. obscenity's whitelist lower-cases the *input* (`englishRecommendedWhitelistMatcherTransformers`, `node_modules/obscenity/dist/preset/english.js:36-42`) and then does `transformed.indexOf(whitelistedTerm)` with the raw term (`RegExpMatcher.js:129`), so any phrase containing an uppercase letter can never match: the row is written, the route says `added`, the toast says "Phrase allowed", and the term keeps matching. The seeded allowlist is all lowercase so nothing existing hits this; the review page is the first path that stores member-typed case. The `already-present` pre-check is also case-sensitive, so `Ass` then `ass` insert two rows. — Read obscenity's matcher and the seed. — Fix: canonicalise in the port (`phrase.toLowerCase().trim()`, collapse runs of spaces) in both literals, the way `canonicalDomain` does for domains, and compare the canonical form in the pre-check; audit the canonical value.

- [Minor] `packages/dashboard/src/pages/review.tsx:406` — the native-hits table links Rule to `/automod/${h.ruleId}`, i.e. `/automod/native:1`; the rule-id regex at `routes/automod.ts:21` has no colon, so the detail page 400s. Render the native rule id as text.

- [Minor] `packages/dashboard/src/pages/review.tsx:148,184` — `${ruleId}` and `${eventId}` are interpolated without `encodeURIComponent`, contrary to the plan's dashboard rule (the rules list at `automod-rules.tsx:143` does encode). Safe today only because event ids are `randomUUID()` and rule ids are regex-bound.

- [Minor] `packages/http/src/routes/automod.ts:369-382` — the verdict route accepts any `mod_case_events` row under scope, not only matches: `recordVerdict` (unchanged, `mod-match-reviews.ts:83-88`) checks existence only. A `config.write` operator who copies a `manual` warn/purge event id from a case page records a verdict that `countVerdictsByRule` tallies under `manual`, and the review tally then shows a `manual` row linking to `/automod/manual`. Cheap guard: 404 unless the event's `ruleId` is a rule in this guild or starts with `native:`.

- [Minor] `packages/http/src/routes/automod.ts:65` — `INVITE_CODE_PATTERN` is `[A-Za-z0-9-]{2,32}`, narrower than the predicate's own `([\w-]{2,64})` (`invite.ts:19`): a code with `_` or over 32 characters matches but cannot be allowlisted from the review page.

- [Minor] No two-guild test for the allowlist-phrase write (brief item 2): the suppress route tests seed one guild only, and `automod-rules.test.ts:198-212` (`findRuleIncludingDisabled`, pre-existing) asserts `undefined` for the other guild without seeding a colliding `r1` there. The scoping is correct by reading (`ruleExists`/`findRuleKindAndConfig`/`findRuleIncludingDisabled`/`addAllowlistPhrase` all take `scope`), but nothing would fail if it regressed.

## Decorative tests

- `review.test.tsx` "suppresses a keyword match…" — never edits the input, so the scope sentence reacting to the *current* value (brief item 7) is asserted nowhere; the caps test edits the value but asserts only the POST body. A dialog whose sentence froze on the prefill would pass.
- `review.test.tsx` "hides the F3.2 warning … only a regex rule" — passes whether the predicate checks rules "in view" or "any rule in the guild": the route emits a `verdicts` key for every rule (`automod.ts:360-363`), so the tally — and therefore `relevantRuleIds` — is every rule in the guild anyway. Not wrong, but the test does not pin the plan's "in the queue or tally" wording.
- `automod.test.ts` "suppresses with a link domain" — proves canonicalisation of `Example.COM` on a rule whose config is `'{}'` (no mode); it cannot see the deny-mode inert write above.
- Nothing asserts PR-59 (`enforce_signed_off_by/at` unchanged after each suppression kind); it holds by construction only.

## Verified and clean

- Forbidden files untouched — `git diff 4afa404 HEAD --stat` over `schema.ts`, `src/migrations`, `db.ts`, `automod-rules.ts`, `mod-match-reviews.ts`, `mod-cases.ts`, `enforcement-gate.ts`, `subscriber.ts`, `native-subscriber.ts`, `effects/gateway.ts`, every `package.json` and the lockfile: empty. `--name-only` lists exactly the plan's files plus the two ruled test-fixture edits.
- PR-59: the four suppression kinds write to `word_allowlist` (`addAllowlistPhrase`, `automod-rules.ts:586`), `automod_invite_allowlist` (`rule-lists.ts:64`), `automod_link_domains` (`rule-lists.ts:176`) and `mod_rule_exemptions` (`addAutomodExemption` → `addChannelExemption`). None touches `mod_rules`; `enforce_signed_off_*` are never named in the diff.
- Guild scope: `listUnreviewedNativeHits`, `countVerdictsByRule`, `countNativeBlocked` all `scope.only(...)` with the join keyed on `guildId` too; each storage test seeds the other guild with colliding ids (`native-old`, `e1`, `n1`) and asserts both guilds' answers. The route GET test collides `e1/e2/n1` across guilds; guild B's verdict on A's `e1` → 404 (test present, `recordVerdict` selects under `scope.only`).
- Verdict route: `reviewedBy: session.accountId`; audit `automod_match.verdict_recorded` / `subjectId = eventId` / `after.verdict`, asserted with `actorId === ACCOUNT`; 404 and 400 assert no audit row; `recorded-with-label-conflict` passes through as `outcome` and the page maps it to a hold toast.
- Suppress route: `kind`/`value` Zod; `link_domain` lower-cased before the regex and the repo canonicalises again; `channel_exemption` via `snowflakeIdSchema`; `wrong-kind` 409, `no-such-rule` 404, `already-present` 200 — all tested; no 4xx path reaches `recordAudit` (every early return precedes it). Param/body parse runs before the guard, the same shape the Slice 8 ledger accepted ("leaks only the caller's own input shape").
- `countNativeBlocked` counts exactly `native_blocked|native_timeout|native_blocked_interaction`; the CHECK at `schema.ts:989-996` and `native-subscriber.ts:75` (`native:` prefix) mean no real rule id can carry those values today. Test covers all three plus `native_alerted` and `would_delete` exclusions.
- Tally: `verdicts` and the old `reviewedCount` come from the same join (`countReviewedByRule` `automod-admin.ts:162-174` vs `countVerdictsByRule`), so the rule detail page's remaining `reviewedCount` (`automod-rule.tsx:250`) cannot disagree with the split on the board or rules list.
- `ConfirmDialog` children render after `Dialog.Description`; the test focuses the input and asserts `aria-describedby`'s target does not contain it.
- Dashboard rules: `DataState` on the page; verdicts via `session.write`, suppression via `writeOrThrow` catching only a 409 `wrong-kind` (400 falls to the generic toast; `writeOrThrow` rethrows only 400/409, `session.tsx:132`); `afterEach(cleanup)` and `// @vitest-environment jsdom` present; `api/automod.ts` imports no `.tsx`; hold colour only on the warning note.
- Port surface: the three members are in all four literals; wiring and test-support `addAutomodAllowlistPhrase`, `addInviteAllowlistEntry` and `addLinkDomain` are line-for-line the same logic. The verdict-click test asserts the POST body, not just the call.
- Gates in the oc worktree, each alone, by exit code: typecheck 0, lint 0, test 0 (135 files, 2588 tests).

## Checked outside the diff

- Does an allowlist phrase actually suppress? → `node_modules/obscenity/dist/matcher/regexp/RegExpMatcher.js:124-142` and `preset/english.js:36-42`: whitelist intervals come from `indexOf` of the raw term in the lower-cased, space-collapsed input — the source of the case finding.
- What does the snippet contain per kind? → `predicates/invite.ts:19,62`, `link-domain.ts:15,116`, `matcher.ts:246`; `matchedOn` in `predicates/types.ts:128`.
- Does an allow row narrow a deny-mode rule? → `link-domain.ts:79-81` filters by `config.mode`; no.
- What can carry a verdict? → `mod-match-reviews.ts:83-88` selects any event under scope; `MANUAL_RULE_ID = 'manual'` in `mod/warn.ts:31`.
- Event/rule id shapes for URL safety → `apps/daemon/src/automod/wiring.ts:345`, `native-wiring.ts:26` (`randomUUID()`); `ruleIdSchema` at `routes/automod.ts:21`.
