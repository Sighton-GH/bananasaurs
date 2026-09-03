# Dispatch C report — Tasks 3 and 4 (`regex`, `caps`, `emoji`)

## Task 3 — the `regex` predicate and the ReDoS gate

Implemented `packages/core/src/automod/predicates/regex.ts` and
`regex.test.ts` exactly as the plan specifies: `regexConfig` (Zod, `.strict()`,
pattern length capped at 1000, flags restricted to `imsu`), `REGEX_TIMEOUT_MS
= 25`, and `regexPredicate` whose `compile` builds a `node:vm` `Context` and
`Script` once and reuses both for every message. Registered as `regex:
regexPredicate` in `registry.ts`. 8 tests, all passing.

**Plan defect found and fixed (not silently reconciled):** the plan's own
Step 1 test code imports `regexConfig` from `./regex.js` but never references
it in any test body. With `tsconfig.all.json`'s `noUnusedLocals: true`
covering test files, that import fails `npm run typecheck`. I removed the
unused import; `REGEX_TIMEOUT_MS` (which *is* used) stays.

### The ReDoS gate — what I did and exactly what I observed

Changed the evaluator from:
```ts
const found = script.runInContext(context, { timeout: REGEX_TIMEOUT_MS }) as ...
```
to a direct, unprotected:
```ts
const found = pattern.exec(messageInput.content) as RegExpExecArray | null;
```

Ran `npx vitest run packages/core/src/automod/predicates/regex.test.ts -t
"survives a catastrophic-backtracking"` twice, once under `timeout 30` and
once under `timeout 40`. **Both runs produced zero output and were killed by
the wrapping `timeout`, exit code 143.** Not vitest's own reporter, not a
partial line, nothing — the process never got control back.

This is a stronger (and more informative) result than the plan's prediction
that "vitest's 20-second per-test timeout fires." It doesn't: `^(a+)+$`
against 60 `a`s is a single synchronous, non-yielding call. It blocks the
JS event loop completely, including whatever timer callback vitest's own
per-test timeout relies on to report a timeout — the timeout mechanism is
itself JS-level and cannot run while the thread is pinned inside the
backtracking `RegExp.exec`. So the failure mode without `vm`'s watchdog isn't
"a slow test that eventually reports timed out" — it is a genuine,
unrecoverable hang that only an external `SIGTERM` from outside the process
ends. That is the sharper version of the stakes the handoff names: a bad
pattern here doesn't just cost 20 seconds, it costs the process, forever,
until something outside it intervenes.

Restored the `script.runInContext(context, { timeout: REGEX_TIMEOUT_MS })`
line. Re-ran the full `regex.test.ts` file: 8/8 pass, including the ReDoS
test completing in ~64ms total for the file.

This is a real, load-bearing gate. It is not decorative.

### `g`/`y` flag refusal (PR-13)

Not separately broken/restored — the plan's "guards to break" list for Task 3
is only the ReDoS gate; the `g`/`y` rejection test (`compileRule` returning
`invalid-config`) is exercised directly by its own test and needed no
break/restore demonstration per the brief's guard list.

## Task 4 — `caps` and `emoji`

Implemented `caps.ts`/`caps.test.ts` and `emoji.ts`/`emoji.test.ts` per the
plan, with the file-local `compile`/`message` helpers (Step 0) duplicated in
each test file as specified. Registered `caps: capsPredicate` and `emoji:
emojiPredicate` in `registry.ts`. 5 tests each, all passing (10 total).

### Guard 1 — `caps`: `letters.length` → `prose.length`

Changed `const ratio = upper / letters.length;` to `upper / prose.length;`
and re-ran `caps.test.ts`. **Observed:** `measures capitals against letters,
not against every character` failed — `expected undefined to be defined`
(`'HELLO!!!!!!!!!!!!!!!'` no longer exceeded the 0.7 ratio threshold once
punctuation diluted the denominator). The other 4 tests stayed green.
Restored `letters.length`; re-ran: 5/5 pass.

### Guard 2 — `emoji`: drop `REGIONAL_INDICATOR` and `KEYCAP`

Changed the condition to `if (PICTOGRAPHIC.test(segment))` only and re-ran
`emoji.test.ts`. **Observed:** `counts flags and keycaps, which are not
Extended_Pictographic` failed — `expected undefined to be defined`
(`'🇬🇧 🇬🇧 1️⃣ 2️⃣'` scored 0 pictographic graphemes, as the plan's probe
predicted). Restored the three-way condition; re-ran: 5/5 pass.

### Guard 3 — `emoji`: grapheme loop → code-point scan

Changed `for (const { segment } of GRAPHEMES.segment(withoutCustom))` to
`for (const segment of withoutCustom)` (a bare string iterator, which yields
Unicode code points, not graphemes). Re-ran `emoji.test.ts`. **Observed:**
`counts a ZWJ sequence as one emoji` failed — `expected { categoryId:
'emoji', ... } to be undefined`, with `detail.unicode: 12` (3 ZWJ families ×
4 code points each) against a `maxCount` of 3, instead of the correct 3
graphemes. Restored the `Intl.Segmenter` loop; re-ran: 5/5 pass.

### Ripple effect found and fixed (not part of Tasks 3/4's file list, but caused by registering `caps`)

Registering `caps` broke three pre-existing tests that had used `'caps'` as
their standing example of "a `mod_rules_kind` value with no predicate behind
it yet":

- `packages/core/src/automod/predicates/registry.test.ts` — 3 tests
  (`predicateFor` returns undefined, `compileRule` reports `no-predicate`,
  `validateRuleConfig` reports `no-predicate`)
- `apps/daemon/src/automod.integration.test.ts` — the `doctor` end-to-end test
  for an inert rule kind

I repointed all four at `mention_spam` (Slice 4's window tier, still
genuinely unregistered after this dispatch), updating rule IDs and doc
comments to match. I also updated `packages/core/src/ops/commands/reads.test.ts`'s
two occurrences of a `caps`/`no-predicate` fixture object to `mention_spam`
for consistency — those two didn't actually fail (they feed a fake port
directly, not the real registry), but leaving a now-false example in a test
that documents `doctor`'s rendering seemed worse than a one-line fix.

Checked (via `rg`, with explicit paths per the sandbox's no-bare-`rg` rule)
every other `'caps'` reference in `packages/core`, `packages/storage`, and
`apps/daemon`: the remaining ones (`fingerprint.test.ts`, two spots in
`subscriber.test.ts` using malformed JSON — which fail on `invalid-config`
either way, not on their asserted-nothing `reason` — and several in
`automod-rules.test.ts`, a storage-layer file that never touches the
predicate registry) don't depend on `caps` being unregistered and needed no
change. `subscriber.test.ts`'s "logs again after the config changes" test
already anticipated this exact situation in its own comment and uses
`keyword_filter`, not `caps` — it was written ahead of this dispatch by
whoever wrote Task 6/7/8's tests.

## Gates

`npm run typecheck && npm run lint && npm run test`, run repeatedly through
the session, all clean at the end:

- typecheck: clean
- lint (eslint + prettier): clean (two files needed `prettier --write` after
  editing — `regex.ts`/`regex.test.ts`, then `reads.test.ts` — both applied)
- test: **108 files / 2221 tests passed**, zero failures, zero skipped.

Baseline was 2203 tests / 105 files. Delta: +3 files (`regex.test.ts`,
`caps.test.ts`, `emoji.test.ts`), +18 tests (8 + 5 + 5). No test was deleted.

## `PREDICATES` after this dispatch

Read directly from `registry.ts`, not trusted from the brief:

```ts
const PREDICATES: Partial<Record<RuleKind, AnyPredicate>> = {
  keyword_filter: keywordFilterPredicate,
  attachment_type: attachmentTypePredicate,
  invite: invitePredicate,
  link_domain: linkDomainPredicate,
  regex: regexPredicate,
  caps: capsPredicate,
  emoji: emojiPredicate,
};
```

**7 of 10 kinds registered.** Absent: `mention_spam`, `rapid_spam`,
`duplicate_message` — the window tier, Slice 4, not this dispatch's.

## Anything I think is wrong that I did not change

- Nothing in Task 3 or Task 4's own code. The one thing I noticed but left
  alone: `emoji.ts`'s `KEYCAP` regex is `/⃣/u` — a bare combining character
  with no character-class wrapper. It works (verified by the passing test,
  and by the broken-guard demonstration going red correctly when it's
  removed from the condition), but a future reader might reasonably wonder
  why it isn't `/⃣/`. Cosmetic only; the plan wrote it this way and it
  is correct as written.
- The `reads.test.ts` fixture fix (caps → mention_spam) is technically
  optional since those two tests don't call the real registry, but I made it
  anyway for documentation accuracy; flagging it explicitly in case the
  coordinator would have preferred it left alone as out-of-scope.

## Commits

- Task 3: `9b779fc` — "feat(automod): the regex predicate, with a hard
  per-evaluation timeout"
- Task 4: `56bd768` — "feat(automod): the caps and emoji predicates"
