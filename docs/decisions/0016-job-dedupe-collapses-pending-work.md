# ADR 0016: a job dedupe key collapses pending work, not history

Status: accepted (2026-08-23), decided during WP3 slice 7a

Corrects the `jobs_dedupe` index shipped in WP2.

## Context

`jobs.dedupe_key` exists so that repeated requests for the same work collapse
into one job. `docs/19` §4 and `core/src/jobs/kinds.ts` both state the reason:

> A flapping connection produces a reconnect every few seconds. Without
> collapsing, each one queues its own reconciliation and the worker spends the
> whole outage repeating a pass whose inputs have not changed.

WP2 implemented that as `uniqueIndex('jobs_dedupe').on(guild_id, dedupe_key)`,
unconditionally. Job rows are never deleted — `completeJob` sets
`state = 'done'` and the row stays for the audit trail.

**Measured, not reasoned:**

```
first enqueue                  : {"enqueued":true,"jobId":1}
job state after completion     : done
second enqueue after completion: {"enqueued":false}
counts                         : {"done":1}
```

So a dedupe key is single-use **for the lifetime of the database**, and
`enqueue` returns `{enqueued: false}` for every later request. The failure is
silent by construction: `onConflictDoNothing` is exactly how the collapse is
implemented, and a collapse and a permanent block are indistinguishable at the
call site.

What this breaks, all of it work WP3 owns:

- `createConnectionSubscriber` enqueues with `reconcileDedupeKey('gateway-gap')`.
  The **second** gateway gap ever enqueues nothing. Reaction drift from that
  outage — the thing reconciliation exists for — is never repaired, and the log
  line says `reconcile-already-queued` about a job that finished days ago.
- The periodic timer pass (`reconcileDedupeKey('timer')`) can run exactly once.
- The adoption pass could be run once per panel and never re-run.

The bug is in the index, not in the callers. Every caller is written the way the
dedupe key is documented to work.

## Decision

**Uniqueness applies only while the work is still pending.**

```sql
CREATE UNIQUE INDEX jobs_dedupe ON jobs (guild_id, dedupe_key)
  WHERE state IN ('queued','running');
```

A second request for work that is already queued or running still collapses,
which is the property the key exists for. A request for work that has finished,
failed or been cancelled enqueues a fresh job, which is the property the
callers assume.

The index still leads with `guild_id`, so the schema invariant test's
"every unique index leads with the partition key" continues to hold, and the
dedupe remains per-guild.

Shipped as a second migration rather than by editing `0000`, because
`0000_steep_khan.sql` has already been applied to a database — the one WP3's
handoff instructed be deleted and rebuilt. A migration chain that is honest
about its own history is worth more than a tidy single file.

## Consequences

**`enqueue` is no longer idempotent across time, only across pending work.**
That is the intended semantics, but it means a caller that enqueues on a timer
must still choose an interval — the index will not save it from queueing a
second pass a millisecond after the first completes. The timer's interval is
that control, not the dedupe key.

**A failed job does not block a retry of the same work.** `failJob` marks a job
`failed` once `max_attempts` is exhausted, and a later request for the same
dedupe key now enqueues a fresh job rather than being silently dropped. This is
the right direction: a permanently-failed reconciliation must not disable
reconciliation forever.

**A test asserts the property directly**, in `packages/storage/src/repos/jobs.test.ts`:
same dedupe key refused while queued, refused while running, accepted after
completion, accepted after failure. Reverting the index to an unconditional
`UNIQUE` fails that test rather than passing review.
