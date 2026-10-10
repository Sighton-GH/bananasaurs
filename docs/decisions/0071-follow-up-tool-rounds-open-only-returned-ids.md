# 0071. Follow-up tool rounds open only returned IDs

Date: 2026-09-24
Status: Accepted (owner approved spec 2026-09-24) Amended by ADR 0137.

## Context

ADR 0067 allows exactly one tool round, because hard rule 3 says a turn whose
only new input is retrieved text may not emit a tool call. The owner decided
(spec decision O2) to allow follow-up rounds that only open things an earlier
result already identified, so injected text cannot steer a new search.
Implements spec Part D section D2, and amends hard rule 3 and ADR 0067.

## Decision

- Round 1 offers every read-only tool the behaviour allows: `search_sources`,
  `list_sources`, `read_chunk`, `outline`, `open_resource`, `search_archive`,
  `web_search`, `server_info`, `current_time`, `my_reminders`,
  `refresh_source`. The model may make several calls in parallel (cap 6).
- Rounds 2–4 offer only ID tools: `read_chunk(chunkId)`,
  `outline(docId)`, `open_resource(resourceId)` (parameter names follow the
  tool catalogue's camelCase; a drift test pins them). Every ID argument must
  appear in the handle set: the IDs returned by earlier results in this same
  request, or in the resource catalogue the harness itself put in the prompt.
  Anything else is refused with the result text "unknown id" and a trace
  entry. No free-text query, web search or refresh after untrusted text has
  been read, so injected text cannot steer a new search or leak data through
  a query.
- Stop conditions: the model answers in text; 4 rounds; 12 tool calls in
  total; or about 24,000 characters of tool results. On a stop without an
  answer, one final call is made with no tool declarations and the instruction
  "Answer now using the results above; do not call tools."
- Tool calls are never executed from text. Only native, structured calls run,
  each through its Zod schema (hard rule 3).
- Output budget: `maxOutputTokens` is 2,048. Gemini gets an explicit
  `thinkingConfig.thinkingBudget` (512 for tool rounds, 1,024 for the answer).
  Thinking tokens are recorded in the trace.
- Results are compact: every tool returns short, bounded text with IDs (spec
  F4), never whole documents.

## Consequences

The model can read a page it found without a second free-text search, which
is what ADR 0067 forbade for lack of a safe rule. The handle set is the safe
rule: anything not previously returned is refused. Hard rule 3 now carries
the exception "except a call that opens an ID an earlier result in the same
request returned".
