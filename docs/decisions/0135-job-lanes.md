# ADR 0135: job lanes, and assistant answers in parallel across channels

Status: accepted 2026-10-09.

## Context

The daemon ran every durable job one at a time, whatever its kind. `drainJobs` looped `JobWorker.drain()` behind a
single `draining` flag, and `runOnce` awaited each handler before claiming the next.

On 2026-10-09 the hourly `resource_refresh` job crawled about 247 GitHub files, one after another. It took 220–287 s
every hour. Assistant mentions queued during it waited up to 282 s, and moderation, logging and every other job
waited too. Outside the refresh, mentions in different channels still queued behind each other while one answer
waited on the model.

The serial design was justified by "a second concurrent drain would interleave transactions". That reasoning does
not hold for better-sqlite3:

- Every `write()` is synchronous and forbids an await inside its transaction.
- `claimNext` selects and updates in one transaction.
- The per-model RPM/RPD limiter (`reserveEntryCall`) reserves in one transaction.

Two jobs running at once in this one process cannot double-claim, and cannot interleave a transaction.

What serial execution *did* protect is assistant conversation semantics. `resolveConversation` decides which
conversation a message joins from the state of its channel: the author's latest turn there, the latest bot reply,
and conversations with a bot reply in the last few minutes, which become `same-channel` links. A thread links to
its parent channel's conversation. Two answers resolving at once in one channel could each miss the other's reply,
and two turns could compute the same `nextAt`. The owner's instruction was explicit: requests in one conversation,
or in connected conversations, must not break each other.

## Decision

1. Jobs run in three **lanes**. Each lane claims only its own kinds and has its own concurrency.
   - `assistant`: `assistant_invoke`, `assistant_summarise`, `conversation_prune`. Concurrency is the instance
     setting `assistant.maxConcurrentRuns`, default 4, bounds 1–8.
   - `background`: `resource_refresh`, `archive_backfill`, `archive_expiry`, `prune_jobs`, `sweep_event_dedupe`.
     Concurrency 1.
   - `default`: every other kind, including any kind added later without a lane. Concurrency 1, FIFO, exactly as
     before. Enforcement, logging and effect ordering do not change.
2. An assistant job carries an **ordering key**, stored in `jobs.ordering_key` and written at enqueue. Two jobs
   with the same key never run at the same time, and the older due job runs first. The key is
   `chan:<threadParentId ?? channelId>`, or `user:<userId>` when there is no channel. A thread therefore shares its
   parent channel's key, and a summary takes the key of the answer that enqueued it. Within one channel, assistant
   behaviour is exactly the old serial behaviour.
3. A job with **no** ordering key in a lane that uses keys is **exclusive**. It is claimed only when the lane has
   nothing running, and nothing else in the lane is claimed while it runs. This covers `conversation_prune`, which
   deletes conversations, and any `assistant_invoke` queued before this change was deployed.
4. Concurrency never increases the number of provider calls, only how many overlap. The local RPM/RPD limits still
   bound bursts per model.
5. `stop()` waits for in-flight jobs. A deploy no longer abandons an answer mid-call (it would have been requeued
   by `recoverStranded` and answered twice over). Shutdown stops the job scheduler before destroying the Discord client, so an answer finishing inside the grace can still post.
6. `JobWorker.runOnce` and `drain` keep their serial behaviour. Tests use them, and production no longer does.

## Consequences

- An hourly refresh, a long purge or a slow log-delete lookup no longer delays assistant answers, and an AI call no
  longer delays moderation or logging.
- One busy channel is still one answer at a time. Per-conversation locking was rejected, because the conversation
  is not known until resolution, and resolution reads channel state. Revisit only if one channel becomes the
  bottleneck.
- A new job kind lands in `default` unless it is given a lane on purpose. A test fails if a registered handler kind
  is missing from the map, so the choice is always explicit.
