# Slice 6: Provider key pools, cooldowns, Gemini chain and routing - implementation plan

> **Instinct plan.** Read with `2026-10-10-harness-00-instinct-handoff.md` and `2026-10-10-harness-00-shared-contracts.md`.
> **Status:** READY (round 1)

**Goal:** Replace single-key model-chain entries with persistent provider pools, make quota exhaustion restart-safe, install the recommended Gemini chain, route simple messages to the light tier, and add a safe dashboard model check.
**Spec:** docs/superpowers/specs/2026-10-09-assistant-harness-capability-design.md Sections 4.7, 5, 6a-6f, D8, D12, D13, D15, D16
**ADRs:** 0143, 0144   **Migration:** key_pools_routing
**Base:** main @ 0371edc3

The existing `ChainEntry` in `apps/daemon/src/assistant/model-chain.ts` and `ProviderError` in `packages/core/src/providers/errors.ts` already exist with narrower meanings. This plan widens those symbols in place to the fixed shared-contract shapes; it does not introduce competing names.

## Global Constraints

- `CLAUDE.md` hard rules 1-9 apply. In particular: AI is never in the enforcement path; every query, key and job carries a guild id; model output passes Zod; every Discord side effect has a durable idempotency key; no secrets in code, logs or fixtures; no new outbound destination unless the slice's ADR records the owner's instruction.
- No new dependency.
- Fixtures use invented names (Sam L, Alex P, Car Team A). Never a real member's name or id.
- Canadian English, plain words in prompts and dashboard copy. No tool names shown to members.
- Write the failing test first for anything touching permissions, pings, idempotency, retention or guild scope, and watch it fail before writing the code.

Slice-specific constraints:
- Provider credentials, Discord tokens and tunnel secrets stay outside source control. Tests use fake keys such as `AIza-test-one`, never a real key.
- The Gemini 429 fixture is written from Google's documented `google.rpc.QuotaFailure` and `google.rpc.RetryInfo` JSON shape; no live provider call is made or required. Pin `PerDay`, `PerMinute`, token-per-minute, `quotaValue` and `retryDelay` cases in the fixture.
- Google free-tier defaults are exactly 5 RPM / 20 RPD for `gemini-3.8-flash` and `gemini-3.6-flash`, and 15 RPM / 500 RPD for `gemini-3.5-flash-lite`; TPM 250,000 is displayed as information and is not locally enforced.
- `pool: 'key'` preserves current one-key behaviour; `pool: 'provider'` resolves every enabled key for the entry's provider. A pool never opens or logs a secret outside the provider construction boundary.
- The chain remains at most six entries. Pool selection is deterministic: usable key with the most remaining daily requests, tie-broken by least recently used, then key id.
- A daily cooldown lasts until the next Pacific midnight; a minute cooldown uses provider retry delay or 60 seconds. Invalid 401/403 keys stay invalid until edit or re-test. Fully spent pools move to the next chain entry and do not schedule a retry.
- Terms are disclosures, not gates. Gemini free keys are recorded as may-train while paid keys are recorded as no-train; both remain usable and warnings appear in logs, dashboard and doctor.
- Every new setting is registered, owner-editable and tested through the dashboard. Lists use editable chips, not comma-separated text.
- Slice 2 runs in parallel. Edits to shared contract files are additive and limited to the Slice 6 symbols named in §3; do not reorder existing unions or unrelated entries.

## Plan decisions

- Use SHA-256 of the secret as the duplicate fingerprint, stored with the key row and never returned; this makes bulk paste idempotent without exposing the secret.
- Keep `project` as an owner-entered opaque label and use it as the quota bucket key; blank labels mean the key is its own project bucket, so separate labels are required for separate Google projects.
- Treat an unknown Gemini model as `TEXT_AND_TOOLS_ONLY` with `thinking: 'none'`, and give `gemini-3.5-flash-lite` the verified table entry available when the capability table is written; its limits remain the specified 15/500 defaults.
- Count Check models cost as one reserved request per capability fixture and refuse before the first call when the selected entry's pool cannot reserve that many requests; tool stubs return bounded fake results and cannot execute writes.
- Keep the old `QuotaLedger` constructor accepted only at the composition boundary during migration, but make persistent cooldown storage authoritative before any provider call; remove its request-path use in the same integration task.

## Review Focus

1. A Gemini daily 429 must prevent that exact key/model from being called on two later runs and after restart; the documented Google error fixture proves the parsed scope and learned limit.
2. A pool with one spent key must select another enabled key, while a pool with all keys spent emits `model-skipped` and falls through without retrying.
3. Keys sharing a project label must share the daily ledger bucket; keys with different labels must not.
4. A greeting must route to `light`, while an attachment, quoted reply, long thread, or full-model keyword routes to `standard`; a light tool call escalates on the next round.
5. Check models must show expected versus first action, reserve its complete budget before calling, stub every tool, and write only a `dashboard-test` ledger source without posting or mutating member data.

## Waves

| Wave | Task | Owns (create/modify) | Depends on |
|---|---|---|---|
| 1 | S6-T1 | `docs/decisions/0143-key-pools-and-gemini-chain.md`, `docs/decisions/0144-complexity-routing.md`, `packages/core/src/providers/model-capabilities.ts`, `packages/core/src/assistant/router.ts`, `apps/daemon/src/assistant/model-capabilities.ts`, `apps/daemon/src/assistant/model-capabilities.test.ts`, `packages/core/src/assistant/router.test.ts` | — |
| 2 | S6-T2 | `packages/storage/src/schema.ts`, `packages/storage/src/repos/assistant-providers.ts`, `packages/storage/src/repos/assistant-key-cooldowns.ts`, `drizzle/**`, storage tests | S6-T1 |
| 3 | S6-T3 | `packages/core/src/providers/errors.ts`, `packages/core/src/providers/gemini.ts`, Gemini quota fixtures and tests | S6-T1 |
| 4 | S6-T4 | `apps/daemon/src/assistant/model-chain.ts`, `apps/daemon/src/assistant/provider-config.ts`, model-chain/provider-config tests | S6-T2, S6-T3 |
| 5 | S6-T5 | `apps/daemon/src/assistant/tool-loop.ts`, `apps/daemon/src/assistant/service.ts`, `packages/core/src/assistant/run-events.ts`, `packages/core/src/settings/instance-settings.ts`, routing/tool-loop/service/settings tests | S6-T1, S6-T2, S6-T4 |
| 6 | S6-T6 | `packages/http/src/routes/assistant-providers.ts`, `packages/http/src/routes/assistant-setup.ts`, HTTP tests, provider eligibility projection files | S6-T2, S6-T4, S6-T5 |
| 6 | S6-T7 | new dashboard provider/routing/check components, `packages/dashboard/src/pages/providers.tsx` mount, dashboard API/types and tests | S6-T6 |
| 7 | S6-T8 | doctor integration, model-health/banner integration, `docs/PRIVACY.md`, `docs/STATE.md`, their tests | S6-T5, S6-T6, S6-T7 |

Tasks in the same wave own disjoint files: Wave 6 has S6-T6's HTTP files and S6-T7's dashboard files only; S6-T7 may mount its component in `providers.tsx`, while S6-T6 owns no dashboard file.

## Tasks
