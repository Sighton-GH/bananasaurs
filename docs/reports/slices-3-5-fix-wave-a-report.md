# Fix wave A report — Slices 3+5 whole-branch review

Fixes CRITICAL-1, IMPORTANT-3, IMPORTANT-4, IMPORTANT-5, IMPORTANT-6, and
decorative guard 3 from `docs/reports/slices-3-5-whole-branch-review.md`, per
`docs/reports/briefs/slices-3-5-fix-wave-a-brief.md`. Baseline was 2240 tests /
109 files at `1963723`; this wave ends at **2250 tests / 109 files** (10 net
new tests, none deleted).

## CRITICAL-1 + IMPORTANT-5 (fixed together, as the brief anticipated)

`packages/core/src/automod/dry-run.ts`:

- `DryRunFixtureResult` gains `outcome: 'ok' | 'threw'`. A `'threw'` outcome
  is always scored `agreement: 'unlabelled'`, never `'agreed'`.
- `DryRunReport` gains `threw: number` and `corpusSize: number` (the fixture
  count independent of abandonment; equal to `total` unless abandoned).
- `runDryRun` counts throws and **abandons the loop after
  `MAX_THROWS_BEFORE_ABANDON = 5`** throws (bounds the stall at ~125ms instead
  of `corpusSize × 25ms`).
- Rewrote the load-bearing-wrong comment ("the same way it does not end the
  live handler") to state what `subscriber.ts` actually does: it logs
  `'the predicate threw; message left unmatched for this rule'` naming the
  rule. This dry run has no logger by design, which is exactly why folding
  `threw` into silence was the bug.

`packages/core/src/ops/commands/automod.ts` (`automod dryrun` only):

- New Case 3, ordered after `!usable` and `total === 0`: when `report.threw >
  0`, refuses to print a match table and reports
  `"N of M evaluation(s) failed (the predicate threw)"`, plus, when
  abandoned (`total < corpusSize`), `"; the run was abandoned after
  evaluating N of M fixtures in the corpus"`. Put into `data` via
  `projectReport`'s new `threw`/`corpusSize` fields, and each result's
  `outcome`.

**Guard watched fail:** `dry-run.test.ts`'s three new tests, run against the
pre-fix `dry-run.ts` (reverted via `git checkout`, patch re-applied after) —
all three failed (`report.threw` was `undefined`). Restored: all green.
Also added an `automod.test.ts` test driving the full command with a
`compileRule` spy forcing a throw on every fixture (20-fixture corpus):
confirms `"5 of 5 evaluation(s) failed"`, `"abandoned"`, `"5 of 20
fixtures"`, and the absence of `"matched on"` (no table printed).

## IMPORTANT-6

`packages/core/src/ops/commands/automod.ts`: for `kind === 'attachment_type'`
only, computes `withMetadata`/`total` (fixtures with `attachments.length > 0`
among the ones actually evaluated) and adds a line to the summary —
`"k of N fixtures carry attachment metadata (the rest predate it and cannot
match this rule)"` — plus `attachmentMetadata: {withMetadata, total} | null`
in `data` for every kind (null when not `attachment_type`). Computed once,
before the `usable`/empty/`threw` branches, so it reaches `data` on every
return path.

Tested in `automod.test.ts`: one test with a 3-fixture corpus (1 with
attachments) asserts the exact sentence and `data` shape; one test on a
`keyword_filter` rule asserts the phrase is absent and `attachmentMetadata`
is `null`.

## IMPORTANT-3

Two-part fix, as specified:

- `packages/core/src/automod/trace.ts`: `serialiseTrace` now truncates any
  over-long `detail` **string** (via new exported `truncateDetailString`,
  `MAX_DETAIL_STRING_LENGTH = 120`, ellipsis `…`) before validating, instead
  of letting `matchTraceSchema.parse` throw on it. Non-string malformations
  (wrong `kind`, a non-scalar `detail` value) still throw — a narrowing, not
  a removal. Rewrote the function's doc comment to state the new, narrower
  throw contract.
- Producers: `link-domain.ts` truncates `detail.host` at construction;
  `attachment-type.ts` truncates `detail.declaredContentType` defensively
  (member-controlled and unbounded in principle, even though short in
  practice — the field that used to be unbounded, `detail.fileName`, is
  removed entirely by IMPORTANT-4 below).

**Guard watched fail:** `trace.test.ts`'s new 200-character-`detail.host`
test, run against the pre-fix `trace.ts` — threw (`too_big`, confirmed via
the actual zod error). Restored: passes, and the stored value round-trips at
≤120 chars. Also added `link-domain.test.ts`'s own producer-level test with a
204-character host (`new URL` does not enforce DNS label length, verified) —
same red-then-green cycle.

**One existing test broke as a direct, correct consequence of this fix** and
was updated, not deleted: `apps/daemon/src/automod/wiring.test.ts`'s
`"writes a valid placeholder trace..."` test used a 200-character
`detail.message` to force `serialiseTrace` to throw into `traceJson`'s
placeholder fallback — exactly the case IMPORTANT-3 says should no longer
throw. Changed its "genuinely malformed" trace to a non-scalar `detail`
value (`{ nested: { a: 1 } }`), which still throws by design, and updated the
comment to explain why the old shape stopped exercising this path.

## IMPORTANT-4 (coordinator ruling implemented exactly)

`packages/core/src/automod/predicates/attachment-type.ts`:

- `snippet` is now `redactedDescription(extension, contentType, sizeBytes)` —
  e.g. `*.exe (application/x-msdownload, 4096 bytes)`, or `(no extension)` /
  `unknown type` when either is absent — never the filename.
- `detail.fileName` is removed entirely.
- Doc comment on `redactedDescription` states why: the predicate matches on
  extension/content-type, never the name, so the name is not the decision
  basis and does not belong in `mod_case_events` (a moderation record
  `/forgetme` does not delete). The full filename stays in the fixture
  corpus, which has its own retention row and `/forgetme` reach (OD-3).
- **No PRIVACY.md change**, per the ruling — nothing widened.

**Guard watched fail:** `attachment-type.test.ts`'s two updated/new tests, run
against the pre-fix predicate — both failed (`'c.scr'` vs the redacted form;
`'medical_letter.exe'` contains the stem). Restored: both pass, and a
dedicated test asserts `trace.detail.fileName` is `undefined` and
`JSON.stringify(detail)` contains no filename stem.

## Decorative guard 3

`packages/core/src/automod/predicates/caps.test.ts`: added a second
assertion inside the existing `'ignores fenced and inline code'` test — a
shout **outside** a fenced block (`'LOOK AT THIS RIGHT NOW ```select...```
EVERYONE'`) that must still fire with `ratio === 1`.

**Guard watched fail, twice**, to find the actual isolating bug (the first
attempt didn't isolate anything new — see below):

1. Removing stripping entirely (`prose = input.content`) failed the
   *original* assertion first (ratio 0.769 > 0.7) — confirms the review's own
   note that the existing test is not fully decorative, but doesn't exercise
   my new assertion specifically.
2. Computing `letters` from `input.content` instead of `prose` also broke
   the original assertion first — same non-isolation.
3. **The isolating bug**: replacing "strip just the fenced span" with "if the
   message contains any fenced block, treat the whole message as empty"
   (`prose = /\`\`\`[\s\S]*?\`\`\`/.test(input.content) ? '' : ...`). Under
   this bug the **original** assertion still passes (prose becomes `''`,
   length 0 < minLength, still `undefined`) — but my new assertion goes red
   (`shoutOutsideFence` is `undefined`, expected defined). This is exactly
   the "passes for two reasons at once" shape the finding describes: the
   original test cannot tell "fenced span removed" from "whole message
   nuked because a fence exists somewhere", and only the new assertion can.
   Restored the real implementation: all 5 tests green.

## Things the review got wrong or incomplete

- IMPORTANT-4's summary bullet ("Neither task could see this alone") is fine,
  but the review's own suggested fix list put the PRIVACY.md line first and
  the redaction second ("If the owner would not accept that, ... needs a
  redacted snippet"). The brief's coordinator ruling reverses that ordering
  for a reason the review doesn't state as strongly as it could: redaction is
  strictly better *even if the owner would accept the PRIVACY.md line*,
  because the filename was never the match's decision basis. Implemented per
  the brief, not the review's ordering.
- IMPORTANT-3's suggested producer-side fix names only `fileName` and `host`.
  Since IMPORTANT-4 deletes `fileName` from `attachment-type.ts` entirely,
  that specific truncation site no longer exists — I truncated
  `declaredContentType` there instead (also member-controlled, also
  currently short in practice but unbounded by type), which the review does
  not mention because it did not anticipate IMPORTANT-4's redaction removing
  the field the review was originally targeting.

## Not changed, and why

- `automod.ts`'s four list-editing commands (`invite-allow`, `invite-deny`,
  `domain-add`, `domain-rm`) and their tests — out of scope per the brief,
  owned by a second dispatch (CRITICAL-2, IMPORTANT-1, IMPORTANT-2,
  IMPORTANT-7).
- All MINOR findings — explicitly out of scope.
- `matchedOn` in `link-domain.ts`'s trace (as opposed to `detail.host`) is
  left untruncated: it is `z.string()` with no `.max()`, so it cannot trigger
  the throw IMPORTANT-3 is about. Truncating it too would be a readability
  change nobody asked for.

## Gates

```
npm run typecheck && npm run lint && npm run test
```

All three clean. 109 files / 2250 tests passed (baseline 2240/109; +10 new,
0 deleted).
