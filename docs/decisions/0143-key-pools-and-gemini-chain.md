# 0143. Provider key pools, persistent cooldowns and Gemini chain

Date: 2026-10-11

Status: accepted (owner decisions D8, D12, D13, D15, 2026-10-10).

## Context

Each chain entry names exactly one key, the free allowance ledger is in memory only, and a Gemini 429 is never
parsed, so an exhausted key is retried on every run and job retry. Free Gemini quota is per project and model, so
project labels and durable learned cooldowns are needed to avoid repeating exhausted calls. The owner chose many
free projects (D15) despite Google's API limitations risk and accepted the Gemini may-train disclosure for free
keys (D12).

## Decision

1. A chain row may use one key (`pool: 'key'`, today's behaviour) or all enabled keys of its provider
   (`pool: 'provider'`); new keys join automatically, removed or disabled keys leave. The chain stays at most six
   entries. Pool selection uses greatest remaining daily request budget, then least-recent use, then key id.
2. A key gains an optional `project` label; keys with the same label share one ledger bucket because Google limits
   per project, not per key. Duplicates are refused by SHA-256 fingerprint of the secret, never the secret itself.
3. Cooldowns and learned quota values persist per key and model in `assistant_key_cooldowns`, replacing the
   in-memory `QuotaLedger` on the request path. A daily Gemini 429 cools until the next Pacific midnight; a minute
   429 cools for the retry delay or 60 s; 401/403 marks the key invalid until edit or re-test.
4. The recommended chain is `gemini-3.8-flash` (5 RPM / 20 RPD) → `gemini-3.6-flash` (5 / 20) →
   `gemini-3.5-flash-lite` (15 / 500), each over the whole Gemini pool, then the owner's OpenRouter entries.
   Gemini free and paid cost classes have separate terms records; disclosures warn but never refuse.
5. Check models runs capability fixtures against one chain entry with stubbed tools and a reserved request budget,
   recorded as `dashboard-test`. No live Gemini call is needed to validate quota parsing; fixtures use Google's
   documented `google.rpc.QuotaFailure` and `google.rpc.RetryInfo` shape.

## Consequences

- The owner accepts possible Google account or key suspension from using several free projects to lift capacity.
  Do not silently hide that risk.
- Free Gemini keys may train on submitted input; paid keys use the recorded no-training terms. Both stay usable.
