# Dispatch D report — Tasks 5, 7, 8: `attachment_type`, `invite`, `link_domain`

Worktree: `release2-slices-3-6`. Plan:
`docs/superpowers/plans/2026-09-02-slices-3-5-stateless-predicates.md`.
Brief: `docs/reports/briefs/slices-3-5-dispatch-d-brief.md`.

## What was implemented, per task, one commit each

**Task 5 — `attachment_type`, and widening the one-code-path gate**
(`30fee50`).

- `packages/core/src/automod/predicates/attachment-type.ts` +
  `.test.ts` (8 tests): matches on declared content type **or** file
  extension (either is enough — "and" in the spec means "both lists are
  checked", not "both must hit"). Extension taken from the final
  dot-segment, lower-cased; content type taken before any `;` parameter,
  lower-cased. Reports the offending attachment's filename as `snippet`,
  not the first attachment.
- Registered `attachment_type: attachmentTypePredicate` in `registry.ts`.
- Added a new test to `dry-run.test.ts`, inside the existing
  `describe('the one-code-path invariant', ...)` block, alongside (not
  replacing) the pre-existing `keyword_filter` gate. It builds an
  `attachment_type` rule blocking `.exe`, drives a real subscriber and a
  real `runDryRun` off the same message-plus-attachment content, and asserts
  the recorded live trace equals the replayed trace, and that both sides are
  a real match (`kind === 'match'`), not two identical non-matches.

**Task 7 — the `invite` predicate** (`2f4ca8e`).

- `packages/core/src/automod/predicates/invite.ts` + `.test.ts` (11 tests,
  including an `it.each` over 6 URL shapes). Pattern matching only — no
  resolution, ever. Uses a module-level `g`-flagged regex with `matchAll`
  (not `.test()`/`.exec()`), per the plan's PR-13/reviewer note: `matchAll`
  does not mutate `lastIndex` across calls, so reusing the compiled pattern
  across messages is safe here even though the same flag is refused in the
  operator-configured `regex` predicate.
- Registered `invite: invitePredicate` in `registry.ts`.

**Task 8 — the `link_domain` predicate** (`dc9933f`).

- `packages/core/src/automod/predicates/link-domain.ts` + `.test.ts`
  (9 tests). Label-wise suffix match (`hostMatches`), not a raw string
  suffix — `example.com` matches `example.com` and `gist.example.com`, not
  `notexample.com`. Strips trailing sentence punctuation and a trailing root
  dot before comparing, so `https://example.com.` still matches. Same
  `matchAll`-over-`g`-regex pattern as `invite`, for the same reason.
- Registered `link_domain: linkDomainPredicate` in `registry.ts`.

Files touched, exactly the three tasks' lists: `attachment-type.ts/.test.ts`,
`invite.ts/.test.ts`, `link-domain.ts/.test.ts` (new), `registry.ts` and
`dry-run.test.ts` (modified). No file outside this list was touched. `caps`,
`emoji`, `regex` were not created — those remain dispatch C's.

## The three guards watched fail

**Task 5 — the widened one-code-path gate (the important one).** Per the
brief's specific instruction: temporarily restored `attachments: []` in
`predicateInputFrom`'s fixture branch in `evaluate.ts` (reverting the field
that Tasks 1–2 already wired up), then ran `dry-run.test.ts`.

- **New gate: RED.** `the dry run and the live subscriber agree on a message
  with attachments` failed at `expect(replayed).toBeDefined()` with
  `expected undefined to be defined` — the live subscriber still matched
  (it reads the real `MessageEvent.attachments`), but the fixture replay
  produced no attachments, so `attachment_type` found nothing and the two
  sides diverged.
- **Old gate: GREEN.** The pre-existing `produces byte-identical matches to
  the live subscriber, trace included` test (the `keyword_filter` gate) and
  the other 8 tests in the file stayed green throughout — 9 passed, 1
  failed. `keyword_filter` reads only `content`, so it is structurally blind
  to the attachments field being wrong.
- Reverted the change; both gates green again (10/10).

This is the exact contrast the obligation asked for: the same bug (fixture
replay skips attachment reconstruction) is invisible to the old gate and
caught by the new one.

**Task 7 — `invite`'s allowlist loop.** Removed the
`if (allowed.has(code.toLowerCase())) continue;` line so the predicate
returns on the first invite found regardless of allowlist status. Result:
`fires on the one code that is not allowlisted` failed
(`expected 'clubhouse' to be 'spamserver'` — it reported the allowlisted
code instead of the spam one), plus two more tests that also depend on the
allowlist being consulted (`does not fire on an allowlisted code`,
`matches an allowlisted code case-insensitively`) — 3 of 11 failed. Restored;
11/11 green again.

**Task 8 — `link_domain`'s suffix match.** Replaced
`listed.some((entry) => hostMatches(host, entry))` with
`listed.some((entry) => host.endsWith(entry))`. Result: `does not fire on a
domain that merely ends with the same letters` (the `notexample.com` case)
failed — `host.endsWith('example.com')` is true for `'notexample.com'`, so
it wrongly matched — while `fires on a subdomain of a denied domain`
(`tracking.example.com`) and all other 7 tests stayed green, exactly as the
brief predicted. 1 of 9 failed. Restored; 9/9 green again.

## Plan/brief defect found — reported plainly, not reconciled

The brief says: *"Confirmation that `predicateFor` now returns a predicate
for seven of the ten kinds if dispatch C has landed, or five if it has not."*

Dispatch C (Task 3 `regex`, Task 4 `caps`/`emoji`) has **not** landed in this
worktree — only `attachment-type.ts`, `invite.ts`, `link-domain.ts`,
`keyword-filter.ts` exist under `predicates/`. Counting `PREDICATES` in
`registry.ts` directly: `keyword_filter`, `attachment_type`, `invite`,
`link_domain` — **four**, not five. The arithmetic is: keyword_filter (1,
pre-existing) + this dispatch's three (attachment_type, invite, link_domain)
= 4; dispatch C's three (regex, caps, emoji) would bring it to 7 once landed.
There is no way to get 5 without either dispatch C having partially landed
one predicate already (it has landed none, per `ls`) or the brief having
miscounted. I'm reporting this as-is rather than guessing which fifth kind
was meant — **the actual, verified count right now is four of ten**, and it
will be seven once dispatch C's three land, with the absent three being the
window tier (`mention_spam`, `rapid_spam`, `duplicate_message`).

No other plan/test disagreement was found in Tasks 5, 7 or 8. The plan's code
blocks for these three tasks matched this worktree's actual conventions
closely, with one adaptation: `dry-run.test.ts` in this worktree is not the
same file shape the plan's Task 5 code block assumed. The plan's snippet
imports `predicateInputFrom`, `evaluateRule`, `createPredicateCache`,
`GUILD_ID`, and a `messageEvent`/`ruleWith` pair that build `PredicateInput`
directly. The actual file instead tests the higher-level `runDryRun` against
a real `createAutomodSubscriber`, with a `ruleWith(terms)` that takes a term
list (not a full object) and a `messageEvent` that builds a `DomainEvent`.
There is no direct import of `predicateInputFrom`/`evaluateRule` in this test
file at all — that comparison happens one layer down, inside `dry-run.ts`
itself. I wrote the new test to match the file's *actual* existing pattern
(mirroring the pre-existing "produces byte-identical matches..." test one
level up, with an `attachment_type` rule and attachments instead of a
`keyword_filter` rule and content) rather than inserting the plan's
lower-level snippet verbatim, since the lower-level helpers it names are not
importable from this file. The resulting test still does exactly what the
obligation asks: builds the "live" side through a real subscriber and the
"replayed" side through a real fixture, and compares the two traces.

## `predicateFor` / kind coverage, confirmed by direct inspection

```
$ grep -n "^const PREDICATES" -A6 packages/core/src/automod/predicates/registry.ts
const PREDICATES: Partial<Record<RuleKind, AnyPredicate>> = {
  keyword_filter: keywordFilterPredicate,
  attachment_type: attachmentTypePredicate,
  invite: invitePredicate,
  link_domain: linkDomainPredicate,
};
```

Four of ten kinds have a predicate right now. The six absent: the window tier
(`mention_spam`, `rapid_spam`, `duplicate_message`, Slice 4 — out of scope for
this whole plan) plus dispatch C's three (`regex`, `caps`, `emoji`), which
have not landed in this worktree as of this report.

## Network-unreachable confirmation (CLAUDE.md rule 1)

Read both new predicate files end to end: neither imports `node:http`,
`node:https`, `node:dns`, `node:net`, `fetch`, or any Discord/HTTP client.
`invite.ts` only builds a `Set` from the rule's hydrated allowlist and runs a
regex `matchAll` — no code path resolves a code to a guild. `link-domain.ts`
uses `new URL(...)` purely as a string parser (hostname/port/userinfo
extraction) — it never performs a network fetch, DNS lookup, or resolution.
Both work identically with every provider and every network destination
unreachable, which is what CLAUDE.md rule 1 requires and what the brief asked
to confirm.

## Gates

```
npm run typecheck && npm run lint && npm run test
```

All three clean at each commit. Final state: **105 test files / 2203 tests**,
up from the baseline 102 files / 2174 tests by exactly the tests these three
tasks added (Task 5: +1 new file with 8 tests, +1 test in `dry-run.test.ts`;
Task 7: +1 new file with 11 tests; Task 8: +1 new file with 9 tests — 8+1+11+9
= 29; 2174+29 = 2203; 102+3 = 105). No test was deleted.

## Anything else noticed, not changed

- `registry.test.ts` still uses `caps` as its worked example of "a permitted
  kind with no predicate registered yet." That remains true today (`caps`
  genuinely has no predicate), and stays true regardless of whether dispatch
  C lands before or after this report — not a defect, just noting I did not
  need to touch that file.
- `invite.ts` and `link-domain.ts` both carry the same "why `matchAll`
  reusing a `g`-flagged regex is safe here, unlike the operator-configured
  `regex` predicate" comment the plan specified, load-bearing per Global
  Constraint 11 — left as the plan wrote it since the underlying claim
  (`matchAll` does not mutate `lastIndex`) is exactly what the plan review
  says was independently verified.
- Nothing required touching `subscriber.ts`, `evaluate.ts` (outside the
  Step-5 break-and-restore drill, which left it unchanged), or
  `types.ts`'s `CompiledPredicate` — no abstraction-failure flag to raise
  for Global Constraint 9.

## Commits

- `30fee50` — feat(automod): the attachment_type predicate, and the
  one-code-path gate reaches a second field
- `2f4ca8e` — feat(automod): the invite predicate
- `dc9933f` — feat(automod): the link_domain predicate
