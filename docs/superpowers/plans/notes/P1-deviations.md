# P1 deviations

Task 1: plan examples used UTF-16 slicing; review found split emoji/combining sequences. Added grapheme-safe cutUnits using Node22 Intl.Segmenter without changing existing signatures. Zero truncate length returns empty; unsupported limits throw RangeError. Modal titles use truncate; labels/descriptions use cutUnits.

Task 1: plan constructors omitted stated button/card constraints. Enforced 34-character button labels with emoji, 38 without, and at most one primary button per card, including section accessories. Renderers must use card(), not bare container(), to enforce card-level rules.

Task 1: plan escaping did not cover indented/numbered list starts. Added escaping and hostile-text regression tests. Number prefixes may be escaped more broadly than Markdown requires; this renders as the same prose and uses one additional text unit.

Task 1: retained the mandated clampLines assertion and behavior of N content lines followed by a cut-marker line. Clarified documentation, normalized CRLF only when cutting, and made zero content lines return only the marker. Trailing blank lines count as lines. Existing tests/assertions unchanged.

Task 1 review: no blocking findings after fix round1. Optional syntax-specific escape tests are deferred to renderer hostile-input tests; renderer text budgeting must use escaped length, not only raw length.

Task 1 gates: initial full suite encountered a V8 worker heap-limit OOM and was stopped; unchanged full suite rerun with NODE_OPTIONS=--max-old-space-size=1536 passed 8554 tests in 437 files. Typecheck/lint also used 1536MB. No gate waived or assertion changed.
## Task 2

- The plan postpones typecheck until Task 3 because the REST adapter lacks the two
  required port methods. Per the lead's compiler-forced scope decision, added
  explicit throwing `deferUpdate` / `showModal` stubs in
  `packages/discord/src/rest/port.ts`. Task 3 must replace them; no working REST
  implementation is claimed here.
- Compiler-required additions: `OutgoingFile` is re-exported from the core index
  for testkit; `ModalSubmitEvent` is re-exported alongside other event types.
  SlashResponder wiring was added in `apps/daemon/src/runtime/guild.ts` and
  `apps/daemon/src/mod.integration.test.ts`; harness methods were added in core
  `mod/commands.test.ts`, `mod/confirmations.test.ts`, `mod/history.test.ts`, and
  `task/commands.test.ts`. PanelResponder is a separate interface and was left
  unchanged. No event-kind switch beyond fingerprint required a change.
- The fake's optional stored card fields explicitly allow `undefined`, matching
  OutgoingMessage and this repo's exact optional property semantics.
- The plan's fake modal guard checks only a defer or deadline. The documented
  first-response rule also excludes a second modal and an immediate reply, so
  `showModal` rejects either. A new regression test was watched fail before
  adding these checks.

Task 4 blocker: after two fix rounds, final review found deleted reports do not invalidate card render watermark. Candidate held uncommitted on wip/P1-task-4. Task 5/8 and storage consumers wait; no known-defect acceptance or extra round without user decision.

Task 2 review repairs: replaced the fake's separate modal/reply checks with a
single initial-acknowledgement state across reply, both defers and modal. Added
ack-order regressions and exact mention/art-loader assertions without weakening
existing assertions. Final repair gates the three-second deadline only on an
unacknowledged interaction and retains the fifteen-minute follow-up deadline.
The six follow-up boundary tests were applied first on the integrated tree:
three failed before the code delta; all 104 fake tests passed after it. Card,
fingerprint and fake focused tests passed 156/156. Full acceptance gates are
recorded in PROGRESS.md only after the final-state run completes.

Task 3: plan said to add the modal-submit gateway test "in the same style" as existing button-interaction tests in `events.test.ts`; that file has no button-interaction tests — its one style is raw gateway packets through discord.js's own action handlers. Drove a real type-5 `ModalSubmit` packet instead of a hand-made fake, which exercises the real `ModalSubmitInteraction`/`ModalSubmitFields` (text input under an action row, radio groups under labels, `value: null` for an unanswered group). Also: a manual mutation check (dropping the `data.value !== null` radio guard) survived the plan's `toMatchObject` fields assertion, so the fields assertion was tightened to an exact `toEqual`; the mutation is caught now.

Task 3 caveat (fix rounds 1-2): an edit PATCH carrying files lists only the new attachments in its payload, so a live PATCH replaces the message's existing attachment set (Discord behaviour, unverified live). A webhook follow-up with files is a POST that creates a new message, not a replacement.

Task1 phase-review tests-only round2: added gallery10/11, stringSelect0/1/25/26 and optional fields/selectRow/radioGroup shape, exactly40 components and aggregate4000/4001 text tests. Three own mutants killed; fresh reviewer approved. Optional undefined-key toEqual nit is wire-equivalent and left unchanged. No production change.

UI gate amendment approved by Connor on WhatsApp10:22:09: per-task focused tests, typecheck and lint; full suite per integration wave and phase end. Fresh reviews, separate task commits, no weakening and no push remain.

## Task4
Task 4: plan expected strictify to report one table made STRICT; generation created task_links and rebuilt task_nudge_slots, so strictify correctly reported two tables made STRICT. Both required indexes were recreated. No SQL was hand-edited.

Task 4: plan typed lastPickup.actorId as string; auditEvents.actorId is nullable. Added a null-safe return: an unidentified latest pickup returns undefined, preserving the promised public interface without a cast.

Task 4 fix round: markCardRendered rejects a lower-version completion wholly (version and renderedAt), where the plan pseudocode took MAX of each independently. Callers (Task 8 renderer) must pass the rendered view's snapshot watermark as `now`, not completion time.

Task 4 fix round: lastPickup orders by at desc, then audit_id desc, so same-timestamp events resolve to the latest written.

Task 4 second fix round (tests only): added three render-ack regressions without changing existing assertions. The wholly-rejected test uses an adversarial task-version fixture (reset to 1 after acknowledging v2@6 and recording report@7), so version mismatch cannot mask an incorrectly accepted obsolete v1@8 timestamp. Equal-version re-ack covers v2@6, report@7, v2@9 clearing staleness. Timestamp monotonicity covers v2@9 then v2@4, directly checks renderedAt remains 9, and checks report@7 remains non-stale.

Mutation evidence: each new test was run alone with `NODE_OPTIONS=--max-old-space-size=1536 npx vitest run packages/storage/src/repos/tasks.test.ts -t '<test name>'`. Each mutant exited 1 with exactly one failed test and 51 skipped tests:

- Removed the `renderedVersion <= version` guard: `rejects an obsolete render timestamp when version alone cannot make the card stale` failed at its final stale-card assertion (expected the card at version 1, received `[]`).
- Changed the guard from `<=` to `<`: `an equal-version re-ack clears a newer report after its snapshot is rendered` failed at its final assertion (expected `[]`, received the stale card at version 2).
- Replaced `MAX(renderedAt, now)` with plain `now`: `an equal-version older snapshot preserves the MAX render timestamp` failed at the stored timestamp assertion (expected `{ renderedAt: 9 }`, received `{ renderedAt: 4 }`).

Production code was restored after each mutant and verified byte-for-byte against the original. All 52 tasks tests passed before mutation runs; the normal gates are rerun after restoration. No production behavior changed in this round.

Task4 owner-approved extra round: deleteReport increments task version and updatedAt atomically. Test proves an acknowledged anchored card becomes stale after deletion, then fresh after render acknowledgement; wrong-guild/unknown no-op and audit-failure rollback are pinned. Integrated tests-first20fail/35pass before implementation,55/55green after. Fresh reviewer approved. Wave full suite remains pending.

Task4 own acceptance: storage55 and HTTP/MCP107 passed; typecheck/lint PASS, all output read. A requested nonexistent daemon task-admin-port.test.ts was silently ignored by Vitest, so no daemon coverage is claimed from that run. Full suite is wave-pending under the approved gate amendment.

## Task5
Task5 helper process miss: HTTP/MCP implementation preceded their tests; only schema red-first was witnessed there. Lead independently integrated all five test files before implementation: schema import failed, HTTP create test failed, MCP pass-through and cleaned-label tests failed,149 existing tests passed. No assertions weakened. Small compiler-required Args.links addition and links:[] detail fixtures are included. Shared clean replaces @ with a space exactly as plan, so the leading space in the expected label is retained. Fresh review approved; input-hardening observations (control characters, zero-width labels, duplicate/local/userinfo URLs) are outside the verbatim planned schema and not changed silently.
## Task 6

- The sample shows Ref for the member entry task.unavailable. ADR 0141 decision 11 and docs/28 forbid member Ref; errorCard suppresses it for member entries. The replacement assertion covers all ten member entries. A moderator-audience test verifies Ref is shown and restores the local entry in finally. The interface is unchanged.
- Raw quote truncation in the sample can exceed the quote/message budget after Markdown escaping and block-quote prefixes. Fit the final wire text, cutting only raw grapheme-safe text before escaping. Result title/detail and Ref are escaped and budgeted; the title uses the guideline's 80-unit cap. Hostile-input regressions cover these differences.
- Fresh implementation review found a future-P2 test bug: the member suppression test enumerated every entry, including future moderator entries. The tests-only repair filters by member audience without changing the assertion. A fresh delta review verified all ten cases and killed the member-Ref mutant.
- Integrated acceptance: applied tests first and observed two missing-module suite failures, then implementation. Focused copy/Discord tests passed 83/83. Own final typecheck, lint and full test passed with 1536MB heap; all output read. No gate waiver or old verifier output used as acceptance. Live Discord pixels remain owner-run and unverified.

Task6 numeric replay: original accepted code replayed unchanged after Tasks4/5. Fresh focused89/6 PASS. Initial typecheck at1536MB terminated137 with Killed and no diagnostic; unchanged retry at1408MB passed. Lint/fullwave status recorded separately, not inferred from old acceptance.

## Task7
Task7 owner-approved extra tests-only round pins escaped check-in header plus newline aggregate budget; fresh review APPROVE. Header-budget and newline mutants are killed. The optional one-unit header slack mutant survives without violating the4000 ceiling. Owner chose exact copy "Marked done by @x · @Role review this task"; the plan's conflicting "please review" assertion is replaced by that rule. Own integrated tests-first observed2 failures/11 passes and missing cards module before implementation. Focused196/14, typecheck and lint PASS, then full Tasks4-7 wave8715/441 PASS, all1149 full-suite output lines personally read. No live Discord visual check was run.

## Task8
Task8 helper did not strictly witness red-first for every change; lead applied both candidate and approved tests-only delta before implementation and observed four missing-module suite failures, then green. Both announce-render watermark and archived-view give-up regressions are included. Own focused59/4 and planned cards/jobs197/13 PASS. Extra requested daemon.test.ts does not exist and contributed no coverage. First full cards/jobs foreground attempt hit120-second execution limit; unchanged background retry197/13 PASS. Typecheck1408MB terminated137 while another gate was active; sequential unchanged retry PASS, followed by full lint PASS. All outputs personally read. Actual pixels of all four committed art PNGs were inspected: intact mascot, leaf and pawprint banners, no regenerated assets. Live Discord card layout remains owner-run and unverified.

## Task9
Original helper extracted task-start.ts outside listed production scope; repaired candidate removes it and inlines identical logic in runtime/guild.ts. Ten actual buildGuildRuntime/FakeDiscord tests replace helper-only coverage while preserving all behavior/status/version assertions. Core tests pin deferUpdate ordering, empty parse/no art private replies and rejection containment. Fresh repair review APPROVE; planning gate, assignee, no-await and fresh-version mutants killed. Own integration applied final tests before implementation, observed22failed12passed, then focused65/5, fulltypecheck and fulllint PASS; all output read. No dependency, production-scope expansion or live Discord.

## Task10
MCP port has no sibling test file; slot/retry assertions are in existing real-composition mcp/wiring.test.ts. Added task-update.test.ts real guild runtime and task-update-slot.test.ts for immediate/idempotent/guild-isolated scheduling. Original candidate review rejected stale pre-await task snapshot. Repair re-reads status/archive/team/assignment after live membership await with no await before recording/scheduling; added regression fails old code and passes fixed code. Fresh delta review APPROVE; optional team-change/reassignment-specific race fixture remains uncovered. recordReport still accepts awaiting_approval for existing other callers; those callers were not changed by this repair. Task8 approved additive tests required clean three-way application; preserved unchanged. Initial plain apply failed atomically, so subsequent84/3 green was old coverage only. Actual tests-first witness16failed44passed plus2missing-module suites, then final focused182/9 and real MCP wiring20 PASS, fulltypecheck/fulllint PASS, all output read. Worker-only gate reports were not substituted for own gates; fullwave pending. No live Discord.

## Task11
Task11: done-this-week includes archived tasks because approval archives them. The plan's includeDone alone misses approved tasks. Pick success passes the raw truncated title to resultCard so it is escaped once. Non-member clarify copy uses "an organiser". buildCompleteSelect remains until Task12 removes its caller; obsolete review/pick builders and their three legacy helper tests were removed as the explicit plan step requests, with behavior covered by Task7 renderer tests rather than dropped to get green. The invalid-zone reminder fixture remains and now expects Discord :f timestamp text.

Fresh candidate and tests-only delta reviews APPROVE. The added96-task hostile digest regression pins escaped aggregate4000/counts/omitted suffixes and parse:[]; budget and mention mutants killed. Count-only mutant survives that fixture because budget binds first; existing Task7 tests separately pin six-row/eight-title caps. Own finaltests-first28failed72passed (all656lines read), focused173/7, typecheck and lint PASS, then full Tasks8-11 integration wave8792/447 PASS exit0; all1354 full-suite lines personally read. Three-way integration preserves Task10's post-membership fresh task/status/team/assignment check. No live Discord run or pixel validation of posted cards.

## Task12
Task12: isolated candidate added task.changed before Task11 was present. Ordered integration already has Task11's exact entry, so no duplicate or copy change was applied. List now uses Discord :R timestamps; kept the original bad-zone fixture and direct ISO fallback assertion, and repair adds a dedicated formatDueLabel fallback test. The row cap changes15 to10 as the plan requires, with status/overdue assertions restored at renderer and command layers. Repair adds select and review/pick dependency/defer error-card assertions. Fresh repaired review APPROVE. Own finaltests-first20failed98passed/all312lines read; import-only three-way conflict merged all Tasks9-12 imports without changing prior paths. Finalfocused164/7 plus real approval/access20/2 PASS, typecheck and fulllint PASS, all output read. A nonexistent runtime/task-approval.test.ts in the first focused command contributed no coverage; the actual daemon task-approval.test.ts was run separately with task-access. Fullwave pending Tasks12-14. Unused buildCompleteSelect cleanup is explicitly pending a fresh worker/reviewer after this Task12 base.

## Task13
Task 13: plan's LinkListEditor.test.tsx had no cleanup between the two render tests, so the second test found the first test's DOM; added `afterEach(cleanup)` (same harness hygiene as the sibling ui tests), no assertion changed.
Task 13: existing task-detail.test.tsx DETAIL fixture had no `links` field though the route always returns one; added `links: []` to the fixture so the summary render matches the API shape. No assertions changed.
Task 13: plan's validateLinks used `let ok = false;` then reassigned in try/catch; eslint no-useless-assignment rejected the unused initial value, so it declares `let ok: boolean;` and assigns in both branches. Messages and logic unchanged.
Task 13 integration note: the isolated candidate created a lowercase p1-deviations.md (case-collision with this file; noted in the candidate's own repair); its three entries are folded in above and the lowercase file was not created.
Task 13 review repair (three P3 nits, tests first, red witnessed): validateLinks tests added for `https:example.com` (killed by dropping the startsWith guard) and a padded URL ` https://e.com ` (accepted, cleanLinks stores the trimmed URL; killed by dropping url.trim()). Per-row link errors are now cleared on any link edit or removal in both the create form and the task-detail edit form (stale "Link 1" alert after removing a bad row). The detail summary list key is now url plus index so allowed duplicate URLs raise no React key warning. No other production change.

## Task 14

- The MCP initialize instructions were already 4,488 characters, just below the pinned 4,500-character cap. Added links and posted progress guidance while shortening existing prose without removing its contract; kept the cap test unchanged.
- The guide lives in `packages/core/src/guide/topics.ts`, not the MCP package. Updated that topic with the lead-approved correction to the obsolete "without posting it" progress bullet.
- Resource-limited worker verification: sequential typecheck with a 1,700 MB heap, changed-file lint/format checks and focused tests only. Full lint/full suite and live gallery remain the lead/owner's acceptance work.
- The sample gallery left reply pings implicit. The real REST adapter defaults `replied_user` to true for replies; the gallery sets `pingReplyAuthor: false` explicitly so update, pick and clarify samples also ping nobody. No adapter change.

### Task 14 repair, round 1

- Added tests before the checklist repair to pin the exact guide progress bullet,
  guide five-link sentence and MCP links/progress sentence. Against the pre-Task-14
  guide/instructions from `b1c88c2d`, all three new tests fail while the 19 existing
  tests pass. Restoring the unchanged `2588bc7a` production copy passes all 22
  tests. The existing 4,500-character instructions cap is unchanged.
- The no-ping gallery uses whole-team samples with no real user or role IDs, so it
  cannot verify real mention names. Split the misleading checkbox into a gallery
  no-ping check (including replies) and an owner-run real task assigned to the
  owner in the test channel. Only that separate real-task check may ping the
  owner; samples must remain free of real IDs. No gallery or production code changed.
- Repair verification stays sequential and resource-limited: the two touched test
  files only, typecheck with a 1,700 MB heap, and changed-file ESLint/Prettier.
  Full suite, full lint, build and live Discord gallery/mention/notification
  checks remain lead/owner acceptance work, not claims made by this repair.

## Phase review repairs (review of tip ebb4492a, verdict CHANGES: 1 P2, 5 P3)

Decisions applied under Connor's standing "use ur suggestions" instruction (relayed by main Oct 11, 11:04pm), each chosen by main:

- 2026-10-12. Question: how to fix P2-1 (deleteReport bumps club_tasks.version and strands an already-posted awaiting_approval review card)? Default: keep the version stable while awaiting_approval and mark the anchor dirty (rendered_version = -1) so the card still refreshes (reviewer options a+b), instead of re-issuing the review slot. Regression test added: delete a report while awaiting approval, then approve with the original review-card version (witnessed red: version 4 vs 3, approve rejected).
- 2026-10-12. Question: which lower findings to fix now? Default: fix P3-1 (server-side modal update validation) and P3-4 (duplicate React keys) in this repair; log-not-fix P3-2, P3-3, P3-5, P3-6 (below).
- P3-1 fix: a trimmed-empty, over-1000-character body or over-200-character blocker is rejected as task.update-not-saved in both the submit handler (packages/core/src/task/commands.ts) and the daemon postUpdate (apps/daemon/src/runtime/guild.ts, new outcome 'invalid'); the modal's maxLength now uses the same TASK_UPDATE_BODY_MAX/TASK_UPDATE_BLOCKER_MAX constants. Tests witnessed red (postUpdate called 3 times) then green.
- P3-4 root cause: the Task 13 review repair's code hunks (summary-list key fix, per-row link-error clearing in both forms, and its five tests) were silently dropped when the Task 13 squash was assembled — the repair patch applied with rejects and only its deviations note landed. All repair hunks are restored in "P1 Task 13 (fix): restore review-repair hunks dropped in the squash"; the restored tests were witnessed red (4 failures) before the production hunks were re-applied. Process note: never apply patches with --reject; verify with git apply --check -R afterwards.
- Log, not fix (plain wording for the report):
  - P3-2: the "I'm on it" button on a reminder card can never succeed once the task's version has moved: it answers "The card has been refreshed. Try again on the refreshed card", but only the task's anchored card is refreshed, not the reminder card, so retrying fails the same way forever. Low impact (the reminder is built from the current version; only a later edit breaks it) but the copy misleads.
  - P3-3: the card refresh pass takes the 10 oldest stale cards; a card that keeps failing with a retryable error (a persistent 5xx, a malformed card) stays stale, and ten such rows at the head of the queue starve every newer stale card. Suggested direction: per-row backoff or a skip after N attempts.
  - P3-5: link URL hardening is consciously not applied (already acknowledged above in this file): `https://` is required, but userinfo URLs (`https://user:pass@host`), control characters and zero-width labels pass. Owner/lead-only input, so low risk.
  - P3-6: unverified live-Discord behaviour: editing a legacy plain-text task post into a Components-V2 card sends `flags: 1<<15` with `content: null, embeds: null`; Discord's public docs only describe the flag on message creation, and no live check was possible. If Discord rejects it with a 400, refresh treats it as retryable, so the oldest legacy rows would be retried every pass and starve newer cards (compounds P3-3). Owner to check once live; the smoke:cards script does not exercise a legacy-post edit.
- 2026-10-12. Question: how to fix the scoped re-review's P2 (an in-flight render completion calls markCardRendered after the awaited Discord edit and erases the awaiting-delete dirty marker, stranding the card on the deleted update)? Default (chosen by main, "fenced generation/watermark"): fence the completion on the task's updated_at as of the stale-row snapshot. staleTaskCards now returns updatedAt and markCardRendered takes it as an optional fence; a completion whose fence no longer matches is dropped, the dirty marker survives and the next pass re-renders. The existing updated_at watermark was used rather than a new render-generation column to avoid a migration inside a repair commit; the fencing semantics are the same. Red witnessed with the reviewer's probe at daemon level ("expected [] to have a length of 1") and at storage level with the unfenced call; green after.
- 2026-10-12. Question: close out the fence re-review's remaining items? Defaults (chosen by main): add a red-first test for the refreshOneTaskCard fence (done - witnessed red with the fence temporarily removed, "expected [] to have a length of 1", green restored); log the two P3s below as known limits, not fixed.
- Known limit, not fixed (fence re-review P3): the fence is updated_at equality, not a true generation. A deleteReport whose `now` equals the updated_at the snapshot was taken at passes the fence and clears the dirty marker (reproduced by the reviewer with an injected clock). This needs a same-millisecond write right before the snapshot; unrealistic with real clocks and an awaited Discord edit. Optional hardening if ever needed: set updated_at = MAX(updated_at + 1, now) in the awaiting branch, or a dedicated render-generation column.
- Known limit, not fixed (fence re-review P3; corrects the round-2 note above, whose "cannot overlap" claim was wrong): the announce path (task-nudges.ts:495-508) can lose a delete on an unanchored awaiting_approval task. The announce slot is created at task creation and only superseded when archived/done, so a delayed announce can fire while the task is awaiting_approval with reports; a delete between taskCardView and recordTaskAnchor updates zero anchor rows (no anchor yet) and the markCardRendered there is unfenced (reproduced by the reviewer). Narrow window (delayed announce plus a delete inside the send await); non-awaiting statuses are unaffected because the version bump keeps the card stale; pre-existing, not made worse by the fence repair. The suggested fix would be fencing that call with the task's updatedAt read with the view.
