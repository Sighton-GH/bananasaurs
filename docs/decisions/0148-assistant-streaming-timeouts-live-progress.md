# 0148: Assistant streaming, idle timeout, finish reasons, live buffer, saved thinking

## Context

Job-lanes merged, so the body-read code it wrapped can be replaced with streaming. OpenRouter sends `: OPENROUTER PROCESSING` keepalive comments and reports mid-stream failures as `finish_reason: "error"` inside a 200 response. Gemini 3 uses `thinkingConfig.thinkingLevel` (`low` tool rounds, `medium` answer; never `minimal`, which errors on 3.8 Flash) with `includeThoughts: true` for thought summaries. The 60 s job-lanes total becomes time-to-first-byte. Slice 6 merged first and left real capability tables (`GEMINI_MODEL_TABLE`, daemon `capabilitiesForEntry`), persistent cooldowns and the escalation hand-over (light round 1 → standard from round 2). D5(b) keeps thinking live plus saved in the trace; ADR 0129 stays metadata-only for the ledger.

## Decision

1. Stream every provider: OpenAI-compatible sends `stream: true` plus `stream_options: { include_usage: true }`, parses SSE `data:` lines, ignores `:` comments, assembles `delta.content`, `delta.reasoning`, `delta.tool_calls` (args concatenated per index, parsed when complete); Gemini calls `:streamGenerateContent?alt=sse`, assembling text, `functionCall` and `thought: true` parts separately, echoing raw parts back so thought signatures survive tool rounds.
2. Timeouts: idle `assistant.providerIdleTimeoutMs` 45,000 re-armed on every byte (keepalives count); ceiling `assistant.providerMaxCallMs` 300,000; `assistant.providerTimeoutMs` 60,000 becomes time-to-first-byte. Typing stays alive with its ceiling raised to the hard ceiling for the run.
3. Finish reasons: `error` or `choices[].error` → retryable `ProviderError`, partial text discarded and never delivered or stored (only the progress counters already emitted remain); `length`/`MAX_TOKENS` with text → delivered with code-built `\n\n-# (cut short)` after the guard; `length` with no text → today's empty-answer path. `maxOutputTokens` default 2,048 → 4,096.
4. Progress: `model-progress { round, answerChars, reasoningChars, keepalives, msSinceLastByte }` at most every 3 s per run on one shared throttle across the escalation hand-over, bumping `updatedAt`; renders as `Receiving… 1,240 chars of answer, 3,100 chars of thinking`. On Discord the only change is the typing indicator, kept alive while bytes arrive.
5. Live text: in-memory per-run buffer capped at 8,000 chars each of answer and thinking; `GET /api/assistant/runs/:runId/live` gated like traces; StepLog polls every 2 s (no browser SSE); buffer dropped at finish; thinking saved under trace `reasoning` per round, capped. A thinking parameter is never sent when the entry capabilities forbid it: OpenRouter gets `reasoning: { exclude: false }` only for `reasoning: true` models (NIM never); Gemini sends `thinkingLevel` only for `levels` models, legacy `thinkingBudget` only for `budget` models, and neither plus no `includeThoughts` for `none` models. Gemini returns thought summaries via `includeThoughts`. A model that exposes no reasoning shows only the progress counters.

## Consequences

- One trickling stream can hold a job lane up to 300 s by design; four lanes stay the cap.
- Thinking text may echo member messages; it is visible with trace capability only, noted in PRIVACY.md, and deleted with the conversation.
- No new outbound destination; no migration. No new Discord side effect: the typing indicator is best-effort as today.
