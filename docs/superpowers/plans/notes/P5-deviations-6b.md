# P5 unit 6b - Connected apps

Base: d318fb292577a15c56a506e490e0f77e87a35d5c.

## Structure and compatibility

- Move-only commit 0268c9c064a2f9c530bb36bc20df3f76aa70ffc4 moved the original page into connected-apps/index.tsx. The original mcp.tsx exports exactly McpPage. Imports gained one parent level; source equality was checked after reversing that adjustment, before formatting.
- The sweep splits Connections, Send allowlist, Role policy, Registered clients and Send ledger into owned files. Query values are connections, send-allowlist, role-policy, registered-clients and send-ledger. Missing or unknown values show Connections without rewriting the URL. Selection preserves unrelated query parameters and follows popstate. No Shell or shared component edits.
- Individual tokens remain under Connections, in the original advanced disclosure. Tables remain DataTable and token values remain identifiers only.
- The three two-option raw selects became kit RadioGroup controls with human labels. Underlying values and POST bodies stay unchanged.
- The original caught role-list error returned an empty successful list. That catch was removed and the owned role-policy section shows the existing DataState error/retry while keeping role-ID fallback and policy controls available. This is a presentation-state fix, not a role-policy API change.
- The send-allowlist empty text now points to Permissions rather than the nonexistent form below it. Existing permission link uses the kit Link.

## Request assertion audit

Existing URL, method, body and guard assertions were not weakened or removed. Tests only select the tab before checking its section and use radio selection instead of a raw select event. Existing display assertions remain, checked on their proper tab. Five write handlers and all five ConfirmDialog definitions match base after whitespace normalization, including the long cleanup consequences. Role-policy save, allow and remove retain original bodies/methods and session write paths.

Added tests cover deep links, unknown tab, popstate, unrelated query preservation, no write on tab navigation, five confirmations/cancel-focus/request boundaries, encoded slash/space/question-mark IDs, exact POST empty bodies, CSRF, returned counts, token empty/failure, section empty/failure, role-list failure and capability-bearing 403.

## Red-green evidence

- Baseline MCP: 12 tests, exit 0. Move MCP: 12 tests, exit 0.
- Routing tests before implementation: 3 failed / 13 passed, exit 1. These fail because no tabs exist. After implementation and tab-aware selectors: 16 passed, exit 0.
- Safety tests: 6 failed / 22 passed, exit 1. One real missing role-list error view plus five new CSRF checks using a mistaken header name. The latter were corrected to the inspected api.ts literal x-bananasaurs-csrf; application request code was never changed. Safety green: 28 passed, exit 0.
- Final MCP coverage: 34 tests, exit 0, including additional existing-state regression coverage.

## Gates and limits

Node 22.23.3; one heavy process at a time. Vitest maxWorkers=1 and no-file-parallelism, 1024 MB heap. Typecheck/build 1408 MB; ESLint/Prettier 1280 MB.

- npm ci: exit 0.
- npm run typecheck: baseline, sweep and final each exit 0 (one intermediate purpose-label narrowing mistake returned 2 and was fixed).
- Initial npm run lint hit the command timeout, not a pass. All seven exact full-repo ESLint legs then exited 0; whole-repo Prettier exited 0.
- Whole dashboard single invocation hit the command timeout, not a pass. Complete 122-file inventory was then run in four disjoint serial shards, each exit 0: 390, 417, 268 and 283 tests (1358). Final MCP-only run adds six tests, so the checked inventory plus final changed-file rerun covers 1364 tests; this is not a new single whole-dashboard invocation.
- HTTP ops-read/ops-write/server plus unchanged Shell: 176 tests, exit 0.
- npm run build: exit 0 across all workspaces. Vite shows 13 node externalization edges: 11 crypto, 1 net, 1 vm. Baseline dashboard build with the original MCP source also exits 0 and has the exact same module/importer graph. Existing large-chunk warnings remain. No shim or suppression.
- No root full test suite run here; lead owns final phase union gate.

## Native verification pending

No browser pixels, physical 360/1440 width, actual 100/200 percent zoom, light/dark appearance, native keyboard walkthrough or screen-reader speech was verified. JSDOM tests verify modal Cancel autofocus/focus return and tab semantics only. Historical MCP offscreen Cancel caveat remains a native composition check, not claimed fixed here. No Discord, push, merge, deploy, tag, new dependency, API, shared-file or account mutation.

No proposed shared-file patches.

## R1 independent-review repair

Independent source review of a796355e verified draft loss/repeated role reads on tab remount and dropped fragments on selection. R1 retains only the Role policy content on first visit, using the installed Radix Tabs Content forceMount. It is explicitly hidden with tabIndex -1 while inactive; initial loading remains lazy and the existing duplicate role loaders are not rewritten. Role policy choices, role ID, purpose and refusal remain mounted. Explicit Save/allow/remove still use the same handlers. Other tabs remain unchanged. selectTab appends the current browser fragment after the preserved query.

Before fixing source, the supplied eight-case probe ran against a796355e: exit 1, exactly three reproduced failures and five passing controls. Two new owned regression cases also failed before implementation (34 pass, 2 fail). First repair green: 36 MCP tests, exit 0. Refusal retention, hidden-content keyboard exclusion and real JSDOM history Back/Forward tests were added afterward as regression coverage, not represented as historical RED.

No shared Tabs, Shell, API, RolePicker or helper edits. No native visibility/focus, screen-reader or actual browser-matrix claims. R1 gates and exact final SHA are in the attached repair report; lead must independently re-review this repair and run affected native checks on composition.

R1 actual gates: scoped MCP/Tabs/RadioGroup/ConfirmDialog 64 tests exit 0; force/all typecheck exit 0; seven exact root ESLint legs each exit 0; whole Prettier exit 0; all-workspace build exit 0. Exhaustive disjoint dashboard batches cover all 122 files, 400 + 417 + 268 + 283 = 1368 tests, each exit 0. Unchanged no-staged-rollout guard: 259 tests exit 0. The independent eight-case probe also passes after repair (exit 0), with its three pre-fix symptoms recorded separately. Build externalization graph remains exactly equal to the earlier 13-edge candidate/baseline graph. Every R1 gate ran serially with an exit sidecar; none timed out. Full root suite is not run in this unit. Native checks and independent source re-review remain pending.
