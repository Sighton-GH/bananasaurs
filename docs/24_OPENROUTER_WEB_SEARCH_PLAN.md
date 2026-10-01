# 24. OpenRouter web search: research and plan

**Status: DRAFT, 2026-09-30. Needs owner decisions W1–W4 before any code.**
Proposed ADR: 0120 (0110–0119 are reserved for the MCP connector).

## 1. What OpenRouter offers

Source: OpenRouter docs, `guides/features/server-tools/web-search.mdx` and
`guides/features/server-tools.mdx`, read on 2026-09-30. Server tools are
marked **Beta** ("The API and behavior may change").

There are three ways to turn it on. Only one is current:

| Mechanism | Status | Behaviour |
|---|---|---|
| `model: "x/y:online"` | deprecated | Always searches once, before the model runs |
| `plugins: [{ id: "web" }]` | deprecated | Same as `:online` |
| `tools: [{ type: "openrouter:web_search", parameters: {…} }]` | current (beta) | The model decides whether to search, 0–N times. OpenRouter runs the searches inside the same HTTP request |

The server tool can sit in the same `tools` array as our own `function`
tools. OpenRouter runs its own tool and returns only our function calls
to us.

Parameters that matter here:

- `engine`: `auto` (the default: the provider's native search if the
  model has one, otherwise Exa), `native`, `exa`, `parallel`,
  `perplexity`, or `firecrawl` (bring your own key).
- `max_uses`: a hard cap on searches per request.
- `max_results` (1–25, default 5), `max_total_results`, and
  `search_context_size` / `max_characters`, which bound the size of the
  results.
- `allowed_domains` / `excluded_domains`. Native Google search supports
  neither; with `auto` it falls back to Exa.
- The top-level request field `max_tool_calls` (default and maximum 30)
  is the server-tool step budget for the whole request.

The response reports `usage.server_tool_use.web_search_requests`.
Citations arrive as `url_citation` annotations on the message.

Pricing is charged to OpenRouter credits, **including on `:free` models**:

- Exa: $0.007 per search (up to 10 results)
- Parallel: $0.001–0.005
- Perplexity: $0.005
- Native search: the provider's own price, passed through. Anthropic
  and OpenAI native search both cost more than Exa.

## 2. How it differs from the Brave tool we already have (ADR 0066)

Today `web_search` is one of our own tools. It runs through
`apps/daemon/src/assistant/tools.ts:771`, and the harness keeps control
at every step:

| Guard | Brave (ours) | OpenRouter server tool |
|---|---|---|
| Local secret/PII scan of the query before it leaves (`scanOutboundRequest`) | yes | **no**: the model writes the query and OpenRouter sends it; we never see it first |
| Results redacted as evidence before the model reads them | yes | **no**: the model reads the raw results inside OpenRouter |
| ADR 0071: no free-text search after untrusted text has been read | enforced (web search is round 1 only) | **broken by default**: the model can search, read, then search again. `max_uses: 1` fixes this |
| Hard rule 3: a turn whose only new input is retrieved text may not emit a tool call | enforced | **broken by default**: in one response the model can read web text and then emit a `set_reminder` or `search_archive` call. The harness has to treat those calls as tainted (see §4) |
| Trace / "what the AI saw" (ADR 0088) | full result text | citation URLs only, plus the search count |
| Log channel records the result links | yes | yes, from the annotations |
| Works with every provider in the chain (ADR 0075) | yes | **OpenRouter entries only**. A Gemini or NIM fallback answers without search |
| New outbound destination from our process | `api.search.brave.com` | none: still only `openrouter.ai` |
| Who else receives the query | Brave | Exa, or the model's own provider (native), chosen by OpenRouter unless we pin `engine` |

**Upside:** no second key, and no second account or allowance. Search
quality is probably better: native search on Claude, GPT and Gemini
models, and Exa returns page excerpts where Brave returns snippets. It
also removes the Brave terms problem: the "Powered by Brave Search" line
and the §3(b)(xiii) training conflict both go away for OpenRouter
answers.

**Downside:**

- We lose the local query scan.
- A beta API sits on the answer path.
- Every search costs money, even when the model is free.
- The guard in §4 adds harness code.

## 3. Owner decisions needed

These change privacy and cost exposure, so CLAUDE.md requires the owner
to decide them.

- **W1. Accept losing the local query scan?** The model is already told
  "Never put names, contact details or private club information in the
  query", but nothing enforces it. The residual risk is private club
  text reaching Exa or the native search backend. The native provider
  already receives the whole conversation, so for native search the
  extra exposure is small. For Exa it is a new data processor.
  **Recommendation:** accept, pin `engine` (W2), and add Exa to
  PRIVACY.md with a terms record (hard rule 5: `trainsOnInput`, the
  cited clause, a review date).
- **W2. Which engine?**
  - Recommended: **`exa`, pinned**, with `max_uses: 1`,
    `max_results: 5`, `search_context_size: "low"`, and
    `max_tool_calls: 1`. This gives one known processor, one terms
    record, and a predictable $0.007 per search. `auto` would send the
    query to whichever backend OpenRouter picks per model, and the
    price would vary.
  - Alternative: `auto`, if you want native Claude/GPT/Gemini search
    quality and accept variable cost and processors.
- **W3. Relationship to Brave.** Choose one:
  - **(a)** A single "Web search source" setting: *Off / Brave /
    OpenRouter*. Recommended: it is simple and there is never a double
    search.
  - **(b)** OpenRouter when the answering entry is OpenRouter, Brave for
    every other provider (both configured).
  - **(c)** Remove Brave.

  (a) keeps Brave available for a Gemini-only setup.
- **W4. Spend cap.** OpenRouter credits pay for searches even on `:free`
  models. Options:
  - a daily search cap per guild, counted from `web_search_requests` in
    our own table
  - relying on an OpenRouter key credit limit set on openrouter.ai
  - both

  **Recommendation:** both. The local cap is a few lines, because the
  per-entry RPD machinery from ADR 0081 already exists.

## 4. Implementation sketch (after W1–W4)

This is the thinnest slice. The tests below are written before any code,
because this touches guild scope and the hard-rule-3 guard.

1. **ADR 0120**: records W1–W4, amends ADR 0066/0071 for the server tool,
   and adds the Exa terms record and a PRIVACY.md entry.
2. **Storage** (migration). Two changes to `assistant_provider_config`:
   - `search_source TEXT NOT NULL DEFAULT 'brave' CHECK IN
     ('brave','openrouter')`. The existing `search_enabled` stays the
     on/off switch.
   - An OpenRouter search settings column: engine and max results,
     validated with Zod.

   The migration backfills existing rows to `brave`, so behaviour is
   unchanged.
3. **Provider contract** (`packages/core/src/providers/contracts.ts`):
   - Add an optional `serverWebSearch?: { engine, maxResults }` to
     `GenerateTextRequest`, and a new capability `'server-web-search'`
     that only `id === 'openrouter'` advertises.
   - Add `webSearchRequests` and `citations[]` to
     `GenerateTextResponse`.

   Gemini and NIM ignore the field. Their capability set says they
   cannot search.
4. **Adapter** (`openai-compatible.ts`):
   - Append `{ type: 'openrouter:web_search', parameters: { engine,
     max_uses: 1, max_results, search_context_size: 'low' } }` to `tools`,
     plus top-level `max_tool_calls: 1`.
   - Extend `responseSchema` with `message.annotations[]`
     (`url_citation`: url and title) and
     `usage.server_tool_use.web_search_requests`.
   - Citation URLs must match `^https?://`, the same filter Brave
     results use.
5. **Harness** (`apps/daemon/src/assistant/service.ts` + `tools.ts`):
   - Attach the server tool only on **round 1**, and only when the
     source is `openrouter` and the answering chain entry is OpenRouter.
     Rounds 2–4 and the final "answer now" call never carry it (ADR
     0071).
   - Declare our own Brave `web_search` function only when the source
     is `brave`. The model never sees two search tools.
   - **Taint guard:** if a response reports `webSearchRequests > 0`, it
     is treated as post-untrusted:
     - Any **acting** tool call in it (`actsForSkill` set) is refused.
     - Any free-text-query tool call in it (`search_sources`,
       `search_archive`, `search_conversations`, `refresh_source`) is
       refused.
     - Only ID tools with handles from the harness's own catalogue
       survive.

     The model gets "unknown id / refused after web search" and the
     trace records it.
   - Citations become `sources` on the answer, the same "Sources" line
     and log-channel links as today. The Brave attribution is omitted
     for OpenRouter answers.
   - Per-guild daily search counter (W4). At the cap, drop the server
     tool for the rest of the day.
6. **HTTP + dashboard**:
   - `PUT` on the existing web-search route accepts `source`.
   - The `providers.tsx` web-search card gets a source selector: Brave
     (needs a key) or OpenRouter (needs an OpenRouter key in the chain;
     shows the price per search and the Exa privacy note).
   - The `assistant-skills.tsx` tool card text follows the source.
   - The doctor warns when the source is OpenRouter but no chain entry
     is OpenRouter.

**Tests first:**

- The adapter serialises the server tool only when asked, and parses
  annotations and usage. Uses a recorded fixture.
- The harness never attaches the server tool on rounds 2+ or on
  non-OpenRouter entries.
- **The taint guard refuses an acting call and a free-text search call
  in a response with `web_search_requests: 1`.** Watch it fail first.
- The source switch declares exactly one search tool.
- The daily cap drops the tool at the limit, scoped per guild.
- Migration: an existing row reads as `brave` with the same `enabled`
  value.

**Unverified until a live call** (one manual request with the owner's
key, never in `npm run test`):

- the exact annotation shape on `/chat/completions` when the model also
  returns function `tool_calls`
- whether `max_tool_calls` counts only server-tool steps
- the error and HTTP status when credits run out mid-search, which is
  probably a 402 and so `quota` under ADR 0079

## 5. Considered: DuckDuckGo

Rejected. DuckDuckGo has no web search API. Its one public API,
`api.duckduckgo.com` (Instant Answers), returns a Wikipedia-style abstract
and related topics. It does not return web results. This was tested on
2026-09-30:

- `q=Python` gave 0 results and 10 disambiguation topics.
- `q=discord.js v14 release notes` gave 0 results, 0 topics and an empty
  abstract.

Every library that "searches DuckDuckGo" (for example the MIT-licensed
Python `ddgs`) works by posting to `html.duckduckgo.com/html` or `/lite`
and parsing the page.

- **Robots rules.** `duckduckgo.com/robots.txt` disallows `/html` and
  `/lite` for all user agents. The `robots.txt` on
  `html.duckduckgo.com` itself says `Allow: /`.
- **Terms.** The Terms and the Acceptable Use Policy were read on
  2026-09-30. They do not name automated queries or scraping. They do
  forbid access "without authorization" and anything that interferes
  with "the integrity or performance of the services", and DuckDuckGo
  may suspend access. This is a grey area, not an explicit ban. An
  earlier line in this draft said it was "outside DuckDuckGo's terms",
  which overstated it.
- **Reliability.** DuckDuckGo rate-limits and challenges automated
  traffic, so this can break without notice.

The goal behind the question, search that works for every AI provider, is
already met by the Brave tool. It is our own function tool, so Gemini,
OpenRouter and NIM entries all get it.

### Findings on 2026-09-30, after the owner approved Option D

- **DuckDuckGo refuses an honest bot.** A single `POST
  html.duckduckgo.com/html/` with the User-Agent `Bananasaurs/0.1
  (self-hosted Discord bot)` returned **HTTP 403**, an error page with no
  results. The same request with a Firefox User-Agent returned HTTP 200
  and 10 results. So the only way to use it is to pretend to be a browser
  and get past a block that DuckDuckGo aims at bots. That is more than
  the grey area described above. It is close to the Acceptable Use
  Policy's "access … without authorization". The build is held until the
  owner decides.
- **Brave forbids using several accounts to get more searches.** Brave
  Search API terms, prohibited uses (v): "circumvent or bypass rate
  limits or service limits through any method, including by creating
  multiple accounts". Holding several keys is still fine for legitimate
  uses: rotating a key, a paid key alongside a free one, or a spare key
  from the same account. Stacking free accounts to get past 1,000
  searches a month is not.

### Option T: Tavily (researched 2026-09-30)

Sources, all read on 2026-09-30:

- `docs.tavily.com`: `api-credits.md`, `rate-limits.md`, `keyless.md`,
  and `api-reference/endpoint/search.md`
- the Platform Terms of Service at `tavily.com/terms`, last updated
  2026-05-04
- `tavily.com/agent-setup/SKILL.md`, read for information only. It is a
  set-up script for coding agents. Its steps (install a CLI, OAuth,
  install skills globally, scan the home directory for repositories)
  were **not** followed.

**What it is.** `POST https://api.tavily.com/search` with the header
`Authorization: Bearer tvly-…`. The response is JSON: `results[]` with a
`title`, a `url`, a `content` excerpt of up to 3 chunks of 500 characters
each, and a `score`. It is built for LLM tool use.

**Cost.**
- The free plan gives 1,000 credits a month, with no credit card.
- A `basic`, `fast` or `ultra-fast` search costs 1 credit. An `advanced`
  search costs 2.
- The development-key rate limit is 100 requests a minute.
- At the plan limit the API answers **HTTP 432**; at the pay-as-you-go
  limit, 433.

**Keyless mode.** With the header `X-Tavily-Access-Mode: keyless` and no
account, search works. Tavily describes this as rate-limited and meant
for "exploration and light use", and it does not publish the cap. When
the cap is hit, Tavily "returns natural-language instructions telling
your agent what happened". That text must be handled as an error in our
code and **never** passed to the model (hard rule 3).

**Live check.** One keyless request with no disguise, sending
`search_depth: basic`, `safe_search: true`, `max_results: 3` and
`chunks_per_source: 2`. It returned HTTP 200 in 1.7 s with 3 relevant
results, each about 900–1,000 characters, and `usage.credits = 1`.

**Terms.**
- The Services are "solely for Customer's internal business purposes,
  including for integration with Customer Applications". A self-hosted
  club bot is such an integration.
- **Queries:** §9.2 gives Tavily a broad, perpetual licence to use the
  queries (Customer Input) to improve Tavily's products and to share them
  with vendors. §6 lets the "AI Functionality" inputs be used for
  training. PRIVACY.md must say that queries may be kept and used this
  way. The existing local query scan (no personal data, no secrets) stays
  in front of every Tavily request.
- **Results:** no clause was found that forbids sending results to an AI
  model. No clause was found that requires an attribution line. This is
  unlike Brave's §3(b)(xiii) training clause and its §4(d) attribution
  requirement.
- **Several accounts:** no explicit clause, unlike Brave's. §3.1 requires
  keeping within "usage caps, rate limits", so the same rule applies: no
  stacking free accounts.

**Assessment.** Tavily fits the existing `web_search` tool port exactly,
as the Brave client does. It works with every AI provider and keeps every
guard: the query scan, redaction, the round-1 rule and the log-channel
links. It needs no disguise, and it costs nothing within 1,000 searches a
month.

### Option D: a zero-cost DuckDuckGo backend (only if the owner accepts the grey area)

This follows the owner's request on 2026-09-30 for search that is
"completely free".

- The backend is written in **TypeScript**, not Python. ADR 0006 and the
  stack ADR 0008 mean one Node process and no second runtime. The HTTP
  call is one form POST plus HTML parsing, about 60 lines. We study
  `ddgs` (MIT) for its behaviour, write original code, and record it in
  PROVENANCE.md.
- It sits behind the **existing** `ports.webSearch`, as a third source:
  *Off / Brave / DuckDuckGo*. The query scan, result redaction, round-1
  rule, log-channel links and the "every AI provider" behaviour all stay.
  No Brave attribution line is added.
- It limits itself on our side:
  - at most one request every few seconds
  - a small per-guild daily cap
  - a short in-memory result cache for the request only
  - an honest User-Agent
- A challenge page or an HTTP error becomes "Web search is unavailable
  right now", not a retry loop.
- It needs ADR 0120, a new outbound destination (`html.duckduckgo.com`)
  approved by the owner (hard rule 8), and a PRIVACY.md line.

## 6. Size

About one ADR, one migration, and roughly 300–400 lines across core,
daemon, http and dashboard, plus tests. It is one slice, deliverable on
its own branch.
