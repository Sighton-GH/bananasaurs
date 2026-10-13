# P5 parallel unit 5a: Doctor and Configuration

Base: d318fb292577a15c56a506e490e0f77e87a35d5c. Owned files only: doctor/config pages and their tests, plus this note. No shared patches, new dependencies, server edits, navigation edits or live calls. Both bounded pages stay at their original paths; no move-only commit needed.

## Source decisions

- Doctor API has `ok`, `text`, `data.problems`, and `data.advisories`, not a per-check results array. Render only actual structured problems with danger/name/impact/fix/route columns, advisories with hold badges, and the actual summary. Legacy failure fallback and unconfigured public probe remain honest. Do not derive checks from prose.
- Raw report text plus object are copied together using CodeBlock under Advanced. The kit's Copy button remains Copy, with visible Copy report context; no shared CodeBlock edit.
- Configuration reads safety from useHealth and already-redacted process configuration from /api/config. Known labels go to KeyValueTable; recursive conversion uses only that returned redacted shape. Advanced keeps its copyable redacted payload.
- Limits remain separate /api/settings POSTs in role-rate, reconcile-budget, breaker-threshold order. Blank means unchanged; positive and integer validation unchanged. SaveBar adds Save and Discard while the existing Apply changes submission stays as a secondary button for compatibility. Controlled drafts remain in page state through health reload; successful fields alone advance the baseline. Failed fields retain inputs and field errors map only to the rejected setting, not every field.
- Guard covers in-app path anchors and unload only. No Back or programmatic navigation claim. Safety confirms keep the original guild, automod switch, and breaker reason scope.

## Request assertion audit and red proof

Original request URL/method/body/count and confirm-scope assertions retained. Presentation selectors changed only: single alert lookup now selects the new error summary and asserts focus and its field anchor; Doctor `fine` lookup matches the copied combined report rather than a separate text node. No request or guard assertion weakened.

Baseline original focused tests: exit 0, 2 files / 8 tests. Added red tests before implementation: exit 1, 4 new failures (missing structured table/Advanced copy; missing dirty guard; missing partial draft save; dishonest health failure loading). Legacy fallback and independent report failure tests already passed. Focused green: exit 0, 2 files / 14 tests. Force/all typecheck: exit 0. Focused eslint: exit 0. Raw logs retained for handoff.

## Remaining verification

Whole dashboard tests, HTTP guards, all seven ESLint legs, whole Prettier and all-workspace build pending at first increment. Parent runs phase full-root suite on exact composed union. Native physical 360/1440, 100/200 zoom light/dark pixels, keyboard, error focus and confirm focus pending on composition. No pixel, screen-reader speech or live claim from jsdom tests.

## Second increment

Second red test run: 5 failures, of which 3 were feature gaps (blur validation, partial-save status naming saved fields, empty config). Two test-harness corrections: Wouter's path hook excludes query/hash, so assert actual browser pathname/search/hash and one push; Radix modal hides background controls from accessible queries, so use hidden:true solely to inspect disabled background Save/Discard. Green: 21 focused tests, exit 0. Busy reauth confirms exact body both before and after reauth; CSRF and credentials checked. Blank unchanged, integer bounds, guard Stay/Leave/unload, independent failure and empty response covered.

Known process labels checked against config/schema.ts: actual keys are BANANASAURS_GUILD_ALLOWLIST, BANANASAURS_ROLE_RATE_LIMIT_PER_MIN and BANANASAURS_ERROR_BREAKER_THRESHOLD. Older missing-limit fallback mentions historical runtime labels; preserve its original scope text, do not widen runtime/API changes.

First all-workspace build exit 0; seven full ESLint legs exit 0; HTTP guard/read/write/auth/server inventory 5 files, 195 tests, exit 0. First whole Prettier exit 1 for tests still being written; fresh final run required. No baseline-browser shim; build emitted 13 node externalization warnings (11 crypto, 1 net, 1 vm), graph comparison pending. First full dashboard foreground attempt was killed by execution timeout; retry runs separately with durable exit receipt. No pass claimed for timeout.

## Final worker gates

Frozen-source final: force/all typecheck 0; each of the seven full ESLint legs 0; whole Prettier 0; all-workspace build 0; whole Dashboard 122 files / 1349 tests 0 (222.46s serial). HTTP ops read/write, auth, server and CSRF header: 195 tests / 5 files 0; unchanged no-staged-rollout guard 259 tests / 1 file 0. Full-root phase suite and native composition checks remain parent-owned pending work.

Exact baseline browser graph comparison: baseline all-workspace build in a second worktree hit TS2742 caused by the shared node_modules symlink path (exit 2), not a candidate failure. Baseline dashboard Vite-only build also exited 1 before producing a graph. Exact fresh graph comparison is NOT verified. Candidate has 13 warnings (11 crypto, net, vm), matching the documented baseline count only, not fresh graph evidence. No shim or warning suppression. Existing chunk-size and jsdom CSS parse diagnostics remain visible. Raw receipts retained with the candidate.
