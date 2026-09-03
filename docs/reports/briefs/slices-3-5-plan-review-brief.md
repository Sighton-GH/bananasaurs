# Brief — review the Slices 3+5 plan against the spec, before any code is written

You are reviewing a plan, not code. Nothing has been implemented yet. The point
of this pass is that Slice 2's plan carried **eight defects** into execution —
a renderer contradicting its own test, an unfalsifiable WHERE clause, a name
collision — and catching those against the spec costs a fraction of catching
them mid-implementation.

Work in `/home/bryan/projects/bananasaurs/.claude/worktrees/release2-slices-3-6`.
Read only; do not edit any file except your report.

## What to read

1. **The plan under review:**
   `docs/superpowers/plans/2026-09-02-slices-3-5-stateless-predicates.md`
2. **The spec it must satisfy:**
   `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`
   — §3 Phase 2 (Slices 3 and 5), and §4's slice-specific gates.
3. **The handoff whose obligations bind it:**
   `docs/reports/release2-slices-3-5-handoff.md`
4. **`CLAUDE.md`** — the hard rules override everything.
5. **The code the plan modifies**, enough to judge whether its claims about it
   are true:
   - `packages/core/src/automod/predicates/types.ts`, `registry.ts`,
     `keyword-filter.ts`
   - `packages/core/src/automod/evaluate.ts`, `fingerprint.ts`, `dry-run.ts`
   - `packages/storage/src/repos/automod-fixtures.ts`, `automod-rules.ts`
   - `packages/storage/src/schema.ts` (the `modRules`, `wordAllowlist` and
     `automodFixtures` tables)

## What to look for, in priority order

1. **Spec requirements with no task.** Walk §3's Slice 3 and Slice 5 bullets
   and §4's gates one at a time and point at the task that implements each.
   The plan has a self-review table making this claim — **verify it rather
   than trusting it**, and say which rows are wrong.
2. **Steps whose code contradicts their own tests.** The plan's code blocks
   and its test blocks were written in one pass and are not verified against
   each other. Check every assertion against the implementation two steps
   below it. (There is at least one deliberate one, in Task 1 Step 5 — the
   plan says so. Finding *others* is the job.)
3. **Tests that cannot fail.** The project's recurring defect is a
   *decorative guard*: a fixture too simple to reach the branch the test is
   named after — a correct assertion on an input where the bug cannot occur.
   Ten were found across Slices 1–2. For each test in the plan, ask: **if the
   implementation were subtly wrong in the way this test's name describes,
   would this go red?** Name every test where the answer is no.
4. **Claims about libraries.** The plan has a "Verified environment facts"
   table of probe results. Those were measured and you should not re-derive
   them. But the plan makes *other* library claims in passing — about Zod 3
   behaviour, drizzle-orm's `onConflictDoNothing`, `Intl.Segmenter`,
   `new URL`, `String.prototype.matchAll` and `lastIndex`, SQLite CHECK
   semantics. Check those against `node_modules` or a one-line probe. Flag any
   that are wrong or unsupported.
5. **Hard-rule violations.** Guild scope on every new query signature
   (rule 2); every boundary Zod-validated (rule 3); nothing new logged without
   a `LOGGABLE_FIELDS` entry (rule 4); no new outbound destination (rule 8);
   no new dependency without justification.
6. **Name and type collisions.** Does a type, function or field the plan
   defines in one task match how a later task uses it? Slice 2's plan had a
   collision. Check `FixtureAttachment` vs `MessageAttachment`,
   `AutomodRule`'s new fields, and every `Predicate` export name against the
   registry entries.
7. **The nine plan rulings (PR-10…PR-18).** Each claims a cost if wrong.
   Is any ruling's reasoning actually false, or its cost understated? PR-14
   (deferring `invite`'s `last_matched_at`) and PR-16 (`attachment_type`'s
   lists in `config` rather than relational) are the two most likely to be
   wrong — argue with them specifically.

## What NOT to do

- Do not write or edit implementation code. No files outside your report.
- Do not re-measure the "Verified environment facts" table. It cost probes.
- Do not restructure the plan or propose a different architecture. The
  predicate interface, the relational/scalar split and the stack are settled
  (ADR 0040, ADR 0041, `CLAUDE.md`) and are not open.
- Do not pad the report. A finding with no defect behind it costs the
  coordinator context and buys nothing.

## Deliverable

Write your full findings to
`docs/reports/slices-3-5-plan-review.md`, organised as:

- **Verdict** — one of `EXECUTE-AS-IS`, `EXECUTE-WITH-FIXES`, `REWORK`.
- **Blocking** — defects that would produce wrong code or a missing spec
  requirement. For each: the plan location (task and step), what is wrong,
  and the concrete correction.
- **Decorative guards** — tests that would stay green against the bug they
  name, with the fixture change that would fix each.
- **Non-blocking** — worth fixing but not before execution starts.
- **Verified clean** — what you checked and found correct. Say so explicitly;
  a reviewer who reports only problems leaves the coordinator unable to tell
  "checked and fine" from "not checked".

**Return to the coordinator only:** the verdict, the count of blocking
findings, the single most serious one in two sentences, and the report path.
Five lines. Everything else goes in the file.
