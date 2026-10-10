# Concurrent assistant jobs and the body-read timeout

Status: **APPROVED 2026-10-09** (D1 = 4, D3 = 60 s, Task 6 in scope, D2 the owner adds a model). Implementation:
opencode Muse Spark on `oc/job-lanes`. The design section below supersedes the first draft. The ordering key is the
channel, per the owner's instruction that requests in one conversation, or in connected conversations, must not
break each other.
Date: 2026-10-09. Base: `main` @ 560dade7. All evidence comes from the live daemon (journal and a read-only
`sqlite3 -readonly`) at 23:00–23:10 PDT.

## Problem 1: conversations sit queued and are not processed

### What happens

- `JobWorker.runOnce` (`packages/core/src/jobs/worker.ts`) claims **one** job and awaits it. `drainJobs`
  (`apps/daemon/src/runtime/daemon.ts:676`) loops `worker.drain()` behind a single `draining` flag. The whole
  daemon therefore runs **one job at a time, of any kind**. An AI answer, a moderation effect, a log delete and the
  hourly resource refresh all share the same single slot.
- The hourly `resource_refresh` job refreshes 1 website plus 1 GitHub org and 11 repos. That is about 247 files,
  each fetched one after another (`github-refresh.ts:394`). It takes **220–287 s every hour** (24 of 24 runs
  today). For those ~4 minutes, nothing else in the bot runs.
- Tonight the refresh ran from 23:00:00 to 23:04:47. Five mentions queued at 23:00:05, 23:00:52, 23:01:56,
  23:02:47 and 23:03:54 waited **282, 245, 190, 156 and 95 s** (`assistant_runs.started_at − queued_at`). Then they
  ran one by one. That backlog is the "bunch of conversations queued" on the live page.
- Even without the refresh, conversations queue behind each other. In the 22:53–22:56 burst, runs waited 4–24 s
  while an earlier answer was still calling the model.
- The comment on `drainJobs` says concurrent drains "would interleave transactions". That is not true for
  better-sqlite3. Every `write()` is synchronous and finishes before the next `await`, and `claimNext`
  (`packages/storage/src/repos/jobs.ts:129`) does select-then-update inside one synchronous transaction, so two
  claimers in one process cannot take the same job. The per-model RPM/RPD limiter (`reserveEntryCall`) is also a
  single synchronous check-and-record. Running jobs concurrently is safe at the storage layer.

### Root cause

The serial worker is a design choice, not a bug in one handler. A slow job of any kind blocks every other kind.
This is also a hard-rule-1 concern: moderation, logging and automod jobs wait behind AI calls and the GitHub
crawl.

## Problem 2: the conversation that failed at 22:57

### What happens

Run `1558357491723804763` (job 13509) did the following:

1. Model call 1: answered with a `web_search` call, which succeeded.
2. Model call 2: asked for a second `web_search`. ADR 0071 correctly refused it ("not allowed after reading
   results").
3. Model call 3 to `nvidia/nemotron-3-ultra-550b-a55b:free` timed out after exactly **30.0 s** (the
   `assistant.providerTimeoutMs` default), with the raw message `The operation was aborted due to timeout`.

### Root cause (verified in source)

- In `packages/core/src/providers/openai-compatible.ts`, only the `fetch()` call is inside the try/catch that turns
  a `TimeoutError` into `ProviderError('timeout', retryable: true)`. Line 389,
  `responseSchema.safeParse(await response.json())`, is **outside** it. OpenRouter returns `200` headers at once
  and holds the body open while the model thinks, so the 30 s abort fires during `response.json()`.
- The raw `DOMException` escapes unwrapped. `classifyProviderFailure` falls through to rule 8, which gives
  `provider-error` ("a reason Bananasaurs does not recognise") with `retryable: false`.
- `jobs/assistant.ts:1308` retries only on `err instanceof ProviderError && err.retryable`. So the 10 s / 30 s /
  90 s retry schedule never ran, and the member got a failure at once.
- The chain has **one** entry ("position 0 of 1"), so there was no fallback model either.
- Minor: the failing `model-result` event reports `ms: 38909`. That is measured from the first model call of the
  run, not from this attempt, which took 30 007 ms.
- `gemini.ts` has the same defect: its `await response.json()` (line ~194) also sits outside its try (verified).

## Owner answers (2026-10-09)

- **D1:** 4 concurrent assistant runs. Accepted.
- **D3:** raise the timeout to 60 s. Accepted. Production has no `instance_settings` row for
  `assistant.providerTimeoutMs`, so changing the code default from 30000 to 60000 (Task 1b) takes effect at deploy.
  Setting it in the dashboard now takes effect at once.
- **Task 6:** in scope. Skip unchanged repos **and** download only changed files.
- **D2:** not yet answered.

## Owner decisions (as originally asked)

- **D1. Assistant concurrency.** How many assistant answers may run at once? I recommend **4**, as an instance
  setting `assistant.maxConcurrentRuns` with bounds 1–8. This does not increase the total number of calls, only how
  many overlap. The RPM/RPD limiter already caps bursts per model. (This choice affects cost exposure, which is why
  it is yours.)
- **D2. A fallback model.** The chain has a single free model, so any timeout or outage fails the member. Add a
  second chain entry in AI setup. You pick the model; no code change is needed.
- **D3. Provider timeout.** 30 s is short for a 550B reasoning model on a free route. I recommend **60 s**. This is
  the existing dashboard setting `assistant.providerTimeoutMs`, so you can change it now, before any deploy.

## Design (for ADR 0135)

Replace the single serial drain with **three lanes**. Each lane has its own claim filter and concurrency.

| Lane         | Kinds                                                                                                      | Concurrency    |
| ------------ | ---------------------------------------------------------------------------------------------------------- | -------------- |
| `assistant`  | `assistant_invoke`, `assistant_summarise`, `conversation_prune`                                            | D1 (default 4) |
| `background` | `resource_refresh`, `archive_backfill`, `archive_expiry`, `prune_jobs`, `sweep_event_dedupe`               | 1              |
| `default`    | every other kind, including any kind added later (reconcile, panels, log deletes, undo, purge, reminders, MCP bulk) | 1    |

**Ordering key: the conversation's channel.** Conversation resolution is channel state. `resolveConversation`
(`jobs/assistant.ts:763`) reads the author's latest turn in the channel, the latest bot reply in the channel, and
conversations with a bot reply in the last few minutes, which it links as `same-channel`. A thread conversation
links to its parent channel's conversation (`thread-parent`). Run two answers in one channel at once and the second
can miss the first's reply, starting a new conversation instead of continuing one. Two turns could also both compute
the same `nextAt` timestamp.

- The key is `chan:<threadParentId ?? channelId>`, so a thread serialises with its parent channel. An invoke
  without a channel uses `user:<userId>`. `assistant_summarise` takes its conversation's key at enqueue, so a
  summary never runs beside an answer in the same channel.
- Within one channel, behaviour is exactly today's: strictly one at a time, FIFO. Different channels run in
  parallel up to D1.
- A job **without** a key (`conversation_prune`, or an `assistant_invoke` queued before the deploy) is
  **exclusive**. It is claimed only when its lane has nothing running, and nothing else in the lane is claimed
  while it runs.
- Rejected: per-conversation locking. The conversation is not known until resolution, and resolution itself reads
  channel state. Revisit only if one busy channel becomes the bottleneck.

**Mechanics:**
- **Storage:** a new nullable column `jobs.ordering_key` (migration 0106), written at enqueue time.
  `claimNext(scope, now, filter?)` gains an optional `ClaimFilter`. With no filter it behaves exactly as today.
  Guild scope stays mandatory.
- **Core:** the `JobWorker` claim step is split from the execute step (`claim(filter)`, `execute(job)`).
  `runOnce` and `drain` keep their exact behaviour for the ~430 tests that use them.
- **Scheduler:** a new `LaneScheduler` in core. `tick()` fills each lane to its concurrency, without awaiting the
  jobs it starts. `idle()` resolves when nothing is in flight.
- **Daemon:** the 1 s poll calls `scheduler.tick()` per guild instead of `drainJobs`. `stop()` awaits
  `scheduler.idle()`, so a deploy no longer abandons an answer mid-call. `drainJobs` stays for tests only.
- **Setting:** the assistant lane's concurrency is the instance setting `assistant.maxConcurrentRuns` (default 4,
  bounds 1–8), read on every tick.
- **Storage safety:** concurrency is safe at the storage layer. better-sqlite3 is synchronous, `write()` forbids
  an await inside a transaction, the claim is select-then-update in one transaction, and the RPM/RPD limiter
  reserves in one transaction.

## Tasks (test first throughout)

ADR 0135 (job lanes) is written by the controller before Task 3 dispatches.

1. **Provider body-read timeout, 60 s default, per-call `ms`.**
   - `openai-compatible.ts` and `gemini.ts`: a `TimeoutError` while reading the body becomes
     `ProviderError('timeout', retryable: true)`. Any other body-read failure becomes
     `ProviderError('outage', retryable: true)`.
   - `classifyProviderFailure` gets a defensive rule: a bare `DOMException` named `TimeoutError` becomes
     `provider-timeout`.
   - `assistant.providerTimeoutMs` defaults to 60000.
   - A failed `model-result` event's `ms` is that call's duration, not the time since the chain entry started.
   - Tests fail on main first.
2. **GitHub blob-SHA cache.**
   - Migration 0105: `resource_documents.blob_sha`.
   - `listTree` keeps each entry's `sha`.
   - A file whose stored `blob_sha` equals its tree entry's `sha`, with an `ok` cached document, is marked fresh
     with no request. Every other file is downloaded as today, and its `sha` is stored.
   - An unchanged repo therefore downloads nothing, and a changed one downloads only changed files.
   - An error row clears `blob_sha`, so the file is retried next hour.
3. **Job lanes.**
   - Migration 0106: `jobs.ordering_key`.
   - The lane map; `assistantOrderingKey`; and `orderingKey` set on the mention enqueue and the summarise enqueue.
   - `ClaimFilter` on `claimNext`; the worker's claim/execute split; `LaneScheduler`; the daemon poll and `stop()`.
   - The `assistant.maxConcurrentRuns` setting.
4. **Concurrency regression tests through the real handler.**
   - Two invokes in two channels overlap.
   - Two invokes in one channel never overlap, and the second continues the first's conversation exactly as it
     does serially.
   - A thread invoke waits for its parent channel's answer.
   - A summary waits for the answer in its channel.
   - `conversation_prune` runs alone.
5. **Final review**, then gates and deploy:
   - Run `npm run typecheck`, `npm run lint` and `npm run test`, each separately.
   - Deploy in this order: stop, migrate (0105–0106), build, start, doctor.

## Verification after deploy

- At the next :00 refresh, mention the bot. `queueWaitMs` on its `started` event should be under 2 s while the
  refresh job is still `running`.
- Send three mentions from three accounts at once. All three runs should show `running` together on the live page.
- With D3 still at 30 s, a slow model should produce `provider-timeout`, then `retry-wait`, then a second attempt,
  not an immediate `provider-error`.
