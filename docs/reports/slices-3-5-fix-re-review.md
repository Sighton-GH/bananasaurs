# Re-review — Slices 3+5 fix waves A and B

Verdict: **ADDRESSED-WITH-RESIDUAL**

Every fix does what its report claims, verified against source (not the
reports) for all fifteen items. Two residual/introduced defects were found,
both in the `dry-run.ts` / `attachment-type.ts` corner the brief flagged as
highest-risk. Neither is the placeholder-trace shape of Slice 2's precedent —
`placeholderTrace`/`traceJson` in `apps/daemon/src/ops/wiring.ts` are
untouched by this diff and already carry that fix from before this branch.

## Per-finding tally

- **CRITICAL-1 (throwing predicate reported as clean)** — PARTIAL. `threw`,
  `corpusSize`, per-fixture `outcome`, and the abandon-after-5 logic all work
  as claimed (verified in `dry-run.ts:93-206`) and the CLI's Case 3 correctly
  refuses the match table. But `DryRunReport.falseNegatives` (and, in
  principle, `falsePositives`) is still computed as
  `results.filter(r => r.label === 'should_match' && !r.matched)` —
  unchanged by the fix — so a fixture whose `outcome` is `'threw'` and whose
  true label is `should_match` is counted as a miss, even though
  `agreement` was explicitly hardened to never say `'agreed'`/`'disagreed'`
  for that same fixture. See New defects below.
- **IMPORTANT-5 (abandon after 5 throws)** — ADDRESSED. Bounds the stall to
  5 evaluations; `break` after `threw >= 5` confirmed in the loop.
- **IMPORTANT-6 (attachment metadata denominator)** — ADDRESSED. Computed
  once before all branches, reaches `data` on every return path including
  the empty/threw cases (verified in `automod.ts`).
- **IMPORTANT-3 (`serialiseTrace` truncation)** — ADDRESSED-WITH-RESIDUAL.
  The narrowing is exactly as advertised: `truncateDetailString` only maps
  over string values in `detail`; a non-scalar `detail` value, an unknown
  `kind`, or a malformed `span` are untouched by the fix and still throw
  (confirmed against `trace.ts:93-101` and `trace.test.ts`'s two paired
  tests). But the fix introduced a live, non-hypothetical instance of the
  known `matchedOn`-has-no-cap gap — see New defects.
- **IMPORTANT-4 (attachment redaction)** — ADDRESSED. `redactedDescription`
  never includes the filename; `detail.fileName` is gone; verified by the
  dedicated test and by reading the predicate. The coordinator's ruling
  (extension + content type + size is enough for an appeal, since the
  filename was never the match's decision basis) reads as sound to me —
  I'd not overturn it.
- **decorative guard 3 (`caps` fenced-code test)** — ADDRESSED. The new
  "shout outside the fence" assertion is a real isolation: confirmed the
  actual stripping logic (`caps.ts:36`) matches the report's description,
  and the report's three-attempt watched-fail (two non-isolating, one
  isolating) is the right shape for this kind of guard.
- **CRITICAL-2 (`link_domain` empty-list hazard)** — ADDRESSED. Traced the
  full consequence chain rather than assuming it: `doctor`'s
  `listUnusableAutomodRules` calls `compileRule` on every enabled rule and
  filters `!result.ok`, so the new `no-terms` refusal surfaces there
  automatically (`apps/daemon/src/ops/wiring.ts:138-149`). The subscriber's
  once-per-fingerprint logging branches generically on `outcome.kind ===
  'unusable'` with no per-reason special-casing (`subscriber.ts:272-276`), so
  it is unaffected. `seedAutomodDefaults` only ever seeds a `keyword_filter`
  rule, never `link_domain`, so it cannot hit the new guard. The `invite`
  asymmetry's reasoning (one list that doesn't invert meaning when empty,
  vs. `link_domain`'s allow/deny pair that does) is sound.
- **MINOR-2 (orphaned doc comment)** — ADDRESSED. One-line move, no
  behaviour.
- **IMPORTANT-1 (stored vs. requested `listType`)** — ADDRESSED. Verified via
  the real round-trip test and the port's `find`-by-canonical-domain lookup.
- **IMPORTANT-2 (canonicalisation drift)** — ADDRESSED. `addLinkDomain` and
  `removeLinkDomain` now call the same `canonicalDomain` helper
  (`automod-rule-lists.ts`) — one function, not two copies that can drift.
  `removeInviteAllowlistEntry`'s new `lower()` comparison is consistent with
  `invite.ts`'s compile-time `code.toLowerCase()` Set: removal finds a
  case-preserving stored row regardless of the operator's casing, and the
  next compile rebuilds the lower-cased Set from whatever remains.
- **IMPORTANT-7 (no kind check)** — ADDRESSED. `findRuleKindAndConfig` gates
  all four write ports; wrong-kind is a usage answer, still audited; real
  test proves a `keyword_filter` rule id is refused by `invite-allow`.
- **decorative guard 1 (CLI suites couldn't fail)** — ADDRESSED. The three
  new `automod-rule-lists.test.ts` tests go through `OPERATOR_COMMANDS`
  against a real migrated database and a `portsFor` that mirrors the fixed
  `wiring.ts` logic rather than the fake renderer-only stubs; the report's
  two-pass watched-fail (revert ports, then revert the repository
  canonicalisation) is correctly targeted at the two different layers the
  bug could have lived in.

**Wave interaction**: both waves touched `automod.ts` and `automod.test.ts`
in disjoint regions (wave A: the `automodDryRunCommand`/`projectReport`
machinery and its `describe('automod dryrun', ...)` block; wave B: the four
list-editing commands and their own `describe` blocks lower in the file,
plus a shared `withStatusLine`/`linkDomainStatusLine` pair wave A never
touches). Read both diff hunks directly against the current file — no
overlap, no reintroduced bug, consistent with the reported 2265/109 with no
deletions.

## New defects introduced by the fixes

1. **IMPORTANT (data integrity, bounded impact)** — `runDryRun`'s
   `falseNegatives` count can include fixtures that threw. CRITICAL-1's fix
   hardened `agreement` so a thrown fixture is never `'agreed'`/`'disagreed'`,
   but the sibling `falseNegatives`/`falsePositives` tallies in
   `dry-run.ts:200-203` still key only on `matched` (always `false` for a
   throw) against `label`, so a `should_match` fixture that threw is counted
   as a miss it never actually took. The abandon-at-5 cap bounds the damage
   to at most 5 misattributed entries per run, and the human-facing CLI text
   is unaffected (Case 3 in `automod.ts` returns before the summary line
   whenever `threw > 0`), but `data.falseNegatives` — the machine-readable
   field the brief notes Slice 6's gate is expected to read — is not, and
   nothing before this fix corrected it despite the fix touching this exact
   code region for the parallel `agreement` field. Smallest fix: exclude
   `outcome === 'threw'` results from both filters.
2. **IMPORTANT (introduced by this diff specifically)** — In
   `attachment-type.ts`, `trace.matchedOn: byExtension ? extension :
   contentType` carries the identical member-controlled, unbounded-in-
   principle value that `detail.declaredContentType` two lines below it now
   truncates via `truncateDetailString` — but `matchedOn` itself is left
   untouched, and `matchTraceSchema.matchedOn` has no `.max()`. Before this
   diff both fields were equally unbounded; after it, one is capped and the
   other, holding the same value, is not — an inconsistency the fix itself
   created. This is the brief's "known inaccuracy" (`matchedOn` could carry
   unchecked content) made concrete, not hypothetical: a crafted filename
   with a very long fake extension, or a spoofed long declared content type,
   writes an unbounded string into `mod_case_events.trace.matchedOn` today.
   Recommend truncating `matchedOn` in `attachment-type.ts` with the same
   `truncateDetailString` call (safe here — unlike `regex`'s `matchedOn`,
   this one is never the operator's configured pattern, so there is no
   1000-character case to protect). Separately, `trace.ts`'s schema comment
   ("`detail`'s `.max(120)` is what actually makes that a rule rather than a
   hope") overstates its own coverage — it should say plainly that the
   `.max(120)` bounds `detail` only, that `matchedOn` is each producer's own
   responsibility, and that `attachment-type.ts`/`link-domain.ts` are the two
   producers that currently need to honour it by convention rather than by
   schema (a blanket schema cap would break `regex`'s 1000-character
   `matchedOn`, per the brief).

No other new defects found. `link-domain.ts`'s `host` truncation is real and
correctly placed; the schema's `.strict()` top-level guard is untouched and
still closes unknown fields.

## Decorative guards among the new tests

None found among the new tests themselves. All eleven new/changed guards
this pass checked (wiring.test.ts's rewritten placeholder-trace case,
trace.test.ts's two IMPORTANT-3 tests, dry-run.test.ts's throw/abandon tests,
automod.test.ts's throw-spy and attachment-metadata tests, caps.test.ts's
shout-outside-fence assertion, link-domain.test.ts's four `compileRule`
refusal tests, and automod-rule-lists.test.ts's three round-trip tests) go
red against a plausible reversion of their own fix, per each report's
watched-fail log, and I independently re-derived at least one failure mode
for each of the highest-risk ones (CRITICAL-1's throw path, CRITICAL-2's
`no-terms` guard, IMPORTANT-2's canonicalisation) by reading the source
rather than trusting the narrative.

## Verified clean (checked, not assumed)

- `trace.ts`'s narrowing: non-scalar `detail`, unknown `kind`, malformed
  `span` all still throw — read the implementation, not just the tests.
- `wiring.ts`'s `placeholderTrace`/`traceJson` (the Slice 2 precedent path):
  confirmed via the diff's file list that `apps/daemon/src/ops/wiring.ts` is
  **not** touched by this fix wave; only its test file's one case was
  edited, exactly as wave A's report says.
- CRITICAL-2's downstream consequences: `doctor` (`listUnusableAutomodRules`
  → `compileRule`), the subscriber's generic `unusable` handling, and
  `seedAutomodDefaults` (`keyword_filter` only) — all read directly, not
  inferred.
- IMPORTANT-2's canonicalisation: one shared `canonicalDomain` helper, not
  two copies — read, not assumed identical.
- IMPORTANT-2's invite mirror: `invite.ts`'s compile-time lower-casing is
  consistent with the repository's new case-insensitive removal — read both
  sides.
- Wave A/B's shared edits to `automod.ts`/`automod.test.ts`: read both diff
  hunks against the current file to confirm disjoint regions and no
  reintroduced bug.
- Did **not** re-run the test suite myself (read-only pass, per the brief);
  relied on the reports' stated 2265/109 and the diff's content, cross-checked
  against the actual source files rather than the reports' prose alone.

Report: `docs/reports/slices-3-5-fix-re-review.md`
