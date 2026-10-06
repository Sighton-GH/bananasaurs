# ADR 0127: time-bucketed jobs run once per bucket, and finished jobs are kept 14 days

Status: accepted (2026-10-04), owner decisions recorded in `docs/26_RESOURCE_LEAKS_PLAN.md` §1

Amends ADR 0016 (job dedupe collapses pending work) and ADR 0073 (resource cache refresh).

## Context

ADR 0016 made `jobs_dedupe` unique only over `queued`/`running`, and warned in its
consequences: "a caller that enqueues on a timer must still choose an interval — the index
will not save it from queueing a second pass a millisecond after the first completes."

On 2026-09-25 (`ff3b05ea`) the resource refresh timer changed from ticking hourly to ticking every
60 seconds, relying on the hour bucket in its dedupe key to make extra ticks no-ops. By ADR
0016's own semantics they are not no-ops: once the bucket's job is `done`, the next tick
enqueues another. Measured on the live database on 2026-10-04:

```
resource_refresh:all:497523|done|60      -- one hour bucket, sixty sweeps
resource_refresh jobs in the last 24 h: 1,099 (expected 24), each refetching all 13 resources
```

The same assumption is made by the day-keyed archive-expiry and conversation-prune timers (they
re-run on every restart) and by the `manual` and `assistant` resource refreshes (minute and
ten-minute buckets). The assistant's `refresh_source` tool tells a member "Already refreshed in
the last 10 minutes" when the enqueue is refused, which under ADR 0016 almost never happens.

Separately, ADR 0016 notes "job rows are never deleted". Five weeks in, `jobs` holds 7,000+ rows.
Assistant jobs keep the whole run detail in `cursor`, which can include Discord message text,
and `event_dedupe` (whose sweep job was never scheduled) holds every event fingerprint since
2026-08-29.

## Decision

**1. A time bucket runs once.** `jobRepo.EnqueueInput` gains `oncePerBucket?: boolean`. When it
is `true`, `enqueue` refuses (returns `{ enqueued: false }`) if **any** row in the guild,
in **any** state, already carries the dedupe key. The check and the insert happen inside the
same `write()` transaction. A failed bucket waits for the next bucket, because the worker's own
retries (5 attempts with backoff) are the retry policy.

It is opt-in, and only for keys that end in a time bucket:

| Uses `oncePerBucket` | Must not |
|---|---|
| `resource_refresh:*:<bucket>` (`hourly`) | `resource_refresh:<id>:added` (no bucket: every save must refresh) |
| `resource_refresh:*:manual:<minute>` | `reconcile_guild:*` (every fresh IDENTIFY must reconcile) |
| `resource_refresh:*:assistant:<tenMinutes>` | `deliver_reminders` (constant per-guild key) |
| `archive_expiry:<day>`, `conversation_prune:<day>` | purge, backfill, `log_message_delete`, `assistant_invoke` |
| `sweep_event_dedupe:<day>`, `prune_jobs:<day>` (new) | |

`jobs_dedupe` stays partial. Making it total is the bug ADR 0016 fixed.

No index is added. The lookup is over one guild's rows, which retention (decision 2) bounds at
about 14 days of work. That's hundreds of rows once the refresh bug is gone.

**2. Finished jobs are kept 14 days** (owner, 2026-10-04). A daily `prune_jobs` job per guild
deletes `done`, `failed` and `cancelled` rows whose `updated_at` is more than 14 days old, in
batches of 500. It never touches `queued` or `running` rows. The assistant run detail in
`cursor` goes with its row. It is not cleared earlier: the owner chose the single 14-day rule.

**3. `event_dedupe` is swept at 14 days** by the existing `sweep_event_dedupe` handler, now
actually enqueued daily. 14 days is far beyond any gateway replay or job retry window.

**4. OAuth tokens are deleted 14 days after they expire**, whether or not they were revoked
(owner, 2026-10-04). Previously only expired-and-revoked tokens were purged. Rotated access
tokens are never revoked, so none were ever purged. Rotated access tokens are leaves of the
refresh chain, so deleting them cannot weaken refresh-token reuse detection, and an expired
token cannot authenticate.

**Not changed (owner, 2026-10-04: "I want good logging and archiving"):** `audit_events`
(including deleted-message text a log route copied), `gateway_gaps`, `dashboard_sessions`, the
MCP send/action ledgers, OAuth clients, and every archive tier. PRIVACY.md is updated to
disclose that the audit log keeps a deleted message's copied text with no time limit. Verified
while writing that disclosure: `attribute-deletion.ts:82` records the full payload, content included,
whenever an enabled route covers `message_delete`, even when that route's `includeContent` is off
(only the posted log message drops it). `/mod purge` records it too (`guild.ts:528–539`).

## Consequences

- Restarting the daemon inside a bucket no longer re-runs that bucket's sweep.
- A failed hourly refresh is not retried until the next bucket (plus the worker's own retries).
- An operator's "Update now" double-click inside one minute is one refresh. That was always the intent.
- `/status`'s failed-job list and `retry` only reach 14 days back.
- Tests assert both halves of decision 1: a bucketed key refuses after `done`, and the `added` and
  `gateway-gap` keys still re-enqueue after `done`. Removing the opt-in, or applying it everywhere,
  fails a test.
