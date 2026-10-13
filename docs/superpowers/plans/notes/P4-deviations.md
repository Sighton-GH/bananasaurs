# P4 deviations

- Task 1: base NAV differed from the plan's "as is" picture, as the plan allows (P3 moved entries).
  Compared the actual base table against Decision 1 and encoded Decision 1 exactly: Safety,
  Permissions and Logging moved from "Start here" to Moderation; Panels moved to Club and was
  renamed "Role panels"; Schedules moved from Assistant to Club; "Review" became "Review queue" and
  "Audit" became "Audit log". Paths and flags are byte-identical to the base (`/tasks` keeps
  ownerOnly + taskAccess, `/assistant/tuning` keeps ownerOnly, nothing else is flagged). The
  path/label/group/icon table is machine-asserted in `app/routes.test.ts`.

- Task 1: page h1 titles are unchanged. `/panels` still heads "Self-granted roles", `/audit`
  "Audit" and `/review" "Review"; Decision 1 renames rail labels only, and the page sweep is P5.
  The Shell current-page test now carries page title and rail label as separate columns.

- Task 1: the plan says "apply the same to JumpNav", so the sheet rows use the rail's link classes
  (`flex items-center gap-2.5 rounded-control px-2.5 min-h-9 text-body`), replacing the old
  `min-h-11 px-3 py-2 text-base` rows. Added on top, for the owner-deferred 180 CSS zoom "Connected
  apps" + Current badge overflow (2026-10-11 22:37, option 1 deferred to P4): `flex-wrap` and
  `py-1.5` on the row, `min-w-0 break-words` on the label span and `shrink-0` on the Current badge,
  so a long label wraps instead of pushing the badge out. The Current badge and its wording are
  kept. No global overflow hidden/clip. jsdom asserts the class contract only; pixel verification
  belongs to the native checker.

- Task 1: `activeNavPath(location)` is the shared longest-prefix-on-a-slash-boundary rule in
  `routes.ts`. `pageTitle` and JumpNav's exported `currentNavEntry` both consume it;
  `currentNavEntry`'s signature is unchanged, so no external caller breaks. The rail and the sheet
  mark `activeNavPath(location) === entry.path`, so detail routes (`/tasks/abc`, `/automod/id`,
  `/assistant/history/id`) highlight their parent and `/assistant/history/id` does not highlight
  Behaviours. Root matches only exactly; bare prefixes (`/tasksXYZ`) and unknown paths match
  nothing.

- Task 1: the mobile trigger still orients from NAV (not visibleNav), so a detail route under a
  hidden entry names its parent on the trigger without the entry appearing in the sheet; tested.
  This reveals a page name the account could already see in the browser tab; it grants no access.

- Task 1: lucide-react 1.48.0 (installed) was checked in node_modules: all 31 plan icon names
  exist, so none needed the "current name" fallback. `Inbox` and `Search` are aliased a second time
  as `IconReview` and `IconSearchPage` next to the existing `IconEmpty`/`IconSearch`, as the plan
  allows. Icons render through the P3 `Icon` component: decorative (`aria-hidden`), 16 px,
  `currentColor`.

- Task 1: `NavStatus` and the `status` field are removed; no consumer outside the task's files
  referenced them, so no widening was needed. `pages/stub.tsx` and `stub.test.tsx` are deleted and
  the `NOT_BUILT` import and its three assertions left `Shell.test.tsx` (plan Decision 6).
  `rg -n "status: 'built'|NOT_BUILT|pages/stub" packages/dashboard/src` finds nothing. Old page
  names in docs, cli-parity prose and page bodies stay for Task 5.

- Task 1 test counts: baseline app suite 8 files / 100 tests PASS and guard 259/259 PASS before any
  change. RED: 35 failed / 96 passed across the three changed suites (9 files / 131 tests total).
  GREEN: 9 files / 131 tests PASS; with `ui/icons.test.tsx`, 10 files / 133 tests PASS. Guard rerun
  unchanged at 259/259. Mutation checks, each restored byte-identical after the kill: bare-prefix
  matching (killed 2), first-match instead of longest (killed 4), `flex-wrap` removed from the
  sheet row (killed 1), one wrong icon (killed 1).

- Task 1 (fix R1): the P4 plan asks for `text-ink-faint` on the rail and jump-sheet group captions,
  but docs/28 section 7.9 requires 4.5:1 for normal text in both themes. Light `ink-faint` #8a93a3
  on canvas #f8f6f0 is 2.8648:1 (12 px caption), so the plan literal fails the rule. Question:
  plan wording or accessibility rule? Default taken (owner overnight grant, 2026-10-12): the rule
  wins, both captions use `text-ink-muted` (light 4.5+, dark passes); size, weight, case and
  spacing unchanged; no palette or global CSS change. New tests read the actual heading class and
  the real stylesheet tokens (light, no-saved-choice dark, saved dark) and require 4.5:1 against
  the canvas. Found by the independent source review 81ca6f30.

2026-10-12 01:49 PDT continuation: exactfinal8a05aa21 source/tests own four gates PASS: forcedtscbuild+tsconfig.all1408, exactrootlint7serialESLintlegs1280+wholePrettier, allworkspacebuild1408 sevenInterWOFF2, exhaustive108uniqueDashboardfiles1084tests in5serialbatches319+249+217+180+119 plusguard259,225.23s aggregate1024oneworker. Completeoutputsread; knownCSSparse/nodebrowserexternalization/chunkwarnings. DetachedworktreeTS2742 fromsharednode_modules symlinkcrossworkspacepath, no sourcefix; exactcandidateappliednormalleadworkspace forcedrootbuild/allPASS. Fullrootnpmtestnotrun/reused; wave/phasefullsuitependingparentcoordination. Sourcebytesmatchcandidate; originalguard2f8641bc unchanged. FreshR1sourceAPPROVE andactualnativecaption/navscopedPASS, light5.59/dark7.75 allfivecaptions, realheadedChrome100/200both360/1440/lightdark. Lightnarrowallgroup/darkrail/currentConnectedappsfullfocus actualpixelsinspectedlead. Parentowner/taskaccessvisibility andlongestprefixparent currentpreserved, sheetnarrowhscrollfixed. MCPinitialoffscreenCancelsamebase retained. No175/AT/devices/otherbrowser/everycaller/live/Task2-5claim. Onecaptionrepairround; planfaintversusdocs28rulecontrastwinsdefaultdocumentedunderoriginalowner23:04overnightgrant. No tag/push/merge/deploy/main/live.

- 2026-10-12 01:50 PDT, parent decision: run the full root suite once at P4 phase end on the composed tree with a parent-launched runner, not per task. Continue exact typecheck, lint, build and exhaustive Dashboard plus guard per task. Do not call the phase gated before that full-suite result. Recorded as the recommended execution default under Connor's standing overnight decision; no release or live-access permission added.

- Task 2 (breadcrumbs and top-bar search), narrow defaults taken under the owner's standing overnight
  "use your suggestions, document them" grant (relayed by the parent; nothing pushed or merged):
  1. The shell had no account menu. Added a minimal one: the session's `accountId` as text plus the
     existing `DropdownMenu` (More-icon trigger labelled "Account menu for <id>") with one item,
     Sign out, calling `session.logout`. No username, avatar, profile or settings entries invented.
  2. The guild switcher stays only in the rail/jump sheet (`GuildIdentity`); the top bar keeps its
     existing guild name and "Server details". Adding a second switcher would duplicate the
     `Server` label that existing tests query once.
  3. Record titles in breadcrumbs: only Task detail derives its title from the ready resource
     (`data.task.title`, "Task" while loading/error and on the permission-denied branch). The other
     eight headers keep their current titles (rule id, "Moderation case", etc.) because their
     resources are read inside `DataState` below the header and the brief forbids refetching or
     inventing fields; each gets its parent crumb only.
  4. Task detail's permission-denied branch still issues its existing detail request (unchanged
     lifecycle); the denied view never renders the fetched title (tested).
  5. Mobile header gained a second wrapping row (Search icon + account menu) instead of widening the
     grid, so controls reflow at narrow widths. Desktop top bar wraps with `flex-wrap`.
  6. Search/palette is state only (`PaletteProvider`); no dialog or global shortcut until Task 4.
  7. Not run: native pixel checks, full root suite, tsconfig.all. Guard count 259 could not be
     identified by name; `no-raw-colours.test.ts` (114 tests) was run instead. Tests were written
     alongside the code, so there is no recorded RED run; mutation checks below stand in.
  Mutations (all restored byte-identical): removed aria-current (3 killed), wrong crumb href (1),
  palette onClick no-op (2), inverted shortcut hint (first run 0 killed, test added, then 2 killed),
  narrowed platform regex (4).

## 2026-10-12 - Task 2 repair round R1 (bound header wrapping, name loaded records)

- PageHeader: the header row is now `items-stretch` below `sm` (still `sm:items-start`), and the row, title column, h1, breadcrumb nav/list and current crumb carry `min-w-0 max-w-full`. Native check found a 175-char title with a 135-char unbroken token gave a 1706px h1 and a 1722px page at 360 and 180 CSS px; the column-flex `items-start` wrapper sized to intrinsic width. No overflow clipping, truncation or global CSS.
- Titles: Conversation uses the loaded `conversation.title`, Skill the loaded `skill.name` (only when found), the prompt wizard the matching behaviour's `name`. Loading, error, not-found and missing-behaviour states keep the generic title. No new fetches or schema.
- Existing generic-h1 assertions in assistant-conversation and assistant-skill tests were updated to the record names; conversation test now scopes the repeated title by role.

- 2026-10-12 02:24 PDT Task 2 final lead receipt: source/tests byte-identical to approved R1 97dddefd (tree 7e994f1c) before appended receipt. Fresh source APPROVE, actual native scoped PASS: full original175-character title wraps at360/180 CSS in both themes, root client=scroll345/172 and h1 client=scroll313/141. Actual long-title middle/end light/dark and desktop title/action screenshots inspected by lead; real100/200 Chrome360/1440. Three loaded record names and generic loading/error/missing fallbacks verified. Literal top-bar switcher absence accepted under parent's 'as today' interpretation; switcher remains rail/sheet, not a literal switcher-in-topbar PASS. Long account-id sticky-header height and repeated Summary h2 retained as non-blocking caveats; no fabricated empty-string API defect. All PageHeader text-title font-semibold is explicit Task2 plan contract, not accidental global typography.
- Own exact root gates PASS: forced tsc --build + tsconfig.all1408, root lint seven serial ESLint legs1280 + whole Prettier, allworkspacebuild1408 seven Inter fonts, exhaustive112 unique Dashboard files1115 tests in six batches206+373+215+187+113+21 (210.38s), plus true source guard259 in own focused19files478 tests38.95s. All complete outputs read. Initial combined root lint hit120s process deadline during dashboard, no exit recorded; resumed dashboard+rest+config passed, prior daemon/core/storage/http passes retained. Known jsdom CSS parse and build builtin externalization/chunk warnings. Full root suite not run per task, pending composed phase-end parent runner; phase not gated. One repair round; no push/merge/tag/deploy/main/live.

- 2026-10-12 02:25 PDT Task3 preparation: parent confirms recommended defaults under overnight decision. Plan test6 says hold status 'from P3 Banner', but existing P3 shared hold tone maps to alert and warning semantics are assertive. Keep hold/danger alert, document literal plan mismatch, no global semantic change. Preserve model persistent streak, failure catalogue title and since details inside the same models banner alongside new cause summary; do not drop old advisory information or turn models into extra causes. Parent confirmation 02:24:21, local implementation scope only.

> Correction: the Task 3 preparation receipt above and semantic decision below are superseded by the P4 audit repair entry at the end. They describe the historical mismatch, not current behavior.

## 2026-10-12 - Task 3 (one system banner)

> Historical Task 3 semantics below are superseded by the optional-live audit repair. Current SystemBanner holds are polite; shared defaults and danger alerts are unchanged.

1. Plan test 6 says hold banners are `role="status"` "from P3's Banner". The shared `ALERT_TONE` maps `hold` to `role="alert"` (ADR 0142, docs/28 warnings assertive). Kept P3 semantics: danger and hold both alert; tests assert the actual rule. No change to Banner or ALERT_TONE. Literal plan test 6 is not met by design (recorded default, 2026-10-12).
2. `ui/ModelHealthBanner.tsx` is now `useModelHealthWarnings()` (returns `models`, the persistent in-chain rows, and `failingModels`, distinct names) plus `ModelHealthLines`. Same URL, 24h window, session.read, `useLiveResource` 60000/60000/isFast false, 403 silent, `inChain === false` excluded, missing `inChain` included. The streak, since-date and failure-catalogue title are kept in a `<details>` inside the single models cause; models is never a second alert.
3. Models cause text: one model reads `1 AI model keeps failing: <name>.`, several read `<n> AI models keep failing: <first>…` (plan template `<n> AI model(s) keep failing: <first>….` resolved by grammar).
4. The static top-bar link "Safety mode: changes are logged, not applied" is removed. It contradicted a ready `dryRun: false` state. The Shell test now asserts its absence and asserts the real "Preview mode is on" banner for a `dryRun: true` health fixture, placed after the desktop header and before `main`.
5. `safety-unknown` is raised only by a failed health read that is not an offline error (`describeError(error).code`). A ready health with `safety` undefined invents no cause (the old strip did the same).
6. Banner action link gets `max-w-[45%] shrink break-words` so long actions wrap in the flex row; no Banner primitive change. Overflow button toggles `and N more` / `Show fewer` with `aria-expanded` and `aria-controls`; expansion is kept when causes change.
7. `useOnline` reads `window`/`navigator` through narrow structural types (no DOM lib in tsconfig.all).
8. Not run: native pixel checks, full root suite. `useOnline` tests were written together with the hook (no RED); SystemBanner tests had a recorded RED (import failure) before implementation.

## 2026-10-12 - Task 3 repair round R1 (banner action wraps below text when narrow)

- Native check (real Chrome, 360px physical + 200% zoom = 180 CSS px) found cause rows with an action link breaking words mid-word ("Discor/d changes are logged"): the action held up to ~45% width and left a ~80 CSS px text column. Fix is layout-only inside SystemBanner: each cause's text and action now share one `flex flex-wrap` row where the text keeps a readable `basis-32` (8rem) with `grow`; when the row cannot fit both, the action wraps to its own line. `ml-auto` keeps the action right-aligned on wide rows (1440 desktop layout unchanged). No Banner primitive, API, core, permissions, dependency or global CSS change; then-current hold=alert semantics (superseded by the audit repair below), cause order, copy, expand behaviour and the 5-visible/'and N more' rule untouched.
- Durable tests added (the independent source reviewer had probed them without shipping): real user-event keyboard Enter and Space activation of the 'and N more' / 'Show fewer' control, and expanded state maintained as causes shrink to a small set, then empty, then grow back. A jsdom class-contract test pins the wrap/basis/ml-auto layout (pixels remain the native checker's job).
- RED recorded: the layout test failed pre-fix (no flex-wrap container); keyboard and small/empty tests passed on the candidate as shipped (probes promoted to durable tests). Mutants killed, each restored byte-identical (sha256): remove flex-wrap (1), remove basis-32 (1), remove ml-auto (1), expand toggle no-op (5), reset expanded on empty causes (1 - only the new small/empty test caught it).
- Not run: tsconfig.all, full root suite, native pixel checks (per sandbox OOM restriction and scope).

- 2026-10-12 04:36 PDT Task3 integrated original96fe6a49 + R1 exact9fee6e25 (treeb726feaf) separately. Fresh original source APPROVE + R1 delta source APPROVE, actual native R1 scopedPASS. Lead inspected three decisive actual images: narrow180 CSS light kill-switch/full words with action below, dark expanded model body/details/action, wide1440 right-aligned actions. Native 120 measured records report0 mid-word body breaks, full eight config geometry; checker only visually inspected three attached screenshots, 1440/200 pixels not individually inspected, so measurement not blanket pixel claim. Account-menu-open/Jump-dialog not native verified thisTask; earlierTask2 exact native checks remain separate evidence. Health403unknown and model403silent preserved. Safety page dryRun chip horizontal scroll at360 observed outside diff and not verified against base: queueP5. Mobile Overview opener mid-word at180 observed outside banner: Task2 did NOT introduce mechanism, exact row/classes/ThemeToggle/JumpNav unchanged from P3base9aa566886 (Task2 added separateSearch/accountrow). QueueP5 native confirmation/repair, no source-stage reclassification.
- Own exactR1 gates PASS: force tscbuild+tsconfig.all1408, exactrootlint7serialESLint1280+wholePrettier, allworkspacebuild1408 sevenInterfonts, exhaustive112uniqueDashboardfiles1141tests235+365+215+191+114+21 +guard259 in batch1,214.26s aggregate1024oneworker. Complete outputs read; byteidentityverified before notes; knownCSSparse/browserexternalization/chunkwarnings. Original own1138+guard259 alsoPASS; no root suite perTask, composedphase-end parent runner pending. One repair round, durable keyboard/reset regressions added, Banner primitive untouched. No push/merge/tag/deploy/main/live.

- 2026-10-12 04:37 PDT Task4 preparation: parent confirms positive bounded fuzzy-score penalty as the execution default. The plan's literal prefix/subsequence formulas can make real long matching title+hint+keywords score zero or negative, while the interface defines zero as no match. Keep matching scores positive and preserve prefix > word-start > contiguous > subsequence ordering, document the chosen bounded penalty with tests. Task4 implementer already received basef117fe1385; this note is lead-local metadata and must be preserved when integrating the candidate.

## 2026-10-12 - Task 4 (navigation-only command palette)

1. **Fuzzy score: positive bounded length penalty (parent-confirmed default under the original 2026-10-11 overnight decision, 2026-10-12).** The plan's literal `1000 - t.length`, `800 - t.length`, `600 - at - t.length / 10` and `200 - t.length` reach 0 or go negative for long texts (a 1000-character label or a 175/200-character hint plus keywords), and `0` means "no match", so a real match would vanish or rank wrongly. `lib/fuzzy.ts` now subtracts a bounded penalty `max * x / (x + max)` (always >= 0 and strictly below `max`): prefix `1000 - bounded(len, 50)` (950 to 1000), word start `800 - bounded(len, 50)` (750 to 800), contiguous `600 - bounded(at, 25) - bounded(len, 25)` (550 to 600), subsequence `200 - bounded(len, 50)` (150 to 200). Every actual match is positive at any length, the four categories never overlap, and shorter texts still win ties inside a category. Tested at 175, 200, 1000 and 5000 characters.
2. **Item score combines fields without letting a hint beat a label.** Best of: label score, hint score x 0.6, keyword score x 0.75. A short exact query ("task") therefore ranks the Tasks page first, ahead of the New task action and any task whose title or hint merely matches. Display and keyboard order is section order (Pages, Actions, Tasks, Cases, Automod rules, Members), best score first inside a section (stable, so source order breaks ties), at most 8 per section. The plan's "sorted by score then section order" is applied inside the grouped listbox because the ARIA groups and the arrow order must agree.
3. **Palette keeps one focus restore.** Radix Dialog with no Trigger never restores focus itself, so `palette-context` records `document.activeElement` on open and restores it once, from the dialog's `onCloseAutoFocus` (default prevented). A close caused by navigation (`closeForNavigation`) skips the restore so the shell's existing main-focus contract wins instead of racing a stale opener. Callbacks are stable (`useCallback` over refs). The global Ctrl/Cmd-K listener is one capture-phase `keydown` on `window`, ignores Alt/Shift combinations and key repeat, and always calls `preventDefault`.
4. **Loads are keyed by open and session scope, not cancelled by effect cleanup.** Each open gets a run key `<open count>|<guild>|<account>|<owner>|<tasks.manage>`. The effect starts each visible source once per run (StrictMode's second effect sees the same run and does nothing), results apply only while that run is still live and current, and a closed palette, a reopen, an account/guild change or a permission change drops everything. Permission loss while open therefore removes task items and never calls `/api/tasks` for a non-owner without `tasks.manage`. Source errors show only `<Section> couldn't load`; no response body or message is rendered.
5. **Task hint** is `<team name> · <status in words>`; an archived task reads `Archived` (the Tasks page does the same), and a task whose team is unknown shows the status alone. The case hint is the member's display name, then username, else the member id. The status words are a small copy of the Tasks page's map because `pages/tasks.tsx` is touched only to export `Snapshot`.
6. **Kill switch** carries extra keywords (`killswitch`, `stop`, `emergency`) and still only navigates to `/safety` with the hint `Opens Safety`.
7. **Geometry default:** the panel is `fixed top-[12vh] left-1/2 w-[min(640px,92vw)] rounded-panel`, with `max-h-[calc(100dvh-12vh-0.5rem)]` and its own `overflow-y-auto` as a last resort, and a listbox capped at `max-h-[60vh]`. The input row and footer are `shrink-0`; labels and hints wrap (`min-w-0`, `[overflow-wrap:anywhere]`); the footer wraps. This replaces the plan's literal `max-h-[60vh]`-only list, which would clip the footer at 180 CSS px by 450 CSS px. Native pixels are not claimed; the class contract is asserted in jsdom only.
8. **Icons:** no new icon or alias; the UI kit action reuses `IconCommand`, task/new-rule actions `IconAdd`.
9. **Not run:** tsconfig.all and any full-root gate, the full dashboard suite, production dashboard build, native pixel checks.
10. **`palette-sources.ts` keeps structural copies of three `.tsx` shapes.** `tsconfig.all.json` is a Node program without `--jsx`, and it type-checks every dashboard `*.ts` file, so a `.ts` module that imports a `.tsx` one (even `import type`) fails with TS6142 there (reproduced with a scoped config before the change). `palette-sources.ts` and its test therefore import nothing from `.tsx`: it declares `TaskSnapshotShape`, `CaseShape` and `PaletteRead` with only the fields it reads (no invented wrappers or member fields), and `CommandPalette.tsx` asserts at compile time that the real `Snapshot`, `ModCase` and `Session['read']` still satisfy them. A drift mutant (an extra required field on `CaseShape`) fails `tsc --build`. `pages/tasks.tsx` still changes only by `export type Snapshot`. The interface names in the brief (`PaletteItem`, `PaletteSource`, `PALETTE_SOURCES`, `staticItems`, `memberItem`, `score`) are unchanged; `PaletteSource.load` takes `PaletteRead` (identical to `Session['read']`), and `rank` is added to `palette-sources.ts`.
11. Two surviving mutants are equivalent, not gaps: removing only the `liveRun` check in the load settle callback (the `prev.run === run` check and the render-time `loaded.run === run` filter independently drop stale results; removing all three is killed), and removing `preventDefault` in `onCloseAutoFocus` (Radix Dialog never restores focus itself when it has no Trigger, so the call is explicit rather than load-bearing).

## 2026-10-12 05:19 PDT - Task 4 acceptance receipt

- Original 95dfbf5e and repair a8b3cb8e integrated separately; Dashboard source is byte-identical to reviewed/native-checked R1. Lead-local fuzzy default note preserved. Original notes above describe original implementation and its original checks, not the final R1 evidence.
- R1 changes narrow hints to indented full-width stacked rows below 448px listbox width, retaining inline right hints above it; encodes member/task/case/rule route IDs; explicitly sets aria-modal=true; places loading/error outside listbox; adds IME regression coverage. No-results was already outside. Fresh source APPROVE exact a8b3cb8e, five mutants killed, no new findings.
- Native checker scoped PASS exact a8b3cb8e: actual Chrome154/Linux native360/1440 at100/200 light/dark, 180CSS narrow content; readable stacked hints and reachable long rows, no horizontal overflow, focus restoration/navigation-main behavior, AXmodal/listbox/status, keyboard/Tab/odd-ID URLs. Lead inspected actual decisive contact-sheet pixels and full360/200light task-bottom image. Remaining native statements are checker-reported, not lead session evidence; no actual AT announcement, macOS/phone/other browser/175% or universal phase check.
- Own root forced project build and tsconfig.all1408 PASS, seven serial root ESLint legs1280 and whole Prettier PASS, all-workspace build1408 PASS7Interfonts. Exhaustive115unique Dashboard files1216tests291+329+249+193+123+31, plus unchangedguard259, six serial one-worker1024batches212.64s PASS; complete successful outputs read. Known CSSparse/browserexternalization/chunk warnings retained. No source/test/config edits for green. Full root suite reserved for composed phase end via parent runner, NOT complete.
- Reviewer P3 case-label question closed as plan interpretation: original plan uses Case first8 ID with member hint; current displayName/username/id hint follows it. No new user question. Astral-codepoint subsequence issue was carried unchanged as low at Task 4 acceptance; superseded by the P4 audit fuzzy repair below. Original native failures fixed by R1; source-only class assertions corroborated by native pixels.
- Parent selected/confirmed bounded scoring under original owner's overnight documented-default grant. File metadata is not approval evidence. No push/merge/deploy/tag/main/live Discord/account effects.

## 2026-10-12 - Task 5 (guide and docs page names)

1. **Guide source is `packages/core/src/guide/topics.ts`** (docs.tsx only renders `GUIDE_TOPICS`). Changed: the `dashboard-pages` summary and body now say "rail" and list the real groups (Club, Moderation, Assistant, Messages, System); seeAlso and bold bullets use the NAV labels Review queue and Audit log; the role-panels topic title, body and seeAlso say Role panels. Topic groups ('Start here', 'Server', ...) are topical grouping, not the rail, and are unchanged.
2. `cli-parity.ts` line 276: "Self-granted roles page" became "Role panels page". Nothing else in that file changed.
3. `docs/28` §7.8: the five group names were already correct and are kept. Added the exact palette member-limit line.
4. `docs/STATE.md`: P4 summary added at the top (dated 2026-10-12, no merged/deployed/live claim). It also names the safety-status-unknown banner cause, which the plan text omitted but SystemBanner implements.
5. Tests: new `guide page names` describe in `docs.test.tsx` (see-also labels equal NAV labels, rail group sentence built from `GROUPS`, no 'Self-granted roles', Review queue/Audit log bolded) and one case in `cli-parity.test.ts`. Existing assertions untouched.
6. Classified, not changed: historical ADRs 0059 and 0076 and `docs/reports/*` ('Advanced / System', 'Start here' headings); `Review`/`Self-granted roles` hits in dashboard page headings, buttons and tests (panels.tsx, permissions.tsx:657, review.test, panel-builder.test, Shell.test negative controls, overview-pulse linkText 'Review') are P5 or non-page strings.
7. **Left for P5/follow-up:** `cli-parity.ts` `page:` values are stale or non-NAV names (Review, Audit, Jobs, Providers, Reaction roles, Connector, Automod rule and others); not tested, outside this task's brief. Guide copy "Teams & members" and "New task" name sub-pages, not rail pages, and are correct. Topic text 'the Tasks page' is unchanged and matches NAV.
8. Obsolete search `rg -n 'StateStrip|ModelHealthBanner\b' packages/dashboard/src`: residual matches are an import in SystemBanner.tsx from the retained hook file and migrated test describe labels in SystemBanner.test.tsx. No component use.
9. Not run: full root test, tsconfig.all, full Dashboard suite, build beyond what is recorded in the report, native browser walkthrough.

## 2026-10-12 05:42 PDT - Task 5 acceptance receipt

- Original c4d3f021 plus R1 7872a7ab integrated separately; full seven-file original and six-file repair bytes exactly match accepted candidate before metadata. Guide data's actual home is core/src/guide/topics.ts; pure strings only, API/routes/logic unchanged. Core guide+MCP drift/tools52 tests PASS. All old assertions retained.
- Fresh original source CHANGES identified current operator doc names; parent-selected R1 default fixes SMOKE_TESTS, webui-capability-map and ROADMAP references, palette continuation indentation, STATE members-by-ID and adds system-summary assertion. Fresh R1 source APPROVE. Summary test is a regression guard passing on c4 base, killed by an Audit-page mutant, NOT RED-first. Original five tests were RED/GREEN; reports distinguished them.
- Own final R1 force project+alltypecheck1408, seven rootESLint1280+wholePrettier and allworkspacebuild1408 PASS. Whole115uniqueDashboardfiles1222tests292+329+254+193+123+31 plus unchangedguard259 PASS in six one-worker1024 batches215.81s; complete outputs read. Known CSSparse/browserexternalization/chunk warnings retained. No source/test/config edits for green. Final R1 coreGuide+MCP52 PASS.
- Current P5 leftovers: panels.tsx and permissions.tsx Self-granted roles; automod-rule.tsx:302 Review page; cli-parity page values legacy labels; capability-map Connector/Providers/Cutover names need source mapping, not blind replacements. Historical ADRs/reports/design, observability plan past-state gap table and non-user-facing jobs/automod comments preserved. Old-component grep is hook import plus migrated describe labels only, no old component use.
- Parent full-root runner and composed native regression are on c4d3f021; R1 delta only docs and one additive test, production bytes unchanged. These checks remain pending; no phase completion or universal native PASS. Once runner finishes its original counts must stay tied to c4 and not relabelled R1. Lead R1 exhaustive tests separately cover additive summary test.
- Parent decision documented under original overnight default scope; no approval taken from file metadata. No push/merge/tag/deploy/main/live Discord/account actions.


## 2026-10-12 - P4 audit repair: Banner announcement ruling

- The composed audit found the Task 3 decision above contradicted Connor's original WhatsApp ruling (2026-10-11 12:51:43 PDT). That original message was recovered directly, with the preceding question, before this repair. Historical receipts remain above but are superseded on announcement semantics.
- Extra shared-file edit: `packages/dashboard/src/ui/Banner.tsx` now accepts optional `live?: 'polite' | 'assertive'`. Absent preserves the P3 tone table exactly, including hold = alert; polite selects status and assertive selects alert. `ALERT_TONE`, styling and default callers are unchanged.
- `SystemBanner` opts into polite only for hold causes. Offline, kill switch and breaker retain alert. Model detail text, cause order, five-visible limit, expansion and keyboard behavior stay unchanged. Added one Banner override regression and corrected SystemBanner role counts without dropping text or behavior assertions.
- Initial RED: Banner/SystemBanner 31 tests, 8 failures against accepted source. First GREEN attempt exposed two unscoped status queries matching the session provider's unrelated live region; queries were scoped to System status. Final GREEN: 31/31; ignore-live, remove-opt-in and danger-polite mutants all fail and restore byte-identical. A first scoped compilation rejected explicit `live={undefined}` under exact optional property types; danger rows now omit the prop entirely and compilation passes. Detailed receipts are in the repair report. Scoped gates only; full-root and native/assistive-technology checks are not claimed.


## 2026-10-12 - P4 audit repair: astral fuzzy subsequences

- The composed audit's P3 issue is fixed in `packages/dashboard/src/lib/fuzzy.ts`: both sides of the subsequence comparison iterate Unicode code points. Prefix, word-start and contiguous matching, folding, score categories and length penalties stay unchanged.
- Regression covers an astral-leading query, an internal astral code point, two different astral code points, BMP control, missing final point, repeated-emoji nonmatch and prefix-over-subsequence ranking. Test was RED on the accepted matcher (`score('😀a', '😀xxa')` returned zero) before production edits.
- The historical Task 4 low-issue receipt and PROGRESS entry are not current limitations. Scoped GREEN, mutant and byte-identical restore receipts are in the repair report. No new dependencies, network destinations, permission, guild, database or Discord changes. Full-root and native checks remain unclaimed.

## 2026-10-12 05:43 PDT - Composed native receipt, root runner still pending

- Composed native checker PASS c4d3f021 exact originalTask5, all8 native360/1440 Chrome154/Linux100/200light/dark localGET-onlyfixture. R1productionbytes unchanged. Report includes rail/sheet currentcaption/permissions/detailparent, longheader/crumb/account reachability, bannermax5/expand/offline/unknown/modeldetails/Jump-to-mainfocus, palette-over-sheet layering/Escape/Tab/routes/stackedlonghint, renderedGuidecopy. No AT/macOS/phone/otherbrowser/175%, no live production claim.
- Lead read full report and inspected actual narrowbanner/palettecontactsheet, narrowlightcurrentcaption, narrowdarklongheader, Guidenarrowrail-copy, darkdesktoprail and narrowSafety180 pixels from transferred17MB evidencezip. Verylong175char account makes stickyheader tall; this is retained reachability caveat, not a new regression. FixtureCases InvalidDate due missing openedAt is not production evidence.
- Guide palette member-limit line is required in docs28§7.8, not the rendered Guide; no missing Task5 requirement. START HERE is intentionally preserved topicalGuidecategory, not stale rail. Switch-from-sidebar wording can be P5terminologypolish. Safetyhorizontalpagebar reproduced at180CSS, not360/100fixture; prior360Safetychipreport remains separate/baseunverified. Overview180trigger wordbreak persistsP5.
- Whole-phase native is scoped PASS, not release approval. Rootrunner and finalcomposedaudit remain pending; no phasecompletion yet.

## 2026-10-12 05:50 PDT - Composed audit correction and prerepair root receipt

- Composedsourceaudit4e610f55 CHANGES: missing exact originalowner12:51:43PDT2026-10-11 WhatsApp ruling. Lead recovered original+precedingquestion itself: optionalsharedBanner.live polite/assertive, absent preservesP3holdalert; SystemBannerholdpoliteonly, dangeroffline/killswitch/breakeralert; exactBanner/SystemBannerregressions and log. Earlierparentkeepalertdirection/Task3note is superseded, not authority to ignoreowner. PendingseparatephaseR1 implementer on4e610f55. Historicalgreenroleassertions/native/gatereceipts validate oldtree only and do not satisfyownersemantics. Astralfuzzysubsequence issue introducedP4 (not inheritedP3), pendingboundedcodepointrepair in samephaseR1.
- Prerepairrootrunner exactc4d3f021 PASS: npmci-ignore-scripts0/forcedtsbuild14080/tsconfig.all14080; fullroot Vitest npxvitest run --pool=forks --maxWorkers=1 --no-file-parallelism1408 472files9321tests0,1125.88Vitest/1127wall. Notliteralnpmtest, samevitesttarget; initialunsupportedminWorkersfailedbeforetests then corrected, noOOM. Lead readfull722lineoutputgzip, knownmainCSSparsewarnings. ThisisnotfinalR1fullrootreceipt; parentarrangingnewrunnerafterphaseR1.
- Finalphaseownrootgates, fullrootrunner, freshsourceaudit and nativeAX/defaultBanner/fuzzyregression required afterrepair. NoP4completion/P5start/release/live.

## 2026-10-12 06:23 PDT - Final P4 acceptance

- Two audit repairs integrated separately with exact35cbf83b production/test/STATE identity; final differences are only historical/corrective/acceptance notes. Source re-audit APPROVE scoped, noP1/P2, five mutants killed, absent Banner.live trees identical on all tones and50kBMP fuzzy pairs unchanged. Cosmetic long comment retained to preserve verified source; Task3heading pointer added metadata-only.
- Final ownrootforce/alltypecheck1408, sevenrootESLint1280+wholePrettier and allworkspacebuild1408 PASS.115uniqueDashboard1224tests293+329+254+194+123+31 plusguard259 sixserial1024oneworkerbatches210.98sPASS; completeoutputsread. EarlierR1coreGuide/MCP52pass retained, fullrootincludes them. No changesforgreen.
- Final independentrootrunner exact35cbf83b Node22.23.3 heap1408: ci-ignore-scripts0, forcedtsbuild0(33s), tsconfig.all0(32s), directrootVitest --pool=forks --maxWorkers=1 --no-file-parallelism0 472files9324tests946.20Vitest/948wall, literalnpmrunlint0(165s), literalnpmrunbuild0(69s) includes bothtypecheck passes+allworkspaces. Lead read complete622lineVitest and allci/lint/build/emptytslogs fromretainedarchive. Notliteralnpmtest, sameVitestroot target. KnownmainCSSparse/buildnodeexternalization/chunk and two install deprecationwarnings; no failure/OOM. Priorc4rootreceipt historicalonly.
- Final native35cb scopedPASS realChrome154/Linux8native360/1440light/dark100/200. AX/DOMholdstatus/dangeralert/offlinealert and defaultkitroles corroborated in records; expand/Jumpfocus/palettekeyboard/trap/routing/astralsubsequencePASS. Lead inspected actual180light hold, darkmixed and astralpalette PNGs plus records. Emoji glyph tofu onLinuxfixture is font/environment caveat, not matcherfailure. NoactualATspoken/macOS/phone/otherbrowser/175/liveclaim.
- P4Tasks1-5 and repairs complete for local handoff, not deployment. RemainingP5page-sweeplimits: Overview180wordbreak, Safety180hscroll (360/100notreproducedfixture; earlier360drychipbaseunverified), longaccountstickyheight, oldpageheading/capabilitymap/cli-paritynames, Guide sidebarword polish, historicalConfirm136/Tooltip390 and MCPinitialoffscreenCancelbase. No change to audience/authority. No push/merge/tag/deploy/main/liveDiscord. P5notstarted; awaitparentconfirmation.
