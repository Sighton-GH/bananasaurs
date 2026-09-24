# 0076. Assistant traces

Date: 2026-09-24
Status: Accepted (owner approved spec 2026-09-24)

## Context

Assistant history is one shallow line per run under Advanced / System
(`outcome`, `detail`), which cannot explain why an answer came out the way it
did. Implements spec Part B section B2.

## Decision

- Every assistant run writes one trace (new table `assistant_traces`,
  guild-scoped, deleted along with its conversation by the prune job). The
  History list shows time, who asked, channel, behaviour, outcome, model,
  duration and tokens, and filters by outcome, behaviour and member.
- Clicking a row opens `/assistant/history/:traceId` with Summary (question,
  answer as posted, outcome, Discord message link, conversation link), Model
  (each provider/model attempted in order with the reason it moved on, plus
  finish reason and prompt / answer / thinking tokens), Prompt (every section
  with character count and estimated tokens, each expandable to its exact
  text), Tool calls (round, tool, arguments, a result preview of the first
  1,500 characters, ok/refused, duration, and why a call was refused),
  Timeline (queued to posted, with durations) and Errors (provider error kind
  and message, never a key).
- Trace JSON is capped at 200 KB. Viewing prompt text needs `config.read`.
- A 14-day daily usage strip (answers, failures, fallbacks, tokens per day)
  sits above the History table.

## Consequences

Debugging moves from one log line to the full run: what the model saw, what
it called, what it cost, and where it failed. Traces inherit conversation
retention, so they disappear with the conversation they belong to.
