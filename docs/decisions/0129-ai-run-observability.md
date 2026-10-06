# 0129. AI run observability: no silent failures, a run ledger, live progress

Date: 2026-10-06

Status: accepted (owner decisions D1–D4, 2026-10-06; plan `docs/27_AI_OBSERVABILITY_PLAN.md`)

## Context

On 2026-10-06 ten assistant requests failed and nothing on the dashboard showed it. Three things went
wrong:

- `mapLoopFailure` rethrew a raw `ProviderError` when the chain's last attempt was an `error`.
- The job wrote a failure trace only for `ChainFailedError`.
- A failure reply was never saved as a conversation turn.

Empty answers dropped the finish reason and token counts, so they could not be diagnosed. Nothing
recorded a run until it ended, and the dashboard never refreshed by itself.

## Decision

1. **Every terminal path writes exactly one trace.** This covers answered, refused, failed, quota,
   local limit, deleted behaviour and channel-not-writable.
   - A failed chain always throws `ChainFailedError`. It keeps the last error's kind, retryable flag
     and quota scope, and carries the attempts and the loop detail. "What the AI saw" therefore
     exists for failures too.
   - A failure reply is saved as the assistant turn and linked to its failure trace.
2. **Outcome.**
   - `failed` means the AI could not produce an answer: chain errors, empty answer, guard failure,
     not configured, quota, local limit.
   - `refused` means a deliberate policy stop: role gate, skill scope, provider terms, a deleted or
     disabled behaviour, a channel that is not writable, IT routing not configured.
   - `ok: false` results carry an explicit `outcome`.
3. **Provider message (partly reverses ADR 0079 §3).**
   - Each failed attempt stores `providerMessage`: the adapter's sanitized short reason, scrubbed of
     key-shaped strings by `sanitizeProviderMessage`, at most 160 characters.
   - API responses include it only for `config.read`.
   - It never goes to Discord, including the AI log channel.
4. **Empty answers explain themselves.**
   - Adapters attach to the error: finish reason, completion and reasoning tokens, the upstream
     provider, and whether reasoning text was returned without an answer.
   - New code `provider-empty-answer`.
5. **Run id.**
   - `runId` is the invocation id. Every assistant log line carries it, and the trace stores it.
   - The trace page shows a `journalctl --since/--until` window for the run.
6. **Run ledger** (migration 0102).
   - `assistant_runs` holds one row per invocation, updated in place.
   - `assistant_run_events` is an append-only step log: metadata only, never message text.
   - Both are guild-partitioned, with the guild in every repository signature.
   - Recorder failures are logged and never change a run's outcome.
   - Deleted with their conversation. Runs with no conversation are deleted after 30 days.
7. **Live dashboard by polling.**
   - Every 2 s while anything is in flight, 15 s otherwise, paused while the tab is hidden.
   - No SSE or WebSocket, and no new dependency.
8. **Model health is advisory.**
   - A chain entry whose last 3 calls all failed with `provider-bad-model`, `provider-auth` or
     `provider-credits` raises a dashboard banner and a `doctor` warning.
   - Nothing changes the chain automatically (hard rule 1).
9. **Cost.** OpenRouter requests send `usage: { include: true }`, and the reported cost is recorded
   when present. Same host; no new destination.

## Consequences

- History and Conversations show every request that reached the job, including how it failed.
- Traces and events grow slightly per run. Retention is unchanged for traces, and the ledger follows
  it.
- `PRIVACY.md` discloses that provider error text and per-step run metadata are stored.
