# P5 deviations and decisions

## 2026-10-12 - Execution setup

Base: accepted P4 7cfb4e64967475246fa8c6c88ff4a1dbbcaf181e. Local handoff only; no push, merge, tag, deploy, main changes or live Discord. P5 preparation started after phase confirmation.

Execution defaults, documented before implementation:

- Work sequentially in plan order, retaining move-only then sweep commit boundaries for large pages. Task6 and7 page groups are separate bounded work units, not one rewrite. Two repair rounds per unit; further scope/round changes require coordination.
- Shared form-only Task1a can proceed while Task1b real Discord-card renderer and Task2 task links/preview dependencies are reconciled. Current P4 branch has no renderTaskCard, core/ui/discord or taskLinksSchema/task_links. Do not invent an alternative renderer, new task-link API or incompatible migration on this branch.
- Preserve all fetch URL/method/body, permission, reauthentication, confirmation scope and CSRF assertions unchanged. Any necessary difference is an explicit deviation, never a test weakened for green.
- Field error hook returns the server's DescribedError.fields problem text; it must not replace it with generic PROBLEM_TEXT enum fallback. Do not clear input on a rejected write.
- Unsaved guard covers the specified same-origin in-app anchor clicks and beforeunload; modified/new-tab/download/external/hash-only clicks are not intercepted. No new history/popstate or unrelated routing authority is implied. Same-page links preserve query/hash semantics. Programmatic navigation and Back coverage must be reported, not claimed without tests.
- Keep shared ConfirmDialog defaults intact. The proposed optional cancelLabel permits Stay in the unsaved guard while all existing callers still read Cancel. Review this additive change independently; no silent universal cancel-label change.
- Historical136character ConfirmDialog action simultaneous-visibility and390token Tooltip top overflow are P5 repair targets, not prior native passes. Prior owner deferral is not approval to leave them broken after the sweep.
- Safety180CSS page overflow and Overview180CSS opener word break must be reproduced at base and repaired in the relevant units; earlier360Safetychip report remains unverified. Do not globally clip the page to conceal overflow. Long account-header height and MCPinitialoffscreenCancel remain measured limits to recheck.
- Map Self-granted roles/cli-parity page labels/capability-map/stale Guide/sidebar/palette words to current routes and permissions, not blind replacements. Preserve historical ADRs/reports and intentional START HERE topical category. AX observations are scoped DOM/browser evidence; no screen-reader speech, macOS/touch or unsupported zoom claim.

Open execution decisions: accepted Track-A P1 dependency transfer for Task1b/2; whether full-root test runs remain per-unit as the P5 plan requires or have an explicitly coordinated phase-end cadence. No override inferred from P4's separate cadence.

## 2026-10-12 - Dependency composition and gate cadence

- Parent supplied accepted P1 full-history tip4737d0b45604c89379e7ef61d3ec86ce76b83f4e. Local no-fast-forward merge into P5bootstrap preserves P4final7cfb4e64 and accepted P1 history. Only merge conflicts: STATE prefix and add/add PROGRESS. Both phase STATE paragraphs and complete ledgers retained. Guide topics/task-detail/source+tests auto-merged; overlapping source inspected separately. This P1+P4 composition is a new integration product, not yet reviewed by Connor. Existing P1migration0107 and dependencies are imported P1 scope, not newly authored P5changes.
- Updated execution default: scoped gates per P5unit; one full-root suite at phase end using an independent runner. A unit touching shared core/runtime requires per-task full-root runner; notify before dispatch. Per-unit root typecheck/lint/build and exhaustive Dashboard plus relevant dependent suites remain required. One heavy gate at a time, complete logs inspected. This explicit P5cadence supersedes the earlier pending per-unit root-test obligation in execution notes/brief.
- Import-graph/new-browser-node-warning comparison for preview and honest runtime-Zod export treatment accepted as plan conflict handling. Dependency absence recorded above is historical and resolved by the composition, subject to validation.

- Task1a native-default update: SaveBar/guard checked at their first actual consuming page rather than synthetic harness. Planned first consumer is Task4 Behaviours settings, then Task5 Configuration; no native-readiness claim for1a until that evidence. Task2 field-error/preview native checks remain separate.
- Composition1e0c3791 independentmerge-only source review APPROVE/noP1P2, ownroot typecheck and323focusedtestsPASS; sevenfullESLintlegs+wholePrettierPASS. Literalrootlint/build foregroundattempts interrupted, noPASS attributed; separateworkspacebuildPASS includesP1cardgraph baseline node:vm fromautomod/predicates/regex.js pluscrypto/net externalization,13warnings and chunksize. Newvmwarning precedes1bpreview, no shim. Independentfullrootrunnerpending.

## Task 1a - Shared form foundations

- Task 1 is split: this unit adds FormSection, SaveBar, useFieldErrors and useUnsavedGuard only. DiscordCardPreview remains Task 1b, blocked on the accepted P1 renderer/link dependency. No task page, renderer, server, route, error catalogue or dependency change.
- Outside-plan primitive edit: ConfirmDialog gains optional cancelLabel, defaulting to Cancel. Only the unsaved guard requests Stay; all existing callers keep their copy and behavior. Its default-label, busy, Escape, backdrop, focus restoration and SSR tests are retained.
- useFieldErrors preserves server problem strings verbatim. A describeError conversion failure for an unusual thrown value is treated as no field errors and clears stale state, without changing the error catalogue.
- Guard scope: capture-phase root-relative same-origin path anchors plus beforeunload while dirty. Modified clicks, non-left clicks, other browsing targets, downloads, external/protocol-relative/hash-only links are untouched. Same-path query/hash links are guarded and preserved. Programmatic navigation and browser Back are not guarded. The first pending link wins until Stay or Leave; repeated confirmation cannot navigate twice.
- Scoped execution cadence explicitly assigned for this unit: Node 22.23.3, heap 1408 MiB, one heavy gate at a time via nohup/poll. Run npx tsc --build, focused tests (one worker), changed-file Prettier/ESLint. Full-root npm typecheck/lint/test/build and tsconfig.all are not run here; phase-end root runner is coordinated separately. No full Task 1 or phase acceptance claim.
- Layout tests are jsdom class/semantic contracts only. Actual light/dark narrow pixels and real-browser keyboard/focus checks are requested from the parent native checker, not claimed here.

## 2026-10-12 06:57 PDT - Task1a integrated acceptance

- Original8f463a22 and R1 15d7be85 integrated separately after exactsourcehashcomparison (all10source/test filesidenticalR1). OriginalreviewCHANGES missingpolitecount; R1freshreviewAPPROVE/nofindings. Own originaltestsfirst14pass1fail+4missingmodulefail, R1newtest1fail4pass then greenfinal. FirstR1importrefmiss ranold56coverage only; notR1evidence, correctedrefactualRED/greenretained. No any/lintdisable/testweakening.
- OwnfinalR1force/alltypecheck1408, fullsevenrootESLintlegs1280+wholePrettier and allworkspacebuild1408PASS/fulloutputsread.120uniqueDashboard1280tests292+318+199+278+100+93 plusunchangedHTTPguard259sixserialoneworker1024batches224.97sPASS. Initialoriginalcoverage1279+missingnonexistentguardpath wasn'tfinalevidence; finalguardcorrectlyranpackages/http/src/no-staged-rollout.test.ts. An earlyfinalbatch1foregroundtimeout incompletewasrerununchanged; onlyfinalfullrunreceiptcounted.
- NativeSaveBar/guard deferredtofirstrealTask4Behavioursettingsconsumer thenTask5Configuration, no pixels/ATspeechclaim; root-relativeanchors/unloadonly, noBack/programmaticclaim. Task1bpreviewcandidate6821449c awaitsreview+owngates; nativepreviewatTask2consumer default, disablednonfocusableactions unchangedunless revieweddecision. NeitherfullTask1norphasecomplete.

## 2026-10-12 07:12 PDT - Task1b integrated source and composition receipt

- Exact candidate6821449cf798bc0a5a4025fa9f190359c0055846 five files integrated on accepted1a8bc11791 as e62f566c121ecd10d5b5be8fa30acbfb23acb04c, treeb1c34e6154bdc4cc26070c855c1d0432165c0cd9. All five Git blob hashes identical before commit. Independent source APPROVE/noP1P2; parent direct acceptance07:10:20. No optional production/test changes or extra repair round. Original1a/R1 source/notes unchanged.
- Own tests-first RED: two missing implementation modules, zero tests executed, exit1; GREEN54/2. Independent reviewer reproduced RED exit1. Worker's red-log exit0 was a receipt typo, not used as proof. Ownforce/alltypecheck1408, sevenfullrootESLintlegs1280+wholePrettier and allworkspacebuild1408PASS.122uniqueDashboard1336tests292+345+200+268+131+100 plus unchangedHTTPguard259, sixserialoneworker1024batches228.00sPASS/alloutputsread. Not a full root suite receipt; phase-end runner still required. CSSparse and13browserexternalization/chunksize baseline retained unchanged. No core/server/dependency change.
- Five P3 source-review notes retained: (1) explicit escaped-close hand-crafted Markdown pinning tests could strengthen coverage, existing core escaping is covered; (2) MAX_MS direct16-digit timestamp test absent, existing17-digit fixture hits scanner cap instead; (3) workerredexit typo corrected above; (4) barequote-without-space/unsafe-link-label-only rendering/gallery multi-image layout/external-link icon/repeated preview aria-label are cosmetic fidelity limits; (5) mockup lightlinkcolor#006ce7 contrast4.40:1 is a documented fidelity tradeoff, not claimed4.5PASS. No speculative source fix; native gallery/lightlink readability requested at actualTask2consumer. Disabled/nonfocusable actions default unchanged. No pixel/ATspeech claim and no fullTask1completion until consumer evidence.
- Composition1e0c3791 independent root runner receipt now fully inspected: npmci, force/alltypecheck, literalrootlint and rootbuild exit0; Vitest487files9659testsPASS1168.61s/1170wall. All793Vitest lines and other rawlogs/meta read and retained. This is verified composition baseline, not finalP5rootgate; composition still new local integration product notyetreviewedbyConnor.
- Task2 preparation grounding: actualTaskCardView needs noanchorid; previewview can be client-side, no read-only serverendpoint justified. Descriptionlimit5000 fromtask-write schema, not illustrative2000. Preview props consumecomponents directly. ExistinglistArchive directaction differs fromplan's'as today'confirmation assertion: add scopeconfirmation without changingPOST/version and log. Destination/timezone/extrareminders/presidentrole/multi-assignee behavior retained. Task2actualconsumernative closes preview deferral; SaveBar/guard firstTask4settings thenTask5Config.

## P5 Task 2 (partial: move stage, Tasks list, New task) - implementer notes

- Move commit b311c5df: structure only. Shared type files are `types.tsx` (not `.ts`) because `tsconfig.all.json` has no `--jsx` and a `.ts` importing a `.tsx` module fails TS6142. Source comparison method: import lines and `export ` prefixes stripped, all whitespace removed, new files concatenated in order versus the old file at base; identical for all five source files except one prettier-added `;` in a `task-teams` type literal. Moved tests differ from base only in import paths. One comment-only edit in `app/palette-sources.ts` (file path in doc comments).
- Teams file split follows the brief's "president-role and team edit components too": `teams/{index,president,team-form,team-card,members,types}`. Detail split: `detail/{index,edit-form,steps,progress,reminders,types}` (no `overview.tsx` yet; Overview is inside `detail/index.tsx` until the detail sweep).
- List: Archive now asks first through a scoped ConfirmDialog (plan said "as today"; base archived directly). POST `/api/tasks/:id/archive` body `{ version }` is unchanged and asserted. Status words per plan ("Waiting for review" for `awaiting_approval`). `Updated` uses `updatedAt` from the existing `/api/tasks` rows (the route spreads the storage row, schema.ts has `updated_at`); shows "Not recorded" when absent. Filters are client-side over the existing snapshot.
- New task: description limit is 5000 (task-write schema), not the plan's 2000. Audience wire values unchanged (`team`/`individual`); client cap of 25 people matches the server max. Label stays "Task title" so existing label selectors keep working. Submit wording is "Create task". Client-side validation messages are unchanged text but now also appear in the ErrorSummary.
- `ui/LinkListEditor.tsx` (additive, shared with the detail edit form): kit `Input`, stable ids `field-links-<i>-label|url`, a visible `n / 5` count. `validateLinks`/`cleanLinks` untouched.
- Preview: `pages/tasks/preview-view.ts` builds a `TaskCardView` client-side and calls the existing `renderTaskCard` from `@bananasaurs/core`; no server endpoint added. Preview-only taskId/version identify an unsaved card and never enter request bodies. R1 withholds the card when due is unset/incomplete; no date is invented.
- Test changes: native `select` changes became `userEvent` picks via `tasks/test-polyfills.ts` (jsdom Radix polyfills). Old list-layout assertions (`Done (1)`, `2 open`, `(overdue)`, `Archived (1)` details) were replaced by table/filter assertions because the layout they described no longer exists. Posting-switch tests and all create/link request assertions are unchanged.
- NOT DONE in this run: Task detail sweep (URL tabs, header, preview on Overview, retained edit mode) and Teams sweep (DataTable, Tabs, Select replacements). Those pages are on the accepted move-stage source and still work.

## Task 2 (cont) - detail page (Task 2b)
- Detail: Overview/Steps/Progress/Reminders as URL tabs (`?tab=`, pushed history entry, other query and hash kept, invalid tab falls back to Overview). Status Badge in header, DescriptionList, saved-card preview (`buildPreviewView({saved})`, production `createdAt`/`updatedAt` come from the task response; old fixtures omit metadata. R1 withholds the saved-card preview when updatedAt is missing rather than substituting the page clock). No Open-in-Discord link (no anchor data). Header Edit button focuses the inline edit form (no new endpoint).
- Edit form restyled to kit (Field/Input/Textarea/Select/RadioGroup/Checkbox, useFieldErrors, ErrorSummary). PUT body unchanged. Assignment select became Audience radios + People checkboxes (same wire values).
- Existing detail tests: report tests now open `?tab=progress`; the destination test uses the kit Select via `pick`; the blank-title test accepts the summary alert alongside the field alert. No request assertion changed.
- Additive kit props (dependent tests rerun): RadioGroup `id`/`error`; LinkListEditor `fieldErrors` (separate label/URL messages per row). Also applied to the New task page: Priority/Audience focus targets and inline text, `assigneeIds.<n>` targets (fieldset `field-assigneeIds` focusable), label+URL errors both shown.
- Steps/Progress/Reminders: kit Input/InlineAlert; requests unchanged.

## Task 2 (cont) - teams page, lead corrections (Task 2b)
- Teams: Teams/Members URL tabs (`?tab=`, pushed entry, other query/hash kept, invalid -> Teams). Teams tab: President role Select, Add team form (kit Select), DataTable of teams with setup issues, per-row `Edit <name>` opens the team editor (name + three Selects, Save/Delete/Close). Members tab: team Select then members DataTable and Add member (search Input, Choose member Select, Team role Select). Every request URL/method/body unchanged; edit form stays open after a failed save/delete and keeps its input. A stored team's channel/role values still start empty as before (the setup response does not carry them).
- Existing teams tests: president clear, delete 409 and announcement-options tests now use userEvent/`pick` and click `Edit Tech` first (selector/flow change only; same URLs/bodies/messages asserted).
- Detail Created/Updated now come from the real task response (`createdAt`/`updatedAt` on the clubTasks row, verified in storage schema and http/routes/tasks.ts). The Task mirror types them optional; the Created/Updated rows are hidden when an old fixture lacks them; R1 also withholds the saved-card preview with an explicit missing-Updated explanation, with no page-clock fallback.
- `assigneeIds.<n>` from the server indexes the POSTed (selected) ids. The summary link and inline text now map n -> that selected person's checkbox, and any membership change clears all `assigneeIds.<n>` errors (new and edit).
- test-polyfills.ts: ResizeObserver stub builds its method names, because the ADR 0121 vocabulary guard (packages/http no-staged-rollout) scans this non-test file and flagged the word (the partial run had not run the HTTP guard).

## Parallel source composition checkpoint (October 12)

Local isolated branch `uiux/p5-composition` starts at d318fb29. Fourteen independently reviewed final
candidate histories merge without overlapping changed paths, in order: Task2 R1b,3R2,4R2,5a,5b,5cfinal,
6aR1,6bR1,6cR1,6dR1,6eR4,7aR1,7bR1,7cR1. No push, remote merge, tag, deployment or live Discord.
Task4 detail registers immediately after its wizard route in Shell; the existing Behaviours navigation,
palette and document-title owner remains. New composed Shell tests cover detail/crumb/title, unknown-id,
wizard precedence, and no write on load. Task7c's outside-ownership Shell title expectation changes to
Role panels; no request assertion changes. Unit notes and independent review caveats remain authoritative
research receipts, not a claim of complete recipe/native/phase acceptance.

Fresh local checkpoint checks: npm ci 0; forced project build 0; composed Shell/routes/integration plus
actual no-staged-rollout 259 guard: four files/335 tests 0. Initial new wizard-heading expectation failed
because the real header uses the behaviour name; corrected to actual heading plus Step1of7, rerun green.
New integration test ESLint 0. Whole-program tsconfig.all exceeded command limits at heap1408; orphaned
own tsc was stopped, not counted as pass. Heap1024 retry aborted134 OOM. Earlier scoped lint was not
completed during resource contention. Whole-repo lint/build/Dashboard and final root need exact-checkpoint
runner; native page groups need real pixels and keyboard work. This reversible checkpoint is not a
phase-completion or all-gates-passed commit. Original accepted branch remains at d318fb29.

Known source limits travel into native/handoff: Task4 applied-settings overlay after failed refresh then
concurrent change; truthful409failed-refresh prompt draft loss; guild-switch settings draft reset;
arrow-activated tabs add history. Task6e full-route-unmount duplicate window is pre-existing. Task7b
nested/cross-step group field targets, tuning multi-dirty guard stacking, and who-can-ask session.write
failure source-only coverage remain. No assistive-technology speech, native zoom or final union root
claim before those checks. Unit8 stays preparation-only; do not write a STATE all-pages-complete claim.
