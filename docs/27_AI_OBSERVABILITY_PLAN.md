> **STATUS: FINAL**: owner decisions D1–D4 recorded 2026-10-06 (§1); approved for implementation
> 2026-10-06 (ADR 0129).

# AI observability: failures, live progress, and the full run record

**Status:** FINAL
**Date:** 2026-10-06
**ADR:** 0129 (0128 is taken by the unmerged MCP text-mention branch)
**Migration:** 0102 (Slice 2 only)
**Evidence:** the daemon journal for 2026-10-06 12:54–13:14 PDT, `data/bananasaurs.db` (read-only),
and a code read of the assistant path (enclosing blocks were read, not single lines).

## Contents

1. Decisions I need from you
2. What prompted this: today's failures, explained
3. What I found: why the dashboard was blind
4. Design
5. Slices
6. Tests to write first
7. How we'll know it worked (after deploy)
8. Out of scope / deferred
9. Research notes

---

## 1. Decisions I need from you

**Owner's answers (2026-10-06):**

- **D1:** **show it.** Store the sanitized provider message on each failed attempt, gated by
  `config.read`, with a key-shaped-string test. ADR 0129 records the partial reversal of ADR 0079 §3.
- **D2:** **delete with the conversation.** Runs with no conversation are deleted after 30 days.
- **D3:** **dashboard banner + `doctor` + the AI log channel embed.** No DMs. Display only.
- **D4:** **yes**, record OpenRouter's per-call cost.
- **D5:** not asked separately; the recommendation stands (Slice 1 ships first, on its own branch).
  Say so if you want it otherwise.

The original questions, kept for the record:

| # | Question | Recommendation |
|---|---|---|
| D1 | **Show the provider's own error text on the dashboard.** Example: `HTTP 404: No endpoints found for stealth/space-bunny-alpha`. ADR 0079 §3 (your decision, 2026-09-25) keeps it in the journal only, so the dashboard shows the classified code (`provider-bad-model`) without the sentence that explains it. The text is already sanitized and capped at 160 characters by the adapters. | **Yes, gated by `config.read`.** Store it on each failed attempt, and add a test that fails if anything key-shaped (`sk-…`, `AIza…`, `Bearer …`, or a long token string) survives. This reverses part of ADR 0079, so ADR 0129 records it. Without it you still need the journal to answer "why". |
| D2 | **How long the step log is kept.** Slice 2 adds a per-run step log: timestamps, stage names, model, ms, token counts, error codes. It holds **no message text**. | **Delete it with its conversation** (the existing conversation-retention setting). Delete runs that never got a conversation (early refusals) after **30 days**. |
| D3 | **Failure alerts outside the dashboard.** When a model fails the same non-transient way repeatedly (a 404 bad model, a revoked key, an exhausted account), where should you be told? | **Dashboard banner + `npm run doctor` line + the existing AI log channel embed**, which would name the model and the code instead of today's fixed "failed before producing a response". **No DMs.** Display only: nothing removes a model from the chain automatically (hard rule 1). |
| D4 | **Cost per call.** OpenRouter can report the exact cost of each call in the response. That needs one extra request field, `usage: { include: true }`, sent to the same host, so no new destination. | **Yes**, record it when present and show it next to tokens. Your chain is free models today, so this mostly reads $0. Its value is noticing when a paid model sneaks in. |
| D5 | **Order.** Ship Slice 1 (no migration, fixes "failures are invisible") as its own branch first, then Slices 2–4? | **Yes.** Slice 1 alone would have shown today's failures in History and Conversations, with the reason. |

**Also, now, separate from this plan:** remove or replace `stealth/space-bunny-alpha` in
*Providers → Model order*. OpenRouter no longer serves it (§2), so it can never answer.

---

## 2. What prompted this: today's failures, explained

Between 12:54 and 13:14 PDT the bot failed **10 requests**, and nothing on the dashboard showed it.
From the journal, each one went the same way:

| Step | Model (key "openrouter kai") | Result |
|---|---|---|
| 1 | `nvidia/nemotron-3-ultra-550b-a55b:free` | `provider-invalid-response`: "openrouter returned no text" (from 13:01 on; at 12:54 it logged no failure, so it was most likely skipped, which nothing records today) |
| 2 | `stealth/space-bunny-alpha` | `provider-bad-model`, HTTP 404: "No endpoints found for stealth/space-bunny-alpha." |
| — | (chain exhausted) | member got "I could not complete that request. No action was taken." |

- **space-bunny-alpha** was a time-limited "stealth" model. OpenRouter has withdrawn it, so the
  fallback can never succeed.
- **nemotron's empty answers** cannot be explained from what we keep. The adapter throws
  `returned no text` and drops everything that would say why:
  - the finish reason (`length` would mean it ran out of output tokens);
  - completion and reasoning token counts;
  - the upstream provider OpenRouter routed to.

  The likeliest cause is a known reasoning-model behaviour: reasoning uses the whole output budget and
  `content` comes back empty (§9). That is unconfirmed until Slice 1 records the finish reason and the
  reasoning tokens.

The trace table's newest `failed` row is from 2026-09-30, so **none of today's 10 failures was
recorded**.

---

## 3. What I found: why the dashboard was blind

| ID | Gap | Where | Effect |
|---|---|---|---|
| G1 | When the chain's last attempt is an `error` (bad model, auth, invalid request), `mapLoopFailure` rethrows the raw `ProviderError`, without the attempt list. The job's trace writer returns early for anything that is not a `ChainFailedError`. | `apps/daemon/src/assistant/service.ts:1229`, `apps/daemon/src/jobs/assistant.ts:895` | **No trace.** This is today's case. |
| G2 | Daily-quota replies, local RPM/RPD-limit replies, deleted-behaviour runs, and the "channel not writable" skip write no trace either. | `jobs/assistant.ts:929-952`, `:448` | The member got a reply; History shows nothing. |
| G3 | A failure reply is posted to Discord but **never written as a conversation turn**. | `answerSingle`, `jobs/assistant.ts` | The Conversations transcript shows the question with no answer and no reason. |
| G4 | Failure traces that *are* written carry `sections: []`, so "What the AI saw" is empty exactly when you need it. | `insertChainFailureTrace` | You can't tell if a bad prompt caused the failure. |
| G5 | `ok: false` results, including an **empty answer** and **"provider not configured"**, are stored as `refused`, not `failed`. | `jobs/assistant.ts:1126, 1248` | Real failures hide under a policy label. |
| G6 | The empty-answer adapter error drops the finish reason, the token counts and the upstream provider. The empty-answer retry inside the tool loop fails silently. | `packages/core/src/providers/openai-compatible.ts:370-371`, `tool-loop.ts` (`finishEntry`) | "Returned no text" is undiagnosable. |
| G7 | The provider's error sentence lives only in the journal (ADR 0079 §3). | `tool-loop.ts:515` | The dashboard says `provider-bad-model` but not *which* model is gone or what the provider said. → D1 |
| G8 | Nothing is recorded until a run **ends**. The only in-flight marker is a `running` row on the Jobs page. | whole path | No "what is it doing now". |
| G9 | The dashboard never refreshes by itself: no polling, SSE or WebSocket anywhere (`useResource` loads on mount and on `reload()` only; verified by grep). | `packages/dashboard/src/hooks/useResource.ts` | Even the data that exists needs a manual reload. |
| G10 | No log line on the success path (model, ms, tokens), and no id ties the journal to a trace. Fallbacks and skipped entries log nothing. | `tool-loop.ts`, `jobs/assistant.ts` | Journal and dashboard can't be lined up. |
| G11 | The AI log channel embed for a failure always says "failed before producing a response". | `log-message.ts` | Staff in Discord can't see why either. |
| G12 | The job worker runs **one job at a time**. A 35-second assistant run (today's failures took 30–38 s) delays every other job, and a second question waits behind the first. Nothing shows that wait. | `packages/core/src/jobs/worker.ts:143` | "Is it stuck?" can't be told apart from "it's queued". |

---

## 4. Design

### 4.1 Approaches considered

**Where the live state lives:**

- **A. A run ledger: `assistant_runs` (one row per request, updated in place) plus `assistant_run_events`
  (append-only step log).** ← recommended. The trace stays the final, detailed record. The ledger
  is small, metadata-only, survives restarts, and can be queried for stats (Slice 4).
- B. Write the trace row at the start with outcome `running` and rewrite its body at each stage. This
  rewrites up to 200 KB of JSON per step, needs a table rebuild for the outcome CHECK, and leaves no
  step history.
- C. An in-memory event bus only. Lost on restart, invisible after the fact, no stats.

**How the dashboard gets updates:**

- **A. Polling** ← recommended. Every 2 s while anything is in flight or the open run is live, and every
  15 s otherwise. It pauses when the tab is hidden. It needs no new dependency, uses the existing
  cookie auth and capability checks unchanged, and costs one indexed SQLite read per tick (single
  owner, single guild).
- B. Server-Sent Events. Truly push, but it needs a long-lived Fastify route, reconnect handling, and an
  in-process bus that still needs the table for history. A 2 s delay doesn't matter for "what is the AI
  doing now". Revisit only if polling proves too slow.
- C. WebSocket: a new dependency (`@fastify/websocket`), with the same costs as B and more.

### 4.2 The run ledger (Slice 2)

`assistant_runs`: one row per invocation.

- **Key and links:** `guild_id`, `run_id` (= `invocationId`), `conversation_id`, `trace_id`.
- **Request:** `user_id`, `channel_id`, `behaviour_id`, `source`.
- **Progress:** `state` (`queued|running|retry-wait|answered|refused|failed`), `stage` (the current
  step, e.g. `calling-model`), `attempt`.
- **Timing:** `queued_at`, `started_at`, `updated_at`, `finished_at`, `retry_at`.
- **Current call:** `model`, `key_label`.
- **Result:** `error_code`, `total_tokens`.
- **Constraints:** primary key `(guild_id, run_id)`; index `(guild_id, state, updated_at)`.

`assistant_run_events`: append-only.

- **Key:** `guild_id`, `run_id`, `seq`, plus `at` and `kind`.
- **Typed columns** used for stats: `model`, `key_id`, `outcome`, `code`, `ms`, `tokens`.
- **Everything else** goes in `data_json`, validated by a Zod discriminated union on `kind`.
- **Constraints:** primary key `(guild_id, run_id, seq)`; index `(guild_id, kind, at)` for Slice 4.

**Event kinds** (each is one line in the step log):

| kind | Recorded data (no message text, ever) |
|---|---|
| `queued` | how it was addressed (mention, reply, slash) |
| `started` | job attempt, **queue wait ms** (G12) |
| `conversation` | new or continued, history turns, summary version |
| `context-built` | prompt sections with character counts and estimated tokens; resources retrieved (chunk count); memories; channel messages; tools offered |
| `model-call` | position in chain, provider, model, key label, round |
| `model-result` | ok or failed; ms; prompt, completion and reasoning tokens; finish reason; upstream provider; cost (D4); failure code, HTTP status or network code; provider message (D1) |
| `model-skipped` | model and reason (disabled, ineligible, daily allowance used, local RPM/RPD limit with the free-up time) |
| `tool-call` / `tool-result` | tool name, round; ok, refused (and why), ms, result size |
| `guard` | what was removed or blocked |
| `retry-scheduled` | the classified failure and when the retry runs |
| `delivering` / `delivered` | parts count, Discord message ids |
| `finished` | outcome, total duration, total tokens |

**Writing it.**

- A `RunRecorder` port is created by the job, bound to `(guildId, runId)` by construction, so no call
  site can omit guild scope (hard rule 2).
- It is passed into `service.invoke` and on into the tool loop. Event payloads are built from values the
  code already holds.
- The `seq` is allocated inside the insert transaction.
- A job retry continues the same run, and `attempt` increments.
- Recorder failures are logged and swallowed: observability must never fail a run.

**Try-it.** Dashboard Try-it gets a recorder too, so test runs show live as well.

**Retention** (D2): runs and events are deleted by the existing conversation prune and member-forget
paths. Orphan runs are deleted at 30 days by the same prune job.

### 4.3 Failures are always recorded (Slice 1)

- **One terminal path.** Every way a run ends writes a trace: answered, refused, failed, and the
  quota, local-limit and early-skip replies.
- **Errors keep their attempts.** `mapLoopFailure` wraps the last error in a `ChainFailedError` that
  keeps its original kind and retryable flag *and* carries the attempt list and the loop detail. A
  failed trace then has the attempts *and* "What the AI saw".
- **Outcome means the right thing.**

  | Outcome | Runs it covers |
  |---|---|
  | `failed` | the AI could not produce an answer: chain errors, empty answer, not configured, quota, local limit |
  | `refused` | a deliberate policy stop: role gate, skill scope, provider terms, the guard's leak block |

  No migration is needed: the outcome values are unchanged and only the mapping moves. Existing rows
  stay as they are.
- **Failure turns.** A failure reply is appended as an assistant turn carrying the failure trace id. The
  transcript shows it as a red "Failed" turn: the classified title, the model that failed last, the
  provider message (D1), and "View details".
- **Conversations list.** It gets a **Failed** badge and a failed-turn count, joined from traces through
  the existing `assistant_traces_conversation` index.
- **Empty answers explain themselves.** The adapter's empty-answer error carries the finish reason, the
  token counts (including reasoning) and the upstream provider. The classification gains
  `provider-empty-answer`, separate from a malformed response, with the hint "the model may have spent
  its whole output budget reasoning; raise *Max output tokens* or move it down the chain".
- **Log correlation.** Every assistant log line carries `runId`. The trace page shows a copyable
  `journalctl -u bananasaurs --grep <runId>` line. Add one `info` line per finished run (model, ms,
  tokens, outcome) and one per fallback or skip.
- **The AI log channel embed** names the failure code and the last model tried (D3).

### 4.4 Live dashboard (Slice 3)

- **API.** All routes need `audit.read`, the same as History.
  - `GET /api/assistant/runs?active=1` returns the in-flight runs.
  - `GET /api/assistant/runs?limit=…` returns recent runs, with the run's state and current stage.
  - `GET /api/assistant/runs/:runId/events?after=<seq>` returns the incremental step log.
- **`useLiveResource` hook.** It wraps `useResource` with the 2 s / 15 s cadence (§4.1) and the
  hidden-tab pause.
- **History.** An **In progress** panel above the table. Each in-flight run shows who asked, the
  channel, a stage label, a stopwatch, and "attempt 2 of 4, retrying at 13:05:10 after
  provider-connect-timeout" or "waiting in queue behind 1 job". Finished runs drop into the table
  without a reload.
- **Conversations.**
  - The list marks conversations with a run in progress.
  - An open transcript shows a pending bot turn with the live stage, which becomes the real answer, or
    a Failed turn, when the run finishes.
- **Run detail** (the existing trace page, reachable while running by run id). It gets a **Step log**
  tab: a waterfall of the events with durations, updating live. The existing Summary, Model, Prompt,
  Tool calls and Errors tabs fill in once the trace lands.

**Stage labels** are plain English, from the current event:

- "Queued (2nd in line)"
- "Reading the conversation"
- "Searching club resources"
- "Asking nemotron-3-ultra (model 1 of 2)"
- "Running tool: search_messages"
- "Model failed (404, no endpoints), trying space-bunny-alpha"
- "Posting the answer"

### 4.5 Model health and alerts (Slice 4)

- **Per chain entry, over the last 24 h and 7 d,** computed from `model-result` events:
  - calls, success rate, p50/p95 latency, tokens;
  - failures by code;
  - the last error, with its provider message and when it happened;
  - the last success.
- **Where it shows:**
  - a column group in *Providers → Model order*;
  - a compact "Model health" card on History.
- **Persistent-failure banner** (display only). It appears on the dashboard and as a `doctor` warning
  when a chain entry's **last 3 calls** all failed with a non-transient code:
  - `provider-bad-model`, `provider-auth` or `provider-credits`. A daily quota resets by itself, so
    it doesn't qualify (ADR 0129 §8).

  Example: "space-bunny-alpha has failed 10 times since 12:54 with HTTP 404 (no endpoints). Remove it
  from Model order." It links straight to the chain editor.
- **Usage strip.** Failures are split by code. Tokens (and cost, D4) are split per model.

---

## 5. Slices

Each slice is independently shippable, with gates (`typecheck && lint && test`) green on its own.

| Slice | Contents | Migration | Size |
|---|---|---|---|
| **1. No silent failures** | §4.3 in full: terminal-path traces (G1, G2, G4), the outcome remap (G5), failure turns and badges (G3), adapter empty-answer detail (G6), the provider message (G7, if D1), `runId` on logs and the success line (G10), log-channel detail (G11). | none | M |
| **2. Run ledger** | ADR 0129. Migration 0102 (two tables). `RunRecorder` threaded through job, service and tool loop. Events from §4.2. Retention wiring. Repository with guild scope in the signature and Zod at the boundary. | 0102 | L |
| **3. Live dashboard** | §4.4: three routes, `useLiveResource`, the In-progress panel, live transcript turn, Step log tab. | none | M |
| **4. Model health** | §4.5: stats query, Providers columns, History card, banner, `doctor` line, usage strip by code and model. Cost capture (D4) lands here, with an adapter change and a live probe first. | none | M |

**Delegation** (per `docs/22`): each slice gets a brief file and an implementer, then a sonnet task
review. The final whole-branch review is Claude. The thinnest end-to-end slice is Slice 1's
"404 bad model → failed trace + failed turn visible on both pages". Build it first and drive it with
the fake provider before widening.

---

## 6. Tests to write first

- **G1 regression:** the chain is `[empty answer, 404 bad model]`. Expect one `failed` trace with both
  attempts, non-empty `sections`, a failed assistant turn linked to it, and the member reply unchanged.
  The test is written against today's code and must fail before the fix.
- **Coverage of terminal paths:** a table-driven test asserts every terminal path writes exactly one
  trace and, where there is a conversation, one turn. The paths are answered, refused × 4 reasons, and
  failed × quota, local-limit, retryable-exhausted, non-retryable, empty-answer and not-configured.
- **Outcome mapping:** empty answer and not configured → `failed`; terms, role and scope → `refused`.
- **Secrets (D1):** a key-shaped string in a provider error never reaches a trace, an event, an API
  response or the log channel. This is an allowlist test on the stored field.
- **Guild scope:** the runs and events repos have no function without `scope`. A cross-guild read
  returns nothing. The constraint rejects a non-snowflake guild id.
- **Replay:** a job retry after a crash continues the same run with a new `attempt`, never duplicates
  a `seq`, and never writes a second trace for the same attempt.
- **Recorder failure:** a throwing recorder does not change the run's outcome or reply.
- **Live API:** `?after=seq` returns only newer events, and `audit.read` is required.
- **Polling hook:** a fake timer test covers the cadence switch and the hidden-tab pause.
- **Health:** three consecutive `provider-bad-model` results raise the banner; one transient
  `provider-connect-timeout` doesn't.

---

## 7. How we'll know it worked (after deploy)

1. Put a nonexistent model id last in the chain, make the first model fail (Try-it with a bad key
   entry), and ask the bot something in Discord. While it runs, History shows an In-progress row
   stepping through stages. Then it shows a `failed` row whose Model tab names the 404 and its message.
   The conversation shows a red Failed turn.
2. Ask two questions back to back. The second shows "Queued (2nd in line)" until the first finishes.
3. After three failures, the banner names the dead model, and `npm run doctor` prints the same warning.
4. `journalctl -u bananasaurs --grep <runId>` from the trace page returns that run's lines and no
   others.

---

## 8. Out of scope / deferred

- **Parallel job execution (G12).** Making the worker run an assistant job alongside other jobs is a
  real latency fix, but it changes the single-writer job model. This plan only *shows* the queue wait.
  It gets its own ADR if you want it.
- **OpenTelemetry export.** The event names follow the GenAI semantic conventions' vocabulary (§9), so an
  exporter could be added later. Exporting means a new outbound destination (hard rule 8), so not now.
- **Automatic chain changes.** Never. Health is advisory (hard rule 1).
- **Raw provider error bodies** (`error.metadata.raw`). These can be large and can echo request
  content. Only the sanitized 160-character message is kept (D1).
- **OpenRouter `/generation` lookups.** These would be an extra call per request. Cost comes from the
  response itself (D4).

---

## 9. Research notes

- **OpenRouter errors** carry `error.metadata.provider_name` and `error.metadata.raw`. Each successful
  response has a generation id whose stats give exact cost, native tokens and the serving provider. If
  an error happens after streaming starts, it arrives inside `choices`, not as an error response.
  ([errors and debugging](https://openrouter.ai/docs/api/reference/errors-and-debugging.md))
- **Empty `content` from reasoning models.** The reasoning phase can consume the whole `max_tokens`
  budget, leaving `message.content` empty while `message.reasoning` is filled. Requests that send no
  `reasoning` control leave this to the model's default.
  ([reasoning tokens](https://www.openrouter.ai/docs/guides/best-practices/reasoning-tokens))
  This matches nemotron's "returned no text". Slice 1 records the evidence (finish reason, reasoning
  tokens) before any fix is chosen.
- **OpenTelemetry GenAI conventions** name what an LLM span should carry:
  - requested and served model;
  - input, output, reasoning and cache tokens;
  - finish reasons;
  - error type;
  - time to first token.

  ([gen-ai attribute registry](https://opentelemetry.io/docs/specs/semconv/attributes-registry/gen-ai),
  [overview](https://www.dash0.com/knowledge/opentelemetry-genai-semantic-conventions-explained))
  The `model-result` event covers all of these except time to first token, which needs streaming,
  and the bot doesn't stream.
- **To verify during Slice 1 and Slice 4, not assumed:** whether OpenRouter's non-streaming response here
  includes a top-level `provider` field, `usage.cost`, and
  `usage.completion_tokens_details.reasoning_tokens`. Check with one live probe against the same host,
  and add fields to the Zod schema as optional.
