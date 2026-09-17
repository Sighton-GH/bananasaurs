# Evaluating `opencode-delegate` for implementation and review dispatches

Kept as the work happens, starting 2026-09-12 with Slice 7. Compares the
`opencode-delegate:opencode-driven-development` plugin (v0.3.0, opencode
1.18.30) against the sonnet-subagent protocol that built Slices 0–6
(`docs/22_DELEGATION_AND_CONTEXT.md`). Every entry: what happened, what was
expected, what was done instead, whether it cost a re-dispatch.

## Setup findings (before the first dispatch)

- **Free catalog on 2026-09-12:** seven models with `toolcall=yes` —
  `big-pickle`, `ling-3.0-flash-fin-free`, `mimo-v2.5-free`,
  `muse-spark-1.2-contributor-free`, `muse-spark-1.3-contributor-free`
  (1,048,576 ctx, 2026-09-02), `nemotron-3.5-lightning-free`,
  `nemotron-3-ultra-free`. Implementer and task reviewer:
  `opencode/muse-spark-1.3-contributor-free`, as instructed.
- **Whole-branch review is not an opencode job.** The instruction is
  "strongest model available, whichever tool provides it"; that is Opus via
  the Agent tool, not any free opencode model. The plugin's own final-review
  step is therefore replaced for that one dispatch. Recorded so the comparison
  is honest: the plugin is being evaluated for implementation and task-level
  review, not for the last line of defence.
- **Worktree layering.** This session runs in
  `.claude/worktrees/release2-slices-7-12` (the harness requires it). The
  plugin creates its own worktree under `.oc-worktrees/<branch>` relative to
  the repo it is run in, branching from the current HEAD. Expected to work
  since worktrees share one `.git`; verified below at the first dispatch.
- **Ledger placement.** The plugin wants its ledger at
  `.oc-runs/<slug>/progress.md`, which it gitignores. This project's rule is
  that a ruling living only in an unversioned file is a decision made in
  secret, so every ruling is mirrored into
  `docs/reports/release2-slices-7-12-ledger.md` at slice close. Two ledgers is
  a cost of the plugin, small but real.

## Dispatch log

### D1 — Slice 7 plan review (`--role review`, muse-spark-1.3) — 2m30s, no re-dispatch

- **What happened:** the review agent read the plan, the ADR, `App.tsx`,
  `api.ts`, SANDBOX_RULES, and the type definitions of `wouter`,
  `@radix-ui/react-dialog` and `@types/react` in `node_modules`, and returned
  2 Important + 4 Minor findings. The headline finding — `JSX.Element` is not
  a global under `@types/react` 19 — was verified true
  (`node_modules/@types/react/index.d.ts:4141`, no `declare global`). One
  Minor (shared `useId` in `Field`) led, on verification, to a real test
  failure the reviewer had not named (`getByLabelText` would not match a
  label whose text content included the hint). Rulings PR-36..PR-40.
- **Expected:** a sonnet plan review on Slices 3–6 typically returned 1–3
  findings in 3–5 minutes, and rarely opened `node_modules`.
- **Done instead:** nothing; the review was better than the baseline.
- **Cost:** 2m30s wall clock, zero coordinator context beyond the RESULT
  block. No re-dispatch.
- **Worked well:** the read-only `plan` agent went to the type definitions
  unprompted, which is exactly `docs/22`'s "verify against `node_modules`"
  rule.

### D2 — Slice 7 Task 1 implement (muse-spark-1.3) — 14m44s, no re-dispatch

- **What happened:** thirteen files from a 29 KB brief; five checkpoint
  commits, one per plan step; `DONE_WITH_CONCERNS`. The concerns were real
  and correct: three places where the plan's verbatim code could not compile
  or run under this repo's tooling (`.ts` cannot import from `.tsx` under
  `tsconfig.all.json`; `exactOptionalPropertyTypes`; RTL auto-cleanup needs
  vitest `globals`). It fixed each minimally, commented every deviation in
  the code, changed two config files outside its Files list, and *said so*
  rather than hiding it. Every claim verified by the coordinator.
- **Expected:** a sonnet implementer on Slices 3–6 would have done the same
  in 6–10 minutes and more often asked (NEEDS_CONTEXT) before touching a file
  outside its list.
- **Done instead:** nothing; ruled PR-41 and carried the constraints forward.
- **Cost:** ~15 minutes wall clock — roughly double the sonnet baseline for
  a task of this shape — and the run crossed the Bash tool's 600 s ceiling,
  so its summary arrived through a background notification. Zero
  re-dispatch. Coordinator context: the RESULT block (~40 lines).
- **Model quality (muse-spark-1.3):** good. The deviations were the right
  ones and the explanations were precise (it cited TS6142 by number). It
  wrote `Field` with the `cloneElement` pattern from the plan correctly.

### D3 — Slice 7 Task 1 review (muse-spark-1.3) — 1m33s, no re-dispatch

- **What happened:** Spec FAIL on the two out-of-list files, Quality
  APPROVED, three Minors that restated the implementer's own disclosed
  deviations. "Checked outside the diff: nothing."
- **Expected:** the same verdict from sonnet; a sonnet reviewer would more
  often have opened `tsconfig.all.json` to test the implementer's TS6142
  claim rather than listing it under Cannot verify.
- **Done instead:** the coordinator verified the claim itself (it is true).
- **Cost:** 1m33s. No re-dispatch. The FAIL was procedurally correct and
  substantively moot — a reviewer cannot know a ruling the coordinator has
  not yet written down, which is an argument for putting rulings into the
  review brief when they pre-date it.

### D4/D5 — Slice 7 Task 2 implement + review (muse-spark-1.3) — 5m05s + 1m15s, no re-dispatch

- **What happened:** eight files, one commit, `DONE`, 19 tests. Four
  lint-forced edits to the plan's verbatim code (`no-base-to-string`,
  `require-await`), each behaviour-identical and each named in the report.
  Review PASS/APPROVED with no findings.
- **Expected:** parity with sonnet; the sonnet baseline for a task this
  size was 4–8 minutes.
- **Done instead:** nothing.
- **Cost:** 6m20s total, no re-dispatch. Within the sonnet band.
- **Observation:** it committed once rather than per step. The brief's
  verbatim "commit after each numbered step" instruction was followed in
  Task 1 and not here — a mild instruction-following wobble that cost
  nothing this time because the run did not die mid-way.

### D6–D9 — Slice 7 Tasks 3 and 4, implement + review (muse-spark-1.3)

- **Task 3** (five pages + health provider, 7 files): 5m10s, `DONE`, 28
  tests; review 44s PASS/APPROVED, no findings. Deviations were lint-forced
  only (`no-base-to-string`, `no-unnecessary-type-assertion`).
- **Task 4** (routes, shell, state strip, App rewrite, 9 files): 5m17s,
  `DONE`, 41 tests, full suite 2,429, Vite build produced `index.html` plus
  an 11.5 KB CSS asset with the tokens in it (coordinator checked the asset,
  not just the exit code). Eight commits, one per step. Review 40s
  PASS/APPROVED, one Minor deferred to the whole-branch review.
- **What the model caught that the plan got wrong:** two defects in the
  coordinator's own plan — a test asserting `findByText('Bananasaurs dev')`
  that could never pass because the name legitimately renders twice (rail
  and Overview), and `error={error}` on `Field` failing
  `exactOptionalPropertyTypes`. It diagnosed both correctly, fixed them
  minimally, and named them. A sonnet implementer would have done the same;
  a weaker model would have deleted the assertion.
- **Reviewer behaviour:** in Task 4's review it did a focused outside-diff
  check unprompted (stale importers of the moved `LoginForm`), which is the
  exact shape the reviewer brief asks for. In Tasks 2 and 3 it checked
  nothing outside the diff. Inconsistent, not wrong.
- **Cost, four tasks:** implement 14m44 + 5m05 + 5m10 + 5m17 = 30m16s; task
  reviews 1m33 + 1m15 + 0m44 + 0m40 = 4m12s; plan review 2m30s. Zero
  re-dispatches, zero fix rounds. The sonnet baseline for a four-task slice
  of this shape (Slices 3–6) was 25–40 minutes of implementation and one to
  two fix rounds. **Time is at parity; fix-round count is better; dollar cost
  is zero versus a sonnet bill.** The quality difference will be settled by
  the whole-branch review — if Opus finds what four clean task reviews
  missed, that is the number that matters.

### D10 — Slice 7 whole-branch review (Opus via Agent tool, not opencode)

- **What happened:** SHIP-WITH-FIXES with 3 Important, 5 Minor, 4
  decorative tests, 3 missing tests — all on a branch whose four task
  reviews (muse-spark-1.3) had returned PASS/APPROVED with one Minor
  between them. The three Importants (password retained in dialog state
  after cancel; cancel surfaced as a sticky danger toast reading the raw
  server code; state strip silent on health failure) are each a real
  user-visible defect and each is the kind of cross-file reasoning a
  task-scoped diff review structurally cannot do. Opus also ran the suite,
  read Radix's source for the focus-trap claim, and checked
  `tsconfig.all.json` and the boundary test — the "verify, do not assert"
  posture the muse-spark reviewers mostly listed under "Cannot verify".
- **What this says about the plugin:** the task-level reviews were not
  wrong on their own terms — every finding was within a diff. But three
  of the four wrote "Checked outside the diff: nothing", and two of the
  three Importants would have been visible from one focused check the
  reviewer brief invites (trace the cancel path; ask what the strip does
  when health is not ready). **The task reviews are cheap and they are
  shallow; the whole-branch review on a strong model is not optional with
  this plugin, and its cost is unchanged from the sonnet flow.**
- **Cost:** ~11 minutes for Opus. Same as Slices 3–6.

### D11–D14 — Slice 7 fix wave, two scoped re-reviews, round 2 (muse-spark-1.3)

- **Fix wave** (14 files, 10 findings): 10m18s, eight commits, `DONE`, one
  honest judgment call reported (an `instanceof HTMLButtonElement` narrowing
  to satisfy both `tsc` and a lint rule). Two of its guards were watched
  failing by the coordinator. Good work from a detailed brief.
- **Re-review 1** (1m40s → ALL ADDRESSED) and **re-review 2** (23 s → ALL
  ADDRESSED) both **ignored the one deliberate check the brief asked for**
  (branch ordering of `ReadonlyError`/401 cases; the `useMemo` dependency
  array). Both checks turned out fine or were fixed by the coordinator's own
  reading — but the coordinator had to do the reading. The scoped
  re-reviewer is a verdict machine, not an investigator; a sonnet
  re-reviewer on Slices 3–6 answered such questions roughly two times in
  three.
- **Round 2** resumed the fix session by id (1m21s, context intact, correct
  on the first try). Session resumption works and is the plugin's best
  feature for fix loops.
- **Where the residual came from:** the coordinator's fix brief said "any
  other 401 → Password not accepted" — a brief defect, not a model one. The
  model followed the brief literally, as the skill says it will. The lesson
  is the skill's own: the brief is the leverage, and a wrong brief is
  executed faithfully.

### D15 — `oc-task --merge` cannot merge a multi-task plan (plugin bug)

- **What happened:** `oc-task --merge --branch oc/slice-7-shell --verified
  "npm run test"` refused with "diff touches files not listed in the spec's
  # Files section" and listed 30 files — every file from Tasks 1–4. It
  validated against the **last** brief's Files list (the two-file round-2
  fix brief), not the union of every brief on the branch, which is what the
  skill document says it does.
- **Expected:** a merge, or a refusal naming only files no brief ever
  listed.
- **Done instead:** `git merge --no-ff` in the coordinator's worktree, which
  is what Slices 0–6 did anyway. `oc-undo` is therefore also unusable for
  this merge.
- **Cost:** two minutes; no re-dispatch. The guard is a good idea
  implemented on the wrong set.
- **Also:** the harness refused `--verified "npm run typecheck && npm run
  lint && npm run test"` outright (a `&&` inside a quoted argument is
  unverifiable to the approver), so the plugin's documented merge shape
  cannot be typed from a worktree-isolated session at all.

### D16 — the plugin's nested worktree breaks the repo's own lint

- **What happened:** after the merge, `npm run lint` on the coordinator
  branch exited 1 with 307 parse errors — every file under
  `.oc-worktrees/oc/slice-7-shell/`, which typed ESLint cannot place in any
  tsconfig project. The same problem `.claude/worktrees/**` is already
  ignored for.
- **Done instead:** `.oc-worktrees/**` and `.oc-runs/**` added to
  `eslint.config.js` ignores and `.prettierignore` (`770c1b4`). The plugin
  adds both to `.gitignore` on first run but knows nothing about a project's
  linters; a note in its README would save the next project the same twenty
  minutes.

### D17 — Slice 8 plan review (muse-spark-1.3) — 2m41s, no re-dispatch

- **What happened:** Spec FAIL / NEEDS_WORK with 1 Critical, 8 Important,
  6 Minor — and every one of them verified true. The Critical was a
  boundary violation in the coordinator's plan (core importing types from
  `@bananasaurs/storage`, banned by `eslint.config.js:46` and ADR 0014)
  that would have failed the implementer's first lint and cost a
  re-dispatch. The Importants were names the coordinator had asserted from
  memory: the `read`/`write` import path, `DryRunReport`'s field list,
  where `RULE_KINDS` lives, `ConfigValidationResult`'s shape, the CLI
  command names (and that keyword terms have no CLI editor at all), a
  missing `enforce` sentence in the mode dialog, and a missing test for the
  slice's own PR-47 workflow. It listed 30+ files it had opened.
- **Expected:** a sonnet plan review on Slices 3–6 returned 1–3 findings;
  this returned 15, all real, on a plan roughly twice the size.
- **Done instead:** nothing — the plan was corrected before Task 1.
- **Cost:** 2m41s. This single review probably saved two implementer
  re-dispatches and one fix round.
- **Verdict on the pattern:** with this plugin the plan review is the
  highest-value dispatch in the slice, because the implementer executes the
  brief literally and cannot recover from a wrong name the way a sonnet
  subagent sometimes does by reading around it. Do not skip it.

### D18–D29 — Slice 8 Tasks 1–6, implement + review (muse-spark-1.3)

| Task | Implement | Review | Notes |
| --- | --- | --- | --- |
| 1 storage queries | 6m09s, DONE | 55 s, clean | tests-first with the red run committed |
| 2 port surface ×4 | 11m59s, DONE_WITH_CONCERNS | 1m23s, clean | found a fourth `OpsPorts` literal the plan missed (PR-51) |
| 3 automod routes | 6m40s, DONE | 2m17s, 1 minor | 42 route tests incl. cross-guild 404, stale session, enforce refusal, disabled dry-run |
| 4 case routes | 3m59s, DONE | 1m15s, clean | |
| 5 rules list + cutover + re-auth queue | 10m02s, DONE | 1m59s, clean | diagnosed that a full fake clock hangs RTL's `findBy` (PR-52) |
| 6 rule detail | 14m08s, DONE | 53 s, 2 minor | one commit, not per step |

Six implement dispatches, zero re-dispatches, zero fix rounds; ~53 minutes
of implementation for roughly 2,900 added lines including tests. The sonnet
baseline for a slice this size (Slice 6) was two sessions and two fix waves.

**The one lesson worth the whole evaluation:** the muse-spark reviewer does
the investigative check you ask for **only when the brief gives it its own
heading and tells it where to put the answer**. "One deliberate check" as a
paragraph inside `# Method` was skipped twice (Slice 7's re-reviews, Task
5). "Deliberate check — report the answer as its own Finding line, even if
the answer is 'correct'", naming the two files to open, produced a
seven-branch trace of the mode dialog against `setRuleMode` (Task 6) and a
field-by-field mapping audit (Task 2). The model is capable; the template's
RESULT block just gives a check nowhere to land. The plugin's
`task-reviewer-brief.md` should carry such a slot.

### D30–D33 — Slice 8 fix wave, re-review; Slice 9 plan review (muse-spark-1.3)

- **Slice 8 fix wave** (10 files, 9 findings): 10m11s, eight commits,
  `DONE`; one guard watched failing. **Re-review** 1m07s: ALL ADDRESSED
  **and both deliberate checks answered** with the branch order quoted —
  the RESULT block was given lines `A.` and `B.` to fill. That is now the
  template used for every re-review.
- **Slice 9 plan review** 2m29s: 6 Important, 6 Minor, all true — including
  a design question (does a suppression void the enforcement sign-off?)
  that produced ruling PR-59, and an ARIA point (no form control inside
  `Dialog.Description`) the coordinator would have shipped. Three plan
  reviews in, this is the plugin's most reliably valuable dispatch: 2–3
  minutes, 15 findings, near-zero false positives.
- **Slice 8 totals:** seven implement dispatches 57m53s, seven task reviews
  9m19s, one fix wave 10m11s, one re-review 1m07s, plan review 2m41s —
  **~81 minutes of opencode time for ~4,300 added lines** with zero
  re-dispatches. The Opus whole-branch review (~12 minutes) found three
  Important defects the seven task reviews had passed.

### D34–D36 — the free tier ran out (Slice 9 Task 2), and the fallback

- **What happened:** Slice 9 Task 1 (5m09s) and its fix round (51 s)
  completed normally on muse-spark-1.3. Task 2 was cut off after 5m49s
  with exit 5: `FreeUsageLimitError — Error from provider (Console): Rate
  limit exceeded`. Step 1 (the four port literals) was committed; the
  plugin auto-committed the half-written routes and tests as a
  checkpoint (`7bc4441`, "uncommitted changes at end of run"), which is the
  right behaviour. A continuation brief on `muse-spark-1.2-contributor-free`
  hit the same error in 1m16s: **the limit is account-wide across free
  models, not per model.**
- **When:** after roughly 3h45m of near-continuous dispatching — 25
  implement/review/re-review runs across three slices, ~112 minutes of model
  time. That is the budget the free tier gave this evaluation in one
  sitting; whether it resets hourly or daily is not something the error or
  the plugin says.
- **Expected:** the skill says exit 5 means "stop and tell the user; do not
  retry on your own". The task instruction says a blocked task falls back to
  a sonnet subagent and the slice continues. Done the second, after one
  probe on a different free model to learn whether the limit was per model.
- **Done instead:** Slice 9 Task 2 continues on a sonnet subagent
  (`superpowers:subagent-driven-development` shape: brief as a file, report
  back as a file, same worktree and branch), from the checkpoint. Later
  tasks retry opencode first and fall back the same way.
- **Cost:** ~7 minutes lost (the truncated run plus the probe) and one
  continuation brief. The checkpoint meant no work was lost.
- **Plugin note:** `oc-task` cannot tell a per-model limit from an
  account-wide one, and `oc-models --free` does not show remaining quota; a
  coordinator learns the budget by exhausting it. Surfacing the limit type
  in the exit-5 summary, and a quota line in `oc-models`, would save the
  probe.

### D37 — the limit did not lift over ~5 hours; Slice 9 Task 3 on sonnet

- **What happened:** The first Task 2 exit-5 was at ~00:46 local. A probe
  with the Task 3 brief on `muse-spark-1.3-contributor-free` at ~05:59
  returned exit 5 again after 1m18s (`Rate limit exceeded`), no checkpoint,
  no files. So the free-tier window is at least five hours long, and the
  sonnet session limit (which had also run out, "resets 2am") came back
  first.
- **Done instead:** Task 3 (the `/review` page) dispatched to a sonnet
  subagent with the pre-sonnetified brief
  (`.oc-runs/slice-9-review/task-3-sonnet-brief.md`); task review will go
  to sonnet as well unless opencode answers by then. Task 4 the same way.
- **Cost:** one 78-second probe. The two probes so far cost less than one
  wasted implementer run would; the policy "probe opencode once per task,
  then fall back" stays.

### D38 — the limit lifted ~09:55; a non-muse model was killed by the OS; a review skipped its deliberate checks again

- **What happened (limit):** The owner reported the muse-spark rate limit
  resolved. A Task 3 review dispatch on `muse-spark-1.3` at 09:58 ran
  normally (3m31s, exit 0). Between 00:46 and ~06:15 every muse-spark
  dispatch had returned 429; the morning ones were plain `APIError 429
  isRetryable` from the Zen gateway rather than `FreeUsageLimitError`, so
  the plugin's exit-5 line covers two different provider conditions with
  one message.
- **What happened (memory):** While muse-spark was 429ing I tried the same
  review brief on `nemotron-3-ultra-free` (1M context, `toolcall=yes`). It
  ran past the 600 s ceiling into the background and was then **killed by
  the harness because the machine ran low on memory** (the notification:
  "stopped because the system is running low on memory"). No RESULT, no
  log summary. Whether the model, the plugin, or the concurrent sonnet
  subagent was the memory hog is not recoverable from the run log. Lesson:
  do not overlap an opencode run with a Claude subagent on this machine.
- **What happened (checks):** The muse-spark review returned Spec PASS,
  Quality APPROVED, `Findings: - None` — and did not emit a line for any of
  the four deliberate checks the brief asked for "as its own Finding line,
  even if the answer is correct". Second occurrence of this pattern (first:
  Slice 8). The controller verified all four from the diff by hand (~2
  minutes); all correct, so the verdict stands, but a PASS that silently
  drops the requested checks is indistinguishable from a PASS that did
  them. Next brief moves the checks into the RESULT block template itself
  (`Check A: …` lines) rather than asking for Finding lines.
- **Cost:** two wasted dispatches (1m15s + the killed run, ~12 min wall),
  plus the hand verification.

### D39 — Slice 9 close: the fix wave and re-review on muse-spark-1.3

- **What happened:** the whole-branch fix brief (ten items, nine to
  implement, one ruled deferred and listed so the reviewer would see it)
  ran 12m14s, ten commits, RESULT block fully filled — the first Slice 9
  implement run whose report needed no controller repair. The scoped
  re-review took 42 s and answered its three checks with quoted code.
- **Model quality (muse-spark-1.3):** the fix wave's assumptions line was
  the useful kind — it reported that a `/review?rule=` link the brief
  assumed did not exist in the page, and named the seven interpolations it
  did wrap. It also found the existing `setEnforceSignOff` repo function
  for the PR-59 tests rather than inventing a helper outside the Files
  list, which the brief had explicitly allowed it to decline.
- **Slice 9 totals:** 9 opencode runs that completed (Task 1 + fix, Task 2
  partial, Task 3 review, Task 4 + review, fix wave + re-review, plan
  review) ≈ 41 min model time; 4 exit-5 runs ≈ 5 min wasted; 1 killed by
  the OS; 2 sonnet fallbacks (Task 2 tail, Task 3) ≈ 13 min; 1 Opus
  whole-branch review 8m33s. Versus Slices 0–6 on sonnet: the implement
  runs are the same wall-clock range (5–14 min), the reviews are faster
  (45 s – 3.5 min vs 2–5 min), and the coordinator paid two extra costs
  the sonnet flow did not — repairing two half-template RESULT blocks and
  hand-verifying four deliberate checks a review silently dropped.

### D40 — a silent hang mid-task (M1 Task 1 continuation), 32 minutes of nothing

- **What happened:** the Task 1 session, resumed with the PR-71 ruling,
  committed Steps 2 and 3 in three minutes, printed "Adapters committed —
  now extending the fake Discord", read `fake-discord.ts` three times, ran
  one `grep emitMessageCreate` at 11:27:45 — and then emitted nothing for
  32 minutes. `opencode run` stayed alive at 0:29 CPU; no error event, no
  RESULT, no exit. `oc-task` has no idle timeout, so the Bash tool's 600 s
  ceiling moved it to the background and it would have sat there until the
  owner asked.
- **Expected:** either progress or an error event within a few minutes; a
  plugin-side idle watchdog that kills the run and reports "no model
  output for N minutes" with the checkpoint state.
- **Did instead:** killed the three processes by hand (`oc-task` ×2,
  `opencode run`, then the `opencode serve` they left), verified the tree
  was clean at the last commit, and dispatched a continuation brief for
  Steps 4–5 in a fresh session. Armed a 6-minute log-silence watchdog on
  the controller side for that run.
- **Cost:** 32 minutes of wall clock and one continuation brief; no work
  lost, because the step commits are the checkpoints.
- **Plugin note:** the summary-only-at-exit design (D-mechanics) is what
  made this invisible. An idle timeout in `oc-task` (say 10 minutes with no
  event) would turn this into an exit-1 with a log pointer.

### D41 — two consecutive runs produced nothing: `ECONNRESET` from the local `opencode serve`

- **What happened:** the fresh-session re-dispatch of Task 1's Steps 4–5
  (run `20260913T120023`) wrote a 0-byte event log for 13 minutes; the
  controller's own silence watchdog (6 min) caught it. When killed, the log
  held exactly one line: `{"type":"error","error":{"code":"ECONNRESET",
  "path":"http://127.0.0.1:29356/session/<id>/message"}}` — the plugin's
  `opencode run --attach` lost its connection to the `opencode serve` it
  had just started, and neither side reported it. A second attempt under a
  7-minute `timeout` (run `20260913T121210`) was the same: 0 bytes, no
  exit. So this is not the provider: it is the local server/attach pair.
- **Expected:** an exit-1 with the `ECONNRESET` in the `errors:` lines
  within seconds of the reset.
- **Did instead:** killed both, dispatched the same continuation brief to a
  sonnet subagent (the step is one file, the fake). opencode is probed
  again at the next task.
- **Cost:** ~20 minutes wall clock across the two attempts; one
  `sonnetify` of an existing brief.
- **Diagnosis (12:39):** a third zero-byte run (the Task 1 review,
  `20260913T123029`, 9 minutes). `opencode serve` answers HTTP (health
  200, session create 200), and a direct one-line message to
  `muse-spark-1.3` through the same API returned `PONG` — after **36
  seconds** for 12 output tokens. The provider is up but degraded, and the
  first run's `ECONNRESET` landed exactly 12 minutes after its start: the
  model's first step on a 15 KB brief did not finish inside whatever
  timeout the attach connection has, and the reset was reported to nobody.
  Not a plugin bug in the narrow sense; a plugin without a first-token
  timeout and a visible error is what turned a slow provider into three
  silent half-hours.
- **Plugin note:** three silent-failure modes are now on record — D15
  (merge), D40 (idle mid-task), D41 (attach reset at start). All three
  share one cause: `oc-task` reports only at exit, and has no idle or
  connection watchdog of its own.

### D42 — Task 2: the work was done in ten minutes, then the model went idle for eight

- **What happened:** the M1 Task 2 run (schema + migration + config +
  PRIVACY.md) generated the migration, ran the invariants, read its own
  diff back against the spec ("Diff matches the spec and the migration is
  clean"), ran `npm run typecheck` at 12:57:36 — and never emitted another
  event. No lint, no commit, no RESULT. The controller's watchdog fired at
  seven minutes; `tsc` was not running. Same shape as D40: idle after a
  tool result, no error, process alive.
- **Did instead:** `kill <opencode run>`; `oc-task` then did the right
  thing — checkpointed the seven files as one commit ("uncommitted
  changes at end of run"), which is exactly what Task 2 required. The
  controller ran the two gates the model had not reached (lint was
  formatting-only; `lint:fix` committed separately) and dispatched the
  review. **The checkpoint-on-exit behaviour is the plugin's best feature;
  it is what makes a kill safe.**
- **Also:** the controller wrapped this dispatch in `timeout 300` to
  bound a silent start, which would have killed a productive run at five
  minutes; killing the `timeout` process itself (SIGKILL) orphaned
  `oc-task` to init and let it finish. A first-token timeout belongs in
  the plugin, not in a shell wrapper.
- **Cost:** ~8 minutes idle, one manual kill, one formatting commit.

### D43 — M1 Tasks 3–6 on muse-spark-1.3: the good run, and the limit as silence

- **What worked:** once the provider recovered (~13:30), four M1 dispatches
  in a row behaved exactly as the skill describes — Task 3 (repository,
  6m35s, red-first commit, tests that caught a real seed bug), Task 4
  (subscriber, 8m51s, honest note that its veto red-run was vacuous), Task 5
  (two jobs and a timer, 16m08s, three well-argued assumptions), and four
  task reviews in 42 s – 1m57s with every deliberate check quoted from the
  code. Muse Spark's reports in this stretch were the best of the
  evaluation: the Task 5 report explained *why* core tests use hand-rolled
  fakes (an eslint restricted-import rule and a package cycle) with the
  file that establishes the precedent.
- **What did not:** the free-tier limit, when it hits mid-run, presents as
  **silence** — no error event, no exit. Task 6 stopped mid-edit of
  `doctor.ts` at 14:32:52 and sat idle until the controller's watchdog fired
  at eight minutes; the owner confirmed the limit had reset. Third occurrence
  (D40, D42, now this). Each time the plugin's checkpoint-on-exit kept every
  byte, and a continuation brief on a fresh session picked up from the
  commit — so the cost is wall-clock, never work.
- **Controller-side mitigation that became standard:** dispatch in the
  background, arm a log-silence watchdog (no output for 4 min at start, or 8
  min mid-run), and on firing: `kill <opencode run>` → checkpoint → read the
  last events → continuation brief. Two lines of bash the plugin should own.
- **Cost this stretch:** one 8-minute idle, one continuation brief.

### D44 — `oc-task` validates a review brief's headings, and its error names only the first

- **What happened:** the M1 whole-branch brief was written in the shape the
  earlier Opus whole-branch briefs used (a title, "Read first", "What to
  look for", "Required output"). `oc-task --role review` refused it twice,
  one heading per attempt: first `missing section: # Diff under review`,
  then `missing section: # Objective`. Each refusal costs a round trip
  because the validator stops at the first missing heading instead of
  listing all of them.
- **Expected:** one refusal naming every missing section, or a `--dry-run`
  that validates without dispatching (the flag exists; it was not obvious
  it also validates headings — worth documenting in `--help`).
- **Cost:** two wasted dispatches, about a minute. Minor, but it is the
  second time a brief-shape rule was learned by rejection rather than from
  the templates (the first: the implementer template's Files list).

### D45 — a second worktree, the same missing `node_modules`, and a model that reported it correctly

- **What happened:** `oc-task` created `.oc-worktrees/oc/m2-search` on the
  first dispatch against that branch (the research run) with **no
  `node_modules`** — the same gap recorded at the very first run for
  `oc/slice-7-shell`, four slices ago. Vitest still passed, because Node's
  resolution walks up into the parent worktree's `node_modules`; `tsc` and
  `eslint` did not, so the implementer's `npm run typecheck` and
  `npm run lint` came back red on `packages/dashboard/vite.config.ts`.
- **The model got this exactly right.** Rather than editing a file outside
  its Files list or reporting DONE over red gates, it reported
  `DONE_WITH_CONCERNS`, named the failure as pre-existing and out of scope,
  and proved its own four files were clean by running `prettier --check`
  and `eslint` on them directly. That is the behaviour the brief asks for
  and the first time an implementer has drawn the line that precisely.
- **Cost:** ~5 minutes (one `npm ci` the controller should have run when
  the branch was created) and one concern to adjudicate. Both gates are 0
  afterwards.
- **Plugin note:** `oc-task` knows when it has just created a worktree —
  that is the moment to run the project's install command, or at minimum
  to print "new worktree: dependencies not installed". Four slices in, this
  is the only mechanical gap that has recurred every single time.

### D46 — the limit presents as a *stalled* run, and two sessions share one account

- **What happened:** M2 Task 2 was dispatched three times across an hour.
  The first (`20260913T155241`) read six files, then went silent for nine
  minutes and exited 1 with no checkpoint. The second
  (`20260913T160207`) wrote **zero bytes for 55 minutes** — and then, the
  moment the owner cleared the limit, resumed *in the same process* and
  carried on working from where it had queued. So a rate-limited run is not
  refused and is not killed: it blocks, invisibly, for as long as the limit
  lasts.
- **Two causes of contention, one of them mine:** a `kill` of an earlier
  run's `timeout` wrapper had left an **orphaned `opencode` process alive
  for 54 minutes** still holding a slot; and a *second Claude session on the
  same machine* was dispatching `oc-task` against the same free-tier account
  (`.oc-runs/governance-suite/`). Neither is visible from inside a run —
  the controller found both only by reading `ps`.
- **Expected:** a rate-limited attach should surface as exit 5 within
  seconds, as it does when the limit is hit at request time. Blocking
  silently is the worst of the three failure modes recorded so far, because
  it is indistinguishable from a model thinking hard.
- **Did instead:** killed the orphan, left the second run to recover, and
  reported to the owner rather than burning further dispatches. The run
  completed its work afterwards.
- **Cost:** ~70 minutes of wall clock on one small task; no work lost.
- **Controller rule added:** after killing any `oc-task`, check `ps` for a
  surviving `opencode` child — killing the wrapper does not kill the model.

### Plugin mechanics found at the first two runs

- **No dependency install in the plugin's worktree.** `oc-task` created
  `.oc-worktrees/oc/slice-7-shell` from the current HEAD with no
  `node_modules`. The review run survived because it only read files; an
  implementer would have failed its first `vitest`. Ran `npm ci` there by
  hand (5 s from the npm cache; 292 top-level entries). A per-plan cost the
  sonnet flow never paid, and one the plugin should do itself or at least
  say it does not.
- **The branch base is pinned at the first run.** The plan review created
  the branch at `6941fa6`; the plan fixes it prompted landed at `f228198` on
  the coordinator branch. Fast-forwarded `oc/slice-7-shell` by hand before
  the first implement dispatch. Harmless here, but a coordinator who did not
  notice would dispatch implementers against a stale base.
- **`oc-task` prints its summary only at exit**, so a run past the Bash
  tool's 600 s ceiling goes to the background with nothing visible until it
  finishes. Task 1 (13 files, ~30 KB brief) crossed that line.
- **Compound shell commands are refused by this harness** when the session
  is worktree-isolated (a heredoc followed by `&&` was refused twice while
  preparing briefs). Not a plugin fault — SANDBOX_RULES already says so — but
  it means brief generation needs a script file, not a one-liner. Wrote
  `.oc-runs/mkbrief.py` for that.

### D47 — a rate limit that fails fast, and the `# Files` rejection again

M3's read-only research dispatch, run `20260913T203945-oc_m3-oauth`,
`opencode/muse-spark-1.3-contributor-free`.

**Two separate things happened, and only one of them is the provider's.**

First, `oc-task` rejected the brief before dispatching:
`brief rejected (role implement): missing section: # Files`. This is D44's
behaviour on the implement role — validation names only the **first** missing
section, so a brief with two gaps costs two round trips. Here it cost one.
The research brief genuinely had no `# Files` section because the task writes
one findings file and no source; the fix was a four-line section naming that
file. Worth noting that a read-only research task is a shape the implement
role's validation does not anticipate, and the `review` role cannot be used
instead because it may not write the findings file at all.

**What I expected:** a dispatch.
**What happened:** `exit: 5 (rate limited by the provider)` after **1m12s**,
with `APIError: Error from provider (Console): Rate limit exceeded. Please
try again later.` and no `## RESULT` block.
**What I did instead:** did not retry — the skill and the owner's standing
instruction both say a 429 is the owner's to clear — and gathered M3's facts
by hand in the controller session while waiting.

**This is the good failure mode, and it contradicts D46.** D46 recorded that
a rate-limited run *blocks in-process and resumes when the limit clears*,
presenting as silence for up to fifty-four minutes. This one failed in 72
seconds with the real provider message and the correct exit code. Both
behaviours are now observed on the same model and the same account, so the
limit does not have one presentation: it can block or it can refuse, and a
silent run cannot be assumed to be either. The practical rule stands —
watchdog the log, and tell the owner at five minutes of no output — but a
fast exit 5 is no longer surprising and should not be treated as a setup
failure.

**Cost:** 1m12s of wall clock, no tokens of controller context beyond the
summary, and no lost work. Against Slices 0-6 with sonnet, where a dispatch
never failed for provider reasons at all, this is the recurring tax of the
free tier rather than a plugin defect.

**What the wait bought.** Reading the four files the research dispatch would
have read produced four corrections to ADR 0045 (PR-90..PR-93), one of them
a cross-guild authorization hole that neither the design nor my own ADR draft
had seen. Recorded here because it argues something about the method rather
than the tool: the controller reading the tree directly is not a fallback of
equal value to a research dispatch — for an authorization boundary it may be
the better first move, because the findings land in the controller's context
already adjudicated rather than as a file to be trusted.

### D48 — the 10-minute foreground cap kills a big task mid-gates, and a review stalls the D46 way

M3 Task 3 (the OAuth provider, the slice's biggest task) and its review, both
on `opencode/muse-spark-1.3-contributor-free`.

**Task 3, run `20260913T220137`.** Dispatched in the foreground with the Bash
tool's maximum 600 s timeout. The model wrote 1,201 lines across four files,
committed twice (`70867d4` item 1 at 22:02, `adde4e7` the provider at 22:05),
and was still running when the wrapper was killed at 22:11 — the log shows it
mid-gates. **What was lost:** only the mechanical tail — `lint:fix` (Prettier
on two files), the two break-probes the brief asked for, and the `## RESULT`
report. **What was not lost:** any code. `oc-task`'s commit-per-task discipline
meant the kill cost nothing that mattered. No orphaned `opencode` process
this time (checked `ps`; the ones present belonged to a different session).

**What I did instead:** ran `lint:fix` and committed it as a separately-labelled
formatting commit; ran both break-probes myself (PKCE check neutralised →
exactly the one expected failure; replay cascade removed → exactly the two
expected failures); ran the gates. Then told the reviewer it was the first
reader of the diff because no self-report existed. Net cost: about six
minutes of controller time and no re-dispatch.

**The review, run `20260913T221539`, was worse.** 418 KB of events in the
first 90 seconds — 17 tool calls, eight steps — then the log stopped at
22:17:10 after a `step_finish` with reason `tool-calls`, and nothing followed
for eight minutes until the cap killed it. That is D46's shape exactly: the
provider stopped answering and the run blocked rather than failing. A second
Claude session on this machine was dispatching against the same free account
at the time (visible in `ps`), which D46 also recorded as a cause.

**What this argues.** The foreground 600 s timeout is the wrong tool for a
task this size: it does not distinguish "still working" from "stalled", and
it kills both. From here (ruling PR-114) long dispatches run in the background
with a log-silence watchdog, so a working run is left alone and a stalled one
is reported to the owner at five minutes of silence, per the standing
instruction. Against Slices 0–6 with sonnet — where no dispatch was ever
killed by the harness or stalled by the provider — this is the second
recurring tax of the free tier, after D47's fast 429.

### D49 — the plugin grew an exit code for the exact failure D46 and D48 described

Mid-M3 the owner updated the plugin. `oc-task --help` now lists a seventh
exit code:

```
  6  stalled — no output for the idle timeout; the session is dead
```

That is precisely the failure this evaluation had recorded twice and could
not distinguish from useful work: **D46** (a run that blocked in-process for
fifty-four minutes) and **D48** (a review that wrote 418 KB in ninety seconds
and then went silent until a wall-clock timeout killed it). Both were
diagnosed by hand — reading `.oc-runs/*.log` mtimes, checking `ps` for an
orphaned `opencode` child. The tool now reports it.

**What this changes for the controller.** Ruling PR-114 stands but gets
cheaper: long dispatches still run in the background, but the log-silence
watchdog becomes a backstop rather than the primary detector, because a
stalled run now exits on its own with a distinguishable code. The
five-minute report-to-owner rule is unchanged — it is about the owner
cycling a rate limit, not about detection.

Worth recording as a property of the whole exercise rather than of one run:
this evaluation file is not only a record, it is the input that produced the
fix. D46 and D48 described a failure mode precisely enough to be
implemented against.

### D50 — the whole-branch review's first attempt died on a Claude session limit

M3's whole-branch review is dispatched to Opus via the Agent tool, per the
owner's standing instruction that the strongest available model reviews the
finished branch. The first attempt terminated immediately:

> Agent terminated early due to an API error: You've hit your session limit
> · resets 7pm (America/Vancouver) (rate_limit, HTTP 429, model
> claude-opus-5)

**Cost:** nothing but wall-clock — the agent produced no output, so there was
no partial work to reconcile and no context spent. The owner cycled the
limit and it was re-dispatched unchanged.

This is the third distinct rate-limit presentation in the record and the
first on the *Claude* side rather than opencode's: D47's fast provider 429,
D46/D48's silent block, and now a hard session cap that fails the agent
before its first tool call. The pattern across all three: **the controller
must never treat "no output" as "no work to do"** — each one needed the
owner, and each one was cheap only because the work was committed and
ledgered before the dispatch went out.

### D51 — M3b: five tasks, two NEEDS_CONTEXT stops, and both were right

Slice M3b (dashboard account disable/enable/delete) ran five tasks on
muse-spark-1.3, implementer and task reviewer both. Four task reviews
returned Spec PASS / Quality APPROVED with **no findings at all**, which has
not happened before on this project — the earlier slices averaged three
Important findings per whole-branch review that the task reviews had passed.
Two things plausibly explain it, and they are worth separating: the slice is
small and mostly additive, and the briefs carried the exact code and the
exact test list. Only the next slice will say which.

**Both NEEDS_CONTEXT stops were correct refusals to widen scope.** Task 2's
brief listed four files; adding a member to `OpsInstance` broke three more
`OpsInstance` literals elsewhere in the tree. The implementer reported the
typecheck failure, quoted it, and asked, rather than editing files its brief
did not name. It did the same thing again one round later when two further
literals surfaced. That is the behaviour the `# Files` section exists to
produce, and it cost two cheap round trips instead of a review finding.

**The finding of the slice came from an implementer refusing to write a
test that would assert nothing.** Task 4's brief instructed it to remove the
`account-gone` guard in `verifyAccessToken` and watch a test go red. The
suite stayed green. It reported that honestly, with the reason —
`deleteAccount` revokes the token in the same transaction, so the request is
refused as `revoked` before the account lookup runs — and said what staging
the branch would require rather than adjusting the test until it passed for
the wrong reason. **That falsified a sentence in the controller's own ADR**
(0045 Amendment 3, A3-2, which claimed the in-transaction revoke was a
redundant belt over a guard that "would refuse them anyway"). The amendment
was corrected. A free model found an error in an Opus-written decision
record by doing exactly what the brief asked and reporting what happened.

**Watching a guard fail paid twice more.** Flipping `accountDeleteCommand`
from `write: true` to `write: false` produced three distinct failures, not
one — the unconfirmed dispatch reaching the port, the registry write-flag
assertion, and a **missing audit row** — which is how the run learned that
`--confirm` and auditing ride on the same flag, so one typo removes both.
And removing the `account-gone` branch turns out to be a **500, not a
bypass**: `verifyAccessToken` reads `.disabled` off `undefined` and throws.
Neither fact is visible in a diff.

### D52 — the worktree does not inherit nested workspace installs

`oc-task` links the base checkout's **root** `node_modules` into a fresh
worktree. This repo also has a nested install at
`packages/dashboard/node_modules`, which the worktree does not get, so
full-repo `npm run typecheck` fails there on
`Cannot find module '@vitejs/plugin-react'` — an error with nothing to do
with the work, which the first implementer correctly diagnosed as
pre-existing and refused to chase.

**Fix, now in every brief's Verification section:**

```
test -e packages/dashboard/node_modules || ln -s <repo>/packages/dashboard/node_modules packages/dashboard/node_modules
```

Note that a `--role review` run discarded the symlink as an unexpected file
change ("reviewer modified 1 file(s); changes discarded"), so it has to be
re-created rather than assumed present. Worth fixing in the tool: linking
every `*/node_modules` the base checkout has, not only the root one.

**And the symlink is a hazard, not just a workaround — it damaged the base
checkout.** An implementer ran `npm install` inside the worktree (reasonably,
while diagnosing the missing module), npm followed the symlink, and wrote
through it into the **main checkout's** `packages/dashboard/node_modules`.
The damage surfaced only after the merge, when `npm run typecheck` on `main`
failed on the same missing module the worktree had originally failed on, and
`@vitejs/plugin-react/` on `main` turned out to be an empty directory while
the worktree's copy was intact. One `npm install` at the repo root repaired
it; the merged code was never affected, and all three gates then passed on
`main`.

The lesson is about the shape of the fix, not the incident: **a symlink from
a worktree into the base checkout makes the base checkout writable by every
dispatch**, and the whole point of a worktree is that it is not. A copy
(`cp -r`) would have cost a few megabytes and contained the blast radius, and
the real fix belongs in `oc-task`: link or copy every nested `node_modules`
at worktree creation, the same way it already handles the root one. Until
then, copy rather than link.

### D54 — a killed run loses the record that authorizes its files

`oc-task --merge` audits the branch diff against the union of every `# Files`
section from **the runs it has records for** (`.oc-runs/*.json`, filtered by
branch). Fix round 2 of Task 2 was killed by the host memory watchdog *after*
both its commits landed but before its run record was written — so its brief
never entered the union, and the merge was refused for two files that brief
explicitly authorizes:

```
oc-task: merge refused — diff touches files not listed in the spec's # Files section:
  apps/daemon/src/automod.integration.test.ts
  packages/storage/src/repos/automod-rule-lists.test.ts
```

**The audit was right to refuse** — it reported exactly what it could see —
and the brief was sitting on disk at
`.oc-runs/m3b-account-lifecycle/task-2-fix-2-brief.md` the whole time. The
controller performed the audit by hand instead (read the brief's Files
section, read both diffs — three-line test stubs), merged with plain `git
merge --no-ff`, and said so in the merge commit rather than reaching for a
flag to silence the check.

Worth fixing in the tool: fall back to scanning `.oc-runs/<plan-slug>/*.md`
for `# Files` sections when a brief has no run record, or write the run
record at dispatch rather than at completion so a killed run still leaves
one. The second is better — a record written at dispatch is also what tells
you a run existed at all.

### D53 — the host's memory watchdog kills background runs

Two background jobs were killed mid-run with "the system is running low on
memory", one of them an `oc-task` fix round during its verification step —
**after both its commits had landed**, so the work survived and only the
RESULT block was lost. `free` showed 14 GB available immediately afterwards,
so the watchdog is reacting to a spike, not a shortage: a full `npm run test`
(157 files, vitest workers) concurrent with an `opencode` session is enough.

**What the controller does now:** never run the full suite while a dispatch
is in flight, and run the gates in the foreground, one at a time. And the
recovery is the ledger plus `git log`, not recollection — the killed run's
two commits were found there and verified by re-running the gates, which is
the second time this session that committing per step has turned a lost
session into a non-event.

### D55 — the worktree was never isolated: cross-package types resolved to `main`

The most consequential tooling finding so far, and it had been true for every
slice built with this plugin.

`oc-task` symlinks the base checkout's `node_modules` into the worktree. npm
workspaces link each workspace package **relatively** —
`node_modules/@bananasaurs/storage -> ../../packages/storage` — and a relative
link resolves against the link's *real* path, not the path you reached it
through. So from inside the worktree, `@bananasaurs/storage` resolved to
**`/home/bryan/projects/bananasaurs/packages/storage`**: the main checkout's
copy, not the branch's.

The consequence: for anything crossing a package boundary, worktree
typechecks were reading **main's built `dist`**, not the branch's source. It
surfaced on M3c as a typecheck error insisting a function the branch had just
added did not exist — with the base checkout's absolute path right there in
the message, which is what gave it away:

```
apps/daemon/src/ops/wiring.ts(938,37): error TS2551: Property
'revokeAllTokensForAccount' does not exist on type 'typeof
import("/home/bryan/projects/bananasaurs/packages/storage/dist/repos/oauth")'
```

**Why it never bit before.** The controller re-runs the gates on `main` after
every merge, which rebuilds main's `dist` with the merged code. So each
slice's worktree saw the *previous* slice's types — correct, because the
previous slice was merged — and the current slice's own cross-package changes
were the only blind spot. M3b added an `OpsInstance` member and passed in the
worktree only because the post-merge gate run on main had already rebuilt
main's dist from an earlier branch. **The post-merge verification on `main`
is what has actually been protecting this project, not the worktree gates.**
That was luck dressed as process, and it is worth saying plainly.

**The fix is a real install per worktree**, not a cleverer link:

```
unlink node_modules && npm install
```

which also gives the worktree its own `packages/dashboard/node_modules` and
so retires D52's copy hack entirely — and removes D52's write-through hazard
at the same time, because nothing in the worktree points at the base checkout
any more. `oc-task --no-link-node-modules` exists for this; it should
probably be the default, with the link as the opt-in for people who want the
speed and have no workspace packages.

**What to carry forward.** A worktree that shares `node_modules` with its
parent is not isolated, whatever the directory listing suggests. And the
diagnostic that solved it was reading the *path* in the error rather than the
message — the type was not missing, it was being looked up somewhere else.

### D56 — M4: eight tasks, nine escalations, and every one was right

Slice M4 ran eight tasks (two of them split into halves) on muse-spark-1.3.
**Nine dispatches stopped to ask rather than guess, and the controller
ruled the implementer right every time.** The list is worth having in one
place because it is the strongest evidence yet that the `# Files` boundary
and the "stop and report" instruction produce findings, not friction:

- Task 1: the brief said to expect a 256-package closure and stop if
  different; it measured 254, verified the SDK was unmoved, and flagged. The
  brief was wrong (hoisted `ajv` 6 counted where nested `ajv` 8 loads).
- Task 1 fix: told to remove a guard and watch a test go red, it reported
  the suite **stayed green** — the probe could not fire for `ajv`. Then the
  fixed probe proved `ajv` *does* load, falsifying the ADR's headline. It
  left the suite red and asked rather than dropping `ajv` to make it pass.
- Task 2: same shape — removing the empty-set branch changed nothing
  because membership subsumed it. Reported `Tests 10 passed (10)` instead of
  manufacturing a red. Ruling M4-D6.
- Task 3: flagged that `@bananasaurs/mcp` resolved to its git-ignored
  `dist/` — a fresh clone would fail the gates — and declined to edit the
  four config files outside its list. A merge blocker, caught before merge.
- Task 4b: widened `archive.test.ts` to keep the gates green when a port
  became required, and disclosed it.
- Task 5: flagged that the guild tools **refuse in production** because the
  daemon held no client, and stopped at the boundary of `http/wiring.ts`.
- Task 7b: judged `archive.ts` did not need the same echo-bounding fix as
  `records.ts` because the snowflake is validated before echo — and the
  reviewer confirmed it.

**The lesson is about the brief, not the model.** Every one of these was a
place where the controller's brief was wrong or incomplete, and the model
found it by doing exactly what the brief said and reporting the result
honestly. A brief that says "stop and report" and a `# Files` list that is
enforced at merge are what turn "the model noticed something" into "the
controller learned something".

### D57 — the host memory watchdog is spike-triggered and hits `tsc --build`

Task 7 was killed **four times** with 12–14 GB free. Every kill landed at
the same point: `npm run typecheck` (`tsc --build --force` across the
monorepo) running inside the opencode process tree during the verification
step — or, on read-heavy briefs, during the initial file reads. The harness
message says "low on memory"; the numbers say it is reacting to the growth
rate of the background job's subtree, not to headroom, and it applies only
to jobs run with `run_in_background`.

What worked: **run the dispatch in the foreground.** The 600 s foreground
limit is shorter than most implement runs, so the harness backgrounds the
job at that point — but by then the read-heavy phase is over, and on 7b the
backgrounded remainder was not killed. On 7a it was killed at typecheck
after every real commit had landed, and the controller finished the tail
(one formatting commit, the guard probes, the gates) the same way it had
for M3c's rate-limited run.

What also worked: **splitting**. Task 7's combined brief named fifteen files
and the model read them all up front; 7a and 7b each named a third as many.
Worth generalising: a `# Files` list over about ten entries is a signal to
split before dispatching, not after the first kill.

Every kill lost nothing, because every step commits. That is now the fifth
time this session that "commit per step" has turned a dead session into a
non-event.

## D58 — the gates were green in the worktree and red on `main`

Slice M4 merged with typecheck, lint and test all passing in the worktree,
and typecheck failed the moment it landed on `main`:
`Cannot find module '@bananasaurs/mcp'`. The cause was not the merge. M4 adds
a new workspace package, and `main`'s `node_modules/@bananasaurs/` had been
installed before that package existed, so its symlink was never created.
`npm install` fixed it in one command.

Two things worth keeping:

- **The test gate could not catch this.** `vitest.config.ts` carries a source
  alias for `@bananasaurs/mcp` — added deliberately in Task 3, so the suite
  reads the package's source rather than a git-ignored `dist` — which meant
  169 files and 3,174 tests passed while `tsc` could not resolve the package
  at all. A green suite is not evidence that a package resolves. The three
  gates are not redundant with each other, and this is the sharpest example
  of it the project has produced.
- It is the inverse of the Task 3 defect, where `@bananasaurs/mcp` resolved
  *to* a git-ignored `dist` that a fresh clone would not have, and a cousin
  of D55, where worktree package links resolved into `main`'s packages. All
  three have one root: **a workspace link is state on disk, not a fact in the
  repository**, and nothing in the gates asserts that the state matches the
  repository. The standing rule that follows: after merging a branch that
  adds a package, run `npm install` before believing any gate.

Generalising past npm: the delegation tooling gives each run an isolated
worktree, which is what makes parallel work safe — and the same isolation is
what lets an environment difference hide until merge. Verification in the
worktree is necessary and is not sufficient. The controller re-runs the gates
on the integration branch after merging, which is how this was caught within
a minute of landing rather than by the next slice.

## D59 — four controller errors in one slice, all caught by "stop and report"

Slice M5 is the strongest evidence yet for the one instruction that costs
nothing: *if anything is ambiguous, contradictory or missing, stop and report
rather than guess.* Four of the eleven rulings the controller wrote for M5
were wrong, and the implementer found every one of them:

1. **The layer order** put the rate cap ahead of the idempotency read, so a
   client retrying a send that had already succeeded would be told
   `rate-cap` once the hour filled — told its message failed while the
   message sat in the channel.
2. **A ruling that was unimplementable**: refuse a DM channel id before the
   allowlist. A Discord snowflake carries no channel type, so no id shape
   distinguishes a DM. The implementer reported it instead of writing a test
   that faked compliance, which is what it would have taken to tick the box.
3. **A ruling that failed the database and the compiler**: `via='mcp'` on the
   audit row, against a CHECK admitting only `ssh`/`http`/`gateway` and a
   type of `'ssh' | 'http'`.
4. **A break-it that could not fail.** The controller specified neutralising
   "the claim precedes the REST call" and running the replay test — which
   stays green either way, because sequentially the claim precedes the second
   call regardless. The implementer noticed, wrote a concurrent probe, and
   *that* failed with two REST calls for one key.

The fourth is the most interesting, because it is the failure mode the whole
"break every guard" discipline exists to prevent, committed by the person
enforcing the discipline. Twenty-odd decorative guards have now been found on
this project; this is the first one authored by the controller in the same
breath as demanding the practice.

What generalises: the value is not in the model catching the controller out.
It is that **an instruction to stop is cheaper than a review round**. Each of
these cost one round trip and a ruling; finding them in the whole-branch
review would have cost a fix wave, and finding the first one in production
would have cost the owner a message posted twice to a 210-member server.

The counterpart finding is that escalations must be *answerable*. All four
came back with concrete options and a recommendation, not "what should I
do?" — which is what made each one a five-minute ruling rather than an
investigation.

## D60 — the review found what the plan assumed away; the branch hold made it cheap

Slice 11 is the slice that ends an observe window. Its plan said the
dashboard "stays read-only" for the cutover, and the brief, the STATE
paragraph and the whole design of the attestation rested on there being one
path to `enforce`. There were two. Slice 8 had already wired the dashboard's
mode dialog to `setRuleMode` with `'enforce'` in its schema — on `main`,
merged, and described in `docs/STATE.md` as "their first production
callers" in a paragraph the controller had not re-read. The database gate
held on that path; the attestation did not exist on it at all.

Two things made this cheap rather than a flip-day incident:

- **The owner chose to build on a held branch.** Asked whether to build
  Slice 11 before the floor, the owner picked "build now, don't merge until
  the floor". So the review, the fix wave and the re-review all happened on
  code that could not reach the live daemon, with ten days in hand. Had the
  same question been answered "build and merge", the second path would have
  been found the same way — but with the first path already live.
- **The reviewer was told to assume a third path before concluding
  none.** It grepped every caller of `setRuleMode` and the two ports, and
  drove the dashboard route through the real Fastify app against a rule
  that would pass the gate. The fix's own break-it then produced the
  decisive failure: with the route's refusal removed, that request returned
  `200`. The route's refusal is the only thing there, and now a test says
  so.

The controller's error count for the day: S10-D1's rationale (a guard that
could not fail), S11-D3 (attesting to disabling a rule that does not exist,
and letting `--no-legacy` contradict a recorded ref), S11-D6 (a state that
never existed), and M6-D1's "at startup". Every one was caught by an
implementer or reviewer that was told to stop, or to assume the worst,
rather than proceed. The pattern from D59 holds at the third slice.

## What worked well

(appended as observed)

## Cost and time versus Slices 0–6

Slices 0–6 with sonnet subagents: a typical implementation dispatch of two to
three tasks returned in 4–12 minutes; a task review in 2–5 minutes; the
coordinator's context cost per dispatch was the five-line report plus the
brief path.

(opencode numbers appended per dispatch)
