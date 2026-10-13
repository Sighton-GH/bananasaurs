# P5 parallel unit 6c: Resources

Base: d318fb292577a15c56a506e490e0f77e87a35d5c. Branch: oc/p5-u6c.

## Source choices and scope

- Move commit bfef9f2a: complete Resources source moved into resources/index.tsx, with the original AssistantResourcesPage export retained in assistant-resources.tsx. Python comparison proved byte identity after relative-import normalization. Sweep then splits controller/list, form, GitHub import and helpers into owned files. Shell and shared components untouched.
- Brief said refresh/remove row menu and unchanged remove confirmation. Base has no remove action, route call, confirmation or test. Lead agreed to omit removal rather than invent a destructive API. Row menus retain Update now, Edit (non-GitHub only) and Enable/Disable.
- Existing ASSISTANT_URL snapshot and RESOURCE_FRESHNESS_URL remain separate. Freshness read failure renders its DataState failure beside the still-available sources; cache status remains unavailable, never Never updated or Ready. Missing fetchedAt on an otherwise present row is Needs attention, not Ready.
- Organisation folders, orphan children, private/auto-discovered badges, token-not-configured warnings, read-only org preview and include selection are retained. Source filter searches all resources for a chosen kind, so org children can match independently; All keeps the existing folder hierarchy.
- Add/Edit uses a resource-local Radix Dialog because the base has no generic shared Dialog. No duplicate shared primitive or shared edit. The controlled form retains input on refusal. Title max 200 comes from the existing HTTP resource schema. Specific legacy field codes are mapped locally; descriptive server text is kept verbatim. ErrorSummary points to field IDs and focuses on failure.
- GitHub panel adds a broad content/training disclosure before preview, retains the more specific private-content warning, and clears preview on URL changes. An in-flight success is ignored when the current URL differs. Opening the panel never previews or imports; preview and import stay explicit.
- Success copy now names the actual Behaviours page, not Assistant. No automatic attachment.

## Request assertion audit and red evidence

No existing request URL, method, body or CSRF/permission assertion was removed or changed. Existing row-action selectors changed to open the menu and select a menuitem; the GitHub no-Edit test now inspects menu items. Generic Too large field-copy assertion became a specific Title error plus aria-invalid, summary focus and retained-input assertions. Existing catalogue/ref metadata assertions retained.

- Baseline focused test: exit 0, 36 tests. Move focused: exit 0, 36 tests.
- Initial sweep red: exit 1, 4 failures / 36 passes, proving absent Dialog, DataTable/filter, freshness-error visibility and stale-preview invalidation. First implementation had a parse error and then selector failures; neither counted as success. Final focused: exit 0, 42 tests.
- Additional boundary red: exit 1. Missing fetchedAt incorrectly displayed Ready. The new CSRF assertion initially used the wrong header name; corrected against the real x-bananasaurs-csrf implementation, not by changing a guard. Final boundary and exact 409 PUT body/CSRF tests pass.
- Focused + HTTP routes/auth/CSRF: exit 0, 6 files / 235 tests.

## Gates and retained logs

Node v22.23.3; npm ci --ignore-scripts exit 0. Force/all typecheck exit 0. Seven exact root ESLint legs and whole-tree Prettier each exit 0. All-workspace npm run build exit 0. Build emits 13 externalization warnings (11 node:crypto, 1 node:net, 1 node:vm); no shim/suppression/new runtime import. Exact base graph comparison is recorded in the delivery report.

Monolithic baseline lint and initial whole-dashboard test each hit the command timeout; NOT PASS. Whole Dashboard source inventory is 122 test files, run as two exhaustive disjoint serial groups (61 + 61) after the last source change: exits 0/0, 837 + 510 tests = 1347 tests. Full-root tests remain the lead's phase-end gate, not claimed here. No core/server code changed. Build-generated ignored dist files are not candidate edits.

## Native pending and limits

No actual browser pixels, physical 360/1440 viewports, 100/200 percent zoom, native keyboard/focus walkthrough, screen-reader speech, live Discord or secret PrintOnce check performed. Dialog focus and ErrorSummary focus are component-test evidence only. Long lists retain all rows with responsive DataTable stacking and source filter, not newly paginated. Native layout (including the single Source column's density, folder/menu placement and wrapped links) and pagination policy remain for composition review. No phase-complete claim, no route patch or shared-file patch required.

## R1: Edit dialog focus repair

Independent review reproduced Edit -> Escape/Cancel falling to BODY because the captured menuitem was removed. Exact reviewer probe witnessed red (2 failed, Add Cancel passed) before repair. Permanent owned focus tests use the existing Radix jsdom polyfills and also fail on the exact prior candidate (4 failed, Add Cancel passed).

Row-local ref captures the persistent Actions button through its aria-haspopup=menu before opening Edit, not the transient menuitem. ResourceForm receives the explicit target; Add keeps its connected button target. If the target is removed (including successful save/reload), focus returns to a persistent focusable Resources header outside DataState. No shared DropdownMenu edits, new props, extra route, request change or proposed shared patch needed. Row ref lookup is scoped to the local action region, not a global label or ID guess.

Five permanent focus tests cover initial Title focus, Edit Escape/Cancel, no PUT on close, Add Cancel, disconnected opener fallback and successful save fallback. Original 42 request/CSRF/refusal tests remain unchanged. Focus + Resources + unchanged rollout guard: exit 0, 306 tests (5 + 42 + 259). One early green attempt encountered missing ResizeObserver in the separate probe's jsdom environment; retained as failure, fixed with test-only existing polyfills. No production shim.

Fresh affected force/all typecheck, seven root ESLint legs/whole Prettier, all-workspace build and exhaustive disjoint Dashboard inventory are recorded in the R1 delivery report with numeric exits and raw logs. Full-root remains lead phase-end cadence; native pixels/browser focus/AT remain pending exact scoped re-review and composition. No acceptance or phase-complete claim.

R1 final receipts: force/all typecheck1408 exit0; exact seven full root ESLint legs1280 each exit0 plus whole Prettier exit0; all-workspace build1408 exit0. Exhaustive123 unique Dashboard source files in three disjoint41-file batches: exits0/0/0,606+503+243=1352 tests; unchanged source rolloutguard259 exit0 (focus/Resources/guard306). Every complete output read. Numeric sidecars/raw logs retained, one heavy job at a time, waited before next launch. Build externalization importer graph exactly equal to prior detached d318 base13 (11crypto/1net/1vm). Original42 Resources tests byte-unchanged versus86f67356. No tracked symlink/dependency/shared/API/guard changes. Five-file owned repair only. Fullroot and native/AT still not verified.
