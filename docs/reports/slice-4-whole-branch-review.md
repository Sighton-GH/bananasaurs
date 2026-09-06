# Whole-branch review — Release 2, Slice 4 (the window tier, seven commits)

**Verdict: SHIP-WITH-FIXES.**

3 CRITICAL · 6 IMPORTANT · 6 MINOR.

Per-task correctness was reviewed already and I did not re-derive it. Every
finding below is either an interaction between two tasks, or output that reads
as a measurement when it is not — the two shapes this pass was sequenced to
find. Three of the findings were confirmed by running the **built production
code** (`packages/core/dist/automod/predicates/registry.js`) rather than by
reading it; the transcripts are quoted inline.

**Gates re-run here, each separately, by exit code** (E-5's rule):
`npm run typecheck` → 0, `npm run lint` → 0, `npm run test` → 0,
**2304 tests / 113 files**. Matches the handoff exactly.

## The reachability fact that grades every severity below

As in the Slices 3+5 review: **Release 2 still has no production code path that
creates a rule of any of the three new kinds.** `createRule`'s only production
caller is `apps/daemon/src/runtime/daemon.ts:539` (the seeded `keyword_filter`),
and `setRuleConfig` has none. A `rapid_spam` or `duplicate_message` rule exists
today only if someone hand-inserts a `mod_rules` row.

That lowers blast radius and excuses nothing: the whole point of the slice is
that these rules will exist and an operator will tune them, and the fixes are
cheap now. Severities are graded on the design intent, as the previous review
graded its own.

---

## CRITICAL

### CRITICAL-1 — `duplicate_message` is defeated by one interleaved message, at *every* configuration (Task 1 × Task 4)

`packages/core/src/automod/predicates/duplicate-message.ts:100-107` with
`packages/core/src/automod/window.ts:100-113`.

`duplicate_message` builds its store with `maxEventsPerMember: config.maxRepeats
+ 1`, copying `rapid_spam`'s sizing argument verbatim, and the doc comment at
`duplicate-message.ts:88-92` states that argument as settled:

> The ring buffer's capacity is `maxRepeats + 1`, for the same reason
> `rapid_spam`'s is `maxMessages + 1`.

The reason does **not** carry over. `rapid_spam` counts *every* event in the
buffer, so a buffer of `maxMessages + 1` can always hold the "one too many".
`duplicate_message` counts only the events whose `value` equals this message's
normalised text (`countMatching`), but `record` puts *every* message in the same
buffer. So the buffer must hold `maxRepeats + 1` events **of one text**, and it
is sized for `maxRepeats + 1` events **in total**. Any other message the member
posts evicts a repeat before the count can exceed the threshold.

Confirmed against the built code — a member posting the same text with a single
different message between each repeat, all inside the window, at four
configurations:

```
interleaved maxRepeats=1: fired at repeat index null
interleaved maxRepeats=2: fired at repeat index null
interleaved maxRepeats=3: fired at repeat index null
interleaved maxRepeats=5: fired at repeat index null
consecutive  maxRepeats=1: fired at repeat index 1
consecutive  maxRepeats=2: fired at repeat index 2
consecutive  maxRepeats=3: fired at repeat index 3
consecutive  maxRepeats=5: fired at repeat index 5
```

`null` means it never fired, at any repeat count. Not "harder to catch" —
**never caught**. The evasion is typing `lol` between posts, and it is also the
ordinary shape of the spam this predicate exists for: the same invite pasted
repeatedly by someone who also says other things.

*Why per-task review could not see it.* Task 1 reviewed a correct, honestly
bounded ring buffer. Task 4 reviewed a correct call into it. The defect is
entirely in the arithmetic relating one to the other, and the doc comment that
should have raised it instead asserts the conclusion.

**Fix.** Decouple the buffer size from the threshold. Add a second constant
beside `DEFAULT_MAX_TRACKED_MEMBERS` — `DEFAULT_MAX_EVENTS_PER_MEMBER = 50`, say
— and use it for `duplicate_message`, documenting the residual evasion (more
than that many distinct messages between repeats). Do **not** put the normalised
text in the `WindowKey` instead: that puts member-authored content in a cache
key and makes the 500-member cap a 500-distinct-*texts* cap. The guard to add,
and to watch fail first: `maxRepeats: 1`, sequence `spam` / `filler` / `spam`,
must match.

### CRITICAL-2 — `duplicate_message`'s documented default fires on two captionless image posts (Task 4)

`packages/core/src/automod/predicates/duplicate-message.ts:22-33` and `:99`.

`minLength` defaults to `0`, deliberately, by an accepted plan-review fix — the
schema must not "silently choose a false-negative rate on the operator's
behalf". The doc comment considers short text (`"ok"` three times *does* fire,
and says so). It does not consider **absent** text.

`predicateInputFrom` builds an input whenever `event.content !== undefined`, and
`packages/discord/src/events.ts:395` maps discord.js's `content` through
`?? undefined` — which for an attachment-only, sticker-only or embed-only
message is the empty string, not null. So `normalised` is `''`, `0 < 0` is
false, and `''` is recorded as the member's repeated "text".

Confirmed against the built code, default config `{"maxRepeats":1,"windowMs":30000}`:

```
empty content #1: no
empty content #2: MATCH
  snippet="" detail={"count":2,"maxRepeats":1,"windowMs":30000,"normalisedLength":0}
```

Two images posted back to back with no caption — the single most ordinary thing
that happens in an engineering club's photo channel — opens a case, with an
empty snippet, on the default configuration. In `enforce` mode it deletes them.

This is a false positive in the one tier `docs/08` says needs the full two-week
floor, and the gate for a rule that feeds the escalation counter is **zero**
false positives. The handoff's own rule applies: narrow the rule, do not move
the bar.

**Fix.** One line: `if (normalised.length === 0) return undefined;` before the
`minLength` comparison, with a comment naming attachment-only messages, and a
test. The plan ruling stands untouched — refusing to invent a floor is not the
same as matching on the absence of content.

### CRITICAL-3 — a windowed rule's dry-run count is wrong in **both** directions, and the CLI says nothing (Tasks 3-4 × Slice 2's corpus and dry-run command)

`packages/core/src/automod/dry-run.ts:104-190`,
`packages/core/src/ops/commands/automod.ts:128-215`,
`packages/core/src/automod/evaluate.ts:240-253`,
`packages/storage/src/repos/automod-fixtures.ts:63-100`.

The corpus is not a message history. `captureObservedFixture` records **one
matched message** (`subscriber.ts:305-333`), only in non-`enforce` mode. Two
consequences meet in Slice 4, and they push the count opposite ways:

**Under-report.** A windowed rule matches only on the "one too many" message, so
only that message and its successors are ever captured — the events that *built*
the count are absent from the corpus by construction. A `rapid_spam` rule with
`maxMessages: 3` that fired correctly on a six-message burst captures three
fixtures; replayed, those three produce counts 1, 2, 3 and **zero matches**.
Once a human labels them `should_match` — they are genuine spam — the CLI prints
`0/3 matched · 0 false positive(s) of 3 labelled · 3 missed` and three
`MISSED — the rule did not match this fixture` lines, for a rule that is working
perfectly. The reassuring-when-false direction is the one that matters at flip
day: *"this rule barely fires over 300 fixtures, it is safe to enforce."*

**Over-report.** PR-1 gives every *edit* its own corpus row
(`<messageId>:<hash(content)>`, deliberately, so an edit does not collapse into
the original). `predicateInputFrom`'s fixture branch then hard-codes
`eventKind: 'messageCreate'` — documented as "the conservative option for
Slice 4, where treating an edit as a create counts it once rather than not at
all". For a **rate** predicate it is not conservative and it is not once: one
message edited three times, each edit captured, becomes four corpus rows and
therefore four counted events in a replay, where live `rapid_spam` counted one
create and ignored all three edits (PR-23).

So the number is neither a rate over traffic nor a rate over anything. And the
same command already carries the caveat pattern this needs: `attachmentAwareness`
(`automod.ts:135-152`) exists because `attachment_type`'s denominator included
fixtures that could not possibly match. That is a strictly *weaker* version of
this problem, and Slice 4 did not add the analogue.

**Fix.** In `automodDryRunCommand`, for `rapid_spam` and `duplicate_message`,
print a caveat line beside the summary and put the same fact in `data` — the
corpus holds only previously-matched messages, so a replay's count is not a rate
over traffic and a `MISSED` on a windowed rule is expected rather than a defect.
Ideally also count and report the rows whose `fixtureId` shares a `messageId`
with another row, which is the over-report term made visible. And correct
`evaluate.ts:246-249`'s "conservative" claim: it is conservative for content
predicates only.

---

## IMPORTANT

### IMPORTANT-1 — `detail.count` can never exceed the threshold, so the trace reads as a measurement and is a constant (Task 1 × Tasks 3-4)

`rapid-spam.ts:81`, `duplicate-message.ts:132`.

Both traces carry `count`. Both fire only when `count > threshold`, and both
buffers cap at `threshold + 1`. So `count` is **always exactly
`threshold + 1`**, forever, and is derivable from the config alone. Confirmed —
fifty messages inside one window, `maxMessages: 3`:

```
rapid_spam after 50 messages in-window, final trace detail: {"count":4,"maxMessages":3,"windowMs":600000}
```

A reviewer on Slice 9's screen reads `count 4 / maxMessages 3` as "we observed
four" and cannot distinguish a marginal burst from a fifty-message raid. This
also silently caps any future severity or escalation logic that reads `count`.

**Fix.** Either count over the full window independently of the buffer, or —
cheaper and honest — rename the field to say what it is (`observedAtCap`, or
carry `atLeast: count`) and add the field that does carry magnitude, below.

### IMPORTANT-2 — neither windowed trace lets a human agree or disagree (Tasks 3-4 × Slice 9's review screen)

`rapid-spam.ts:66-86`, `duplicate-message.ts:117-138`, rendered by
`trace.ts#renderTrace`.

A reviewer sees the predicate name, a threshold restated in prose, `(none)` for
normalisations, and (per IMPORTANT-1) a constant. No timestamps, no elapsed
span, no reference to the other messages in the window, and no span into this
one. The evidence for a *sequence* match is a snippet of one message. The only
way to agree or disagree is to open Discord and scroll — and the spec's own
pre-flip gate is "a rehearsal in which every rule's trace is rendered and read.
A trace nobody can read produces an observe window that yields nothing."

**Fix.** Add `elapsedMs` (this message's `atMs` minus the oldest counted event's)
and, for `duplicate_message`, `firstAtMs`. Both are numbers, not content, so
ADR 0041 §4 is untouched. `normalisedLength` already there is a good precedent.

### IMPORTANT-3 — the real memory ceiling is not the one `DEFAULT_MAX_TRACKED_MEMBERS` documents

`window.ts:190-202`.

The constant's comment reasons about 500 members and concludes "the memory cost
is one small ring buffer each". The per-member cap is not a constant — it is
`threshold + 1`, operator-controlled, and both schemas permit a threshold of
1 000. The actual ceiling is

`(number of compiled windowed rules) × 500 × (threshold + 1) × (bytes per event)`

and for `duplicate_message` "bytes per event" is a **whole normalised message**
(`record(atMs, normalised)`, uncapped; `minLength`'s ceiling is 4 000 chars). At
the maximum a single `duplicate_message` rule reaches roughly 500 × 1 001 × 4 KB
≈ 2 GB; at realistic message lengths, ~100 MB per rule. `rapid_spam` at maximum
is ~500 000 event objects, ~25 MB per rule. Nothing validates the product, and
nothing bounds the rule count. `docs/15` sets resource budgets this can exceed
with one hand-inserted row.

**Fix.** Store `sha256(normalised).slice(0,16)` instead of the text (see
IMPORTANT-4 — the same change fixes retention), and state the ceiling as a
product in the constant's comment.

### IMPORTANT-4 — deleting the pruning (`6bbc60a`) was right on the two grounds argued, and incomplete on a third: retention

The argument in the ledger and in `window.ts:64-85` is correct as far as it
goes, and I could not construct an input where the deletion changes an
observable **verdict**. `countWithin`/`countMatching` filter on every call, so
an out-of-window event is never counted; `maxEventsPerMember` applies on every
`record`, so the array is capped at all times. On correctness and on the memory
*bound*, the deletion stands and should not be reverted as written.

**The third ground the analysis missed is exactly the one a test cannot see, and
that is why it could not be seen.** Age-based pruning was the only mechanism
that dropped member-authored content out of process memory as it aged. Without
it, `duplicate_message` retains a member's normalised message text with **no
time bound at all**: a member who posts twice and never posts again keeps those
strings resident until the process restarts or that rule's fingerprint changes.
Two things compound it:

- `PredicateCache` never deletes an entry (`evaluate.ts:98-110` only ever
  `set`s). Disable or delete a windowed rule and `listRules` stops returning it,
  so its cache entry — and its store, holding up to 500 members' text — is never
  revisited and never released for the process lifetime.
- `/forgetme` deletes rows (`automod_fixtures`, case events). It cannot reach a
  closure-held `Map`, and `PRIVACY.md`'s 30-day promise about deleted-message
  content is about storage.

So: the deletion was **not wrong**, but the justification recorded for it is
narrower than it reads, and the gap it leaves is a privacy property rather than
a correctness one. **Fix (one change, three findings): record a truncated
sha256 of the normalised text rather than the text.** `countMatching` only ever
tests equality, so behaviour is identical; memory becomes a constant per event
(IMPORTANT-3); and no member-authored content is held in RAM at all, which
closes this without restoring the mechanism whose guard could not be written.
Record the reasoning where the deletion is recorded, so the next reader does not
re-add pruning to solve it.

### IMPORTANT-5 — Task 5b's two gate cases are **not** sufficient; three divergences window state makes possible that neither can catch (Task 5b × Tasks 1/3/4)

Both cases are well built and PR-25's reasoning about them is right. But they
close exactly the two blind spots the coordinator enumerated, and window state
opens more than two. Named, as asked:

1. **`eventKind`, and it is the important one.** The fixture branch hard-codes
   `eventKind: 'messageCreate'`; the live path ignores `messageUpdate` for both
   windowed predicates (PR-23). That is an *asymmetric*, replay-only divergence
   — precisely the class PR-25 says the gate can see — and neither case ever
   constructs a `messageUpdate` on either side. It is also the mechanism of
   CRITICAL-3's over-report term, so the gate is green over a live bug.
2. **The handwritten-fixture author collapse.** `predicateInputFrom` uses
   `fixture.authorId ?? 'fixture'`, and every handwritten fixture has
   `author_id NULL` by construction. So a replay attributes **every** handwritten
   fixture to one pseudo-member, and a windowed rule counts an operator's
   adversarial `should_not_match` corpus as one person's burst. Replay-only,
   asymmetric, invisible to both cases (both use observed fixtures with a real
   author, matching the live event's author). Latent only because no production
   surface writes handwritten fixtures yet — but `automod dryrun --source
   handwritten` already exists.
3. **The `maxMembers` eviction.** The live store also tracks members whose
   messages never matched and were therefore never captured, so the two paths
   reach the 500-member cap at different points and evict different members.
   Both cases use one member.

Two further gaps in Obligation 1's coverage, worth recording with it:

- **The gate covers `rapid_spam` only.** `duplicate_message` — the only predicate
  that exercises `countMatching` and the `value` half of the store, the genuinely
  new code — is not in the differential gate at all.
- **Neither new case compares the trace across paths**, unlike the two older gate
  cases which assert `expect(replayed?.trace).toEqual(recorded.trace)`. So the
  gate's headline claim ("byte-identical matches, trace included") does not
  extend to the window tier; Case A compares *which message* matched, and Case B
  compares two nothings.

**Fix.** Add a third case with a `messageUpdate` in the live sequence and the
same message present once in the corpus, asserting the two paths' counts, and
extend one case to `duplicate_message` with a trace comparison. Both watched
failing.

*On PR-25's claim itself:* it is stated correctly in the code
(`dry-run.test.ts:246-256`), and no test in the suite relies on the opposite —
the two older gate cases both scope their claims correctly in their own comments
("a behavioural comparison, so it can only see a divergence in a field some
shipped predicate reads"), and nothing treats the gate as proof of correctness.

### IMPORTANT-6 — Slice 4 turned a spurious recompile from a wasted CPU cycle into a silent kill switch, and Slice 9 already schedules one (Task 1/3/4 × `fingerprint.ts`, pre-existing)

`packages/core/src/automod/fingerprint.ts:19` and `:96-105`, with
`rapid-spam.ts:65-71`.

`ruleFingerprint` is exclusion-based: every field on `AutomodRule` is hashed
unless it is in `EXCLUDED_FIELDS`, and the comment presents that as a pure safety
property ("a field added later is hashed by default"). Before this slice it was.
Now, a field that changes **with traffic** recompiles the artifact on every
message, which resets the window, which means `rapid_spam` can never fire — with
no log line, no `doctor` entry, and a rule that reads as enabled and configured.
That is ADR 0039's exact silent-non-matching failure, reintroduced through a
mechanism built to prevent it.

This is not hypothetical: **PR-14 defers `invite`'s `last_matched_at` to Slice
9**, and a per-rule last-matched timestamp on `AutomodRule` is precisely such a
field. Neither `fingerprint.ts` nor PR-21 warns about it; PR-21 says a recompile
is always correct, which is true only for a *configuration* change.

**Fix.** A sentence in `EXCLUDED_FIELDS`' comment: a field that changes with
traffic rather than with configuration **must** be excluded, because since Slice
4 a recompile destroys window state. Add the note to PR-14's deferral in the
ledger, and a test that a rule differing only in such a field keeps its
fingerprint, to be written when the field arrives.

---

## MINOR

1. **`RingMemberWindow` is not a ring.** `window.ts:96-98` re-slices the whole
   array on every `record` once full — an O(cap) allocation per message per rule,
   up to 1 001 elements at maximum config. `countWithin`/`countMatching` allocate
   an intermediate array via `.filter().length`. Negligible for one club guild;
   the name promises otherwise.
2. **`stripZeroWidth` runs twice on every live message.** `predicateInputFrom`
   already strips `content`; `normaliseForDuplicateCheck` strips again. Harmless,
   and the exported function genuinely needs it for its own test — worth a
   comment so nobody "optimises" the strip out of the exported normaliser.
3. **Stale premise in a comment, of exactly the class Task 5a set out to end.**
   `packages/core/src/automod/subscriber.test.ts:1136-1137` says "`'caps'` has no
   registered predicate" — untrue since Slice 5. The test itself is fine
   (`keyword_filter`); only the explanation expired.
4. **Neither windowed predicate is channel-scoped, and neither says so.** The
   same text in five channels is five repeats; twenty messages across ten
   channels is one rate. Almost certainly right, and undocumented — one comment
   each, because a reader will otherwise assume the omission is a bug.
5. **`WindowStore.size()` exists only for a test** and is on the production
   interface. Honestly documented as such; noted only so it is not mistaken for a
   caller-facing API later.
6. **`automod.integration.test.ts:381`'s title still claims "is inert"** and the
   test sends no message — it asserts only `doctor`'s output. Pre-existing and
   unchanged by the repoint; the repoint itself is sound (see Verified clean).

---

## Decorative guards

**One introduced by this slice, and it is named for the bug CRITICAL-1 is.**

`packages/core/src/automod/predicates/duplicate-message.test.ts:78-86` —
*"does not count different messages toward the repeat"*. `maxRepeats: 2` gives a
buffer of 3, and the test posts exactly 3 messages, so **no eviction ever
occurs**. It passes under the correct implementation and under the shipped one.
It is the canonical shape `docs/22` records: a fixture too simple to reach the
branch the test is named after. Four messages (`spam`/`other`/`spam`/`spam` at
`maxRepeats: 2`) would go red today.

**One that is sound but load-bearing on a fact its fixture does not state.**

`dry-run.test.ts`'s Case B asserts two identical nothings. PR-25 justifies that
correctly — only a spread-out sequence distinguishes a correct replay clock from
a wrong one — and the coordinator watched it redden. It stays honest only while
the fixture's timestamps remain outside `windowMs`; a later edit to either turns
it decorative with no visible signal. Worth one line in the test tying the
timestamps to the config value they must exceed.

**Checked and *not* decorative** — the ambiguity is genuinely present in each
fixture, so a subtly wrong implementation goes red:

- `window.test.ts` "keeps two members apart", "keeps two guilds apart", "keeps
  two rules apart": both sides record, so a key missing a component reports 2.
- `window.test.ts` "does not grow past the per-member cap": 50 events, a window
  covering all of them, asserting 3.
- `window.test.ts` "evicts the least recently active member": asserts both the
  survivor and the evicted.
- `rapid-spam.test.ts` "counts each member separately": interleaved authors, two
  each under a threshold of 3 — a rule-only key reaches 4 and fires.
- `rapid-spam.test.ts` / `duplicate-message.test.ts` "is guild-scoped": the
  second guild's message would be the *second* count under a key missing
  `guildId`, at `maxMessages`/`maxRepeats` 1, so it fires and goes red.
- `mention-spam.test.ts` "counts user and role mentions together" (neither list
  reaches the threshold alone) and "makes `countEveryoneAs` configurable" (a
  hard-coded weight of 5 fires).
- `dry-run.test.ts` Case A asserts *which* message matched on both paths, not
  merely that something did.

---

## Verified clean

Stated explicitly so "checked and fine" is distinguishable from "not checked".

- **Guild scope (rule 2).** The window key is
  `` `${guildId}:${memberId}:${ruleId}` `` and `WindowKey` makes `guildId`
  non-optional at the type level, so a caller cannot omit it. Both predicates
  pass `input.guildId`. Three unit guards cover it and none is decorative.
- **No `Date.now()`** in `window.ts` or any of the three predicates (`rg` over
  all four files: no hit outside the doc comment saying so).
- **No unintended recompile from the subscriber's lifetime.** `buildGuildRuntime`
  — and therefore `createAutomodSubscriber` and its `predicateCache` — runs
  **once per allowlisted guild at process start**
  (`apps/daemon/src/runtime/daemon.ts:115-124`), not on `guildCreate`. A gateway
  reconnect does not reset a window.
- **No unintended recompile from hydration.** `ruleFingerprint` canonicalises and
  sorts `terms`, `allowlist`, `inviteAllowlist`, `linkDomains`, and `hydrate`
  additionally orders its queries, so the digest cannot follow the query plan.
  `mode` is excluded, so a `test` → `enforce` flip does **not** discard a window
  (the expensive moment, and it is handled).
- **No unintended recompile from an unrelated write.** The only writer of
  `mod_rules.config` is `setRuleConfig` (no production caller yet); list writes
  (`addLinkDomain`, terms) change only the fingerprint of the rule they belong to.
  A rule is read once per message and evaluated once.
- **How many stores exist:** one per compiled windowed artifact — i.e. per
  enabled windowed rule per guild, plus one per windowed rule per dry run for the
  duration of that run. Superseded artifacts are dropped when the same key is
  re-evaluated. (The ceiling that follows is IMPORTANT-3; the *count* is what the
  plan implies.)
- **`matchedOn` carries no member content in any of the three predicates** — it
  is a threshold restated in prose, config-derived, and bounded by the config
  schemas (`maxMentions` ≤ 1 000, `windowMs` ≤ 600 000). `detail` values are
  numbers and booleans only, well inside `matchTraceSchema`'s `.max(120)`. The
  one predicate that matches *on* content puts `normalisedLength`, not the text.
  ADR 0041 §4 holds for all three.
- **`snippet: input.content.slice(0, 200)`** matches the `caps` and `emoji`
  precedent set in Slices 3+5 and goes to `mod_case_events.matched_snippet`,
  which is not the trace. Consistent, bounded, not a regression.
- **`mention_spam` is genuinely stateless** (PR-24 honoured — no `window.js`
  import) and reads Discord's own `mentionsEveryone` flag rather than the text,
  with `evaluate.ts`'s `EVERYONE_MENTION` reconstructing it for fixtures only.
- **The registry seam is production-safe.** `compileRule` and
  `validateRuleConfig` delegate over the shipped `PREDICATES`;
  `compileRuleWith`/`validateRuleConfigWith` have no production caller (`rg`
  across `packages` and `apps`, excluding tests) and are **not exported from
  `packages/core/src/index.ts`**, so nothing outside the package can reach them
  with an empty registry. `resolveConfigWith` checks `isRuleKind` first, so no
  cast reaches `no-predicate` through a public entry point.
- **Obligation 3 discharged.** `rg` over `no-predicate` across `packages` and
  `apps`: no test depends on a real `RuleKind` being unregistered. The two
  registry tests use `compileRuleWith({}, …)`, `reads.test.ts` uses a
  deliberately non-`RuleKind` string against a fake port, and
  `subscriber.test.ts`/`evaluate.test.ts` use real predicates.
- **The `automod.integration.test.ts` repoint to `no-terms` is sound.**
  `no-terms` travels the same `compileRule` → `listUnusableAutomodRules` →
  `doctor` rendering path `no-predicate` did, so the end-to-end wiring the test
  exists for is still exercised, and unlike a borrowed unshipped kind it cannot
  expire. The only thing lost is that no end-to-end test now reaches the
  *registry-resolution* branch — correctly, since it is unreachable in
  production, and `registry.test.ts` covers it with the seam. (Its "is inert"
  half was already unasserted before the repoint — MINOR-6.)
- **PR-25's claim is stated correctly** in `dry-run.test.ts:246-256`, and no test
  in the suite implicitly relies on a differential gate being able to see a
  symmetric bug.
- **Eviction logic** (`window.ts:180-187`): re-recording an already-tracked
  member does not evict anyone (`wasTracked` short-circuits), `for()` genuinely
  has no side effect on an absent key, and the LRU-by-insertion-order reasoning
  is correct for a `Map` that deletes before setting.

---

## Hard-rules checklist

| Rule | Result |
| --- | --- |
| 1 — AI never in the enforcement path | **Clean, checked.** No provider import, call or prompt anywhere in the diff; all three predicates are deterministic pure functions over `PredicateInput`. |
| 2 — guild scope is a mandatory partition key | **Clean, checked** — including the cache-key clause the brief names: the window key carries `guildId` in its own right, `WindowKey` makes it non-optional at the type level, and three non-decorative guards cover it. No new query. |
| 3 — model output / stored data is untrusted input | **Clean, checked.** Both new configs are `.strict()` Zod schemas parsed on the way *out* of the database by `resolveConfigWith`; the trace still meets `matchTraceSchema` on write and read. No new boundary is unvalidated. |
| 4 — no secrets in logs or diagnostics | **Clean, checked.** The diff adds no log call at all, so `LOGGABLE_FIELDS` owes nothing; `window.ts` and the three predicates take no logger, which is what keeps them callable from a dry run. |
| 5 — no provider receives server content | **Not engaged.** No provider request exists in this slice. |
| 6 — every Discord side effect has a durable idempotency key | **Owes nothing.** This slice adds **no** Discord side effect — no gateway or REST call in the diff — so there is nothing for rule 6 to cover, and I am not inventing one. |
| 7 — licensing | **Clean.** All new code is original; no new third-party source, so `docs/PROVENANCE.md` needs no entry. |
| 8 — no autonomous writes, broad access, DM AI or new outbound destinations | **Clean, checked.** No new network destination, no new permission, no new autonomous action. |
| New dependencies | **None.** The only imports added are `zod` and in-repo modules, both already present. |

---

## What I would do before merging

1. CRITICAL-1 and CRITICAL-2 — two small edits in `duplicate-message.ts`, each
   with a guard watched failing first. Neither touches Task 1's module.
2. CRITICAL-3 — the caveat line in `automodDryRunCommand`, modelled on
   `attachmentAwareness`, plus the correction to `evaluate.ts`'s "conservative"
   comment.
3. IMPORTANT-4's hash-instead-of-text change, which also settles IMPORTANT-3 and
   leaves `6bbc60a` correctly deleted.
4. IMPORTANT-5's third gate case (`messageUpdate`) and IMPORTANT-6's one-sentence
   warning in `EXCLUDED_FIELDS`, both cheap and both preventing a future silent
   failure.

IMPORTANT-1, IMPORTANT-2 and the MINORs can travel with Slice 9, where the review
screen that renders them is built — provided they are carried in the handoff
rather than remembered.
