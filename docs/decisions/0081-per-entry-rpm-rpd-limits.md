# 0081. Per-chain-entry RPM and RPD limits

Date: 2026-09-25

Status: accepted (owner request 2026-09-25)

## Context

Free provider tiers meter requests per minute and per day, per key and per model. Today
Bananasaurs learns a limit only by hitting it: a 429 costs a retry cycle, and the daily cap
(ADR 0077) is known only after the provider refuses. The owner asked to set RPM and RPD on each
model, so that Bananasaurs skips a model at its limit instead of calling it.

## Decision

1. **Scope: one chain entry** (key + model; owner, 2026-09-25). `assistant_model_chain` gains
   nullable `rpm_limit` and `rpd_limit`, where null means no limit.
2. **Every provider HTTP call is recorded** in `assistant_model_calls (key_id, model, at,
   guild_id)`, including each tool round and each chain Test. The table is instance-scoped
   because the key is shared, and `guild_id` records which guild spent the call. Rows older than
   48 h are pruned.
3. **Reserve before sending.** The limit check and the insert run in one synchronous
   `better-sqlite3` transaction. The daemon is the single writer and there is no `await` between
   them, so two jobs cannot both take the last slot. A failed call still counts, as it does at
   the provider.
4. **Windows.** RPM is a sliding 60 s window. RPD counts from the provider's day start: UTC
   midnight for OpenRouter and NVIDIA NIM, and midnight America/Los_Angeles for Gemini. Each
   refusal carries `availableAt`.
5. **Chain behaviour.** An entry at its limit is recorded as a `skipped` attempt with code
   `local-rpm-limit` or `local-rpd-limit`, and the loop moves on. If every entry that could have
   run was skipped for a local limit, no provider is called. The member is answered at once with
   when the next model frees up, and the job does not retry (owner, 2026-09-25).
6. The provider-reported daily cap (ADR 0077, `QuotaLedger`) keeps working alongside.

## Consequences

- An owner who sets limits slightly below the provider's never spends a retry cycle on a 429.
- Limits are advisory to Bananasaurs only. Another client sharing the key still counts at the
  provider, and Bananasaurs cannot see those calls.
