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

## What worked well

(appended as observed)

## Cost and time versus Slices 0–6

Slices 0–6 with sonnet subagents: a typical implementation dispatch of two to
three tasks returned in 4–12 minutes; a task review in 2–5 minutes; the
coordinator's context cost per dispatch was the five-line report plus the
brief path.

(opencode numbers appended per dispatch)
