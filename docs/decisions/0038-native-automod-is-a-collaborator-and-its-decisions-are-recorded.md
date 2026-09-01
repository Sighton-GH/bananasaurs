# 0038 — Native AutoMod is a collaborator, and its decisions are recorded

Status: accepted
Date: 2026-09-01
Depends on ADR 0035 (automod rule engine foundation — this ADR answers the half
of the native-AutoMod question 0035 left open), ADR 0036 (the twelve-value
case-event vocabulary and `countsAsViolation` — this ADR extends the first and
reuses the second), ADR 0037 (the `manual` sentinel precedent for
`mod_case_events.rule_id`).
Constrained by `CLAUDE.md` rule 1 (AI, and by the same reasoning any
unauditable heuristic, is never in the enforcement path), rule 2 (guild scope),
rule 3 (untrusted input crosses a Zod validator), rule 6 (durable idempotency
keys).
Implements Slice 0 of
`docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`.

## Context

`docs/08_ROADMAP.md` opens Release 2 with a scope check: configure Discord's
native AutoMod first, and build the custom engine only for what native cannot
express. `STATE.md` carried that as the next action for ten days. It is now
done, and the answer is more interesting than either "native covers it" or
"native is useless."

**What the guild actually runs.** Native AutoMod is enabled with three
defaults: block mention spam, block suspected spam content, block commonly
flagged words. The owner cannot inspect how any of them decide — Discord does
not publish the algorithms, and the FAQ page that gestures at them blocks
automated fetching.

**What ADR 0035 already settled.** Native AutoMod cannot be the whole answer,
because members holding `Administrator` or `Manage Server` are exempt from
every native rule, unconditionally and unconfigurably. That is the requirement
this club actually has, since other members hold Administrator.

**What ADR 0035 left open.** It never said what to *delegate* to native, nor
how the two engines coexist. `REVIEW.md` §E asks for "native Discord AutoMod
integration where it blocks earlier — do not duplicate it blindly," which names
a goal and no mechanism.

Two platform facts settle it, both confirmed against
`discord-api-types@v10` in this repo's lockfile rather than from memory:

1. **Native AutoMod blocks a message before it exists.** The gateway therefore
   never dispatches `MESSAGE_CREATE` for it, and
   `packages/core/src/automod/subscriber.ts` never sees it.
2. **Discord dispatches `AUTO_MODERATION_ACTION_EXECUTION`** to any bot holding
   the `AutoModerationExecution` intent (`2097152`, bit 21 — **not
   privileged**, so no Developer Portal review and no user threshold). Its
   payload carries `guild_id`, `rule_id`, `rule_trigger_type`, `user_id`, the
   executed `action`, `content`, `matched_keyword` and `matched_content`
   (`GatewayAutoModerationActionExecutionDispatchData`, `gateway/v10.d.ts:411`).

## Decision

### Native keeps its three rules and blocks first; Bananasaurs builds equivalents anyway

Blocking a message before it posts is strictly better than deleting it after,
so native is not switched off in favour of parity. Bananasaurs still builds
mention-spam, spam and keyword equivalents, for two reasons that have nothing
to do with duplication:

- **the admin gap** — native exempts `Administrator` / `Manage Server` holders
  unconditionally, and message deletion is not hierarchy-gated for a bot with
  `Manage Messages`, so Bananasaurs can act where native structurally cannot;
- **auditability** — a native decision that is not recorded cannot be reviewed,
  tuned, or explained to the member it affected.

### No overlap flag is needed, because event ordering makes double-punishment impossible

`REVIEW.md` §A4 requires that two engines never enforce the same rule at once,
and prescribes per-rule atomic cutover. That rule is about **Carl-bot**, where
both engines see the same message. It does not transfer to native AutoMod:
where native is configured to *block*, our subscriber is never invoked for that
message, so a Bananasaurs rule in `enforce` cannot punish the same content
twice. It only ever evaluates what native let through — exempt members, and
whatever native's algorithm missed.

This is asserted by a test rather than left as an argument, so that a future
change to the event path fails loudly instead of quietly creating the
double-punishment §A4 exists to prevent.

The exception is a native rule configured to *alert* rather than block: the
message posts, both engines see it, and §A4 applies normally. Configuring a
native rule to alert-only while its Bananasaurs equivalent enforces is a
supported combination; configuring **both** to enforce is the one native
combination that double-punishes, and it is the operator's to avoid.

### Native's decisions are recorded as case events under a `native:` sentinel

Each `AUTO_MODERATION_ACTION_EXECUTION` writes a `mod_case_events` row with
`rule_id = 'native:<discord_rule_id>'`, following ADR 0037's `manual` sentinel
precedent exactly: `rule_id` stays `NOT NULL`, and there is no foreign key to
`mod_rules`, which the automod events already rely on being absent.
`actor_id` is null — the actor is Discord, not a member or a moderator.

The vocabulary grows by four, additive, the way ADR 0036's twelve and
ADR 0037's six both were. Every existing value keeps its meaning:

| value | what really happened |
| --- | --- |
| `native_blocked` | native prevented the message from posting (`BlockMessage`) |
| `native_alerted` | native logged the content to its alert channel (`SendAlertMessage`) |
| `native_timeout` | native timed the member out (`Timeout`) |
| `native_blocked_interaction` | native barred the member from interacting (`BlockMemberInteraction`) |

`matched_keyword` goes in `matched_snippet` and the trigger type in
`matched_category`, reusing the columns the automod events already populate
rather than adding native-specific ones.

**The payload is untrusted input** (rule 3), and its boundary is guarded by the
translator's own field-by-field mapping (selective choice of which fields to
carry forward) and a length clamp on `matched_snippet`. The translator itself
performs the validation, not a dedicated Zod layer — `attachGatewayTranslation`
applies no post-translation validation for this event or any other, so that
mechanism remains characteristic of this house pattern rather than an invariant
across all gateway events.

### A native hit is recorded but does not count toward escalation

`openOrResolveCase` is called with `countsAsViolation: false` — ADR 0036's
existing mechanism, used for its existing reason.

A counting native hit would mean an algorithm nobody can inspect incrementing
the counter that drives our timeouts, kicks and bans. `CLAUDE.md` rule 1 keeps
the AI out of the enforcement path because a decision that cannot be
deterministically reviewed must not execute one; an unpublished third-party
heuristic is the same shape of thing, and the same reasoning applies. Native
already punished the content — it blocked it — so nothing is left unenforced by
declining to count it a second time.

The consequence, stated plainly: a member repeatedly caught by native alone
accrues history a moderator can read but never trips the ladder. If that turns
out to be wrong in practice, it is a one-line change to a flag that already
exists, and the recorded history is not lost in the meantime — which is the
right way round for a decision this reversible.

### The idempotency key prefers a Discord id and falls back to a bounded fingerprint

Rule 6 requires a durable idempotency key, and gateway events replay on
reconnect. This payload makes that harder than usual: **it carries no event id
and no timestamp**, and `message_id` "will not be present if message was
blocked by AutoMod" (`gateway/v10.d.ts:441`) — which is precisely the common
case, since all three of the guild's rules block.

The key is therefore derived in priority order:

1. `alert_system_message_id` when present — unique per alert action;
2. `message_id` when present — the action did not block;
3. otherwise a fingerprint over `(kind, ruleId, userId, actionType, content,
   timeBucket)` within a bounded time window.

   Two things this deliberately does **not** include, both corrected against the
   implementation during review. `guildId` is absent because `event_dedupe`'s
   primary key is `(guild_id, event_kind, fingerprint)` — the guild is already a
   column, and embedding it in the hash as well would be redundant, which is why
   no other case in `fingerprintOf` does it. `matchedKeyword` is absent because
   `content` already determines it for a fixed rule, so it would add no
   discriminating power.

This is not a new invention: it is the house pattern. `event_dedupe` is keyed
`(guild_id, event_kind, fingerprint)`, **not** the `(guild_id,
discord_event_id)` `REVIEW.md` §C8 prescribed, because gateway dispatches carry
no event id — the reasoning is already written down at
`packages/core/src/pipeline/fingerprint.ts:4-48` and mirrored at
`packages/storage/src/schema.ts:357-375`. `fingerprintOf` is a `switch` over
`event.kind`; returning `undefined` there is the explicit "not deduplicated"
choice, and this event returns a real fingerprint.

**Corrected while implementing.** An earlier draft of this ADR claimed that
`fingerprintOf`'s `switch` already made a missing case a compile error. It did
not. Falling off the end of a function whose return type is `string |
undefined` is legal TypeScript, and `tsconfig.base.json` sets `strict`,
`exactOptionalPropertyTypes` and `noFallthroughCasesInSwitch` but **not**
`noImplicitReturns` — so an unhandled kind silently became level-triggered
rather than failing loudly, which is an idempotency gap (rule 6) that nothing
surfaces. Reproduced both ways before acting on it: clean at exit 0 without the
flag, TS7030 with it. This slice therefore *builds* the gate it assumed,
via an explicit `default` clause asserting `never` — local to one function,
rather than a compiler flag whose blast radius is every package. Adopting
`noImplicitReturns` repo-wide would close the same class of gap everywhere and
is worth doing; it is deliberately left as its own change.

**The accepted trade-off.** Case 3 collapses two byte-identical blocked
messages from the same member inside the window into one recorded event, so a
determined repeat offender is under-counted in the review queue's volume
number. That is deliberately preferred to the alternative failure — a
reconnect replay recording the same block twice — because an over-count is a
false signal in the data the false-positive gate is computed from, while an
under-count is a smaller number of true events. And because native hits do not
count toward escalation, an under-count costs nothing in enforcement; it costs
only queue volume.

### The observe-window measurement bias is disclosed, not hidden

Because native blocks first, any Bananasaurs rule whose category overlaps a
*blocking* native rule is measured, during its observe window, against a stream
native has already filtered. Its false-positive rate is real but its match
volume is not representative, and a clean-looking number could be misread as a
clean rule.

The rule therefore carries a flag marking it as overlapping a blocking native
rule, and the review surface says so wherever it reports that rule's numbers.
The Release 2 gate rests on those numbers; a number presented without the
caveat that qualifies it is the kind of quiet lie the gate exists to catch.

## Consequences

- **Permission requirement:** `AUTO_MODERATION_ACTION_EXECUTION` dispatch requires
  the `MANAGE_GUILD` permission (confirmed in `discord.js` source,
  `AutoModerationActionExecution.js`). This is not currently granted; whether to
  grant it is the owner's decision and has not been made. Granting it has a real
  trade-off: `MANAGE_GUILD` also unlocks Discord's AutoMod REST endpoints, converting
  "Bananasaurs structurally cannot manage native rules via the API" (permission
  wall, permission architecture layer 1) into "merely does not." Section §A2 of
  `docs/18_SAFETY_AND_BLAST_RADIUS.md` records this trade and its structural
  implications. When the permission is not held, the bot runs normally but native
  AutoMod observability is inert — events are never recorded and the decision is
  unauditable. Whether this is acceptable is separate from the technical deferral:
  "should Bananasaurs *manage* native rules?" This ADR reads native's decisions
  only, never writes them back.
- `REQUIRED_INTENTS` gains `AutoModerationExecution`. It is not privileged, so
  no portal change is needed, but `doctor` and the intent assertions must be
  updated together or the daemon will assert against a stale set.
- A new guild-scoped subscriber, through the same dedupe and idempotency
  machinery every other side effect uses. It performs **no Discord writes at
  all** — it only records — so it does not pass through
  `ModerationActionGateway` and is not subject to dry run. That is deliberate:
  suppressing a *record* of something Discord already did would make the log
  lie about the guild's history, and the kill switch stops side effects, not
  observations.
- A migration widening the `mod_case_events.action_taken` CHECK by four values.
  Existing rows keep their meaning; nothing is rewritten. SQLite cannot alter a
  CHECK in place, so drizzle-kit emits a full table rebuild, exactly the shape
  migration `0008` took for ADR 0037's six values.
- **The vocabulary lives in three hand-maintained places** and there is no
  shared import to keep them honest, because `packages/core` may not import
  `@bananasaurs/storage` (ADR 0014): the CHECK in
  `packages/storage/src/schema.ts`, the `ModCaseActionTaken` union in
  `packages/storage/src/repos/mod-cases.ts`, and `AutomodActionTaken` in
  `packages/core/src/automod/subscriber.ts`. A value added to two of the three
  fails at runtime on a CHECK violation, not at compile time. All three change
  together, and a test asserts they agree.
- A rule-level flag for the native-overlap disclosure, landing with the other
  `mod_rules` columns in Slice 6 rather than as its own migration.
- `MESSAGE_CONTENT` is already held, so `content` and `matched_content` arrive
  populated. Had it not been, they would be empty strings and the recorded
  event would be far less useful — worth knowing if the intent is ever dropped.
  Loss of this intent also silently coarsens deduplication: `content` is a
  component of the fingerprint, so its absence would collapse all of one
  member's blocks under one rule inside a 60-second window into a single
  recorded event.
- No new dependency. No provider call. Nothing in this path degrades if every
  AI provider is unreachable, because none is involved.
- Not decided here, and deliberately: whether Bananasaurs should ever *manage*
  native AutoMod rules through the REST API. This ADR reads native's decisions
  and writes nothing back. Authoring native rules is a larger question about
  which engine owns configuration, and it is not needed to close Release 2.
