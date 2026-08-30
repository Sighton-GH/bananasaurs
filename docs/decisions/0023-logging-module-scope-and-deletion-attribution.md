# ADR 0023: Logging module scope, deletion attribution, and log-post idempotency

Status: accepted (2026-08-29)

## Context

WP4 (`docs/20` §WP4, slice 12 in `docs/19` §7) is the logging module. Three
documents describe its scope with different grain, and none of them alone is
enough to start writing code:

- `docs/20`: "Message edits and deletions, joins and leaves, role and channel
  changes... Deletion actor inferred from audit log and labelled inferred
  everywhere it surfaces."
- `docs/19` §6.7: only elaborates on message deletion attribution and the
  30-minute-outage gap marker; its slice 12 demonstrable in §7 is narrower
  still — "Edits and deletes appear in the log channel, correctly labelled."
- `REVIEW.md` §E, Release 1: **"Message, member, and role logging."** No
  channel logging anywhere in the Release 1 list — it appears only as
  "channel changes" in `docs/20`'s summary bullet.

Per `CLAUDE.md`, `REVIEW.md` wins where it contradicts an older document.

## Decision 1 — scope is message, member, role; not channel; no kick/ban attribution

**No channel-change logging in this slice.** `REVIEW.md`'s Release 1 list
omits it, and the codebase agrees with `REVIEW.md` rather than `docs/20`:
`DomainEvent` (`packages/core/src/discord/events.ts`) has no channel-change
variant at all, `DiscordPort` has no channel-read method, and `FakeDiscord`
has no channel verb. Building it would mean widening the port (a new REST
route, a new gateway subscription, a new fake verb) for a feature absent from
the authoritative release list — exactly what "the port stays narrow" and
"never work ahead of the current release" (`docs/20`) forbid. If the owner
wants it, it is a new ADR and a new slice.

**No kick/ban attribution.** `AuditLogEntry.actionType` already includes
`member_kick` and `member_ban` (ADR 0019), and `GUILD_MEMBER_REMOVE` fires
identically for a voluntary leave, a kick, or a ban — the same
attribution-from-audit-log problem ADR 0019 solved for messages. Building it
now would be working ahead of the release: `REVIEW.md`'s Release 2 list names
"kick, ban/unban... mod log" explicitly, and `FakeDiscord` has no
`kickMemberAs`/`banMemberAs` verb the way it has `deleteMessageAs` — the fake
was extended exactly where WP4 needs it and not here, which is itself
evidence the scope stops at message deletion. `memberRemove` is therefore
always logged as a plain "member left" with no actor lookup. The action-type
union stays as ADR 0019 left it (harmless to leave unused values in a type);
nothing in WP4 constructs a `fetchAuditLog` call for `member_kick`,
`member_ban`, or `role_update`.

**Role-update logging reports the role's own new state, not who changed it.**
Same reasoning: attributing a role edit to an admin is a second
audit-log-correlation problem `docs/19`/`REVIEW.md` never asks for, and
`RoleEvent` today carries only `roleId`. Decision 2 widens it just enough to
report *what* changed, not *who*.

## Decision 2 — `RoleEvent` gains `name`, no port change

`packages/discord/src/events.ts`'s `GuildRoleCreate`/`Update`/`Delete`
listeners already receive the full discord.js `Role` object — including on
delete, where it is the last-known state before removal from cache, handed to
the listener for free. Today the translation throws away everything but
`role.id`. Adding `name: string` to `RoleEvent` costs no new Discord call
(unlike `fetchRoles`, which cannot help on delete — the role is already gone
from the cache by the time the event fires) and is what makes "Role deleted:
`@old-name`" possible instead of "Role deleted: `id 123456789012345678`",
which is useless to a moderator. This is a `DomainEvent` change, not a
`DiscordPort` change, so it needs no port-widening ADR of its own — recorded
here because `docs/20` still wants consequential choices written down.

## Decision 3 — message-delete attribution: a durable per-run cursor, single-candidate rule

ADR 0019 states the available key is `(actor, author, channel, time,
count-delta)` and that "deciding whether a count increment corresponds to
*this* deletion is WP4's job... a judgement, not a lookup." This is that
judgement.

**Mechanism.** `messageDelete` enqueues a delayed job
(`log_message_delete`, `run_after = now + MESSAGE_DELETE_ATTRIBUTION_DELAY_MS`)
rather than fetching the audit log synchronously — ADR 0019 fact 3 says a
synchronous fetch is expected to find nothing. The delay
(`3_000`ms — comfortably past the fake's `AUDIT_LOG_LAG_MS = 2_000`, and
otherwise an acknowledged guess, exactly as ADR 0019 says the coalescing
window is) buys the audit log time to catch up, once, and does not retry
waiting for it: a self-deletion will never produce an entry no matter how
long we wait, so an open-ended poll would only delay the "unknown" case
without ever resolving it, per ADR 0019's "must tolerate 'no entry yet'"
without ever treating "still nothing" as "self-deleted."

**The cursor.** `message_delete_runs` (guild-scoped, PK
`(guild_id, actor_user_id, author_id, channel_id)`, one column
`claimed_count`) records how many deletions in a given (actor, author,
channel) run WP4 has already attributed. Without it, "the count went up"
cannot be answered — the port reports only the run's live total, never a
delta, and ADR 0019 says so explicitly (no `lastActionAtMs` on the public
type; it is fake-internal).

**The algorithm**, run once per pending deletion at job time:

1. Fetch recent `message_delete` audit entries.
2. Filter to candidates where `entry.targetId === authorId` and
   `entry.channelId === channelId`. (Undefined `authorId` — the message was
   uncached — makes attribution impossible by construction; skip straight to
   unknown.)
3. For each candidate, compute `unclaimed = (entry.count ?? 1) -
   (cursor.claimedCount for that candidate's actor, default 0)`.
4. Keep candidates with `unclaimed > 0` ("active").
   - **Exactly one active candidate** → attribute to that actor,
     `inferred = true`, and increment *that* cursor's `claimed_count` by
     exactly **one** (not the full unclaimed amount — see below).
   - **Zero active candidates** → `actor unknown`. Either no entry has
     appeared yet (self-deletion, or the delay wasn't enough) or every
     candidate's activity was already claimed by an earlier deletion.
   - **Two or more active candidates** → `actor unknown`. Two different
     actors both show unclaimed deletions of this author in this channel,
     and nothing distinguishes which one is ours. This is the exact
     ambiguity `docs/20`'s gate names: "a missing actor degrades to
     'unknown,' never to a guess presented as fact... applies to a wrong
     actor at least as strongly as to a missing one." Guessing between two
     candidates is exactly the guess the gate forbids, even though one of
     them is very likely right.

**Why claim exactly one unit, not the whole visible delta.** A burst of `N`
messages by the same author, in the same channel, deleted by the same
moderator, produces `N` independent jobs (one per `messageDelete` dispatch)
and, eventually, one coalesced entry with `count = N`. Each job sees the
*same* live `count`. If job 1 claimed the whole delta immediately, job 2
would see `unclaimed = 0` and wrongly report "unknown" for a message that
really was attributable — a correctness loss in the safe direction, but an
avoidable one. Claiming one unit per successful attribution means each of
the `N` jobs independently observes "at least one unclaimed deletion exists"
and each correctly claims its own share, regardless of execution order.

**The residual ambiguity this does not solve, stated plainly.** If a member
self-deletes one message (which writes no entry) at nearly the same moment a
moderator deletes a *different* message by that same member in the same
channel, both jobs see the same single active candidate (the moderator's
entry) and race to claim it. Whichever job runs first claims it — correctly,
if it was the moderator-deleted one; **wrongly, naming a real moderator for
a self-deletion, if it wasn't.** No algorithm can do better with only
`(actor, target, channel, count)` and no message id — ADR 0019 says the key
is approximate in every component, and this is what "approximate" costs in
practice. It is not fixed here. It is named so a future reader does not
discover it by trusting a wrong "(inferred)" tag.

**Recorded via the existing generic audit trail**, not a bespoke table:
`recordAudit` (`packages/storage/src/repos/effects.ts`), `action:
'message_delete'`, `subjectType: 'message'`, `subjectId: messageId`,
`inferred: true` when an actor was found, `actorId: undefined` and
`inferred: false` when not. This is the same table role effects already
audit through, so `bananasaurs audit tail` (WP5 slice 13) shows an inferred
deletion the same way it shows everything else, with the same honesty
convention (`actor_unix_user_claimed` amendment 2 is the same discipline
applied to a different trust boundary).

## Decision 4 — log-post idempotency deliberately inverts the role-effects pattern

CLAUDE.md rule 6 is unconditional: every Discord side effect needs a durable
idempotency key and a unique constraint that makes double execution
impossible. A `sendMessage` to a log channel is a Discord side effect.

The existing pattern (`EffectGateway`, ADR-adjacent to role effects) claims
an idempotency key **before** the REST call: "a crash between them records
the effect as attempted and a replay skips it" (`docs/reports/WP5-slice-6.md`
§3). That is correct for role mutations, where a skip is safe — the state is
either already right or will be caught by reconciliation, which is
level-triggered and self-healing. **The logging module has no reconciliation
and cannot skip silently**: `docs/19` §6.7 already establishes that missing
log lines are the accepted-but-visible failure mode, and its whole argument
is "silently missing log lines is worse than a visible gap marker." Claiming
before sending and never releasing the claim on failure would convert a
transient failure (a slow 500, a momentary channel-permission hiccup) into a
*silent, permanent* loss — worse than the gap marker this same package
exists to add, and for a much more common cause than a full outage.

**Decision: claim, attempt the send, and release the claim if the send
throws.** `pipelineRepo.recordFirstSight` (already used for gateway
dedupe) is reused for the claim, under a **namespaced** `eventKind` —
`log:message_edit`, `log:member_join`, `log:role_update`, etc. — never the
bare gateway kind, because the pipeline's own gate 2 already inserts a row
under the bare kind (`messageDelete`, `roleCreate`, ...) *before* any
subscriber runs; reusing that exact key would make every claim attempt from
this module observe "already seen" and never fire. A new `forgetFirstSight`
(paired DELETE) releases the claim when the send throws, so the next
delivery of the same logical event — a resumed-session replay is the only
realistic source of one, since gate 2 already drops genuine gateway replays
for six of these seven kinds — gets to try again. This is safe without extra
locking because ADR 0020 already serialises dispatch per guild: nothing
calls the logging subscriber for the same guild concurrently, so
claim-then-send-then-release-on-failure has no race window to close.

This still cannot promise delivery — a permanently failing channel (bot
kicked, channel deleted) fails forever and is logged via pino each time,
never silently. That is the same "best-effort, visibly" posture `docs/19`
§6.7 already accepts for the outage case, applied consistently to the
non-outage case too.

**`roleUpdate` has no pipeline-level fingerprint** (`fingerprint.ts` leaves it
undeduplicated on purpose, as "level-triggered," because nothing consumed it
before now). WP4 does not add one there — doing so would change gate 2's
behaviour for every future consumer of `roleUpdate`, not just this one.
Instead the logging subscriber computes its own local, content-based
fingerprint for that one kind — `` `${roleId}:${name}` `` — under its own
namespaced claim. A real rename produces a new fingerprint and logs
correctly; a resumed-session replay of the identical dispatch produces the
identical fingerprint and is skipped. The other six kinds reuse
`fingerprintOf(event)` from the shared module verbatim, under the namespaced
key, rather than duplicating that logic.

## Decision 5 — gap markers are the logging module's responsibility

`docs/19` §6.7's restated gate: "role state is correct after reconciliation,
and every gap is detected and posted to the log channel as an explicit gap
marker." `packages/storage/src/repos/pipeline.ts`'s doc-comment on
`recordGap` already says as much: "message edits and deletions are not
[recoverable by reconciliation], which is why the logging module marks the
gap." This generalises to every WP4 event kind, not only messages — a member
join/leave or a role change during a fresh-IDENTIFY gap is exactly as
unrecoverable (there is no "list what changed while I was away" call for
any of them either).

On a non-resumed `connection` event, the logging module posts one marker to
every *distinct* channel currently enabled in `log_routes` for this guild
(a channel appearing under two event kinds gets one marker, not two),
naming the window with Discord's own `<t:unix:t>` timestamp markup so it
renders in each reader's local time rather than a server-assumed timezone.
Idempotency key: namespaced claim on `(disconnectedAtMs, channelId)`, not
`gapId` — `gapId` is minted by `recordGap`, inside `connection-subscriber.ts`,
a *different* subscriber; subscribers share no state and pipeline dispatch
discards each one's return value, so the logging module has no way to learn
the id connection-subscriber just assigned. `disconnectedAtMs` is already on
the event and is just as good a key: a guild cannot have two simultaneous
disconnections, so it identifies the gap exactly as well as the row's
surrogate key would.

## Consequences

- A new table, `message_delete_runs`, migration required.
- Two new `pipelineRepo` exports: `forgetFirstSight` alongside the existing
  `recordFirstSight`.
- `RoleEvent` gains `name: string`; every existing construction site (the
  adapter, the fake, any test emitting a synthetic `RoleEvent`) must supply
  it — a compile error names every one.
- `LOGGABLE_FIELDS` gains `actorId` and `authorId` (both plain Discord user
  ids, same trust level as the `userId` already allowlisted).
- No retention/purge job for logged content: ADR 0009 already settles this —
  "Log-channel forwards: governed by Discord's own retention in that
  channel, not by Bananasaurs." The `audit_events` rows this module writes
  for deletion attribution get no bespoke retention either, consistent with
  `audit_events` having none anywhere else yet; a general audit retention
  policy is not this package's problem to invent.
- `message_delete_runs` grows by at most one row per unique
  (actor, author, channel) triple this guild has ever seen a moderator
  delete from — bounded by realistic single-guild usage, unlike
  `event_dedupe`. No sweep job is built for it in this slice; noted as a
  WP6-or-later item if it ever needs one, the same way `event_dedupe`'s
  sweep was built in a dedicated slice rather than assumed.

## Rejected alternatives

**Widening `AuditLogEntry` with a `lastActionAtMs` or exposing the fake's
internal run state.** ADR 0019 already rejected widening the port for
correlation help ("the port stays narrow... that is a judgement, it belongs
above the port"). Re-litigating it here for convenience would undo a
decision made two slices ago for a documented reason.

**Claim-before-send with no release, matching role effects exactly.**
Rejected in Decision 4 above: correct for a self-healing subsystem, wrong
for one with no reconciliation, where it would turn "the gate that is
unachievable as written" (§6.7) into "the gate that is unachievable and
silently unmet" for far more than the outage case that section addresses.

**Attributing to the actor with the most unclaimed count, when more than
one candidate is active.** Considered, to reduce how often WP4 says
"unknown." Rejected: "most likely" is still a guess presented as fact the
moment it is rendered as "(inferred)" without a confidence caveat the
`docs/20` gate has no vocabulary for, and inventing that vocabulary now is
scope the release does not ask for.
