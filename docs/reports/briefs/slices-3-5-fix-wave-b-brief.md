# Brief — Fix wave B: `link_domain`'s empty-list hazard, and the list-editing commands

Work in `/home/bryan/projects/bananasaurs/.claude/worktrees/release2-slices-3-6`.
This is a git worktree. **Do not `cd` to `/home/bryan/projects/bananasaurs`.**

## Your task

Fix **four findings and two decorative guards** from the whole-branch review at
`docs/reports/slices-3-5-whole-branch-review.md`. **Read the full text of each
finding**; the table below is orientation, not the spec.

| Finding | What | Severity |
| --- | --- | --- |
| CRITICAL-2 | `link_domain` has no empty-list guard: `allow` mode with no allow rows matches **every link**; `deny` mode with no deny rows can never match; the CLI reports both as a tidy success | **CRITICAL** |
| IMPORTANT-1 | `automod domain-add` prints the `listType` the operator asked for, not the one the row is actually on | IMPORTANT |
| IMPORTANT-2 | `addLinkDomain` canonicalises, `removeLinkDomain` does not — so you cannot remove what you added | IMPORTANT |
| IMPORTANT-7 | none of the four new commands checks the rule's **kind** | IMPORTANT |
| Guard 1 | all four new CLI test suites drive `fakeOpsPorts` with canned outcome strings, so they cannot fail for IMPORTANT-1, -2 or -7 | (guard) |
| Guard 2 | `link-domain.test.ts` has no empty-list case in either mode, so CRITICAL-2 has no guard anywhere | (guard) |
| MINOR-2 | orphaned doc comment at `packages/core/src/ops/ports.ts:316-317` | MINOR |

**Fix wave A is already committed** (`d3e1c6e`, `5986bbd`, `9912a8e`,
`db0e82c`) and handled CRITICAL-1 and IMPORTANT-3/4/5/6. **Do not revisit
those.** In particular `attachment_type`'s snippet is now deliberately redacted
(no filename) and `serialiseTrace` deliberately truncates over-long `detail`
strings instead of throwing — both are rulings, not accidents.

In `packages/core/src/ops/commands/automod.ts` and `automod.test.ts`, touch
**only** the four list-editing commands (`invite-allow`, `invite-deny`,
`domain-add`, `domain-rm`) and their tests. Wave A owns `automod dryrun` there
and has already committed it.

Leave every other MINOR alone.

## Baseline

**2250 tests / 109 files**, typecheck and lint clean, at `db0e82c`. If the count
drops you deleted a test and must say so.

## CRITICAL-2 — the important part is which direction the bug goes

`compileRule`'s guard against "a rule that looks configured and can never
match" is hard-scoped to one kind:

```ts
if (rule.kind === 'keyword_filter' && rule.terms.length === 0) {
```

`link_domain` compiles from
`rule.linkDomains.filter(e => e.listType === config.mode)`. When that is empty:

- **`deny` with no deny rows** — the rule can never fire. Silent
  non-matching: ADR 0039's exact failure, in the slice that exists to kill it.
- **`allow` with no allow rows** — **every link in every message matches.** In
  `test`/`observe` that floods the corpus and Slice 9's review queue with a
  false positive per link; in `enforce` it deletes every message containing a
  link.

Both are one `automod domain-rm` away, and the command prints
`rule r1's domain lists are now empty`, which reads as a completed tidy-up.

**A comment in `link-domain.ts` is a load-bearing error and must be corrected,
not merely worked around.** It says inferring the mode from which rows exist
"would make deleting the last allow row silently change the rule from a
whitelist into a no-op." Deleting the last allow row does not make it a no-op —
**it makes it match everything.** Fix the comment to say what is true.

**The fix, two parts:**

1. **Generalise the guard in `registry.ts`.** Return `no-terms` for a
   `link_domain` rule when no row carries the configured `mode`. That makes the
   `allow` case **inert and loud** instead of fire-on-everything, makes the
   `deny` case visible, and `doctor`'s `listUnusableAutomodRules` reports both.
   `no-terms`' current `detail` string says "no enabled terms in this rule" —
   make the detail kind-appropriate rather than reusing wording about terms.
2. **Make the two `domain-*` commands say what the resulting state means.**
   They have the rule id, so they can read its `config.mode`. An empty list must
   read as a consequence, not as tidiness — e.g. `rule r1 is a whitelist (mode
   allow) and its allow list is now empty, so it cannot match; add a domain or
   disable the rule`.

**`invite` gets no such guard, deliberately, and say so in a comment.** An
`invite` rule with an empty allowlist is *correct and useful* — it fires on every
invite, which is the point of the predicate. The asymmetry with `link_domain` is
real: `link_domain`'s `allow` mode inverts its meaning when the list empties,
`invite`'s does not.

## IMPORTANT-1 — do not paper over it by printing the argument

`automod_link_domains`' primary key is `(guild_id, rule_id, domain)`, so
re-adding a domain with the **other** `listType` is an `onConflictDoNothing`
no-op. The wiring's before/after count sees no change, returns
`'already-present'`, and the command prints the operator's requested `listType`
while the list below shows the real one. Two lines of output contradict each
other and the wrong one is the headline. The operator's actual intent — move this
domain to the other list — silently did not happen.

**Fix:** the port returns the **stored** `listType` alongside
`'already-present'`, and the message names it truthfully — e.g.
`example.com is already on rule r1's allow list; nothing changed (remove it
first to move it to deny)`.

**Do not build a move command.** Telling the truth and naming the remedy is in
scope; a new verb is not.

## IMPORTANT-2 — one place should know the canonical form

`addLinkDomain` lower-cases and strips a leading `www.`; `removeLinkDomain`
compares verbatim. So `automod domain-rm r1 WWW.Example.COM` deletes nothing and
the operator must reverse-engineer the canonical form from the printed list.

**Fix:** canonicalise inside `removeLinkDomain`, in the repository, so one place
knows the rule. Apply the same reasoning to `removeInviteAllowlistEntry` —
removing `CLUBHOUSE` should remove `clubhouse`, since the predicate already
matches codes case-insensitively. Note in a comment that invite codes are stored
**case-preserving** (the label is for humans) but matched and removed
case-insensitively; that is deliberate, not drift.

## IMPORTANT-7 — existence is not enough

The guard is `ruleExists`. So
`automod invite-allow default-word-filter clubhouse 'our server' --confirm`
succeeds against a `keyword_filter` rule, writes a row, writes an audit row, and
prints a success line. Nothing will ever read that row.

**Fix:** add `'wrong-kind'` to each of the four ports' return unions, check the
kind, and say so. `invite-allow`/`invite-deny` require kind `invite`;
`domain-add`/`domain-rm` require `link_domain`.

## The two decorative guards — this is half the value of this wave

**Guard 1.** All four CLI suites drive `fakeOpsPorts` with hard-coded outcomes
(`addLinkDomain: () => 'already-present'`) and assert on rendered text. They test
the renderer, which is legitimate — but they **cannot fail** for IMPORTANT-1, -2
or -7, because the repository is never in the loop.
`it('says a code is already allowed rather than erroring on a repeat add')`
reads like a round-trip test and is a string assertion over a canned constant.

Keep the renderer tests. **Add real round-trip coverage** in
`packages/storage/src/repos/automod-rule-lists.test.ts`, which already reaches a
migrated database *and* `OPERATOR_COMMANDS` (Task 9 established that pattern and
explains in its header comment why that file is the only place that can). Cover,
against a real database:

- add a domain as `deny`, re-add it as `allow` → the message names **allow**
  (IMPORTANT-1);
- add `example.com`, remove `WWW.Example.COM` → it is gone (IMPORTANT-2);
- `invite-allow` against a `keyword_filter` rule → refused as wrong-kind
  (IMPORTANT-7).

**Guard 2.** Add empty-list cases to `link-domain.test.ts` in **both** modes:
`deny` with no rows never matches, and `allow` with no rows — assert the post-fix
behaviour (the rule is unusable via `compileRule`), *and* keep a test proving the
predicate itself would match everything if it were ever compiled that way, so the
hazard stays documented rather than merely fixed.

## Things that will bite you

- **`rg` needs an explicit path** in this sandbox; a bare-pattern `rg` is
  blocked. `grep` returns false negatives — use `rg <pattern> <path>` or `awk`.
  Never request `.env` or any credential file.
- **Do not use backticks inside `git commit -m`** — this shell substitutes them.
- **Adding to a port's return union breaks every stub.** Slice 1 Task 6 and
  Task 9 both had to touch `packages/core/src/ops/test-fixtures.ts` and
  `packages/http/src/test-support.ts`. Run `npm run typecheck` early and
  **report how many sites you touched**.
- **Comments are load-bearing claims** here. CRITICAL-2 exists partly because one
  asserted the wrong failure direction.

## The rule that matters most

**Break it and watch it fail.** Twelve decorative guards have been found on this
project, and two of this wave's items *are* decorative guards. Write each guard
first, watch it red against current code, then fix. Report for each: what you
broke, what went red, that you restored it. A guard you did not watch fail is a
guard you have not tested.

## Gates

```
npm run typecheck && npm run lint && npm run test
```

All three clean before you report done.

## Deliverable

Write detail to `docs/reports/slices-3-5-fix-wave-b-report.md`:

- What you changed per finding, with commits.
- **Every guard you watched fail**, and what went red.
- How many port-stub sites you touched.
- Anything the review got **wrong or incomplete** — say it plainly. Wave A found
  two such things and both were real.
- Anything you chose not to change, and why.

**Return only five lines:** status per finding, commit SHAs, one-line test
summary, guards watched fail, and any concern.
