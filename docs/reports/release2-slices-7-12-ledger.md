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

**Task 1 — tokens, primitives, `useResource`** (muse-spark-1.3, 14m44s,
commits `4325f8f..59f3cd5`, 8 tests). Reported `DONE_WITH_CONCERNS`; the
task review (1m33s) returned Spec FAIL / Quality APPROVED on the same two
concerns. Coordinator re-ran the verification and two gates in the plugin's
worktree: 8/8, typecheck 0, lint 0.

- **PR-41 — three deviations from the plan's verbatim code accepted, all
  forced by repo tooling and all verified.** (a) `packages/dashboard/tsconfig.json`
  now excludes only `*.test.ts`, so `*.test.tsx` belongs to the DOM+jsx
  project; excluded from both projects, typed ESLint could not resolve them.
  (b) `eslint.config.js`'s test-relaxation glob gained `**/*.test.tsx`.
  (c) `Resource<T>` is defined in `hooks/useResource.ts` and re-exported from
  `ui/DataState.tsx`, because `tsconfig.all.json` includes every `.ts` under
  `packages/*/src` with no `jsx` option — a `.ts` file cannot import from a
  `.tsx` module (TS6142). Also: `afterEach(cleanup)` in every component test
  (vitest `globals` is off, so RTL's auto-cleanup never registers — without it
  `DataState.test.tsx` fails on duplicate `role=status`). All four carried into
  the plan's Global Constraints for Tasks 2–4. Cost if wrong: two one-line
  config edits to revert.

**Task 2 — session provider, toasts, dialogs** (5m05s, `3ce65c7`, 19 tests).
Review PASS/APPROVED, no findings. **Task 3 — the five pages and the health
provider** (5m10s, `9b8622e`, 28 tests). Review PASS/APPROVED, no findings.
**Task 4 — routes, shell, state strip, `App.tsx` rewrite** (5m17s,
`2ad5b31..690e244`, 41 tests; full suite 2,429; Vite build emits
`index.html` and an 11.5 KB CSS asset carrying the tokens). Review
PASS/APPROVED, one Minor deferred. The implementer corrected two defects in
the plan itself: a `findByText` that could never pass because the guild name
legitimately renders twice, and `error={error}` under
`exactOptionalPropertyTypes`.

### Whole-branch review (Opus, `docs/reports/slice-7-whole-branch-review.md`)

**SHIP-WITH-FIXES: 3 Important, 5 Minor, 4 decorative tests, 3 missing
tests.** All four task reviews had passed; none saw any of the three.

- **I-1 — the re-auth dialog kept the typed password in state after cancel.**
  `ReauthDialog` never unmounts (only `open` toggles), so the next prompt
  opened pre-filled and the password sat in memory for the session. Real;
  fixed in the wave.
- **I-2 — cancelling re-auth raised a sticky danger toast reading the raw
  server code `reauth-required`.** New behaviour (the old page let the
  rejection go unhandled), contradicting D4's copy rule, and
  `session.test.tsx` locked it in. Real; fixed: a neutral "Cancelled —
  nothing was changed", and a rejected password maps to "Password not
  accepted".
- **I-3 — the state strip was silent when `/api/health` failed**, so on four
  of five pages a kill switch that was on would read as "nothing held". Real;
  fixed: an explicit "Health unknown" hold, and the strip becomes a labelled
  `<section>` rather than a live region.
- **PR-42 — the focus ring is ink, not amber.** The plan put `--color-hold` on
  `:focus-visible`; ADR 0043 D4 says the hold colour is never on a button.
  The ADR stands; the CSS changes. Likewise the danger button's hover is a
  15% tint, not a fill, and overlays use `bg-canvas/70` so no colour is named
  outside the token set. Cost if wrong: a less conspicuous focus ring, still
  4.5:1 in both themes.
- **PR-43 — `ConfirmDialog` gains `busy`** so a double-click cannot send two
  `POST /api/killswitch` and write two audit rows. Cost if wrong: none.
- **Parked, real-and-deferred to Slice 8:** the single re-auth resolver can
  be overwritten by two concurrent writes (inherited verbatim from the old
  `Dashboard`; unreachable today because every writer is `busy`-gated and one
  page mounts at a time — Slice 8's first page with two writers must queue or
  refuse); and `DataState`'s `degraded` state has no producer yet — Slice 8's
  pages are where a stale-but-served state first exists.
- **Decorative tests made real:** "exposes Sign out" now asserts the
  `POST /api/logout`; the guild-name check is scoped to the rail; the
  "nothing held" strip test waits for the resource to be *ready* rather than
  for `fetch` to have been called. Added: `ReauthDialog` submit/cancel/Escape,
  `ConfirmDialog` busy, and `Field`'s `aria-describedby`/`aria-invalid` wiring
  (the thing PR-37 restructured it for, previously untested).

### Fix wave and close-out

Fix wave 1 (muse-spark-1.3, 10m18s, eight commits `23cb3e8..461836c`, 50
dashboard tests); the coordinator watched two of the new guards fail (the
password-clear and the health-unknown hold, each broken by one line and
restored with `git restore`). Scoped re-review: ALL ADDRESSED, no new
breakage — but it did not answer the branch-ordering question the brief
asked, so the coordinator read the branch itself and found a residual **the
fix brief had caused**: "any other 401" mapped an expired session
(`unauthenticated`) to "Password not accepted". Round 2 (1m21s, same session,
`6f8f44a..80166ce`): the three 401 bodies the server can send map to three
outcomes — `reauth-required` → neutral "Cancelled"; `invalid-credentials` →
"Password not accepted"; `unauthenticated` → "Signed out" plus `onLoggedOut()`.
Re-review ALL ADDRESSED (23 s; again skipped the deliberate check, which the
coordinator verified: `onLoggedOut` is in the `useMemo` dependency list).

Merged `14c3557` into `worktree-release2-slices-7-12`. The merged tree linted
**red** — not the code: ESLint walked into the plugin's `.oc-worktrees/`
(307 parse errors from a second copy of every source file), the exact
failure `.claude/worktrees/**` was already ignored for. `770c1b4` adds
`.oc-worktrees/**` and `.oc-runs/**` to the ESLint and prettier ignores.

**Gates on `770c1b4`, each run alone, read by exit code: typecheck 0, lint 0,
test 0 — 2,439 tests across 127 files** (2,388 + 51 new). Built `dist/` and
screenshotted four pages with a stubbed API through Playwright's cached
Chromium: rail, amber strip, tables, both themes render as ADR 0043 D4
describes.

**Carried forward to Slice 8:** the single re-auth resolver (queue or refuse a
second concurrent write); a first producer for `DataState`'s `degraded`
state; the `NavEntry.area` grouping once two entries share a `docs/06` area
(PR-39).

---

## Slice 8 — the Release 2 pages

No ADR named (spec §9). Plan
`docs/superpowers/plans/2026-09-12-slice-8-release-2-pages.md`. The design
choices the spec leaves open, recorded before the first dispatch:

- **PR-44 — no new capability.** Rule reads use `config.read`, rule writes
  `config.write`, case reads `audit.read`. A new capability name would not
  reach the existing owner account without a migration (bootstrap granted the
  list as it stood on 2026-08-30), and a dashboard whose owner cannot open its
  new pages is worse than a coarser capability. Cost if wrong: a later
  migration to split `automod.manage` out of `config.write`.
- **PR-45 — re-auth on rule creation and mode changes only.** Both change
  what the bot does to real messages; a config edit or an exemption does not
  start or stop anything. Cost if wrong: a fresh-password prompt added to two
  more routes.
- **PR-46 — the admin queries live in a new module,
  `automod-admin.ts`**, not in `automod-rules.ts`, which owns the state
  machine and the subscriber's hot path while the observe window runs. The
  one exception is `findRuleIncludingDisabled`, added beside
  `listEnabledRules` because it needs that module's private `hydrate`.
  Cost if wrong: one file to fold back.
- **PR-47 — the dashboard may dry-run a disabled rule.** The edit → dry-run →
  enable workflow needs it; the CLI's enabled-only `findAutomodRule` and its
  reasoning are unchanged. Cost if wrong: none — a dry run writes nothing.
- **PR-48 — the mode dialog states the state machine's consequence, and
  restricts nothing the server permits.** `enforce` is disabled client-side
  only when `enforcementEligibility` says so, mirroring the server; every
  other transition is allowed with its effect named in full sentences before
  confirmation, including the one that leaves an observe clock running on a
  rule that has stopped observing. The server is the gate; the dialog is the
  scope statement `docs/06` requires. Cost if wrong: an operator who reads
  the sentence and clicks anyway — which is the owner's call.
- **PR-49 — a native `<select>` for the rule kind.** Eleven options on a
  create form one person uses; the Radix Select is reserved for Slice 9's
  per-row verdict control where keyboard operation inside a table matters.
- **PR-50 — rule configuration is edited as JSON, validated server-side by
  the kind's Zod schema.** Ten per-kind forms is a slice on its own; a
  textarea with the schema's issues rendered under it is honest for "one
  technically capable owner" (`docs/06`) and keeps one validator (rule 3).
  Cost if wrong: per-kind forms later, over the same route.
- **Rule creation is in scope**, per `STATE.md` ("the creation surface
  arrives with the dashboard (Slice 8)") — the nine kinds from Slices 1–5
  have no production caller until it exists.
