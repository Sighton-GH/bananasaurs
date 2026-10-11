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
| 1 | S6-T1 | `docs/decisions/0143-key-pools-and-gemini-chain.md`, `docs/decisions/0144-complexity-routing.md`, `packages/core/src/providers/model-capabilities.ts`, `packages/core/src/assistant/router.ts`, `packages/core/src/index.ts` additive exports, `apps/daemon/src/assistant/model-capabilities.ts`, `apps/daemon/src/assistant/model-capabilities.test.ts`, `packages/core/src/assistant/router.test.ts` | — |
| 2 | S6-T2 | `packages/storage/src/schema.ts`, `packages/storage/src/repos/assistant-providers.ts`, `packages/storage/src/repos/assistant-key-cooldowns.ts`, `packages/storage/src/repos/assistant-providers.test.ts`, `packages/storage/src/repos/assistant-key-cooldowns.test.ts`, `packages/storage/src/schema-invariants.test.ts`, generated `drizzle/**` | S6-T1 |
| 3 | S6-T3 | `packages/core/src/providers/errors.ts`, `packages/core/src/providers/gemini.ts`, `packages/core/src/providers/__fixtures__/gemini-429-quota.json`, `packages/core/src/providers/gemini.test.ts` | S6-T1 |
| 4 | S6-T4 | `apps/daemon/src/assistant/model-chain.ts`, `apps/daemon/src/assistant/provider-config.ts`, model-chain/provider-config tests | S6-T2, S6-T3 |
| 5 | S6-T5 | `apps/daemon/src/assistant/tool-loop.ts`, `apps/daemon/src/assistant/service.ts`, `packages/core/src/assistant/run-events.ts`, `packages/core/src/assistant/run-events.test.ts`, `packages/core/src/settings/instance-settings.ts`, `packages/core/src/settings/instance-settings.test.ts`, `apps/daemon/src/assistant/tool-loop.test.ts`, `apps/daemon/src/assistant/service.test.ts` | S6-T1, S6-T2, S6-T4 |
| 6 | S6-T6 | `packages/http/src/routes/assistant-providers.ts`, `packages/http/src/routes/assistant-providers.test.ts`, `packages/http/src/routes/assistant-setup.ts`, `packages/http/src/routes/assistant-setup.test.ts`, `packages/http/src/server.ts` additive wiring | S6-T2, S6-T4, S6-T5 |
| 6 | S6-T7 | new dashboard provider/routing/check components, `packages/dashboard/src/pages/providers.tsx`, `packages/dashboard/src/pages/providers.test.tsx`, `packages/dashboard/src/api/assistant.ts`, `packages/dashboard/src/api/assistant.test.ts` | S6-T6 |
| 7 | S6-T8 | `apps/daemon/src/runtime/doctor.ts`, `apps/daemon/src/runtime/doctor.test.ts`, `packages/http/src/routes/assistant-model-health.ts`, `packages/http/src/routes/assistant-model-health.test.ts`, `packages/dashboard/src/api/runs.ts`, `packages/dashboard/src/api/runs.test.ts`, `docs/PRIVACY.md`, `docs/STATE.md` | S6-T5, S6-T6, S6-T7 |

Tasks in the same wave own disjoint files: Wave 6 has S6-T6's HTTP files and S6-T7's dashboard files only; S6-T7 may mount its component in `providers.tsx`, while S6-T6 owns no dashboard file.

## Tasks

### S6-T1: ADRs, capabilities and pure routing contracts   ·   Wave 1
**Owns:** Create: `docs/decisions/0143-key-pools-and-gemini-chain.md`, `docs/decisions/0144-complexity-routing.md`, `packages/core/src/providers/model-capabilities.ts`, `packages/core/src/assistant/router.ts`; Modify additively: `packages/core/src/index.ts`; Create: `apps/daemon/src/assistant/model-capabilities.ts`, `apps/daemon/src/assistant/model-capabilities.test.ts`, `packages/core/src/assistant/router.test.ts`
**Reads (do not edit):** `docs/decisions/0137-read-only-tools-in-later-rounds.md`, `docs/superpowers/plans/2026-10-10-harness-00-shared-contracts.md`, `packages/core/src/providers/contracts.ts`, `apps/daemon/src/assistant/openrouter-models.ts`
**Interfaces:** Produces exact §3 contracts: `ThinkingControl`, `ModelCapabilities`, `GeminiModelInfo`, `GEMINI_MODEL_TABLE`, `geminiCapabilities(model: string): ModelCapabilities`, `TEXT_AND_TOOLS_ONLY`, `capabilitiesForEntry(entry: { readonly providerId: ProviderId; readonly model: string }, catalogue: OpenRouterModelCatalogue): ModelCapabilities`, `ChainTier`, `RouterRules`, `RouteInput`, `routeRun(input: RouteInput, rules: RouterRules): { tier: ChainTier; reason: string }`, and `orderChainByTier<T extends { readonly tier: ChainTier }>(entries: readonly T[], tier: ChainTier): T[]`.

- [ ] **Step 1: Write the failing tests** in `router.test.ts` and `model-capabilities.test.ts`. Use Vitest `describe`, `it`, `expect`; assert greeting `hi` is light, `remind me at 5` standard, 81 characters standard under default max 80, attachment/quote standard, 5 earlier turns standard, a configured greeting remains light in a long thread, a full-model keyword forces standard, disabled rules always select standard, light ordering precedes standard and standard ordering preserves standard-first. Assert Gemini 3.8 and 3.6 have tools/image/pdf/reasoning true and thinking `levels` with free limits 5/20; 3.5 Flash-Lite limits 15/500; unknown Gemini is text+tools only and thinking `none`; OpenRouter mapping uses image/file/tools/reasoning booleans and NIM returns `TEXT_AND_TOOLS_ONLY`.
- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/assistant/router.test.ts apps/daemon/src/assistant/model-capabilities.test.ts --maxWorkers=1` · Expected: FAIL because the pure modules do not exist.
- [ ] **Step 3: Implement** — Add the exact exports above. Set router defaults `enabled: true`, `maxChars: 80`, `longThreadTurns: 4`, `escalateOnTool: true`, full-model keywords exactly `remind`, `schedule`, `task`, `ping`, `search`, `look up`, `summar`, `explain`, `why`, `how`, `write`, `story`, `code`, `plan`, `compare`, `translate`, `fix`; include configurable anchored greeting/thanks/emoji patterns. Check simple criteria in order and return a stable plain reason. Define `GEMINI_MODEL_TABLE` for `gemini-3.8-flash` and `gemini-3.6-flash` as capabilities + freeRpm 5/freeRpd 20; `gemini-3.5-flash-lite` capabilities + 15/500. `capabilitiesForEntry` reads OpenRouter catalogue properties, maps `file` to `pdf`, Gemini through `geminiCapabilities`, and NIM to `TEXT_AND_TOOLS_ONLY`.

Write ADR 0143 in full:

```markdown
# 0143. Provider key pools, persistent cooldowns and Gemini chain

Date: 2026-10-10

Status: accepted (owner decisions D8, D12, D13, D15, D16; 2026-10-10).

## Context

The provider chain currently binds each model row to one key, the free allowance ledger is in memory, and Gemini 429 bodies are not parsed. Free Gemini quota is per project and model, so project labels and durable learned cooldowns are necessary to avoid repeating exhausted calls. The owner chose many free projects (D15) despite Google's API limitations risk and accepted Gemini may-train disclosure for free keys (D12).

## Decision

A chain row may use one key or all enabled keys for its provider. Pool selection uses greatest remaining daily request budget, least-recent use, then key id. Project labels share request-ledger accounting. Cooldowns and learned quota values persist per key/model. Gemini 3.8 Flash is the first recommended pooled entry, followed by 3.6 Flash and 3.5 Flash-Lite; configured OpenRouter entries remain after these. Gemini free and paid cost classes have separate terms records; disclosures warn but never refuse. Check models uses bounded fixtures, stubbed tools and reserved request budget only.

## Consequences

The owner accepts possible Google account/key suspension from using several free projects to increase capacity. Do not silently hide that risk. No live Gemini call is needed to validate quota parsing; fixtures use Google's documented `google.rpc.QuotaFailure` and `google.rpc.RetryInfo` shape. Free Gemini keys may train on submitted input and must be disclosed in logs, dashboard, doctor and PRIVACY.md; paid keys use the recorded no-training terms.
```

Write ADR 0144 in full:

```markdown
# 0144. Deterministic complexity routing

Date: 2026-10-10

Status: accepted (owner decision D16, 2026-10-10).

## Context

Simple greetings should not spend the standard Gemini daily quota. A model-based classifier would cost a provider request and could make routing nondeterministic.

## Decision

A pure deterministic router selects `light` only for short messages with no attachments or quote/reply, no full-model keyword, and at most four earlier turns. Configurable greeting/thanks/emoji patterns remain light in long conversations. Light runs try light entries then standard entries; standard runs try standard then light. When enabled, a light run that invokes a tool switches to standard for its next model round. Router rules and background job tiers are instance settings visible on the dashboard.

## Consequences

Routing is auditable through a fixed reason string and the `routed` run event. No classifier call is made. Misclassification can be corrected by the owner through editable keyword and greeting lists.
```

- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS.
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0.
- [ ] **Step 6: Format and lint** — `npx prettier --write docs/decisions/0143-key-pools-and-gemini-chain.md docs/decisions/0144-complexity-routing.md packages/core/src/providers/model-capabilities.ts packages/core/src/assistant/router.ts apps/daemon/src/assistant/model-capabilities.ts apps/daemon/src/assistant/model-capabilities.test.ts packages/core/src/assistant/router.test.ts` then `npx eslint packages/core/src/providers/model-capabilities.ts packages/core/src/assistant/router.ts apps/daemon/src/assistant/model-capabilities.ts apps/daemon/src/assistant/model-capabilities.test.ts packages/core/src/assistant/router.test.ts` · exit 0.
- [ ] **Step 7: Commit** — `git add docs/decisions/0143-key-pools-and-gemini-chain.md docs/decisions/0144-complexity-routing.md packages/core/src/providers/model-capabilities.ts packages/core/src/assistant/router.ts apps/daemon/src/assistant/model-capabilities.ts apps/daemon/src/assistant/model-capabilities.test.ts packages/core/src/assistant/router.test.ts && git commit -m "Slice 6 T1: ADRs and model routing contracts"`

**Done when:** the two ADRs exist; both pure contract test files pass and the exact shared symbols compile.

### S6-T2: Migration, project-aware keys and persistent cooldown repository   ·   Wave 2
**Owns:** Modify: `packages/storage/src/schema.ts`, `packages/storage/src/repos/assistant-providers.ts`; Create: `packages/storage/src/repos/assistant-key-cooldowns.ts`, `packages/storage/src/repos/assistant-key-cooldowns.test.ts`; Modify: `packages/storage/src/repos/assistant-providers.test.ts`, `packages/storage/src/schema-invariants.test.ts`; Create generated files under `drizzle/` via the prescribed generator
**Reads (do not edit):** `packages/storage/src/write.ts`, `packages/storage/src/scope.ts`, `packages/storage/src/repos/assistant-model-calls.ts`, existing provider repository tests, `docs/superpowers/plans/2026-10-10-harness-00-shared-contracts.md`
**Interfaces:** Consumes `ChainTier` from `@bananasaurs/core`. Produces `StoredKey.project?: string`, `StoredKey.fingerprint: string`, `ChainRow.pool: 'key' | 'provider'`, `ChainRow.tier: ChainTier`, `ChainRow.project`-aware repository methods, and `assistantKeyCooldownsRepo` functions `get(scope, keyId, model, now): KeyCooldown | undefined`, `set(scope, input: { keyId: string; model: string; until: number; reason: string; setAt: number; learnedLimit?: { perDay?: number; perMinute?: number } }): void`, `clear(scope, keyId, model?): void`, and `list(scope): KeyCooldown[]`.

- [ ] **Step 1: Write failing storage tests** using the existing storage test harness and `InstanceScope`: round-trip the project/fingerprint and new `pool`/`tier` columns; preserve old rows as `pool: 'key'` and `tier: 'standard'`; enforce unique fingerprint; key/model cooldown survives reopening the database, expires when `now >= until`, can be cleared by key, cascades on key deletion, and isolates queries through instance scope.
- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/storage/src/repos/assistant-providers.test.ts packages/storage/src/repos/assistant-key-cooldowns.test.ts --maxWorkers=1` · Expected: FAIL for absent schema/repository fields/table.
- [ ] **Step 3: Implement** — In `assistantProviderKeys` add nullable `project` (max 80 chars) and unique non-null `fingerprint`; add nullable/default-compatible `pool` and `tier` to `assistantModelChain`, constrained to `key|provider` and `standard|light`. Create `assistant_key_cooldowns` keyed by `(key_id, model)` with `until`, `reason`, `set_at`, nullable `learned_per_day`, nullable `learned_per_minute`, a key FK cascade and bounded strings. Extend `addKey`, `updateKey`, `getModelChain`, and `setModelChain` while preserving existing call sites through defaults. Keep project bucket computation in a repository helper that returns `project:<label>` or `key:<keyId>`; all SQL uses `readInstance`/`writeInstance`. Run `npm run db:generate -- --name key_pools_routing`; read the generated SQL and confirm it adds the columns, defaults existing rows to key/standard, adds the cooldown table/index/FK, and does not rebuild unrelated tables. Never hand-number or hand-edit a migration.
- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS, including migration test from the prior schema state.
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0.
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/storage/src/schema.ts packages/storage/src/repos/assistant-providers.ts packages/storage/src/repos/assistant-key-cooldowns.ts packages/storage/src/repos/assistant-providers.test.ts packages/storage/src/repos/assistant-key-cooldowns.test.ts drizzle` then `npx eslint packages/storage/src/schema.ts packages/storage/src/repos/assistant-providers.ts packages/storage/src/repos/assistant-key-cooldowns.ts packages/storage/src/repos/assistant-providers.test.ts packages/storage/src/repos/assistant-key-cooldowns.test.ts` · exit 0.
- [ ] **Step 7: Commit** — `git add packages/storage/src/schema.ts packages/storage/src/repos/assistant-providers.ts packages/storage/src/repos/assistant-key-cooldowns.ts packages/storage/src/repos/assistant-providers.test.ts packages/storage/src/repos/assistant-key-cooldowns.test.ts drizzle && git commit -m "Slice 6 T2: persistent key pools and cooldown storage"`

**Done when:** the migration is generated and reviewed; old rows retain one-key standard semantics; repository tests prove expiry, deletion and persistence.

### S6-T3: Parse documented Gemini quota errors into provider fields   ·   Wave 3
**Owns:** Modify: `packages/core/src/providers/errors.ts`, `packages/core/src/providers/gemini.ts`; Create: `packages/core/src/providers/__fixtures__/gemini-429-quota.json`, update/create Gemini provider tests
**Reads (do not edit):** `packages/core/src/providers/provider-day.ts`, `packages/core/src/providers/gemini.test.ts`, `packages/core/src/providers/failure.ts`, shared contracts §3
**Interfaces:** Widens `ProviderError` with exact shared fields `quotaScope?: 'daily-free' | 'day' | 'minute'`, `retryAfterMs?: number`, `learnedLimit?: { readonly perDay?: number; readonly perMinute?: number }`; preserves every current constructor option and field.

- [ ] **Step 1: Write failing tests and fixture.** Add a static JSON fixture (not captured from a real call) with `error.status: 'RESOURCE_EXHAUSTED'`, `details` containing a `type.googleapis.com/google.rpc.QuotaFailure` whose `violations` include `quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'`, `quotaMetric`, `quotaDimensions`, `quotaValue: '20'`, plus a second `QuotaFailure` with `PerMinute` and `quotaValue: '5'`; include `type.googleapis.com/google.rpc.RetryInfo` with `retryDelay: '37s'`. In Gemini tests, have fake `fetch` return the fixture with HTTP 429. Assert daily-only gives `quotaScope: 'day'`, `learnedLimit.perDay === 20`, and next Pacific midnight is left to the cooldown consumer; minute gives scope minute, 37,000 ms and learned minute 5; tokens-per-minute maps minute; missing/malformed details stays a plain rate-limit with 60-second fallback downstream; 401/403 remain authentication and never include response body/key in error text.
- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/providers/gemini.test.ts --maxWorkers=1` · Expected: FAIL because `ProviderError` has no shared quota fields and Gemini discards 429 body details.
- [ ] **Step 3: Implement** — Parse error JSON with Zod after reading a non-OK response, but retain fixed public error messages. Find Google detail records by `@type`; classify daily when any quota id contains `PerDay`, minute when it contains `PerMinute` or identifies tokens-per-minute, parse decimal `quotaValue` without accepting unsafe/non-finite values, parse retry durations as seconds plus nanos, cap values to a safe retry range, and prefer daily when daily and minute violations coexist. Never retain raw provider message/details in an ordinary log or error. Set kind quota for `RESOURCE_EXHAUSTED`, preserve status/host; daily scope is `day`, minute `minute`, and retry delay becomes `retryAfterMs`. Keep 429 without a recognized quota detail as rate-limit.
- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS against the committed static fixture; tests perform no network call.
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0.
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/providers/errors.ts packages/core/src/providers/gemini.ts packages/core/src/providers/__fixtures__/gemini-429-quota.json packages/core/src/providers/gemini.test.ts` then `npx eslint packages/core/src/providers/errors.ts packages/core/src/providers/gemini.ts packages/core/src/providers/gemini.test.ts` · exit 0.
- [ ] **Step 7: Commit** — `git add packages/core/src/providers/errors.ts packages/core/src/providers/gemini.ts packages/core/src/providers/__fixtures__/gemini-429-quota.json packages/core/src/providers/gemini.test.ts && git commit -m "Slice 6 T3: parse Gemini quota errors from documented fixture"`

**Done when:** documented Gemini quota variants produce typed, bounded fields; malformed/unrecognized bodies remain safe; no test makes a live call.

### S6-T4: Resolve pools, key selection and per-cost-class Gemini terms   ·   Wave 4
**Owns:** Modify: `apps/daemon/src/assistant/model-chain.ts`, `apps/daemon/src/assistant/provider-config.ts`; Test: `apps/daemon/src/assistant/model-chain.test.ts`, `apps/daemon/src/assistant/provider-config.test.ts`
**Reads (do not edit):** storage provider/cooldown repositories, `packages/core/src/providers/provider-day.ts`, `packages/core/src/providers/model-capabilities.ts`, `apps/daemon/src/assistant/local-limit.ts`
**Interfaces:** Consumes `GEMINI_MODEL_TABLE`, `capabilitiesForEntry`, `ChainRow.pool/tier`, `StoredKey.project/fingerprint`, and cooldown repository contracts. Produces `ChainEntry` with exact shared fields `readonly tier: ChainTier`, `readonly pool: 'key' | 'provider'`, `readonly capabilities: ModelCapabilities`, plus candidate key selection metadata; `resolveModelChain` expands provider pools to enabled keys of that provider and exposes a deterministic `selectPoolKey` function.

- [ ] **Step 1: Write failing tests** in the existing model-chain/provider-config test helpers. Assert a `key` row resolves only its referenced key; `provider` expands all and only enabled matching-provider keys; another provider, disabled, unreadable and terms-unverified keys are excluded; project-labelled keys share usage remaining; selection picks most remaining RPD, then least-recently-used and key id; model rows get `tier`, `pool`, capabilities and known RPM/RPD defaults; unknown limits stay null; Gemini eligibility is selected from free versus paid terms and may-train remains usable. Test only fake provider factories and in-memory DB fixtures.
- [ ] **Step 2: Run it and watch it fail** — `npx vitest run apps/daemon/src/assistant/model-chain.test.ts apps/daemon/src/assistant/provider-config.test.ts --maxWorkers=1` · Expected: FAIL on missing fields and provider pool expansion.
- [ ] **Step 3: Implement** — Update `resolveModelChain` to retain the existing stored/env fallback semantics, resolve pool member credentials only inside provider construction, and create one `ChainEntry` per selected usable member while preserving pool identity and position. Use `GEMINI_MODEL_TABLE` defaults only when row limits are null. Account usage by (project bucket, model), with no shared budget for unrelated project labels. Extend provider eligibility lookup to distinguish Gemini `free` and `paid` cost classes while retaining generic provider rows for OpenRouter/NIM; a free key warns if its record is stale/no-training, a paid key warns if its record is missing, but neither key is refused solely for training status. Keep keys out of errors and projected entries.
- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS.
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0.
- [ ] **Step 6: Format and lint** — `npx prettier --write apps/daemon/src/assistant/model-chain.ts apps/daemon/src/assistant/provider-config.ts apps/daemon/src/assistant/model-chain.test.ts apps/daemon/src/assistant/provider-config.test.ts` then `npx eslint apps/daemon/src/assistant/model-chain.ts apps/daemon/src/assistant/provider-config.ts apps/daemon/src/assistant/model-chain.test.ts apps/daemon/src/assistant/provider-config.test.ts` · exit 0.
- [ ] **Step 7: Commit** — `git add apps/daemon/src/assistant/model-chain.ts apps/daemon/src/assistant/provider-config.ts apps/daemon/src/assistant/model-chain.test.ts apps/daemon/src/assistant/provider-config.test.ts && git commit -m "Slice 6 T4: resolve pooled model entries and Gemini capabilities"`

**Done when:** model entries describe their tier, pool and capabilities, and provider pools never resolve a disabled or unrelated key.

### S6-T5: Persist cooldowns, route runs and escalate light tool calls   ·   Wave 5
**Owns:** Modify: `apps/daemon/src/assistant/tool-loop.ts`, `apps/daemon/src/assistant/service.ts`, `packages/core/src/assistant/run-events.ts`, `packages/core/src/settings/instance-settings.ts`; tests for these paths
**Reads (do not edit):** `apps/daemon/src/assistant/local-limit.ts`, `apps/daemon/src/assistant/run-recorder.ts`, `packages/core/src/settings/instance-settings.test.ts`, router and cooldown contracts
**Interfaces:** Consumes `routeRun`, `orderChainByTier`, `RouterRules`, `KeyCooldown` repository operations and widened `ProviderError`. Produces `routed` event `{ kind: 'routed'; tier: ChainTier; reason: string }`; settings prefixed `assistant.router…` and key-pool configuration; loop options `cooldowns`, `routeTier`, `escalateOnTool`; removes request-path dependence on `QuotaLedger`.

- [ ] **Step 1: Write failing tests** for `run-events.test.ts`, tool-loop and service tests and append registry validation cases to `instance-settings.test.ts`. Cover routed event round-trip; no cooldown allows a call; an existing key/model cooldown skips before `reserveModelCall`; daily Gemini error stores until next Pacific midnight with learned limit; minute error stores retry delay or 60s; OpenRouter `:free` uses `resolveResetAt`; plain 429 honours Retry-After; 401/403 persist invalid status; restart is represented by creating a new service over the same storage; two post-daily-error runs never call that key; a second key is used; all-spent entries are skipped and eventually produce existing local-limit reply without retry. Break-it: remove the cooldown check, run the named never-called-again test and observe failure, then restore the guard. Routing tests pin light/standard reasons and multi-tier fallback; an actual light-tier tool call makes round 2 use the first standard entry when escalation is enabled. Settings test every registry entry and bounds/defaults.
- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/assistant/run-events.test.ts packages/core/src/settings/instance-settings.test.ts apps/daemon/src/assistant/tool-loop.test.ts apps/daemon/src/assistant/service.test.ts --maxWorkers=1` · Expected: FAIL because routed events/settings/cooldown selection are absent.
- [ ] **Step 3: Implement** — Extend the run-event discriminated union additively with strict `routed`; update the dashboard event descriptor in its owning task only. Register settings with D16 defaults: `assistant.routerEnabled=true`, `assistant.routerMaxChars=80`, `assistant.routerFullModelKeywords` exact list in T1, `assistant.routerGreetingPatterns` configured greeting/thanks/emoji pattern list, `assistant.routerLongThreadTurns=4`, `assistant.routerEscalateOnTool=true`, `assistant.routerSummaryTier='light'`, `assistant.routerDailyDigestTier='light'`. In service, route sanitized current text and quote/attachment/history booleans, record event, order the chain. In loop, before reserving, query persistent cooldown by key/model, record `model-skipped` with stable reason and `availableAt`, then continue. On provider error, persist cooldown based on `quotaScope`, `retryAfterMs`, `learnedLimit`, `resetAt` or Pacific midnight; compute local key/project budget from successful reservations. Mark invalid on 401/403 and clear invalid only after explicit owner key edit/re-test. A fully exhausted chain returns the existing local-limit outcome so job retries stop. Escalate after a tool by beginning the next round on standard-tier entries, retaining standard order and not repeating a model already attempted for the run. Keep `QuotaLedger` compatibility only if a test or external constructor still needs it; it must not influence persistent cooldown decisions.
- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS including the break-it restoration.
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0.
- [ ] **Step 6: Format and lint** — `npx prettier --write apps/daemon/src/assistant/tool-loop.ts apps/daemon/src/assistant/service.ts packages/core/src/assistant/run-events.ts packages/core/src/settings/instance-settings.ts apps/daemon/src/assistant/tool-loop.test.ts apps/daemon/src/assistant/service.test.ts packages/core/src/assistant/run-events.test.ts packages/core/src/settings/instance-settings.test.ts` then `npx eslint apps/daemon/src/assistant/tool-loop.ts apps/daemon/src/assistant/service.ts packages/core/src/assistant/run-events.ts packages/core/src/settings/instance-settings.ts apps/daemon/src/assistant/tool-loop.test.ts apps/daemon/src/assistant/service.test.ts packages/core/src/assistant/run-events.test.ts packages/core/src/settings/instance-settings.test.ts` · exit 0.
- [ ] **Step 7: Commit** — `git add apps/daemon/src/assistant/tool-loop.ts apps/daemon/src/assistant/service.ts packages/core/src/assistant/run-events.ts packages/core/src/settings/instance-settings.ts apps/daemon/src/assistant/tool-loop.test.ts apps/daemon/src/assistant/service.test.ts packages/core/src/assistant/run-events.test.ts packages/core/src/settings/instance-settings.test.ts && git commit -m "Slice 6 T5: persist cooldowns and route model tiers"`

**Done when:** routing and persistent cooldowns are tested through service/loop boundaries; removed guards are observed failing; no exhausted key is retried by request or job retry.

### S6-T6: Owner APIs for pools, bulk keys, recommended chain and Check models   ·   Wave 6
**Owns:** Modify: `packages/http/src/routes/assistant-providers.ts`, `packages/http/src/routes/assistant-providers.test.ts`, `packages/http/src/routes/assistant-setup.ts`, `packages/http/src/routes/assistant-setup.test.ts`, `packages/http/src/server.ts` only to add service dependencies, `packages/storage/src/schema.ts` is not edited here, Gemini provider eligibility records and their tests
**Reads (do not edit):** route auth/audit helpers, assistant provider store, model-chain contracts, capability fixtures in `apps/daemon/src/assistant/capability-fixtures.ts`
**Interfaces:** Consumes `ProviderConfigStore` project/pool/tier/limits, `routeRun`, `RouterRules`, model capability functions and `dashboard-test` run recorder. Produces owner-only `POST /api/assistant/keys/bulk`, recommended-chain and routing endpoints, `POST /api/assistant/models/check`, and typed request/response schemas; Check models response includes `{ fixtures: [{ id, expectedFirstAction, actualFirstAction, passed }], requestBudget, tier, reason }`.

- [ ] **Step 1: Write failing route tests** using the existing HTTP route test app/owner session fixtures. Assert non-owner gets 403; bulk parsing accepts one key per line or `key, project`, rejects empty/oversize/malformed lines and duplicate fingerprints, stores sealed keys and project label, audits only count/labels, returns no key/fingerprint; recommended chain inserts exact three Gemini pool entries at the top only when no Gemini entry exists and moves existing entries after them; all pool/tier/limit fields round-trip and chain remains capped at six; settings route owner-only validation; Check models states complete budget before first provider call, refuses when insufficient, uses selected entry, returns scorecard expected vs actual, stubs tool calls without executing actual tools, records source `dashboard-test`, and never sends Discord or mutating-tool effects. Include per-cost-class eligibility projections and may-train notice without refusal.
- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/http/src/routes/assistant-providers.test.ts packages/http/src/routes/assistant-setup.test.ts --maxWorkers=1` · Expected: FAIL because endpoints and fields are absent.
- [ ] **Step 3: Implement** — Extend route Zod schemas for `pool`, `tier`, `project`, limits and exact selected provider; reject chain over six and invalid provider/key relationships before writes. Bulk route: validate each line, hash for duplicate detection, use injected provider key verifier for one `models.list` check per Gemini key only, seal through the existing config-store boundary, auto-label `Gemini 1`, etc., and audit count/labels only. Return safe row status and requests/limits/learned limit without secret or fingerprint. Add one-click recommended chain with models/rates from plan constraints; existing OpenRouter rows are appended and remain within six. Check models: require owner, validate fixture ids and selected chain position, compute fixture count and reserve all budget before any calls, use only read-only bounded stub declarations for tools, record each call as `dashboard-test`, preserve per-guild recorder scope, and return first-action scorecard. Extend provider eligibility view to show free/paid Gemini terms independently; no terms warning blocks selection.
- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS.
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0.
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/http/src/routes/assistant-providers.ts packages/http/src/routes/assistant-setup.ts packages/http/src/server.ts packages/http/src/routes/assistant-providers.test.ts packages/http/src/routes/assistant-setup.test.ts` then `npx eslint packages/http/src/routes/assistant-providers.ts packages/http/src/routes/assistant-setup.ts packages/http/src/server.ts packages/http/src/routes/assistant-providers.test.ts packages/http/src/routes/assistant-setup.test.ts` · exit 0.
- [ ] **Step 7: Commit** — `git add packages/http/src/routes/assistant-providers.ts packages/http/src/routes/assistant-setup.ts packages/http/src/server.ts packages/http/src/routes/assistant-providers.test.ts packages/http/src/routes/assistant-setup.test.ts && git commit -m "Slice 6 T6: owner routes for pools and model checks"`

**Done when:** owner routes safely add and inspect pools, configure the Gemini chain, and run fixture checks without executing tools or posting messages.

### S6-T7: Dashboard key pools, routing controls and Check models   ·   Wave 6
**Owns:** Create: new dashboard components for provider pool/key entry, routing and Check models plus component tests; Modify: `packages/dashboard/src/pages/providers.tsx` only to mount components, dashboard API/types file and its tests
**Reads (do not edit):** `packages/dashboard/src/pages/providers.tsx`, `packages/dashboard/src/pages/providers.test.tsx`, `packages/dashboard/src/api/assistant.ts`, shared `Button`, `Field`, `Input`, `HelpTip`, `StatusPill` components
**Interfaces:** Consumes S6-T6 endpoints and types. Produces dashboard controls for project-labelled paste, pool and tier per model row, learned quota/cooldown statuses, recommended Gemini setup, router settings and Try the router, and Check models scorecard.

- [ ] **Step 1: Write failing dashboard tests** with `renderWithSession`, `stubFetch`, Testing Library and the existing `setupBody()` fixture. Assert pasted keys submit one request and never render back; same-project note is visible; provider pool and tier controls save correct values; recommended setup submits one action and shows three models with exact defaults; per-key statuses distinguish cooling, spent, invalid; router values render, save and reset, list controls are editable chips and Try the router makes no model call; Check models shows cost before confirmation, rejects/cancels if budget insufficient, displays expected/actual and pass state after response. Add a dashboard test for every new router setting rendering and saving as required by D17.
- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/dashboard/src/pages/providers.test.tsx packages/dashboard/src/api/assistant.test.ts --maxWorkers=1` · Expected: FAIL because controls and response types are absent.
- [ ] **Step 3: Implement** — Add new components rather than restructuring the existing provider page; mount them inside the current Model order / API keys sections. Use explicit labels/help/default/current/reset for every setting; render keywords and patterns as chip lists. Show “Keys from the same Google project share one 20/day.” Keep key values in a cleared-on-submit textarea and never display an API response containing key material. Surface learned values like “Google says 20/day”, `cooling until`, `spent until midnight PT`, and `invalid`. Add pool selector (`one key`/`all provider keys`) and tier selector (`standard`/`light`). Add Try the router display from local API result with no model call, and Check models confirmation naming exact request count before POST. Respect HTTP auth responses and never store pasted values in component state after success.
- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS.
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0.
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/dashboard/src/pages/providers.tsx packages/dashboard/src/pages/providers.test.tsx packages/dashboard/src/api/assistant.ts packages/dashboard/src/api/assistant.test.ts packages/dashboard/src/components/assistant-provider-pools.tsx packages/dashboard/src/components/assistant-provider-pools.test.tsx packages/dashboard/src/components/assistant-routing.tsx packages/dashboard/src/components/assistant-routing.test.tsx packages/dashboard/src/components/assistant-model-check.tsx packages/dashboard/src/components/assistant-model-check.test.tsx` then `npx eslint` on the same owned TS/TSX paths · exit 0.
- [ ] **Step 7: Commit** — `git add packages/dashboard/src/pages/providers.tsx packages/dashboard/src/pages/providers.test.tsx packages/dashboard/src/api/assistant.ts packages/dashboard/src/api/assistant.test.ts packages/dashboard/src/components/assistant-provider-pools.tsx packages/dashboard/src/components/assistant-provider-pools.test.tsx packages/dashboard/src/components/assistant-routing.tsx packages/dashboard/src/components/assistant-routing.test.tsx packages/dashboard/src/components/assistant-model-check.tsx packages/dashboard/src/components/assistant-model-check.test.tsx && git commit -m "Slice 6 T7: dashboard pool, routing and model-check controls"`

**Done when:** dashboard tests prove every new setting renders/saves and Check models exposes cost and safe scorecard without leaking submitted keys.

### S6-T8: Doctor, health display and required privacy/state records   ·   Wave 7
**Owns:** Modify: `apps/daemon/src/runtime/doctor.ts`, `apps/daemon/src/runtime/doctor.test.ts`, `packages/http/src/routes/assistant-model-health.ts`, `packages/http/src/routes/assistant-model-health.test.ts`, `packages/dashboard/src/api/runs.ts`, `packages/dashboard/src/api/runs.test.ts`, `docs/PRIVACY.md`, `docs/STATE.md`
**Reads (do not edit):** `docs/decisions/0143-key-pools-and-gemini-chain.md`, `docs/decisions/0144-complexity-routing.md`, provider terms records, cooldown APIs, shared contracts
**Interfaces:** Consumes cooldown/key projections and `routed` event; produces doctor checks for invalid keys and provider terms per cost class, health projection for fully spent pools versus individual exhausted keys, routed/tier step-log rendering, privacy disclosure and top-of-file state summary.

- [ ] **Step 1: Write failing tests** for doctor and health: invalid key fails doctor; valid exhausted key is normal if another pool key is usable; fully spent pool has a health warning with reset time; free Gemini `may-train` warning appears and paid/no-training is reported accurately. Dashboard run event renderer shows `Light: <reason>` / `Standard: <reason>` from `routed` without showing secrets. Verify existing fixtures and assertions using invented names.
- [ ] **Step 2: Run it and watch it fail** — `npx vitest run apps/daemon/src/runtime/doctor.test.ts packages/http/src/routes/assistant-model-health.test.ts packages/dashboard/src/api/runs.test.ts --maxWorkers=1` · Expected: FAIL for absent invalid/pool/routed reporting.
- [ ] **Step 3: Implement** — Add doctor checks to `apps/daemon/src/runtime/doctor.ts`; fail on any invalid key, warn if no usable key remains, and do not alarm on an ordinary spent key when siblings remain. Extend `packages/http/src/routes/assistant-model-health.ts` and its response to distinguish all-pool-spent from per-key spent/cooling and include a safe reset time. Add the event description in `packages/dashboard/src/api/runs.ts`. Update `docs/PRIVACY.md` with free Gemini may-train disclosure, paid Gemini no-training record, and Check models fixture/stub behaviour; update `docs/STATE.md` immediately after the first `---` with Slice 6 summary and migration/ADRs in the same style as the Slice 1 entry.
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run apps/daemon/src/runtime/doctor.test.ts packages/http/src/routes/assistant-model-health.test.ts packages/dashboard/src/api/runs.test.ts --maxWorkers=1` · Expected: PASS.
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0.
- [ ] **Step 6: Format and lint** — `npx prettier --write apps/daemon/src/runtime/doctor.ts apps/daemon/src/runtime/doctor.test.ts packages/http/src/routes/assistant-model-health.ts packages/http/src/routes/assistant-model-health.test.ts packages/dashboard/src/api/runs.ts packages/dashboard/src/api/runs.test.ts docs/PRIVACY.md docs/STATE.md` then `npx eslint apps/daemon/src/runtime/doctor.ts apps/daemon/src/runtime/doctor.test.ts packages/http/src/routes/assistant-model-health.ts packages/http/src/routes/assistant-model-health.test.ts packages/dashboard/src/api/runs.ts packages/dashboard/src/api/runs.test.ts` · exit 0.
- [ ] **Step 7: Commit** — `git add apps/daemon/src/runtime/doctor.ts apps/daemon/src/runtime/doctor.test.ts packages/http/src/routes/assistant-model-health.ts packages/http/src/routes/assistant-model-health.test.ts packages/dashboard/src/api/runs.ts packages/dashboard/src/api/runs.test.ts docs/PRIVACY.md docs/STATE.md && git commit -m "Slice 6 T8: report pool health and routing safely"`

**Done when:** doctor distinguishes invalid from normally spent keys; privacy and state describe shipped behavior; routed reason appears in the run log.

## Slice gate (orchestrator only, after the last wave)
npm run typecheck        (≈1.7 GB peak — run alone)
npm run lint
npx vitest run --maxWorkers=1
## After merge (owner)
Stop the daemon → `npm run db:migrate` → build → start. On AI setup, record Gemini free and paid terms separately, label each distinct Google project, paste provider keys, select “Use the recommended Gemini setup”, review router and background-job tiers, and check remaining key budgets before running Check models. In Discord, test a greeting, a reminder request, a long-thread follow-up, and a request after the first Gemini key is exhausted; verify fallback and run-history reasons. No live Gemini 429 is required; quota behavior is covered by the documented Google-format fixture.
