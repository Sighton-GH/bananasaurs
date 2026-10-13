# P5 parallel unit 6a

Base: d318fb292577a15c56a506e490e0f77e87a35d5c. Only panel builder, its tests and this note are owned.

## Structure and source choices

- Move-only d2c78b98 relocates the full builder to panels/builder/index.tsx. Normalizing relative import prefixes produces byte-identical source. Original path keeps exactly PanelBuilder and toPanelName. Existing consumer tests stay at their original path.
- Sweep splits Options and Behaviour into owned files. Preview forwards all original PanelPreview props, retaining the original panel preview rather than rendering a task card. Where and Limits remain in index.
- Two-stage flow stays edit -> review -> Create -> saved. SaveBar Save validates and enters review; it never writes, and Create remains the only POST /api/panels call. Saved Publish calls the same onCreated(panelId) callback formerly named Open it. Copy says publishing is a separate confirmed action on the saved page. No publish endpoint is called.
- Draft Discard resets editable inputs and message-check/preview state, keeps loaded role/channel/emoji data, preserves selected type, and advances rather than reuses option numbering. Back from review retains draft and verified message. Build another clears channel, behaviour and limits as well as prior form content.
- Guard covers path-anchor clicks and beforeunload only. Cancel button gets its own explicit dialog. No Back/programmatic-navigation coverage claim.
- Role picker uses Select, Behaviour/format use RadioGroup, message text uses counted Textarea with Field htmlFor. Role-list reads use DataState; failed data is not rendered as empty or described as pasteable when the Select cannot accept typed IDs.
- ChannelPicker lacks an id prop; error-summary destination is a focusable owned wrapper, not a shared-kit edit. Summary takes focus; field errors keep input. Server-field errors return to edit. No shared patch needed.

## Request/assertion audit

Existing request URLs, writeOrThrow call and assemble body preserved. Existing expected POST bodies are unchanged, including reaction adoption, message ID, managed-role allowlist feedback, option identity, Unicode/keycap and custom emoji normalization, required/blocked roles. Only native-select selectors become Radix keyboard/option selectors, disabled attributes become data-disabled, and Open it selector becomes Publish. No request or guard assertion weakened.

## Red-green evidence

- Baseline and move: 16/16 tests, exit 0.
- First red: existing 16 pass, new 3 fail (sections/SaveBar, link/unload/discard guard, focused summary), exit 1, before implementation.
- Second red: 19 pass, new 3 fail (saved/reset, server field focus, honest failure copy), exit 1, before implementing those fixes.
- Latest focused green: 22/22, exit 0. Full force/all typecheck exit 0. Dashboard ESLint exit 0 after a test-only exact-option type fix and fetch-input narrowing.
- Whole npm run lint initial attempt interrupted at 120 seconds, not PASS. Remaining full gates reported separately on exact candidate.

## Pending verification

No pixels, physical-width native browser, zoom, screen reader, Discord, deployment or production claims. Native composition needs 360/1440, light/dark, 100/200%, keyboard/error-focus/guard/dialog return focus checks by lead. Root full-suite and independent review belong to composition. No phase completion claim.

## Repair round 1 and common gates

Deferred message-check test exposed stale checked content returning after Discard. Witnessed red (exit 1); response-generation invalidation added on check/target change/discard, with no request changes. Green: 23 focused tests exit 0. This is a separate repair commit. Fresh force/all typecheck, dashboard ESLint, workspace builds and entire dashboard inventory rerun serially: 122 files / 1347 tests, exit 0. Seven complete ESLint legs and whole Prettier passed on sweep; dashboard leg and whole Prettier rerun for repair. HTTP/dependent suite: 6 files / 172 tests exit 0. Initial whole-lint timeout and first repair command timeout are not reported as passes; explicit reruns have exits.

Both exact baseline d318fb29 and candidate built with 13 identical node externalization edges (11 crypto, 1 net, 1 vm), compared as sorted (module, importer) pairs. Large-chunk warnings also preexist. No shims or suppressions.

## Source-review fix: grouped error-summary destinations

Independent source review found duplicate React keys when two option problems both target field-options. Owned builder projection now groups entries by actual focus destination and joins all messages in original order. Real field ids remain unchanged; no fabricated ids or shared ErrorSummary edits. Regression witnesses two simultaneous option problems RED (exit 1), then checks one combined entry, both messages retained, real focused target, no duplicate-key console warning, and updated remaining message after one problem is fixed. Prior request/guard and deferred-check race tests retained. Focused GREEN: 24 tests, exit 0. Review low items stay recorded in the source-review report, not widened into this fix. No native/AT claims.
