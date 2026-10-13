# P5 unit 4 (Behaviours) notes

Base d318fb292577a15c56a506e490e0f77e87a35d5c. Branch oc/p5-u4. Shared notes untouched.

## 4a: move-only

`pages/assistant.tsx` (1406 lines) split unchanged into `pages/behaviours/`:
`create.tsx` (TAG_SURFACES, CreateBehaviourForm), `access.tsx` (BehaviourAccessEditor, TicketsCard,
DecisionsCard), `settings.tsx` (BotTagCard, LogChannelCard), `prompt.tsx` (BehaviourPromptCard),
`try.tsx` (preview panel, AnswerText, TryItBox), `index.tsx` (AssistantPage, AssistantReady).
`assistant.tsx` is now a wrapper re-exporting exactly AssistantPage and TryItBox. Original
`assistant.test.tsx` retained at its path and unmodified. Only changes: `export` added to cross-file
components, import paths and import formatting (Prettier).

Comparison: after dropping import lines, blank lines, indentation and the `export` keyword, the sorted line
multiset of the old file equals that of the new files, except the wrapper's own header and re-export lines.

## 4b-1: detail component (not routed)

Added `behaviours/detail.tsx` (`AssistantBehaviourDetailPage`) and `detail.test.tsx`. Resolves `:id` against the
same `GET /api/assistant` snapshot; an unknown id renders NotFound ("This behaviour doesn't exist or was
deleted", Back to behaviours) and never the first behaviour. Tabs Prompt / Access / Try it from `?tab=`
(unknown value means Prompt; choosing a tab pushes `?tab=`). Prompt tab shows a read-only CodeBlock labelled
"Full prompt" with the saved instructions (no new endpoint) above the unchanged prompt editor; the compiled
preview endpoint is not used here. Existing prompt/access/ticket/try components are reused unchanged, keyed
`prompt-/access-/try-<id>`. Enable/disable stays the explicit button with the same whole-object PUT.
Route is NOT registered: see the separate route patch (wizard route stays before `:id`).
Red: test file failed to import `./detail.js` before the component existed (all 8 tests absent).
Test expectations omit `guildId` from PUT bodies exactly as the existing assistant.test.tsx assertions do.

## 4b-2: list sweep, tab fixes

- `/assistant` is now PageHeader + `New behaviour` (dialog) + URL tabs `Behaviours` (default, DataTable
  Name link / Who can use it / Skills / Status) and `Settings` (BotTagCard, LogChannelCard, DecisionsCard). The
  inline selection cards and per-behaviour editors left the list; they live on the detail page. Who can use it:
  allowlist absent shows "Not shown by this server", empty shows "Nobody yet" (fails closed), never "everyone".
- Row links point at `/assistant/behaviours/:id`, which works only once the lead registers the route.
- New behaviour: domain-local Radix dialog (`create-dialog.tsx`) around the UNCHANGED `CreateBehaviourForm`; the PUT
  create body and disabled default are unchanged; on success it reloads and navigates to the new detail URL (a
  deliberate internal navigation, not covered by the unsaved guard). FormSections are NOT adopted inside the form
  yet (deferred, form markup untouched to keep the body and tests byte-stable).
- Tab URLs: choosing a tab keeps every other query field and the hash (built from the real browser location).
  Panels are visited-mounted (`tab-panels.tsx`, Radix Content forceMount + hidden): a draft, a pending write or a
  Try answer survives tab flips; unvisited tabs render and load nothing. Detail tab bodies reset per behaviour id.
- Compiled-prompt preview (existing `/preview` endpoint, on click only) moved to the detail Prompt tab.
- Test migration in `assistant.test.tsx`: tests that drove the old inline editors now render the detail route or
  the list; every request URL/method/body assertion is unchanged. Create button label changed from
  "Create a behaviour" to "New behaviour" as the brief asks; the create form's own heading is unchanged.
  Removed assertion: `aria-pressed` card selection (the list has no selection state now). Tickets card and
  per-behaviour access moved to detail Access; guild-level decisions moved to Settings.

## 4b-3: SaveBar/guard, sticky reload, FormSections

- Settings drafts (bot-tag choice, log channel) are now controlled fields with one SaveBar (dirty count = changed
  fields, Discard, busy) and `useUnsavedGuard`. No bulk API: Save sends one request per changed field, in this order:
  `PUT /api/assistant/bot-tag {behaviourId}` (via writeOrThrow, 400/409 shown inline as before), then
  `PUT /api/assistant/log-channel {channelId}` (via write). A failure never blocks or undoes the other: the saved
  field reloads as the new baseline, the failed one stays a draft with its message. The second request is attempted
  even if the first fails (they are independent settings); documented choice. Per-card Save buttons removed.
  The bar sits outside the tab panels so a dirty Settings draft stays visible from the Behaviours tab; the guard
  covers in-app anchors and real unload only (not Back or programmatic navigation, no claim made).
- Found while testing: `useResource.reload()` flips to loading, which unmounted the whole page body and would drop
  drafts and error state after any save. `behaviours/sticky-resource.ts` keeps the last data on screen during a
  reload (first load and failed reloads unchanged), used by the list and detail pages.
- Create form now uses FormSections (Basics, Instructions, Skills it may use, Who may use it). Field set, labels,
  regions, PUT body and disabled default unchanged.
- Test changes: bot-tag/log tests press the SaveBar Save instead of per-card buttons; "Save disabled when clean"
  became "no save bar when clean". Added navigation tests (list row link to detail, create lands on new URL).
- Red witnessed: before the sticky fix the partial-failure test (refused bot-tag message lost) and the guard test
  failed; the guard test failure was a wrong role (`alertdialog`, the dialog is `dialog`), a test fix.

## Fix round (review of 7b3eeb7e)

- B1 prompt draft vs reloaded revision: `BehaviourPromptCard` now remembers the revision and text its draft started
  from. If the revision moves while the user has real unsaved edits that differ from the latest, Save is blocked,
  the draft is kept, and the user chooses "Use the latest instructions" or "Keep my text on the latest revision"
  (re-bases the draft, then Save sends it with the current revision, deliberately). An unedited or converged draft
  follows the reload silently; an ordinary toggle/save reload that does not move the revision never touches a draft.
  `BehaviourAccessEditor` is last-write-wins by design (no version check); unchanged, recorded only.
- B2 sticky cache identity: the loader stamps data with `account|guild`; stale-identity data is treated as loading
  (also for the one render where `useResource` still reports the old result after a session change); an error
  forgets the cache. Settings drafts are cleared on an identity change because they belong to the old guild's
  settings; this is deliberate and documented, not silent leakage into the new guild.
- S1 Settings save: a saved field advances the baseline immediately (kept as "applied" until the reload shows it),
  so it is clean and cannot be re-sent while the refresh is pending; only a failed field stays dirty. Drafts and
  the unsaved guard now live above the data boundary: a reload that errors keeps dirty drafts, shows "You have
  unsaved Settings changes. They are kept and come back when the page loads", and they return on retry.
- S2 (not changed): URL tabs use the shared Tabs with automatic activation, so arrowing through tabs pushes one
  history entry per tab. At d318 the only Tabs user is the /kit page with local state (no history entries), so
  there is no base precedent for URL-driven tabs; the shared kit is out of scope for this unit.
- Record-only lows: a reload error no longer loses Settings drafts (now kept) but still replaces the page body with
  the error state; the create dialog's Cancel/Escape stay enabled during an in-flight create; the detail page
  title is the behaviour name (the document title is the Shell's).

Fix round 2 (re-review of 85356584)

- Correction to the round-1 B1 note: the claim that "an ordinary toggle/save reload that does not move the revision
  never touches a draft" was only true of a stub. The real server bumps promptVersion on every behaviour write
  (toggle, access, prompt). The prompt card now treats a bumped version with unchanged text as no conflict: it
  re-seeds the version only and keeps the edited draft. A conflict needs the latest TEXT to differ from the seed
  AND the draft to be edited and differ from it. Tests bump the version on toggle and on access save.
- After the card's own successful save, Save stays off until the reload shows a newer revision (no resend of the
  old promptVersion). A failed save keeps the draft and Save available.
- The 409 toast no longer promises retention across a failed reload: "Nothing was saved. Your text stays on screen
  while the latest revision loads, unless that load fails." If the reload errors the card unmounts and the prompt
  draft is lost (only Settings drafts live above the data boundary). Recorded, not changed.
- Conflict preview uses the kit CodeBlock (label "Latest instructions", with Copy).
- Settings: the "applied" overlay is cleared when a reload lands after this page's own save, so a value another
  admin changed first is shown; still-unsaved failed fields stay drafts. If the refresh fails, the saved value
  stays shown. An unrelated reload landing between the PUT and its own refresh would clear the overlay early.
- Record-only, unchanged: S2 arrow-key history entries, the lows, and that a guild/identity switch silently
  clears Settings drafts (they belong to the old guild).
