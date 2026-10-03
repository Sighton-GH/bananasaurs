# 0066. Web search through the Brave Search API

Date: 2026-09-23
Status: accepted (owner decision 2026-09-23)
Amended by ADR 0120 (Tavily as a second source, several keys, per-key limits).

## Context

The owner wants the assistant to search the internet. The first choice was
Gemini's Google Search grounding. Its terms require grounded results to be
shown together with Google's Search Suggestions, an HTML widget that Discord
cannot render, so the owner chose the Brave Search API instead.

## Decision

- A read-only `web_search` tool calls
  `https://api.search.brave.com/res/v1/web/search` with the
  `X-Subscription-Token` header. This is a new outbound destination, added on
  the owner's explicit instruction (hard rule 8).
- The key is saved write-only from AI setup and sealed like the provider key.
  Web search is off until a key is saved and switched on.
- Results are evidence, never instructions (hard rule 3). They are redacted
  like other evidence, and they are held only for the request (Brave terms
  §3(b)(i): transient storage only). The log channel records result links,
  never result text.
- An answer that used web results ends with "Powered by Brave Search" (Brave
  terms §4(d)).

## Consequences

Brave's terms §3(b)(xiii) forbid using results to "train… or otherwise improve
artificial intelligence models or services". While the configured AI provider
trains on what it is sent (ADR 0062, Gemini's free tier), Brave results sent
to it may be used for that training. The owner was told this. A no-training
provider tier removes the conflict. Brave's free allowance is $5 of credit a
month (about 1,000 searches).
