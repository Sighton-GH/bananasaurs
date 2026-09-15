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

### Plan review (muse-spark-1.3, 2m41s)

Spec FAIL / NEEDS_WORK: 1 Critical, 8 Important, 6 Minor — all verified, all
applied at `cf3aaf8` before any dispatch. The Critical was the
coordinator's: the plan had core importing types from `@bananasaurs/storage`,
which `eslint.config.js` bans and ADR 0014 forbids; the port types are now
re-declared in core the way `AutomodRule` and `FixtureRecord` already are.
The Importants were names asserted from memory (`read`/`write` live in
`write.ts`; `DryRunReport`'s real fields; `RULE_KINDS` in
`predicates/types.ts`; `ConfigValidationResult` carries `reason`/`detail`,
not `issues`; the CLI names are `invite-allow`/`invite-deny`/`domain-add`/
`domain-rm`, and keyword terms have no CLI editor at all), a missing
`enforce` sentence in the mode dialog, and a missing route test for the
PR-47 workflow.

### Task log

**Task 1 — `automod-admin.ts`** (6m09s, `f4eb728..cb036a3`): tests written
first and watched failing (the step-1 commit is the red run), 6/6 after, each
with a second guild seeded. Review PASS/APPROVED.

**Task 2 — the port surface** (11m59s, `9cdaa35..145d1a4`, 88 tests in the
covering files): `findRuleIncludingDisabled` with its two-guild test, the
eleven members declared in core and implemented three times.

- **PR-51 — a fourth hand-built `OpsPorts` literal exists**
  (`packages/storage/src/repos/automod-rule-lists.test.ts`), which the plan
  did not know about; the implementer gave it eleven `notNeeded` stubs
  outside its Files list because typecheck cannot pass otherwise. Accepted.
  Cost if wrong: none. The plan's "implemented three times" was wrong by
  one, and the next plan that widens `OpsPorts` should say four.
- The review, asked in its own section to compare the wiring's field
  mappings against the storage shapes, did so and found nothing dropped,
  renamed or defaulted. That brief shape — a named check with file paths —
  is what makes the muse-spark reviewer investigate rather than list under
  "cannot verify".

**Tasks 3–7** (automod routes 6m40s `fe5e94b..0cf43d5`, 42 tests; case
routes 3m59s `d8a73b6..8916f42`, 18 tests; rules list + cutover board + the
re-auth queue 10m02s `10a98d9..7161c99`; rule detail 14m08s `84cf05d`; cases
pages 4m46s `c46987f`). Every task review PASS/APPROVED; seven Minors
deferred to the whole-branch wave. Branch head `c46987f`: **2,534 tests
across 134 files**, gates green.

- **PR-52 — `writeOrThrow` beside `write`, and `vi.useFakeTimers({ toFake:
  ['Date'] })`.** A form must render a 400's `detail` and a 409's refusal
  inline, which the toast-only `write` cannot supply; a full fake clock
  freezes the timers RTL's `findBy` polls with and hangs every async
  assertion. Both accepted. Cost if wrong: one helper to fold back.
- The muse-spark reviewer answered a deliberate check only when the brief
  gave it its own heading and a place to put the answer ("report it as its
  own Finding line") — Task 6's seven-branch trace of the mode dialog
  against `setRuleMode` and Task 2's field-mapping audit were produced that
  way; the same check phrased inside `# Method` was skipped twice.

### Whole-branch review (Opus, `docs/reports/slice-8-whole-branch-review.md`)

**SHIP-WITH-FIXES: 3 Important, 3 Minor, 3 decorative tests.** No path to an
impermissible state transition; guild scope, capabilities, re-auth and
validation all traced clean. What the seven task reviews missed:

- **I-1 — the mode dialog is silent about `enabled` when both change.** An
  operator picking `observe` and unticking Enabled on a `not_started` rule is
  told the window starts; the server stamps `observe_started_at` **and** sets
  `enabled = 0` in one write, so the clock runs on a rule matching nothing —
  the "worthless window" shape ADR 0042 §1 exists to prevent. PR-48 permits
  the transition; it requires the sentence. Fixed in the wave;
  `modeScopeSentence` becomes an exported pure function with a nine-row
  `it.each`.
- **I-2 — the three `writeOrThrow` callers bypassed Slice 7's 401 mapping.**
  An expired session mid-edit showed "The request failed" and left the page
  looking signed in; a read-only instance lost its hold toast. Fixed: one
  shared error handler; `writeOrThrow` throws only 400/409.
- **I-3 — one of seven sentences tested**, and the `enforce` radio's disabled
  state untested. Fixed in the wave.
- Minors fixed in the same wave: the mode audit row's `before` carries
  `cutoverState` and `observeStartedAt`; the `countReviewedByRule`
  cross-guild test seeds a colliding `eventId` in the other guild; the
  production `runAutomodDryRun` gets an integration test on a disabled rule
  (the PR-47 proof the route test cannot give, because test-support's twin is
  canned); the 409 test compares whole rows; the audit tests parse
  `before`/`after`.

### Fix wave and close-out

Fix wave 1 (muse-spark-1.3, 10m11s, eight commits `6b30310..a6d1ec1`, 199
tests in the covering files); the coordinator watched the I-1 guard fail
(one line of the `enabled`-with-`observe` sentence removed → the `it.each`
row went red) and restored it. Scoped re-review: ALL ADDRESSED, and both
deliberate checks answered with quoted branch order — `writeOrThrow` rethrows
only 400/409, `ReadonlyError` (a 503 `ApiError` subclass) lands in the shared
handler, and the dialogs left open after a handled failure are not a strand
(`busy` resets in `finally`; the expired-session path unmounts the shell).

Merged `7877ada` into `worktree-release2-slices-7-12`. **Gates on `7877ada`,
each run alone, read by exit code: typecheck 0, lint 0, test 0 — 2,548 tests
across 134 files** (2,439 → 2,548). Built and screenshotted the rule detail
page and the cutover board with stubbed data.

**Carried forward to Slice 9:** the Lists section's note reads "Slice 9's
review screen adds allowlist terms" — a plan reference in product copy, the
coordinator's own wording in the plan; reword when the screen exists. Task
7's four Minors (a duplicate `wouter` import, `statusBadge` duplicated
between `cases.tsx` and `member.tsx`, an unused `ModCase` re-export, an
unrendered `fixtureId`) and Task 3's extra `OpsSafetyState` export are
cosmetic and can ride along with Slice 9's first dashboard task. Path-param
validation runs before the auth guard on the new routes; the review judged
it leaks only the caller's own input shape — left as is.

---

## Slice 9 — the false-positive review screen

No ADR named (spec §9). Plan
`docs/superpowers/plans/2026-09-13-slice-9-false-positive-review.md`. The
one Release 2's gate depends on: it supplies the numerator. Rulings before
the first dispatch:

- **PR-53 — native hits get their own query, not a widened
  `listUnreviewedMatches`.** Slice 2's PR-7 defined a match as "an event with
  a trace" precisely to avoid a hand-maintained `action_taken` list; native
  events have no trace by design. `listUnreviewedNativeHits` selects on the
  `native:` rule-id prefix the native subscriber writes, so the two queries
  stay honest about what each is. A verdict on a native hit records through
  the unchanged `recordVerdict` (which does not require a trace) under the
  `native:<id>` rule id — it feeds no Bananasaurs rule's gate, and it is not
  meant to; it records whether Discord was right. Cost if wrong: one query to
  fold.
- **PR-54 — verdicts and suppressions do not need a fresh password.** A
  verdict is evidence and is revisable; a suppression only narrows a rule.
  Cost if wrong: `requireFresh` on two routes.
- **PR-55 — the one-click suppression is per kind, and `regex` gets a link,
  not a button.** "Narrowed pattern" cannot be invented from a match; the
  honest action is the configuration editor. `caps`/`emoji`/`attachment_type`
  and the window tier get a channel exemption (the only one-click that does
  not require inventing a threshold); role exemptions are not offered from
  the queue because the match does not carry the author's roles. Cost if
  wrong: another button.
- **PR-56 — the F3.2 warning keys off rule kind and native's block count.**
  Native's three defaults filter mention spam, spam content and flagged
  words, which overlap `mention_spam`, `rapid_spam`/`duplicate_message` and
  `keyword_filter`; the warning renders when native has recorded at least
  one block and such a rule is in view. Discord does not publish its
  algorithms, so a finer overlap test would be a guess. Cost if wrong: an
  over- or under-cautious sentence.
- **PR-57 — `invite.last_matched_at` (PR-14) stays deferred, past the observe
  window.** It is a write per matched message in the subscriber's hot path,
  and Slice 4's review recorded that placed on `AutomodRule` without an
  `EXCLUDED_FIELDS` entry it would recompile — and reset — every windowed
  rule's window on every observed message. Not a change to make while the
  clock the release depends on is running. Flagged to the owner in the
  handoff. Cost if wrong: a rotated partner code sits unnoticed for the
  length of the window.
- **PR-58 — the handwritten-fixture synthetic author stays deferred, with a
  sharper reason:** `addHandwrittenFixture` has **no production caller** —
  no CLI command and no dashboard surface creates a handwritten fixture, so
  the collapsed-author replay Slice 4 warned about cannot occur. The fix (a
  nullable author key, a migration) ships with the first fixture creator,
  which no Release 2 slice names. Cost if wrong: none until a creator exists.

### Plan review (muse-spark-1.3, 2m29s)

Spec PASS / NEEDS_WORK: 6 Important, 6 Minor, all applied before any
dispatch. The one that was a decision rather than a correction:

- **PR-59 — a suppression preserves the enforcement sign-off.** The reviewer
  asked why list edits from the review screen do not void
  `enforce_signed_off_by/at` the way `setRuleConfig` does under ADR 0042
  Amendment 2. Because every suppression strictly narrows the rule — an
  allowed phrase, code or domain, an exempt channel — and narrowing cannot
  create the false positives a sign-off attests against; Amendment 2 voids
  on configuration *replacement*, which can widen. The suppress route
  therefore writes nothing to `mod_rules`, which is also the answer the
  observe window wants. Cost if wrong: a sign-off that survives a narrowing
  edit — by construction not less true than before.

The corrections: the storage-level `recordCaseEvent` shape (the plan had
pointed at the port-level one); `addLinkDomain` returns an object, not a
string; a form control must not live inside `Dialog.Description`, so
`ConfirmDialog` gains a `children` slot; the review-GET test needs its own
traced-match seeder; audit assertions name `subjectType`/`subjectId`;
"blocked" counts the three native actions that stop a message, not one;
domains lower-cased before validation; the snippet-only copy covers
enforce-mode deletions.

### Task log

**Task 1 — `automod-admin.ts`** (5m09s, `54158d9..f8b9a10`, muse-spark-1.3):
`listUnreviewedNativeHits`, `countVerdictsByRule`, `countNativeBlocked`,
each with a two-guild test. Review Spec FAIL on one Important — guild B was
seeded with a *different* event id, so a missing `guild_id` filter would
not have been caught — plus one Minor (`native_blocked_interaction` never
seeded). Fix round 1/5 (51 s) addressed both; the controller read the
two-line diff in place of a re-review.

**Task 2 — ports ×4 and the three routes** (5m49s to the rate limit, then
the sonnet continuation `72ee3ad..f0cddee`; 121 tests in the covering
files): the free tier ran out mid-task (`FreeUsageLimitError`, account-wide
across free models). The plugin's auto-checkpoint kept the half-written
routes; a sonnet subagent verified the work was complete and only
formatted. Review (sonnet) PASS/APPROVED, two Minors deferred: POST routes
parse before auth (pre-existing pattern), verdict audit `after` includes the
outcome.

**Task 3 — the Review page** (10m42s, sonnet, `e5985fd..8531efc`, 10 page
tests): opencode returned 429 on two probes across five hours, so the task
ran on sonnet with the same brief. Review (muse-spark-1.3, 3m31s, once the
limit lifted) PASS/APPROVED.

- **PR-60 — three one-line `verdicts:` fixture additions outside the Files
  list are accepted.** Task 2 made `RuleSummary.verdicts` required; the
  Slice 8 page tests' fixture factories could not typecheck without it.
  Cost if wrong: none — test fixtures only.
- The reviewer's `Findings: None` silently dropped the four deliberate
  checks the brief asked for as Finding lines; the controller verified all
  four from the diff (all correct). From Task 4 on, the checks are slots in
  the RESULT template (`Check A: …`), and that shape was answered in full.

**Task 4 — suppression, the verdict split, the Slice 8 residue** (13m08s,
muse-spark-1.3, `47071a9..0ec5aaa`, five step commits; review 45 s
PASS/APPROVED, checks A–D quoted): `ConfirmDialog` gains a `children` slot
rendered outside `Dialog.Description` with a test that the input is
focusable and not inside the `aria-describedby` target; per-kind suppression
through `writeOrThrow` with 409 `wrong-kind` caught to a danger toast;
`statusBadge` exported from `cases.tsx`; the Lists note reworded. The
model's RESULT block left `Commits:` and `Concerns:` as template
placeholders — the controller filled them from the commit log and the
worktree.

- **PR-61 — two `fixtureId: undefined` removals in `cases.test.tsx` are
  accepted.** Step 3 removed the unrendered field from `case.tsx`'s type;
  the fixture could not typecheck with it. Cost if wrong: none.

Branch head `0ec5aaa`: **2,588 tests across 135 files**, typecheck, lint and
test each exit 0, re-run by the controller in the worktree.

### Whole-branch review (Opus, `docs/reports/slice-9-whole-branch-review.md`)

8m33s, 45 tool uses. **SHIP-WITH-FIXES**: three Important that no per-task
review saw, because each needed a read outside the diff — obscenity's
whitelist matcher, the link-domain predicate's mode filter, the three
predicates' snippet contents. Third slice in a row where the whole-branch
review earned its cost.

- **PR-62 — a `link_domain` suppression on a deny-mode rule removes the
  domain from the deny list.** The route had always written an allow row,
  which a deny-mode rule never reads: an inert row, `200 added`, "Domain
  allowed", and the match keeps firing. Removal is still strictly narrowing
  (PR-59 holds). When the matched domain is not itself on the deny list (a
  parent is), the route answers 409 `not-denied` and the dialog says to
  narrow it in the configuration. Cost if wrong: an operator who wanted an
  allow row on a deny-mode rule — which cannot do anything — does not get
  one.
- **PR-63 — the suppression dialog prefills from the trace's `matchedOn`,
  falling back to the snippet.** The snippet is the matched span
  (`discord.gg/abc`, the whole URL, `Ass`), not the value the route
  accepts; `matchedOn` is the code, the host, the configured term, which
  ADR 0041 R-8 already calls "the thing a reviewer acts on". A pure helper
  `suppressionPrefill` in `api/automod.ts`. Cost if wrong: a prefill the
  operator edits before confirming.
- **PR-64 — allowlist phrases are stored lower-cased and space-collapsed.**
  obscenity lower-cases the input and searches for the raw whitelisted
  term, so a phrase with any uppercase letter could never match; the
  pre-check was also case-sensitive, so `Ass` then `ass` made two rows.
  Canonicalised in both port literals; the audit row records the canonical
  value; blank phrases are a 400. Cost if wrong: none — the matcher only
  ever sees lower case.
- **PR-65 — verdicts on non-automod events are deferred.** A `config.write`
  operator who pastes a `manual` event id records a verdict the tally
  shows under `manual`. The guard needs a storage read of the event's rule
  id before `recordVerdict`, which the observe-window constraints make a
  poor trade for a Minor. Carried to the Slice 10–12 residue list. Cost if
  wrong: a `manual` row on the tally that an operator has to explain.

Minors taken into the same fix wave: native rule ids rendered as text
(`/automod/native:1` is not a route); `encodeURIComponent` on every
interpolated id; `INVITE_CODE_PATTERN` widened to the predicate's own
`[\w-]{2,64}`; a two-guild test for the phrase write. Decorative tests
closed: the scope sentence is asserted against an *edited* value; PR-59 is
asserted per suppression kind (sign-off columns byte-for-byte unchanged).

### Fix wave and close-out

One fix dispatch (muse-spark-1.3, 12m14s, `9eb0c6c..3a40697`, nine task
commits and a `lint:fix` commit) with every finding and both decorative
gaps; the RESULT block came back fully filled. Scoped re-review (42 s):
**ALL ADDRESSED**, three deliberate checks quoted from the code — the 409
`not-denied` returns before `recordAudit`; the two port literals share the
identical canonicalisation expression and pre-check on it; the dashboard's
`not-denied` catch sits inside the same 409 gate as `wrong-kind`, so a 400
still falls through. No new breakage.

Merged `oc/slice-9-review` into `worktree-release2-slices-7-12` with
`--no-ff` (`cbd6000`; the plugin's `--merge` still cannot validate a
multi-task plan, D15). Gates on the merge, each alone, by exit code:
typecheck 0, lint 0, test 0 — **2,602 tests across 135 files** (+68 this
slice: 14 route, 16 page, 6 dialog/tally, 32 storage and port).

Carried forward to Slices 10–12: PR-65 (verdicts on non-automod events);
Task 2's two Minors (POST routes parse before auth — pre-existing shape;
the verdict audit `after` includes the outcome); PR-57 (PR-14 deferred past
the window); `/mydata` and `/forgetme` owed.

What this slice teaches that Slices 7–8 did not: **every Important the
whole-branch review found needed a read outside the diff** — a dependency's
matcher, a predicate's mode filter, the shape of a stored snippet. Task
reviews are given the diff and told not to crawl, which is the right cost
control for a per-task gate and exactly why the whole-branch reviewer must
be told the opposite. The brief's "verify, do not assert; say what you ran
or read" is the load-bearing line.

## Slice M1 — archive schema, ingestion, retention

Branch `oc/m1-archive` from `08a3bd9`. ADR 0046 accepted before planning;
its Amendment 1 written at planning, after a read-only research dispatch
(muse-spark-1.3, 10m40s, sixteen questions answered with file:line) found
four things the ADR assumed that the tree did not have.

### Rulings at planning (ADR 0046 Amendment 1)

- **PR-66 — `messageDeleteBulk` enters the pipeline.** The adapter
  translated three message events; D5 named four. New domain event,
  fingerprinted on channel + sorted ids. Cost if wrong: a subscriber that
  did not expect the kind — none exists; the logging subscriber gained an
  early return.
- **PR-67 — attachment bytes are deferred out of M1; `none` records no
  hash.** Hashing needs the bytes; nothing in the tree fetches bytes from
  anywhere, and the first outbound byte fetch is a rule-8 event for a later
  ADR. The policy column, CHECK and nullable `sha256`/`bytes_path` ship now;
  `--attachments bytes` is refused with `'attachments-bytes-not-built'`.
  Cost if wrong: an attachment whose CDN URL expires before the fetcher
  exists — recoverable while the message lives.
- **PR-68 — `FetchedMessage` gains `editedTimestampMs` and `attachments`;
  `MessageAttachment` gains `attachmentId`.** Purge's pager carried
  neither. Cost if wrong: none; purge reads neither field.
- **PR-69 — the case link is `archive_messages.case_id`, set by the
  operator.** No column ties a message to a case and nothing closes a case
  yet. `linkToCase` verifies the case exists and is open. The `case` tier's
  90-day clock starts at the latest `mod_case_events.at` of a closed case —
  inert in production, tested with a seeded closed row. Cost if wrong: a
  linked row that never expires while cases never close — which is the
  conservative direction.
- **PR-70 — `archive_expiry` is produced by a daily timer.** The job table
  has no scheduler. One `archive_expiry` per guild per UTC day, dedupe key
  `archive_expiry:<yyyy-mm-dd>`, proven through the real `jobs_dedupe`
  index. Cost if wrong: a second timer design later; the job is unchanged.

### Plan review (muse-spark-1.3, 7m07s)

Spec FAIL / NEEDS_WORK: 8 Important, 11 Minor, all applied before the first
dispatch. The ones that would have cost a fix round each: three missing
snowflake CHECKs the invariants test enumerates by column name; the logging
subscriber's `switch` has no `never` guard, so a new event kind compiles and
throws at runtime; `opsPortsFor` receives no config; the per-channel
permission precedent is `wiring.ts:591-621`, not the guild-level doctor
code; discord.js types the bulk-delete channel as always-guild; `'failed'`
was an unreachable CHECK value.

### Task log

**Task 1 — the pipeline** (`32da41d..fb8acb8`): muse-spark-1.3 stopped at
NEEDS_CONTEXT after 3m47s with exactly the right question — the plan's
required `attachmentId` broke literals in files the observe window forbids.

- **PR-71 — `attachmentId`, `editedTimestampMs`, `attachments` are
  optional properties.** A fixture-derived attachment has no Discord id;
  purge's callers predate the fields; the adapter, REST port and fake
  always populate them; the archive skips an attachment without an id.
  Cost if wrong: a row missing an attachment that had no id, which live
  events never produce.

Resumed; Steps 2–3 committed; then the session hung (32 minutes, no event,
D40). Two fresh-session re-dispatches were 0-byte (`ECONNRESET`, provider
degraded — D41); Step 4 ran on sonnet (9m42s). Review (sonnet, 4m21s)
PASS/APPROVED, one Important — the bulk-delete test asserted ids
order-independently while the interface promises Discord's order — fixed in
one line (`fb8acb8`), verified by the controller. `Partials.Message` is on
(`client.ts:60`), so a bulk delete carries every id.

**Task 2 — config, schema, migration, PRIVACY.md** (`6d6f0cd..305d481`,
one commit as required, plus a formatting commit): muse-spark-1.3 did the
task in ten minutes, verified it, then went idle after `typecheck` (D42);
the plugin's checkpoint on kill was the required single commit. Review
(muse-spark-1.3, 1m57s, after two 0-byte attempts) PASS/APPROVED, four
checks quoted, and it verified the "unset → `[]`" test is not vacuous.

**Task 3 — the repository** (`bc772d3..ff37cdb`, 6m35s): red-first commit;
the tests caught a real seeding bug (two open cases for one member violate
`mod_cases_open_per_member`). Review 1m18s PASS/APPROVED.

- **PR-72 — `linkToCase` to a different case re-links.** No unlink exists,
  so a wrong link must be movable; the audit row records both. Cost if
  wrong: an operator moves a link they meant to keep.

**Task 4 — the subscriber** (`0e08be6..9a83795`, 8m51s): the implementer
said plainly that its veto red-run was vacuous (an absence passes against
an empty handler). The controller neutralised each veto line in turn and
watched 1 / 2 / 1 tests fail. Review 1m47s PASS/APPROVED; one Minor
deferred (a channel constant used as a message id in one test).

**Task 5 — backfill, expiry, the timer** (`a2b68f8..96523a0`, 16m08s):
DONE_WITH_CONCERNS, all three concerns answered by a ruling or a reading.

- **PR-73 — three queue-count assertions in `daemon.integration.test.ts`
  now name the job kind**, because the expiry timer enqueues one job at
  startup. Test-only. Cost if wrong: none.

Review 42 s PASS/APPROVED with all four checks quoted: cursor persisted
before continuation, resume with a fresh handler, dedupe through the real
index, day 29/30/31 through the real repository, timer stopped on the
backup timer's path.

**Task 6 — ports ×4, five commands, doctor** (`5c6951b..9a45a12`): the
first run committed Steps 1–2 and went idle mid-edit when the free tier hit
(D43); checkpoint, continuation, 7m11s. Review 2m29s Spec FAIL on one claim
stated twice.

- **PR-74 — refusals audit.** The plan said `'already-enabled'` records no
  audit; the codebase says the opposite — `OpsWriteResult.audit` "is not
  optional", and `automod signoff` / `invite-add` audit their refusals with
  `after.outcome` because "an operator tried to edit a rule that does not
  exist is a fact worth having". The implementer followed the codebase;
  the plan line was wrong and is corrected. Cost if wrong: one audit row
  per mistyped `enable-channel`.

Branch head `9a45a12`: **2,702 tests across 142 files** (+100), typecheck,
lint and test each exit 0, re-run by the controller in the worktree.

### Whole-branch review (Opus, `docs/reports/m1-whole-branch-review.md`)

7m24s, 42 tool uses. **SHIP-WITH-FIXES**: one Critical, three Important,
six Minor. Fourth slice in a row where the whole-branch review found what
the per-task reviews could not — and again every one of them needed a read
outside the diff.

- **PR-75 (Critical) — the backfill continuation collided with its own
  still-`running` job row.** `archiveBackfillDedupeKey(guildId, channelId)`
  is the key the running tick's own row holds; `jobs_dedupe` is unique over
  `state IN ('queued','running')` and `enqueue` uses `onConflictDoNothing`,
  so the successor was silently refused. A channel over 100 messages would
  have backfilled exactly one page and sat in `running` with a frozen cursor
  forever, with nothing to say why. **`packages/core/src/mod/purge.ts:20-60`
  documents this precise hazard at length** and avoids it by keying every
  successor off the tick's own `jobId`; the archive repeated what purge had
  already written down. Fixed with purge's two-shape key
  (`…:<channel>` first, `…:<channel>:after:<jobId>` after), and a real-queue
  integration test that drives two ticks through `jobRepo` — the controller
  reverted the key to the colliding shape and watched that test fail. Cost
  if wrong: the archive quietly holds one page per channel.
- **PR-76 (Important) — the backfill honoured one of three vetoes.**
  `BackfillPorts` had only `findChannel`: a guild removed from
  `BANANASAURS_ARCHIVE_GUILDS` with a job already queued kept ingesting, and
  a channel in `log_excluded_channels` was refused by the subscriber and
  fully backfilled by the job. ADR 0046 D1's whole point is that the
  precondition is a check, not a note. Both added ahead of the fetch, both
  directions tested against the call count.
- **PR-77 (Important) — a deleted row whose content was already NULL never
  purged.** The candidate predicate required `content IS NOT NULL`, so an
  attachment-only or embed-only message (the REST pager maps `''` to
  `undefined`) kept its attachment filenames and edit rows indefinitely and
  never stamped `content_purged_at` — against PRIVACY.md's own words. Now
  `deleted_at IS NOT NULL AND content_purged_at IS NULL`.
- **PR-78 (Important, latent) — a closed case with no events never
  expired.** `caseClosedAt` returned `undefined`, which the `case` tier read
  as "not due yet". Falls back to the case's `openedAt`. Latent only because
  nothing closes a case yet.
- Minors fixed in the same wave: PRIVACY.md names the edits table (PR-79);
  the expiry timer skips a guild with no archive channels; `attachment_id`
  gains its format CHECK and the invariant set names it (migration `0019`);
  `disable-channel` audits the message count it destroyed;
  `archiveLinkCase` stops reporting a preserved message as "already
  linked"; the untested `unreadableArchiveChannels` permission logic gets
  its own test; two comments (the backfill throttle, the two-clock
  `created_at`).

### Fix wave and close-out

One fix dispatch (muse-spark-1.3, 14m48s, `78b2d50..1faaae6`, one commit per
task plus `lint:fix`) with every finding; the implementer chose the right
home for the real-queue test (eslint bans `packages/core` from importing
`@bananasaurs/storage`) and said so. Scoped re-review (1m35s): **ALL
ADDRESSED**, no new breakage, one comment-only observation left (two stale
"per-channel dedupe key" header comments).

Merged `oc/m1-archive` into `worktree-release2-slices-7-12` with `--no-ff`
(`1a1c242`). Gates on the merge, each alone, by exit code: typecheck 0,
lint 0, test 0 — **2,717 tests across 144 files** (+115 this slice).

What M1 teaches that the dashboard slices did not: **the codebase's own
prose is a reviewer.** The Critical was not a subtle race — it was a hazard
a sibling module had already hit, documented in forty lines of comment, and
solved. A brief that had said "read `purge.ts`'s dedupe docstring before
writing the continuation" would have prevented it; the fix brief did say
that, and the fix was right first time. Task briefs now name the file that
already solved the problem, not just the file to copy the pattern from.

## Slice M2 — FTS5 search and permission-filtered citations

Branch `oc/m2-search` from `ddf3abe`. **ADR 0049 written before the plan**,
after a read-only research dispatch found a collision the slice text did not
anticipate: drizzle-kit cannot generate a virtual table, and the project's
own `strictify.mjs` says out loud that FTS5 tables cannot be `STRICT`. So
M2 needed the project's first hand-written migration.

### The ADR, and the amendment that undid a third of it

ADR 0049's first draft added a named exemption to `schema-invariants.test.ts`
for the FTS table and its four shadows. The plan review asked the question
the draft had not: *does `PRAGMA table_list` even report a virtual table as
a `table`?* Run rather than reasoned, the answer is no — the FTS table is
`virtual`, its shadows are `shadow`, and `allTables()` keeps only `table`.

- **PR-81 — the exemption is withdrawn (Amendment 1).** It would have been
  dead code, and its "exhaustiveness" test would have passed vacuously,
  which is worse than no test. Replaced by three positive tests: the
  machinery is `virtual`/`shadow` *for the reason we think* (so a future
  SQLite that reclassifies it fails loudly); the triggers keep the index
  from outliving its content; the index carries `guild_id` and a `MATCH`
  filtered by it returns only that guild's rows. Cost if wrong: the first
  test is the tripwire.
- **PR-80 — a review finding rejected.** The plan review said
  `WHERE archive_messages_fts MATCH ?` was wrong under an alias and should
  be `f MATCH ?`. Executing both: the plan's form works, the suggested fix
  raises `no such column: f`. The plan stood and the fact became a Global
  Constraint with its evidence. First review finding overturned by running
  the code rather than arguing about it.
- **PR-82 — `findMessage` is M2's.** ADR 0046 D6 promised purged content
  stays "reachable by `getMessage`"; M1 shipped no by-id reader, so the
  promise had nothing to call.
- The Critical the plan review *did* find: a journal entry whose `when` is
  not **strictly greater** than its predecessor is silently skipped on a
  database that has already migrated — indistinguishable from success.

### Task log

**Tasks 1–2 — the migration and the tests that pay for it**
(`927f143..871fb6e`): the hand-written `0020_archive_fts.sql` with the
virtual table and three triggers, the journal entry, and the three tests.
Task 1 reported `DONE_WITH_CONCERNS` over red `typecheck`/`lint` — correctly:
the controller had never run `npm ci` in the new worktree, and the model
proved its own four files clean with `prettier --check` and `eslint`
directly rather than reporting DONE over red gates. Review PASS/APPROVED.
Controller break-and-watch-fail: removing the `_ad` trigger fails 1 test;
removing `guild_id UNINDEXED` fails 3.

**Task 3 — `searchMessages`** (`7b0eb3a..891fca0`, 9m33s, red run first):
the citation-leak test written and watched failing, then one raw-SQL
function whose hits and count queries share a single `WHERE`.

- **PR-83 — the brief was wrong about `db.$client`.** It claimed the handle
  was reachable at the type level; the implementer found `TS2339` (the
  repo's `Db` alias is the bare class; `$client` lives on `drizzle()`'s
  return intersection) and recovered drizzle's own declared type through
  `unknown`, citing the runtime attachment — no `as any` anywhere in the
  file. Accepted. Cost if wrong: one cast to revisit if drizzle changes its
  export shape.
- **PR-84 — `rebuildSearchIndex` uses the transaction's typed handle**,
  because `$client` is absent at runtime on a `write()` transaction object.

Controller break-and-watch-fail: neutralising the visibility `IN` clause
fails 10 of 12 tests; neutralising the guild predicate fails 10. Review
PASS/APPROVED.

**Task 4 — ports ×4 and two commands** (`ef2ed51..5889240`, 7m11s): the
visibility set is built from `archiveRepo.listChannels(scope)` and never
from caller input. Review PASS/APPROVED.

### Whole-branch review (Opus, `docs/reports/m2-whole-branch-review.md`)

9m03s, 38 tool uses. **SHIP-WITH-FIXES** with a merge blocker, and it is the
question the brief pointed at hardest: *what happens on a database that
already has rows?*

- **PR-85 (Critical) — the migration created the index but never populated
  it.** An external-content FTS5 table created after rows exist is empty and
  stays empty — and worse, the `_au`/`_ad` triggers then issue FTS5
  `'delete'` for rows that were never indexed, which raises
  `database disk image is malformed`. **Reproduced independently by the
  controller** against the installed `better-sqlite3` with the exact shapes
  the migration ships: no rebuild → `MATCH` count 0, and both
  `UPDATE … SET content = NULL` (the retention purge) and `DELETE` throw;
  with one `'rebuild'` statement → all three succeed. Blast radius in this
  tree: `recordEdit` loses the edit; `expireContent` purges every candidate
  in one transaction, so a single legacy row aborts the whole retention run,
  permanently, every run — ADR 0046 D3 silently broken. Fixed by appending
  the rebuild as the migration's final statement, with a test that seeds at
  0019 and migrates through 0020. The controller removed the statement again
  and watched that test fail. Cost if wrong: none — the rebuild is a no-op
  on an empty table.
- **PR-86 (Important) — the catch swallowed everything.** A missing table,
  `SQLITE_CORRUPT` and `too many SQL variables` all returned "no results",
  identical to an operator's typo — which is what would have made PR-85
  invisible in production. Narrowed to the FTS5 syntax family; everything
  else rethrows.
- **PR-87 (Important) — nothing checked the index.** ADR 0049's
  Consequences claimed reindex existed "so a restored backup has a
  documented recovery"; the command existed, the documentation did not. Now
  an `archiveIndexHealth` port, a `doctor` line
  (`ARCHIVE INDEX STALE: …`), and a restore note in `docs/SMOKE_TESTS.md`.
  The implementer flagged, unprompted, that a row-count comparison detects
  row-level skew but not token-level staleness — recorded so the line is not
  read as a total integrity proof.
- **PR-88 (Important) — the slice's most security-relevant line had no
  test.** `archiveSearch`'s visibility set could have been regressed to pass
  caller input and every existing test would have stayed green. Now an
  integration test drives the real port.
- Minors fixed in the same wave: the placeholder list de-duplicated and
  capped (refusing above the cap rather than truncating a visibility set);
  the rebuild-is-global/count-is-per-guild seam named in the command text
  and the audit row; the deliberate choice that deleted-but-unpurged
  messages stay searchable written into ADR 0049 and pinned by a test; two
  decorative tests repaired.

### Fix wave and close-out

One fix dispatch (muse-spark-1.3, 17m52s, `ee69596..91c4a15`, one commit per
task) with every finding; scoped re-review (59 s): **ALL ADDRESSED**, no new
breakage. Merged into `worktree-release2-slices-7-12` with `--no-ff`.
Gates on the merge, each alone, by exit code: typecheck 0, lint 0, test 0 —
**2,755 tests across 145 files** (+53 this slice).

What M2 teaches that M1 did not: **the failure that matters is the one the
happy path never reaches.** Every per-task review, and every test, exercised
a database where the FTS table existed before any row did — which is true in
every test and false in every restore. The whole-branch brief asked "what
happens on a database that already has rows?" explicitly, and that single
question found a migration bug that could not have been fixed after it
shipped. Ask it of every migration from here.

## Slice M3 — the OAuth 2.1 authorization server

Branch `oc/m3-oauth` from `78fb00e`. **Not run lean** by the owner's
instruction: a plan review, seven per-task reviews, five fix rounds, an Opus
whole-branch review, a fix wave and a final scoped re-review. **ADR 0045
written first**, then amended twice — once before the plan and once at the
close, because both amendments were forced by facts the design did not have.
Rulings PR-90..PR-134.

### The ADR was wrong before a line was written

A read-only research dispatch plus the controller's own reading of the tree
found four claims the design's §5 asserted that the code did not support
(Amendment 1):

- **PR-90** — `policy.ts` holds no origin or CSRF rules at all; they live in
  `server.ts`.
- **PR-91** — the dashboard's CSRF is a **custom request header** matched
  against the session token. An HTML form cannot send one, and the consent
  page has no session to draw from, so it needed its own protection: a
  single-use pending-authorization row with a nonce, validated before
  anything renders. That added a fourth table.
- **PR-92 — the hole that mattered.** `account_capabilities` is keyed
  `(guild_id, account_id, capability)`, so `mcp.authorize` cannot be held
  instance-wide; but tokens are instance-level by D3. Left alone, an account
  granted the capability in guild A would mint a token M4 could point at
  **guild B** — a cross-guild leak arriving through the authorization layer
  rather than through a query. Ruling: the reachable guild set is never
  stored and never frozen; it is computed live at each call from the
  approving account's current grants.
- **PR-93** — `mcp.authorize` did not exist and did not typecheck.

### The plan review found three Criticals before any code

**NEEDS-REWORK**, and the reviewer executed rather than argued — it read
`originMatchesHost`, checked `ipOf` for `trustProxy`, and verified the
journal timestamp itself.

- **PR-94** — a code replayed after a rotation would not have killed the
  live tokens: only the first pair carried `issued_from_code_hash`. Every
  rotation now inherits it.
- **PR-95** — `verifyBearer` never looked at the account, so ADR 0045 D6's
  promise was false: a disabled owner's access token would keep working for
  an hour and its refresh for thirty days.
- **PR-96** — the consent form called `verifyPassword` directly, inheriting
  none of `login`'s dummy-hash timing, lockout-without-verify, disabled
  handling or failed-attempt recording: **an unthrottled password oracle
  that bypassed lockout**, sitting beside the front door it undercut. Task 4
  step 0 extracts `verifyAccountCredentials` so both paths share one
  implementation.

Eight Importants were accepted and two findings **rejected with reasons**:
consent phishing is inherent to RFC 7591 and already mitigated, earning one
line of page copy rather than a redesign; and `originMatchesHost` passing an
absent `Origin` is deliberate and load-bearing for non-browser callers.

### Task log

Seven tasks, each verified by the controller re-running the gates and
breaking the new guard:

| Guard neutralised | Failures |
| --- | --- |
| a seventh name added to `INSTANCE_LEVEL` | 1 — the exact-six tripwire |
| the recursive CTE in `revokeTokenChain` | 1 |
| PKCE `secretsMatch` | 1 — refusal (c) |
| the `usedAt` replay cascade | 2 — refusal (b) and PR-94 |
| refusal (f)'s capability check | 1 |
| `originMatchesHost` on the consent POST | 1 |
| a root-level form parser re-added | 1 — the login-CSRF guard |
| `account.disabled` in `verifyAccessToken` | 3 — across both layers |
| a real `Map` cache injected into `requireBearer` | 3 — including the named test |
| `token_type: 'Bearer'` → `'bearer-ish'` | 1 — the SDK's own parser |

Notable rulings along the way. **PR-120**: the Task 4 review's first *Minor*
was escalated to Important by the controller — the form parser was on the
root Fastify instance, so `POST /api/login` began parsing form bodies, and
since that route has no origin check, no CSRF token, and **issues the
session cookie**, while a cross-origin HTML form can send form-encoded
bodies with no CORS preflight and never JSON, a root-level parser converts
an unreachable route into **login CSRF**. The review measured the status
change without naming the consequence. **PR-124**: a `GuildScope` cast to an
`InstanceScope` — runtime-safe, but it fabricated the very type the
codebase guards, and the file being edited already stated the rule at
`:843-850`. Root cause was the controller's own brief, whose Files list left
no honest way to obtain a real instance scope. **PR-121**: the Task 5 brief
predicted a planted leak would fail the log-scan test; it did not, because
`token` is a Pino `redact` path — the implementer reported the contradiction
instead of forcing a failure.

### Whole-branch review (Opus, `docs/reports/m3-whole-branch-review.md`)

66 tool uses, 13m08s, six probes against a real database.
**SHIP-WITH-FIXES**, two Criticals, both confirmed by the controller before
the fix wave and probed after it.

- **PR-126 (Critical) — revoking the capability did not end the session.**
  `refreshTokens` re-checked account existence and `disabled` but never
  `mcp.authorize`. PR-92 says minting requires the capability; **rotation
  mints**. So the refresh chain renewed itself for thirty rolling days. The
  aggravating fact the reviewer established by search: **nothing in this
  tree can disable or delete a dashboard account** — no route, no CLI
  command, no repository function — so the capability grant is the only
  lever an operator has, and it did not work. Fixed at the route layer,
  where guilds are visible (PR-98); the provider exposes only
  `accountForRefreshToken`, a hash-and-read with no other logic, so the two
  layers cannot drift.
- **PR-127 (Critical) — a replayed refresh token spared the token most
  likely leaked.** The replay branch walked `parent_token_id` downward, but
  both rows of the first pair carry `parentTokenId: null`, so the sibling
  access token was never a descendant and survived the leak signal. Exactly
  the hazard PR-118 had already fixed for `revokeByValue`. One line: lineage
  instead of chain.
- **PR-128 (Important)** — `touchToken` on the bearer success path is a
  write, so under `BANANASAURS_READONLY` a **valid** token got 503 and an
  invalid one 401: an oracle, and the guard unusable in precisely the mode
  M4's read tools need. Now best-effort.
- **PR-129 (Important)** — `mcp revoke` killed one row, leaving a leaked
  access token's sibling refresh free to mint a replacement immediately.
- **PR-130 (Minor, from Check E)** — with `MCP_PUBLIC_URL` unset the SPA
  fallback answered **200** for every OAuth path; the 404 test passes only
  because no test adds the static handler. The same shape as M2's Critical:
  an assertion true in every test and false in every daemon.
- Also: **PR-122** confirmed and sized (zero `safeLogFields` call sites in
  `packages/http`, pre-existing, every field M3 logs today allowlisted);
  `purgeExpired` had no caller; the consent page was thin.

### Fix wave and close-out

One dispatch, nine items, nine commits (`3097d88..2e4293c`). The implementer
watched items 1–3 failing first and quoted the failure text. Controller
probes: reverting the lineage call to the chain call fails exactly the named
lineage test; neutralising the route guard fails exactly the named
capability test. The final scoped re-review returned **ALL ADDRESSED**,
having executed the two-rotation replay itself — exchange, refresh, refresh,
replay the original code — and confirmed **all six rows revoked**.

Residual carried forward. **PR-134**: a replay arriving *after* the
capability was revoked hits the route guard first, so the lineage cascade
does not run — not load-bearing, because the refusal already prevents any
mint and PR-92 deliberately does not revoke on grant loss. **PR-131**:
`revokeTokenChain` is kept, because `revokeByValue`'s access-token branch
calls it legitimately. **PR-132**: `mcp revoke` on an already-revoked id is
now idempotent rather than an error.

What M3 teaches that M1 and M2 did not: **a promise in an ADR is not a
guarantee until something fails without it.** D6 said "revoking the account
revokes every token it approved" from the first draft, and it was false in
two directions at once — nothing could revoke an account, and the lever that
did exist did not stop a rotation. Neither gap is visible in a diff; both
required asking what an operator would actually reach for. Ask that of every
promise an ADR makes from here.

## Slice M3b — dashboard account disable, enable, delete

Rulings PR-136..PR-147 (recorded in the run ledger as M3b-R1..R12).
Branch `oc/m3b-account-lifecycle`, merged to `main` 2026-09-15 as `6f47112`.
No new ADR: ADR 0045 **Amendment 3** carries the four decisions, because the
promise being closed is D6's.

**Why the slice exists.** M3's whole-branch review established that nothing
in this tree could disable or delete a dashboard account — no route, no CLI
command, no repository function; `disabled` was read in five places and
written in none outside tests. ADR 0045 D6 ("revoking the account revokes
everything it approved") was therefore a promise with no trigger. The owner
scoped M3b at M3's close: repository functions, three commands, and a test
proving a deleted account's live tokens stop verifying on the next request.

**What shipped.** `setAccountDisabled`, `deleteAccount`, `countEnabledOwners`
and `listAccounts` in `packages/storage/src/repos/accounts.ts`; three
`OpsInstance` members behind an exported `accountOpsFor(instanceScope, now)`
factory; `account list` plus `account disable|enable|delete --confirm`; six
tests in `bearer.test.ts` driving the real OAuth routes. **3,001 tests across
157 files**, gates clean by exit code on the merge commit. No moderation
source touched — the two automod files in the diff gain three-line test stubs
— so the observe window running on both guilds is unaffected.

### Rulings

- **PR-136 (M3b-R1)** — `account list` ships although the owner's spec named
  only disable/enable/delete: without it nothing in the tree can *show* that a
  disable took effect, and an unobservable write is half-shipped.
- **PR-137 (M3b-R2)** — no "last owner" guard on either command. Both are
  recoverable from the same terminal, and a guard on delete would make
  `bootstrap reissue`'s documented recovery path unreachable forever. They
  warn instead. **This ruling was the one the whole-branch review nearly
  falsified — see PR-145.**
- **PR-138 (M3b-R3)** — the account members live in `accountOpsFor` rather
  than inline in `opsInstanceFor`, which needs a `Config` and a live
  discord.js `Client` and has no test anywhere. That split is what made "no
  password hash crosses this boundary" a cheap sentinel test.
- **PR-139 (M3b-R4)** — `packages/http/src/test-support.ts` duplicates the
  mapping, because `packages/http` cannot import `apps/daemon`. Cost recorded
  at the time as "one mapping exists twice"; **paid twice**, once when the
  member was added and again when `accountsRemaining` was.
- **PR-140 (M3b-R5)** — `accountSetDisabled` answers `'no-such-account'` on
  the no-match race, matching `accountDelete`.
- **PR-141 (M3b-R6)** — five hand-rolled `OpsInstance` literals now exist
  across four packages, so adding one port member is a five-file change.
  Consolidating them onto `fakeOpsInstance` ruled out of scope here.
- **PR-142 (M3b-R7)** — the `account-gone` branch is pinned by a raw-SQL row
  delete, because `deleteAccount` can never reach it.
- **PR-143 (M3b-R8)** — the `--guild` finding is fixed in prose, not in the
  dispatcher. `resolveGuild` running for every command is what makes "every
  write is audited against a guild" a property of the machinery; carving out
  four commands is a change to the operator surface's shape and needs its own
  slice.
- **PR-144 (M3b-R9)** — `accountsRemaining` added to
  `OpsAccountDeleteResult`; the warning branches on it.
- **PR-145 (M3b-R10)** — both warnings gated on ownership.
- **PR-146 (M3b-R11)** — the fix wave fixes the *claim*, not the capability;
  a rotation command is an owner decision. Open, in `docs/STATE.md`.
- **PR-147 (M3b-R12)** — the unreachable race branches are kept but commented
  as unreachable-by-construction. **Decorative guard #19.**

### What the whole-branch review found that five task reviews did not

**SHIP-WITH-FIXES: 0 Critical, 4 Important, 4 Minor**, every one reproduced
by running probes against the built code rather than read off the diff. Full
account in `docs/reports/m3b-whole-branch-review.md`. The controller
independently re-confirmed the two load-bearing ones before ruling.

- **The `--guild` claim was false on the real daemon.** `docs/17` said the
  four commands "take no `--guild` flag". `resolveGuild` runs for *every*
  command before `run` (`dispatch.ts:281`) and the deployed allowlist holds
  two guilds, so all four refuse without it. The new sentence also
  contradicted the unchanged rule four lines below it. The seam that hid this
  from five reviews: **no `account` command ran through the real socket** —
  the stub-based command tests and the real-database wiring tests were joined
  only by the `OpsInstance` type. One integration test now closes it, and
  that Minor is the most valuable of the four.
- **`account delete`'s warning named a command that throws.** It advised
  `bootstrap reissue`, which refuses while *any* account row exists, not
  while any enabled owner exists. PR-137's entire recovery argument holds
  only when the deleted account was the last row — so the ruling survived,
  but its justification had a hole the ruling's own author did not see.
- **Both warnings fired for non-owners.** Executed: with the sole owner
  already disabled, disabling a member printed "that was the last enabled
  owner account… re-enable it", naming an account whose re-enabling restores
  no sign-in. Wrong about what happened *and* wrong about the remedy.
- **`disable` is a pause, not a rotation.** Both guards are live re-reads, so
  `enable` hands every stolen credential back intact — this branch's own
  tests assert that, correctly, because it is what proves nothing is cached.
  But `docs/17` presented disable as the D6 compromise lever.
  `sessionRepo.revokeAllForAccount` and `accountRepo.setPasswordHash` both
  exist, are tested, and have **zero production callers**.

### What this slice teaches that M1, M2 and M3 did not

M3 taught that a promise in an ADR is not a guarantee until something fails
without it. M3b teaches the next turn of the same screw: **an ADR's
justification can be wrong even when its decision is right, and only running
the code tells you which.**

A3-2 was written — by the controller, in an ADR, before implementation —
saying the in-transaction token revoke was a redundant belt "because
`verifyAccessToken` would return `account-gone` anyway". An implementer was
told to remove that guard and watch a test go red. The suite stayed **green**,
and it reported that honestly with the reason rather than adjusting the test
until it passed: the revoke lands first, so the request is refused as
`revoked` and the account-lookup branch never executes. Two facts followed
that nothing in a diff would have shown — the `account-gone` branch is
unreachable through `deleteAccount`, and removing it is a **500, not a
bypass**, because `verifyAccessToken` reads `.disabled` off `undefined` and
throws. A3-2 was corrected.

The same discipline paid a third time on the `--confirm` gate: flipping
`write: true` to `write: false` produced **three** distinct failures, not one
— the unconfirmed dispatch reaching the port, the registry write-flag
assertion, and a **missing audit row** — which is how the run learned that
`--confirm` and auditing ride on the same flag, so one typo removes both.

So: **write the ADR first, then try to falsify it.** Three of this slice's
most useful facts came from breaking a guard and reading what happened, and
none of them was visible to a reviewer reading a diff.
