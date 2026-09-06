# Release 2, Slice 4 — the window tier (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the last three predicates — `mention_spam`, `rapid_spam`,
`duplicate_message` — and with them the first sliding-window state this project
has carried, then close the one-code-path gate's two remaining blind spots.

**Architecture:** One new module (`automod/window.ts`) holding a bounded,
guild-scoped ring buffer; three new predicate files; three registry entries. The
window lives on the **compiled artifact**, in `compile`'s closure, so the
subscriber's fingerprinted per-instance cache already gives it the right
lifetime and a dry run's fresh cache already isolates it. The predicate
interface, the subscriber and the evaluator do not change shape.

**Tech Stack:** TypeScript (Node 22, strict) · Zod 3.25.76 · Vitest 2. **No new
dependency.**

**Spec:** `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`
§3 Phase 2, Slice 4, and §4's gates.

**Handoff:** `docs/reports/release2-slice-4-handoff.md` — its four obligations
bind this plan and are restated below.

**Ledger:** `docs/reports/release2-slices-1-6-ledger.md` — R-1…R-15, OD-1…OD-3,
PR-1…PR-19. After a compaction it outranks anyone's recollection.

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **Guild scope is a mandatory partition key** (CLAUDE.md rule 2), and **rule 2
   names cache keys explicitly**. The window key carries a guild id even though
   the artifact is already per-guild — defence in depth, the same reasoning
   `predicateCacheKey` records.
2. **Stored JSON is untrusted** (rule 3). Each predicate's config is a
   `.strict()` Zod schema, validated on write *and* read.
3. **AI is never in the enforcement path** (rule 1). Nothing here calls a
   provider.
4. **No new outbound destination** (rule 8), **no new dependency**, **no
   migration** — all three kinds are already permitted by `mod_rules_kind`
   (ruling R-2) and all three configs are scalar (ADR 0040 §3). If you think you
   need a schema change, **stop and say so**.
5. **Pino redaction is an allowlist** (rule 4). A new logged *field name* needs a
   `LOGGABLE_FIELDS` entry with a comment saying what may flow into it, or
   `safeLogFields` silently drops it — ruling R-10 is a shipped bug of exactly
   that shape.
6. **Break it and watch it fail.** **Fourteen** decorative guards have been
   found here. The shape is *a fixture too simple to reach the branch the test
   is named after*. Watch every guard go red before you make it pass, and say in
   your report which line you neutralised and what failed.
7. **Verify both directions of a boundary.** Slice 5's `emoji` predicate
   measured that `\p{Extended_Pictographic}` under-counts and fixed it; nobody
   checked it *over*-counts too (`©`, `™`, `▪`, `☑`), so a bulleted list scored
   as emoji. A measurement confirming what you expected is half a measurement.
8. **A human-facing guard is not a machine-facing guard.** The dry run's CLI text
   was protected against a misleading summary while the same wrong number
   survived in `data.falseNegatives`, which Slice 6 reads as a machine.
9. **If you find yourself editing `subscriber.ts`, `evaluate.ts` or
   `CompiledPredicate` to make a predicate fit — stop and say so.** That is the
   abstraction failing and it is worth a ruling. It held for all six predicates
   of Slices 3+5. Task 5 legitimately edits `dry-run.test.ts`; the prohibition is
   on unplanned changes.
10. **This plan will contain defects.** Slices 1–2 carried eight, Slice 3+5 five.
    Treat the code below as a strong proposal. **When a test and the code
    disagree, say so plainly** rather than quietly reconciling them.
11. **Comments are load-bearing claims.** Both CRITICALs in Slice 3+5 trace to a
    comment asserting something false. Check a library claim against
    `node_modules` before repeating it.
12. **`grep` returns false negatives here** — use `rg` with an explicit path, or
    `awk`. A bare-pattern `rg` is refused (it could read `.env`); that refusal is
    correct. **`jq` is not installed.** Do not use backticks in `git commit -m`.
13. Gates: `npm run typecheck && npm run lint && npm run test`, all clean, run by
    you, before any completion claim. Baseline **2267 tests / 109 files**.

---

## Verified facts

Measured in this worktree, not recalled.

| Fact | Consequence |
| --- | --- |
| `matcher.ts` exports exactly `stripZeroWidth`, `collapseThresholdsFor`, `buildMatcher`. There is **no** exported string→string normaliser. | See ruling PR-20. |
| `obscenity` exposes transformers only as *containers* consumed inside `RegExpMatcher`. `TransformerSet` exists in `dist/` but is **not** exported from the package index. | Applying the matcher's chain standalone needs a private deep import. Do not. |
| The matcher's `collapseDuplicatesTransformer` thresholds are **derived from the configured word list** (`collapseThresholdsFor`, ADR 0039). | That stage is undefined for a predicate with no word list. |
| `PredicateInput` already carries `atMs`, `eventKind`, `mentionedUserIds`, `mentionedRoleIds`, `mentionsEveryone` (rulings R-3, R-13). | This slice adds no interface fields. |
| `createPredicateCache()` is fresh per `runDryRun` call (ADR 0041 §6), and the subscriber holds one per instance (R-1). | Window state gets the right lifetime for free. |

---

## Plan rulings

Numbering continues from PR-19. Append these to the ledger.

**PR-20 — `duplicate_message` gets its own documented normalisation, because
the spec's instruction to reuse the keyword matcher's is not achievable.** The
spec says "the normalisation is the same code the keyword matcher uses, not a
second copy". Two verified obstacles, and both are fatal to the literal reading:
the matcher's collapse-duplicates stage takes its thresholds **from the word
list** (ADR 0039), and `duplicate_message` has no word list, so that stage has
no defined behaviour for it; and `obscenity` never exposes its transformer chain
as a function over a string — `TransformerSet` is internal, so reusing the chain
means a deep import into `dist/`.

**The third option, examined and rejected** — recorded so nobody re-proposes it.
`obscenity` *does* export the transformer factories themselves
(`resolveConfusablesTransformer`, `resolveLeetSpeakTransformer`,
`toAsciiLowerCaseTransformer`), so one could hand-roll the dispatch loop that
runs them over a string. **The reason not to is not merely that it copies a deep
import — it is that the copy would be fragile *and* still not faithful.** It
would depend on an undocumented container discriminant (`'factory' in container`
versus a plain `transform` property) with no compatibility guarantee, and it
would *still* omit `collapseDuplicatesTransformer`, whose thresholds need a word
list this predicate does not have. So the cost buys a partial, brittle subset of
the matcher's behaviour — which is worse than an honest, simple normaliser that
says what it does.

So `duplicate_message` normalises with **`stripZeroWidth` (the shared function,
imported, not reimplemented) plus lowercase plus whitespace collapse**, in a
named exported function with a comment recording the above. *The spec's intent is
honoured where it can be:* the one evasion class this project's own code closes
is shared rather than copied. *Costs if wrong:* two members posting the same text
with different leetspeak spellings are not treated as duplicates. That is the
safe direction for a predicate in the tier the spec says needs the full
two-week observation floor, and widening it later is additive.

**PR-21 — window state lives on the compiled artifact, in `compile`'s closure,
not in module state.** The subscriber's cache is per-instance and keyed
`<guildId>:<ruleId>` with a content fingerprint (R-1, ADR 0040 §5), so an
artifact's lifetime is already "this guild's rule, until its configuration
changes". A dry run gets a fresh cache per invocation, which is the isolation
ADR 0041 §6 exists to provide. *Consequence to state in the code:* **editing a
windowed rule's config resets its window**, because the fingerprint changes and
the artifact is rebuilt. That is correct — a changed threshold should not be
judged against counts accrued under the old one — and it must be commented, or a
future reader will read it as a bug. *Costs if wrong:* a module-level store
would survive config edits and leak across guilds; this cannot.

**PR-22 — the window is a bounded map with two independent limits, and
exceeding the member cap evicts rather than refuses.** Per member per rule, a
ring buffer capped at the largest count any config could ask for; across
members, a cap on how many members are tracked at once, evicting the
least-recently-active. Both are needed: without the per-member cap a single
member's flood grows one buffer without limit, and without the member cap a
guild-wide raid grows the map without limit. **Eviction, never refusal:**
dropping the oldest member's window means one spammer may get one extra message
through, where refusing to track would mean the rule silently stops working
under exactly the load it exists for. *Costs if wrong:* under a raid larger than
the member cap, the earliest-tracked members' windows are forgotten and their
counts restart. Bounded, documented, and the safe direction.

**PR-23 — the window tier counts `messageCreate` only, and ignores
`messageUpdate`.** `PredicateInput.eventKind` exists for this (ruling R-13,
added a slice early for exactly this predicate set). A member fixing a typo
three times must not read as three messages. *Costs if wrong:* a member who
edits a message to add spam is not counted toward a rate. The content predicates
still fire on that edit, so the message is not unmoderated — only un-*rated* —
and the alternative (counting edits) makes an ordinary typo-fixer trip a spam
rule, which is a false positive in the tier whose gate is a false-positive rate.

**PR-25 — a differential gate detects only *asymmetric* divergence, so the
"break it" target must sit on exactly one side of the comparison.** The
one-code-path gate compares the live subscriber against the dry run. **A bug in
the code they share cannot make them disagree** — it makes both wrong together,
and the comparison stays green. That is not a weakness to fix; it is what the
gate is, and `evaluate.ts`'s header already implies it: the gate proves the two
callers are *the same code*, not that the code is *correct*.

Two consequences, and the first draft of Task 5 got both wrong — the plan review
caught them before any code was written:

1. **Never corrupt `evaluateRule`, `compileRule` or `predicateInputFrom`'s
   *shared* logic to test this gate.** Corrupting `evaluateRule`'s cache lookup
   starves both sides of window state equally; both say "no match" and agree.
   The corruption must be asymmetric: the *subscriber's* cache wiring (live only),
   or `predicateInputFrom`'s *fixture branch* (replay only).
2. **The fixture shape has to make the corrupted answer differ from the correct
   one.** A "the fourth message is one too many" burst already has all four
   timestamps clustered inside one window, so replacing the replay clock with
   `Date.now()` — which also clusters them, inside microseconds — produces the
   *same* verdict. The guard passes under the bug it is named after. Only a
   sequence **spread beyond** the window distinguishes them: correct → no match,
   clustered-by-corruption → a wrong match.

*Costs if wrong:* Task 5 reports Obligation 1 discharged while never having
exercised it — which is precisely the failure Obligation 1 exists to prevent, and
would have shipped a gate that reads as proof and is not.

**PR-24 — `mention_spam` is stateless and reads one message.** The spec groups
it in the window tier, but nothing about counting mentions on a single message
needs a window. It ships without touching `window.ts`. *Costs if wrong:*
nothing; if a later requirement wants mentions-per-minute, it becomes a second
config field and gains a window then. Recorded because a reader comparing the
spec's grouping to the code will otherwise think a window was forgotten.

---

## File structure

**New:** `packages/core/src/automod/window.ts` + `.test.ts`;
`predicates/mention-spam.ts` + `.test.ts`; `predicates/rapid-spam.ts` +
`.test.ts`; `predicates/duplicate-message.ts` + `.test.ts`.

**Modified:** `predicates/registry.ts` (three entries);
`packages/core/src/automod/dry-run.test.ts` (Task 5, obligation 1);
`predicates/registry.test.ts` and `ops/commands/reads.test.ts` (Task 5,
obligation 3); `packages/core/src/index.ts` if the window module needs exporting.

---

## Task order and dispatch batching

**Strictly one dispatch at a time** — every predicate task edits
`registry.ts`, and commit `7be2e4f` records what concurrent work in one worktree
costs.

| Dispatch | Tasks | Why together |
| --- | --- | --- |
| A | 1, 2 | The window store, then the one predicate that does not use it. **Done** — `7cec46c`, `6dd61da`. |
| B | **5a**, 3, 4 | The registry seam **first** (see below), then both predicates that consume Task 1's store. |
| C | 5b | The behavioural one-code-path gate — needs all three predicates registered. |

**Task 5 is split, and 5a moved forward, because the alternative is a fourth
round of churn.** Obligation 3's four placeholder tests have now been repointed
**three times**: they used `'caps'`, moved to `'mention_spam'` when Slice 5
shipped `caps`, and moved to `'rapid_spam'` when dispatch A shipped
`mention_spam`. **Dispatch B ships `rapid_spam`**, so leaving the seam until
Task 5 would break them a fourth time and then a fifth when `duplicate_message`
lands.

Doing 5a first means the last two predicates register against a registry that no
longer needs a real-but-unshipped kind to stand for "unregistered". **This is the
treadmill obligation 3 exists to end; ending it one dispatch early costs
nothing.**

---

### Task 1: the bounded, guild-scoped window store

**Files:** Create `packages/core/src/automod/window.ts` + `window.test.ts`.

**Interfaces — later tasks are written against these names:**

```ts
export interface WindowKey {
  readonly guildId: string;
  readonly memberId: string;
  readonly ruleId: string;
}

/** One member's recent events for one rule, oldest first. */
export interface MemberWindow {
  /** Records an event at `atMs` and prunes anything older than `windowMs`. */
  record(atMs: number, value?: string): void;
  /** How many events fall inside `[atMs - windowMs, atMs]`. */
  countWithin(atMs: number, windowMs: number): number;
  /** How many recorded events inside the window carry exactly `value`. */
  countMatching(atMs: number, windowMs: number, value: string): number;
}

export interface WindowStore {
  for(key: WindowKey): MemberWindow;
  /** Members currently tracked. Exposed for the eviction test, not for callers. */
  size(): number;
}

export const createWindowStore = (options: {
  /** Per-member ring buffer capacity (PR-22). */
  readonly maxEventsPerMember: number;
  /** How many members to track before evicting the least recently active (PR-22). */
  readonly maxMembers: number;
}) => WindowStore;

/**
 * How many members one windowed rule tracks at once, before the least recently
 * active is evicted (PR-22).
 *
 * Exported as a constant, and imported by both windowed predicates, so the two
 * cannot drift to different undocumented numbers — each builds its own store,
 * because window state lives per compiled artifact (PR-21).
 *
 * 500 is deliberately modest: Bananasaurs serves **one** engineering-club guild
 * (`CLAUDE.md`), so 500 simultaneously-active posters is far beyond a realistic
 * burst, and the memory cost is one small ring buffer each. If a raid ever
 * exceeds it, PR-22's eviction is the documented behaviour rather than a
 * failure.
 */
export const DEFAULT_MAX_TRACKED_MEMBERS = 500;
```

**Tasks 3 and 4 both import `DEFAULT_MAX_TRACKED_MEMBERS`** rather than each
choosing a number. Only `maxEventsPerMember` is per-rule, sized from that rule's
own config.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { createWindowStore } from './window.js';

const key = (memberId: string, guildId = '100000000000000001', ruleId = 'r1') => ({
  guildId,
  memberId,
  ruleId,
});

describe('the window store', () => {
  it('counts only events inside the window', () => {
    const store = createWindowStore({ maxEventsPerMember: 10, maxMembers: 10 });
    const w = store.for(key('m1'));
    w.record(1_000);
    w.record(2_000);
    w.record(9_000);
    // A 5-second window at t=9000 covers [4000, 9000]: only the last event.
    expect(w.countWithin(9_000, 5_000)).toBe(1);
    expect(w.countWithin(9_000, 10_000)).toBe(3);
  });

  it('keeps two members apart', () => {
    // NOT decorative: BOTH members record events, so an implementation that
    // ignored memberId would report 2 for each and this goes red. One member
    // with events and one without would pass under that bug.
    const store = createWindowStore({ maxEventsPerMember: 10, maxMembers: 10 });
    store.for(key('m1')).record(1_000);
    store.for(key('m2')).record(1_000);
    expect(store.for(key('m1')).countWithin(1_000, 5_000)).toBe(1);
    expect(store.for(key('m2')).countWithin(1_000, 5_000)).toBe(1);
  });

  it('keeps two guilds apart even for the same member and rule', () => {
    // CLAUDE.md rule 2 names cache keys explicitly. Both sides record, so an
    // implementation keyed on (memberId, ruleId) alone reports 2 and goes red.
    const store = createWindowStore({ maxEventsPerMember: 10, maxMembers: 10 });
    store.for(key('m1', '100000000000000001')).record(1_000);
    store.for(key('m1', '200000000000000002')).record(1_000);
    expect(store.for(key('m1', '100000000000000001')).countWithin(1_000, 5_000)).toBe(1);
  });

  it('keeps two rules apart for the same member', () => {
    const store = createWindowStore({ maxEventsPerMember: 10, maxMembers: 10 });
    store.for(key('m1', '100000000000000001', 'rule-a')).record(1_000);
    store.for(key('m1', '100000000000000001', 'rule-b')).record(1_000);
    expect(
      store.for(key('m1', '100000000000000001', 'rule-a')).countWithin(1_000, 5_000),
    ).toBe(1);
  });

  it('does not grow past the per-member cap', () => {
    const store = createWindowStore({ maxEventsPerMember: 3, maxMembers: 10 });
    const w = store.for(key('m1'));
    for (let i = 0; i < 50; i++) w.record(1_000 + i);
    // A 100-second window covers every event ever recorded, so this can only
    // be 3 if the buffer is genuinely bounded — the assertion would read 50
    // under an unbounded implementation.
    expect(w.countWithin(1_050, 100_000)).toBe(3);
  });

  it('evicts the least recently active member past the member cap', () => {
    const store = createWindowStore({ maxEventsPerMember: 5, maxMembers: 2 });
    store.for(key('m1')).record(1_000);
    store.for(key('m2')).record(2_000);
    store.for(key('m3')).record(3_000); // evicts m1, the least recently active
    expect(store.size()).toBe(2);
    // m1's window is forgotten — one extra message may get through, which
    // PR-22 accepts deliberately over refusing to track under load.
    expect(store.for(key('m1')).countWithin(3_000, 100_000)).toBe(0);
    expect(store.for(key('m2')).countWithin(3_000, 100_000)).toBe(1);
  });

  it('counts repeats of one value without counting the others', () => {
    // duplicate_message's need. Three events, two of them identical, so an
    // implementation ignoring `value` reports 3 and goes red.
    const store = createWindowStore({ maxEventsPerMember: 10, maxMembers: 10 });
    const w = store.for(key('m1'));
    w.record(1_000, 'buy crypto now');
    w.record(2_000, 'something else');
    w.record(3_000, 'buy crypto now');
    expect(w.countMatching(3_000, 10_000, 'buy crypto now')).toBe(2);
  });

  it('takes its clock from the caller, never from Date.now()', () => {
    // The dry run replays fixtures at their recorded createdAt (ADR 0041 §6).
    // A store reading the wall clock would make a replay's result depend on
    // when the replay ran. Events far in the past must count when the caller
    // says the window is far in the past too.
    const store = createWindowStore({ maxEventsPerMember: 10, maxMembers: 10 });
    const w = store.for(key('m1'));
    w.record(1_000);
    w.record(2_000);
    expect(w.countWithin(2_000, 5_000)).toBe(2);
  });
});
```

- [ ] **Step 2: Run them and watch them fail.** `npx vitest run packages/core/src/automod/window.test.ts` — no such module.

- [ ] **Step 3: Implement `window.ts`**

Write it yourself from the interface above. The requirements that are not
negotiable, each with the reason so you do not trade it away:

- **No `Date.now()` anywhere in this module.** Every method takes `atMs`. A dry
  run replays fixtures at their recorded timestamps, and a store that read the
  wall clock would make a replay's result depend on when it ran — which is
  exactly the determinism ADR 0041 §6 exists to protect, and one of the two
  blind spots Task 5 closes.
- **The map key includes `guildId`** (CLAUDE.md rule 2), even though the
  artifact is already per-guild. The same defence-in-depth `predicateCacheKey`
  documents.
- **Both caps from PR-22**, with the eviction policy commented as a deliberate
  choice over refusal.
- **Pruning on `record`**, so a member who stops posting does not hold their
  events forever — and note in a comment that pruning needs a `windowMs`, so
  either the store is constructed knowing it or `record` prunes lazily against
  the largest window it has been asked about. Pick one and say why.

- [ ] **Step 4: Run the tests, and break three guards**

Expected: PASS. Then watch each go red and restore:
1. Drop `guildId` from the map key → the two-guilds test fails.
2. Remove the per-member cap → the cap test reports 50, not 3.
3. Remove the eviction → `size()` reports 3, not 2.

Report what you saw for each.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add packages/core/src/automod/window.ts packages/core/src/automod/window.test.ts
git commit -m "feat(automod): a bounded, guild-scoped sliding-window store

The first state this project's predicates have carried. No Date.now() in the
module: every method takes the clock from its caller, because a dry run replays
fixtures at their recorded timestamps and a store reading the wall clock would
make a replay depend on when it ran.

Two independent caps (plan ruling PR-22): a per-member ring buffer, and a cap on
members tracked, evicting the least recently active. Eviction rather than
refusal - forgetting one member's window lets one extra message through, where
refusing to track would make the rule stop working under exactly the load it
exists for.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SAXL4Tpn7zGArAzZs9vKNW"
```

---

### Task 2: `mention_spam`

**Files:** Create `predicates/mention-spam.ts` + `.test.ts`; modify
`registry.ts`.

**This predicate is stateless** (ruling PR-24) — it counts mentions on one
message and never touches `window.ts`. Say so in its doc comment, because the
spec groups it with the window tier and a reader will otherwise think a window
was forgotten.

Config: `{ maxMentions: number, countEveryoneAs?: number }`. `@everyone`/`@here`
reach far more people than a user mention, so they are worth more than one —
default 5, and make it configurable rather than hard-coded.

- [ ] **Step 1: Write the failing tests.** Follow Slice 5's per-file
  `compile`/`message` helper pattern (see `caps.test.ts`); each `AutomodRule`
  literal needs all four list fields (`terms`, `allowlist`, `inviteAllowlist`,
  `linkDomains`).

```ts
it('counts user and role mentions together', () => {
  // The ambiguity: neither list alone reaches the threshold, so an
  // implementation that counted only one of them goes red.
  const compiled = compile('{"maxMentions":3}');
  expect(
    compiled.evaluate(
      message('hi', {
        mentionedUserIds: ['1', '2'],
        mentionedRoleIds: ['3', '4'],
      }),
    ),
  ).toBeDefined();
});

it('does not fire at the threshold, only above it', () => {
  const compiled = compile('{"maxMentions":3}');
  expect(compiled.evaluate(message('hi', { mentionedUserIds: ['1', '2', '3'] }))).toBeUndefined();
});

it('weights @everyone above a single mention', () => {
  // One @everyone alone exceeds a threshold of 3 at the default weight of 5.
  const compiled = compile('{"maxMentions":3}');
  expect(compiled.evaluate(message('hi', { mentionsEveryone: true }))).toBeDefined();
});

it('reads Discord’s own everyone flag, not the message text', () => {
  // A live message carries mentionsEveryone from the gateway; the text is not
  // the authority. 'user@heretical.com' must not count.
  const compiled = compile('{"maxMentions":1}');
  expect(
    compiled.evaluate(message('mail me at user@heretical.com', { mentionsEveryone: false })),
  ).toBeUndefined();
});

it('has no span, because the count is a property of the whole message', () => {
  const compiled = compile('{"maxMentions":1}');
  expect(compiled.evaluate(message('hi', { mentionedUserIds: ['1', '2'] }))?.trace.span)
    .toBeUndefined();
});
```

- [ ] **Step 2: Watch them fail.** No such module.
- [ ] **Step 3: Implement it.** `categoryId: 'mention_spam'`; `matchedOn` names
  the configured threshold (`more than 3 mentions`), never message text —
  ruling R-8, and `matchedOn` is unbounded by schema so each producer is
  responsible for putting only configured values there (see `trace.ts`'s
  comment). `detail` carries the counts.
- [ ] **Step 4: Register it, run, and break one guard.** Count only user
  mentions → the "counts user and role mentions together" test goes red.
  Restore. Report it.
- [ ] **Step 5: Gates and commit.**

---

### Task 3: `rapid_spam`

**Files:** Create `predicates/rapid-spam.ts` + `.test.ts`; modify `registry.ts`.

**Consumes:** Task 1's `createWindowStore`.

Config: `{ maxMessages: number, windowMs: number }`, with `windowMs` bounded
(say 1 000–600 000) so a config cannot ask the store to hold an unbounded span.

- [ ] **Step 1: Write the failing tests**

```ts
it('fires when a member exceeds the rate, and not before', () => {
  const compiled = compile('{"maxMessages":3,"windowMs":10000}');
  const at = (ms: number) => message('anything', { atMs: ms, messageId: `m${String(ms)}` });
  expect(compiled.evaluate(at(1_000))).toBeUndefined();
  expect(compiled.evaluate(at(2_000))).toBeUndefined();
  expect(compiled.evaluate(at(3_000))).toBeUndefined();
  // The fourth inside the window is one too many.
  expect(compiled.evaluate(at(4_000))).toBeDefined();
});

it('forgets messages that fall out of the window', () => {
  // The ambiguity a single burst cannot show: the same four messages spread
  // beyond the window must NOT fire, so an implementation that never prunes
  // goes red here while passing the test above.
  const compiled = compile('{"maxMessages":3,"windowMs":10000}');
  const at = (ms: number) => message('anything', { atMs: ms, messageId: `m${String(ms)}` });
  expect(compiled.evaluate(at(1_000))).toBeUndefined();
  expect(compiled.evaluate(at(20_000))).toBeUndefined();
  expect(compiled.evaluate(at(40_000))).toBeUndefined();
  expect(compiled.evaluate(at(60_000))).toBeUndefined();
});

it('counts each member separately', () => {
  // Two members interleaved, neither exceeding the rate alone. An
  // implementation keyed on the rule only fires and goes red.
  const compiled = compile('{"maxMessages":3,"windowMs":10000}');
  for (const ms of [1_000, 2_000, 3_000, 4_000]) {
    expect(
      compiled.evaluate(
        message('x', { atMs: ms, authorId: ms % 2000 === 0 ? '111' : '222', messageId: `a${String(ms)}` }),
      ),
    ).toBeUndefined();
  }
});

it('does not count an edit as a new message (ruling PR-23)', () => {
  // R-13 added eventKind a slice early for exactly this. A member fixing a
  // typo three times must not trip a rate rule.
  const compiled = compile('{"maxMessages":2,"windowMs":10000}');
  expect(compiled.evaluate(message('x', { atMs: 1_000, messageId: 'm1' }))).toBeUndefined();
  for (const ms of [1_100, 1_200, 1_300, 1_400]) {
    expect(
      compiled.evaluate(
        message('x', { atMs: ms, messageId: 'm1', eventKind: 'messageUpdate' }),
      ),
    ).toBeUndefined();
  }
});
```

- [ ] **Step 2: Watch them fail.**
- [ ] **Step 3: Implement it.** `compile` creates the store (its capacity from
  `config.maxMessages`, so the buffer is exactly as big as the rule can ask
  for); `evaluate` returns early on `eventKind !== 'messageCreate'` (PR-23),
  records, counts, and matches when the count exceeds `maxMessages`. Comment
  that **a config edit resets the window** because the fingerprint changes and
  the artifact is rebuilt (PR-21) — correct behaviour, and it reads as a bug
  without the comment.
- [ ] **Step 4: Register, run, break two guards.** (a) Never prune → the
  "forgets messages" test goes red. (b) Drop the `eventKind` guard → the edit
  test goes red. Restore both; report.
- [ ] **Step 5: Gates and commit.**

---

### Task 4: `duplicate_message`

**Files:** Create `predicates/duplicate-message.ts` + `.test.ts`; modify
`registry.ts`.

**Consumes:** Task 1's `createWindowStore` (`countMatching`).

**Read plan ruling PR-20 before you start.** The spec says to reuse the keyword
matcher's normalisation; that is **not achievable** and the ruling records the
two verified reasons. You are writing a named, exported normaliser that imports
`stripZeroWidth` and adds lowercase plus whitespace collapse. **Do not deep-import
anything from `obscenity/dist`.** Put PR-20's reasoning in the function's doc
comment — a future reader comparing the code to the spec must find the answer
there.

Config: `{ maxRepeats: number, windowMs: number, minLength?: number }`, with
**`minLength` defaulting to 0** — i.e. no floor unless the operator sets one, so
the schema's default cannot silently suppress matches an operator expects. Say
that in the schema's comment. A floor still matters and operators should use
one: `"ok"` posted three times is not spam, and with `minLength: 0` this
predicate does fire on ordinary short replies. The default is 0 because a
non-zero default would be this plan quietly choosing a false-negative rate on
the operator's behalf, in the tier whose gate is a false-positive rate.

- [ ] **Step 1: Write the failing tests**

```ts
it('fires on the same text repeated within the window', () => {
  const compiled = compile('{"maxRepeats":2,"windowMs":30000,"minLength":5}');
  const say = (ms: number, text: string) =>
    compiled.evaluate(message(text, { atMs: ms, messageId: `m${String(ms)}` }));
  expect(say(1_000, 'buy crypto now')).toBeUndefined();
  expect(say(2_000, 'buy crypto now')).toBeUndefined();
  expect(say(3_000, 'buy crypto now')).toBeDefined();
});

it('does not count different messages toward the repeat', () => {
  // The ambiguity: three messages, only two identical, so an implementation
  // that counted every message (a rate rule by mistake) goes red.
  const compiled = compile('{"maxRepeats":2,"windowMs":30000,"minLength":5}');
  const say = (ms: number, text: string) =>
    compiled.evaluate(message(text, { atMs: ms, messageId: `m${String(ms)}` }));
  expect(say(1_000, 'buy crypto now')).toBeUndefined();
  expect(say(2_000, 'a totally different message')).toBeUndefined();
  expect(say(3_000, 'buy crypto now')).toBeUndefined();
});

it('treats case and spacing differences as the same message', () => {
  const compiled = compile('{"maxRepeats":1,"windowMs":30000,"minLength":5}');
  const say = (ms: number, text: string) =>
    compiled.evaluate(message(text, { atMs: ms, messageId: `m${String(ms)}` }));
  expect(say(1_000, 'buy crypto now')).toBeUndefined();
  expect(say(2_000, 'BUY   Crypto  NOW')).toBeDefined();
});

it('ignores a zero-width character inserted to evade it', () => {
  // stripZeroWidth is the one normalisation shared with the matcher (PR-20),
  // and this is what it buys.
  const compiled = compile('{"maxRepeats":1,"windowMs":30000,"minLength":5}');
  const say = (ms: number, text: string) =>
    compiled.evaluate(message(text, { atMs: ms, messageId: `m${String(ms)}` }));
  expect(say(1_000, 'buy crypto now')).toBeUndefined();
  expect(say(2_000, 'buy​crypto​now')).toBeDefined();
});

it('does not fire below the minimum length', () => {
  const compiled = compile('{"maxRepeats":1,"windowMs":30000,"minLength":10}');
  const say = (ms: number, text: string) =>
    compiled.evaluate(message(text, { atMs: ms, messageId: `m${String(ms)}` }));
  expect(say(1_000, 'ok')).toBeUndefined();
  expect(say(2_000, 'ok')).toBeUndefined();
  expect(say(3_000, 'ok')).toBeUndefined();
});
```

Note the third test as written expects `'buy crypto now'` and
`'BUY   Crypto  NOW'` to normalise alike — **check that against your
normaliser**: whitespace collapse must run before comparison, not only trimming.
If the test and the code disagree, say which you changed.

- [ ] **Step 2: Watch them fail.**
- [ ] **Step 3: Implement it**, including the exported normaliser with PR-20's
  reasoning. `matchedOn` names the threshold, not the message text — the content
  is a member-controlled string and ADR 0041 §4 keeps whole-message content out
  of the trace. `detail` may carry the repeat count and the normalised length,
  **not** the normalised text.
- [ ] **Step 4: Register, run, break two guards.** (a) Count every message
  rather than matching ones → the "different messages" test goes red. (b) Drop
  `stripZeroWidth` → the zero-width test goes red. Restore; report.
- [ ] **Step 5: Gates and commit.**

---

### Task 5a: the registry seam (obligation 3) — runs FIRST in dispatch B

**Files:** `predicates/registry.ts`, `predicates/registry.test.ts`,
`packages/core/src/ops/commands/reads.test.ts`,
`apps/daemon/src/automod.integration.test.ts`.

`compileRule` reports `no-predicate` for a permitted kind whose predicate has not
shipped. **After this slice all ten kinds have one**, and `resolveConfig` checks
`isRuleKind` *first*, so a made-up string yields `unknown-kind`, never
`no-predicate`. **No cast can reach that branch.**

Four tests currently stand a real-but-unshipped kind in for "unregistered", and
they have been repointed **three times** (`caps` → `mention_spam` →
`rapid_spam`). Each repoint was correct in isolation and the churn is the
problem: **a fixture whose validity expires on a schedule the test never
mentions.**

- [ ] **Step 1: Add the seam, keeping `no-predicate` genuinely tested**

Preferred shape — smallest change that survives the tenth predicate:

```ts
/**
 * `kind` → predicate, against an explicitly supplied registry.
 *
 * Exists so `no-predicate` stays testable after this slice, when every one of
 * the ten kinds `mod_rules_kind` permits has an implementation and no real
 * `RuleKind` value is left to stand for "not shipped yet". `resolveConfig`
 * checks `isRuleKind` first, so a made-up string yields `unknown-kind` — a
 * different failure, deliberately — and therefore no cast can reach the
 * `no-predicate` branch through the public entry points.
 *
 * The branch stays because an eleventh kind will arrive the way the tenth did:
 * ruling R-2 widened the SQL CHECK to all ten kinds *ahead* of their
 * predicates, precisely so a rule naming an unshipped kind was inert and loud
 * rather than silently non-matching. This is the seam that keeps that promise
 * under test instead of on trust.
 */
export const compileRuleWith = (
  registry: Partial<Record<RuleKind, AnyPredicate>>,
  rule: AutomodRule,
): CompileResult => { /* the current body of compileRule, reading `registry` */ };

/** The production entry point: `compileRuleWith` over the shipped registry. */
export const compileRule = (rule: AutomodRule): CompileResult =>
  compileRuleWith(PREDICATES, rule);
```

Do the same for `validateRuleConfig` if `no-predicate` is reachable through it —
check, do not assume.

**If this cannot be done without changing `registry.ts`'s public shape in a way
you would not want to live with, take the alternative instead:** delete the four
assertions and add a comment at the `no-predicate` branch recording that it is
unreachable until an eleventh kind exists, and why it stays. **Say which you
chose and why.** What is *not* acceptable is leaving those four tests passing
against a kind that is now registered — that is a decorative guard by
construction, and it is the specific thing this obligation exists to prevent.

- [ ] **Step 2: Repoint the four tests at the seam, not at another real kind**

`registry.test.ts` ×3, `reads.test.ts`, `automod.integration.test.ts` — use
`compileRuleWith({}, rule)` (an empty registry) so the test states its own
premise instead of borrowing a kind that is about to ship. **After this, no test
in the repository depends on any kind being unregistered.** Confirm that with
`rg` over the test files and say so.

- [ ] **Step 3: Watch it fail.** Make `resolveConfig` return `no-predicate`
  before its `isRuleKind` check and confirm a test distinguishing
  `unknown-kind` from `no-predicate` goes red — the two failures must stay
  distinguishable, because `doctor` renders them differently. Restore.

- [ ] **Step 4: Gates and commit.**

---

### Task 5b: close the gate's two blind spots

**Files:** Modify `packages/core/src/automod/dry-run.test.ts`;
`predicates/registry.test.ts`; `packages/core/src/ops/commands/reads.test.ts`.

This task carries **obligations 1 and 3** of the handoff. Read both in
`docs/reports/release2-slice-4-handoff.md` before starting.

#### Obligation 1 — the behavioural gate must compare a *sequence*

The one-code-path gate compares the live subscriber against `runDryRun`. It is
behavioural, so it only sees divergence in fields a shipped predicate reads.
Slice 3+5 widened it to `attachments`. **Two blind spots remain and both go live
in this slice:** a wrong `atMs`, and a bypassed predicate cache (no observable
difference while every predicate was stateless).

**Read ruling PR-25 below before writing either case.** The first draft of this
task specified two "break it" exercises and **neither could have gone red**; the
plan review caught both. The principle they violated is the one thing to
understand here.

- [ ] **Step 1: Add *two* sequence cases to `dry-run.test.ts`**

Follow the file's existing shape — it drives a real `createAutomodSubscriber`
and compares against `runDryRun`, rather than calling `evaluateRule` directly.
Both cases use a `rapid_spam` rule with a 10 000 ms window and
`maxMessages: 3`.

**Case A — a burst that matches on both paths.** Four messages/fixtures
clustered inside the window (`1_000, 2_000, 3_000, 4_000`). Assert both paths
match, and **assert which message matched**, not merely that something did — a
comparison of two identical nothings passes under every implementation, which is
the trap Slice 3+5's gate had to be rescued from.

**Case B — a sequence spread beyond the window, matching on neither path.**
`1_000, 20_000, 40_000, 60_000` against the 10 000 ms window: each message ages
out before the next arrives, so the correct answer on both paths is **no match
anywhere**. This is the case that makes the clock visible, and it is the *only*
shape that can — see PR-25.

- [ ] **Step 2: Prove the gate catches both blind spots**

This is the whole point of the task. Do both, and report both halves.

1. **Wrong clock — corrupt the fixture branch only.** In
   `predicateInputFrom`'s fixture branch, replace `atMs: fixture.createdAt`
   with `atMs: Date.now()`. **Case B must go red.** `runDryRun` processes
   fixtures in a tight synchronous loop, so four `Date.now()` calls land within
   microseconds of each other — the replay's four events all cluster inside one
   window and wrongly report a match at the fourth, while the live path
   (untouched, using `event.receivedAtMs`) correctly reports none. Case A must
   stay **green**, because clustered timestamps are what Case A already has.
   The pre-existing content-only gates must also stay green.
2. **Bypassed cache — corrupt the *subscriber*, never `evaluateRule`.** Wire the
   test subscriber so each `handle()` call uses a throwaway
   `createPredicateCache()` instead of the instance-held one. **Case A must go
   red:** the live side never accumulates window state so it never reaches four,
   while the replay's correctly-reused cache does. **Do not corrupt
   `evaluateRule` or `compileRule`** — see PR-25.

Restore both. **If either case stays green, say so loudly** — the obligation is
then unmet, and the coordinator needs to know before the slice closes rather
than after.

- [ ] **Step 3: Gates and commit.** Confirm in your report that
  `predicateFor` now returns a predicate for **all ten** kinds, read from
  `PREDICATES` with `rg` rather than assumed — and that no test anywhere still
  depends on a kind being unregistered (Task 5a should already have ended that).

**Obligation 3 is Task 5a, not this task**, and it runs at the *start* of
dispatch B. It was moved there because its four placeholder tests had already
been repointed three times and `rapid_spam` — dispatch B's own predicate —
would have forced a fourth.

---

## Self-review — spec coverage

| Spec requirement | Task |
| --- | --- |
| `mention_spam` | 2 |
| `rapid_spam` | 3 |
| `duplicate_message` | 4 |
| In-memory counters keyed `(guildId, memberId, ruleId)` | 1 |
| Bounded ring buffer with an eviction sweep | 1 (PR-22) |
| A restart resets the window, accepted and documented | 1, 3 (PR-21) |
| The key is guild-scoped in its own right | 1 |
| `duplicate_message` normalisation shared with the matcher | 4 — **not achievable as written; PR-20 records why and what ships instead** |
| Obligation 1: the behavioural gate reaches `atMs` and the cache | 5b |
| Obligation 3: the `no-predicate` seam | **5a — moved to the start of dispatch B**, because its placeholder tests had been repointed three times and `rapid_spam` would have forced a fourth |
| Obligation 4: break every guard | all |

**Deliberate deviation:** PR-20. Nothing else in the spec's Slice 4 is
unimplemented by this plan.
