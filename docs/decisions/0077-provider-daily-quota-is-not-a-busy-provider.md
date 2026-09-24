# 0077. A provider's daily quota is not a busy provider

Date: 2026-09-24

Status: accepted (owner request 2026-09-24)

## Context

The live configuration is provider `openrouter`, model
`nvidia/nemotron-3-ultra-550b-a55b:free`, no fallbacks. `GET
https://openrouter.ai/api/v1/key` reported `is_free_tier: true` and free-model
daily requests `50/50` (the cap already spent).

Before writing any code, the two OpenRouter docs pages that govern this were
read directly (not from memory), fetched 2026-09-24:

- `https://openrouter.ai/docs/api-reference/limits`
- `https://openrouter.ai/docs/api-reference/errors`

What they say, verbatim in substance:

- **Free usage limits** (`limits` page): a model whose id ends in `:free`
  allows 20 requests/minute. Per-day: 50 `:free` requests/day for an account
  that has purchased less than 10 credits, 1000/day once it has purchased at
  least 10 credits. `GET /api/v1/key` returns `is_free_tier`, `usage_daily`
  ("Number of credits used (current UTC day)") and similar weekly/monthly
  fields, confirming the daily window is the UTC calendar day. A negative
  credit balance can produce `402`s even for free models — a different case
  from the free-model daily/per-minute caps.
- **Error body shape** (`errors` page): every OpenRouter error, on
  `/chat/completions`, is
  `{ error: { code: number; message: string; metadata?: Record<string, unknown> } }`,
  with the HTTP status equal to `error.code`.
- **`Retry-After`** is the only rate-limit-related HTTP response header the
  errors page documents, and only on `429`, `503`, and a narrow `402` case
  (`error.metadata.limit_source === 'openrouter_in_flight_budget'`). It is in
  seconds. **The page does not document `X-RateLimit-Limit`,
  `X-RateLimit-Remaining`, or `X-RateLimit-Reset` headers for
  `/chat/completions` at all** — those do not appear anywhere in either page.
- **Distinguishing the daily cap from the per-minute cap**: the docs give
  both caps the same typed error: HTTP `429`, `error.metadata.error_type =
  "rate_limit_exceeded"`. There is no separate `error_type`, no dedicated
  HTTP status, and no header that positively marks a `429` as "this was the
  daily cap, not the per-minute cap." The only place the two could differ is
  the free-text `error.message`, and the docs do not give a canonical string
  for either case.

**The docs do not settle how to tell the two apart.** Per the task
constraint, the conservative rule below is used instead of guessing from
memory: treat a `429` as the daily free-model cap only when the request was
for a `:free` model **and** the error message itself positively names the
per-day limit (contains "free" and "day" within a short span, e.g. the
`free-models-per-day` slug OpenRouter attaches to this class of message). Any
`429` that does not satisfy both conditions stays classified exactly as it is
today (`rate-limit`, retryable) — including a `:free` model's per-minute cap,
and any 429 whose message doesn't happen to mention "day" (a false negative
here costs one wasted retry cycle; a false positive would silently drop a
transient error without retrying it, which is worse).

Because `X-RateLimit-Reset` is not documented for this endpoint, it is read
defensively and never relied on as the sole path to an answer: absence of a
usable header does not change the classification, only whether `resetAt` is
known. When present, its unit is likewise undocumented, so the value is
disambiguated by magnitude (see Decision) rather than assumed.

`packages/core/src/providers/openai-compatible.ts` (`statusKind`, before this
change) maps every `429` to `rate-limit`/`retryable: true` for both
OpenRouter and NVIDIA NIM, and discards the response body — the log said only
`"HTTP 429"`. `apps/daemon/src/jobs/assistant.ts` retries a retryable
provider error at 10s/30s/90s (`PROVIDER_RETRY_DELAYS_MS`) and finally
answers `BUSY_REPLY` ("Try again in a minute") — wrong advice for a cap that
does not reset for up to 24 hours, and each member message could cost up to
4 of the day's 50 requests before failing.

## Decision

- **`ProviderError`** gains two optional, readonly fields, set only via
  `options`: `resetAt?: number` (epoch ms) and `quotaScope?: 'daily-free'`.
  Every existing call site compiles unchanged.
- **Detection, in `openai-compatible.ts`, on a non-2xx response:**
  1. Read the body as text, bounded to 4 KB, and `safeParse` it against
     `{ error: { code?: number; message?: string; metadata?: object } }`;
     a parse failure (malformed JSON, empty body, or a body so large the
     bound truncates it mid-object) is treated as no body — never throws.
  2. A `429` is classified `quota` / `quotaScope: 'daily-free'` only when
     **both** hold: the requested model id ends in `:free`, and the parsed
     `error.message` matches `/free[\s\S]{0,40}per[- ]?day|per[- ]?day[\s\S]{0,40}free/i`
     (a "free" and a "day"/"per-day" phrase within 40 characters of each
     other, either order). Otherwise a `429` stays `rate-limit`/retryable,
     exactly as before.
  3. `resetAt` comes only from the `X-RateLimit-Reset` response header
     (undocumented for this endpoint, read defensively): parsed as a number;
     if it is `< 1e12` it is treated as seconds since epoch and multiplied by
     1000, otherwise as milliseconds already; the result is kept only if it
     is finite and strictly after "now". Anything else (header absent,
     non-numeric, in the past) leaves `resetAt` unset — callers fall back to
     the next UTC midnight (see below).
  4. Every non-2xx `ProviderError` message includes the provider's short
     reason when the body parsed: `code <n>: <first 160 chars of message,
     control characters stripped>`, e.g. `openrouter request failed with
     HTTP 429 (code 429: Rate limit exceeded: free-models-per-day)`. The
     daily-cap case uses its own clearer prefix,
     `<id> free-model daily limit reached`, with the same reason appended in
     parentheses when available. Never the request body, headers, or key.
- **`generate.ts` fallback rule:** on a `quota` error with `quotaScope ===
  'daily-free'`, the next model in the configured order is tried only if its
  id does **not** end in `:free` — a second free model on the same provider
  shares the daily counter and would fail identically, burning another
  request against tomorrow's math for nothing. A configured paid fallback is
  still tried. If there is no next model, or the next model is also
  `:free`, the error is rethrown immediately.
- **`jobs/assistant.ts`:** a `ProviderError` with `quotaScope ===
  'daily-free'` is answered at once — no `RetryAfterError`, no job retry,
  exactly one provider call spent — with: `The bot's free AI allowance for
  today is used up. It resets <t:UNIX:t>. No action was taken.` `UNIX` is
  `Math.floor(resetAt / 1000)` when `resetAt` is known, otherwise
  `Math.floor(nextUtcMidnight(deps.now()) / 1000)`. `BUSY_REPLY` is
  unchanged and still used for genuine transient errors (5xx, timeout, a
  per-minute or non-`:free` `429`).
- **Logging:** no new fields. The existing log calls in
  `jobs/assistant.ts` already pass the `ProviderError` through
  `safeLogFields({ err, ... })`, and `err` is narrowed to `{ name, message
  }` — since the message now carries the reason (previous bullet), the log
  line already carries it. Nothing outside the allowlist is touched.

## Gemini follow-up (not in scope here)

`packages/core/src/providers/gemini.ts`'s `statusKind` has the identical gap:
every `429` maps to `rate-limit`/`retryable: true`, with no attempt to
distinguish a Gemini free-tier daily quota from a transient per-minute
limit. Gemini's `GenerateContentResponse` error shape and per-day quota
signalling differ from OpenRouter's and were not researched here. Filed as a
follow-up, not fixed in this task (owner request 2026-09-24 scoped this task
to OpenRouter/NVIDIA NIM's shared adapter only).
