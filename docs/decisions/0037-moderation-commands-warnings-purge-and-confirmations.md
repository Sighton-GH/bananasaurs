# 0037 — Moderation commands, warnings that feed the ladder, bounded purge, and confirmation taps

Status: accepted
Date: 2026-08-31
Depends on ADR 0035 (automod rule engine foundation), ADR 0036 (the
twelve-value case-event vocabulary — this ADR extends it, never redefines
it), ADR 0023 (deletion attribution), ADR 0018 (the REST client refuses
rather than waits; interaction-token windows), ADR 0032 (slash-command
registration is a composition-root REST call), ADR 0015 (protected
principals are targets).
Constrained by `CLAUDE.md` rules 1 (no AI in the enforcement path — none of
this touches a provider), 2 (guild scope everywhere), 6 (durable idempotency
keys), and `docs/18_SAFETY_AND_BLAST_RADIUS.md`'s layer ordering.

## Context

The automod slice (ADR 0035/0036) built the rule engine, the cases, the
escalation ladder, and a `ModerationActionGateway` that can timeout and kick.
Release 2's moderation-commands slice adds the human half: `/mod` commands a
moderator types, cases a moderator reads and writes, a bounded purge, and
mod-issued warnings. The owner has made four decisions up front:

1. `/mod purge` uses the **same** `moderation.act` capability as kick — one
   bar for destructive member and channel actions, not a second grant.
2. `/mod warn` **feeds the ladder**: a mod-issued warning increments the same
   per-member escalation counter automod violations use, with the same
   violation-expiry semantics, so moderator warnings move members toward
   automatic escalation exactly the way automod strikes do.
3. `/mod ban` and `/mod purge` get **second-confirmation taps**: an ephemeral
   preview of exactly what will happen, executed only after an explicit
   confirm.
4. The purge is a durable background job on the existing `jobs` table, and
   purged messages go through the **normal deletion-attribution path**
   (ADR 0023) — a moderator purge is a deletion like any other and must
   appear truthfully in the deletion record.

Discord platform facts that bound the design, already confirmed for ADR 0035
and extended here: the guild owner can never be banned, kicked, or timed out
by a bot; a ban is not hierarchy-gated for a *member who has already left*
(there is no member to compare roles against); bulk message delete accepts at
most 100 ids and rejects the entire call if any message is 14 days old or
older; a member timeout is capped at 28 days; interaction tokens live
fifteen minutes from the interaction, and a component on an ephemeral
follow-up is addressable through that token for exactly that long
(ADR 0018, `packages/discord/src/rest/port.ts`).

## Decision

### The DiscordPort surface grows by five methods, not by a moderation sub-port

`banMember(guildId, userId, reason)`, `unbanMember(guildId, userId, reason)`,
`untimeoutMember(guildId, userId, reason)`,
`bulkDeleteMessages(guildId, channelId, messageIds, reason)`, and
`fetchRecentMessages(guildId, channelId, { before?, limit })` (a page of
`{ messageId, authorId, createdAtMs, content }` plus a continuation cursor).
The port stays one interface the FakeDiscord implements whole; a separate
"moderation port" would split the seam every test harness and the safety
layers already share. (`untimeoutMember` exists because Discord removes a
timeout by PATCHing `communication_disabled_until` to null — a dedicated
verb keeps that honest instead of overloading `timeoutMember` with a magic
duration.)

Ban does **not** delete messages: Discord's `delete_message_days` /
`delete_message_seconds` parameters are deprecated, and message removal is
purge's job, explicitly and separately. Unban performs no hierarchy check —
the target is not a member, so `fetchMember` has nothing to compare — and the
gateway's refusal vocabulary therefore needs no new members for it.
**Untimeout does keep the hierarchy check** (amended while implementing, and
different from unban): its target *is* a member in the guild, and Discord
gates the PATCH by role position exactly as it gates a timeout, so skipping
the check would record an `applied` the API then refuses.

### The purge job: payload, resume, budget

One job kind, `mod_purge`, payload `{ intentId, channelId, initiatorUserId,
reason }`, Zod-validated on read like every job payload (`jobs.payload` is
JSON written by us and still untrusted). Progress lives in the existing
`jobs.cursor`: `{ phase: 'fresh' | 'old', lastMessageId }` — the id of the
last message deleted, so a restart resumes from Discord's own `before`
pagination instead of re-listing from the top.

The **budget** is a pure function beside `checkReconcileBudget`
(`packages/core/src/effects/budget.ts`): `checkPurgeBudget(count, budget)`
against `PURGE_MAX_MESSAGES = 500`, a constant rather than guild config —
one guild, one sensible ceiling, and a config surface is not this slice's
job. The confirm-time preview counts the channel's matching messages first
and **refuses** a purge larger than the budget, telling the moderator to
narrow the scope; the worker additionally checks the budget per tick. The
job requeues itself with a spaced `runAfter` between ticks so the one-at-a-time
portion for messages older than 14 days walks out under Discord's rate
limits instead of hammering them.

**Amendment (Task 5 implementation): the successor's dedupe key is not the
job's own key.** `JobWorker.runOnce` (`packages/core/src/jobs/worker.ts`)
always marks a claimed row `done` once its handler returns; there is no
"run me again" signal, so a tick that is not finished must enqueue a *new*
row for its own continuation. `jobs_dedupe` is unique only over
`state IN ('queued','running')`, and a tick's own row is still `running`
while its handler executes — so a successor enqueued under the *same* key
the current row holds would collide with itself and be silently dropped,
stopping the purge dead after one tick. `purgeDedupeKey(guildId, intentId,
afterJobId?)` (`packages/core/src/jobs/kinds.ts`) therefore takes two
shapes: the confirm tap mints the *first* job with no `afterJobId`,
producing the bare `mod:<guildId>:purge:<intentId>` key this section names
above; every tick after that mints its **successor's** key from its own
`context.jobId` — `mod:<guildId>:purge:<intentId>:after:<jobId>`. Keying off
the tick's own row id (never the cursor content it computed) makes
self-collision structurally impossible — a row was enqueued under its
*progenitor's* id, never its own — and, because `jobId` is stable across a
crash (`requeueStranded` never changes it), makes a stranded-and-reclaimed
tick mint the *identical* successor key on retry regardless of what page it
happens to fetch and delete the second time around, so a crash between
"successor inserted" and "this row marked done" cannot leave two live
successors racing each other through the same channel. The job row's
`enqueue` also grew an optional initial `cursor` (`packages/storage/src/
repos/jobs.ts`) so the newly-inserted successor starts already knowing where
to resume, rather than at `null`. Full reasoning and the two known, bounded
edge cases this still leaves (an undercounted-but-never-double-deleted page,
and a narrow crash window where a real deletion can end up with no audit
row) are in `packages/core/src/mod/purge.ts`'s module docstring.

### Purged messages go through the normal deletion-attribution path

The purge deletes only through `DiscordPort` — `bulkDeleteMessages` for
messages under 14 days, `deleteMessage` one at a time above — and then, for
every message it deleted, does two things the ordinary `MESSAGE_DELETE`
subscriber does:

1. writes the honest `audit_events` row first: `action = 'message_delete'`,
   `subjectId = <messageId>`, `actorType = 'member'`, `actorId = <the
   moderator who confirmed>`, `inferred = 0`;
2. enqueues the normal delayed `log_message_delete` job for that message.

ADR 0023's `findMessageDeleteAttribution` reads `audit_events` by messageId
before consulting the audit log, so the delayed job finds the *true* actor —
the moderator, not the bot — and posts the ordinary log line. No
purge-specific archive, no parallel record, no new retention rule: the
tombstone/retention semantics are whatever the ordinary deletion record's
are.

Why self-enqueue instead of waiting for Discord's events: Discord dispatches
`MESSAGE_DELETE` for a bot's single deletions, but `MESSAGE_DELETE_BULK` for
bulk deletes, and the gateway does not subscribe to the latter — a
pre-existing gap this slice does not widen the domain-event surface to close.
The self-enqueued attribution job covers the gap exactly where this slice
creates it, and the `event_dedupe` claim (fingerprinted on the messageId)
makes the "both paths fire" case safe: exactly one attribution, one log line.

### Notes are case events; evidence links are case events

`/mod note` writes `mod_case_events` with `action_taken = 'note'`,
`ruleId = 'manual'` (a reserved sentinel — see below), and the note text in
`matched_snippet`. `/mod evidence` writes `action_taken = 'evidence_added'`
with the URL in `matched_snippet` and `matched_category = 'evidence'`.
One append-only stream per case gets ordering, the composite FK back to the
case, guild scoping, and whatever retention the record has, for free; a
second table would fork the history a moderator reads into two shapes for no
capability either shape lacks. Both are reversible to split out if notes ever
need per-note editing — they do not today, and an append-only record is the
more honest default.

### The `manual` sentinel, `actor_id`, and the widened vocabulary

`mod_case_events.rule_id` stays `NOT NULL`; manual events carry the sentinel
`'manual'` (or `'manual:<command>'` where the distinction helps history
readers). There is no FK from it to `mod_rules` — the automod events already
rely on that absence.

Manual actions need an **actor**. The automod events' actor is implicitly
the bot; a moderator command's actor is a member who must be visible in
history. A nullable `actor_id` column joins the table (snowflake-checked,
null for automod/system events).

The vocabulary grows by six, all additive — ADR 0036's twelve keep their
meanings untouched:

| value | what really happened |
| --- | --- |
| `warned` | a moderator issued a warning; it incremented the escalation counter |
| `note` | a moderator appended a note; nothing was enforced |
| `evidence_added` | a moderator attached an evidence URL; nothing was enforced |
| `purged` | the purge job deleted its messages (counts in the event) |
| `purge_refused` | the purge never started: a safety layer refused (reason recorded) |
| `purge_failed` | the purge started and Discord errored partway; the job retries |

Manual member actions (timeout/untimeout/kick/ban/unban) **reuse** the five
`escalation_*` values: the mapping from `ModerationOutcome` to event value is
one-to-one and already written (ADR 0036), and "escalation" is accurate —
these are enforcement actions against a member. `escalation_action`'s CHECK
widens to `('timeout','kick','ban','unban')`, and `timeout`/`kick` keep their
automod meaning unchanged.

### Warnings feed the ladder: one counter, two sources

A mod warn calls `openOrResolveCase` with `countsAsViolation: true` — the
same function, the same per-member counter, the same "at most one open case"
index the automod subscriber uses. Mixed automod/manual counts are
indistinguishable by construction: `nextEscalationTier` reads one number and
cannot know or care where each increment came from.

**The ladder's automatic consequence can trigger on a manual warning alone**
(the owner's ladder-feeding decision, stated plainly): a mod warn that pushes
the counter across tier 1 attempts the automatic timeout through
`ModerationActionGateway`, exactly as an automod strike would, with its own
durable dedupe key and the outcome recorded as its own case event. A
moderator issuing the third warning and watching the bot auto-timeout is the
behaviour, not a bug.

**Violation expiry: none exists, and none is built here.** The counter is
monotonic over the member's open case for both sources. The roadmap's
"violation expiry" was never built in the automod slice; building an expiry
semantics only for manual warnings would make the two sources diverge, which
is precisely what ladder-feeding forbids. The tests for mixed counts assert
that a manual warning and an automod strike are *identical* in their effect
on the counter — so when expiry lands later, it necessarily applies to both
or neither.

### Confirmation taps: components on the ephemeral follow-up, intent bound to the confirm

`/mod ban` and `/mod purge` defer ephemeral, then `respondToInteraction` with
a preview — target, reason, and for purge the message counts and age
distribution — plus Confirm/Cancel buttons (`components` on the follow-up,
which `OutgoingMessage` already carries). The mechanism is components on the
ephemeral follow-up rather than a second typed command because the token is
already in hand, the preview renders where the moderator is looking, and a
typed `/mod confirm` would need its own argument plumbing to address an
intent anyway.

The pending intent is **durable**: a `mod_pending_actions` table
(`(guild_id, intent_id)` primary key, Zod-validated JSON payload,
`created_by`, `expires_at` fifteen minutes out — the interaction-token
window, so expiry and addressability end together). The button customIds
carry only the intent id (`modconfirm:<intentId>`, `modcancel:<intentId>`),
never the payload — a custom id is attacker-controlled input, and the
component handler resolves everything else from the database row.

**Only the invoking moderator may confirm.** The confirm handler re-runs
`authorize('moderation.act')` for the *clicker* and requires
`clicker === created_by`: a confirmation button left on screen is not an
authorization transfer to whoever clicks next.

**The idempotency claim binds to the confirmed action, not the invocation.**
The dedupe key (`mod:<guildId>:<action>:<intentId>`) has this exact shape
from the preview onward, but nothing stores it: Task 7's implementation
re-derives it deterministically from `(guildId, action, intentId)` at
confirm time, identically to how it would have been minted at preview
time — a stored copy could only ever drift from that derivation, never
correct it, so there is no second copy to keep in sync. It is claimed only
when the action executes — inside `ModerationActionGateway`'s existing claim
layer for member actions, and inside the `jobs` table's dedupe for purge. A
double-tap on Confirm therefore resolves to `skipped` ("already executed"),
not a second ban; so does a replayed interaction dispatch. Preview → restart
→ confirm is safe the other direction too: the intent row survives the
restart, though the interaction token does not — the confirm fails with
"expired", and the moderator types the command again. Recorded as accepted,
not fixed: the token is Discord's credential, not ours to preserve.

### `/mod`: one command, subcommands, ephemeral, registered per ADR 0032

One registration (`/mod` with subcommands `timeout`, `untimeout`, `kick`,
`ban`, `unban`, `warn`, `purge`, `note`, `evidence`, `history`) in
`packages/discord/src/rest/commands.ts`, joined to the guild `PUT` — the
endpoint replaces the set, so registration stays idempotent by construction.
`default_member_permissions` carries a moderator bitfield as a **first
filter** (Discord's gate is advisory-by-configuration), and the handler
re-checks `moderation.act` through `authorize()` on every invocation and
every confirmation — the Discord gate grants nothing (ADR 0012). All
responses are ephemeral: moderation actions and someone's case history are
not channel content. `timeout` clamps to Discord's 28-day maximum in the
boundary validator; `history` is permission-scoped by the same capability —
a member without `moderation.act` gets the same refusal as any other `/mod`
subcommand, not a redacted view.

## Consequences

- Migration `0007`: `actor_id` on `mod_case_events` plus the widened
  `action_taken` / `escalation_action` CHECKs; new `mod_pending_actions`
  table. Pre-existing rows keep their meaning; nothing is rewritten.
- New port methods mean new FakeDiscord verbs and new `port.test.ts` cases;
  `PortMethod` grows mechanically.
- `doctor` treats `Ban Members` and `Manage Messages` as required (Release 2
  set) — they move out of the "extra permissions" finding and into the
  missing-permissions finding, while `Administrator` stays forbidden.
- No new runtime dependency. No provider call anywhere in the path.
- Out of scope, unchanged: protected users/roles config beyond ADR 0015,
  reconciliation of actions taken directly in Discord, per-action capability
  grants, reason templates, audit-log reconciliation, and everything Release 3+.

