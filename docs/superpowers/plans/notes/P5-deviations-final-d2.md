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

10 isolated runs after the change (`npx vitest run
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
