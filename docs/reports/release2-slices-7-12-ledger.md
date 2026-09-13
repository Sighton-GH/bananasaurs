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
