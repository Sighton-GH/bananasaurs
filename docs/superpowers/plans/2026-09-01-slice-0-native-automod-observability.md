# Slice 0 — Native AutoMod observability, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every decision Discord's native AutoMod makes as a durable, reviewable moderation case event, so native's unpublished algorithms become observable and feed the same false-positive review as our own rules.

**Architecture:** A new `DomainEvent` kind (`autoModerationAction`) flows through the existing gateway-translation → pipeline → subscriber → repository path that `MESSAGE_CREATE` already uses. The subscriber only *records* — it makes no Discord calls, so it does not pass through `ModerationActionGateway` and is not subject to dry run. Case events land under the reserved sentinel `rule_id = 'native:<discord_rule_id>'` with `countsAsViolation: false`.

**Tech Stack:** TypeScript (Node 22, strict, `exactOptionalPropertyTypes`) · discord.js v14 · better-sqlite3 + Drizzle · Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md` §3 Slice 0
**ADR:** `docs/decisions/0038-native-automod-is-a-collaborator-and-its-decisions-are-recorded.md`

## Global Constraints

- **Guild scope is a mandatory partition key** (CLAUDE.md rule 2). Every repository signature takes a `GuildScope`. Subscribers close over one scope and never read `event.guildId` themselves (ADR 0020); the composition root wraps them in `scopedTo`.
- **`packages/core` may never import `@bananasaurs/storage`** (ADR 0014). Core declares port interfaces; `apps/daemon/src/**/wiring.ts` binds them to repos.
- **Durable idempotency** (rule 6). Gateway events replay on reconnect; assume it.
- **The payload is untrusted input** (rule 3) and crosses a Zod validator on arrival.
- **No AI, no provider call, no new outbound destination** anywhere in this slice.
- **`exactOptionalPropertyTypes` is on.** An optional property set to literal `undefined` is *not* the same as absent. Use the conditional-spread idiom (`...(x !== undefined && { x })`) seen throughout `apps/daemon/src/automod/wiring.ts`.
- **New tables must be `STRICT`.** `npm run db:generate` runs `scripts/strictify.mjs` for this; never hand-edit a generated migration to add it.
- Before any task is complete: `npm run typecheck && npm run lint && npm run test` all clean.

## Explicitly not in this slice

- **The native-overlap disclosure flag on `mod_rules`.** ADR 0038 requires a rule
  whose category overlaps a *blocking* native rule to be marked, so its
  observe-window numbers are never read as a clean rate. That column lands with
  the other `mod_rules` columns in Slice 6 rather than as its own table rebuild
  here, and the false-positive review screen that renders it is Slice 9.
- **Managing native AutoMod rules through the REST API.** This slice reads
  native's decisions and writes nothing back. ADR 0038 leaves authoring native
  rules open deliberately; it is not needed to close Release 2.
- **Any change to `apps/daemon/src/runtime/doctor.ts`.** `AutoModerationExecution`
  is not privileged, and `doctor`'s `PRIVILEGED` array exists only for the two
  intents Discord can grant in code and silently withhold on the wire.

## File structure

**Create**
- `packages/core/src/automod/native-subscriber.ts` — the recording subscriber, ports only
- `packages/core/src/automod/native-subscriber.test.ts`
- `apps/daemon/src/automod/native-wiring.ts` — composition-root deps binding
- `apps/daemon/src/native-automod.integration.test.ts` — gateway → DB
- `drizzle/0009_<generated>.sql` — CHECK widening (generated, never hand-written)

**Modify**
- `packages/core/src/discord/events.ts` — add `AutoModerationEvent`, extend the `DomainEvent` union
- `packages/core/src/index.ts` — re-export the new type
- `packages/core/src/pipeline/fingerprint.ts` + `.test.ts` — the dedupe case
- `packages/discord/src/client.ts` + `.test.ts` — the intent
- `packages/discord/src/events.ts` — listener and translator
- `packages/storage/src/schema.ts` — widen the `mod_case_events_action_taken` CHECK
- `packages/storage/src/repos/mod-cases.ts` — widen `ModCaseActionTaken`
- `packages/testkit/src/fake-discord.ts` — `emitAutoModerationAction`
- `apps/daemon/src/runtime/guild.ts:580-601` — register the subscriber

---

### Task 1: The domain event and its fingerprint

**Files:**
- Modify: `packages/core/src/discord/events.ts` (add interface; extend union at the `DomainEvent` declaration)
- Modify: `packages/core/src/index.ts` (re-export, alongside `MessageEvent` etc.)
- Modify: `packages/core/src/pipeline/fingerprint.ts:68-113`
- Test: `packages/core/src/pipeline/fingerprint.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AutoModerationEvent` (below), added to `DomainEvent`. Tasks 2, 4, 5 and 6 all construct this shape.

Discord's numeric enums are mapped to string unions *at the adapter* (Task 2), so `packages/core` never carries Discord enum values. Verified against `discord-api-types` v10 in this repo's lockfile: `AutoModerationActionType` is `BlockMessage=1, SendAlertMessage=2, Timeout=3, BlockMemberInteraction=4`; `AutoModerationRuleTriggerType` is `Keyword=1, Spam=3, KeywordPreset=4, MentionSpam=5, MemberProfile=6`.

- [ ] **Step 1: Add the event interface**

In `packages/core/src/discord/events.ts`, after `MessageEvent`:

```ts
/** Which action Discord's own AutoMod executed. */
export type NativeAutoModAction = 'block' | 'alert' | 'timeout' | 'block_interaction';

/** Which kind of native rule fired. `unknown` covers enum values Discord adds later. */
export type NativeAutoModTrigger =
  | 'keyword'
  | 'spam'
  | 'keyword_preset'
  | 'mention_spam'
  | 'member_profile'
  | 'unknown';

/**
 * Discord's own AutoMod acted (ADR 0038). Bananasaurs records this; it never
 * acts on it. Native blocks *before* the message exists, so no `messageCreate`
 * is dispatched for blocked content and our own subscriber never sees it —
 * this event is the only way that decision is observable.
 */
export interface AutoModerationEvent extends Base {
  kind: 'autoModerationAction';
  /** Discord's AutoMod rule id. Never one of our own `mod_rules.rule_id`s. */
  ruleId: Snowflake;
  triggerType: NativeAutoModTrigger;
  /** The member whose content triggered the rule. */
  userId: Snowflake;
  actionType: NativeAutoModAction;
  /** Absent when the content was not part of a channel message. */
  channelId: Snowflake | undefined;
  /**
   * Absent exactly when AutoMod *blocked* the message — the common case here,
   * since a blocking rule is why we hear about it at all. Never flattened to a
   * string: `undefined` means "there is no message", not "the id is empty".
   */
  messageId: Snowflake | undefined;
  /** Present only for the `alert` action: the id of the log message it posted. */
  alertMessageId: Snowflake | undefined;
  /** Requires `MESSAGE_CONTENT`, which this bot holds. Empty string if not. */
  content: string;
  /** The rule's configured word that matched, when Discord names one. */
  matchedKeyword: string | undefined;
  /** The substring of `content` that matched. Requires `MESSAGE_CONTENT`. */
  matchedContent: string | undefined;
}
```

Then add `| AutoModerationEvent` to the `DomainEvent` union.

- [ ] **Step 2: Run typecheck — and note that it PASSES, which is the bug**

Run: `npm run typecheck`
Expected: **clean.**

> **Corrected during execution.** This step originally predicted a `TS2366`
> failure, on the claim that `fingerprintOf`'s `switch` was a compile-enforced
> gate over `DomainEvent.kind`. It is not. Falling off the end of a function
> returning `string | undefined` is legal, and `tsconfig.base.json` does not set
> `noImplicitReturns` (it sets `strict`, `exactOptionalPropertyTypes` and
> `noFallthroughCasesInSwitch`). Verified both ways with an isolated repro:
> exit 0 without the flag, `TS7030` with it.
>
> So a new `DomainEvent` kind silently becomes level-triggered — "not
> deduplicated" — instead of failing loudly. That is an idempotency gap
> (CLAUDE.md rule 6) that nothing surfaces. Step 5a below builds the gate this
> step assumed already existed.

- [ ] **Step 3: Write the failing fingerprint tests**

In `packages/core/src/pipeline/fingerprint.test.ts`, following the existing per-kind assertions:

```ts
const nativeEvent = (over: Partial<AutoModerationEvent> = {}): AutoModerationEvent => ({
  kind: 'autoModerationAction',
  guildId: '111111111111111111',
  receivedAtMs: 1_700_000_000_000,
  ruleId: '222222222222222222',
  triggerType: 'keyword',
  userId: '333333333333333333',
  actionType: 'block',
  channelId: '444444444444444444',
  messageId: undefined,
  alertMessageId: undefined,
  content: 'a forbidden word',
  matchedKeyword: 'forbidden',
  matchedContent: 'forbidden',
  ...over,
});

describe('autoModerationAction fingerprints', () => {
  it('uses the alert message id when Discord supplies one', () => {
    const a = nativeEvent({ actionType: 'alert', alertMessageId: '555555555555555555' });
    const b = nativeEvent({
      actionType: 'alert',
      alertMessageId: '555555555555555555',
      // A replay carries the same ids but is observed later; the later
      // observation must not create a second fingerprint.
      receivedAtMs: 1_700_000_090_000,
      content: 'different text entirely',
    });
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it('uses the message id when the action did not block', () => {
    const a = nativeEvent({ actionType: 'timeout', messageId: '666666666666666666' });
    const b = nativeEvent({
      actionType: 'timeout',
      messageId: '666666666666666666',
      receivedAtMs: 1_700_000_090_000,
    });
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it('separates two actions on the same message', () => {
    // One rule with both an alert and a timeout action produces two dispatches
    // carrying the same message id. They are two real events, not a replay.
    const alert = nativeEvent({ actionType: 'alert', messageId: '666666666666666666' });
    const timeout = nativeEvent({ actionType: 'timeout', messageId: '666666666666666666' });
    expect(fingerprintOf(alert)).not.toBe(fingerprintOf(timeout));
  });

  it('falls back to a content fingerprint when the message was blocked', () => {
    // No message id and no alert id: this is the common case, and the only
    // available identity is what was matched, by whom, under which rule.
    const a = nativeEvent();
    const b = nativeEvent({ receivedAtMs: 1_700_000_000_500 });
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it('treats a blocked repeat outside the bucket as a new event', () => {
    const a = nativeEvent();
    const b = nativeEvent({ receivedAtMs: 1_700_000_000_000 + 60_000 });
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(b));
  });

  it('separates different members saying the same thing', () => {
    const a = nativeEvent();
    const b = nativeEvent({ userId: '777777777777777777' });
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(b));
  });

  it('is never level-triggered', () => {
    expect(fingerprintOf(nativeEvent())).toBeDefined();
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/pipeline/fingerprint.test.ts`
Expected: FAIL — the file does not compile, for the same `TS2366` reason as Step 2.

- [ ] **Step 5: Add the fingerprint case**

In `packages/core/src/pipeline/fingerprint.ts`, inside the `switch`, before the `return undefined` group:

```ts
    case 'autoModerationAction': {
      // Discord sends no event id and no timestamp for this dispatch, and
      // `message_id` "will not be present if message was blocked by AutoMod"
      // — the common case, since every native rule in this guild blocks
      // (ADR 0038). Prefer whichever id Discord did supply; otherwise fall
      // back to what was matched, by whom, under which rule, in the same
      // coarse bucket `memberRemove` already uses for the same reason.
      //
      // The accepted trade-off: two byte-identical blocked messages from one
      // member inside the bucket collapse into one event. That under-counts a
      // repeat offender in the review queue rather than risking a replayed
      // dispatch being recorded twice — and since native events never count
      // toward escalation, an under-count costs nothing in enforcement.
      const discordId = event.alertMessageId ?? event.messageId;
      if (discordId !== undefined) return digest(event.kind, discordId, event.actionType);
      return digest(
        event.kind,
        event.ruleId,
        event.userId,
        event.actionType,
        event.content,
        Math.floor(event.receivedAtMs / FALLBACK_BUCKET_MS),
      );
    }
```

- [ ] **Step 5a: Build the exhaustiveness gate Step 2 assumed existed**

Add an explicit `default` clause to `fingerprintOf` asserting `never`, so that
adding a `DomainEvent` kind without deciding its dedupe behaviour is a compile
error rather than a silent fallback to "not deduplicated":

```ts
    default: {
      // Not reachable: every `DomainEvent` kind above returns. This clause
      // exists so that *adding* a kind without deciding its dedupe behaviour
      // is a compile error rather than a silent fallback to "not
      // deduplicated" — an idempotency gap (CLAUDE.md rule 6) nothing else
      // surfaces. `strict` alone does not catch it: falling off the end of a
      // `string | undefined` function is legal, and `noImplicitReturns` is
      // not set. Do not delete this as dead code; being unreachable is the
      // point.
      const unhandled: never = event;
      void unhandled;
      return undefined;
    }
```

Verify the gate actually holds: temporarily add a throwaway member to the
`DomainEvent` union, confirm `npm run typecheck` now FAILS at the `never`
assignment, then remove it and confirm typecheck is clean again. The throwaway
is a verification step, never a commit.

Do **not** enable `noImplicitReturns` repo-wide here — it would close the same
class of gap everywhere, and is worth doing, but its blast radius is every
package and this slice is about native AutoMod observability.

- [ ] **Step 6: Re-export the type**

In `packages/core/src/index.ts`, add `AutoModerationEvent`, `NativeAutoModAction` and `NativeAutoModTrigger` to the existing `export type { ... } from './discord/events.js'` block that already names `MessageEvent`.

- [ ] **Step 7: Run typecheck and the tests**

Run: `npm run typecheck && npx vitest run packages/core/src/pipeline/fingerprint.test.ts`
Expected: typecheck clean; all seven new tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/discord/events.ts packages/core/src/index.ts packages/core/src/pipeline/fingerprint.ts packages/core/src/pipeline/fingerprint.test.ts
git commit -m "feat(core): add the autoModerationAction domain event and its fingerprint"
```

---

### Task 2: The intent and the gateway translation

**Files:**
- Modify: `packages/discord/src/client.ts:32-39` (`REQUIRED_INTENTS`)
- Modify: `packages/discord/src/client.test.ts`
- Modify: `packages/discord/src/events.ts` (listener beside the `// --- messages ---` block; translator beside `toMessageEvent`)
- Test: `packages/discord/src/events.test.ts`

**Interfaces:**
- Consumes: `AutoModerationEvent` from Task 1.
- Produces: a `client.on(Events.AutoModerationActionExecution, …)` listener emitting that event. Task 5's integration test relies on nothing from this file (it drives `FakeDiscord` directly), so this task is independently verifiable.

`GatewayIntentBits.AutoModerationExecution` is `2097152` (bit 21) and is **not privileged** — confirmed at runtime against this repo's installed discord.js. No Developer Portal toggle, and therefore no change to `apps/daemon/src/runtime/doctor.ts`, whose `PRIVILEGED` array covers only the two intents Discord can silently withhold.

- [ ] **Step 1: Write the failing intent test**

In `packages/discord/src/client.test.ts`, beside the existing `REQUIRED_INTENTS` assertions:

```ts
it('requests the auto-moderation execution intent', () => {
  expect(REQUIRED_INTENTS).toContain(GatewayIntentBits.AutoModerationExecution);
});

it('does not treat auto-moderation execution as privileged', () => {
  // It needs no Developer Portal toggle, so `doctor` must not report it as a
  // grant that could be silently withheld.
  expect(PRIVILEGED_INTENTS).not.toContain(GatewayIntentBits.AutoModerationExecution);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/discord/src/client.test.ts`
Expected: FAIL on the first test — `REQUIRED_INTENTS` does not contain `2097152`.

- [ ] **Step 3: Add the intent**

In `packages/discord/src/client.ts`, add to `REQUIRED_INTENTS`:

```ts
  GatewayIntentBits.AutoModerationExecution, // native AutoMod decisions (ADR 0038) — not privileged
```

Do not touch `PRIVILEGED_INTENTS`. `assertClientOptions` already loops over `REQUIRED_INTENTS` generically, so it enforces the new bit with no further change.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/discord/src/client.test.ts`
Expected: PASS. If another test asserts an exact intent count or an exact array, update it to match the six-plus-one set.

- [ ] **Step 5: Write the failing translator test**

In `packages/discord/src/events.test.ts`, following the shape of the existing `messageCreate` translation tests:

```ts
it('translates a blocked auto-moderation execution', () => {
  const emitted: DomainEvent[] = [];
  const client = fakeClient();
  attachGatewayTranslation(client, {
    now: () => 1_700_000_000_000,
    isGuildAllowed: () => true,
    emit: (e) => void emitted.push(e),
    onError: () => undefined,
  });

  client.trigger(Events.AutoModerationActionExecution, {
    guild: { id: '111111111111111111' },
    ruleId: '222222222222222222',
    ruleTriggerType: 1, // Keyword
    userId: '333333333333333333',
    action: { type: 1 }, // BlockMessage
    channelId: '444444444444444444',
    messageId: null, // blocked: Discord omits it
    alertSystemMessageId: null,
    content: 'a forbidden word',
    matchedKeyword: 'forbidden',
    matchedContent: 'forbidden',
  });

  expect(emitted).toEqual([
    {
      kind: 'autoModerationAction',
      guildId: '111111111111111111',
      receivedAtMs: 1_700_000_000_000,
      ruleId: '222222222222222222',
      triggerType: 'keyword',
      userId: '333333333333333333',
      actionType: 'block',
      channelId: '444444444444444444',
      messageId: undefined,
      alertMessageId: undefined,
      content: 'a forbidden word',
      matchedKeyword: 'forbidden',
      matchedContent: 'forbidden',
    },
  ]);
});

it('maps an unrecognised trigger type to unknown rather than dropping the event', () => {
  const emitted: DomainEvent[] = [];
  const client = fakeClient();
  attachGatewayTranslation(client, {
    now: () => 1_700_000_000_000,
    isGuildAllowed: () => true,
    emit: (e) => void emitted.push(e),
    onError: () => undefined,
  });

  client.trigger(Events.AutoModerationActionExecution, {
    guild: { id: '111111111111111111' },
    ruleId: '222222222222222222',
    ruleTriggerType: 99, // a type Discord adds after this was written
    userId: '333333333333333333',
    action: { type: 1 },
    channelId: '444444444444444444',
    messageId: null,
    alertSystemMessageId: null,
    content: '',
    matchedKeyword: null,
    matchedContent: null,
  });

  expect(emitted).toHaveLength(1);
  expect((emitted[0] as AutoModerationEvent).triggerType).toBe('unknown');
});
```

Match the file's existing helper for faking a client — if it differs from `fakeClient()`/`trigger`, use whatever the neighbouring `messageCreate` tests use rather than introducing a second harness.

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run packages/discord/src/events.test.ts`
Expected: FAIL — nothing is emitted, because no listener is attached for this event.

- [ ] **Step 7: Add the listener and translator**

In `packages/discord/src/events.ts`, after the `// --- messages ---` block:

```ts
  // --- native auto-moderation (ADR 0038) ----------------------------------
  client.on(Events.AutoModerationActionExecution, (execution: AutoModerationActionExecution) => {
    translate('autoModerationAction', () => toAutoModerationEvent(execution, now()));
  });
```

And beside `toMessageEvent`:

```ts
/**
 * Discord's numeric enums are mapped to string unions here, at the adapter, so
 * `packages/core` never carries Discord enum values. An unrecognised value maps
 * to `'unknown'` rather than dropping the event: a decision we cannot name is
 * still a decision that happened, and ADR 0038 exists to record it.
 */
const ACTION_TYPES: Record<number, NativeAutoModAction> = {
  1: 'block',
  2: 'alert',
  3: 'timeout',
  4: 'block_interaction',
};

const TRIGGER_TYPES: Record<number, NativeAutoModTrigger> = {
  1: 'keyword',
  3: 'spam',
  4: 'keyword_preset',
  5: 'mention_spam',
  6: 'member_profile',
};

function toAutoModerationEvent(
  execution: AutoModerationActionExecution,
  receivedAtMs: number,
): DomainEvent | undefined {
  // No `if (!guildId) return undefined` guard here, unlike every other
  // translator in this file: `AutoModerationActionExecution.guild` is
  // non-nullable (`discord.js` typings), because Discord only fires this
  // dispatch for a guild. A guard would be dead code, and eslint's
  // no-unnecessary-condition would say so.
  const actionType = ACTION_TYPES[execution.action.type];
  // An action type we cannot name is dropped rather than guessed: unlike a
  // trigger type, the action is what the recorded vocabulary asserts happened,
  // and recording "something" would put a falsehood in the case history.
  if (actionType === undefined) return undefined;
  return {
    kind: 'autoModerationAction',
    guildId: execution.guild.id,
    receivedAtMs,
    ruleId: execution.ruleId,
    triggerType: TRIGGER_TYPES[execution.ruleTriggerType] ?? 'unknown',
    userId: execution.userId,
    actionType,
    channelId: execution.channelId ?? undefined,
    messageId: execution.messageId ?? undefined,
    alertMessageId: execution.alertSystemMessageId ?? undefined,
    content: execution.content,
    matchedKeyword: execution.matchedKeyword ?? undefined,
    matchedContent: execution.matchedContent ?? undefined,
  };
}
```

Import `AutoModerationActionExecution` from `discord.js` and the two union types from `@bananasaurs/core` alongside the existing type imports.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run packages/discord/ && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add packages/discord/src/client.ts packages/discord/src/client.test.ts packages/discord/src/events.ts packages/discord/src/events.test.ts
git commit -m "feat(discord): request the auto-moderation intent and translate its executions"
```

---

### Task 3: The recorded vocabulary and its migration

**Files:**
- Modify: `packages/storage/src/schema.ts:806-815` (the `mod_case_events_action_taken` CHECK)
- Modify: `packages/storage/src/repos/mod-cases.ts:45-76` (`ModCaseActionTaken`)
- Modify: `packages/core/src/automod/subscriber.ts:65-77` (`AutomodActionTaken`)
- Create: `drizzle/0009_<generated>.sql` (via `npm run db:generate`)
- Test: `packages/storage/src/repos/mod-cases.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: four new `ModCaseActionTaken` / `AutomodActionTaken` members — `'native_blocked'`, `'native_alerted'`, `'native_timeout'`, `'native_blocked_interaction'` — used by Tasks 4 and 5.

**The vocabulary lives in three hand-maintained places** and there is no shared import to keep them honest, because `packages/core` may not import `@bananasaurs/storage` (ADR 0014). A value added to two of the three fails at *runtime* on a CHECK violation, not at compile time. Step 1 exists to make that failure mode impossible to reach again.

- [ ] **Step 1: Write the failing lockstep test**

In `packages/storage/src/repos/mod-cases.test.ts`:

```ts
it('every action_taken value the union names is accepted by the CHECK', () => {
  // The union, the CHECK and core's mirror are three hand-maintained copies
  // (ADR 0014 forbids the shared import that would remove the duplication).
  // A value added to two of the three fails at runtime, not at compile time —
  // so this test walks every member of the union through a real insert.
  const scope = seedGuild();
  const opened = openOrResolveCase(scope, { memberId: MEMBER_ID, now: 1 });

  const all: ModCaseActionTaken[] = [
    'deleted', 'deleted_and_escalated', 'escalation_refused', 'escalation_failed',
    'escalation_dry_run', 'escalation_skipped', 'would_delete', 'delete_failed',
    'delete_blocked_killswitch', 'delete_blocked_breaker', 'delete_blocked_dry_run',
    'delete_blocked_guild_unknown', 'warned', 'note', 'evidence_added',
    'purged', 'purge_refused', 'purge_failed', 'manual_applied',
    'native_blocked', 'native_alerted', 'native_timeout', 'native_blocked_interaction',
  ];

  for (const actionTaken of all) {
    expect(() =>
      recordCaseEvent(scope, {
        eventId: `evt-${actionTaken}`,
        caseId: opened.caseId,
        ruleId: 'native:222222222222222222',
        memberId: MEMBER_ID,
        at: 1,
        matchedCategory: 'keyword',
        matchedSnippet: 'x',
        actionTaken,
      }),
    ).not.toThrow();
  }
});
```

Reuse whatever `seedGuild` / `MEMBER_ID` helpers the file already defines rather than inventing new ones.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/storage/src/repos/mod-cases.test.ts`
Expected: FAIL — TypeScript rejects the four `native_*` literals as not assignable to `ModCaseActionTaken`.

- [ ] **Step 3: Widen the two TypeScript unions**

In `packages/storage/src/repos/mod-cases.ts`, append to `ModCaseActionTaken`:

```ts
  /**
   * Native Discord AutoMod acted (ADR 0038). Recorded, never counted: these
   * carry `countsAsViolation: false`, because an algorithm nobody can inspect
   * must not increment the counter that drives our timeouts and bans.
   */
  | 'native_blocked'
  | 'native_alerted'
  | 'native_timeout'
  | 'native_blocked_interaction';
```

Append the same four members, with a one-line comment pointing at ADR 0038, to `AutomodActionTaken` in `packages/core/src/automod/subscriber.ts`.

- [ ] **Step 4: Widen the CHECK constraint**

In `packages/storage/src/schema.ts`, extend the `mod_case_events_action_taken` CHECK's `IN (…)` list with a new line:

```
        'native_blocked','native_alerted','native_timeout','native_blocked_interaction')
```

(keeping the existing values and closing the parenthesis on the new final line).

- [ ] **Step 5: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/0009_*.sql` plus its snapshot. SQLite cannot alter a CHECK in place, so drizzle-kit emits a full table rebuild — `PRAGMA foreign_keys=OFF` → `CREATE TABLE __new_mod_case_events (…) STRICT` → `INSERT … SELECT` → `DROP` → `RENAME` → `PRAGMA foreign_keys=ON`. This is exactly the shape migration `0008` took for ADR 0037's six values; if the generated file looks different, stop and read it before continuing.

Review the generated SQL and confirm `STRICT` is present on the rebuilt table. Never hand-edit it to add `STRICT` — `scripts/strictify.mjs` does that, and a hand edit will drift from the snapshot.

- [ ] **Step 6: Run the tests**

Run: `npm run typecheck && npx vitest run packages/storage/`
Expected: PASS, including the new lockstep test with all 23 values inserting cleanly.

- [ ] **Step 7: Commit**

```bash
git add packages/storage/src/schema.ts packages/storage/src/repos/mod-cases.ts packages/storage/src/repos/mod-cases.test.ts packages/core/src/automod/subscriber.ts drizzle/
git commit -m "feat(storage): record what native AutoMod did, with four additive action values"
```

---

### Task 4: The recording subscriber

**Files:**
- Create: `packages/core/src/automod/native-subscriber.ts`
- Test: `packages/core/src/automod/native-subscriber.test.ts`

**Interfaces:**
- Consumes: `AutoModerationEvent` (Task 1), the four `native_*` values (Task 3).
- Produces:
  ```ts
  export interface NativeAutomodSubscriberDeps {
    readonly logger: Logger;
    readonly openOrResolveCase: (
      memberId: string,
      options: { countsAsViolation: boolean },
    ) => { caseId: string };
    readonly recordCaseEvent: (input: {
      caseId: string;
      ruleId: string;
      memberId: string;
      matchedCategory: string;
      matchedSnippet: string;
      actionTaken: AutomodActionTaken;
    }) => void;
  }
  export const createNativeAutomodSubscriber:
    (deps: NativeAutomodSubscriberDeps) => Subscriber;
  ```
  Task 5 binds these ports to repos.

This subscriber makes **no Discord calls at all**. It therefore takes no `DiscordPort`, no `ModerationActionGateway` and no safety state: there is nothing for the kill switch or dry run to suppress, and suppressing a *record* of something Discord already did would make the log lie about the guild's history.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/automod/native-subscriber.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createNativeAutomodSubscriber } from './native-subscriber.js';
import type { AutoModerationEvent } from '../discord/events.js';

const silentLogger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
} as unknown as Parameters<typeof createNativeAutomodSubscriber>[0]['logger'];

const deps = () => {
  const recorded: unknown[] = [];
  const openOrResolveCase = vi.fn(() => ({ caseId: 'case-1' }));
  return {
    recorded,
    openOrResolveCase,
    subscriber: createNativeAutomodSubscriber({
      logger: silentLogger,
      openOrResolveCase,
      recordCaseEvent: (input) => void recorded.push(input),
    }),
  };
};

const event = (over: Partial<AutoModerationEvent> = {}): AutoModerationEvent => ({
  kind: 'autoModerationAction',
  guildId: '111111111111111111',
  receivedAtMs: 1_700_000_000_000,
  ruleId: '222222222222222222',
  triggerType: 'keyword',
  userId: '333333333333333333',
  actionType: 'block',
  channelId: '444444444444444444',
  messageId: undefined,
  alertMessageId: undefined,
  content: 'a forbidden word',
  matchedKeyword: 'forbidden',
  matchedContent: 'forbidden',
  ...over,
});

describe('native automod subscriber', () => {
  it('ignores every event kind but its own', async () => {
    const { subscriber, recorded } = deps();
    await subscriber.handle({
      kind: 'messageCreate',
      guildId: '111111111111111111',
      receivedAtMs: 1,
      channelId: '444444444444444444',
      messageId: '555555555555555555',
      authorId: '333333333333333333',
      authorIsBot: false,
      content: 'hello',
      editedTimestampMs: undefined,
    });
    expect(recorded).toEqual([]);
  });

  it('records a block under the native sentinel', async () => {
    const { subscriber, recorded } = deps();
    await subscriber.handle(event());
    expect(recorded).toEqual([
      {
        caseId: 'case-1',
        ruleId: 'native:222222222222222222',
        memberId: '333333333333333333',
        matchedCategory: 'keyword',
        matchedSnippet: 'forbidden',
        actionTaken: 'native_blocked',
      },
    ]);
  });

  it('never counts a native hit toward escalation', async () => {
    // ADR 0038: an algorithm nobody can inspect must not increment the counter
    // that drives our timeouts, kicks and bans.
    const { subscriber, openOrResolveCase } = deps();
    await subscriber.handle(event());
    expect(openOrResolveCase).toHaveBeenCalledWith('333333333333333333', {
      countsAsViolation: false,
    });
  });

  it.each([
    ['block', 'native_blocked'],
    ['alert', 'native_alerted'],
    ['timeout', 'native_timeout'],
    ['block_interaction', 'native_blocked_interaction'],
  ] as const)('maps the %s action to %s', async (actionType, expected) => {
    const { subscriber, recorded } = deps();
    await subscriber.handle(event({ actionType }));
    expect(recorded).toHaveLength(1);
    expect((recorded[0] as { actionTaken: string }).actionTaken).toBe(expected);
  });

  it('falls back to the matched content when Discord names no keyword', async () => {
    const { subscriber, recorded } = deps();
    await subscriber.handle(event({ matchedKeyword: undefined, matchedContent: 'forb1dden' }));
    expect((recorded[0] as { matchedSnippet: string }).matchedSnippet).toBe('forb1dden');
  });

  it('records an empty snippet rather than dropping the event when nothing matched', async () => {
    // A spam-triggered rule names neither a keyword nor a matched substring.
    // The decision still happened and is still worth recording.
    const { subscriber, recorded } = deps();
    await subscriber.handle(
      event({ triggerType: 'spam', matchedKeyword: undefined, matchedContent: undefined }),
    );
    expect(recorded).toHaveLength(1);
    expect((recorded[0] as { matchedSnippet: string }).matchedSnippet).toBe('');
    expect((recorded[0] as { matchedCategory: string }).matchedCategory).toBe('spam');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/core/src/automod/native-subscriber.test.ts`
Expected: FAIL — `Cannot find module './native-subscriber.js'`.

- [ ] **Step 3: Write the subscriber**

Create `packages/core/src/automod/native-subscriber.ts`:

```ts
import type { Subscriber } from '../pipeline/pipeline.js';
import type { Logger } from '../obs/logger.js';
import { safeLogFields } from '../obs/logger.js';
import type { AutoModerationEvent, NativeAutoModAction } from '../discord/events.js';
import type { AutomodActionTaken } from './subscriber.js';

/**
 * Records what Discord's own AutoMod did (ADR 0038).
 *
 * This subscriber makes **no Discord calls**. It therefore takes no
 * `DiscordPort`, no `ModerationActionGateway` and no safety state: there is
 * nothing for the kill switch or dry run to suppress, and suppressing a
 * *record* of something Discord already did would make the moderation log lie
 * about the guild's history. The kill switch stops side effects; this is an
 * observation.
 *
 * Every dependency arrives as a port, per ADR 0014 — this module never imports
 * `@bananasaurs/storage`.
 */

/** The reserved sentinel prefix, following ADR 0037's `manual` precedent. */
const NATIVE_RULE_PREFIX = 'native:';

const ACTION_TO_RECORDED: Record<NativeAutoModAction, AutomodActionTaken> = {
  block: 'native_blocked',
  alert: 'native_alerted',
  timeout: 'native_timeout',
  block_interaction: 'native_blocked_interaction',
};

export interface NativeAutomodSubscriberDeps {
  readonly logger: Logger;
  readonly openOrResolveCase: (
    memberId: string,
    options: { countsAsViolation: boolean },
  ) => { caseId: string };
  readonly recordCaseEvent: (input: {
    caseId: string;
    ruleId: string;
    memberId: string;
    matchedCategory: string;
    matchedSnippet: string;
    actionTaken: AutomodActionTaken;
  }) => void;
}

export const createNativeAutomodSubscriber = (deps: NativeAutomodSubscriberDeps): Subscriber => ({
  name: 'native-automod',
  handle: (event) => {
    if (event.kind !== 'autoModerationAction') return;
    const native: AutoModerationEvent = event;

    // `countsAsViolation: false` still opens or resolves the member's case, so
    // the observation is durably visible in history — it only leaves
    // `violation_count` alone (ADR 0036's mechanism, ADR 0038's reason).
    const { caseId } = deps.openOrResolveCase(native.userId, { countsAsViolation: false });

    deps.recordCaseEvent({
      caseId,
      ruleId: `${NATIVE_RULE_PREFIX}${native.ruleId}`,
      memberId: native.userId,
      matchedCategory: native.triggerType,
      // Discord names a keyword for keyword rules, a matched substring for
      // some others, and neither for spam. An empty snippet is honest; not
      // recording the event at all would lose a decision that really happened.
      matchedSnippet: native.matchedKeyword ?? native.matchedContent ?? '',
      actionTaken: ACTION_TO_RECORDED[native.actionType],
    });

    deps.logger.info(
      safeLogFields({
        event: 'native_automod_recorded',
        ruleId: native.ruleId,
        action: native.actionType,
        trigger: native.triggerType,
      }),
      'recorded a native AutoMod decision',
    );
  },
});
```

If `safeLogFields`'s allowlist rejects any of these field names, add them there deliberately — CLAUDE.md rule 4 makes redaction an allowlist, so a new field is a decision, not an oversight. Never log `content` or `matchedContent`: they are member-authored text.

- [ ] **Step 4: Export it from the package**

In `packages/core/src/index.ts`, beside the existing automod exports:

```ts
export { createNativeAutomodSubscriber } from './automod/native-subscriber.js';
export type { NativeAutomodSubscriberDeps } from './automod/native-subscriber.js';
```

Without this, Task 5's `apps/daemon/src/automod/native-wiring.ts` cannot import either name — `apps/daemon` consumes `@bananasaurs/core`'s public surface, never its internal paths.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/core/src/automod/native-subscriber.test.ts && npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/automod/native-subscriber.ts packages/core/src/automod/native-subscriber.test.ts packages/core/src/index.ts
git commit -m "feat(core): record native AutoMod decisions without counting them"
```

---

### Task 5: Wiring, the fake, and the end-to-end test

**Files:**
- Create: `apps/daemon/src/automod/native-wiring.ts`
- Modify: `packages/testkit/src/fake-discord.ts` (beside `emitMessageCreate`)
- Modify: `apps/daemon/src/runtime/guild.ts:580-601` (the `subscribers` array)
- Test: `apps/daemon/src/native-automod.integration.test.ts`

**Interfaces:**
- Consumes: `createNativeAutomodSubscriber` (Task 4), `AutoModerationEvent` (Task 1).
- Produces: `nativeAutomodPortsFor(scope, logger, now): NativeAutomodSubscriberDeps`; `FakeDiscord.emitAutoModerationAction(p)`.

- [ ] **Step 1: Add the fake's emitter**

In `packages/testkit/src/fake-discord.ts`, after `emitMessageCreate`:

```ts
  /**
   * AUTO_MODERATION_ACTION_EXECUTION (ADR 0038). Defaults describe the common
   * case: a keyword rule that *blocked* the message, so Discord supplies no
   * message id — which is exactly the case the fingerprint has to handle
   * without one.
   */
  async emitAutoModerationAction(p: {
    ruleId: Snowflake;
    userId: Snowflake;
    actionType?: NativeAutoModAction;
    triggerType?: NativeAutoModTrigger;
    channelId?: Snowflake;
    messageId?: Snowflake;
    alertMessageId?: Snowflake;
    content?: string;
    matchedKeyword?: string;
    matchedContent?: string;
  }): Promise<void> {
    await this.emit({
      kind: 'autoModerationAction',
      guildId: this.guildId,
      receivedAtMs: this.clock,
      ruleId: p.ruleId,
      triggerType: p.triggerType ?? 'keyword',
      userId: p.userId,
      actionType: p.actionType ?? 'block',
      channelId: p.channelId,
      messageId: p.messageId,
      alertMessageId: p.alertMessageId,
      content: p.content ?? '',
      matchedKeyword: p.matchedKeyword,
      matchedContent: p.matchedContent,
    });
  }
```

- [ ] **Step 2: Write the wiring**

Create `apps/daemon/src/automod/native-wiring.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Logger, NativeAutomodSubscriberDeps } from '@bananasaurs/core';
import { type GuildScope, modCaseRepo } from '@bananasaurs/storage';

/**
 * Binds the native-AutoMod subscriber's ports to repositories (ADR 0038).
 *
 * Deliberately narrower than `automodPortsFor`: this subscriber performs no
 * Discord writes, so it needs no `DiscordPort`, no gateway and no safety
 * state.
 */
export const nativeAutomodPortsFor = (
  scope: GuildScope,
  logger: Logger,
  now: () => number,
): NativeAutomodSubscriberDeps => ({
  logger,
  openOrResolveCase: (memberId, options) =>
    modCaseRepo.openOrResolveCase(scope, {
      memberId,
      now: now(),
      countsAsViolation: options.countsAsViolation,
    }),
  recordCaseEvent: (input) =>
    modCaseRepo.recordCaseEvent(scope, {
      eventId: randomUUID(),
      at: now(),
      caseId: input.caseId,
      ruleId: input.ruleId,
      memberId: input.memberId,
      matchedCategory: input.matchedCategory,
      matchedSnippet: input.matchedSnippet,
      actionTaken: input.actionTaken,
    }),
});
```

Match the import style of `apps/daemon/src/automod/wiring.ts` exactly — if it imports repos individually rather than as `modCaseRepo`, follow that.

- [ ] **Step 3: Register the subscriber**

In `apps/daemon/src/runtime/guild.ts`, build the ports beside where `automodPorts` is built (~line 278), then add to the `subscribers` array (~line 580-601):

```ts
    createNativeAutomodSubscriber(nativeAutomodPorts),
```

It needs no `scopedTo` of its own — `daemon.ts:202-204` wraps every entry of every guild runtime's `subscribers` array already (ADR 0020).

- [ ] **Step 4: Write the failing integration test**

Create `apps/daemon/src/native-automod.integration.test.ts`, copying the harness shape from `apps/daemon/src/automod.integration.test.ts:61-142` (`buildPipeline`, `discord.onEvent(async (event) => { await pipeline.dispatch(event); })`, and its `findCase` helper reading `schema.modCases` directly):

```ts
it('records a native block as a case event under the native sentinel', async () => {
  await discord.emitAutoModerationAction({
    ruleId: '222222222222222222',
    userId: MEMBER_ID,
    matchedKeyword: 'forbidden',
    content: 'a forbidden word',
  });

  const events = listCaseEvents(MEMBER_ID);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    ruleId: 'native:222222222222222222',
    actionTaken: 'native_blocked',
    matchedCategory: 'keyword',
    matchedSnippet: 'forbidden',
    actorId: null,
  });
});

it('leaves the violation counter at zero', async () => {
  await discord.emitAutoModerationAction({ ruleId: '222222222222222222', userId: MEMBER_ID });
  await discord.emitAutoModerationAction({ ruleId: '222222222222222222', userId: MEMBER_ID,
    content: 'a different forbidden word' });

  expect(findCase(MEMBER_ID)?.violationCount).toBe(0);
});

it('makes no Discord calls at all', async () => {
  discord.resetCalls();
  await discord.emitAutoModerationAction({ ruleId: '222222222222222222', userId: MEMBER_ID });
  expect(discord.restCalls()).toEqual([]);
});

it('records only once when the gateway replays the dispatch', async () => {
  // Reconnects replay (CLAUDE.md rule 6). A blocked message carries no id, so
  // the pipeline's fingerprint is the content fallback — this asserts it holds.
  const payload = {
    ruleId: '222222222222222222',
    userId: MEMBER_ID,
    matchedKeyword: 'forbidden',
    content: 'a forbidden word',
  };
  await discord.emitAutoModerationAction(payload);
  await discord.emitAutoModerationAction(payload);

  expect(listCaseEvents(MEMBER_ID)).toHaveLength(1);
});
```

Add a `listCaseEvents` helper beside the existing `findCase`, reading `schema.modCaseEvents` filtered by guild and member.

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run apps/daemon/src/native-automod.integration.test.ts`
Expected: FAIL — the subscriber is not reached, or `emitAutoModerationAction` does not exist, depending on how far Steps 1-3 got.

- [ ] **Step 6: Run the whole suite**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all clean. If `apps/daemon/src/index.test.ts` asserts an exact subscriber count or list, update it — that is a real assertion doing its job, not a nuisance.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/automod/native-wiring.ts apps/daemon/src/runtime/guild.ts apps/daemon/src/native-automod.integration.test.ts packages/testkit/src/fake-discord.ts
git commit -m "feat(daemon): wire the native AutoMod recorder end to end"
```

---

### Task 6: Assert the no-double-punishment property

**Files:**
- Test: `apps/daemon/src/native-automod.integration.test.ts` (extend)

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: nothing. This task is a claim, made executable.

ADR 0038 argues that native AutoMod and Bananasaurs cannot double-punish, because native blocks *before* the message exists and so `MESSAGE_CREATE` is never dispatched for it. `REVIEW.md` §A4 forbids two engines enforcing at once, and this is the reasoning that says the rule does not transfer from Carl-bot to native. **An argument in a document does not survive a refactor; a test does.** This task exists solely to make that property load-bearing.

- [ ] **Step 1: Write the property test**

```ts
describe('native AutoMod and Bananasaurs do not double-punish (ADR 0038)', () => {
  it('a blocked message produces a native record and no automod evaluation', async () => {
    // Native blocked it, so no messageCreate is ever dispatched — the whole
    // basis of the claim. Emitting only the auto-moderation event *is* the
    // fidelity: the gateway genuinely sends nothing else.
    await seedEnforcingKeywordRule('forbidden');
    discord.resetCalls();

    await discord.emitAutoModerationAction({
      ruleId: '222222222222222222',
      userId: MEMBER_ID,
      matchedKeyword: 'forbidden',
      content: 'a forbidden word',
    });

    const events = listCaseEvents(MEMBER_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.actionTaken).toBe('native_blocked');
    // No deletion was attempted: our rule never saw the message.
    expect(discord.restCalls('deleteMessage')).toEqual([]);
    expect(findCase(MEMBER_ID)?.violationCount).toBe(0);
  });

  it('an alert-only native rule leaves our rule free to enforce, once', async () => {
    // The one native configuration where both engines see the same content:
    // alert does not block, so the message posts and messageCreate follows.
    // Our rule enforces; native's alert is recorded. Two records, one
    // punishment — which is the behaviour, not a bug.
    await seedEnforcingKeywordRule('forbidden');
    discord.resetCalls();

    await discord.emitAutoModerationAction({
      ruleId: '222222222222222222',
      userId: MEMBER_ID,
      actionType: 'alert',
      alertMessageId: '888888888888888888',
      messageId: '555555555555555555',
      matchedKeyword: 'forbidden',
      content: 'a forbidden word',
    });
    await discord.emitMessageCreate({
      channelId: CHANNEL_ID,
      messageId: '555555555555555555',
      authorId: MEMBER_ID,
      content: 'a forbidden word',
    });

    const taken = listCaseEvents(MEMBER_ID).map((e) => e.actionTaken).sort();
    expect(taken).toEqual(['deleted', 'native_alerted']);
    expect(discord.restCalls('deleteMessage')).toHaveLength(1);
  });
});
```

Reuse the existing `automod.integration.test.ts` helper for seeding an enforcing keyword rule; if none is exported, lift the setup inline rather than exporting test helpers across files.

- [ ] **Step 2: Run the tests**

Run: `npx vitest run apps/daemon/src/native-automod.integration.test.ts`
Expected: PASS. If the second test shows two deletions or two counted violations, stop — that is the §A4 failure this task exists to detect, and it means ADR 0038's ordering claim is wrong rather than that the test is.

- [ ] **Step 3: Full verification**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all clean.

- [ ] **Step 4: Answer the hard-rules checklist**

Write these into the commit body or PR description, one line each, per the spec's §4 per-slice checkpoint:
- guild scope: every new repo call takes `GuildScope`; the subscriber never reads `event.guildId` (ADR 0020).
- idempotency: the pipeline fingerprint (Task 1) plus `recordCaseEvent`'s `onConflictDoNothing` on `(guild_id, event_id)`.
- rule 1: no provider call anywhere in this path; nothing degrades with every provider unreachable.
- rule 3: the gateway payload is validated at the adapter boundary before becoming a domain event.
- rule 4: no member-authored content reaches a log line; `safeLogFields`' allowlist extended deliberately if at all.
- rule 7: no new dependency.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/native-automod.integration.test.ts
git commit -m "test: assert native AutoMod and Bananasaurs cannot double-punish"
```

---

## After the plan

Per the spec's §4 per-phase checkpoint, Slice 0 does **not** end at Task 6. Phase 1 (Slices 0-2) closes with a whole-branch review by a fresh agent that did not write the code — ADR 0036 exists because exactly that review caught three defects twelve per-task reviews had each missed, including a guild in dry run really deleting real members' messages.

Next slice: Slice 1 — the predicate abstraction and `mod_rules.config` carrier, preceded by ADR 0039.
