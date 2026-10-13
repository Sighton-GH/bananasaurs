# P5 unit 3 (AI setup) — notes and deviations

Base: d318fb292577a15c56a506e490e0f77e87a35d5c. Branch oc/p5-u3. Owned: providers.tsx/tests, pages/ai-setup/**, this file.

## Commit 3a — move only

- `pages/providers.tsx` split unchanged into `pages/ai-setup/{index,summary,model-order,keys,web-search,github,terms}.tsx`.
  Original-path `pages/providers.tsx` retained as a one-line wrapper re-exporting `ProvidersPage` exactly;
  consumers (Shell.tsx, model-health.test.tsx) untouched.
- File placement choices: `ChecklistSection` → summary.tsx (replaced by status badges in 3b); `ProvidersSection`
  stays with `KeysSection` in keys.tsx (plan: Keys tab = API keys + Providers); `TermsForm`/`TermsCard` → terms.tsx
  (keys.tsx imports `TermsCard`); eligibility-warnings table + review dialog stay in index.tsx until 3b moves them
  into the Terms tab.
- Move-only evidence: original body lines 54–1968 vs concatenated new-file bodies, import blocks stripped, blanks
  dropped, sorted — diff empty apart from the `export ` markers on moved functions. Each new file's import block
  was pruned to the identifiers its body uses (type markers preserved); Prettier reflowed imports only.
- providers.test.tsx moved to pages/ai-setup/providers.test.tsx with only relative import path updates
  (`../x` → `../../x`, `./providers.js` → `./index.js`). No assertion changed.
- terms.tsx: unused `providerName` value import dropped (a same-named prop exists; the import was genuinely
  unused in the moved code); `PROVIDERS` kept as `type PROVIDERS` (used only in a `typeof` position) per
  consistent-type-imports. Both are import-line-only changes, no body change.
- Gates at 3a: tsc --build --force PASS; tsc -p tsconfig.all.json PASS (needs NODE_OPTIONS=--max-old-space-size=1400
  on this 1 GB box — default heap OOMs on the whole-program check); eslint packages/dashboard PASS; prettier check
  PASS; vitest ai-setup/providers.test.tsx + model-health.test.tsx 49/49 PASS; wider consumer set
  (assistant-failures, assistant-resources, pages, Shell) 152/152 PASS run pre-prettier, re-confirmed at commit.

## Commit 3b — sweep: tabs, status summary, terms extraction

- Header purpose now "Which AI models answer, and the keys they use." (plan wording; replaces the older sentence).
- Setup checklist replaced by `SetupSummary` (summary.tsx): at most four badges linking to their tabs.
  Counts from data the page already loads: Models ready = chain rows with status `ready` (actual chain
  status, not row count); Keys saved = setup.keys; Web search = assistant.aiStatus.webSearch.enabled —
  a ready assistant resource without a webSearch block reads as Off, matching the WebSearchCard's existing
  `?? false`; only a missing/failed assistant resource shows "unavailable". Terms to check = rows of the
  existing /api/providers/eligibility warnings resource (backend-computed, nonduplicating; covers
  unverified/stale/not-no/not-production). A failed warnings resource shows "unavailable", never 0.
- Tabs Model order / Keys / Web search / GitHub / Terms in `?tab=`; default `keys` when no key saved else
  `model-order`; an explicit valid query wins; invalid values fall back safely. Tab switches keep the current
  route, unrelated query params and the hash; Back works (one history entry per activation — Radix
  automatic activation also navigates on arrow-key focus, a documented consequence of the kit Tabs).
- Terms tab: new `TermsSection` (terms.tsx) holds the Terms record cards (moved out of ProvidersSection —
  no duplication) plus the "Service terms to check" table and the review ConfirmDialog with its request,
  toast and scope text byte-identical. REASON_TEXT/trainsTone moved index → terms.tsx.
- May-train prominence: ProvidersSection keeps its per-provider terms sentence (including MAY_TRAIN_COPY)
  in the Keys tab, and a `hold` InlineAlert sits above the tabs whenever the warnings resource lists rows,
  calling out "may train on your data" when any row is not training-free, linking to the Terms tab.
- TermsCard copy reconciled with ADR 0062/backend (wording only, gating untouched): old "The assistant
  stays off unless they say it doesn't train" overstated the block — may-train is disclosed, not blocked.
  New: "The assistant stays off until the terms are recorded; a service whose record says it may train
  stays available by the owner's decision and is flagged with warnings."
- ProvidersSection props reduced to `setup` (providerTerms/isOwner/onChanged moved to TermsSection with the
  TermsCards). No request, guard, masking, ordering or dialog text changed.
- Selector changes in tests (assertions unchanged): 20 existing tests open their tab first via `openTab`
  (Radix activates on mousedown); the six-sections-order test now asserts the five tabs and per-tab
  headings; the two checklist tests now assert summary badges + fresh-install lands on Keys; an afterEach
  resets the URL to /providers since tab state lives in the query string.
- RED witnessed before implementing: 6 of 9 new P5-3b tests failed on the 3a tree (tab defaults, Back,
  badges, None ready, terms extraction); 3 passed vacuously (invalid-query default, no-guess-on-failure,
  may-train outside tabs) and now pin the new behavior.

## Commit 3 (fix) — keep visited tabs mounted (source review P2)

- Independent source review of 6746e344 found one P2: the kit `TabPanel` unmounts inactive panels, so
  tab switches destroyed all five sections' unsaved drafts and reissued mount-time requests
  (model discovery POST + health GET, search-key GET) on revisit.
- Repair (lead ruling): lazy-persistent panels. A section mounts on its first visit (lazy request
  behavior from 3b preserved), then stays mounted with `hidden` while inactive via a local
  `KeepAlivePanel` (role=tabpanel, aria-label) in index.tsx. The kit `Tabs`/`TabPanel` is shared and
  untouched; no state lifted into new shared primitives. No automatic draft save, no persistent
  secret storage. URL/query/hash/Back behavior unchanged (control test kept from the reproducer).
- Note: Radix triggers' generated aria-controls ids no longer point at Radix Content (kit Content
  not used for these panels); panels carry role=tabpanel + aria-label instead. Flagged for the
  native composition pass.
- Regression tests: `tab-drafts.test.tsx`, adapted from the reviewer's bug-witness reproducer with
  the 7 bug expectations INVERTED (preservation / exactly one call) — witnessed RED (7 failed,
  control passed) on 6746e344 before the fix, 8/8 green after. The control (unrelated query, hash,
  real Back) is unchanged.

## Commit 3 (fix round 2) — restore the trigger/panel relationship

- Re-review of the first fix found KeepAlivePanel's plain div left each Radix trigger's aria-controls
  dangling and dropped the kit's tabIndex=0/focus baseline. Repair (lead, matching 6b persistence):
  local Radix `Tabs.Content` with `forceMount` inside the existing visited guard, explicit
  `hidden={!active}` (forceMount alone keeps inactive panels present), `tabIndex` 0 active / -1
  inactive, kit's `focus-visible:outline-accent` class. Shared kit untouched; no new dependency
  (`@radix-ui/react-tabs` was already the kit's dependency). Draft/request lifetime unchanged.
- Red-first: new test asserts every visited trigger's aria-controls resolves to a tabpanel with
  reciprocal aria-labelledby, tabindex 0/-1 and hidden state per selection — witnessed failing on
  the first fix ("no panel with id radix-...") before the repair, green after.
