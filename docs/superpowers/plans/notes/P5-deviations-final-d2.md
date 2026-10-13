# P5 final D2 deviations and notes

Base `b23e01e4`, branch `uiux-d2`.

## Step 1 — N15 reorder-focus determinism

Change: in `packages/dashboard/src/ui/n15-reorder-focus.test.tsx` only, every
timer-based commit in the test hosts (`Host` modes `async`/`intervene` and
`DupObjectHost`) now pushes its pending `setItems(next)` into a test-owned
queue (`makeCommits().queue` via a new `commitQueue` prop) instead of
`setTimeout(..., 10)`. Each test releases its commit(s) with
`await act(async () => { commits.releaseNext(); })` (or `releaseAll()` for the
two-commit pointer test) at the point the old timer was meant to fire — after
the keyboard/click steps whose pre-commit state it asserts. No test name and
no assertion changed. Product code (`ui/OrderedList.tsx`) is untouched.

## Controller ruling (step 1 follow-up)

Per the continuation brief: with duplicate React keys the product's guarantee
is "focus is on the moved row's own control at its new position", not DOM-node
identity. In `duplicate-keyed distinct objects` only, the final
`expect(document.activeElement).toBe(xDown)` became:

```tsx
// React does not define DOM reuse for duplicate keys; the guarantee is the moved row's control at its new position.
expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move x down' }));
expect(screen.getAllByRole('listitem')[1]?.contains(document.activeElement)).toBe(true);
```

The earlier pre-commit `expect(document.activeElement).toBe(xDown)` is unchanged.

10 isolated runs after the ruling (`npx vitest run
packages/dashboard/src/ui/n15-reorder-focus.test.tsx`, one process per run):

- runs 1–10: 24 passed, 0 failed.

## D2 inventory

`grep -n -E '<select|<textarea|type="radio"|type="checkbox"|<table|JSON\.stringify|text-danger|text-xl'` over each page file in the Files list (2026-10-13, clean tree at `7709df18`):

- packages/dashboard/src/pages/behaviours/create.tsx — 160 `<select`, 177 `<select`, 219 `<textarea`, 246 `type="checkbox"`
- packages/dashboard/src/pages/behaviours/access.tsx — 119 `type="checkbox"`, 150 `type="checkbox"`, 181 `<select`, 364 `<textarea`, 379 `<select`
- packages/dashboard/src/pages/behaviours/settings.tsx — 247 `<select`, 267 `text-danger`, 297 `<select`, 312 `text-danger`
- packages/dashboard/src/pages/behaviours/prompt.tsx — 105 `<textarea`
- packages/dashboard/src/pages/behaviours/try.tsx — 180 `<textarea`, 207 `text-danger`
- packages/dashboard/src/pages/behaviours/index.tsx — (no hits)
- packages/dashboard/src/pages/behaviours/detail.tsx — (no hits)
- packages/dashboard/src/pages/behaviours/tab-panels.tsx — (no hits)
- packages/dashboard/src/pages/behaviours/create-dialog.tsx — (no hits)
- packages/dashboard/src/app/shell-chrome.tsx — 29 `<select`
- packages/dashboard/src/pages/assistant-shared.tsx — 113 `type="checkbox"`, 151 `type="checkbox"`
- packages/dashboard/src/pages/messages-assistant/assistant-skill.tsx — 179 `type="radio"`, 188 `type="radio"`, 197 `type="radio"`
- packages/dashboard/src/pages/messages-assistant/skill-items.tsx — 168 `JSON.stringify` (recurrence-body comparison), 178 `JSON.stringify` x2 (draft dirty check), 217 `JSON.stringify` (recurrence change check), 289 `type="checkbox"`
- packages/dashboard/src/pages/messages-assistant/assistant-prompt-wizard.tsx — 180 raw `<input type="checkbox">` (CheckRow helper), 201 raw `<input type="radio">` (RadioRow helper), 244 `JSON.stringify` (answers baseline), 246 `JSON.stringify` (dirty check)
- packages/dashboard/src/pages/accounts/detail/password.tsx — 63 `type="radio"`, 72 `type="radio"`
- packages/dashboard/src/pages/logging/index.tsx — 54 `type="checkbox"` (TriCheckbox helper; the page body already uses kit `Checkbox`)
- packages/dashboard/src/pages/assistant-live.tsx — (no hits)
- packages/dashboard/src/pages/assistant-live-buffer.tsx — (no hits)
- packages/dashboard/src/ui/n15-reorder-focus.test.tsx — (no hits)

No `<table` or `text-xl` hits in any listed file.

10 isolated runs before the ruling (`npx vitest run
packages/dashboard/src/ui/n15-reorder-focus.test.tsx`, one process per run):

- runs 1–10: 23 passed, 1 failed — the same single test every time:
  `duplicate-keyed distinct objects: a same-order interim rerender does not
  consume the restore`, at the second `expect(document.activeElement).toBe(xDown)`
  (line 480). Focus is on the button now labelled `Move x down` (the
  `focusedName()` assertion on the line above passes), but it is a different
  DOM node than the captured `xDown` (which is now labelled `Move y down`).

For comparison, the unmodified file on this same machine: 5 runs, of which 3
failed `a later pointer move-click is not overridden by the earlier keyboard
restore` (the flake the manual queue fixes — the 10 ms commit fires
mid-`user.click`), 1 failed that test plus `expires a never-timely restore`,
and 1 run was killed by the 30 s tool timeout before finishing.

Reading of `ui/OrderedList.tsx`: the restore in `useLayoutEffect` resolves the
committed item's row (`expected`) and focuses that row's up/down control. With
duplicate React keys (`key="dup"` on both the x and y rows), which DOM node
lands under that row after the commit is unspecified — React reuses the keyed
nodes in place, so focus (following `xDown`'s node) can end up on the sibling's
label while the moved item's control (same name, other node) receives the
restore. The pre-commit `toBe(xDown)` at line 473 passes; only the post-commit
node-identity assertion at line 480 cannot hold once commit timing is
deterministic. Per the brief this is reported as a product bug rather than
fixed here: no change to `OrderedList.tsx`.

## D2 remaining

Fresh inventory after steps 3–6:

- No raw `<select>`, `<textarea>`, `type="radio"`, `type="checkbox"`, `<table`, `text-danger`, or `text-xl` remains in the listed production page files.
- `packages/dashboard/src/pages/messages-assistant/skill-items.tsx:169,179,218` — `JSON.stringify` compares recurrence/request state to detect dirty fields and construct unchanged request patches; it is not rendered.
- `packages/dashboard/src/pages/messages-assistant/assistant-prompt-wizard.tsx:239,241` — `JSON.stringify` compares wizard answers to the initial baseline for unsaved-change detection; it is not rendered.
- `packages/dashboard/src/pages/run-detail/index.tsx:38` and `packages/dashboard/src/pages/ai-setup/index.tsx:111` appeared only when the broad page-directory search was used; they are outside the D2 Files list and were not changed.
- Test-only `JSON.stringify` response construction remains in the existing touched tests; it is not user-visible and does not alter request assertions.
