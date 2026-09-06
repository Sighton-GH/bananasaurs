# Brief — Dispatch C: Tasks 3 and 4 — `regex` (and the ReDoS gate), `caps`, `emoji`

Work in `/home/bryan/projects/bananasaurs/.claude/worktrees/release2-slices-3-6`.
This is a git worktree. **Do not `cd` to `/home/bryan/projects/bananasaurs`.**

## Your task

Implement **Task 3 and Task 4** from
`docs/superpowers/plans/2026-09-02-slices-3-5-stateless-predicates.md`, in that
order, one commit each.

Read, in this order:

1. `CLAUDE.md` — the hard rules. They override the plan and this brief.
2. The plan's **Global Constraints**, **Verified environment facts** and
   **Plan rulings** — PR-10 through PR-13, PR-17 and PR-18 are yours.
3. The plan's **Task 3** and **Task 4**, in full — including **Task 4's Step 0**,
   which defines the test helpers both of its test files need.

Do **not** implement any other task. Tasks 1, 2, 5, 6, 7 and 8 are already done
(`d48a1c4`, `cd34d0e`, `84f4d9e`, `30fee50`, `2f4ca8e`, `dc9933f`). Task 9 is a
later dispatch.

Baseline: **2203 tests / 105 files**, typecheck and lint clean. If the count
drops you deleted a test and must say so.

## What is already in place

`AutomodRule` has four list fields — `terms`, `allowlist`, `inviteAllowlist`
(`{ code, label }[]`) and `linkDomains` (`{ domain, listType }[]`). **Every
`AutomodRule` literal you write must include all four.** The plan's code blocks
already do. If any field does not exist, stop and say so rather than deleting
fields to make it compile.

`predicates/registry.ts` currently registers **four** of the ten kinds:
`keyword_filter`, `attachment_type`, `invite`, `link_domain`. You add three
(`regex`, `caps`, `emoji`), bringing it to **seven**. The three that remain
absent afterwards are the window tier — `mention_spam`, `rapid_spam`,
`duplicate_message` — which is Slice 4 and not yours. Confirm that count in your
report by reading `PREDICATES`, not by trusting this paragraph.

## The obligation Task 3 carries — this is the most important thing you will do

Task 3 is **obligation 1** of `docs/reports/release2-slices-3-5-handoff.md`, and
the handoff's wording is worth quoting because it sets the stakes:

> Do not ship `regex` without it — a pattern an operator can type that hangs the
> subscriber takes moderation down for the whole guild, and they have no way to
> know they did it.

The spec (§4) names the gate: a catastrophic-backtracking pattern, asserting the
timeout or the linear-time engine holds.

**These facts were measured in this worktree. Do not re-derive them, and do not
contradict them without re-measuring:**

- `^(a+)+$` against `'a'.repeat(26) + 'b'` takes **3052 ms**. It is genuinely
  catastrophic here.
- `vm.Script.runInContext(ctx, { timeout })` **does** interrupt that
  backtracking — it threw at 204 ms on a 200 ms budget against a 60-character
  input that would otherwise never finish.
- The timeout still fires when the `Script` **and** the context are created once
  and reused, which is what makes it affordable.
- A context that has already timed out **stays usable** for later evaluations.
- Cost: **120 µs/call** via the wrapper versus 0.05 µs direct, over 20 000
  iterations.

**`node:vm` here is an interruptible execution wrapper, not a security
sandbox.** The script inside is the fixed string `pattern.exec(input)`; the
operator's pattern arrives as a `RegExp` built by `new RegExp` in the ordinary
realm, and `new RegExp` cannot execute arbitrary code. No operator-supplied
*code* is ever evaluated. Say this in the file — a reader who sees `node:vm`
will otherwise reasonably assume a sandbox and try to "fix" it.

### How to prove the gate is real

The plan's Task 3 Step 5 tells you: replace the timed `script.runInContext(...)`
with a direct `pattern.exec(messageInput.content)`, re-run the ReDoS test, and
confirm it **hangs** — which you will observe as vitest's 20-second per-test
timeout firing, not as an assertion failure. Then restore.

**Do this, and report exactly what you observed.** A ReDoS test that passes
against an unprotected implementation is the most expensive decorative guard
this project could ship: it would certify a hole while looking like coverage.

## Why `g` and `y` are refused (PR-13) — do not "simplify" this away

Measured on this Node, on a **reused** `/a/g`: `test('banana')` → true
(`lastIndex` 2), again → true (`lastIndex` 4), then `test('xyz')` → false
(`lastIndex` back to 0). This predicate compiles **one** `RegExp` and reuses it
for every message the rule ever sees, so a `g`-flagged pattern would give the
same message different answers depending on what was posted before it — a
moderation rule that is wrong roughly half the time and looks perfect in any
test that evaluates a single message. Allowed flags are `i`, `m`, `s`, `u` only.

Note the contrast, because it looks like an inconsistency and is not:
`invite.ts` and `link-domain.ts` (already shipped) *do* use module-level
`g`-flagged regexes — but with `matchAll`, which does **not** mutate the shared
regex's `lastIndex`. Verified. Both files' comments explain it. Do not
"harmonise" the two.

## Two things the plan review already fixed — use the corrected versions

1. **Task 3's span test uses `/\bcat\b/` against `'concatenate a cat'`**, where
   `indexOf('cat')` is 3 and the engine's index is 14. An earlier draft used
   `/n[o0]w/` on `'now or n0w'`, where both were 0 — so it could not fail for
   the bug it was named after. Use the corrected fixture as written, including
   the assertion that pins `content.indexOf('cat')` to 3.
2. **Task 4 has a Step 0** defining the `compile`/`message` helpers. An earlier
   draft called them without defining them.

## Things that will bite you, specifically

- **`rg` with no path argument is blocked by the sandbox** (it could read
  `.env`). Always give `rg` an explicit file or directory. Never ask for `.env`
  or any credential file — you do not need one, and `npm run test` runs with no
  network and no live Discord by design.
- **`grep` returns false negatives here.** Use `rg` with a path, or `awk`.
- **This shell substitutes backticks inside `git commit -m`.** Avoid them.
- **No migration in this dispatch.** All three predicates' configuration is
  scalar and lives in `mod_rules.config` (ADR 0040 §3). If you think you need a
  schema change, stop and report it.
- **A plan's file list is a lower bound.** Run `typecheck` early.
- The ReDoS tests carry an explicit `20_000` ms vitest timeout in the plan. Keep
  it — the default would fire before the assertion in the "watch it hang" step
  and make the observation ambiguous.

## The rule that matters most

**Break it and watch it fail.** Eleven decorative guards have now been found on
this project — ten across Slices 1–2, plus one in this very plan caught by the
plan review. The shape is always *a fixture too simple to reach the branch the
test is named after*: a correct assertion on an input where the bug cannot
occur, so it passes before the fix and after.

Guards to break and watch in this dispatch, all of them:

- **`regex`:** the ReDoS gate, as described above (must hang, not fail).
- **`caps`:** change `letters.length` to `prose.length` — the
  "measures capitals against letters" test must go red.
- **`emoji`:** drop `REGIONAL_INDICATOR` and `KEYCAP` from the condition — the
  flags/keycaps test must go red. Separately, replace the grapheme loop with a
  code-point scan — the ZWJ-family test must go red.

Report each one: what you changed, which assertion failed and how, that you
restored it.

## Gates

Before reporting done:

```
npm run typecheck && npm run lint && npm run test
```

All three clean. **No completion claim on code you have not run.**

## Deliverable

Write your detail to `docs/reports/slices-3-5-dispatch-c-report.md`:

- What you implemented, per task, one commit each.
- **The ReDoS gate**: what you did to break it, and exactly what you observed
  when it hung. This is the most important paragraph in your report.
- The other three guards, same treatment.
- **Any plan defect you found** — where a test and the plan's code disagree, or
  an assertion that cannot hold as written. Say it plainly; do not quietly
  reconcile them. The plan carried a real sequencing defect and a decorative
  guard already; assume more.
- The count from `PREDICATES` after your changes, and which kinds are absent.
- Anything you think is wrong that you did not change.

**Return to the coordinator only five lines:** status per task, commit SHAs,
one-line test summary, the guards you watched fail, and any concern.
