# 0120. Tavily web search, several search keys, and per-key limits

Date: 2026-09-30

Status: accepted (owner decision 2026-09-30). Amends ADR 0066.

## Context

The owner wants web search that costs nothing and works with every AI
provider in the chain. Three options were researched and rejected
(`docs/24_OPENROUTER_WEB_SEARCH_PLAN.md`):

- **OpenRouter's server-side search.** It only works when an OpenRouter
  model answers. It skips the local query scan, and it breaks ADR 0071
  unless it is capped.
- **DuckDuckGo.** It has no search API. Its HTML endpoint answers a bot
  that honestly names itself with a 403, so using it means disguising the
  bot as a browser. We will not do that.
- **Stacking several free Brave accounts.** Brave's terms forbid it: "circumvent or
  bypass rate limits or service limits through any method, including by
  creating multiple accounts".

The owner chose Tavily and kept Brave as an option. The owner also asked for
dashboard limits that keep a key under its free monthly allowance, and for
several keys.

## Decision

1. **A web search source**: `brave` or `tavily`. The column is
   `assistant_provider_config.search_source`, default `brave`, so existing
   installs keep Brave. `search_enabled` stays the on/off switch. Only
   the instance owner may change either.
2. **Tavily is a new outbound destination** (hard rule 8, owner instruction
   2026-09-30): `POST https://api.tavily.com/search` with a
   `Authorization: Bearer` key. The request is fixed:
   - `search_depth: "basic"` (1 credit)
   - `max_results: 5`
   - `chunks_per_source: 2`
   - `safe_search: true`
   - no answer, raw content or images

   Keyless mode is not used: its cap is unpublished, and it answers an
   over-limit request with instructions addressed to "your agent".
3. **Several labelled keys per source**, in their own table,
   `assistant_search_keys`. Each key is sealed like provider keys and
   instance-level like them, and it is tried in the order the owner sets.
   The saved Brave key is copied in as the first Brave key, labelled
   "Brave key", with a limit of 1,000. The old `search_api_key_enc`
   column is kept but no longer read.
4. **Per-key limits** (owner request): a nullable `monthly_limit` and a
   nullable `daily_limit`. A new key's monthly limit defaults to 1,000.
   - **Windows are sliding**: 31 days for the monthly limit, 24 hours for
     the daily one. A calendar month is not used, because a provider's
     billing cycle can start mid-month, and calendar counting could then
     spend up to twice the limit inside one provider cycle. A sliding
     31-day window keeps every window of 31 days or fewer at or under the
     limit, whatever the provider's reset day.
   - **Reserve before sending**, as ADR 0081 does. The limit check and the
     insert into `web_search_calls (key_id, at, guild_id)` run in one
     synchronous transaction. A failed call still counts. Rows older than
     32 days are pruned.
5. **Key order.** For each search, the source's enabled keys are tried in
   order:
   - A key at its limit is skipped without being called.
   - A key the provider refuses is skipped to the next key. This covers
     HTTP 401, 402, 403, 429, 432 and 433; the call still counts.
   - A timeout or any other error ends the search.
   - If every key is at its limit, the tool returns "Web search has
     reached its limit for now", and the model answers without it.
6. **Provider error bodies are never passed on.** Neither the model, the
   logs nor the member sees them. The clients keep only the HTTP status.
   This applies hard rule 3 to Tavily's natural-language limit messages.
7. The "Powered by Brave Search" line (Brave terms §4(d)) is added only to
   answers that used a Brave result.
8. Every existing guard stays in front of both sources:
   - the local query scan (no personal data, no secrets)
   - result redaction as evidence
   - web search in round 1 only (ADR 0071)
   - log-channel links only
9. `BRAVE_SEARCH_API_KEY` in `.env` is used only when the daemon has no provider key store (no encryption secret), as before; it is never limited. With a key store, search keys come only from the dashboard.

## Consequences

- **Tavily keeps queries.** Its terms (§9.2, §6) grant a broad licence to
  keep and use queries, including for AI training. PRIVACY.md says so, and
  the dashboard shows it next to the Tavily option.
- **Several keys are not for stacking free accounts.** Brave forbids it,
  and Tavily requires staying within its usage caps (§3.1). The dashboard
  says this next to "Add key".
- **The limits only count this bot's calls.** Another client using the
  same key still spends the provider's allowance, and Bananasaurs cannot
  see those calls, so the owner should leave a margin.
