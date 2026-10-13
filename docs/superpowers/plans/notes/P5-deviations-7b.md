# P5 unit 7b notes

## Base and ownership

Base: d318fb292577a15c56a506e490e0f77e87a35d5c. Local branch: oc/p5-u7b.
Large owned pages move to pages/messages-assistant, with original-path wrappers
preserving every existing export. Imports into peer pages remain through wrappers.
No shared primitives, Shell, peer pages, manifests, runtime, or request APIs change.

## Move evidence

The move commit changes relative import depth only. Source comparison normalizes
`../../` to `../` and `../` page imports to `./`; all other bytes match the base.

## Verification limits

Native pixels, physical viewport/zoom, keyboard walkthrough and live Discord are
not verified on this isolated candidate. The lead owns native composition checks.

## Sweep choices

- Archive and AI tuning use query-backed sections. The default All view preserves
  existing test selectors and all settings remain reachable. Hidden sections stay
  mounted so local drafts, busy/error state and resources survive switching.
- Wizard keeps its seven-step state machine, stored choices, glossary limits,
  preview and commit body. Counted textareas use external Field labels so counts
  are descriptions, not part of the accessible name. Locked safety content is
  copyable under Advanced and remains unchanged data.
- Tool parameters use DataTable; skill instructions use CodeBlock without changing
  supplied model content. Raw JSON searches now find only recurrence comparisons
  in skill-items (not display or a request-body change).
- History/conversations retain filter API construction, cursor controls and sort
  semantics. Empty filter sentinels are UI-only and translate back to empty
  strings before API filters or retention body construction.
- Schedules and the skill catalogue filter loaded data locally. Filtering makes
  no new request, reminder, retrieval, run, cancellation or scope change.
- Memory save no longer closes the editor or announces success on an undefined
  session write result. Errors preserve all drafts and map field problems to
  the existing memory editor. URL/method/body and session CSRF/reauth remain.
- Retention and skill scope keep their exact write bodies but use writeOrThrow for
  400/409 field errors. Tuning error summaries reuse existing per-row validation.
  Wizard field problems are shown inline/summary while its existing 409 flow stays.
- Peer imports remain original-path wrappers, including TryItBox and trace helpers.

## Test assertion audit

Original stubFetch URL/method/body assertions are unchanged. Select interaction
selectors use Radix keyboard entry and test-only DOM polyfills from the kit test.
Instruction content assertion changes PRE to CODE (CodeBlock keeps the same text).
The history filtered result now expects a filtered-empty title instead of claiming
no runs exist. No race/cancel/latest-wins or request assertion was removed.

## Red proof

- First recipe/memory run: 11 failed, 1 passed (12 tests). Raw controls,
  missing clear paths, unlabelled server card and lost memory draft failed red.
- Archive/tuning tab run: 2 failed, 16 passed (18 tests), both retained-draft paths
  absent before sections were added.
- Skill filter failed before implementation. Schedule filter failed before its
  implementation. Wizard schema-summary test failed before inline mapping.
- Logs are delivered with the gate sidecar. Final results will be listed in report.

## Remaining native checks

No native desktop/mobile pixels, physical 360/1440 viewport, 100/200 percent zoom,
light/dark render, keyboard wizard/review, browser Back, focus restoration or
live provider/Discord claim is made. Parent composition must verify these.
The isolated candidate uses no new shared styles/primitives or route registration.

## Gate repair notes

First full candidate typecheck found test-only `exact` options unsupported by
Testing Library role queries and two unused imports. Removed those options and
imports without changing assertion scope or any request assertion. Fresh force/all
rerun is required; this first attempt is not a PASS.

## Permission-state repair

Read-only audit-denial tests exposed the old history/conversations/transcript
wrappers converting 403 ApiError into generic Error. The owned pages now preserve
403 ApiError for the existing Forbidden state. Requests, audit.read enforcement,
trace redaction and owner-only policy do not change. Transcript's historical 404
wording remains to preserve its existing assertion; it is a documented recipe gap.

## Tab test repair

Synthetic fireEvent.click does not exercise Radix tab activation. Query/deep-link
and retained-draft tests now use keyboard arrows, assert the selected tab and
assert hidden controls are absent from the accessible view before returning.
This caught the previous tests not actually switching tabs. No production shim.

The HTTP vocabulary guard scans helper files as production unless named
`test-support.ts`. The owned Radix DOM polyfill file was renamed to that exact
existing convention; it is imported only from tests. No guard was changed.

## Known remaining recipe scope

No raw select/textarea/table/pre remains in the owned page source. Existing
archive guards, reindex/preserve/link-case controls and pagination are unchanged.
No accidental writes from section/filter navigation were introduced.

This candidate does not claim every recipe requirement is complete: no global
SaveBar is added to per-row tuning (each setting has a distinct immediate write)
or memory (server card and memory are separate bodies). Some model-health/older
activity sections retain their pre-existing hidden-on-load-failure behavior;
PendingTurn still uses its original live-resource behavior. Those need explicit
review rather than treating missing data as empty. Detail 404 mapping, comprehensive
row-action menus, relative future reminder times, filter bars for every helper list,
and full form/schema coverage remain incomplete. No new JSON exposure or unredaction
was introduced. The candidate is for review/integration, not phase completion.

## Final candidate gates

- Node 22.23.3. Force/all typecheck 1408 MB: PASS.
- Exact seven full ESLint legs + whole Prettier 1280 MB: PASS.
- All-workspace build 1408 MB: PASS. Existing 13 node externalization warnings.
- Dashboard four serial shards, one worker/1024 MB: PASS, 125 files/1371 tests.
- Focused-final: PASS, 21 files/257 tests.
- HTTP repair result is reported in the delivered gate-sidecar and raw log.
- Full root: not run here. Independent audit and native composition: parent-owned.

## Bounded completion sweep, October 12

Preserved query fragments with actual browser-location/History regression, duplicate query keys and same-node mounted sections. Added independently visible usage/model/activity failures and named empties, persistent archive detail failure, transcript/missing-skill NotFound, filtered history/search clear actions, local loaded-list filters, archive channel row menus, future-aware owned time display with absolute timezone hover, and per-body draft footers/local discard/anchor-unload guards. Retention, tuning, scope, reminder and server-card saves use their own form submit boundary; no global save transaction. Immediate actions remain separate. Wizard still has seven steps, one final write and existing 409 handling.

Limits: native composition/length/zoom/keyboard/assistive technology and full-root union remain unverified. Error routing for nested wizard/reminder/search/archive paths uses the actual existing form/current-step group, retaining all messages, rather than claiming exhaustive per-control field mapping. Who-can-ask retains session.write/default error delivery and ordered conditional follow-up, so it has discard/guard but does not capture all server field errors inline. Bounded six-tool catalogue does not warrant a filter. Further unbounded helper list filters, wizard explicit discard and full field mapping should be independently assessed. Do not call this a completed phase.

Selectors changed only where presentation changed: archive buttons became menuitems, missing skill uses NotFound wording, optional author label and who-can-ask staged Save uses its footer. Request/body/order assertions retained. Raw failed attempts and repairs are included in receipts. No native claims or live operations.

## Task 7b fix round 1

Fixes a-f: joined messages next to summaries are screen-reader-only description targets; filtered misses expose one clear action; empty members differ from filtered members; unfiltered history empty has no empty clear action; transcript dead rethrow removed; search form clear clears stale field errors. Wizard confirmed local discard restores the loaded answers baseline and clears intermediate drafts/errors without a write, preserving seven steps and final/409 write flow. Memory has one page dirty guard aggregating its two bodies, not a save transaction.

Known field mappings: search q/authorId/limit go to controls; ChannelPicker channelId goes to its focusable existing owned wrapper because the shared picker cannot forward an ID. Reminder text/context/dueAt go to controls; recurrence paths stay in the actual reminder-details group. Archive preserve messageId and link messageId/caseId go to their controls. Unknown search/archive paths stay at their actual form. Wizard nested/cross-step paths stay at current-step group. No comprehensive mapping claim. Direct-handler save boundaries left as resolved; no shared edit. g/h and unbounded helper filters remain recorded rather than changed. Who-can-ask session.write failure delivery remains source-verified, not failure-test-covered.

Memory double-dialog regression is covered. Independent per-tuning-row guards may still stack with multiple dirty keys; recorded limit, no shared guard change. Native visual/composition and full-root union remain unverified.
