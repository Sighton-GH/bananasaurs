# P5 deviations — unit 6e (Account edit)

Base: d318fb292577a15c56a506e490e0f77e87a35d5c. Branch: oc/p5-u6e. Owned files only:
`packages/dashboard/src/pages/account-edit.tsx` (+test), `packages/dashboard/src/pages/accounts/detail/**`,
this notes file. No shared file (Shell, kit, NAV, styles, manifests, other pages) was edited. No
shared-primitive patch needed: the danger-bordered panel uses the existing `border-tone-danger` token in a
page-local `<section>`, because kit `Card` has no danger tone and kit must not be mutated by a unit.

## Source choices

- Tab state lives in `?tab=` (`useSearch` + `URLSearchParams`), default `summary`, unknown values fall back
  to `summary`; switching pushes a new history entry so Back returns to the previous tab. No request fires
  on tab switch (asserted).
- Danger zone moved off kit `Card` to a page-local `<section>` with `border-tone-danger` (plan: "danger
  stays at the bottom of Summary as a danger-bordered Card"). Headings and confirm dialogs unchanged.
- Owner accounts: tabs reduced to what may actually touch the row — Summary only for another owner's row,
  Summary + Password for the owner's own row (the pre-existing summary/password-only behaviour, kept
  verbatim). The summary's owner sentence is the honest explanation; no Permissions/Reveal/Sessions/Danger
  controls are offered for an owner row to any viewer. Non-owner rows keep `canReveal = isViewerOwner &&
  account.revealable` exactly.
- `isViewerOwner` still computed from the viewer's own account row; `isOwnAccount` still accountId equality.

## Request assertion audit

Every `stubFetch` URL/method/body assertion is byte-identical to base. Added assertions only:
`POST /api/accounts/jo%20y/disabled` body `{ disabled: true }` (username encoding), the 400 grant-refusal
route, the 403 list route, and fetch-count assertions around tab switches. No assertion was weakened or
dropped; the section-order test became a tab-order test because panels now render one at a time.

## Selector updates (allowed by the plan's test rule)

Tests open tabs with `userEvent.click` before interacting with Permissions/Password/Sessions controls —
Radix tab triggers activate on pointer events, which `fireEvent.click` does not produce. No request/guard
assertion changed.

## Red proof

Correction (lead review): the exact move commit `22c9d084` fails to collect the test file — its detail
files used `../../` where the new depth requires `../../../` (defect found at first run and repaired in
the sweep commit `b1b10291`; history kept, not rewritten). The byte-identical body evidence for the move
stands (bodies extracted and diffed before the import fix). The honest RED is therefore against an
import-corrected move baseline: 15 failed, 9 passed of 24 (failures include the missing tablist, missing
`?tab=` handling, and all tab-gated interactions). Against the swept implementation: 24 passed.
Caveat: the red run used `fireEvent.click` for tab triggers; the green file switched those to
`userEvent.click` (event mechanics only — every expectation is unchanged).

## Repair round 3 (review P2): permissions draft survives tab switches

Independent review found that `PermissionsSection` unmounted with its tab panel, losing an unsaved
role/custom-capabilities selection on tab switch. Fixed by lifting the draft: `usePermissionsDraft(held)`
in `permissions.tsx` holds `role`/`customCaps`, and `index.tsx` keeps it in a `NonOwnerAccountSections`
component mounted above the tab panels (keyed by username, so a different account starts a fresh draft).
`PermissionsSection` receives the draft as a prop; its save flow, error/busy state and every request are
unchanged. No guard blocks tab switches; no request fires on a switch (asserted, including after a
refused save). Red-first: two new tests (draft across tab switches; refused-save draft across tab
switches with no extra writes) failed against `c39dbfc6` before the fix.

## Native / pending

Native checks (PrintOnce focus/copy/error/close on a real screen, long-username/header at 180 px CSS
reachability, 360/1440 light/dark pixels) are NOT run here — they run on composition per the contract. No
pixel, DPR, or screen-reader claim is made. Full-root gates (seven ESLint legs, whole-workspace build) run
as far as the unit box allows; the lead re-runs gates fresh on composition.

## Repair round 4 (re-review R1): draft lifecycle above DataState

Re-review of the round-3 fix found three defects, all from the draft living below `DataState` and the
save lifecycle (busy/error) living in the unmounting panel:

- **D1**: a tab switch during a pending save remounted the section with `busy=false`, enabling a
  duplicate `POST` (probe wrote twice).
- **D2**: a refusal arriving while the operator was on another tab was lost — the draft stayed dirty
  with no error shown.
- **D3**: any reload triggered from a sibling tab (e.g. Sessions "Sign out everywhere") drops into
  `DataState`'s Loading state, unmounting the round-3 draft owner and wiping unapplied choices.

Fix (lead rulings): `usePermissionsDraft` now holds selection **and** busy/error above `DataState` in
`AccountEditPage`. A route/username change resets the draft (effect keyed on the param, and `update`
rebuilds from the held baseline on any username mismatch). A successful own save reconciles
deliberately: clear the draft, reload, fresh response becomes the baseline. A sibling reload no longer
touches the draft. The in-flight guard is the lifted `busy`, so a second Save click while pending is
disabled and writes stay at one. No storage persistence, no extra reads or writes.

Red-first: four regression tests failed against `4eb0d8c2` (pending-save duplicate write;
refusal-while-inactive; sibling reload; route-change reset) plus one added coverage test that passed
immediately (partial-grants baseline preselects Custom honestly). Adapted from the reviewer's probe
file, with all pending responses tracked and released. After the fix: 31/31 in the page file.

## Repair round 5 (re-review R2, third functional round): route/identity-gated draft store

Round-limit exception: the lead approved this third functional repair round explicitly (two were the
standing maximum), because the R2 re-review found one blocking root with three exit paths.

Re-review of `26f64f68` found `save()`'s completions were route-blind against the single draft slot:

- **F1**: a late successful save from account A called the captured `onSaved` → unconditional
  `resetDraft()` + reload, wiping account B's unsaved draft.
- **F2**: a late 400 refusal from A rebuilt the single slot under A's identity (destroying B's draft),
  and the refusal then vanished: B's view filters A's entry out, and returning to A fired the
  username-keyed reset before the answer could be seen.
- **F3**: a late non-400 failure (toast + `undefined`) took the early return `onDraftChange({busy:
  false})`, again re-seeding the slot under A and wiping B.

Fix: drafts are a per-username store (`usePermissionsDrafts`) held in `AccountEditPage` above
`DataState`. Every completion carries its account identity and writes only its own entry. A successful
save clears its own entry and reloads the baseline only when the route still shows that account
(`routeUsername` ref), so a late success never disturbs the viewed account (the off-route baseline
reconciliation was missing here — see H1 below, fixed in round 4). A
refusal updates only A's entry (selection + error kept), so it is still there when the operator returns.
Route changes prune only clean entries — an in-flight save or an unseen refusal survives navigation; a
plain draft still resets on route change (the R2 behaviour). No session/module registry was added; the
reviewer's module/session-scope ideas were proposals only, and no shared session/API file was touched.

Red-first (each completion outcome): three tests adapted from the reviewer's deferred-response probes
failed against `26f64f68` — late success (F1), late 400 refusal (F2), late non-400 failure (F3) — plus
two controls that already passed (own-save baseline reconcile, sibling reload during a pending save).
After the fix: 36/36 in the page file.

## F4: known pre-existing limit — duplicate-write window on full route unmount

The R2 probe P4 showed: save pending on `/accounts/sam`, navigate to `/accounts` (full page unmount),
back, re-edit, Save — a second `POST` fires while the first is in flight, because the lifted `busy`
dies with the unmounted page. This window is **pre-existing at base `d318fb29` and at `c39dbfc6`**: the
draft store only retains busy state across in-page unmounts (tab switches, sibling-tab `DataState`
reloads), not across a full route unmount, and the lead ruled **not** to build a remount in-flight
marker for this unit. The distinction: tab/sibling-reload busy retention is in scope and covered; the
full-route-unmount window remains, as at base.

## H1: off-route late success left a stale baseline (introduced by round 3, fixed in round 4)

Round 3's guard made a late success skip the reload entirely: it cleared A's entry but never
reconciled A's baseline. Returning to A after its save landed while B was showing still displayed the
pre-save held capabilities; re-editing from that stale baseline re-sent the same grant (probe fact:
`moderateCheckedOnReturn: false`, duplicate write). This defect did not exist before round 3 — it was
introduced by the round-3 fix for F1.

Fix (round 4, lead-approved scope): a save that completes off-route marks its account stale
(`staleAfterOffRouteSave` ref in `AccountEditPage`); returning the route to that account fires one
refetch before the baseline is trusted again. The viewed account's draft/busy/error is untouched, no
unconditional reload unmounts the other account's view, and tab navigation or routes to unmarked
accounts fire no extra request. The reviewer's optional own-key-safe Map change (H2) stayed closed —
no speculative repair.

Red-first: the adapted probe failed against `5fe0cbc1` (`gets()` stayed 1 on return, stale baseline);
after the fix: 37/37 in the page file.
