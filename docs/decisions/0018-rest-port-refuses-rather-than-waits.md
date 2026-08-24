# ADR 0018: The Discord REST port refuses rather than retries or waits

Status: accepted (2026-08-23)

## Context

`docs/19` §6.1 and the slice 6 handoff both state the rule this decision implements:

> discord.js queues internally; our rate limiter and circuit breaker sit **above** it. Do not let the adapter silently retry — a refusal the gateway can see is worth more than a retry it cannot.

The rule was written before anyone read `@discordjs/rest`'s defaults. Measured against the installed 14.27.0 (`node_modules/@discordjs/rest/dist/index.d.ts:408-412`), they are:

| Option | Default | What it does |
|---|---|---|
| `retries` | `3` | Retries 5xx responses and timeouts, silently |
| `rejectOnRateLimit` | `null` | **Waits out** every rate limit rather than reporting it |
| `timeout` | `15_000` | Aborts a request after 15s |
| `globalRequestsPerSecond` | `50` | Pre-emptively throttles across all routes |

So out of the box the adapter does exactly what the rule forbids, in two different ways, and neither is visible from above.

Three of the twelve layers in the effect gateway — the rate cap, the circuit breaker, and the budget — are built on being told when Discord refuses. A 429 that `@discordjs/rest` absorbs by sleeping is a refusal the breaker never counts, so a guild can sit in a permanently rate-limited state with a breaker that never trips and a log that shows only latency. A 500 retried three times is three calls charged against a rate cap that authorised one.

There is a sharper failure than either. An interaction must be acknowledged within **three seconds**, after which Discord discards the token and the member sees "This interaction failed" no matter what the bot does next (`port.ts`, `deferInteraction`). If `@discordjs/rest` silently waits out a bucket for four seconds on the defer call, the token is dead, the member sees a failure, and nothing in our logs says why — the request eventually succeeded.

## Decision

The REST client is constructed with:

```ts
rest: {
  retries: 0,
  rejectOnRateLimit: () => true,
}
```

**`retries: 0`.** A 5xx or a timeout surfaces as a `DiscordApiError` and reaches the effect gateway, which owns the decision to retry — it is the thing holding the breaker, the rate cap and the idempotency key. Retrying underneath it means retrying without any of them.

**`rejectOnRateLimit: () => true`.** Every rate limit, per-route or global, throws `RateLimitError` instead of being queued. The adapter maps it to `DiscordApiError(429, RateLimited, …, { retryAfter, global })` — a shape `packages/core/src/discord/errors.ts` already defines, `retryAfter` and `global` included, which is good evidence this is the behaviour the error vocabulary was designed around.

`timeout` and `globalRequestsPerSecond` keep their defaults. The first is a bound on a single request rather than a retry policy; the second is a pre-emptive spacing that cannot mask a refusal because it never produces one.

## Consequences

**A rate limit reaching us is now a reported failure, not a slowdown.** That is the point, and it is also the cost: work that would previously have completed slowly now fails and is re-driven by the layer above. This is only correct because our own rate cap sits above and is supposed to prevent reaching Discord's limit at all — `docs/21` exercise 4 tests exactly that ("the rate cap refuses the excess rather than queueing it"). **A 429 from Discord therefore means our cap is mis-sized, and we want that visible rather than absorbed.**

**Bulk paths must be resumable, and already are.** The adoption pass is a resumable job with a cursor and an allowance, and reconciliation runs under a budget. Neither depends on a long-running REST call surviving a rate limit.

**The breaker can now trip on rate limiting.** Previously impossible. This is the behaviour `docs/21` exercise 4 asks for when checking `guilds.breaker_tripped_at`.

**Rejected: keeping the queueing default and setting only `retries: 0`.** It fixes the retry half and leaves the worse half — the invisible wait — in place, including on the interaction path where it costs a member-visible failure with no diagnosis.

**Rejected: rejecting only on global rate limits.** Per-route buckets are where role mutations actually land, so this would exempt the routes the rule exists for.

## Related

The port also speaks raw REST routes (`client.rest` plus `Routes.*`) rather than discord.js structures. The structure API resolves through the client cache, which slice 6a deliberately made tiny, so a structure call can silently become a fetch that is not rate-limited, budgeted, or attributable to a guild. Raw routes keep every call explicit, keep guild scope in the URL, and make `DiscordAPIError` the single error shape to map. The narrowness of `DiscordPort` is what makes this affordable: fourteen methods, each one or two requests.
