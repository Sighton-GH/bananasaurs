# ADR 0019: Audit log entries are coalesced, late, and not about the message

Status: accepted (2026-08-23)

Extends `AuditLogEntry` in `packages/core/src/discord/port.ts`. Written in WP5 slice 6b, for WP4.

## Context

WP4's hardest requirement is inferred deletion attribution: `MESSAGE_DELETE` carries no actor, so the actor has to be recovered from the guild audit log and labelled *inferred* everywhere it surfaces.

Everything built so far models the audit log as `FakeDiscord.fetchAuditLog` — a hand-populated array with a filter over it. The slice 6 handoff flagged this as the least-modelled part of the fake and asked for it to be checked against discord.js before WP4 rests on it. It was. **Four facts, all verified against the installed 14.27.0, and each one changes the design of the thing WP4 has to build.**

### 1. `target_id` is the message *author*, not the message

`GuildAuditLogsEntry.js:326-331`:

```js
} else if (targetType === Targets.Message) {
  // Discord sends a channel id for the MessageBulkDelete action type.
  this.target =
    data.action_type === AuditLogEvent.MessageBulkDelete
      ? (guild.channels.cache.get(data.target_id) ?? { id: data.target_id })
      : (guild.client.users.cache.get(data.target_id) ?? null);
```

So for `MESSAGE_DELETE` the target resolves to a **User**, and for `MESSAGE_BULK_DELETE` to a **Channel**. **There is no message id anywhere in a `MESSAGE_DELETE` audit entry.** A correlation keyed on message id cannot be written, and the port's `targetId` — documented as nothing in particular — silently means a different kind of thing per action type.

### 2. Entries coalesce, and `count` is the only signal

`GuildAuditLogsEntry.js:203-209`: `MESSAGE_DELETE` carries `options.count` and `options.channel_id`. Discord updates **one** entry's `count` when the same actor deletes several messages by the same author in the same channel, rather than creating one entry per message.

So an entry does not describe *a* deletion. It describes *a run of deletions*, and the only way to tell that a new deletion joined an existing run is that the count went up since the last look. `AuditLogEntry` has no `count` field, so today that is unobservable.

### 3. Entries appear with a lag

The `MESSAGE_DELETE` gateway dispatch arrives before the audit entry exists. Correlation therefore cannot be synchronous — a fetch issued on receipt of the delete event will frequently find nothing, and finding nothing is not evidence that there was no actor.

### 4. A self-deletion produces no entry at all

When a member deletes their own message, Discord writes nothing. "Actor unknown" is a common outcome, not an edge case, and must never be resolved by picking the nearest entry.

## Decision

**Extend `AuditLogEntry` with `count` and `channelId`, and document what `targetId` means.**

```ts
export interface AuditLogEntry {
  actorUserId: Snowflake | undefined;
  /** For `message_delete` this is the message AUTHOR, not the message. */
  targetId: Snowflake | undefined;
  actionType: 'message_delete' | 'member_kick' | 'member_ban' | 'role_update';
  createdAtMs: number;
  reason: string | undefined;
  /** Running total for a coalesced entry. Undefined when Discord sent none. */
  count: number | undefined;
  /** The channel a coalesced `message_delete` run belongs to. */
  channelId: Snowflake | undefined;
}
```

Both are optional, because Discord sends `options` only for the action types that have it, and a field invented when absent would be worse than one missing.

**The port stays narrow.** No correlation logic, no caching of previous counts, no polling. The adapter reports what Discord said; deciding whether a count increment corresponds to *this* deletion is WP4's job, and it is a judgement, not a lookup.

**`FakeDiscord` is corrected to model all four facts**, because a fixture that makes the problem look easy is how you ship a bot that confidently names the wrong moderator.

## Consequences

**WP4 cannot correlate on message id.** The available key is (actor, author, channel, time, count-delta), and every part of it is approximate. This is the single most important thing this ADR exists to say, and it was invisible before the adapter was written.

**WP4 must tolerate "no entry yet".** A fetch on receipt of the delete event is expected to miss. Whatever WP4 does — a short delayed re-check, or attribution on the next pass — it must treat absence as *unknown*, never as *self-deleted*, because the two are indistinguishable at the moment of the fetch and only one of them is safe to assert.

**A count increment is evidence, not proof.** Two members deleting messages by the same author in the same channel within the same window produce entries that cannot be separated with certainty. `docs/20` WP4's gate — "a missing actor degrades to 'unknown,' never to a guess presented as fact" — applies to a *wrong* actor at least as strongly as to a missing one.

**Rejected: widening the port with a `messageId` on audit entries.** There is nothing to populate it with. Discord does not send one.

**Rejected: having the adapter poll and diff counts.** That is correlation, it is stateful, and it belongs above the port where the audit trail and the "inferred" labelling already live.
