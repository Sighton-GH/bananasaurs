# Assistant harness Slices 2–6: shared contracts

> **DRAFT — owner review.** Read by every slice plan and by the Instinct orchestrator. When a slice plan and this
> file disagree, this file wins; tell the controller (Claude) so the plan is corrected.

**Spec:** `docs/superpowers/specs/2026-10-09-assistant-harness-capability-design.md` (APPROVED; decisions D1–D17).
**Base:** `main` @ 0371edc3 (Slice 1 merged: ADRs 0136–0137, no migration).
**Handoff:** `docs/superpowers/plans/2026-10-10-harness-00-instinct-handoff.md`.

## 1. Rounds

| Round | Slices | Starts from | Plans |
|---|---|---|---|
| 1 | **6** key pools, cooldowns, Gemini chain, routing · **2** new abilities | `harness-slices-plan` tip | built and merged (`harness-round1`, migrations 0107–0108) |
| 2 | **3** streaming · **5** daily digest | `main` after round 1 merges (`harness-round2-plan` tip) | refreshed 2026-10-11, ready |
| 3 | **4** attachments | `main` after round 2 merges | refreshed by the controller first |

Slices in one round run at the same time on separate branches. Each produces its own bundle. The controller
merges them and resolves conflicts between them.

## 2. Numbers

**ADRs** (UI/UX overhaul holds 0140–0142):

| ADR | Slice | Title |
|---|---|---|
| 0143 | 6 | Key pools, persistent cooldowns, learned limits, Gemini default chain, free-project risk (D15), per-cost-class terms (D12), Check models (6f) |
| 0144 | 6 | Complexity routing (6e) |
| 0145 | 2 | Member names, find_member, reply pings, scheduled-message style (2a–2d) |
| 0146 | 2 | Assistant task tools (2e) |
| 0147 | 2 | Parallel web-search source (2g; hard rules 5 and 8) |
| 0148 | 3 | Streaming, idle timeout, finish reasons, live buffer, saved thinking (amends 0129 §6) |
| 0149 | 4 | Attachment fetch destination; images and PDFs to providers, native only |
| 0150 | 5 | Daily digest and automatic memory proposals |

**Migrations.** Never hand-number or hand-write one. Generate it with
`npm run db:generate -- --name <name>` after editing `packages/storage/src/schema.ts`; drizzle-kit takes the next
free number on your base. Read the generated SQL and check it does what the task says. Do **not** renumber it to
avoid another slice: the UI/UX overhaul and parallel slices will also take 0107+, and the controller renumbers
migrations when merging bundles. At most **one task per slice** touches `schema.ts` or `drizzle/`.

| Slice | Migration name | Contents |
|---|---|---|
| 6 | `key_pools_routing` | `assistant_model_chain.pool` + `.tier`; key `project` + `fingerprint`; `assistant_key_cooldowns` table |
| 2 | `parallel_search_source` | widen the `search_source` CHECK to include `parallel` |
| 5 | `daily_digests` | `assistant_daily_digests` table; run `source` CHECK gains `daily-digest`; memory-proposal source gains `daily-digest` if it has a CHECK |
| 3, 4 | none | — |

Round 1 shipped 0107 (`key_pools_routing`) and 0108 (`parallel_search_source`). On the round 2 base drizzle-kit gives Slice 5 0109.

## 3. Cross-slice types (names are fixed)

If a name below already exists in the code with a different meaning, the slice plan keeps the existing one, says so
in its header, and the controller updates this file.

**Slice 6 produces, Slices 3 and 4 consume:**

```ts
// packages/core/src/providers/model-capabilities.ts (new, Slice 6)
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
export const GEMINI_MODEL_TABLE: Readonly<Record<string, GeminiModelProfile>>;
/** Unknown Gemini model → text + tools only, thinking 'none'. */
export function geminiCapabilities(model: string): ModelCapabilities;
export const TEXT_AND_TOOLS_ONLY: ModelCapabilities;
```

```ts
// apps/daemon/src/assistant/model-capabilities.ts (new, Slice 6)
/** gemini → GEMINI table; openrouter → OpenRouter catalogue listing (image, file→pdf, tools, reasoning);
 *  nvidia-nim → TEXT_AND_TOOLS_ONLY. */
export function capabilitiesForEntry(
  entry: { readonly providerId: ProviderId; readonly model: string },
  catalogue: OpenRouterModelCatalogue,
): ModelCapabilities;
```

`ChainEntry` (`apps/daemon/src/assistant/model-chain.ts`) gains `readonly tier: ChainTier`,
`readonly pool: 'key' | 'provider'` (round 1). Round 1 did not add `capabilities`; Slice 3 adds `readonly capabilities?: ModelCapabilities` (optional, filled per request by the provider store).

**Slice 6 produces, Slice 5 consumes:**

```ts
// packages/core/src/assistant/router.ts (new, Slice 6)
export type ChainTier = 'standard' | 'light';
export interface RouterRules {
  readonly enabled: boolean;
  readonly maxChars: number;               // 80
  readonly fullModelKeywords: readonly string[];
  readonly greetingPatterns: readonly string[];
  readonly longThreadTurns: number;        // 4
  readonly escalateOnTool: boolean;        // true
}
export interface RouteInput {
  readonly text: string;                   // mentions already stripped
  readonly hasAttachments: boolean;
  readonly hasQuoteOrReply: boolean;
  readonly earlierTurns: number;
}
export function routeRun(input: RouteInput, rules: RouterRules): { tier: ChainTier; reason: string };
/** Light run: light entries first, then standard in order. Standard run: standard in order, then light. */
export function orderChainByTier<T extends { readonly tier: ChainTier }>(entries: readonly T[], tier: ChainTier): T[];
```

**ProviderError** (`packages/core/src/providers/errors.ts`), Slice 6 widens; Slice 3 must keep every field when it
rewrites the adapters for streaming:

```ts
public readonly quotaScope?: 'daily-free' | 'day' | 'minute';
/** From Retry-After or google.rpc.RetryInfo.retryDelay. */
public readonly retryAfterMs?: number;
/** quotaValue from a Gemini QuotaFailure violation. */
public readonly learnedLimit?: { readonly perDay?: number; readonly perMinute?: number };
```

**Slice 3 produces, Slice 4 consumes:** streaming adapters with the existing `generateText` signature;
`GenerateTextRequest` gains `thinkingLevel?: 'low' | 'medium' | 'high'` and
`onProgress?: (progress: StreamProgress) => void`; `GenerateTextResponse` gains `reasoning?: string`.

**Slice 4 produces:** `GenerationMessage.media?: readonly GenerationMedia[]` with
`GenerationMedia { kind: 'image' | 'pdf'; mediaType: string; dataBase64: string; name: string }`.

**Run ledger** (`packages/core/src/assistant/run-events.ts` and the storage CHECK):
- Slice 6 adds event `routed { tier, reason }` and records `model-skipped` with a cooldown reason.
- Slice 3 adds event `model-progress { round, answerChars, reasoningChars, keepalives, msSinceLastByte }`.
- Slice 5 adds run source `daily-digest`.

**Instance settings** (registry in `packages/core/src/settings/instance-settings.ts`, ADR 0080). Follow the file's
existing key style. Prefixes per slice: Slice 6 `assistant.router…` and key-pool settings; Slice 3
`assistant.provider…` and `assistant.thinking…`; Slice 4 `assistant.attachments…`; Slice 5 `assistant.digest…`;
Slice 2 ping caps. Every setting is visible and editable on the dashboard with a test (spec §4.7, D17).

**Skills** (`packages/core/src/assistant/skills.ts`): Slice 2 adds `ping` and `tasks`.
**Tool groups** (`TOOL_GROUPS` in `tool-catalogue.ts`): Slice 2 adds the tools to fitting groups (`tasks` is a new
group); every new tool sets `group`, `rounds` and, if it acts, `writes: true` and `requiresSkill` (ADR 0136/0137).

## 4. Files more than one slice edits

These conflict between parallel slices. Edit them **additively**: append to the end of a list, object or union;
never reorder, reformat or rename what is there; keep each edit small.

`packages/storage/src/schema.ts` · `drizzle/**` · `packages/core/src/settings/instance-settings.ts` ·
`packages/core/src/assistant/run-events.ts` · `packages/core/src/providers/errors.ts` ·
`packages/core/src/providers/contracts.ts` · `apps/daemon/src/assistant/service.ts` ·
`apps/daemon/src/assistant/tool-loop.ts` · `apps/daemon/src/assistant/tools.ts` ·
`packages/core/src/assistant/tool-catalogue.ts` · `apps/daemon/src/runtime/daemon.ts` · doctor ·
provider-eligibility records · `docs/PRIVACY.md` · `docs/STATE.md`.

**Dashboard pages are being restyled by the UI/UX overhaul** (P3–P5, running now). Put new dashboard UI in **new
component files** and change an existing page only to mount the component and pass its props. The controller merges
both.

## 5. Rules every task follows

Copied into every slice plan's Global Constraints.

- `CLAUDE.md` hard rules 1–9 apply. In particular: AI is never in the enforcement path; every query, key and job
  carries a guild id; model output passes Zod; every Discord side effect has a durable idempotency key; no secrets
  in code, logs or fixtures; no new outbound destination unless the slice's ADR records the owner's instruction.
- No new dependency.
- Fixtures use invented names (Sam L, Alex P, Car Team A). Never a real member's name or id.
- Canadian English, plain words in prompts and dashboard copy. No tool names shown to members.
- Write the failing test first for anything touching permissions, pings, idempotency, retention or guild scope, and
  watch it fail before writing the code.
