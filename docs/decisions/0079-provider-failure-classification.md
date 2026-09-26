# 0079. Provider failure classification and per-attempt traces

Date: 2026-09-25

Status: accepted (owner request 2026-09-25)

## Context

On 2026-09-25 every assistant request failed with `Every assistant model is busy (busy)`. The
cause was network-level: a VPN pushed IPv4 connect time past Node's 250 ms Happy Eyeballs wait,
and every `fetch` died with `UND_ERR_CONNECT_TIMEOUT`. None of that reached a log line, a trace
or the dashboard:

- `ProviderError` carries no HTTP status and no network code, so `attemptReasonFor`'s status
  branches never fire.
- A retryable chain failure throws before any trace is written, so History shows nothing.
- The chain summary names only the last attempt's outcome.

## Decision

1. `ProviderError` gains optional `status`, `netCode` and `host`. Both adapters set them:
   `status` from the HTTP response, `netCode` from the `fetch` failure's `cause.code` (an
   allowlist of undici and Node codes), and `host` from our own base URL, never from provider
   output.
2. `classifyProviderFailure(err)` in `packages/core/src/providers/failure.ts` maps any error to
   a stable `ProviderFailureCode` (`provider-connect-timeout`, `provider-dns`, `provider-auth`,
   `provider-rate-limit`, `provider-daily-quota`, …, plus `local-rpm-limit` and
   `local-rpd-limit` from ADR 0081). Each code has fixed title, explanation and hint text.
3. **Traces and the dashboard hold only the code and the classified fields** (hard rule 4, owner
   decision 2026-09-25). The provider's sanitized short reason (≤160 characters, already
   produced by the adapters) appears only in the journal, as `providerMessage`.
4. Every failed attempt logs one `warn` line, `provider attempt failed`. A retryable chain
   failure throws `ChainFailedError` carrying its attempts. The job writes a trace for every
   invocation attempt that fails, with flag `retry:<n>` while it will retry.
5. The chain test route answers the classified failure (code, title, explanation, hint, host,
   status or network code) instead of one of four fixed sentences.

## Consequences

- The next network-level outage reads as "provider-connect-timeout: check VPN/network" in
  History and on the Test button, not "busy".
- The trace schema gains optional fields, so older rows still parse.
- A retried invocation now produces up to five traces rather than one. This is acceptable: each
  is a real provider attempt, and retention applies to all of them.
