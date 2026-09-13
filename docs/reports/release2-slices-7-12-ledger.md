# Release 2, Slices 7–12 and Phase 4b — the running ledger

Continues `docs/reports/release2-slices-1-6-ledger.md`. Plan rulings continue
its numbering (PR-36 onward). Every ruling here is a decision taken on the
owner's behalf and can be reversed; each carries what it costs if wrong.

Implementation and task review in this run are dispatched through the
`opencode-delegate` plugin (evaluation in
`docs/reports/opencode-plugin-evaluation.md`); whole-branch reviews go to the
strongest model available (Opus via the Agent tool). The plugin keeps its own
mechanical ledger in `.oc-runs/<slice>/progress.md`, which is gitignored; this
file is the durable record.

**Branch:** `worktree-release2-slices-7-12` (from `main` @ `ec413d7`).

## Standing constraint for every slice in this run

The observe window is running on both guilds since 2026-09-12 (club floor
elapses 2026-09-27T02:49:57.656Z). **Nothing in Slices 7–10 or M1–M6 touches
`mod_rules`, `setRuleMode`, or the moderation paths of the effect gateway.**
Slice 11 is the first that may, and only under owner decision.

The flip-day question in `docs/reports/release2-slice-6-handoff.md` was already
answered by the owner (by hand, both guilds — `docs/STATE.md`) before this run
began; it was not reopened.

---

## Slice 7 — the application shell

ADR 0043 (`c003fca`), plan
`docs/superpowers/plans/2026-09-12-slice-7-application-shell.md`, dependencies
installed and verified by two throwaway jsdom spikes (`c5836d6`).

### Plan review (muse-spark-1.3 via opencode, 2m30s)

Spec PASS, Quality NEEDS_WORK: 2 Important, 4 Minor. All verified before
acting; rulings below.

- **PR-36 — `JSX.Element` is not a global under `@types/react` 19.** Verified:
  `node_modules/@types/react/index.d.ts:4141` declares `JSX` inside the
  `React` namespace with no `declare global`. The plan's Interfaces blocks now
  say `ReactElement` and instruct that return types stay inferred in code.
  Cost if wrong: none — the code blocks never annotated returns.
- **PR-37 — `Field` restructured.** The reviewer found hint and error sharing
  one `useId` and `aria-describedby` on the `<label>`. Verifying that exposed a
  worse problem the reviewer did not name: with the hint inside the `<label>`,
  testing-library's `getByLabelText('Password')` would not match on the
  Bootstrap form, so Task 4's own test would have failed. Hint and error now
  sit outside the label with distinct ids and are attached to the control via
  `cloneElement`. Cost if wrong: a `Field` child that is not a single element
  gets no description — every current caller passes an `<Input>`.
- **PR-38 — Overview and Panels tests assert every rendered field**, not three
  of them. The reviewer's point: a page that dropped the dry-run, kill-switch,
  breaker or scheduler-lag rows would have passed. Cost if wrong: none.
- **PR-39 — `NavEntry` has no `area` field.** ADR 0043 D3 named one; nothing
  in Slice 7 groups the rail, so the field would be decorative. ADR amended to
  `{ path, label, status }`; grouping is added when Slice 8 first has two
  entries in one `docs/06` area. Cost if wrong: a one-field addition later.
- **PR-40 — Coordinator setup commit.** The dependency install and the
  `vitest.config.ts` include line were committed by the coordinator
  (`c5836d6`) rather than dispatched, because they had to exist for the plan's
  library claims to be verified against `node_modules` before any brief
  asserted them. Cost if wrong: none; the commit is reviewable like any other.

### Task log

(appended per dispatch)
