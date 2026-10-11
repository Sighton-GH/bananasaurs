# 0147. Parallel as a third web-search source

Date: 2026-10-11

Status: accepted (owner request and decision D11, 2026-10-10: fast mode, training disclosure accepted).

## Context
Web search runs Brave or Tavily through one `WebSearchRun` shape (ADR 0120). The owner asked for Parallel as one more source beside them.

## Decision
1. REST, not MCP: `POST https://api.parallel.ai/v1/search` with header `x-api-key`; fixed body `{ objective, search_queries: [query], mode: "fast" }`, first 5 results mapped to `WebResult` with each excerpt capped at 1,000 characters. The `objective` is the model's query through the same local query scan; no member text is added.
2. Fits ADR 0120 unchanged in shape: `search_source` gains `parallel`; keys live in `assistant_search_keys` with the same sealed storage, ordering, limits and reserve-before-send. Default monthly limit for a new Parallel key is 4,500 (under the 5,000 free allowance; fast is $1 per 1,000 after that).
3. Hard rule 5: provider-eligibility row `parallel` with `trainsOnInput: "yes"` (customer terms §4(b): Parallel may use queries to train), cited clause and review date; warnings in the log and dashboard, plus a PRIVACY.md line. Queries are model search terms (member names already forbidden), not member messages.
4. Hard rule 8: `api.parallel.ai` is a new outbound destination on the owner's 2026-10-10 instruction, recorded here.

## Consequences
- One migration widening the `search_source` CHECKs. Doctor has no search-terms surface, so it is unchanged; Slice 6 owns the doctor line.
