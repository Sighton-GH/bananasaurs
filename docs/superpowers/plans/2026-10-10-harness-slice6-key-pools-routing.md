# Slice 6: Provider key pools, cooldowns, Gemini chain and routing — implementation plan

> **Instinct plan.** Read with `2026-10-10-harness-00-instinct-handoff.md` and `2026-10-10-harness-00-shared-contracts.md`.
> **Status:** READY (round 1)

**Goal:** Run the assistant on pooled Gemini keys with restart-safe cooldowns, the recommended Gemini chain, deterministic complexity routing, and a safe dashboard model check.
**Spec:** docs/superpowers/specs/2026-10-09-assistant-harness-capability-design.md §Slice 6 (6a–6f), the Gemini half of 1g, decisions D8, D12, D13, D15, D16, §4.7
**ADRs:** 0143, 0144   **Migration:** key_pools_routing
**Base:** main @ 0371edc3

`ChainEntry` (`apps/daemon/src/assistant/model-chain.ts:39-52`) and `ProviderError`
(`packages/core/src/providers/errors.ts:12-73`) already exist with narrower meanings. This plan widens those
symbols in place to the shared-contract shapes; it introduces no competing names. `GeminiModelInfo`
(`packages/core/src/providers/gemini.ts:301-307`) already exists for the `models.list` shape; the contracts
`GeminiModelProfile` is a different type (capabilities plus free limits) and is added as named, so there is no
collision. `model-skipped` already exists in `run-events.ts:104-113`; this plan adds only the `routed` event and
records `model-skipped` with a cooldown reason. The runs `source` CHECK (`schema.ts:2455`) already allows
`dashboard-test`, so Check models needs no CHECK change.

## Global Constraints

- `CLAUDE.md` hard rules 1–9 apply. In particular: AI is never in the enforcement path; every query, key and job
  carries a guild id; model output passes Zod; every Discord side effect has a durable idempotency key; no secrets
  in code, logs or fixtures; no new outbound destination unless the slice's ADR records the owner's instruction.
- No new dependency.
- Fixtures use invented names (Sam L, Alex P, Car Team A). Never a real member's name or id.
- Canadian English, plain words in prompts and dashboard copy. No tool names shown to members.
- Write the failing test first for anything touching permissions, pings, idempotency, retention or guild scope, and
  watch it fail before writing the code.

Slice-specific constraints (exact values from the spec):
- Provider credentials, Discord tokens and tunnel secrets stay outside source control. Tests use fake keys such as
  `AIza-test-one`, never a real key.
- The Gemini 429 fixture is written from Google's documented `google.rpc.QuotaFailure` and
  `google.rpc.RetryInfo` JSON shape; no live provider call is made or required. Pin `PerDay`, `PerMinute`,
  token-per-minute, `quotaValue` and `retryDelay` cases in the fixture.
- Google free-tier defaults are exactly 5 RPM / 20 RPD for `gemini-3.8-flash` and `gemini-3.6-flash`, and 15 RPM /
  500 RPD for `gemini-3.5-flash-lite`; TPM 250,000 is displayed as information and is not locally enforced.
- `pool: 'key'` behaves exactly as today; `pool: 'provider'` resolves every enabled key of the entry's provider.
  A pool never opens or logs a secret outside the provider construction boundary.
- The chain stays at most six entries. Pool selection is deterministic: usable key with the most remaining daily
  requests, tie-broken by least recently used, then key id.
- A daily cooldown lasts until the next Pacific midnight (`nextProviderDayStart('gemini', now)`); a minute
  cooldown uses provider retry delay or 60 seconds. Invalid 401/403 keys stay invalid until edit or re-test. Fully
  spent pools move to the next chain entry and do not schedule a retry.
- Terms are disclosures, never gates. Gemini free keys are recorded as may-train while paid keys are recorded as
  no-train; both remain usable and warnings appear in logs, dashboard and doctor.
- Every new setting is registered, owner-editable and tested through the dashboard. Lists use editable chips, not
  comma-separated text.
- Slice 2 runs in parallel. Edits to shared contract files are additive and limited to the Slice 6 symbols named
  in §3; do not reorder existing unions or unrelated entries.

## Plan decisions

- Fingerprint is SHA-256 hex of the secret (`fingerprintOf`, stored with the key row, never returned); bulk paste
  is idempotent without exposing the secret. The column is nullable so existing rows migrate untouched.
- `project` is an owner-entered opaque label (max 80 chars). The quota bucket is `project:<label>` when set,
  else `key:<keyId>`; blank labels never share a bucket.
- An unknown Gemini model is `TEXT_AND_TOOLS_ONLY` with thinking `none`; `gemini-3.5-flash-lite` ships with the
  verified table entry and 15/500 defaults.
- `quotaScope: 'daily-free'` is kept for the OpenRouter `:free` path; Gemini uses `'day'` / `'minute'`.
- `QuotaLedger` keeps its constructor so existing call sites compile, but the loop no longer consults it; the
  persistent cooldown table is authoritative.
- Pool chain rows anchor to the provider's oldest key id (foreign key), but runtime expansion uses the provider,
  not the anchor; recommended setup refuses when no Gemini key exists.
- Keyword and greeting-pattern settings are string arrays with display `text`, rendered as chip lists by the new
  routing component.
- Check models defines its own `CHECK_FIXTURES` (id, message, expected first action) in the route module; budget
  equals fixture count and is reserved before the first call; ledger source is `dashboard-test`.
- `routed` reasons use a fixed vocabulary (`greeting`, `short-and-simple`, `router-off`, `long-message`,
  `has-attachments`, `has-quote`, `full-model-keyword`, `long-thread`).
- Eligibility lookup prefers `gemini:free` / `gemini:paid` rows and falls back to the `gemini` row, so existing
  setups keep working.

## Review Focus

1. A Gemini daily 429 must prevent that exact key/model from being called on two later runs and after restart;
   the documented Google error fixture proves the parsed scope and learned limit. (S6-T5 parser, S6-T6 storage,
   S6-T11 loop)
2. A pool with one spent key must select another enabled key, while a pool with all keys spent emits
   `model-skipped` and falls through without retrying. (S6-T10, S6-T11)
3. Keys sharing a project label must share the daily ledger bucket; keys with different labels must not. (S6-T6,
   S6-T10)
4. A greeting must route to `light`, while an attachment, quoted reply, long thread, or full-model keyword routes
   to `standard`; a light tool call escalates on the next round. (S6-T4, S6-T13)
5. Check models must show expected versus first action, reserve its complete budget before calling, stub every
   tool, and write only a `dashboard-test` ledger source without posting or mutating member data. (S6-T14)

## Waves

| Wave | Task | Owns (create/modify) | Depends on |
|---|---|---|---|
| 1 | S6-T1 ADR 0143 | Create: `docs/decisions/0143-key-pools-and-gemini-chain.md` | — |
| 1 | S6-T2 ADR 0144 | Create: `docs/decisions/0144-complexity-routing.md` | — |
| 1 | S6-T3 Gemini capability table | Create: `packages/core/src/providers/model-capabilities.ts`, `packages/core/src/providers/model-capabilities.test.ts` · Modify: `packages/core/src/index.ts` (one export line) | — |
| 1 | S6-T4 Pure complexity router | Create: `packages/core/src/assistant/router.ts`, `packages/core/src/assistant/router.test.ts` | — |
| 1 | S6-T5 Pure Gemini quota parser + fixture | Create: `packages/core/src/providers/gemini-quota.ts`, `packages/core/src/providers/__fixtures__/gemini-429-quota.json`, `packages/core/src/providers/gemini-quota.test.ts` | — |
| 2 | S6-T6 Migration, keys, cooldown store | Modify: `packages/storage/src/schema.ts`, `packages/storage/src/repos/assistant-providers.ts` · Create: `packages/storage/src/repos/assistant-key-cooldowns.ts`, `packages/storage/src/repos/assistant-key-cooldowns.test.ts`, `packages/storage/src/repos/assistant-pools.test.ts` + generated `drizzle/` | S6-T1 |
| 2 | S6-T7 Error fields + adapter mapping | Modify: `packages/core/src/providers/errors.ts`, `packages/core/src/providers/gemini.ts`, `packages/core/src/providers/openai-compatible.ts`, `packages/core/src/index.ts` (one export line), `packages/core/src/providers/gemini.test.ts` · Create: `packages/core/src/providers/quota-fields.test.ts` | S6-T5 |
| 2 | S6-T8 Daemon capability mapping | Create: `apps/daemon/src/assistant/model-capabilities.ts`, `apps/daemon/src/assistant/model-capabilities.test.ts` | S6-T3 |
| 2 | S6-T9 Router and tier settings | Modify: `packages/core/src/settings/instance-settings.ts`, `packages/core/src/settings/instance-settings.test.ts` | S6-T1 |
| 3 | S6-T10 Pool resolution and selection | Modify: `apps/daemon/src/assistant/model-chain.ts`, `apps/daemon/src/assistant/provider-config.ts`, `apps/daemon/src/assistant/model-chain.test.ts`, `apps/daemon/src/assistant/provider-config.test.ts` | S6-T6, S6-T7, S6-T8 |
| 3 | S6-T11 Loop cooldowns + routed event | Modify: `apps/daemon/src/assistant/tool-loop.ts`, `apps/daemon/src/assistant/tool-loop.test.ts`, `packages/core/src/assistant/run-events.ts`, `packages/core/src/assistant/run-events.test.ts` | S6-T6, S6-T7 |
| 3 | S6-T12 Bulk keys + recommended chain routes | Modify: `packages/http/src/routes/assistant-providers.ts`, `packages/http/src/routes/assistant-providers.test.ts` | S6-T6 |
| 4 | S6-T13 Service routing + escalation | Modify: `apps/daemon/src/assistant/service.ts`, `apps/daemon/src/assistant/service.test.ts`, `packages/core/src/index.ts` (one export line) | S6-T4, S6-T9, S6-T10, S6-T11 |
| 4 | S6-T14 Check-models route | Create: `packages/http/src/routes/assistant-model-check.ts`, `packages/http/src/routes/assistant-model-check.test.ts` · Modify: `packages/http/src/server.ts` (register call only) | S6-T6, S6-T10 |
| 4 | S6-T15 Doctor, health, run-event text | Modify: `apps/daemon/src/runtime/doctor.ts`, `apps/daemon/src/runtime/doctor.test.ts`, `packages/http/src/routes/assistant-model-health.ts`, `packages/http/src/routes/assistant-model-health.test.ts`, `packages/dashboard/src/api/runs.ts` · Create: `packages/dashboard/src/api/runs.test.ts` | S6-T11 |
| 5 | S6-T16 Dashboard pools, routing, check UI | Create: `packages/dashboard/src/components/assistant-keys-paste.tsx`, `packages/dashboard/src/components/assistant-key-status-rows.tsx`, `packages/dashboard/src/components/assistant-chain-pools.tsx`, `packages/dashboard/src/components/assistant-recommended-setup.tsx`, `packages/dashboard/src/components/assistant-routing-settings.tsx`, `packages/dashboard/src/components/assistant-model-check.tsx`, `packages/dashboard/src/components/assistant-slice6.test.tsx`, `packages/dashboard/src/api/assistant-slice6.test.ts` · Modify: `packages/dashboard/src/pages/providers.tsx` (mount only), `packages/dashboard/src/pages/providers.test.tsx`, `packages/dashboard/src/api/assistant.ts` (additive types) | S6-T12, S6-T13, S6-T14, S6-T15 |
| 5 | S6-T17 STATE.md + PRIVACY.md | Modify: `docs/STATE.md`, `docs/PRIVACY.md` | S6-T1, S6-T2, S6-T13, S6-T15 |

Tasks in the same wave own disjoint files: wave 1 touches five separate paths; wave 2 touches storage vs
core-providers vs daemon-capabilities vs settings; wave 3 touches chain vs loop vs HTTP keys routes; wave 4
touches service vs HTTP check route vs doctor/health; wave 5 touches dashboard vs docs.

## Tasks

### S6-T1: ADR 0143 key pools, cooldowns and Gemini chain   ·   Wave 1
**Owns:** Create: `docs/decisions/0143-key-pools-and-gemini-chain.md`
**Reads (do not edit):** `docs/decisions/0137-read-only-tools-in-later-rounds.md` (style model),
`docs/superpowers/plans/2026-10-10-harness-00-shared-contracts.md` §2 (ADR number)
**Interfaces:** Consumes: none · Produces: ADR 0143 (decisions S6-T3–S6-T17 cite by number)

- [ ] **Step 1: Write the failing test** — not applicable (documents). Verify the number is free first:
  `ls docs/decisions/0143-*` must print nothing; `rg -n "0143" docs/superpowers/plans/2026-10-10-harness-00-shared-contracts.md`
  must show the contracts ADR table row for Slice 6.
- [ ] **Step 2: Run it and watch it fail** — not applicable (documents).
- [ ] **Step 3: Implement** — write the full ADR text:

```markdown
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
```

- [ ] **Step 4: Run it and watch it pass** — not applicable (documents).
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0 (docs only; proves nothing else broke)
- [ ] **Step 6: Format and lint** — `npx prettier --write docs/decisions/0143-key-pools-and-gemini-chain.md`
  then `npx eslint docs/decisions/0143-key-pools-and-gemini-chain.md` · exit 0
- [ ] **Step 7: Commit** — `git add docs/decisions/0143-key-pools-and-gemini-chain.md && git commit -m "Slice 6 T1: ADR 0143 key pools and Gemini chain"`

**Done when:** ADR 0143 exists with Context/Decision/Consequences; contracts ADR table matches; gates pass.

---

### S6-T2: ADR 0144 deterministic complexity routing   ·   Wave 1
**Owns:** Create: `docs/decisions/0144-complexity-routing.md`
**Reads (do not edit):** `docs/decisions/0137-read-only-tools-in-later-rounds.md` (style model),
`docs/superpowers/plans/2026-10-10-harness-00-shared-contracts.md` §2 (ADR number)
**Interfaces:** Consumes: none · Produces: ADR 0144 (decisions S6-T4, S6-T9, S6-T13 cite by number)

- [ ] **Step 1: Write the failing test** — not applicable (documents). Verify the number is free first:
  `ls docs/decisions/0144-*` must print nothing.
- [ ] **Step 2: Run it and watch it fail** — not applicable (documents).
- [ ] **Step 3: Implement** — write the full ADR text:

```markdown
# 0144. Deterministic complexity routing

Date: 2026-10-11

Status: accepted (owner decision D16, 2026-10-10).

## Context

Simple greetings should not spend the standard Gemini daily quota of 20 requests per project. A model-based
classifier would cost a provider request and could route nondeterministically.

## Decision

1. A pure deterministic function `routeRun(input, rules)` selects `light` only for short messages with no
   attachments or quote/reply, no full-model keyword, and at most four earlier turns. Configurable
   greeting/thanks/emoji patterns stay light even in long conversations.
2. A light run tries light entries first, then standard entries in order; a standard run tries standard entries in
   order, then light entries last. A light run that invokes a tool switches to standard for its next model round
   (configurable, on by default).
3. Router rules and background-job tiers are instance settings visible on the dashboard. Routing is auditable
   through a fixed reason string and the `routed` run event. No classifier call is ever made.

## Consequences

- Misclassification is corrected by the owner through editable keyword and greeting lists, not code changes.
- Background summaries and the daily digest default to the light tier, keeping Flash quota for members.
```

- [ ] **Step 4: Run it and watch it pass** — not applicable (documents).
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write docs/decisions/0144-complexity-routing.md`
  then `npx eslint docs/decisions/0144-complexity-routing.md` · exit 0
- [ ] **Step 7: Commit** — `git add docs/decisions/0144-complexity-routing.md && git commit -m "Slice 6 T2: ADR 0144 complexity routing"`

**Done when:** ADR 0144 exists with Context/Decision/Consequences; gates pass.

---

### S6-T3: Gemini capability table and shared capability types   ·   Wave 1
**Owns:** Create: `packages/core/src/providers/model-capabilities.ts`,
`packages/core/src/providers/model-capabilities.test.ts` · Modify additively:
`packages/core/src/index.ts` (append one export line)
**Reads (do not edit):** `packages/core/src/index.ts` tail (export style),
`packages/core/src/providers/gemini.ts:300-307` (`GeminiModelInfo`, a different type — do not rename it)
**Interfaces:** Consumes: none · Produces: `ThinkingControl`, `ModelCapabilities`, `GeminiModelProfile`,
`GEMINI_MODEL_TABLE`, `geminiCapabilities(model: string): ModelCapabilities`, `TEXT_AND_TOOLS_ONLY` with the exact
contracts §3 signatures (for S6-T8)

- [ ] **Step 1: Write the failing test** — create
  `packages/core/src/providers/model-capabilities.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  GEMINI_MODEL_TABLE,
  TEXT_AND_TOOLS_ONLY,
  geminiCapabilities,
} from './model-capabilities.js';

describe('geminiCapabilities (ADR 0143)', () => {
  it('marks gemini-3.8-flash as full capability with 5/20 free limits', () => {
    expect(GEMINI_MODEL_TABLE['gemini-3.8-flash']).toEqual({
      tools: true,
      image: true,
      pdf: true,
      reasoning: true,
      thinking: 'levels',
      freeRpm: 5,
      freeRpd: 20,
    });
    expect(geminiCapabilities('gemini-3.8-flash')).toEqual({
      tools: true,
      image: true,
      pdf: true,
      reasoning: true,
      thinking: 'levels',
    });
  });
  it('marks gemini-3.6-flash the same and flash-lite 15/500', () => {
    expect(GEMINI_MODEL_TABLE['gemini-3.6-flash']).toMatchObject({ freeRpm: 5, freeRpd: 20 });
    expect(GEMINI_MODEL_TABLE['gemini-3.5-flash-lite']).toMatchObject({
      tools: true,
      image: true,
      pdf: true,
      reasoning: true,
      thinking: 'levels',
      freeRpm: 15,
      freeRpd: 500,
    });
  });
  it('treats an unknown Gemini model as text plus tools only', () => {
    expect(TEXT_AND_TOOLS_ONLY).toEqual({
      tools: true,
      image: false,
      pdf: false,
      reasoning: false,
      thinking: 'none',
    });
    expect(geminiCapabilities('gemini-9.9-ultra')).toBe(TEXT_AND_TOOLS_ONLY);
  });
});
```

- [ ] **Step 2: Run it and watch it fail** —
  `npx vitest run packages/core/src/providers/model-capabilities.test.ts --maxWorkers=1` · Expected: FAIL with
  `Failed to resolve import "./model-capabilities.js"`
- [ ] **Step 3: Implement** — create `packages/core/src/providers/model-capabilities.ts`:

```ts
/** Which thinking control a model family takes (contracts §3, Slice 6 produces). */
export type ThinkingControl = 'levels' | 'budget' | 'none';

export interface ModelCapabilities {
  readonly tools: boolean;
  readonly image: boolean;
  readonly pdf: boolean;
  readonly reasoning: boolean;
  readonly thinking: ThinkingControl;
}

/** Known Gemini models: capabilities plus free-tier limits for pre-filling a chain row. */
export interface GeminiModelProfile extends ModelCapabilities {
  readonly freeRpm?: number;
  readonly freeRpd?: number;
}

const FULL_GEMINI: ModelCapabilities = {
  tools: true,
  image: true,
  pdf: true,
  reasoning: true,
  thinking: 'levels',
};

export const GEMINI_MODEL_TABLE: Readonly<Record<string, GeminiModelProfile>> = {
  'gemini-3.8-flash': { ...FULL_GEMINI, freeRpm: 5, freeRpd: 20 },
  'gemini-3.6-flash': { ...FULL_GEMINI, freeRpm: 5, freeRpd: 20 },
  'gemini-3.5-flash-lite': { ...FULL_GEMINI, freeRpm: 15, freeRpd: 500 },
};

/** Unknown Gemini model → text + tools only, thinking 'none'. */
export const TEXT_AND_TOOLS_ONLY: ModelCapabilities = {
  tools: true,
  image: false,
  pdf: false,
  reasoning: false,
  thinking: 'none',
};

export function geminiCapabilities(model: string): ModelCapabilities {
  const row = GEMINI_MODEL_TABLE[model];
  if (row === undefined) return TEXT_AND_TOOLS_ONLY;
  return {
    tools: row.tools,
    image: row.image,
    pdf: row.pdf,
    reasoning: row.reasoning,
    thinking: row.thinking,
  };
}
```

Then append one line to `packages/core/src/index.ts` in its existing export style (read the tail first; the file
is a list of `export ... from './...js';` lines):
`export * from './providers/model-capabilities.js';`

- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** —
  `npx prettier --write packages/core/src/providers/model-capabilities.ts packages/core/src/providers/model-capabilities.test.ts packages/core/src/index.ts`
  then `npx eslint packages/core/src/providers/model-capabilities.ts packages/core/src/providers/model-capabilities.test.ts packages/core/src/index.ts` · exit 0
- [ ] **Step 7: Commit** —
  `git add packages/core/src/providers/model-capabilities.ts packages/core/src/providers/model-capabilities.test.ts packages/core/src/index.ts && git commit -m "Slice 6 T3: Gemini capability table and shared types"`

**Done when:** the three known models carry exact spec limits; unknown models return the shared
`TEXT_AND_TOOLS_ONLY` reference; the root index re-exports the module.

---

### S6-T4: Pure complexity router and tier ordering   ·   Wave 1
**Owns:** Create: `packages/core/src/assistant/router.ts`, `packages/core/src/assistant/router.test.ts`
**Reads (do not edit):** contracts §3 router signatures (names are fixed)
**Interfaces:** Consumes: none · Produces: `ChainTier`, `RouterRules`, `RouteInput`, `DEFAULT_ROUTER_RULES`,
`routeRun(input: RouteInput, rules: RouterRules): { tier: ChainTier; reason: string }`,
`orderChainByTier<T extends { readonly tier: ChainTier }>(entries: readonly T[], tier: ChainTier): T[]` (for
S6-T13; the root-index export line lands in S6-T13)

- [ ] **Step 1: Write the failing test** — create `packages/core/src/assistant/router.test.ts` (table-driven cases
  from spec 6e):

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTER_RULES,
  orderChainByTier,
  routeRun,
  type RouteInput,
} from './router.js';

const input = (over: Partial<RouteInput> = {}): RouteInput => ({
  text: 'hi',
  hasAttachments: false,
  hasQuoteOrReply: false,
  earlierTurns: 0,
  ...over,
});

describe('routeRun (ADR 0144, spec 6e)', () => {
  it.each([
    ['hi', 'light'],
    ['thanks!', 'light'],
    ['remind me at 5', 'standard'],
    ['can you ping Sam L', 'standard'],
    ['search the web for TRIUMF tours', 'standard'],
    ['write a story about a racerbot', 'standard'],
  ] as const)('%s routes %s', (text, tier) => {
    expect(routeRun(input({ text }), DEFAULT_ROUTER_RULES).tier).toBe(tier);
  });
  it('routes an 81-character plain message to standard under the default 80', () => {
    const text = 'x'.repeat(81);
    expect(routeRun(input({ text }), DEFAULT_ROUTER_RULES)).toEqual({
      tier: 'standard',
      reason: 'long-message',
    });
  });
  it('routes attachments, quotes and long threads to standard', () => {
    expect(routeRun(input({ text: 'look at this' }), DEFAULT_ROUTER_RULES).tier).toBe('light');
    expect(routeRun(input({ text: 'look at this', hasAttachments: true }), DEFAULT_ROUTER_RULES)).toEqual({
      tier: 'standard',
      reason: 'has-attachments',
    });
    expect(
      routeRun(input({ text: 'look at this', hasQuoteOrReply: true }), DEFAULT_ROUTER_RULES),
    ).toEqual({ tier: 'standard', reason: 'has-quote' });
    expect(routeRun(input({ text: 'and then?', earlierTurns: 5 }), DEFAULT_ROUTER_RULES)).toEqual({
      tier: 'standard',
      reason: 'long-thread',
    });
  });
  it('keeps a greeting light inside a long thread', () => {
    expect(routeRun(input({ text: 'thanks!', earlierTurns: 9 }), DEFAULT_ROUTER_RULES)).toEqual({
      tier: 'light',
      reason: 'greeting',
    });
  });
  it('always selects standard when disabled', () => {
    expect(
      routeRun(input({ text: 'hi' }), { ...DEFAULT_ROUTER_RULES, enabled: false }),
    ).toEqual({ tier: 'standard', reason: 'router-off' });
  });
  it('pins the spec defaults', () => {
    expect(DEFAULT_ROUTER_RULES).toMatchObject({
      enabled: true,
      maxChars: 80,
      longThreadTurns: 4,
      escalateOnTool: true,
    });
    expect(DEFAULT_ROUTER_RULES.fullModelKeywords).toContain('remind');
    expect(DEFAULT_ROUTER_RULES.fullModelKeywords).toHaveLength(16);
  });
});

describe('orderChainByTier', () => {
  const entries = [
    { id: 's1', tier: 'standard' as const },
    { id: 'l1', tier: 'light' as const },
    { id: 's2', tier: 'standard' as const },
  ];
  it('tries light first on a light run, standard first on a standard run', () => {
    expect(orderChainByTier(entries, 'light').map((e) => e.id)).toEqual(['l1', 's1', 's2']);
    expect(orderChainByTier(entries, 'standard').map((e) => e.id)).toEqual(['s1', 's2', 'l1']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail** —
  `npx vitest run packages/core/src/assistant/router.test.ts --maxWorkers=1` · Expected: FAIL with
  `Failed to resolve import "./router.js"`
- [ ] **Step 3: Implement** — create `packages/core/src/assistant/router.ts`:

```ts
/** Which half of the chain a run tries first (contracts §3, Slice 6 produces). */
export type ChainTier = 'standard' | 'light';

export interface RouterRules {
  readonly enabled: boolean;
  readonly maxChars: number;
  readonly fullModelKeywords: readonly string[];
  readonly greetingPatterns: readonly string[];
  readonly longThreadTurns: number;
  readonly escalateOnTool: boolean;
}

export interface RouteInput {
  /** Mentions already stripped. */
  readonly text: string;
  readonly hasAttachments: boolean;
  readonly hasQuoteOrReply: boolean;
  readonly earlierTurns: number;
}

/** Spec 6e defaults: on, 80 chars, 16 full-model keywords, 4-turn thread cap, escalate on. */
export const DEFAULT_ROUTER_RULES: RouterRules = {
  enabled: true,
  maxChars: 80,
  fullModelKeywords: [
    'remind',
    'schedule',
    'task',
    'ping',
    'search',
    'look up',
    'summar',
    'explain',
    'why',
    'how',
    'write',
    'story',
    'code',
    'plan',
    'compare',
    'translate',
    'fix',
  ],
  greetingPatterns: [
    'hi',
    'hello',
    'hey',
    'thanks',
    'thank you',
    'thx',
    'good morning',
    'good night',
  ],
  longThreadTurns: 4,
  escalateOnTool: true,
};

const isEmojiOnly = (text: string): boolean =>
  text.length > 0 && /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\s]*$/u.test(text);

const isGreeting = (text: string, rules: RouterRules): boolean => {
  const clean = text.trim().toLowerCase().replace(/[.!?…\s]+$/g, '');
  if (isEmojiOnly(text.trim())) return true;
  return rules.greetingPatterns.some((pattern) => clean === pattern.toLowerCase());
};

/** Deterministic and free: no AI request is spent to classify. Reasons are a fixed vocabulary. */
export function routeRun(
  input: RouteInput,
  rules: RouterRules,
): { tier: ChainTier; reason: string } {
  if (!rules.enabled) return { tier: 'standard', reason: 'router-off' };
  if (isGreeting(input.text, rules)) return { tier: 'light', reason: 'greeting' };
  if (input.text.length > rules.maxChars) return { tier: 'standard', reason: 'long-message' };
  if (input.hasAttachments) return { tier: 'standard', reason: 'has-attachments' };
  if (input.hasQuoteOrReply) return { tier: 'standard', reason: 'has-quote' };
  const lowered = input.text.toLowerCase();
  if (rules.fullModelKeywords.some((keyword) => lowered.includes(keyword.toLowerCase()))) {
    return { tier: 'standard', reason: 'full-model-keyword' };
  }
  if (input.earlierTurns > rules.longThreadTurns) {
    return { tier: 'standard', reason: 'long-thread' };
  }
  return { tier: 'light', reason: 'short-and-simple' };
}

/** Light run: light entries first, then standard in order. Standard run: standard in order, then light. */
export function orderChainByTier<T extends { readonly tier: ChainTier }>(
  entries: readonly T[],
  tier: ChainTier,
): T[] {
  const first = tier === 'light' ? 'light' : 'standard';
  const second = tier === 'light' ? 'standard' : 'light';
  return [...entries.filter((e) => e.tier === first), ...entries.filter((e) => e.tier === second)];
}
```

- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** —
  `npx prettier --write packages/core/src/assistant/router.ts packages/core/src/assistant/router.test.ts`
  then `npx eslint packages/core/src/assistant/router.ts packages/core/src/assistant/router.test.ts` · exit 0
- [ ] **Step 7: Commit** —
  `git add packages/core/src/assistant/router.ts packages/core/src/assistant/router.test.ts && git commit -m "Slice 6 T4: pure complexity router and tier ordering"`

**Done when:** every 6e table case passes (`hi` light, `remind me at 5` standard, attachment/quote/long-thread
standard, greeting-in-long-thread light); ordering tries the run's tier first.

---

### S6-T5: Pure Gemini quota-error parser and documented fixture   ·   Wave 1
**Owns:** Create: `packages/core/src/providers/gemini-quota.ts`,
`packages/core/src/providers/__fixtures__/gemini-429-quota.json`,
`packages/core/src/providers/gemini-quota.test.ts`
**Reads (do not edit):** `packages/core/src/providers/gemini.test.ts:1-10` (the `ok()` helper style for fake
`fetch`; this task uses no fetch — the parser is pure)
**Interfaces:** Consumes: none · Produces: `parseGeminiQuotaError(body: unknown): { readonly scope:
'day' | 'minute' | undefined; readonly retryAfterMs?: number; readonly learnedLimit?: { readonly perDay?:
number; readonly perMinute?: number } }` (for S6-T7's adapter wiring). No live call; the fixture is hand-written
from Google's documented error shape.

- [ ] **Step 1: Write the failing test** — create `packages/core/src/providers/gemini-quota.test.ts`. First create
  the fixture `packages/core/src/providers/__fixtures__/gemini-429-quota.json` (Step 3 code below), then:

```ts
import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/gemini-429-quota.json';
import { parseGeminiQuotaError } from './gemini-quota.js';

const violation = (quotaId: string, quotaValue: string) => ({
  quotaMetric: 'generativelanguage.googleapis.com/generate_requests',
  quotaId,
  quotaDimensions: { model: 'gemini-3.8-flash' },
  quotaValue,
});

const bodyWith = (details: unknown[]) => ({
  error: { code: 429, message: 'Resource has been exhausted.', status: 'RESOURCE_EXHAUSTED', details },
});

describe('parseGeminiQuotaError (ADR 0143)', () => {
  it('parses the documented fixture: daily wins, minute and retry delay kept', () => {
    expect(parseGeminiQuotaError(fixture)).toEqual({
      scope: 'day',
      retryAfterMs: 37_000,
      learnedLimit: { perDay: 20, perMinute: 5 },
    });
  });
  it('maps a minute-only violation to minute scope with its learned limit', () => {
    const body = bodyWith([
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [violation('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '5')],
      },
    ]);
    expect(parseGeminiQuotaError(body)).toEqual({
      scope: 'minute',
      learnedLimit: { perMinute: 5 },
    });
  });
  it('maps a token-per-minute violation to minute scope', () => {
    const body = bodyWith([
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [violation('GenerateTokensPerMinutePerProjectPerModel-FreeTier', '250000')],
      },
    ]);
    expect(parseGeminiQuotaError(body)?.scope).toBe('minute');
  });
  it('returns undefined scope for missing or malformed details', () => {
    expect(parseGeminiQuotaError({ error: { status: 'RESOURCE_EXHAUSTED' } })).toEqual({
      scope: undefined,
    });
    expect(parseGeminiQuotaError({ nope: true })).toEqual({ scope: undefined });
    expect(parseGeminiQuotaError(null)).toEqual({ scope: undefined });
  });
  it('ignores unsafe quota values and caps retry delays', () => {
    const body = bodyWith([
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [violation('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'lots')],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '999999s' },
    ]);
    const parsed = parseGeminiQuotaError(body);
    expect(parsed?.scope).toBe('day');
    expect(parsed?.learnedLimit).toBeUndefined();
    expect(parsed?.retryAfterMs).toBeLessThanOrEqual(3_600_000);
  });
});
```

- [ ] **Step 2: Run it and watch it fail** —
  `npx vitest run packages/core/src/providers/gemini-quota.test.ts --maxWorkers=1` · Expected: FAIL with
  `Failed to resolve import "./gemini-quota.js"`
- [ ] **Step 3: Implement** — write the fixture (hand-written from Google's documented shape, never captured from
  a real call; fake model name only in dimensions):

```json
{
  "error": {
    "code": 429,
    "message": "Resource has been exhausted (e.g. check quota).",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        "violations": [
          {
            "quotaMetric": "generativelanguage.googleapis.com/generate_requests",
            "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
            "quotaDimensions": { "model": "gemini-3.8-flash", "location": "global" },
            "quotaValue": "20"
          },
          {
            "quotaMetric": "generativelanguage.googleapis.com/generate_requests",
            "quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
            "quotaDimensions": { "model": "gemini-3.8-flash", "location": "global" },
            "quotaValue": "5"
          }
        ]
      },
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        "retryDelay": "37s"
      }
    ]
  }
}
```

and create `packages/core/src/providers/gemini-quota.ts`:

```ts
import { z } from 'zod';

export interface ParsedGeminiQuota {
  readonly scope: 'day' | 'minute' | undefined;
  readonly retryAfterMs?: number;
  readonly learnedLimit?: { readonly perDay?: number; readonly perMinute?: number };
}

const violationSchema = z.object({
  quotaId: z.string().optional(),
  quotaValue: z.string().optional(),
});

const detailsSchema = z.object({
  error: z
    .object({
      details: z
        .array(z.object({ '@type': z.string(), violations: z.array(violationSchema).optional(), retryDelay: z.string().optional() }))
        .optional(),
    })
    .optional(),
});

const safeQuotaValue = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000_000) return undefined;
  return value;
};

/** `37s`, `1.5s`, `200ms`: seconds plus nanos, capped to one hour. */
const safeRetryDelayMs = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const match = /^(\d+)(?:\.(\d{1,9}))?s$/.exec(raw);
  if (match === null) return undefined;
  const seconds = Number(match[1]);
  const nanos = Number((match[2] ?? '0').padEnd(9, '0'));
  if (!Number.isSafeInteger(seconds)) return undefined;
  return Math.min(seconds * 1000 + Math.floor(nanos / 1_000_000), 3_600_000);
};

/**
 * Pure parse of a Gemini 429 body (ADR 0143). Daily wins when daily and minute violations coexist; a
 * token-per-minute violation is minute scope. Never throws; unknown shapes yield `{ scope: undefined }`.
 */
export const parseGeminiQuotaError = (body: unknown): ParsedGeminiQuota => {
  const parsed = detailsSchema.safeParse(body);
  if (!parsed.success) return { scope: undefined };
  const details = parsed.data.error?.details ?? [];
  let perDay: number | undefined;
  let perMinute: number | undefined;
  let sawDaily = false;
  let sawMinute = false;
  let retryAfterMs: number | undefined;
  for (const detail of details) {
    if (detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo') {
      const delay = safeRetryDelayMs(detail.retryDelay);
      if (delay !== undefined) retryAfterMs = delay;
    }
    if (detail['@type'] !== 'type.googleapis.com/google.rpc.QuotaFailure') continue;
    for (const violation of detail.violations ?? []) {
      const id = violation.quotaId ?? '';
      const value = safeQuotaValue(violation.quotaValue);
      if (/PerDay/i.test(id)) {
        sawDaily = true;
        if (value !== undefined) perDay = value;
      } else if (/PerMinute/i.test(id)) {
        sawMinute = true;
        if (value !== undefined) perMinute = value;
      }
    }
  }
  const scope = sawDaily ? 'day' : sawMinute ? 'minute' : undefined;
  if (scope === undefined) return { scope: undefined };
  const learnedLimit =
    perDay !== undefined && perMinute !== undefined
      ? { perDay, perMinute }
      : perDay !== undefined
        ? { perDay }
        : perMinute !== undefined
          ? { perMinute }
          : undefined;
  return {
    scope,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(learnedLimit === undefined ? {} : { learnedLimit }),
  };
};
```

- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** —
  `npx prettier --write packages/core/src/providers/gemini-quota.ts packages/core/src/providers/gemini-quota.test.ts packages/core/src/providers/__fixtures__/gemini-429-quota.json`
  then `npx eslint packages/core/src/providers/gemini-quota.ts packages/core/src/providers/gemini-quota.test.ts` · exit 0
- [ ] **Step 7: Commit** —
  `git add packages/core/src/providers/gemini-quota.ts packages/core/src/providers/gemini-quota.test.ts packages/core/src/providers/__fixtures__/gemini-429-quota.json && git commit -m "Slice 6 T5: pure Gemini quota parser and documented fixture"`

**Done when:** the documented fixture parses to day scope with both learned limits and 37 s; malformed bodies
stay safe; no test makes a network call.

---

<!-- PASS3 -->

## Slice gate (orchestrator only, after the last wave)
npm run typecheck        (≈1.7 GB peak — run alone)
npm run lint
npx vitest run --maxWorkers=1
## After merge (owner)
Stop the daemon → `npm run db:migrate` → build → start. On AI setup, record Gemini free and paid terms
separately, label each distinct Google project, paste provider keys, select "Use the recommended Gemini setup",
review router and background-job tiers, and check remaining key budgets before running Check models. In Discord,
test a greeting, a reminder request, a long-thread follow-up, and a request after the first Gemini key is
exhausted; verify fallback and run-history reasons. No live Gemini 429 is required; quota behaviour is covered by
the documented Google-format fixture.
