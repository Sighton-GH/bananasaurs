# P5 unit 6d: Permissions

## Base and scope

- Base: d318fb292577a15c56a506e490e0f77e87a35d5c.
- Owns permissions wrapper/tests and pages/permissions only; shared files unchanged.
- Move: original source is byte-identical after reversing import depth adjustments.
  Original wrapper preserves its sole export, PermissionsPage. Existing tests remain at original path.
- Requests stay through session.read/write; no API, grant, scope, capability or shared primitive changes.
- Combined reads: four mandatory sources, optional logging exclusions remains undefined on failure.
- Physical browser, pixels, zoom, screen-reader speech and live Discord are not verified here.
  Native composition checks belong to the lead.

## Presentation decisions and assertion audit

- Channels/Assistant/Specialised tabs use `useSearchParams`, keep unrelated query
  values, default unknown values to Channels, and push history (not replace).
- Category expansion and effective-row helper stay unchanged. Helper extraction
  is source-equivalent after adding exports and its own type imports.
- One DescriptionList disclosure and HelpTips explain the four switches. Every
  non-string DataTable column has its mobileLabel, using the existing kit prop.
- Attachment choice uses the existing native RadioGroup (two options), not a
  new shared extension. Categories still send channelId only, never bytes policy.
- Row writes moved into kit DropdownMenu entries. Existing tests open the same
  row menu and use menuitem selectors; category expansion selectors are narrowed
  to distinguish the expansion button from the menu trigger. No request URL,
  method, body, no-delete or inherited-state assertion was removed or weakened.
  The No access presentation text count changes from 8 to 6 because other rows'
  actions are now inside closed menus; the four effective exclusion badges remain.
- Optional log-routes failure still becomes undefined. Only its No access column
  and action hide; the notice no longer claims an unknown exclusion state is shown.
  Mandatory failures remain a DataState error and cannot render scope actions.
- Link labels match the existing routes: Connected apps, Role panels, Behaviours.
  No capability-map or NAV rename. Assistant tab links to Behaviours, not new grants.
- New request matrix covers all nine writer branches (archive enable/pause/resume,
  read allow/stop, send allow/stop, exclusion add/remove), category variants,
  encoded IDs, bodies and CSRF. Server read-only refusal still uses session.write
  and does not refresh scope. No server/capability logic changed.

## Red / green

- Before sweep implementation: 6d-red.log, Vitest exit 1; 9 tests, 4 failing
  (URL tabs, disclosure/radio, keyboard HelpTip, optional column hiding), 5 passing.
- New selector corrected from expected header name "Read Help: Read" to "Read"
  after inspecting the real accessible name. HelpTip button is tested independently.
- Existing fifteen tests remain, including every original request assertion.
- Final focused run: 45 tests in 4 files, exit 0. Failed interim runs exposed
  missing jsdom ResizeObserver setup, test fixture cursor typing and unused import;
  fixed only in owned tests with no shared suppression or production shim.

## Gate follow-up

Final statuses and full raw outputs are in the returned report and log archive.
Full root suite, physical native composition checks, and independent review remain
lead responsibilities. No phase-completion, pixel or screen-reader claim is made.

## Fix round 1: preserve tab URL fragments

- Independent source review found that wouter useSearchParams removes a fragment
  when it rebuilds pathname and query. Reproduced at assistant&keep=1#scope:
  clicking Specialised kept keep=1 but lost #scope. Red Vitest exit 1, 1/9 failed.
- Owned index now uses useLocation navigation with copied search parameters and
  the browser's current hash appended. Navigation still pushes history. No shared
  helper or other page changed; unknown-tab fallback remains unchanged.
- Regression uses real wouter browser hooks in jsdom and checks hash/query after
  clicking and actual history.back(). This is not native-browser verification.
