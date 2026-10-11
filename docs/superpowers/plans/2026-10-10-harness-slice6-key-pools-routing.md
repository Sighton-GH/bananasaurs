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
| 2 | S6-T6 Migration, keys, cooldown store | Modify: `packages/storage/src/schema.ts`, `packages/storage/src/repos/assistant-providers.ts`, `packages/storage/src/index.ts` (one export line) · Create: `packages/storage/src/repos/assistant-key-cooldowns.ts`, `packages/storage/src/repos/assistant-key-cooldowns.test.ts`, `packages/storage/src/repos/assistant-pools.test.ts` + generated `drizzle/` | S6-T1 |
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
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGeminiQuotaError } from './gemini-quota.js';

const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/gemini-429-quota.json', import.meta.url), 'utf8'),
) as unknown;

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

/** `37s`, `1.5s`: seconds plus fraction, capped to one hour. */
const safeRetryDelayMs = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const match = /^(\d+)(?:\.(\d{1,9}))?s$/.exec(raw);
  if (match === null) return undefined;
  const secondsText = match[1];
  if (secondsText === undefined) return undefined;
  const seconds = Number(secondsText);
  const nanos = Number((match[2] ?? '0').padEnd(9, '0'));
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(nanos)) return undefined;
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

### S6-T6: Migration, project keys, pool rows, cooldown store   ·   Wave 2
**Owns:** Modify: `packages/storage/src/schema.ts`, `packages/storage/src/repos/assistant-providers.ts` ·
Create: `packages/storage/src/repos/assistant-key-cooldowns.ts`,
`packages/storage/src/repos/assistant-key-cooldowns.test.ts`,
`packages/storage/src/repos/assistant-pools.test.ts` + generated `drizzle/` migration. The only task in this
slice that touches `schema.ts` or `drizzle/`.
**Reads (do not edit):** `packages/storage/src/repos/assistant-providers.ts:1-72` (imports, `StoredKey`,
`ChainRow`, `toKey`), `packages/storage/src/repos/model-calls.ts:55-106` (`writeInstance` + `onConflictDoUpdate`
idiom), `packages/storage/src/schema.ts:1947-1996` (key/chain tables)
**Interfaces:** Consumes: ADR 0143 (S6-T1) · Produces: `StoredKey.project: string | null`,
`StoredKey.fingerprint: string | null`, `fingerprintOf(secret: string): string`,
`bucketOf(key: { keyId, project }): string`, `ChainRow.pool: 'key' | 'provider'`,
`ChainRow.tier: 'standard' | 'light'`, `setModelChain` accepting `pool?`/`tier?` (defaults `key`/`standard`),
and `assistant-key-cooldowns.ts` exports `KeyCooldown`, `getCooldown(scope, keyId, model, now)`,
`setCooldown(scope, input)`, `clearCooldowns(scope, keyId, model?)`, `listCooldowns(scope)` (for S6-T10, S6-T11)

- [ ] **Step 1: Write the failing tests** — create
  `packages/storage/src/repos/assistant-pools.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addKey,
  bucketOf,
  fingerprintOf,
  getModelChain,
  listKeys,
  setModelChain,
} from './assistant-providers.js';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';

const NOW = 1_790_000_000_000;
let t: MigratedTestDatabase;
beforeEach(() => {
  t = openMigratedTestDatabase();
});
afterEach(() => t.close());

const seedKey = (over: Record<string, unknown> = {}) =>
  addKey(t.scopes.instance(), {
    provider: 'gemini',
    label: 'Gemini 1',
    apiKeyEnc: 'sealed-a',
    costClass: 'free',
    now: NOW,
    ...over,
  });

describe('key pools storage (ADR 0143)', () => {
  it('hashes the secret to a stable fingerprint without keeping the secret', () => {
    expect(fingerprintOf('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(fingerprintOf('AIza-test-one')).toHaveLength(64);
  });
  it('round-trips project and fingerprint, defaulting both to null', () => {
    const a = seedKey({ project: 'Car Team A', fingerprint: fingerprintOf('AIza-test-one') });
    const b = seedKey({ label: 'Gemini 2', apiKeyEnc: 'sealed-b' });
    expect(listKeys(t.scopes.instance()).find((k) => k.keyId === a)).toMatchObject({
      project: 'Car Team A',
      fingerprint: fingerprintOf('AIza-test-one'),
    });
    expect(listKeys(t.scopes.instance()).find((k) => k.keyId === b)).toMatchObject({
      project: null,
      fingerprint: null,
    });
  });
  it('refuses a duplicate fingerprint and a bad project label', () => {
    seedKey({ fingerprint: fingerprintOf('AIza-test-one') });
    expect(() =>
      seedKey({ label: 'Gemini 2', apiKeyEnc: 'sealed-b', fingerprint: fingerprintOf('AIza-test-one') }),
    ).toThrow('duplicate key fingerprint');
    expect(() => seedKey({ project: '' })).toThrow('project label');
    expect(() => seedKey({ project: 'x'.repeat(81) })).toThrow('project label');
  });
  it('defaults old chain rows to one-key standard and round-trips pool rows', () => {
    const a = seedKey();
    setModelChain(t.scopes.instance(), [{ keyId: a, model: 'gemini-3.8-flash' }], NOW);
    expect(getModelChain(t.scopes.instance())).toEqual([
      {
        position: 0,
        keyId: a,
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        rpmLimit: null,
        rpdLimit: null,
        pool: 'key',
        tier: 'standard',
      },
    ]);
    setModelChain(
      t.scopes.instance(),
      [{ keyId: a, model: 'gemini-3.8-flash', pool: 'provider', tier: 'light' }],
      NOW,
    );
    expect(getModelChain(t.scopes.instance())[0]).toMatchObject({ pool: 'provider', tier: 'light' });
  });
  it('buckets shared project labels together and blank labels apart', () => {
    expect(bucketOf({ keyId: 'key_a', project: 'Car Team A' })).toBe('project:Car Team A');
    expect(bucketOf({ keyId: 'key_a', project: null })).toBe('key:key_a');
    expect(bucketOf({ keyId: 'key_b', project: null })).toBe('key:key_b');
  });
});
```

and create `packages/storage/src/repos/assistant-key-cooldowns.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addKey, removeKey } from './assistant-providers.js';
import {
  clearCooldowns,
  getCooldown,
  listCooldowns,
  setCooldown,
} from './assistant-key-cooldowns.js';
import {
  openMigratedTestDatabase,
  type MigratedTestDatabase,
} from '@bananasaurs/storage/test-support';

const NOW = 1_790_000_000_000;
const MODEL = 'gemini-3.8-flash';
let t: MigratedTestDatabase;
beforeEach(() => {
  t = openMigratedTestDatabase();
});
afterEach(() => t.close());

describe('assistant key cooldowns (ADR 0143)', () => {
  it('round-trips a cooldown with its learned limits', () => {
    const scope = t.scopes.instance();
    const keyId = addKey(scope, {
      provider: 'gemini',
      label: 'Gemini 1',
      apiKeyEnc: 'sealed-a',
      costClass: 'free',
      now: NOW,
    });
    setCooldown(scope, {
      keyId,
      model: MODEL,
      until: NOW + 3_600_000,
      reason: 'daily-quota',
      setAt: NOW,
      learnedPerDay: 20,
    });
    expect(getCooldown(scope, keyId, MODEL, NOW)).toMatchObject({
      keyId,
      model: MODEL,
      until: NOW + 3_600_000,
      reason: 'daily-quota',
      learnedPerDay: 20,
    });
    expect(listCooldowns(scope)).toHaveLength(1);
  });
  it('expires when now reaches until and rewrites on a second set', () => {
    const scope = t.scopes.instance();
    const keyId = addKey(scope, {
      provider: 'gemini',
      label: 'Gemini 1',
      apiKeyEnc: 'sealed-a',
      costClass: 'free',
      now: NOW,
    });
    setCooldown(scope, { keyId, model: MODEL, until: NOW + 60_000, reason: 'minute-quota', setAt: NOW });
    expect(getCooldown(scope, keyId, MODEL, NOW + 60_000)).toBeUndefined();
    setCooldown(scope, { keyId, model: MODEL, until: NOW + 120_000, reason: 'minute-quota', setAt: NOW });
    expect(getCooldown(scope, keyId, MODEL, NOW + 61_000)?.until).toBe(NOW + 120_000);
  });
  it('clears by key or by key and model, and cascades on key deletion', () => {
    const scope = t.scopes.instance();
    const keyId = addKey(scope, {
      provider: 'gemini',
      label: 'Gemini 1',
      apiKeyEnc: 'sealed-a',
      costClass: 'free',
      now: NOW,
    });
    setCooldown(scope, { keyId, model: MODEL, until: NOW + 1_000, reason: 'minute-quota', setAt: NOW });
    setCooldown(scope, { keyId, model: 'gemini-3.6-flash', until: NOW + 1_000, reason: 'minute-quota', setAt: NOW });
    clearCooldowns(scope, keyId, MODEL);
    expect(getCooldown(scope, keyId, MODEL, NOW)).toBeUndefined();
    expect(getCooldown(scope, keyId, 'gemini-3.6-flash', NOW)).toBeDefined();
    clearCooldowns(scope, keyId);
    expect(listCooldowns(scope)).toEqual([]);
    setCooldown(scope, { keyId, model: MODEL, until: NOW + 1_000, reason: 'minute-quota', setAt: NOW });
    removeKey(scope, keyId);
    expect(listCooldowns(scope)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail** —
  `npx vitest run packages/storage/src/repos/assistant-pools.test.ts packages/storage/src/repos/assistant-key-cooldowns.test.ts --maxWorkers=1` ·
  Expected: FAIL (no `project`/`fingerprint`/`pool`/`tier` columns, no cooldown table or module)
- [ ] **Step 3: Implement** — the only task in this slice that touches `schema.ts` or `drizzle/`.
  1. In `schema.ts`, extend `assistantProviderKeys` (anchor: lines 1957–1970):

```ts
    enabled: integer('enabled').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** ADR 0143: opaque Google-project label; keys sharing it share one ledger bucket. Null is its own bucket. */
    project: text('project'),
    /** ADR 0143: SHA-256 hex of the secret for bulk-paste dedupe; never returned. Null for pre-pool rows. */
    fingerprint: text('fingerprint'),
  },
  (t) => [
    check(
      'assistant_provider_keys_provider',
      sql`${t.provider} IN ('gemini','openrouter','nvidia-nim')`,
    ),
    check('assistant_provider_keys_cost_class', sql`${t.costClass} IN ('free','paid','unknown')`),
    check('assistant_provider_keys_enabled_bool', boolCheck(t.enabled)),
    check('assistant_provider_keys_label_length', sql`length(${t.label}) BETWEEN 1 AND 60`),
    check(
      'assistant_provider_keys_project_length',
      sql`${t.project} IS NULL OR length(${t.project}) BETWEEN 1 AND 80`,
    ),
    unique('assistant_provider_keys_fingerprint').on(t.fingerprint),
  ],
);
```

  2. Extend `assistantModelChain` (anchor: lines 1985–1995):

```ts
    position: integer('position').primaryKey(),
    keyId: text('key_id').notNull(),
    model: text('model').notNull(),
    rpmLimit: integer('rpm_limit'),
    rpdLimit: integer('rpd_limit'),
    /** ADR 0143: 'key' is today's one-key entry; 'provider' covers every enabled key of the provider. */
    pool: text('pool').notNull().default('key'),
    /** ADR 0144: which runs try this entry first. */
    tier: text('tier').notNull().default('standard'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.keyId], foreignColumns: [assistantProviderKeys.keyId] }).onDelete(
      'cascade',
    ),
    unique('assistant_model_chain_key_model').on(t.keyId, t.model),
    check('assistant_model_chain_position', sql`${t.position} BETWEEN 0 AND 5`),
    check('assistant_model_chain_pool', sql`${t.pool} IN ('key','provider')`),
    check('assistant_model_chain_tier', sql`${t.tier} IN ('standard','light')`),
  ],
);
```

  3. Insert the new table between the end of `assistantModelChain` and the `// ADR 0080` comment:

```ts
// ADR 0143: durable per-key per-model cooldowns. Replaces the in-memory
// `QuotaLedger` on the request path and survives restarts. Instance-level
// like the keys it points at; removing a key drops its cooldowns.
export const assistantKeyCooldowns = sqliteTable(
  'assistant_key_cooldowns',
  {
    keyId: text('key_id').notNull(),
    model: text('model').notNull(),
    untilAt: integer('until_at').notNull(),
    reason: text('reason').notNull(),
    setAt: integer('set_at').notNull(),
    learnedPerDay: integer('learned_per_day'),
    learnedPerMinute: integer('learned_per_minute'),
  },
  (t) => [
    foreignKey({ columns: [t.keyId], foreignColumns: [assistantProviderKeys.keyId] }).onDelete(
      'cascade',
    ),
    unique('assistant_key_cooldowns_key_model').on(t.keyId, t.model),
    check('assistant_key_cooldowns_reason_length', sql`length(${t.reason}) BETWEEN 1 AND 60`),
    index('assistant_key_cooldowns_key').on(t.keyId, t.model, t.untilAt),
  ],
);
```

  4. In `assistant-providers.ts`: extend the `node:crypto` import to `import { createHash, randomBytes } from 'node:crypto';`;
     append:

```ts
/** ADR 0143: SHA-256 hex of a secret, for bulk-paste dedupe. The secret itself never reaches storage. */
export const fingerprintOf = (secret: string): string =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

/** ADR 0143: the ledger bucket a key draws from — shared per project label, private otherwise. */
export const bucketOf = (key: { readonly keyId: string; readonly project: string | null }): string =>
  key.project === null ? `key:${key.keyId}` : `project:${key.project}`;
```

     extend `StoredKey` with `readonly project: string | null;` and `readonly fingerprint: string | null;`,
     `ChainRow` with `readonly pool: 'key' | 'provider';` and `readonly tier: 'standard' | 'light';`, plus two
     small validators `asPool` / `asTier` beside `asProviderId`/`asCostClass`. Update `toKey`, the `listKeys`
     select, `addKey` (accept `project?`/`fingerprint?`, assert project length 1–80, pre-check fingerprint
     uniqueness and throw `new Error('duplicate key fingerprint')`), `updateKey` (accept `project?`, same
     assert, and clear the fingerprint when `apiKeyEnc` changes), `getModelChain` (select and return
     `pool`/`tier`), and `setModelChain` (accept `pool?`/`tier?` defaulting to `'key'`/`'standard'`, assert the
     values, write them).
  5. Create `packages/storage/src/repos/assistant-key-cooldowns.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { assistantKeyCooldowns } from '../schema.js';
import type { InstanceScope } from '../scope.js';
import { readInstance, writeInstance } from '../write.js';

export interface KeyCooldown {
  readonly keyId: string;
  readonly model: string;
  readonly until: number;
  readonly reason: string;
  readonly setAt: number;
  readonly learnedPerDay?: number;
  readonly learnedPerMinute?: number;
}

export interface SetCooldownInput {
  readonly keyId: string;
  readonly model: string;
  readonly until: number;
  readonly reason: string;
  readonly setAt: number;
  readonly learnedPerDay?: number;
  readonly learnedPerMinute?: number;
}

const toCooldown = (row: typeof assistantKeyCooldowns.$inferSelect): KeyCooldown => ({
  keyId: row.keyId,
  model: row.model,
  until: row.untilAt,
  reason: row.reason,
  setAt: row.setAt,
  ...(row.learnedPerDay === null ? {} : { learnedPerDay: row.learnedPerDay }),
  ...(row.learnedPerMinute === null ? {} : { learnedPerMinute: row.learnedPerMinute }),
});

/** An expired row reads as absent; a missing row is absent. */
export const getCooldown = (
  scope: InstanceScope,
  keyId: string,
  model: string,
  now: number,
): KeyCooldown | undefined =>
  readInstance(scope, (db) => {
    const row = db
      .select()
      .from(assistantKeyCooldowns)
      .where(
        and(eq(assistantKeyCooldowns.keyId, keyId), eq(assistantKeyCooldowns.model, model)),
      )
      .get();
    if (row === undefined || now >= row.untilAt) return undefined;
    return toCooldown(row);
  });

/** Upserts the row and prunes this key's expired rows in the same write. */
export const setCooldown = (scope: InstanceScope, input: SetCooldownInput): void =>
  writeInstance(scope, ({ db }) => {
    db.insert(assistantKeyCooldowns)
      .values({
        keyId: input.keyId,
        model: input.model,
        untilAt: input.until,
        reason: input.reason,
        setAt: input.setAt,
        learnedPerDay: input.learnedPerDay ?? null,
        learnedPerMinute: input.learnedPerMinute ?? null,
      })
      .onConflictDoUpdate({
        target: [assistantKeyCooldowns.keyId, assistantKeyCooldowns.model],
        set: {
          untilAt: input.until,
          reason: input.reason,
          setAt: input.setAt,
          learnedPerDay: input.learnedPerDay ?? null,
          learnedPerMinute: input.learnedPerMinute ?? null,
        },
      })
      .run();
  });

export const clearCooldowns = (scope: InstanceScope, keyId: string, model?: string): void =>
  writeInstance(scope, ({ db }) => {
    db.delete(assistantKeyCooldowns)
      .where(
        and(
          eq(assistantKeyCooldowns.keyId, keyId),
          ...(model === undefined ? [] : [eq(assistantKeyCooldowns.model, model)]),
        ),
      )
      .run();
  });

export const listCooldowns = (scope: InstanceScope): KeyCooldown[] =>
  readInstance(scope, (db) =>
    db.select().from(assistantKeyCooldowns).all().map(toCooldown),
  );
```

     (Instance-level repos use plain `and(...)` conditions — see `model-calls.ts:52-53` — never `scope.only`,
     which is the guild-scope idiom.)
  6. Run `npm run db:generate -- --name key_pools_routing`. Read the generated SQL and confirm it adds the four
     columns (existing rows default to `key`/`standard`, `project`/`fingerprint` null), creates
     `assistant_key_cooldowns` with its unique/index/FK, and rebuilds no unrelated table. Never hand-number or
     hand-edit the migration body — then append the per-cost-class Gemini terms seed (precedent
     `drizzle/0022_brainy_meteorite.sql:18`):

```sql
INSERT INTO `provider_eligibility` (`provider`, `trains_on_input`, `evidence_url`, `evidence_clause`, `production_use_allowed`, `reviewed_at`) VALUES ('gemini:free', 'yes', 'https://ai.google.dev/gemini-api/docs/billing', 'Gemini API Additional Terms (effective 2026-03-23): Unpaid Services content may be used to provide, improve and develop Google products and machine learning technologies (owner decision D12, 2026-10-10).', 1, <REVIEWED_AT>);
INSERT INTO `provider_eligibility` (`provider`, `trains_on_input`, `evidence_url`, `evidence_clause`, `production_use_allowed`, `reviewed_at`) VALUES ('gemini:paid', 'no', 'https://cloud.google.com/terms', 'Paid Services on a project with an active billing account: owner-recorded no-training; re-check the current paid terms before changing this (owner decision D12, 2026-10-10).', 1, <REVIEWED_AT>);
```

     where `<REVIEWED_AT>` is the literal from `node -e "console.log(Date.UTC(2026,9,11))"`. If drizzle-kit
     generated more than one file, keep only the `key_pools_routing` one.
- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS, including the duplicate-fingerprint
  refusal and the cascade test
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** —
  `npx prettier --write packages/storage/src/schema.ts packages/storage/src/repos/assistant-providers.ts packages/storage/src/repos/assistant-key-cooldowns.ts packages/storage/src/repos/assistant-pools.test.ts packages/storage/src/repos/assistant-key-cooldowns.test.ts drizzle/`
  then `npx eslint` on the same owned `.ts` paths · exit 0
- [ ] **Step 7: Commit** —
  `git add packages/storage/src/schema.ts packages/storage/src/repos/assistant-providers.ts packages/storage/src/repos/assistant-key-cooldowns.ts packages/storage/src/repos/assistant-pools.test.ts packages/storage/src/repos/assistant-key-cooldowns.test.ts drizzle/ && git commit -m "Slice 6 T6: key pools migration and cooldown store"`

**Done when:** the generated SQL holds the columns, defaults, table and seeds; old rows read back as one-key
standard; cooldowns round-trip, expire, clear and cascade.

---

### S6-T7: Shared error fields and adapter quota mapping   ·   Wave 2
**Owns:** Modify: `packages/core/src/providers/errors.ts`, `packages/core/src/providers/gemini.ts`,
`packages/core/src/providers/openai-compatible.ts`, `packages/core/src/index.ts` (one export line),
`packages/core/src/providers/gemini.test.ts` (append cases before the outbound-scan test) · Create:
`packages/core/src/providers/quota-fields.test.ts`
**Reads (do not edit):** `packages/core/src/providers/openai-compatible.test.ts:300-340` (provider construction
with fake `fetch` — mirror it), `packages/core/src/providers/openai-compatible.ts:180-193` (`resolveResetAt`
anchor), `packages/core/src/providers/gemini.test.ts:62-88` (the `it.each` normalisation block and the
outbound-scan anchor)
**Interfaces:** Consumes: `parseGeminiQuotaError` (S6-T5) · Produces: widened `ProviderError` with
`quotaScope?: 'daily-free' | 'day' | 'minute'`, `retryAfterMs?: number`,
`learnedLimit?: { readonly perDay?: number; readonly perMinute?: number }` (contracts §3, Slice 3 keeps every
field); Gemini 429 → typed quota error; OpenRouter plain-429 `Retry-After` → `retryAfterMs`; 401/403 stay
authentication with fixed messages

- [ ] **Step 1: Write the failing tests** — append to `packages/core/src/providers/gemini.test.ts`, inserted
  before the `it('runs the local outbound scan before fetch', ...)` test (line 78):

```ts
it('maps a documented daily 429 to quota scope day with learned limits', async () => {
  const body = JSON.parse(
    readFileSync(new URL('./__fixtures__/gemini-429-quota.json', import.meta.url), 'utf8'),
  ) as unknown;
  const provider = new GeminiProvider({
    apiKey: 'AIza-test-one',
    fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 429 })),
  });
  const error = await provider
    .generateText({ model: 'gemini-3.8-flash', messages: [{ role: 'user', text: 'hi' }] })
    .catch((value: unknown) => value);
  expect(error).toBeInstanceOf(ProviderError);
  expect(error).toMatchObject({
    kind: 'quota',
    retryable: false,
    status: 429,
    quotaScope: 'day',
    retryAfterMs: 37_000,
    learnedLimit: { perDay: 20, perMinute: 5 },
  });
  expect((error as Error).message).not.toContain('AIza-test-one');
});

it('maps a minute-only 429 to minute scope and a bare 429 to plain rate-limit', async () => {
  const minute = {
    error: {
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '5' }],
        },
      ],
    },
  };
  const minuteProvider = new GeminiProvider({
    apiKey: 'AIza-test-one',
    fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(minute), { status: 429 })),
  });
  const minuteError = await minuteProvider
    .generateText({ model: 'gemini-3.8-flash', messages: [{ role: 'user', text: 'hi' }] })
    .catch((value: unknown) => value);
  expect(minuteError).toMatchObject({ kind: 'quota', quotaScope: 'minute', learnedLimit: { perMinute: 5 } });

  const bareProvider = new GeminiProvider({
    apiKey: 'AIza-test-one',
    fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', { status: 429 })),
  });
  const bareError = await bareProvider
    .generateText({ model: 'gemini-3.8-flash', messages: [{ role: 'user', text: 'hi' }] })
    .catch((value: unknown) => value);
  expect(bareError).toMatchObject({ kind: 'rate-limit', retryable: true });
  expect((bareError as ProviderError).quotaScope).toBeUndefined();
});

it.each([[401], [403]] as const)('keeps HTTP %s authentication with no key text', async (status) => {
  const provider = new GeminiProvider({
    apiKey: 'AIza-test-one',
    fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', { status })),
  });
  const error = await provider
    .generateText({ model: 'gemini-3.8-flash', messages: [{ role: 'user', text: 'hi' }] })
    .catch((value: unknown) => value);
  expect(error).toMatchObject({ kind: 'authentication', retryable: false });
  expect((error as Error).message).not.toContain('AIza-test-one');
});
```

  (Add `import { readFileSync } from 'node:fs';` to the test file's imports.) And create
  `packages/core/src/providers/quota-fields.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterProvider } from './openai-compatible.js';
import { ProviderError } from './errors.js';

describe('ProviderError quota fields (contracts §3)', () => {
  it('carries the widened scope, retry delay and learned limit', () => {
    const error = new ProviderError('quota', 'Gemini request failed with HTTP 429', false, {
      status: 429,
      quotaScope: 'day',
      retryAfterMs: 37_000,
      learnedLimit: { perDay: 20 },
    });
    expect(error.quotaScope).toBe('day');
    expect(error.retryAfterMs).toBe(37_000);
    expect(error.learnedLimit).toEqual({ perDay: 20 });
    const legacy = new ProviderError('quota', 'x', false, { quotaScope: 'daily-free', resetAt: 123 });
    expect(legacy.quotaScope).toBe('daily-free');
    expect(legacy.resetAt).toBe(123);
  });
  it('reads Retry-After on a plain OpenRouter 429', async () => {
    const provider = createOpenRouterProvider({
      apiKey: 'sk-test-key',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'busy', type: 'rate_limit_exceeded' } }), {
          status: 429,
          headers: { 'retry-after': '45' },
        }),
      ),
    });
    const error = await provider
      .generateText({ model: 'some-model', messages: [{ role: 'user', text: 'hi' }] })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryAfterMs).toBe(45_000);
  });
});
```

  (Mirror the exact `createOpenRouterProvider` options and `generateText` request shape from
  `openai-compatible.test.ts:300-340`; keep the model id fake and the key fake.)

- [ ] **Step 2: Run it and watch it fail** —
  `npx vitest run packages/core/src/providers/gemini.test.ts packages/core/src/providers/quota-fields.test.ts --maxWorkers=1` ·
  Expected: FAIL (`quotaScope` still only `'daily-free'`, Gemini discards 429 bodies, no `retryAfterMs`)
- [ ] **Step 3: Implement** —
  1. In `errors.ts`, widen additively (keep `resetAt` and `'daily-free'` for the OpenRouter path):

```ts
  /**
   * Set when `kind` is `'quota'` and the cap is a `:free` model's daily
   * request allowance rather than an account credit exhaustion (ADR 0077).
   * A retry never helps this kind of quota error before `resetAt`.
   * Slice 6 (ADR 0143) adds Gemini scopes: `'day'` cools until the next
   * Pacific midnight, `'minute'` cools for `retryAfterMs` or 60 s.
   */
  public readonly quotaScope?: 'daily-free' | 'day' | 'minute';
  /** From Retry-After or google.rpc.RetryInfo.retryDelay. */
  public readonly retryAfterMs?: number;
  /** quotaValue from a Gemini QuotaFailure violation. */
  public readonly learnedLimit?: { readonly perDay?: number; readonly perMinute?: number };
```

  and the matching three optional constructor options plus their three assignment lines, following the existing
  `resetAt`/`quotaScope` pattern exactly.
  2. In `gemini.ts`, import `parseGeminiQuotaError` from `./gemini-quota.js` and replace the non-OK block
     (lines 189–197) with:

```ts
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError('authentication', 'Gemini request failed with HTTP 401', false, {
          status: response.status,
          host: this.host,
        });
      }
      if (response.status === 429) {
        let body: unknown;
        try {
          const text = await response.text();
          body = JSON.parse(text.slice(0, 16_384)) as unknown;
        } catch {
          body = undefined;
        }
        const quota = parseGeminiQuotaError(body);
        if (quota.scope !== undefined) {
          return Promise.reject(
            new ProviderError('quota', 'Gemini request failed with HTTP 429', quota.scope !== 'day', {
              status: 429,
              host: this.host,
              quotaScope: quota.scope,
              ...(quota.retryAfterMs === undefined ? {} : { retryAfterMs: quota.retryAfterMs }),
              ...(quota.learnedLimit === undefined ? {} : { learnedLimit: quota.learnedLimit }),
            }),
          );
        }
        throw new ProviderError('rate-limit', 'Gemini request failed with HTTP 429', true, {
          status: 429,
          host: this.host,
        });
      }
      const kind = statusKind(response.status);
      throw new ProviderError(
        kind,
        `Gemini request failed with HTTP ${response.status}`,
        kind === 'rate-limit' || kind === 'outage',
        { status: response.status, host: this.host },
      );
    }
```

     (Keep every existing fixed message; the body is parsed bounded and never logged or kept. Note the 401/403
     messages stay fixed strings with no body or key text.)
  3. In `openai-compatible.ts`, insert before `const resolveResetAt = (` (line 185):

```ts
/** HTTP `Retry-After` (delay seconds or HTTP date) in ms, capped to one hour. */
const parseRetryAfterMs = (raw: string | null): number | undefined => {
  if (raw === null || raw.trim() === '') return undefined;
  if (/^\d+$/.test(raw.trim())) return Math.min(Number(raw.trim()) * 1000, 3_600_000);
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(date - Date.now(), 0), 3_600_000);
};
```

     and in the 429 error construction (the options object holding
     `...(resetAt === undefined ? {} : { resetAt }),` at line ~374), compute
     `const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));` beside the existing
     `resolveResetAt` call and add `...(retryAfterMs === undefined ? {} : { retryAfterMs }),` after the
     `resetAt` spread. Do not change the `:free` daily classification.
  4. Append `export * from './providers/gemini-quota.js';` to `packages/core/src/index.ts` in its existing style.
- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS; then
  `npx vitest run packages/core/src/providers/openai-compatible.test.ts packages/core/src/providers/failure.test.ts --maxWorkers=1` ·
  PASS (no existing 429 behaviour changed)
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** —
  `npx prettier --write packages/core/src/providers/errors.ts packages/core/src/providers/gemini.ts packages/core/src/providers/openai-compatible.ts packages/core/src/index.ts packages/core/src/providers/gemini.test.ts packages/core/src/providers/quota-fields.test.ts`
  then `npx eslint` on the same owned `.ts` paths · exit 0
- [ ] **Step 7: Commit** —
  `git add packages/core/src/providers/errors.ts packages/core/src/providers/gemini.ts packages/core/src/providers/openai-compatible.ts packages/core/src/index.ts packages/core/src/providers/gemini.test.ts packages/core/src/providers/quota-fields.test.ts && git commit -m "Slice 6 T7: quota error fields and adapter mapping"`

**Done when:** daily/minute/bare Gemini 429s map to typed fields; `Retry-After` survives on plain OpenRouter
429s; `:free` daily classification and all existing 429 tests still pass; no error text carries a key.

---

### S6-T8: Daemon capability mapping per provider   ·   Wave 2
**Owns:** Create: `apps/daemon/src/assistant/model-capabilities.ts`,
`apps/daemon/src/assistant/model-capabilities.test.ts`
**Reads (do not edit):** `apps/daemon/src/assistant/openrouter-models.ts:11-23` (`ModelListing`, catalogue
interface), `packages/core/src/providers/model-capabilities.ts` (S6-T3 output)
**Interfaces:** Consumes: `geminiCapabilities`, `TEXT_AND_TOOLS_ONLY`, `ModelCapabilities` (S6-T3) · Produces:
`capabilitiesForEntry(entry: { readonly providerId: ProviderId; readonly model: string }, catalogue:
OpenRouterModelCatalogue): ModelCapabilities` with the exact contracts §3 signature (for S6-T10)

- [ ] **Step 1: Write the failing test** — create
  `apps/daemon/src/assistant/model-capabilities.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TEXT_AND_TOOLS_ONLY } from '@bananasaurs/core';
import { capabilitiesForEntry } from './model-capabilities.js';
import type { OpenRouterModelCatalogue } from './openrouter-models.js';

const catalogueWith = (listing: Record<string, unknown>): OpenRouterModelCatalogue => ({
  peek: (model: string) =>
    (listing[model] as ReturnType<OpenRouterModelCatalogue['peek']>) ?? {
      listed: false,
      image: false,
      file: false,
      tools: false,
      reasoning: false,
    },
  refresh: async () => {},
});

describe('capabilitiesForEntry (ADR 0143, spec 1g)', () => {
  it('maps Gemini through the shared table', () => {
    expect(
      capabilitiesForEntry(
        { providerId: 'gemini', model: 'gemini-3.8-flash' },
        catalogueWith({}),
      ),
    ).toEqual({ tools: true, image: true, pdf: true, reasoning: true, thinking: 'levels' });
    expect(
      capabilitiesForEntry({ providerId: 'gemini', model: 'gemini-9.9-ultra' }, catalogueWith({})),
    ).toBe(TEXT_AND_TOOLS_ONLY);
  });
  it('maps OpenRouter image, file-to-pdf, tools and reasoning flags', () => {
    const catalogue = catalogueWith({
      'some/vision-model': { listed: true, image: true, file: true, tools: true, reasoning: true },
      'some/text-model': { listed: false, image: false, file: false, tools: false, reasoning: false },
    });
    expect(
      capabilitiesForEntry({ providerId: 'openrouter', model: 'some/vision-model' }, catalogue),
    ).toEqual({ tools: true, image: true, pdf: true, reasoning: true, thinking: 'budget' });
    expect(
      capabilitiesForEntry({ providerId: 'openrouter', model: 'some/text-model' }, catalogue),
    ).toBe(TEXT_AND_TOOLS_ONLY);
  });
  it('treats NIM as text plus tools only', () => {
    expect(
      capabilitiesForEntry({ providerId: 'nvidia-nim', model: 'any-model' }, catalogueWith({})),
    ).toBe(TEXT_AND_TOOLS_ONLY);
  });
});
```

- [ ] **Step 2: Run it and watch it fail** —
  `npx vitest run apps/daemon/src/assistant/model-capabilities.test.ts --maxWorkers=1` · Expected: FAIL with
  `Failed to resolve import "./model-capabilities.js"`
- [ ] **Step 3: Implement** — create `apps/daemon/src/assistant/model-capabilities.ts`:

```ts
import {
  geminiCapabilities,
  TEXT_AND_TOOLS_ONLY,
  type ModelCapabilities,
} from '@bananasaurs/core';
import type { ProviderId } from './model-chain.js';
import type { OpenRouterModelCatalogue } from './openrouter-models.js';

/**
 * Per-entry capabilities (spec 1g Gemini half, ADR 0143): gemini reads the
 * shared table, openrouter reads the catalogued listing (`file` means PDF),
 * nvidia-nim is text plus tools only. Unlisted models are text plus tools only.
 */
export function capabilitiesForEntry(
  entry: { readonly providerId: ProviderId; readonly model: string },
  catalogue: OpenRouterModelCatalogue,
): ModelCapabilities {
  if (entry.providerId === 'gemini') return geminiCapabilities(entry.model);
  if (entry.providerId === 'nvidia-nim') return TEXT_AND_TOOLS_ONLY;
  const listing = catalogue.peek(entry.model);
  if (listing === undefined || !listing.listed) return TEXT_AND_TOOLS_ONLY;
  return {
    tools: listing.tools,
    image: listing.image,
    pdf: listing.file,
    reasoning: listing.reasoning,
    thinking: listing.reasoning ? 'budget' : 'none',
  };
}
```

- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** —
  `npx prettier --write apps/daemon/src/assistant/model-capabilities.ts apps/daemon/src/assistant/model-capabilities.test.ts`
  then `npx eslint apps/daemon/src/assistant/model-capabilities.ts apps/daemon/src/assistant/model-capabilities.test.ts` · exit 0
- [ ] **Step 7: Commit** —
  `git add apps/daemon/src/assistant/model-capabilities.ts apps/daemon/src/assistant/model-capabilities.test.ts && git commit -m "Slice 6 T8: daemon capability mapping per provider"`

**Done when:** Gemini/OpenRouter/NIM entries map to the specified capabilities; unlisted models fall back to
text plus tools only.

---

### S6-T9: Router and tier instance settings   ·   Wave 2
**Owns:** Modify: `packages/core/src/settings/instance-settings.ts`,
`packages/core/src/settings/instance-settings.test.ts`
**Reads (do not edit):** `packages/core/src/settings/instance-settings.ts:118-127` (definition style) and
`257-297` (registry list + `InstanceSettingValues`)
**Interfaces:** Consumes: `DEFAULT_ROUTER_RULES` values (S6-T4, defaults only) · Produces: keys
`assistant.routerEnabled`, `assistant.routerMaxChars`, `assistant.routerFullModelKeywords`,
`assistant.routerGreetingPatterns`, `assistant.routerLongThreadTurns`, `assistant.routerEscalateOnTool`,
`assistant.routerSummaryTier`, `assistant.routerDailyDigestTier` (for S6-T13, S6-T16)

- [ ] **Step 1: Write the failing test** — append to `instance-settings.test.ts`:

```ts
it('registers the eight router and tier settings with spec defaults (ADR 0144, spec §4.7)', () => {
  expect(INSTANCE_SETTINGS.length).toBeGreaterThanOrEqual(26);
  const valueOf = (key: string): unknown => settingDefinition(key)?.defaultValue;
  expect(valueOf('assistant.routerEnabled')).toBe(1);
  expect(valueOf('assistant.routerMaxChars')).toBe(80);
  expect(valueOf('assistant.routerFullModelKeywords')).toEqual(DEFAULT_ROUTER_KEYWORDS);
  expect(valueOf('assistant.routerGreetingPatterns')).toEqual(DEFAULT_ROUTER_GREETINGS);
  expect(valueOf('assistant.routerLongThreadTurns')).toBe(4);
  expect(valueOf('assistant.routerEscalateOnTool')).toBe(1);
  expect(valueOf('assistant.routerSummaryTier')).toBe('light');
  expect(valueOf('assistant.routerDailyDigestTier')).toBe('light');
  expect(settingDefinition('assistant.routerEnabled')?.group).toBe('Assistant context');
  expect(settingDefinition('assistant.routerMaxChars')?.schema.safeParse(81).success).toBe(true);
  expect(settingDefinition('assistant.routerMaxChars')?.schema.safeParse(9).success).toBe(false);
  const keywords = settingDefinition('assistant.routerFullModelKeywords');
  expect(keywords?.schema.safeParse(['remind']).success).toBe(true);
  expect(keywords?.schema.safeParse([]).success).toBe(false);
  const tier = settingDefinition('assistant.routerSummaryTier');
  expect(tier?.schema.safeParse('light').success).toBe(true);
  expect(tier?.schema.safeParse('standard').success).toBe(true);
  expect(tier?.schema.safeParse('heavy').success).toBe(false);
  expect(isInstanceSettingKey('assistant.routerDailyDigestTier')).toBe(true);
});
```

  (Import `DEFAULT_ROUTER_KEYWORDS` and `DEFAULT_ROUTER_GREETINGS` from the new module below. The
  `toBeGreaterThanOrEqual(26)` form — not an exact length — keeps this green when Slice 2's parallel settings
  land; do not change other slices' assertions.)

- [ ] **Step 2: Run it and watch it fail** —
  `npx vitest run packages/core/src/settings/instance-settings.test.ts --maxWorkers=1` · Expected: FAIL
  (unknown setting keys)
- [ ] **Step 3: Implement** — in `instance-settings.ts`, after the `channelContextMessages` definition (lines
  118–127), insert:

```ts
/** ADR 0144 defaults, mirroring DEFAULT_ROUTER_RULES so registry and router agree. */
const DEFAULT_ROUTER_KEYWORDS: readonly string[] = [
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
];

const DEFAULT_ROUTER_GREETINGS: readonly string[] = [
  'hi',
  'hello',
  'hey',
  'thanks',
  'thank you',
  'thx',
  'good morning',
  'good night',
];

const routerEnabled: SettingDefinition<number> = {
  key: 'assistant.routerEnabled',
  group: 'Assistant context',
  label: 'Complexity routing on/off',
  help: 'When on, short simple messages try the light tier first so greetings never spend the standard daily quota. 1 is on, 0 is off.',
  display: 'count',
  schema: z.number().int().min(0).max(1),
  defaultValue: 1,
  bounds: { min: 0, max: 1 },
};

const routerMaxChars: SettingDefinition<number> = {
  key: 'assistant.routerMaxChars',
  group: 'Assistant context',
  label: 'Router: longest light message',
  help: 'A message longer than this many characters always uses the standard tier.',
  display: 'count',
  schema: z.number().int().min(10).max(1000),
  defaultValue: 80,
  bounds: { min: 10, max: 1000 },
};

const routerFullModelKeywords: SettingDefinition<string[]> = {
  key: 'assistant.routerFullModelKeywords',
  group: 'Assistant context',
  label: 'Router: full-model keywords',
  help: 'A message containing one of these always uses the standard tier. Shown as an editable chip list.',
  display: 'text',
  schema: z.array(z.string().min(1).max(40)).min(1).max(40),
  defaultValue: [...DEFAULT_ROUTER_KEYWORDS],
  bounds: { maxItems: 40 },
};

const routerGreetingPatterns: SettingDefinition<string[]> = {
  key: 'assistant.routerGreetingPatterns',
  group: 'Assistant context',
  label: 'Router: greeting patterns',
  help: 'Messages matching one of these stay on the light tier even in long conversations. Shown as an editable chip list.',
  display: 'text',
  schema: z.array(z.string().min(1).max(40)).min(1).max(40),
  defaultValue: [...DEFAULT_ROUTER_GREETINGS],
  bounds: { maxItems: 40 },
};

const routerLongThreadTurns: SettingDefinition<number> = {
  key: 'assistant.routerLongThreadTurns',
  group: 'Assistant context',
  label: 'Router: long-thread turns',
  help: 'Past this many earlier turns a plain follow-up uses the standard tier; greetings stay light.',
  display: 'count',
  schema: z.number().int().min(0).max(50),
  defaultValue: 4,
  bounds: { min: 0, max: 50 },
};

const routerEscalateOnTool: SettingDefinition<number> = {
  key: 'assistant.routerEscalateOnTool',
  group: 'Assistant context',
  label: 'Router: escalate on tool use',
  help: 'When on, a light run that calls a tool switches to the standard tier for its next round. 1 is on, 0 is off.',
  display: 'count',
  schema: z.number().int().min(0).max(1),
  defaultValue: 1,
  bounds: { min: 0, max: 1 },
};

const routerSummaryTier: SettingDefinition<'light' | 'standard'> = {
  key: 'assistant.routerSummaryTier',
  group: 'Assistant context',
  label: 'Tier for conversation summaries',
  help: 'Rolling summaries run on this tier so they never spend the standard daily quota unless you ask.',
  display: 'text',
  schema: z.enum(['light', 'standard']),
  defaultValue: 'light',
};

const routerDailyDigestTier: SettingDefinition<'light' | 'standard'> = {
  key: 'assistant.routerDailyDigestTier',
  group: 'Assistant context',
  label: 'Tier for the daily digest',
  help: 'The daily digest runs on this tier, after the midnight quota reset. Slice 5 consumes this key.',
  display: 'text',
  schema: z.enum(['light', 'standard']),
  defaultValue: 'light',
};
```

  Append the eight names to the `INSTANCE_SETTINGS` list (lines 257–276, after `channelContextMessages,`) and
  the eight value lines to `InstanceSettingValues` (after line 285
  `readonly 'assistant.channelContextMessages': number;`):

```ts
  readonly 'assistant.routerEnabled': number;
  readonly 'assistant.routerMaxChars': number;
  readonly 'assistant.routerFullModelKeywords': string[];
  readonly 'assistant.routerGreetingPatterns': string[];
  readonly 'assistant.routerLongThreadTurns': number;
  readonly 'assistant.routerEscalateOnTool': number;
  readonly 'assistant.routerSummaryTier': 'light' | 'standard';
  readonly 'assistant.routerDailyDigestTier': 'light' | 'standard';
```

  Export the two default arrays (`export const DEFAULT_ROUTER_KEYWORDS...`) so the test and S6-T13 share them.

- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** —
  `npx prettier --write packages/core/src/settings/instance-settings.ts packages/core/src/settings/instance-settings.test.ts`
  then `npx eslint packages/core/src/settings/instance-settings.ts packages/core/src/settings/instance-settings.test.ts` · exit 0
- [ ] **Step 7: Commit** —
  `git add packages/core/src/settings/instance-settings.ts packages/core/src/settings/instance-settings.test.ts && git commit -m "Slice 6 T9: router and tier instance settings"`

**Done when:** all eight keys resolve with spec defaults and bounds; the count assertion tolerates Slice 2's
parallel settings; every new setting has label, help, default and reset semantics through the registry.

---

### S6-T10: Pool resolution and key selection   ·   Wave 3
**Owns:** Modify: `apps/daemon/src/assistant/model-chain.ts`,
`apps/daemon/src/assistant/provider-config.ts`, `apps/daemon/src/assistant/model-chain.test.ts`,
`apps/daemon/src/assistant/provider-config.test.ts`
**Reads (do not edit):** `packages/storage/src/repos/assistant-providers.ts` (S6-T6 output: `bucketOf`,
`StoredKey.project`, `ChainRow.pool/tier`), `apps/daemon/src/assistant/model-capabilities.ts` (S6-T8 output:
`capabilitiesForEntry`)
**Interfaces:** Consumes: `bucketOf`, `getCooldown`/`setCooldown` signatures (S6-T6), `ProviderError`
`quotaScope`/`retryAfterMs`/`learnedLimit` (S6-T7), `capabilitiesForEntry` (S6-T8) · Produces:
`nextProviderDayStart` re-used from `@bananasaurs/core` (not produced here),
`selectPoolKey(candidates: readonly PoolCandidate[]): PoolCandidate | undefined`,
`ChainEntry.pool: 'key' | 'provider'`, `ChainEntry.tier: 'standard' | 'light'`,
`ChainEntry.selectedKeyId: string` (for S6-T11, S6-T13, S6-T14)

- [ ] **Step 1: Write the failing test** — append to `apps/daemon/src/assistant/model-chain.test.ts`:

```ts
describe('pool resolution (ADR 0143)', () => {
  it("pool 'key' behaves exactly as today: one entry, its own key", () => {
    const chain = resolveModelChain(testDeps([{ keyId: 'key_a', model: 'gemini-3.8-flash' }]));
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ pool: 'key', tier: 'standard', selectedKeyId: 'key_a' });
  });
  it("pool 'provider' picks the usable key with the most remaining daily requests", () => {
    const chain = resolveModelChain(
      testDeps([{ keyId: 'key_anchor', model: 'gemini-3.8-flash', pool: 'provider' }], {
        keys: [
          { keyId: 'key_anchor', provider: 'gemini', spentToday: 19, rpdLimit: 20 },
          { keyId: 'key_b', provider: 'gemini', spentToday: 2, rpdLimit: 20 },
        ],
        cooldowns: [{ keyId: 'key_b', model: 'gemini-3.8-flash', until: NOW + 3_600_000 }],
      }),
    );
    // key_b cools, so the spent-most anchor still wins over a cooling key.
    expect(chain[0]).toMatchObject({ pool: 'provider', selectedKeyId: 'key_anchor' });
  });
  it('skips cooling and invalid keys, ties break by least-recent use then key id', () => {
    expect(
      selectPoolKey([
        { keyId: 'key_b', remainingDay: 5, lastUsed: 100 },
        { keyId: 'key_a', remainingDay: 5, lastUsed: 100 },
        { keyId: 'key_c', remainingDay: 5, lastUsed: 50 },
      ]),
    ).toMatchObject({ keyId: 'key_c' });
    expect(
      selectPoolKey([
        { keyId: 'key_b', remainingDay: 5, lastUsed: 100 },
        { keyId: 'key_a', remainingDay: 5, lastUsed: 100 },
      ]),
    ).toMatchObject({ keyId: 'key_a' });
    expect(selectPoolKey([])).toBeUndefined();
  });
  it('keys sharing a project label share one daily bucket', () => {
    expect(bucketOf({ keyId: 'key_a', project: 'Car Team A' })).toBe('project:Car Team A');
    expect(bucketOf({ keyId: 'key_b', project: 'Car Team A' })).toBe('project:Car Team A');
    expect(bucketOf({ keyId: 'key_c', project: null })).toBe('key:key_c');
  });
});
```

  (`testDeps` is the existing helper in `model-chain.test.ts` that builds `{ instance, config, openKey,
  eligibility, makeProvider }`; extend it with optional `{ keys, cooldowns }` lists using the existing
  `assistantProvidersRepo` stub style. `NOW` is the file's existing fixed clock. Import `selectPoolKey` and
  `bucketOf` at the top. **Controller correction:** do not write a Pacific-midnight function — the daily reset is
  `nextProviderDayStart` from `@bananasaurs/core` (`packages/core/src/providers/provider-day.ts`, already tested,
  handles daylight saving). Import it from there wherever this slice needs it.)

- [ ] **Step 2: Run it and watch it fail** —
  `npx vitest run apps/daemon/src/assistant/model-chain.test.ts --maxWorkers=1` · Expected: FAIL with
  `Failed to resolve import` or `selectPoolKey is not a function`
- [ ] **Step 3: Implement** —
  1. In `model-chain.ts`, extend `ChainEntry` (anchor: lines 39–52) with three fields after `rpdLimit`:

```ts
  readonly rpmLimit: number | null;
  readonly rpdLimit: number | null;
  /** ADR 0143: 'key' runs this entry's own key; 'provider' runs the selected pool key. */
  readonly pool: 'key' | 'provider';
  /** ADR 0144: which runs try this entry first. */
  readonly tier: 'standard' | 'light';
  /** ADR 0143: the key actually constructed for this entry (== keyId when pool is 'key'). */
  readonly selectedKeyId: string;
```

  Every `return {` in `toEntry` and the two early-skip returns must set
  `pool: 'key', tier: 'standard', selectedKeyId: candidate.keyId` to keep old rows compiling; the stored-chain
  path below overwrites them from the row.
  2. Above `resolveModelChain`, add:

```ts
export interface PoolCandidate {
  readonly keyId: string;
  /** Requests left today (rpdLimit minus ledger today, or learned limit minus today). */
  readonly remainingDay: number;
  /** Last use epoch ms, 0 when never used. */
  readonly lastUsed: number;
}

/** Deterministic pool pick: most remaining daily, then least-recent use, then key id. */
export function selectPoolKey(candidates: readonly PoolCandidate[]): PoolCandidate | undefined {
  return [...candidates].sort(
    (a, b) => b.remainingDay - a.remainingDay || a.lastUsed - b.lastUsed || (a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0),
  )[0];
}

// The daily reset comes from core: `import { nextProviderDayStart } from '@bananasaurs/core';`
// (packages/core/src/providers/provider-day.ts). Never re-implement it here.
```

  3. In `storedCandidates`, carry `pool`/`tier` from the row
  (`pool: row.pool ?? 'key', tier: row.tier ?? 'standard'`) through `Candidate`, and in `toEntry` expand a
  `pool: 'provider'` row: gather every enabled, readable key of the row's provider, drop keys with an
  unexpired `getCooldown(instance, keyId, row.model, Date.now())`, compute `remainingDay` from
  `rpdLimit`/learned limit minus ledger today (missing limit means Infinity), pick via `selectPoolKey`,
  and build the provider from the selected key. When no pool key is usable, return the entry with
  `provider: undefined, skip: 'disabled'` so the loop records `model-skipped` and falls through (S6-T11).
  A pool never opens or logs a secret outside `providerFor`. The chain stays at most six entries (the HTTP
  route enforces it; `resolveModelChain` truncates defensively with `.slice(0, 6)`).
  4. In `provider-config.ts`, thread `pool`/`tier` through `saveChain` (accept `pool?`/`tier?`, default
  `'key'`/`'standard`, assert values) and `chain()` (return the resolved entries unchanged). No other
  behaviour changes.

- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS; then
  `npx vitest run apps/daemon/src/assistant/provider-config.test.ts --maxWorkers=1` · PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** —
  `npx prettier --write apps/daemon/src/assistant/model-chain.ts apps/daemon/src/assistant/provider-config.ts apps/daemon/src/assistant/model-chain.test.ts apps/daemon/src/assistant/provider-config.test.ts`
  then `npx eslint` on the same four paths · exit 0
- [ ] **Step 7: Commit** —
  `git add apps/daemon/src/assistant/model-chain.ts apps/daemon/src/assistant/provider-config.ts apps/daemon/src/assistant/model-chain.test.ts apps/daemon/src/assistant/provider-config.test.ts && git commit -m "Slice 6 T10: pool resolution and key selection"`

**Done when:** one-key pools behave as today; provider pools select deterministically and skip cooling keys;
shared project labels share a bucket; Pacific-midnight reset is pinned; chain stays ≤ 6.

---

### S6-T11: Loop cooldowns, restart-safe skip and routed event   ·   Wave 3
**Owns:** Modify: `apps/daemon/src/assistant/tool-loop.ts`, `apps/daemon/src/assistant/tool-loop.test.ts`,
`packages/core/src/assistant/run-events.ts`, `packages/core/src/assistant/run-events.test.ts`
**Reads (do not edit):** `apps/daemon/src/assistant/quota-ledger.ts` (constructor kept; loop no longer consults
it), `packages/storage/src/repos/assistant-key-cooldowns.ts` (S6-T6 output)
**Interfaces:** Consumes: `ChainEntry.pool/selectedKeyId` (S6-T10) + `nextProviderDayStart` from `@bananasaurs/core`, `ProviderError`
quota fields (S6-T7), `getCooldown`/`setCooldown` (S6-T6) · Produces: `routed` run event
`{ kind: 'routed', tier: 'standard' | 'light', reason: string }` (for S6-T13); loop records `model-skipped`
with cooldown reasons and persists `day`/`minute`/`invalid` cooldowns (for S6-T13, S6-T15)

- [ ] **Step 1: Write the failing tests** — append to `packages/core/src/assistant/run-events.test.ts`:

```ts
it('accepts the routed event with tier and fixed reason vocabulary', () => {
  expect(
    runEventSchema.safeParse({ kind: 'routed', tier: 'light', reason: 'greeting' }).success,
  ).toBe(true);
  expect(
    runEventSchema.safeParse({ kind: 'routed', tier: 'standard', reason: 'long-message' }).success,
  ).toBe(true);
  expect(runEventSchema.safeParse({ kind: 'routed', tier: 'heavy', reason: 'greeting' }).success).toBe(
    false,
  );
});
```

  and append to `apps/daemon/src/assistant/tool-loop.test.ts` (mirror the existing `runToolLoop` harness with
  its `recorder` and fake providers; `NOW` is the file's existing clock):

```ts
describe('persistent cooldowns (ADR 0143, spec 6c)', () => {
  it('two runs after a daily 429 never call that key again before the reset', async () => {
    const calls: string[] = [];
    const chain = poolChain(['key_a', 'key_b'], 'gemini-3.8-flash', calls);
    const first = await runToolLoop(testInput(chain, { failKey: 'key_a', failBody: DAILY_429 }));
    expect(calls.filter((k) => k === 'key_a')).toHaveLength(1);
    expect(first.attempts.some((a) => a.outcome === 'answered')).toBe(true);
    calls.length = 0;
    const second = await runToolLoop(testInput(chain));
    expect(calls).not.toContain('key_a');
    expect(second.events.map((e) => e.kind)).toContain('model-skipped');
    expect(
      second.events.find((e) => e.kind === 'model-skipped' && e.keyId === 'key_a'),
    ).toMatchObject({ reason: 'daily-quota' });
  });
  it('a restart keeps the cooldown (cooldown table is the authority)', async () => {
    const calls: string[] = [];
    const chain = poolChain(['key_a', 'key_b'], 'gemini-3.8-flash', calls);
    await runToolLoop(testInput(chain, { failKey: 'key_a', failBody: DAILY_429 }));
    const afterRestart = await runToolLoop(testInput(freshChain(chain), { freshLedger: true }));
    expect(calls.filter((k) => k === 'key_a')).toHaveLength(1);
    expect(afterRestart.events.find((e) => e.kind === 'model-skipped' && e.keyId === 'key_a')).toBeDefined();
  });
  it('a minute cooldown expires on time and the key is tried again', async () => {
    const calls: string[] = [];
    const chain = poolChain(['key_a'], 'gemini-3.8-flash', calls);
    await runToolLoop(testInput(chain, { failKey: 'key_a', failBody: MINUTE_429, now: NOW }));
    const during = await runToolLoop(testInput(chain, { now: NOW + 30_000 }));
    expect(during.events.find((e) => e.kind === 'model-skipped' && e.keyId === 'key_a')).toMatchObject({
      reason: 'minute-quota',
    });
    const after = await runToolLoop(testInput(chain, { now: NOW + 61_000 }));
    expect(after.events.map((e) => e.kind)).toContain('model-call');
  });
  it('a pool with all keys spent emits model-skipped and falls through without retrying', async () => {
    const result = await runToolLoop(testInput(spentPoolChain(), { now: NOW }));
    expect(result.attempts.every((a) => a.outcome === 'skipped')).toBe(true);
    expect(result.events.map((e) => e.kind)).not.toContain('retry-scheduled');
  });
  it('an OpenRouter :free daily cap cools that key until its reset', async () => {
    const calls: string[] = [];
    const chain = poolChain(['key_or'], 'some-model:free', calls, 'openrouter');
    await runToolLoop(testInput(chain, { failKey: 'key_or', failError: DAILY_FREE_ERROR }));
    calls.length = 0;
    await runToolLoop(testInput(chain, { now: NOW + 60_000 }));
    expect(calls).not.toContain('key_or');
  });
});
```

  (`DAILY_429`/`MINUTE_429` are the S6-T5 fixture shape inline: `QuotaFailure` with
  `GenerateRequestsPerDayPerProjectPerModel-FreeTier` value `20` / `…PerMinute…` value `5` plus
  `RetryInfo` `37s`. `DAILY_FREE_ERROR` is `new ProviderError('quota', 'daily free cap', { quotaScope:
  'daily-free', resetAt: NOW + 3_600_000 })` (use the constructor's real option shape in `errors.ts`).
  `testInput`/`poolChain`/`freshChain`/`spentPoolChain` are local helpers built on the file's existing harness;
  `poolChain`'s optional fourth argument is the provider id, default `'gemini'`.)

  **Break-it (controller correction — no bypass flag in production code):** after Step 4 passes, delete the
  pre-call `getCooldown` skip block in `tool-loop.ts`, run the same command, and watch "two runs after a daily 429
  never call that key again" fail. Restore the block, re-run, PASS. Name the failing test in the commit message.

- [ ] **Step 2: Run it and watch it fail** —
  `npx vitest run packages/core/src/assistant/run-events.test.ts apps/daemon/src/assistant/tool-loop.test.ts --maxWorkers=1` ·
  Expected: FAIL (`routed` unknown; no cooldown persistence)
- [ ] **Step 3: Implement** —
  1. In `run-events.ts`, insert before the `tool-call` entry (anchor: lines 114–120):

```ts
  z
    .object({
      kind: z.literal('routed'),
      tier: z.enum(['standard', 'light']),
      reason: z.string().max(60),
    })
    .strict(),
```

  2. In `tool-loop.ts`:
     - Keep the `QuotaLedger` import and constructor working (existing call sites in `service.ts` compile),
       but delete the two request-path consultations: the `ledgerUntil` block (anchor: lines 364–382,
       `input.quotaLedger?.exhaustedUntil`) and the `cappedKeys`/`onDailyCap → markExhausted` path (anchor:
       lines 383–397 and `onDailyCap` at 430–435). Replace them with the cooldown table: before each entry,
       call `getCooldown(instance, entry.selectedKeyId ?? entry.keyId, entry.model, input.now())`; when
       defined, record `model-skipped` with reason `daily-quota` / `minute-quota` / `invalid-key` (from the
       row's `reason`), push a skipped attempt, and `continue` — never call the provider.
     - In the provider-error catch (anchor: `pushFailedAttempt` near line 700), map a `ProviderError` to one
       `setCooldown` call for (`entry.selectedKeyId ?? entry.keyId`, `entry.model`), using the entry's own
       provider (`entry.providerId`), never a hard-coded `'gemini'`:
       - `kind: 'quota'`, `quotaScope: 'day'` → `until: nextProviderDayStart(entry.providerId, input.now())`,
         `reason: 'daily-quota'`, learned limits from `error.learnedLimit`;
       - `kind: 'quota'`, `quotaScope: 'daily-free'` (OpenRouter `:free`, today's `QuotaLedger` case — spec 6c
         moves it here) → `until: error.resetAt ?? nextProviderDayStart(entry.providerId, input.now())`,
         `reason: 'daily-quota'`;
       - `quotaScope: 'minute'`, or `kind: 'rate-limit'` with `retryAfterMs` (a plain 429 with `Retry-After`) →
         `until: input.now() + (error.retryAfterMs ?? 60_000)`, `reason: 'minute-quota'`;
       - `kind: 'authentication'` → `until: Number.MAX_SAFE_INTEGER`, `reason: 'invalid-key'` (cleared only by
         edit or re-test in S6-T12).
       Fully spent pools fall through to the next entry and never schedule a retry (`retry-scheduled` is not
       emitted on this path).
  3. No secret, key text or response body is logged or recorded; reasons stay fixed strings.

- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS (then re-add the guard after the
  break-it check and re-run · PASS)
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** —
  `npx prettier --write apps/daemon/src/assistant/tool-loop.ts apps/daemon/src/assistant/tool-loop.test.ts packages/core/src/assistant/run-events.ts packages/core/src/assistant/run-events.test.ts`
  then `npx eslint` on the same four paths · exit 0
- [ ] **Step 7: Commit** —
  `git add apps/daemon/src/assistant/tool-loop.ts apps/daemon/src/assistant/tool-loop.test.ts packages/core/src/assistant/run-events.ts packages/core/src/assistant/run-events.test.ts && git commit -m "Slice 6 T11: loop cooldowns and routed event"`

**Done when:** the 6c cases pass (never-called-again, restart-safe, minute expiry, spent-pool fall-through);
the break-it test proves the skip is load-bearing; `routed` validates with tier + reason.

---

### S6-T12: Bulk key paste and recommended chain routes   ·   Wave 3
**Owns:** Modify: `packages/http/src/routes/assistant-providers.ts`,
`packages/http/src/routes/assistant-providers.test.ts`
**Reads (do not edit):** `packages/storage/src/repos/assistant-providers.ts` (S6-T6 output: `fingerprintOf`,
`addKey` duplicate refusal), `packages/core/src/providers/model-capabilities.ts` (S6-T3 output:
`GEMINI_MODEL_TABLE`)
**Interfaces:** Consumes: `fingerprintOf`, `bucketOf` (S6-T6), `GEMINI_MODEL_TABLE` free limits (S6-T3) ·
Produces: `POST /api/assistant/keys/bulk`, `POST /api/assistant/model-chain/recommended` (for S6-T16);
re-test clears `invalid-key` cooldowns (for S6-T11)

- [ ] **Step 1: Write the failing test** — append to `packages/http/src/routes/assistant-providers.test.ts`
  (mirror the file's existing owner-guard + `assistantProviderConfig` stub harness):

```ts
describe('bulk keys and recommended chain (ADR 0143)', () => {
  it('pastes many keys at once, deduping by fingerprint without ever returning key text', async () => {
    const store = stubStore({ keys: [{ keyId: 'key_a', fingerprint: fingerprintOf('AIza-test-one') }] });
    const first = await app.inject({
      method: 'POST',
      url: '/api/assistant/keys/bulk',
      payload: {
        provider: 'gemini',
        project: 'Car Team A',
        keysText: 'AIza-test-one\nAIza-test-two\nAIza-test-two',
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ added: 1, duplicates: 2 });
    expect(JSON.stringify(first.json())).not.toContain('AIza-');
    const audit = auditRows().filter((r) => r.action === 'assistant_provider.keys_pasted');
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain('AIza-');
  });
  it('refuses an empty paste and a bad project label', async () => {
    for (const payload of [
      { provider: 'gemini', keysText: '   \n ' },
      { provider: 'gemini', project: 'x'.repeat(81), keysText: 'AIza-test-two' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/assistant/keys/bulk', payload });
      expect(res.statusCode).toBe(400);
    }
  });
  it('recommended setup builds the Gemini chain then owner OpenRouter entries', async () => {
    const store = stubStore({
      keys: [
        { keyId: 'key_a', provider: 'gemini' },
        { keyId: 'key_b', provider: 'gemini' },
        { keyId: 'key_o', provider: 'openrouter' },
      ],
    });
    const res = await app.inject({ method: 'POST', url: '/api/assistant/model-chain/recommended', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, count: 4 });
    const saved = store.savedChain();
    expect(saved.map((e) => e.model)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'owner-model',
    ]);
    expect(saved.slice(0, 3).every((e) => e.pool === 'provider')).toBe(true);
    expect(saved[0]).toMatchObject({ rpdLimit: 20, rpmLimit: 5 });
    expect(saved[3]).toMatchObject({ pool: 'key' });
  });
  it('recommended setup refuses when no Gemini key exists', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/assistant/model-chain/recommended', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'no-gemini-key' });
  });
  it('re-test clears an invalid-key cooldown on success', async () => {
    const store = stubStore({ cooldowns: [{ keyId: 'key_a', reason: 'invalid-key' }] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/assistant/model-chain/test',
      payload: { position: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(store.cooldowns()).toEqual([]);
  });
});
```

  (`stubStore`, `auditRows` extend the file's existing harness; keys use fake `AIza-test-*` values only.)

  **Controller addition — write these first:** a signed-in non-owner account calling `POST
  /api/assistant/keys/bulk` and the recommended-chain route gets `403` with the file's existing owner-protected
  error code, and the store receives no key and no chain write (assert the stub's call counts are 0). Follow the
  owner-guard tests already in this file. Break-it: remove the owner guard from the bulk route, watch the 403 test
  fail, restore.

- [ ] **Step 2: Run it and watch it fail** —
  `npx vitest run packages/http/src/routes/assistant-providers.test.ts --maxWorkers=1` · Expected: FAIL
  (unknown routes `/bulk`, `/recommended`)
- [ ] **Step 3: Implement** — in `assistant-providers.ts`:
  1. Add the bulk schema beside `keyBody` (anchor: lines 17–24):

```ts
const bulkBody = z
  .object({
    provider: z.enum(PROVIDERS),
    project: z.string().min(1).max(80).optional(),
    costClass: z.enum(['free', 'paid', 'unknown']).optional(),
    keysText: z.string().min(1).max(20_000),
  })
  .strict();
```

  2. Register `POST /api/assistant/keys/bulk` after the single-key POST (anchor: lines 187–188): split
  `keysText` on newlines, trim, drop empties; for each line compute `fingerprintOf(line)`; skip lines whose
  fingerprint matches an existing key or an earlier line in the same paste (count as `duplicates`); else
  `configured.addKey({ provider, label: derivedLabel, apiKey: line, project, costClass }, deps.now())`
  where `derivedLabel` is `${provider} ${count}` (never the key text). Respond `{ added, duplicates }`.
  Audit once as `assistant_provider.keys_pasted` with `{ provider, project, added, duplicates }` — no key
  text, sealed or plain, in the response, audit row, log or error.
  3. Register `POST /api/assistant/model-chain/recommended` after the chain PUT (anchor: lines 305–306):
  refuse `{ error: 'no-gemini-key' }` (400) when no enabled Gemini key exists; else `saveChain` with three
  Gemini pool entries over the provider's oldest key id (the FK anchor; runtime expansion uses the provider
  per S6-T10) with limits from `GEMINI_MODEL_TABLE` (5/20, 5/20, 15/500), then re-append the owner's
  existing OpenRouter entries unchanged (pool `key`); audit as `assistant_provider.chain_saved` with the
  entry list. Refuse when the result would exceed six entries (`too-many`).
  4. Extend `chainBody` entries with `pool: z.enum(['key', 'provider']).optional()` and
  `tier: z.enum(['standard', 'light']).optional()`; pass them through `saveChain` and the audit payload.
  5. In the model-chain test route (anchor: lines 357–362), on success call
  `clearCooldowns(instance, entry.selectedKeyId ?? entry.keyId, entry.model)` so a fixed key is usable
  again; on 401/403 set the `invalid-key` cooldown (S6-T11). Key edit (`PATCH` with `apiKey`) also clears
  that key's cooldowns.

- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** —
  `npx prettier --write packages/http/src/routes/assistant-providers.ts packages/http/src/routes/assistant-providers.test.ts`
  then `npx eslint` on both paths · exit 0
- [ ] **Step 7: Commit** —
  `git add packages/http/src/routes/assistant-providers.ts packages/http/src/routes/assistant-providers.test.ts && git commit -m "Slice 6 T12: bulk keys and recommended chain routes"`

**Done when:** bulk paste is idempotent by fingerprint with no key text anywhere; recommended setup builds the
3-entry Gemini pool chain plus owner entries or refuses cleanly; re-test/edit clears invalid cooldowns.

---

### S6-T13: Service routing, tier ordering and escalation   ·   Wave 4
**Owns:** Modify: `apps/daemon/src/assistant/service.ts`, `apps/daemon/src/assistant/service.test.ts`,
`packages/core/src/index.ts` (one export line)
**Reads (do not edit):** `packages/core/src/assistant/router.ts` (S6-T4 output), `apps/daemon/src/assistant/model-chain.ts`
(S6-T10 output: `tier`, `orderChainByTier` location), `packages/core/src/settings/instance-settings.ts` (S6-T9 output)
**Interfaces:** Consumes: `routeRun`, `orderChainByTier`, `ChainTier` (S6-T4), router settings keys (S6-T9),
`ChainEntry.tier/pool` (S6-T10), `routed` event + cooldown loop (S6-T11) · Produces: routed run behaviour
audited by the `routed` event (for S6-T15, S6-T16)

- [ ] **Step 1: Write the failing test** — append to `apps/daemon/src/assistant/service.test.ts` (use the
  file's existing service harness with stub chain + settings):

```ts
describe('complexity routing (ADR 0144, spec 6e)', () => {
  it.each([
    ['hi', 'light'],
    ['remind me at 5', 'standard'],
  ])('routes %s to the %s tier first', async (text, tier) => {
    const seen = await runWith(text, {});
    expect(seen.routed).toEqual({ tier, reason: tier === 'light' ? 'greeting' : 'full-model-keyword' });
    expect(seen.firstEntryTier).toBe(tier);
  });
  it('routes attachments and long threads to standard, greetings stay light', async () => {
    expect((await runWith('look', { hasAttachments: true })).routed.tier).toBe('standard');
    expect((await runWith('and then?', { earlierTurns: 5 })).routed).toMatchObject({
      tier: 'standard',
      reason: 'long-thread',
    });
    expect((await runWith('thanks!', { earlierTurns: 9 })).routed).toMatchObject({
      tier: 'light',
      reason: 'greeting',
    });
  });
  it('a light run falls back to standard when Flash-Lite is spent', async () => {
    const seen = await runWith('hi', { spentModels: ['gemini-3.5-flash-lite'] });
    expect(seen.routed.tier).toBe('light');
    expect(seen.answeredBy.model).not.toBe('gemini-3.5-flash-lite');
    expect(seen.answeredBy.tier).toBe('standard');
  });
  it('a light tool call escalates to standard on the next round (on by default)', async () => {
    const seen = await runWith('hi', { toolCalls: ['list_sources'] });
    expect(seen.rounds[1].tier).toBe('standard');
    expect(seen.rounds[1].reason).toBe('escalated-after-tool');
  });
  it('router-off and background tiers are honoured', async () => {
    expect((await runWith('hi', { settings: { 'assistant.routerEnabled': 0 } })).routed).toMatchObject({
      tier: 'standard',
      reason: 'router-off',
    });
    expect((await runWithSummaryTier('light')).tierUsed).toBe('light');
  });
});
```

  (`runWith`/`runWithSummaryTier` wrap the existing harness: stub settings from S6-T9 defaults, a two-tier
  chain, fake providers that record tiers tried. Reasons use the fixed vocabulary from Plan decisions.)

- [ ] **Step 2: Run it and watch it fail** —
  `npx vitest run apps/daemon/src/assistant/service.test.ts --maxWorkers=1` · Expected: FAIL (no `routed`
  event, no tier ordering)
- [ ] **Step 3: Implement** — in `service.ts`:
  1. Append `export * from './assistant/router.js';` to `packages/core/src/index.ts` in its existing style
  (the S6-T4 export deferred here so wave-1 file lists stay disjoint).
  2. Build `RouterRules` from instance settings at run start (anchor: the service's settings read near line
  371, beside `quotaLedger`): `enabled` from `assistant.routerEnabled`, `maxChars` from
  `assistant.routerMaxChars`, keywords/greetings from the two chip-list settings (fall back to
  `DEFAULT_ROUTER_KEYWORDS`/`DEFAULT_ROUTER_GREETINGS` when empty), `longThreadTurns`, `escalateOnTool`.
  Background jobs use `assistant.routerSummaryTier` / `assistant.routerDailyDigestTier` as a forced tier
  (no `routeRun` call; `routed` reason is `background-tier`).
  3. Call `routeRun({ text, hasAttachments, hasQuoteOrReply, earlierTurns }, rules)`, record
  `{ kind: 'routed', tier, reason }` as the run's first event, and order the resolved chain with
  `orderChainByTier(chain, tier)` before the loop (import from `@bananasaurs/core`). A light run tries light
  entries first then standard; standard tries standard then light (S6-T4).
  4. Escalation: when the run is light, `escalateOnTool` is on, and round 1 invokes any tool, re-order the
  remaining entries to standard-first for round 2 and record a second `routed` event with reason
  `escalated-after-tool`. Mentions are stripped before routing; routing never spends a provider request.

- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** —
  `npx prettier --write apps/daemon/src/assistant/service.ts apps/daemon/src/assistant/service.test.ts packages/core/src/index.ts`
  then `npx eslint` on the same three paths · exit 0
- [ ] **Step 7: Commit** —
  `git add apps/daemon/src/assistant/service.ts apps/daemon/src/assistant/service.test.ts packages/core/src/index.ts && git commit -m "Slice 6 T13: service routing and escalation"`

**Done when:** every 6e routing case passes through the service; light falls back to standard when spent; tool
calls escalate; router-off and background tiers are honoured; `routed` audits each decision.

---

### S6-T14: Check-models route with stubbed tools and budget   ·   Wave 4
**Owns:** Create: `packages/http/src/routes/assistant-model-check.ts`,
`packages/http/src/routes/assistant-model-check.test.ts` · Modify: `packages/http/src/server.ts` (register
call only)
**Reads (do not edit):** `packages/http/src/routes/assistant-providers.ts:308-384` (model-chain test route
style, `reserveTestCall`, `TERMS_REFUSAL`), `packages/http/src/server.ts:121-160` (`assistantProviderConfig`
type and route registration style)
**Interfaces:** Consumes: resolved chain entries + `selectedKeyId` (S6-T10), `reserveTestCall` (S6-T12) ·
Produces: `POST /api/assistant/model-check` (for S6-T16); writes only `dashboard-test` ledger source

- [ ] **Step 1: Write the failing test** — create
  `packages/http/src/routes/assistant-model-check.test.ts` (mirror the `assistant-providers.test.ts`
  owner-guard + stub harness):

```ts
import { describe, expect, it } from 'vitest';

describe('check models (ADR 0143)', () => {
  it('shows expected versus first action per fixture with stubbed tools', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/assistant/model-check',
      payload: { position: 0 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(3);
    expect(body.results[0]).toMatchObject({
      id: 'greeting-light',
      expectedFirstAction: 'answer-without-tools',
    });
    expect(typeof body.results[0].firstAction).toBe('string');
    expect(body.budget).toMatchObject({ reserved: 3, spent: 3 });
    expect(body.ledgerSource).toBe('dashboard-test');
  });
  it('refuses before any call when the budget does not cover every fixture', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/assistant/model-check',
      payload: { position: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, error: 'budget-exhausted' });
    expect(spentCalls()).toBe(0);
  });
  it('stubs every tool, posts nothing, and mutates no member data', async () => {
    await app.inject({ method: 'POST', url: '/api/assistant/model-check', payload: { position: 0 } });
    expect(postedMessages()).toEqual([]);
    expect(memberWrites()).toEqual([]);
    expect(toolStubsUsed().length).toBeGreaterThan(0);
  });
  it('terms-unverified entries refuse without calling', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/assistant/model-check',
      payload: { position: 4 },
    });
    expect(res.json()).toMatchObject({ ok: false });
    expect(spentCalls()).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail** —
  `npx vitest run packages/http/src/routes/assistant-model-check.test.ts --maxWorkers=1` · Expected: FAIL
  with `Failed to resolve import "./assistant-model-check.js"`
- [ ] **Step 3: Implement** — create `packages/http/src/routes/assistant-model-check.ts`:

```ts
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { HttpDeps, RouteGuard } from '../server.js';
import { badRequest } from '../errors/reply.js';
import type { SessionContext } from '../auth.js';
import { dashboardAuditBase } from './audit-base.js';
import { isInstanceOwner } from './assistant.js';

const checkBody = z.object({ position: z.number().int().min(0) }).strict();

/** Fixture id, member-safe message, and the expected first action of the checked entry. */
export const CHECK_FIXTURES = [
  { id: 'greeting-light', message: 'hi', expectedFirstAction: 'answer-without-tools' },
  { id: 'reminder-standard', message: 'remind me at 5', expectedFirstAction: 'call-tool' },
  { id: 'attachment-standard', message: 'look at this', expectedFirstAction: 'call-tool' },
] as const;

const fakeTools = [
  { name: 'list_sources', run: async () => ({ stubbed: true }) },
  { name: 'read_chunk', run: async () => ({ stubbed: true }) },
] as const;

export const registerAssistantModelCheckRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  app.post('/api/assistant/model-check', async (request, reply) => {
    const session = guard.require(request, reply) as SessionContext | undefined;
    if (session === undefined) return reply;
    if (!isInstanceOwner(deps, session)) return reply.status(403).send({ error: 'owner-only' });
    const parsed = checkBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const configured = deps.assistantProviderConfig;
    const entries = configured?.chain?.() ?? [];
    const entry = entries[parsed.data.position];
    if (entry === undefined) return reply.status(404).send({ error: 'not-found' });
    if (entry.provider === undefined || entry.skip !== undefined) {
      return reply.status(200).send({ ok: false, error: 'entry-unusable', skip: entry.skip ?? 'skipped' });
    }
    // Budget equals fixture count: reserve every call before the first one.
    const budget = CHECK_FIXTURES.length;
    const reservations = CHECK_FIXTURES.map(() =>
      configured?.reserveTestCall?.(parsed.data.position, session.guildId),
    );
    if (reservations.some((r) => r !== undefined && !r.ok)) {
      return reply.status(200).send({ ok: false, error: 'budget-exhausted', budget: { reserved: 0, spent: 0 } });
    }
    const results = [];
    for (const fixture of CHECK_FIXTURES) {
      void fixture;
      void fakeTools;
      // The real call runs with stubbed tools and ledger source 'dashboard-test';
      // the first action (answer vs tool call) is recorded per fixture below.
      results.push({ id: 'pending', expectedFirstAction: 'pending', firstAction: 'pending' });
    }
    void results;
    return reply.status(200).send({ ok: true, results: [], budget: { reserved: budget, spent: 0 }, ledgerSource: 'dashboard-test' });
  });
};
```

  (The loop body above is the shape; the subagent fills it: one `generateText` per fixture with the stubbed
  tool list, `firstAction` = `'call-tool'` when the response carries tool calls else `'answer-without-tools'`,
  ledger writes use source `dashboard-test` only, no Discord post, no member-data mutation. Audit once as
  `assistant_provider.model_checked` with `{ position, fixtureCount }`, never message text beyond fixture ids.)
  Then in `packages/http/src/server.ts`, add one register call beside the existing
  `registerAssistantProviderRoutes` call — no other change.

- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** —
  `npx prettier --write packages/http/src/routes/assistant-model-check.ts packages/http/src/routes/assistant-model-check.test.ts packages/http/src/server.ts`
  then `npx eslint` on the same three paths · exit 0
- [ ] **Step 7: Commit** —
  `git add packages/http/src/routes/assistant-model-check.ts packages/http/src/routes/assistant-model-check.test.ts packages/http/src/server.ts && git commit -m "Slice 6 T14: check-models route"`

**Done when:** check runs every fixture against one entry with stubbed tools; budget is reserved before the
first call and refusal spends nothing; ledger source is `dashboard-test`; nothing posts or mutates member data.

---

### S6-T15: Doctor, health and run-event text   ·   Wave 4
**Owns:** Modify: `apps/daemon/src/runtime/doctor.ts`, `apps/daemon/src/runtime/doctor.test.ts`,
`packages/http/src/routes/assistant-model-health.ts`,
`packages/http/src/routes/assistant-model-health.test.ts`, `packages/dashboard/src/api/runs.ts` · Create:
`packages/dashboard/src/api/runs.test.ts`
**Reads (do not edit):** `apps/daemon/src/runtime/doctor.ts:520-587` (provider/eligibility check style),
`packages/http/src/routes/assistant-model-health.ts:1-80` (full file: enrichment + `config.read` gating),
`packages/dashboard/src/api/runs.ts:60-112` (`model-skipped` text + `unknownEvent` default)
**Interfaces:** Consumes: `routed` event (S6-T11), cooldown reasons + routing tiers (S6-T11, S6-T13) ·
Produces: dashboard-visible cooldown/may-train banners and `routed` text (for S6-T16)

- [ ] **Step 1: Write the failing tests** — append to `apps/daemon/src/runtime/doctor.test.ts`:

```ts
it('warns on may-train Gemini keys and fully cooling pools (ADR 0143)', async () => {
  const report = await doctorWith({
    keys: [{ keyId: 'key_a', provider: 'gemini', costClass: 'free' }],
    cooldowns: [{ keyId: 'key_a', model: 'gemini-3.8-flash', reason: 'daily-quota' }],
  });
  expect(report.warnings.join('\n')).toContain('may train');
  expect(report.warnings.join('\n')).toContain('cooling');
});
```

  append to `packages/http/src/routes/assistant-model-health.test.ts`:

```ts
it('marks in-chain pairs and withholds providerMessage without config.read', async () => {
  const viewer = await getAs('/api/assistant/model-health?window=24h', { capabilities: ['audit.read'] });
  expect(viewer.statusCode).toBe(200);
  expect(viewer.json().models[0]).toMatchObject({ inChain: true });
  expect(viewer.json().models[0].lastError?.providerMessage).toBeUndefined();
});
```

  and create `packages/dashboard/src/api/runs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runEventText } from './runs.js';

describe('run event text (Slice 6)', () => {
  it('renders routed and cooldown-skipped reasons in plain words', () => {
    expect(runEventText({ kind: 'routed', tier: 'light', reason: 'greeting' })).toContain('Light');
    expect(
      runEventText({ kind: 'model-skipped', provider: 'gemini', model: 'gemini-3.8-flash', keyId: 'key_a', reason: 'daily-quota' }),
    ).toContain('daily limit');
  });
});
```

  (Use each file's existing harness names; `runEventText` is the existing formatter in `runs.ts` that already
  handles `model-skipped`.)

- [ ] **Step 2: Run it and watch it fail** —
  `npx vitest run apps/daemon/src/runtime/doctor.test.ts packages/http/src/routes/assistant-model-health.test.ts packages/dashboard/src/api/runs.test.ts --maxWorkers=1` ·
  Expected: FAIL (no warnings; no `inChain`; no `routed` text)
- [ ] **Step 3: Implement** —
  1. In `doctor.ts` (anchor: the provider section near lines 520–587), add two advisory checks: (a) any
  Gemini free key reports `may train on submitted input — recorded terms, still usable` as a warning naming
  the key label (never the secret); (b) any chain entry whose pool keys all cool (via `getCooldown`) reports
  `pool cooling until <Pacific midnight>` as a warning. Both are warnings, never failures; plain Canadian
  English.
  2. In `assistant-model-health.ts`, the `inChain` enrichment already exists — extend each model with
  `coolingUntil` (max `until` across that key/model's cooldown rows, omitted when none) and keep the
  `config.read` gating for `providerMessage`. No new query param.
  3. In `packages/dashboard/src/api/runs.ts`, add a `routed` case beside `model-skipped` (anchor: lines
  76–80):

```ts
case 'routed':
  return event.tier === 'light'
    ? `Tried the light model first (${event.reason})`
    : `Tried the standard model first (${event.reason})`;
```

  and extend the `model-skipped` text: reason `daily-quota` → `daily limit`, `minute-quota` →
  `minute limit`, `invalid-key` → `key needs attention`. No tool names shown.

- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** —
  `npx prettier --write apps/daemon/src/runtime/doctor.ts apps/daemon/src/runtime/doctor.test.ts packages/http/src/routes/assistant-model-health.ts packages/http/src/routes/assistant-model-health.test.ts packages/dashboard/src/api/runs.ts packages/dashboard/src/api/runs.test.ts`
  then `npx eslint` on the same six paths · exit 0
- [ ] **Step 7: Commit** —
  `git add apps/daemon/src/runtime/doctor.ts apps/daemon/src/runtime/doctor.test.ts packages/http/src/routes/assistant-model-health.ts packages/http/src/routes/assistant-model-health.test.ts packages/dashboard/src/api/runs.ts packages/dashboard/src/api/runs.test.ts && git commit -m "Slice 6 T15: doctor health and run-event text"`

**Done when:** doctor warns on may-train keys and cooling pools; health marks in-chain pairs with cooling times
and still withholds provider text; history renders `routed` and cooldown skips in plain words.

---

### S6-T16: Dashboard pools, routing, check UI   ·   Wave 5
**Owns:** Create: `packages/dashboard/src/components/assistant-keys-paste.tsx`,
`packages/dashboard/src/components/assistant-key-status-rows.tsx`,
`packages/dashboard/src/components/assistant-chain-pools.tsx`,
`packages/dashboard/src/components/assistant-recommended-setup.tsx`,
`packages/dashboard/src/components/assistant-routing-settings.tsx`,
`packages/dashboard/src/components/assistant-model-check.tsx`,
`packages/dashboard/src/components/assistant-slice6.test.tsx`,
`packages/dashboard/src/api/assistant-slice6.test.ts` · Modify: `packages/dashboard/src/pages/providers.tsx`
(mount only), `packages/dashboard/src/pages/providers.test.tsx`, `packages/dashboard/src/api/assistant.ts`
(additive types)
**Reads (do not edit):** `packages/dashboard/src/pages/providers.tsx:1-60` (import + `ui/` component style),
`packages/dashboard/src/api/assistant.ts:300-360` (`SetupKeyRow`/`SetupChainRow` shapes),
`packages/dashboard/src/test-support.tsx` (`renderWithSession`, `stubFetch`)
**Interfaces:** Consumes: bulk/recommended/check endpoints (S6-T12, S6-T14), router settings keys (S6-T9),
`routed`/cooldown text (S6-T15) · Produces: dashboard UI (no further consumers)

- [ ] **Step 1: Write the failing tests** — create
  `packages/dashboard/src/components/assistant-slice6.test.tsx` (use `renderWithSession` + `stubFetch` from
  `test-support.tsx`; `Card`/`Button`/`Field` from `ui/`):

```tsx
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithSession } from '../test-support.js';
import { AssistantKeysPaste } from './assistant-keys-paste.js';
import { AssistantRoutingSettings } from './assistant-routing-settings.js';
import { AssistantModelCheck } from './assistant-model-check.js';

describe('Slice 6 dashboard (ADR 0143/0144)', () => {
  it('paste box saves many keys and reports added versus duplicates', async () => {
    const { user } = renderWithSession(<AssistantKeysPaste />);
    await user.type(screen.getByLabelText(/paste/i), 'AIza-test-one\nAIza-test-two');
    await user.click(screen.getByRole('button', { name: /save keys/i }));
    expect(await screen.findByText(/1 added, 1 already saved/i)).toBeDefined();
  });
  it('routing settings render chip lists and Try the router', async () => {
    renderWithSession(<AssistantRoutingSettings />);
    expect(screen.getByText(/full-model keywords/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /try the router/i })).toBeDefined();
  });
  it('check-models shows the expected-versus-first-action scorecard', async () => {
    renderWithSession(<AssistantModelCheck position={0} />);
    await screen.findByRole('button', { name: /check this entry/i });
    expect(screen.getByText(/expected/i)).toBeDefined();
  });
});
```

  and create `packages/dashboard/src/api/assistant-slice6.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BULK_KEYS_URL, MODEL_CHECK_URL, RECOMMENDED_CHAIN_URL } from './assistant.js';

describe('Slice 6 API urls', () => {
  it('pins the three new endpoints', () => {
    expect(BULK_KEYS_URL).toBe('/api/assistant/keys/bulk');
    expect(RECOMMENDED_CHAIN_URL).toBe('/api/assistant/model-chain/recommended');
    expect(MODEL_CHECK_URL).toBe('/api/assistant/model-check');
  });
});
```

- [ ] **Step 2: Run it and watch it fail** —
  `npx vitest run packages/dashboard/src/components/assistant-slice6.test.tsx packages/dashboard/src/api/assistant-slice6.test.ts --maxWorkers=1` ·
  Expected: FAIL with `Failed to resolve import`
- [ ] **Step 3: Implement** — one new component file each (all under
  `packages/dashboard/src/components/`, using existing `ui/` primitives; Canadian English, plain words, no
  tool names shown to members):
  1. `assistant-keys-paste.tsx`: a labelled textarea plus provider/project pickers; posts `BULK_KEYS_URL`;
  shows `{ added } added, { duplicates } already saved`; never echoes key text.
  2. `assistant-key-status-rows.tsx`: per-key remaining-today budget, cooling-until time, and the may-train
  note for free Gemini keys.
  3. `assistant-chain-pools.tsx`: pool (`one key` / `whole provider`) and tier (`standard` / `light`)
  columns in the chain editor; saves via the extended chain body (S6-T12).
  4. `assistant-recommended-setup.tsx`: "Use the recommended Gemini setup" button posting
  `RECOMMENDED_CHAIN_URL`; shows `no-gemini-key` as `Add a Gemini key first`.
  5. `assistant-routing-settings.tsx`: on/off, longest-light-message, long-thread turns, escalate toggle,
  background-job tiers, plus editable chip lists for keywords/greetings (string arrays with display `text`,
  per Plan decisions — never comma-separated text) and a "Try the router" box that routes locally and shows
  tier + reason.
  6. `assistant-model-check.tsx`: per-entry "Check this entry" posting `MODEL_CHECK_URL`; scorecard of
  fixture id → expected vs first action; budget refusal shown as `Out of test budget — try again after the
  reset`.
  7. In `packages/dashboard/src/api/assistant.ts`, add the three URL constants plus additive `pool?`/`tier?`
  on `SetupChainRow`, `project?` on `SetupKeyRow`, and `coolingUntil?` on the health model — no existing type
  changes.
  8. In `packages/dashboard/src/pages/providers.tsx`, mount the six components in the existing sections
  (imports + one JSX tag each; no other change). Extend `providers.test.tsx` with one test that the mounted
  components render (paste box label + Try-the-router button present).

- [ ] **Step 4: Run it and watch it pass** — same command · Expected: PASS; then
  `npx vitest run packages/dashboard/src/pages/providers.test.tsx --maxWorkers=1` · PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** —
  `npx prettier --write packages/dashboard/src/components/assistant-*.tsx packages/dashboard/src/components/assistant-slice6.test.tsx packages/dashboard/src/api/assistant-slice6.test.ts packages/dashboard/src/api/assistant.ts packages/dashboard/src/pages/providers.tsx packages/dashboard/src/pages/providers.test.tsx`
  then `npx eslint` on the same paths · exit 0
- [ ] **Step 7: Commit** —
  `git add packages/dashboard/src/components/assistant-keys-paste.tsx packages/dashboard/src/components/assistant-key-status-rows.tsx packages/dashboard/src/components/assistant-chain-pools.tsx packages/dashboard/src/components/assistant-recommended-setup.tsx packages/dashboard/src/components/assistant-routing-settings.tsx packages/dashboard/src/components/assistant-model-check.tsx packages/dashboard/src/components/assistant-slice6.test.tsx packages/dashboard/src/api/assistant-slice6.test.ts packages/dashboard/src/api/assistant.ts packages/dashboard/src/pages/providers.tsx packages/dashboard/src/pages/providers.test.tsx && git commit -m "Slice 6 T16: dashboard pools routing check UI"`

**Done when:** paste, status rows, pool/tier columns, recommended button, routing chips + try-box, and the
check scorecard all render and save through the new endpoints; every new setting has a control (§4.7).

---

### S6-T17: STATE.md and PRIVACY.md   ·   Wave 5
**Owns:** Modify: `docs/STATE.md`, `PRIVACY.md`
**Reads (do not edit):** `docs/STATE.md:1-20` (living-document header + Slice 1 entry style),
`PRIVACY.md` (row style; Slice 2/M1 rows landed the retention row in the migration commit)
**Interfaces:** Consumes: ADR 0143/0144 numbers (S6-T1, S6-T2), routing behaviour (S6-T13), doctor/health
surface (S6-T15) · Produces: none (last task)

- [ ] **Step 1: Write the failing test** — not applicable (documents). Verify placement first:
  `sed -n '1,10p' docs/STATE.md` must show the living-document header and the first `---`; `grep -n "cooldown"
  PRIVACY.md` must print nothing (the new rows are absent).
- [ ] **Step 2: Run it and watch it fail** — not applicable (documents).
- [ ] **Step 3: Implement** —
  1. In `docs/STATE.md`, insert after the first `---` (same bullet style as the Slice 1 entry):

```markdown
**Slice 6 — provider key pools, cooldowns, Gemini chain and routing (ADRs 0143–0144, migration
`key_pools_routing`).**

- **Key pools:** a chain entry uses one key or every enabled key of its provider; the pick is deterministic
  (most daily requests left, then least-recent use, then key id). Keys sharing a project label share one daily
  ledger bucket. Bulk paste dedupes by SHA-256 fingerprint without exposing secrets.
- **Cooldowns:** a daily Gemini 429 cools until the next Pacific midnight, a minute 429 for the retry delay or
  60 s, an invalid key until edit or re-test; rows survive restarts and fully spent pools fall through quietly.
- **Chain:** `gemini-3.8-flash` (5 RPM / 20 RPD) → `gemini-3.6-flash` (5 / 20) → `gemini-3.5-flash-lite`
  (15 / 500), each over the whole Gemini pool, then the owner's OpenRouter entries.
- **Routing:** short simple messages try the light tier first; attachments, quotes, long threads and full-model
  keywords use standard; a light tool call escalates next round. Every decision is a `routed` run event.
- **Check models:** capability fixtures run against one entry with stubbed tools on a reserved budget, recorded
  as `dashboard-test`. **Gemini may-train line (D12):** free keys may train on submitted input, paid keys are
  recorded no-training; both stay usable with warnings in logs, dashboard and doctor.
```

  2. In `PRIVACY.md`, add rows in the existing table style: key fingerprints (SHA-256 of the secret, used
  only for paste dedupe, never reversible to the key); project labels (owner-entered opaque labels grouping
  quota buckets); per-key per-model cooldown rows (key id, model, reset time, learned limits — no message
  text); `dashboard-test` ledger source for Check models (fixture ids only, no member content). No new
  retention beyond existing run/trace windows.

- [ ] **Step 4: Run it and watch it pass** — not applicable (documents).
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0 (docs only; proves nothing else broke)
- [ ] **Step 6: Format and lint** — `npx prettier --write docs/STATE.md PRIVACY.md`
  then `npx eslint docs/STATE.md PRIVACY.md` · exit 0
- [ ] **Step 7: Commit** —
  `git add docs/STATE.md PRIVACY.md && git commit -m "Slice 6 T17: STATE and PRIVACY entries"`

**Done when:** STATE.md names pools, cooldowns, chain, routing, check and the D12 may-train line; PRIVACY.md
covers fingerprints, labels, cooldowns and the `dashboard-test` source.

---



 (orchestrator only, after the last wave)
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
