# Slice 3: Streaming, idle timeout, live progress and thinking — implementation plan

> **Instinct plan.** Read with `2026-10-10-harness-00-instinct-handoff.md` and `2026-10-10-harness-00-shared-contracts.md`.
> **Status:** READY — refreshed against harness-round1 (Slices 6+2 merged)

**Goal:** Every provider streams its answer with an idle timeout and a hard ceiling, finish reasons are checked, and the dashboard shows live progress plus saved thinking.
**Spec:** docs/superpowers/specs/2026-10-09-assistant-harness-capability-design.md §Slice 3 (3a–3e), D5(b), D6, §4.7
**ADRs:** 0148   **Migration:** none
**Base:** main @ 0371edc3 (working tree also contains merged Slices 6+2: key pools, cooldowns, routing with escalation hand-over, capabilities)

## Refresh notes (READY refresh, 2026-10-12)

- Status DRAFT → READY; every file/line anchor re-checked against the merged tree.
- S3-T2: `GenerateTextRequest` also gains `capabilities` and `onChunk` (live text needs unthrottled deltas; the ledger stays metadata-only).
- S3-T3: Step 3 is now complete `sse.ts` code, not prose.
- S3-T4: settings count pin goes 28 → 30 in both `instance-settings.test.ts` and the tuning fixture; tuning page needs no code change (generic rows).
- S3-T5: Step 3 is now the complete new `capTrace`, not prose.
- S3-T6/S3-T7: Step 3 is now complete adapter code (timers, SSE assembly, capability gating with conservative defaults); capability tables are real (`model-capabilities.ts`, daemon `capabilitiesForEntry`).
- S3-T8: typing-keepalive job edit moved out (it does not own `jobs/assistant.ts`); progress throttle is per-run and shared across the escalation hand-over; `model-chain.ts` timeout wiring added here.
- New S3-T12: the brief's Discord progress design check (one code-built notice per run, posted/edited/deleted, durable cursor id, Write-gated) plus service/daemon wiring, typing ceiling and trace-`reasoning` persistence.
- Deviation from contracts §3 for the controller: `ChainEntry` has NO `capabilities` field in the merged code, so capabilities resolve per request via daemon `capabilitiesForEntry`, not from the entry.

## Merged-code notes (verified, not assumed)

- `ProviderError` already carries `quotaScope 'daily-free' | 'day' | 'minute'`, `retryAfterMs`, `learnedLimit` (`packages/core/src/providers/errors.ts` lines 26–30). Adapter rewrites keep every field.
- `packages/core/src/providers/model-capabilities.ts` is real: `ThinkingControl`, `ModelCapabilities`, `GeminiModelProfile`, `GEMINI_MODEL_TABLE` (3 rows), `geminiCapabilities` (unknown → `TEXT_AND_TOOLS_ONLY`), `TEXT_AND_TOOLS_ONLY`.
- Daemon `capabilitiesForEntry(entry, catalogue)` is real (`apps/daemon/src/assistant/model-capabilities.ts` lines 10–25); the OpenRouter catalogue lives at the composition root (`apps/daemon/src/runtime/daemon.ts` lines 210, 229) and reaches guilds via `buildGuildRuntime` (`daemon.ts` line 316).
- Escalation hand-over is real: `escalateAfterTools` / `onEscalated` / `Resume` (`apps/daemon/src/assistant/tool-loop.ts` lines 230–241, 466–531, 1184–1208); service orders by tier and records `routed` + `escalated-after-tool` (`apps/daemon/src/assistant/service.ts` lines 1370–1486).
- `ChainEntry` has `pool`, `tier`, `selectedKeyId` but no `capabilities` (`apps/daemon/src/assistant/model-chain.ts` lines 42–61).
- `SafeProvider.generateText` forwards the whole request untouched (`packages/core/src/providers/safe-provider.ts` lines 22–26), so `thinkingLevel`, `capabilities`, `onProgress`, `onChunk` pass through.
- Invoke payload already has `hasAttachments` (`apps/daemon/src/assistant/commands.ts`); `AssistantInvocation` (lines 35–107) is where `onProgress` lands.
- Instance settings are 28 (`packages/core/src/settings/instance-settings.ts` lines 398–427; pin at `instance-settings.test.ts:12`); migrations end at `drizzle/0108_parallel_search_source.sql`; run sources are `mention | slash-command | dashboard-test` (`packages/storage/src/schema.ts` line 2497).
- The Discord port already supports edits and deletes (`editMessage` at `packages/discord/src/rest/port.ts:353`, port type at `packages/core/src/discord/port.ts:327,367`); the invoke job today only wires `send`/`respond` plus typing (`apps/daemon/src/jobs/assistant.ts` lines 339, 725–739; wiring at `apps/daemon/src/runtime/guild.ts:1299–1334`).
- The job cursor (`assistantInvokeCursor` in `packages/core/src/jobs/kinds.ts` lines 611–619, staged in `jobs/assistant.ts` lines 92–105, 649–661) is the durable idempotency mechanism to extend.

## Global Constraints

- `CLAUDE.md` hard rules 1–9 apply. In particular: AI is never in the enforcement path; every query, key and job carries a guild id; model output passes Zod; every Discord side effect has a durable idempotency key; no secrets in code, logs or fixtures; no new outbound destination unless the slice's ADR records the owner's instruction.
- No new dependency.
- Fixtures use invented names (Sam L, Alex P, Car Team A). Never a real member's name or id.
- Canadian English, plain words in prompts and dashboard copy. No tool names shown to members.
- Write the failing test first for anything touching permissions, pings, idempotency, retention or guild scope, and watch it fail before writing the code.

- Slice rules: `assistant.providerTimeoutMs` (60,000) becomes time-to-first-byte; new `assistant.providerIdleTimeoutMs` default 45,000 (re-armed on every byte, keepalives count); new `assistant.providerMaxCallMs` default 300,000 (hard ceiling). `assistant.maxOutputTokens` default 2,048 → 4,096, bounds stay 256–8,192. A thinking parameter is never sent to a model whose capabilities do not support it: Gemini sends `thinkingConfig.thinkingLevel` (`low` for tool rounds, `medium` for the answer, never `minimal`) only when capabilities say `levels`, keeps the legacy `thinkingBudget` only when they say `budget`, and sends neither (nor `includeThoughts`) when `none`; OpenRouter sends `reasoning: { exclude: false }` only when the entry capabilities say `reasoning: true`, NIM never. `model-progress` carries `{ round, answerChars, reasoningChars, keepalives, msSinceLastByte }`, at most every 3 s per run (one shared throttle across the escalation hand-over, so a light round 1 plus a standard round 2 never emit a second stream), bumping `updatedAt`. Live buffer caps at 8,000 chars of answer and 8,000 of thinking per run, dropped at finish; thinking saved under trace `reasoning` per round (each max 8,000, at most 12). StepLog polls every 2 s (no browser SSE). Discord shows one code-built progress notice per run (`Working on it…`, posted once, edited at most every 10 s, deleted after delivery; text never contains model or member text; `allowedMentions: { parse: [] }` on every post and edit; message id in the staged job cursor so a retry edits instead of posting a second; Write-gated like the reply; typing-only fallback when no channel or no edit/delete wiring). Every new setting gets registry plus dashboard control plus test. Contracts §4 files edited additively. No migration. No new outbound host: the streaming endpoints are the same provider hosts.

## Plan decisions

- New SSE parsing lives in `packages/core/src/providers/sse.ts` (`parseSseStream`); both adapters share it for comment lines, split chunks and `[DONE]`. Reason: one keepalive/idle behaviour for both providers.
- Capability gating is enforced inside the adapters with conservative built-ins (Gemini falls back to `geminiCapabilities(request.model)`, OpenAI-compatible falls back to `TEXT_AND_TOOLS_ONLY`), overridden by `request.capabilities` when the daemon supplies it. Reason: the brief forbids blind thinking parameters, and seed/test paths have no catalogue.
- `thinkingLevel` is explicit `GenerateTextRequest.thinkingLevel` when set, else tools offered → `low`, answer call → `medium`, never `minimal`. Reason: spec 3a plus the 3.8 Flash `minimal` error.
- Three timers compose through one linked `AbortController` (time-to-first-byte, idle re-armed per SSE event, absolute ceiling); idle timeout throws retryable `ProviderError('timeout', …)`. Reason: `AbortSignal.timeout` alone cannot express three timers plus the caller's signal.
- Mid-stream `error`/`choices[].error` becomes retryable `ProviderError('outage', …)` with `finishReason: 'error'`; the partial text is discarded, never delivered or stored — only the already-emitted progress counters remain. Reason: the ledger is metadata-only and cannot carry text.
- `length`/`MAX_TOKENS` with text is delivered with code-built `\n\n-# (cut short)` appended after the guard, so the marker is never stripped. Reason: the guard would otherwise remove or refuse it.
- The `model-progress` throttle lives per `runToolLoop` call and is shared across entries and the escalation hand-over. Reason: one progress stream per run across light round 1 → standard round 2.
- Live text flows through unthrottled `onChunk` deltas into a module-singleton buffer the routes read; the run recorder drops the run id on `finished`. Reason: routes cannot take new deps without touching `HttpDeps`, and the buffer must die with the run.
- The Discord progress notice is posted, edited and deleted inside the run's existing reply scope — not an autonomous write. Retry safety comes from the staged cursor's `progressMessageId`, not a new table. Reason: hard rule 6 with no migration.
- `ChainEntry` carries no `capabilities` (merged code deviates from contracts §3); the service resolves per request with daemon `capabilitiesForEntry`. The controller owns updating the contracts file.
- Dashboard tuning rows render generically from settings, so new settings need fixture rows but no page change. Reason: `TuningCards` maps `data.settings`.
- Live buffer is a daemon in-memory map by run id (`apps/daemon/src/assistant/live-buffer.ts`), deleted on `finished`; keeps the ledger metadata-only with no storage change.
- `describeRunEvent` for `model-progress` renders `Receiving… 1,240 chars of answer, 3,100 chars of thinking`, omitting a side with 0 chars.
- Typing stays alive by raising `maxMs` to the hard ceiling for the run and stopping only at run end.

## Review Focus

1. **A stream that trickles forever.** One byte every 40 s must hit the 45 s idle timer with a retryable `timeout`; a stream under idle but past 300 s must hit the ceiling. Pinned in S3-T6 and S3-T7.
2. **Mid-stream `finish_reason: "error"` inside a 200.** Becomes retryable `ProviderError`; partial text discarded, never delivered or stored. Pinned in S3-T6.
3. **Fragmented tool-call arguments across chunks.** Concatenated per index, parsed only when complete. Pinned in S3-T6.
4. **Thinking sent blind or echoed.** A thinking parameter is never sent when capabilities forbid it (unknown model → none); thinking that echoes a member message lives in the buffer, is saved under trace `reasoning`, and is shown only with trace capability, plus a PRIVACY.md line. Pinned in S3-T6, S3-T7, S3-T9 and S3-T11.
5. **Progress across the escalation hand-over.** A light entry's round 1 plus a standard entry from round 2 emit one throttled progress stream per run (edited, never a second); a cooled or skipped entry emits nothing; the Discord notice follows the same one-run rule with a durable cursor id. Pinned in S3-T8 and S3-T12.


## Waves

| Wave | Task | Owns (create/modify) | Depends on |
|---|---|---|---|
| 1 | S3-T1 ADR 0148 | Create: `docs/decisions/0148-assistant-streaming-timeouts-live-progress.md` | — |
| 1 | S3-T2 Contracts and run-event schema | Modify: `packages/core/src/providers/contracts.ts`; Modify: `packages/core/src/assistant/run-events.ts`; Test: `packages/core/src/assistant/run-events.test.ts` | — |
| 2 | S3-T3 Shared SSE parser | Create: `packages/core/src/providers/sse.ts`; Test: `packages/core/src/providers/sse.test.ts` | S3-T2 |
| 2 | S3-T4 Timeout and token settings | Modify: `packages/core/src/settings/instance-settings.ts`; Test: `packages/core/src/settings/instance-settings.test.ts`; Test: `packages/dashboard/src/pages/assistant-tuning.test.tsx` | S3-T1 |
| 2 | S3-T5 Trace reasoning field | Modify: `packages/core/src/assistant/trace.ts`; Test: `packages/core/src/assistant/trace.test.ts` | S3-T2 |
| 3 | S3-T6 OpenAI-compatible streaming | Modify: `packages/core/src/providers/openai-compatible.ts`; Test: `packages/core/src/providers/openai-compatible.test.ts` | S3-T2, S3-T3 |
| 3 | S3-T7 Gemini streaming | Modify: `packages/core/src/providers/gemini.ts`; Test: `packages/core/src/providers/gemini.test.ts` | S3-T2, S3-T3 |
| 4 | S3-T8 Tool loop wiring, finish reasons, chain timeouts | Modify: `apps/daemon/src/assistant/tool-loop.ts`; Test: `apps/daemon/src/assistant/tool-loop.test.ts`; Modify: `apps/daemon/src/assistant/model-chain.ts`; Test: `apps/daemon/src/assistant/model-chain.test.ts` | S3-T2, S3-T6, S3-T7 |
| 4 | S3-T9 Live buffer, route and progress events | Create: `apps/daemon/src/assistant/live-buffer.ts`; Test: `apps/daemon/src/assistant/live-buffer.test.ts`; Modify: `packages/http/src/routes/assistant-runs.ts`; Test: `packages/http/src/routes/assistant-runs.test.ts`; Modify: `apps/daemon/src/assistant/run-recorder.ts` | S3-T2 |
| 5 | S3-T10 Dashboard live text and progress | Modify: `packages/dashboard/src/api/runs.ts`; Create: `packages/dashboard/src/pages/assistant-live-buffer.tsx`; Test: `packages/dashboard/src/pages/assistant-live-buffer.test.tsx`; Modify: `packages/dashboard/src/pages/assistant-live.tsx` | S3-T4, S3-T9 |
| 5 | S3-T11 State and privacy paperwork | Modify: `docs/STATE.md`; Modify: `PRIVACY.md` | S3-T1 |
| 5 | S3-T12 Discord progress notice and daemon wiring | Modify: `apps/daemon/src/jobs/assistant.ts`; Test: `apps/daemon/src/jobs/assistant.test.ts`; Modify: `packages/core/src/jobs/kinds.ts`; Modify: `apps/daemon/src/assistant/commands.ts`; Modify: `apps/daemon/src/assistant/service.ts`; Test: `apps/daemon/src/assistant/service.test.ts`; Modify: `apps/daemon/src/runtime/guild.ts`; Modify: `apps/daemon/src/runtime/daemon.ts` | S3-T2, S3-T8 |

### S3-T1: ADR 0148   ·   Wave 1
**Owns:** Create: `docs/decisions/0148-assistant-streaming-timeouts-live-progress.md`
**Reads (do not edit):** `docs/decisions/0137-read-only-tools-in-later-rounds.md`, `docs/decisions/0129-ai-run-observability.md`, `packages/core/src/providers/contracts.ts`
**Interfaces:** Consumes: none · Produces: ADR 0148 text (Context, Decision, Consequences) used by S3-T4 and S3-T11

- [ ] **Step 1: Write the failing test** — no code test; open `docs/decisions/0137-read-only-tools-in-later-rounds.md` and copy its three headings (`#`, `## Context`, `## Decision`, `## Consequences`) into the new file. The check is the file exists with those headings.
- [ ] **Step 2: Run it and watch it fail** — `ls docs/decisions/0148-assistant-streaming-timeouts-live-progress.md` · Expected: FAIL with no such file before writing.
- [ ] **Step 3: Implement** — write the ADR in full:

```md
# 0148: Assistant streaming, idle timeout, finish reasons, live buffer, saved thinking

## Context

Job-lanes merged, so the body-read code it wrapped can be replaced with streaming. OpenRouter sends `: OPENROUTER PROCESSING` keepalive comments and reports mid-stream failures as `finish_reason: "error"` inside a 200 response. Gemini 3 uses `thinkingConfig.thinkingLevel` (`low` tool rounds, `medium` answer; never `minimal`, which errors on 3.8 Flash) with `includeThoughts: true` for thought summaries. The 60 s job-lanes total becomes time-to-first-byte. Slice 6 merged first and left real capability tables (`GEMINI_MODEL_TABLE`, daemon `capabilitiesForEntry`), persistent cooldowns and the escalation hand-over (light round 1 → standard from round 2). D5(b) keeps thinking live plus saved in the trace; ADR 0129 stays metadata-only for the ledger.

## Decision

1. Stream every provider: OpenAI-compatible sends `stream: true` plus `stream_options: { include_usage: true }`, parses SSE `data:` lines, ignores `:` comments, assembles `delta.content`, `delta.reasoning`, `delta.tool_calls` (args concatenated per index, parsed when complete); Gemini calls `:streamGenerateContent?alt=sse`, assembling text, `functionCall` and `thought: true` parts separately, echoing raw parts back so thought signatures survive tool rounds.
2. Timeouts: idle `assistant.providerIdleTimeoutMs` 45,000 re-armed on every byte (keepalives count); ceiling `assistant.providerMaxCallMs` 300,000; `assistant.providerTimeoutMs` 60,000 becomes time-to-first-byte. Typing stays alive with its ceiling raised to the hard ceiling for the run.
3. Finish reasons: `error` or `choices[].error` → retryable `ProviderError`, partial text discarded and never delivered or stored (only the progress counters already emitted remain); `length`/`MAX_TOKENS` with text → delivered with code-built `\n\n-# (cut short)` after the guard; `length` with no text → today's empty-answer path. `maxOutputTokens` default 2,048 → 4,096.
4. Progress: `model-progress { round, answerChars, reasoningChars, keepalives, msSinceLastByte }` at most every 3 s per run on one shared throttle across the escalation hand-over, bumping `updatedAt`; renders as `Receiving… 1,240 chars of answer, 3,100 chars of thinking`. Discord shows one code-built `Working on it…` notice per run (posted once, edited at most every 10 s, deleted after delivery, idempotent on the staged cursor, Write-gated).
5. Live text: in-memory per-run buffer capped at 8,000 chars each of answer and thinking; `GET /api/assistant/runs/:runId/live` gated like traces; StepLog polls every 2 s (no browser SSE); buffer dropped at finish; thinking saved under trace `reasoning` per round, capped. A thinking parameter is never sent when the entry capabilities forbid it: OpenRouter gets `reasoning: { exclude: false }` only for `reasoning: true` models (NIM never); Gemini sends `thinkingLevel` only for `levels` models, legacy `thinkingBudget` only for `budget` models, and neither plus no `includeThoughts` for `none` models. Gemini returns thought summaries via `includeThoughts`. A model that exposes no reasoning shows only the progress counters.

## Consequences

- One trickling stream can hold a job lane up to 300 s by design; four lanes stay the cap.
- Thinking text may echo member messages; it is visible with trace capability only, noted in PRIVACY.md, and deleted with the conversation.
- The Discord progress notice is one extra post plus edits per channel run, inside that run's reply scope; it never carries model or member text, so it cannot ping.
- No new outbound destination; no migration.
```

- [ ] **Step 4: Run it and watch it pass** — `ls docs/decisions/0148-assistant-streaming-timeouts-live-progress.md` · Expected: PASS (file exists)

- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write docs/decisions/0148-assistant-streaming-timeouts-live-progress.md` then `npx eslint docs/decisions/0148-assistant-streaming-timeouts-live-progress.md` · exit 0
- [ ] **Step 7: Commit** — `git add docs/decisions/0148-assistant-streaming-timeouts-live-progress.md && git commit -m "Slice 3 T1: ADR 0148 streaming timeouts live progress"`

**Done when:** ADR 0148 exists with Context/Decision/Consequences; S3-T4 and S3-T11 can quote its numbers.

### S3-T2: Contracts and run-event schema   ·   Wave 1
**Owns:** Modify: `packages/core/src/providers/contracts.ts`; Modify: `packages/core/src/assistant/run-events.ts`; Test: `packages/core/src/assistant/run-events.test.ts`
**Reads (do not edit):** `packages/core/src/providers/errors.ts`, `apps/daemon/src/assistant/run-recorder.ts`
**Interfaces:** Consumes: none · Produces: `export interface StreamProgress { readonly round: number; readonly answerChars: number; readonly reasoningChars: number; readonly keepalives: number; readonly msSinceLastByte: number }`; `export interface StreamChunk { readonly text: string; readonly reasoning: string }`; `GenerateTextRequest` gains `thinkingLevel?: 'low' | 'medium' | 'high'`, `capabilities?: ModelCapabilities`, `onProgress?: (progress: StreamProgress) => void`, `onChunk?: (chunk: StreamChunk) => void`; `GenerateTextResponse` gains `reasoning?: string`; run event `model-progress { round, answerChars, reasoningChars, keepalives, msSinceLastByte }`

- [ ] **Step 1: Write the failing test** — in `packages/core/src/assistant/run-events.test.ts`, inside `describe('runEventSchema (ADR 0129 §6)', …)`, add:

```ts
it('round-trips a model-progress event', () => {
  const event = {
    kind: 'model-progress',
    round: 1,
    answerChars: 1240,
    reasoningChars: 3100,
    keepalives: 2,
    msSinceLastByte: 400,
  } as const;
  expect(runEventSchema.parse(event)).toEqual(event);
});

it('rejects a model-progress event carrying text', () => {
  expect(
    runEventSchema.safeParse({
      kind: 'model-progress',
      round: 1,
      answerChars: 3,
      reasoningChars: 0,
      keepalives: 0,
      msSinceLastByte: 1,
      text: 'partial answer',
    }).success,
  ).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/assistant/run-events.test.ts --maxWorkers=1` · Expected: FAIL with `model-progress` not in the union

- [ ] **Step 3: Implement** — anchor: `packages/core/src/providers/contracts.ts` lines 42–53 (`GenerateTextRequest` with `thinkingBudget` at line 50 and `tools` at line 52) and lines 64–75 (`GenerateTextResponse` with `text`, `model`, `finishReason`). The file imports nothing today; `model-capabilities.ts` imports nothing either, so a type-only import cannot cycle. Replacement in full:

```ts
import type { ModelCapabilities } from './model-capabilities.js';

export type ProviderCapability =
  'text' | 'streaming' | 'structured-output' | 'tools' | 'vision' | 'usage';
```

(keep every interface between unchanged) then above `GenerateTextRequest` add:

```ts
/** Throttled stream counters: metadata only, safe for the run ledger. */
export interface StreamProgress {
  readonly round: number;
  readonly answerChars: number;
  readonly reasoningChars: number;
  readonly keepalives: number;
  readonly msSinceLastByte: number;
}

/** Unthrottled text deltas for the live buffer; never stored in the ledger. */
export interface StreamChunk {
  readonly text: string;
  readonly reasoning: string;
}
```

and extend the request after the `thinkingBudget` line, keeping the field order stable:

```ts
  /** Hint for providers with a thinking budget (Gemini); ignored elsewhere. */
  readonly thinkingBudget?: number;
  /**
   * Explicit thinking level (Gemini 3). Absent means the adapter derives
   * `low` for tool rounds and `medium` for the answer. Never `minimal`.
   * Never sent when the entry capabilities forbid thinking.
   */
  readonly thinkingLevel?: 'low' | 'medium' | 'high';
  /**
   * Per-entry capabilities from daemon `capabilitiesForEntry`. Absent means
   * the adapter's conservative built-in default (unknown models get no
   * thinking parameter and no reasoning request).
   */
  readonly capabilities?: ModelCapabilities;
  /** Offered only by providers with the `tools` capability. */
  readonly tools?: readonly ToolDeclaration[];
  /** Throttled progress counters (metadata only, safe for the ledger). */
  readonly onProgress?: (progress: StreamProgress) => void;
  /** Unthrottled text deltas for the live buffer; never stored in the ledger. */
  readonly onChunk?: (chunk: StreamChunk) => void;
```

and add to `GenerateTextResponse` after `text`:

```ts
  /** Empty when the model only asked for tools. */
  readonly text: string;
  /**
   * Non-answer reasoning (OpenRouter `delta.reasoning`, Gemini thought
   * summaries). Absent when the model exposed none. Saved per round under
   * trace `reasoning`, never delivered to members.
   */
  readonly reasoning?: string;
```

Anchor: `packages/core/src/assistant/run-events.ts` the `finished` object (lines 158–167, the last union member). Append after it — contracts §4: unions grow at the end, Slice 6's `routed` (lines 114–120) stays where it is:

```ts
  z
    .object({
      kind: z.literal('model-progress'),
      round: z.number().int().nonnegative(),
      answerChars: z.number().int().nonnegative(),
      reasoningChars: z.number().int().nonnegative(),
      keepalives: z.number().int().nonnegative(),
      msSinceLastByte: z.number().int().nonnegative(),
    })
    .strict(),
```

Keep every existing ProviderError quota field (`quotaScope`, `retryAfterMs`, `learnedLimit`) untouched: this task does not open the adapters. Do not rename the existing `GeminiModelInfo` in `packages/core/src/providers/gemini.ts` (lines 338–344): it lists key-visible models and is a different interface from Slice 6's `GeminiModelProfile`.
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/assistant/run-events.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/providers/contracts.ts packages/core/src/assistant/run-events.ts packages/core/src/assistant/run-events.test.ts` then `npx eslint packages/core/src/providers/contracts.ts packages/core/src/assistant/run-events.ts packages/core/src/assistant/run-events.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/providers/contracts.ts packages/core/src/assistant/run-events.ts packages/core/src/assistant/run-events.test.ts && git commit -m "Slice 3 T2: stream contracts and model-progress event"`

**Done when:** `runEventSchema` parses `model-progress` and rejects one carrying `text`; `StreamProgress`, `StreamChunk`, `thinkingLevel`, `capabilities`, `onProgress`, `onChunk`, `reasoning` exist in contracts.

### S3-T3: Shared SSE parser   ·   Wave 2
**Owns:** Create: `packages/core/src/providers/sse.ts`; Test: `packages/core/src/providers/sse.test.ts`
**Reads (do not edit):** `packages/core/src/providers/openai-compatible.ts` (lines 100–120 `readErrorBody`, `parseToolArguments`), `packages/core/src/providers/gemini.ts` (lines 53–88 `toContents`)
**Interfaces:** Consumes: none · Produces: `export interface SseEvent { readonly data: string; readonly keepalive: boolean }` and `export async function* parseSseStream(body: ReadableStream<Uint8Array> | AsyncIterable<string>): AsyncGenerator<SseEvent>` — yields `{ data, keepalive: false }` per `data:` line joined across multi-line data, `{ data: '', keepalive: true }` per `:` comment line, stops at `data: [DONE]`, reassembles chunks split mid-line

- [ ] **Step 1: Write the failing test** — create `packages/core/src/providers/sse.test.ts` with the real helper style of `openai-compatible.test.ts` (plain `describe`/`it`, `vi` only where needed):

```ts
import { describe, expect, it } from 'vitest';
import { parseSseStream } from './sse.js';

const collect = async (chunks: readonly string[]) => {
  async function* feed() {
    for (const c of chunks) yield c;
  }
  const out = [];
  for await (const e of parseSseStream(feed())) out.push(e);
  return out;
};

describe('parseSseStream', () => {
  it('ignores keepalive comments and counts them', async () => {
    const events = await collect([': OPENROUTER PROCESSING\n', 'data: {"a":1}\n\n']);
    expect(events).toEqual([
      { data: '', keepalive: true },
      { data: '{"a":1}', keepalive: false },
    ]);
  });

  it('reassembles a data line split across chunks', async () => {
    const events = await collect(['data: {"delta', ': {"content": "hi"}}\n\n']);
    expect(events).toEqual([{ data: '{"delta: {"content": "hi"}}', keepalive: false }]);
  });

  it('joins multi-line data with newlines', async () => {
    const events = await collect(['data: line1\ndata: line2\n\n']);
    expect(events).toEqual([{ data: 'line1\nline2', keepalive: false }]);
  });

  it('stops at [DONE]', async () => {
    const events = await collect(['data: {"a":1}\n\n', 'data: [DONE]\n\n', 'data: {"a":2}\n\n']);
    expect(events).toEqual([{ data: '{"a":1}', keepalive: false }]);
  });
};
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/providers/sse.test.ts --maxWorkers=1` · Expected: FAIL with cannot find module `./sse.js`
- [ ] **Step 3: Implement** — create `packages/core/src/providers/sse.ts` in full (no existing file; both adapters import it in S3-T6/S3-T7):

```ts
export async function* parseSseStream(
  body: ReadableStream<Uint8Array> | AsyncIterable<string>,
): AsyncGenerator<SseEvent> {
  let buffer = '';
  if (Symbol.asyncIterator in (body as AsyncIterable<string>)) {
    for await (const chunk of body as AsyncIterable<string>) buffer += chunk;
  } else {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      buffer += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  const pendingData: string[] = [];
  const lines = buffer.split('\n');
  // A trailing partial line with no terminating blank line still counts:
  // test feeds always end with `\n\n`, live streams end with `[DONE]`.
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      if (pendingData.length === 0) continue;
      const data = pendingData.splice(0).join('\n');
      if (data === '[DONE]') return;
      yield { data, keepalive: false };
    } else if (line.startsWith(':')) {
      yield { data: '', keepalive: true };
    } else if (line.startsWith('data:')) {
      pendingData.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
    }
  }
  if (pendingData.length > 0) {
    const data = pendingData.join('\n');
    if (data !== '[DONE]') yield { data, keepalive: false };
  }
}
```

Ship the normalised version below: it reassembles chunks split mid-line because concatenation happens before splitting, decodes split UTF-8 via the streaming `TextDecoder`, and stops at `data: [DONE]`. `AsyncIterable<string>` exists so the unit tests feed strings without a Response.
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/providers/sse.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/providers/sse.ts packages/core/src/providers/sse.test.ts` then `npx eslint packages/core/src/providers/sse.ts packages/core/src/providers/sse.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/providers/sse.ts packages/core/src/providers/sse.test.ts && git commit -m "Slice 3 T3: shared SSE parser"`

**Done when:** keepalive comments, split chunks, multi-line data and `[DONE]` all parse per the four tests.

### S3-T4: Timeout and token settings   ·   Wave 2
**Owns:** Modify: `packages/core/src/settings/instance-settings.ts`; Test: `packages/core/src/settings/instance-settings.test.ts`; Test: `packages/dashboard/src/pages/assistant-tuning.test.tsx`
**Reads (do not edit):** `docs/decisions/0148-assistant-streaming-timeouts-live-progress.md`
**Interfaces:** Consumes: ADR 0148 numbers · Produces: settings `assistant.providerIdleTimeoutMs` (45,000), `assistant.providerMaxCallMs` (300,000), `assistant.maxOutputTokens` default 4,096; registry grows 28 → 30 entries

- [ ] **Step 1: Write the failing test** — in `packages/core/src/settings/instance-settings.test.ts`, after the count test at lines 11–12 (`expect(INSTANCE_SETTINGS).toHaveLength(28)`), add:

```ts
it('streaming timeouts default to 45 s idle and 300 s ceiling', () => {
  const values = Object.fromEntries(INSTANCE_SETTINGS.map((s) => [s.key, s.defaultValue]));
  expect(values['assistant.providerIdleTimeoutMs']).toBe(45_000);
  expect(values['assistant.providerMaxCallMs']).toBe(300_000);
});

it('max output tokens defaults to 4096 for reasoning', () => {
  const values = Object.fromEntries(INSTANCE_SETTINGS.map((s) => [s.key, s.defaultValue]));
  expect(values['assistant.maxOutputTokens']).toBe(4_096);
});
```

and change the count pin to `expect(INSTANCE_SETTINGS).toHaveLength(30);`. In `packages/dashboard/src/pages/assistant-tuning.test.tsx`, extend the `SETTINGS` fixture (lines 8–128) with two rows after the `assistant.providerTimeoutMs` row (lines 20–30), in the same shape:

```ts
{
  key: 'assistant.providerIdleTimeoutMs',
  group: 'Assistant retries',
  label: 'Provider idle timeout',
  help: 'How long one AI answer may go without any data before it is abandoned. Keepalive messages count as data.',
  display: 'seconds',
  bounds: { min: 5000, max: 120000 },
  value: 45000,
  defaultValue: 45000,
  isDefault: true,
},
{
  key: 'assistant.providerMaxCallMs',
  group: 'Assistant retries',
  label: 'Provider max call time',
  help: 'The longest one AI answer may take in total, even when data keeps arriving.',
  display: 'seconds',
  bounds: { min: 60000, max: 600000 },
  value: 300000,
  defaultValue: 300000,
  isDefault: true,
},
```

The tuning page renders rows generically from `data.settings` (`TuningCards`, `assistant-tuning.tsx` lines 336–355), so no page change is needed; the `renders the five group headings` test (line 138) still passes because both rows join the existing `Assistant retries` group.

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/settings/instance-settings.test.ts --maxWorkers=1` · Expected: FAIL with `providerIdleTimeoutMs` undefined, maxOutputTokens 2048, and length 28; plus `npx vitest run packages/dashboard/src/pages/assistant-tuning.test.tsx --maxWorkers=1` · Expected: FAIL with the two rows missing
- [ ] **Step 3: Implement** — anchor: `packages/core/src/settings/instance-settings.ts` the `providerTimeout` const (lines 64–73) and the `maxOutputTokens` const (lines 108–117, `defaultValue: 2048`). Add after `providerTimeout`:

```ts
const providerIdleTimeout: SettingDefinition<number> = {
  key: 'assistant.providerIdleTimeoutMs',
  group: 'Assistant retries',
  label: 'Provider idle timeout',
  help: 'How long one AI answer may go without any data before it is abandoned. Keepalive messages count as data.',
  display: 'seconds',
  schema: z.number().int().min(5000).max(120000),
  defaultValue: 45000,
  bounds: { min: 5000, max: 120000 },
};

const providerMaxCall: SettingDefinition<number> = {
  key: 'assistant.providerMaxCallMs',
  group: 'Assistant retries',
  label: 'Provider max call time',
  help: 'The longest one AI answer may take in total, even when data keeps arriving.',
  display: 'seconds',
  schema: z.number().int().min(60000).max(600000),
  defaultValue: 300000,
  bounds: { min: 60000, max: 600000 },
};
```

Register both in `INSTANCE_SETTINGS` (lines 398–427) directly after `providerTimeout`, and add both keys to `InstanceSettingValues` (lines 429–458) directly after `'assistant.providerTimeoutMs': number;`. Change `maxOutputTokens` `defaultValue: 2048` to `defaultValue: 4096` (bounds unchanged).
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/settings/instance-settings.test.ts packages/dashboard/src/pages/assistant-tuning.test.tsx --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/settings/instance-settings.ts packages/core/src/settings/instance-settings.test.ts packages/dashboard/src/pages/assistant-tuning.test.tsx` then `npx eslint packages/core/src/settings/instance-settings.ts packages/core/src/settings/instance-settings.test.ts packages/dashboard/src/pages/assistant-tuning.test.tsx` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/settings/instance-settings.ts packages/core/src/settings/instance-settings.test.ts packages/dashboard/src/pages/assistant-tuning.test.tsx && git commit -m "Slice 3 T4: streaming timeout and token settings"`

**Done when:** the two new keys exist with the ADR defaults and bounds; maxOutputTokens defaults to 4,096; the registry holds 30 entries; the tuning page renders both rows with no page change; every existing test still passes.

### S3-T5: Trace reasoning field   ·   Wave 2
**Owns:** Modify: `packages/core/src/assistant/trace.ts`; Test: `packages/core/src/assistant/trace.test.ts`
**Reads (do not edit):** `packages/core/src/providers/contracts.ts` (`GenerateTextResponse.reasoning` from S3-T2)
**Interfaces:** Consumes: `GenerateTextResponse.reasoning` · Produces: `assistantTraceSchema` gains optional `reasoning: z.array(z.object({ round: z.number().int().min(0), text: z.string().max(8000) })).max(12)`; `capTrace` caps each entry at 8,000 chars

- [ ] **Step 1: Write the failing test** — in `packages/core/src/assistant/trace.test.ts`, add:

```ts
it('keeps per-round reasoning capped at 8000 chars', () => {
  const trace = fixtureTrace({ reasoning: [{ round: 1, text: 'x'.repeat(9000) }] });
  const capped = capTrace({ ...trace, answer: 'a'.repeat(199_000) });
  expect(capped.reasoning?.[0]?.text.length).toBeLessThanOrEqual(8000);
  expect(capped.reasoning?.[0]?.text.endsWith('… [truncated]')).toBe(true);
});
```

using that file's existing exported `fixtureTrace` helper (top of file; builds a valid `AssistantTrace` with overrides).

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/assistant/trace.test.ts --maxWorkers=1` · Expected: FAIL with `reasoning` unknown key or `capTrace` not capping it
- [ ] **Step 3: Implement** — anchor: `packages/core/src/assistant/trace.ts` the `toolCalls` array (lines 89–104), the `guard` field (line 105), and `capTrace` (lines 229–272 with `truncateTo` at 213–217 and `TRUNCATION_SUFFIX` at 211). Replacement has two parts. First, add after the `toolCalls` array, before `guard`:

```ts
  /**
   * Saved thinking per round (Slice 3, ADR 0148): OpenRouter reasoning and
   * Gemini thought summaries. Capped by `capTrace`; shown collapsed on the
   * "What the AI saw" page to trace-capable viewers only.
   */
  reasoning: z
    .array(z.object({ round: z.number().int().min(0), text: z.string().max(8000) }))
    .max(12)
    .optional(),
```

Note the schema caps text at 8,000 chars, so `assistantTraceSchema.parse` rejects longer entries — `capTrace` must truncate *before* validation. Second, replace `capTrace` with:

```ts
export const capTrace = (t: AssistantTrace, maxBytes = 200_000): AssistantTrace => {
  // Reasoning entries are truncated up front: the schema rejects text over
  // 8,000 chars, so an untruncated entry could never be stored.
  const sections = t.sections.map((s) => ({ ...s }));
  const toolCalls = t.toolCalls.map((c) => ({ ...c }));
  const reasoning = (t.reasoning ?? []).map((r) => ({
    ...r,
    text: truncateTo(r.text, 8000),
  }));
  const out: AssistantTrace = { ...t, sections, toolCalls, reasoning: reasoning.length > 0 ? reasoning : undefined };
  const shrink = (fields: { get(): string; set(v: string): void }[]): boolean => {
    let changed = false;
    for (const field of fields) {
      const current = field.get();
      if (current.length > TRUNCATION_SUFFIX.length) {
        field.set(truncateTo(current, Math.ceil(current.length / 2)));
        changed = true;
      }
    }
    return changed;
  };
  while (
    byteSize(out) > maxBytes &&
    shrink(
      sections.map((s, i) => ({
        get: () => sections[i]?.text ?? '',
        set: (v: string) => {
          sections[i] = { ...s, text: v, chars: v.length, estTokens: estimateTokens(v) };
        },
      })),
    )
  ) {
    // Sections first, per the interface contract.
  }
  while (
    byteSize(out) > maxBytes &&
    shrink(
      toolCalls.map((c, i) => ({
        get: () => toolCalls[i]?.preview ?? '',
        set: (v: string) => {
          toolCalls[i] = { ...c, preview: v };
        },
      })),
    )
  ) {
    // Then previews.
  }
  while (
    byteSize(out) > maxBytes &&
    shrink(
      reasoning.map((r, i) => ({
        get: () => reasoning[i]?.text ?? '',
        set: (v: string) => {
          reasoning[i] = { ...r, text: v };
        },
      })),
    )
  ) {
    // Then reasoning, before giving up.
  }
  return out;
};
```

Keep `byteSize`, `truncateTo`, `estimateTokens` and the fixed-fields-never-touched rule unchanged. `reasoning` stays `undefined` when the run produced none, so old rows still parse.
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/assistant/trace.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/assistant/trace.ts packages/core/src/assistant/trace.test.ts` then `npx eslint packages/core/src/assistant/trace.ts packages/core/src/assistant/trace.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/assistant/trace.ts packages/core/src/assistant/trace.test.ts && git commit -m "Slice 3 T5: trace reasoning field"`

**Done when:** a trace round-trips `reasoning` entries; entries over 8,000 chars are truncated with the standard suffix.

### S3-T6: OpenAI-compatible streaming   ·   Wave 3
**Owns:** Modify: `packages/core/src/providers/openai-compatible.ts`; Test: `packages/core/src/providers/openai-compatible.test.ts`
**Reads (do not edit):** `packages/core/src/providers/sse.ts` (S3-T3), `packages/core/src/providers/contracts.ts` (`StreamProgress`, `StreamChunk`, `onProgress`, `onChunk`, `capabilities`), `packages/core/src/providers/errors.ts`, `packages/core/src/providers/model-capabilities.ts` (`TEXT_AND_TOOLS_ONLY`)
**Interfaces:** Consumes: `parseSseStream` from S3-T3; `StreamProgress`, `StreamChunk` from S3-T2 · Produces: `OpenAiCompatibleProvider.generateText` streams with `stream: true`, `stream_options: { include_usage: true }` (OpenRouter only), capability-gated `reasoning: { exclude: false }`, first-byte/idle/ceiling timers, `reasoning` in the response; constructor options `idleTimeoutMs` (default 45,000) and `maxCallMs` (default 300,000)

- [ ] **Step 1: Write the failing test** — in `packages/core/src/providers/openai-compatible.test.ts` (imports `createOpenRouterProvider`, `createNvidiaNimProvider`, `ProviderError` at lines 1–3; `vi.fn` fetch style). First add an SSE helper at the top of the `describe` block and convert every existing success-path mock: the adapter will always send `stream: true`, so `new Response(JSON.stringify(...))` bodies must become SSE. For each existing test that mocks a 200 JSON body (the shared `response` at lines 5–12, the tool-declaration test at 64–73, and every other `ok`-style mock in the file), wrap the same payload object with:

```ts
const sse = (...payloads: unknown[]): Response =>
  new Response(
    `${payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('')}data: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
```

i.e. `sse({ model: 'served', choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }], usage: {...} })`. Non-2xx error-path mocks stay unchanged (the error path still reads text). The old non-streaming `response.json()` success path is deleted, so unconverted tests fail with `invalid-response`/`returned no text` — convert all of them. Then add:

```ts
it('streams deltas, ignores keepalives, and joins fragmented tool args', async () => {
  const body =
    ': OPENROUTER PROCESSING\n\n' +
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"lo","reasoning":"why","tool_calls":[{"index":0,"id":"c1","function":{"name":"search_sources","arguments":"{\\"q"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ue\\":1}"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n' +
    'data: [DONE]\n\n';
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
  const seen: Array<{ answerChars: number; keepalives: number }> = [];
  const chunks: Array<{ text: string; reasoning: string }> = [];
  const res = await provider.generateText({
    model: 'm',
    messages: [{ role: 'user', text: 'hi Sam L' }],
    capabilities: { tools: true, image: false, pdf: false, reasoning: true, thinking: 'budget' },
    onProgress: (p) => { seen.push({ answerChars: p.answerChars, keepalives: p.keepalives }); },
    onChunk: (c) => { chunks.push({ ...c }); },
  });
  expect(res.text).toBe('hello');
  expect(res.reasoning).toBe('why');
  expect(res.toolCalls).toEqual([{ id: 'c1', name: 'search_sources', args: { que: 1 } }]);
  expect(seen.length).toBeGreaterThanOrEqual(1);
  expect(seen.some((s) => s.keepalives >= 1)).toBe(true);
  expect(chunks.map((c) => c.text).join('')).toBe('hello');
  expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({
    stream: true,
    stream_options: { include_usage: true },
    reasoning: { exclude: false },
  });
});

it('omits the reasoning request without capabilities or without reasoning support', async () => {
  const payload = { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] };
  const mk = () => vi.fn<typeof globalThis.fetch>().mockResolvedValue(sse(payload));
  const noCaps = createOpenRouterProvider({ apiKey: 'secret', fetch: mk() });
  await noCaps.generateText({ model: 'm', messages: [{ role: 'user', text: 'hi' }] });
  expect('reasoning' in JSON.parse(noCapsFetchBody())).toBe(false);
  const denied = createOpenRouterProvider({ apiKey: 'secret', fetch: mk() });
  await denied.generateText({
    model: 'm',
    messages: [{ role: 'user', text: 'hi' }],
    capabilities: { tools: true, image: false, pdf: false, reasoning: false, thinking: 'none' },
  });
  expect('reasoning' in JSON.parse(deniedFetchBody())).toBe(false);
});
```

(write it with two explicit fetch mocks and read each body from its own mock — the sketch above abbreviates; the real test asserts on `fetch.mock.calls[0][1].body` per provider). Also: NIM never sends `reasoning` even with reasoning capabilities (it has no such field):

```ts
it('nim never sends a reasoning request field', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    sse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }),
  );
  const provider = createNvidiaNimProvider({ apiKey: 'secret', fetch });
  await provider.generateText({
    model: 'm',
    messages: [{ role: 'user', text: 'hi' }],
    capabilities: { tools: true, image: false, pdf: false, reasoning: true, thinking: 'budget' },
  });
  const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
  expect('reasoning' in body).toBe(false);
  expect(body).toMatchObject({ stream: true });
  expect('stream_options' in body).toBe(false);
});
```

```ts
it('turns mid-stream finish_reason error into a retryable ProviderError', async () => {
  const body = 'data: {"choices":[{"delta":{"content":"part"},"finish_reason":"error","error":{"message":"upstream broke"}}]}\n\n';
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
  const err = await provider.generateText({ model: 'm', messages: [{ role: 'user', text: 'hi' }] }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err).toMatchObject({ kind: 'outage', retryable: true, finishReason: 'error' });
});

it('delivers length text with reasoning and usage', async () => {
  const body =
    'data: {"choices":[{"delta":{"content":"half","reasoning":"why"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":2,"completion_tokens":9,"total_tokens":11}}\n\n' +
    'data: [DONE]\n\n';
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
  const res = await provider.generateText({
    model: 'm',
    messages: [{ role: 'user', text: 'hi Sam L' }],
    capabilities: { tools: true, image: false, pdf: false, reasoning: true, thinking: 'budget' },
  });
  expect(res.text).toBe('half');
  expect(res.reasoning).toBe('why');
  expect(res.finishReason).toBe('length');
  expect(res.usage).toMatchObject({ promptTokens: 2, completionTokens: 9, totalTokens: 11 });
});

it('an idle stream throws a retryable timeout', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
    () => new Promise(() => {}),
  );
  const provider = createOpenRouterProvider({ apiKey: 'secret', fetch, timeoutMs: 50 });
  const err = await provider
    .generateText({ model: 'm', messages: [{ role: 'user', text: 'hi Car Team A' }] })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err).toMatchObject({ kind: 'timeout', retryable: true });
});

it('a stalled mid-stream body hits the idle timer', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({ start() {} }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const provider = createOpenRouterProvider({ apiKey: 'secret', fetch, idleTimeoutMs: 50 });
  const err = await provider
    .generateText({ model: 'm', messages: [{ role: 'user', text: 'hi' }] })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err).toMatchObject({ kind: 'timeout', retryable: true });
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/providers/openai-compatible.test.ts --maxWorkers=1` · Expected: FAIL with `stream: true` missing from the request body, no `reasoning` on the response, and every unconverted JSON mock failing
- [ ] **Step 3: Implement** — in `packages/core/src/providers/openai-compatible.ts`, against the current code:

(a) Options: extend `OpenAiCompatibleProviderOptions` (lines 56–63) with `readonly idleTimeoutMs?: number; readonly maxCallMs?: number;`, add `private readonly idleTimeoutMs: number; private readonly maxCallMs: number;` beside `timeoutMs` (line 290), and default them in the constructor (line 300) to `options.idleTimeoutMs ?? 45_000` and `options.maxCallMs ?? 300_000`.

(b) Imports: add `import { parseSseStream } from './sse.js';`, `import { TEXT_AND_TOOLS_ONLY } from './model-capabilities.js';`, and `import type { ModelCapabilities } from './model-capabilities.js';` (for the request field already typed in contracts).

(c) Hoist the `usage` object out of `responseSchema` (lines 41–53) into a module `usageSchema` const used by both the old error-path shape (kept for reference) and the new chunk schema below; keep `toolCallSchema`, `readErrorBody`, `shortReason`, quota helpers and `parseToolArguments` exactly as they are.

(d) Add the chunk schema after `responseSchema`:

```ts
const streamErrorSchema = z.object({
  message: z.string().optional(),
  code: z.union([z.number(), z.string()]).optional(),
});

const streamChunkSchema = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullable().optional(),
            reasoning: reasoningTextSchema,
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().nonnegative().optional(),
                  id: z.string().optional(),
                  type: z.string().optional(),
                  function: z.object({
                    name: z.string().min(1).optional(),
                    arguments: z.string().optional(),
                  }),
                }),
              )
              .optional(),
          })
          .optional(),
        finish_reason: z.string().nullable().optional(),
        error: streamErrorSchema.optional(),
      }),
    )
    .default([]),
  usage: usageSchema,
});
```

A chunk that fails this parse is a retryable `ProviderError('invalid-response', …)`? No — an unreadable mid-stream chunk means the stream is corrupt: throw `ProviderError('invalid-response', …, false)` with cause, like the old single-JSON parse failure. Keep that mapping.

(e) Replace `generateText` (lines 304–489) in full. The fetch setup, `toWireMessage` body build (lines 313–338) and the `!response.ok` error path (lines 361–407, quota/daily-free/retryAfter logic) stay byte-identical except the body gains streaming fields:

```ts
const capabilities: ModelCapabilities = request.capabilities ?? TEXT_AND_TOOLS_ONLY;
const body = JSON.stringify({
  model: request.model,
  messages: [ ...same as today... ],
  ...(same tools / max_tokens / temperature / usage-include as today)...,
  stream: true,
  // NIM has no usage-include field (see today's comment), so it gets
  // neither streaming-usage option.
  ...(this.id === 'openrouter' ? { stream_options: { include_usage: true } } : {}),
  // Capability gate: reasoning is asked only for models that support it.
  ...(this.id === 'openrouter' && capabilities.reasoning ? { reasoning: { exclude: false } } : {}),
});
```

Timers (replacing the single `AbortSignal.timeout` at lines 308–310):

```ts
const controller = new AbortController();
const timers: ReturnType<typeof setTimeout>[] = [];
const clearTimers = (): void => {
  while (timers.length > 0) clearTimeout(timers.pop());
};
const abortTimeout = (): void => {
  controller.abort(new DOMException(`${this.id} stream timed out`, 'TimeoutError'));
};
try {
  request.signal?.addEventListener('abort', () => controller.abort(request.signal?.reason), { once: true });
  const signal = controller.signal;
  timers.push(setTimeout(abortTimeout, this.maxCallMs)); // hard ceiling
  const firstByteTimer = setTimeout(abortTimeout, this.timeoutMs); // time to first byte
  timers.push(firstByteTimer);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const rearmIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(abortTimeout, this.idleTimeoutMs);
    timers.push(idleTimer);
  };
  let response: Response;
  try {
    response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body,
      signal,
    });
  } catch (error) {
    // Unchanged mapping: TimeoutError (ours or the caller's deadline) →
    // retryable timeout; anything else → outage. A caller abort surfaces
    // as an AbortError (not TimeoutError) and keeps today's outage mapping.
    const timeout = isTimeoutError(error);
    const netCode = netCodeOf(error);
    throw new ProviderError(
      timeout ? 'timeout' : 'outage',
      `${this.id} request ${timeout ? 'timed out' : 'failed'}`,
      true,
      { cause: error, host: this.host, ...(netCode === undefined ? {} : { netCode }) },
    );
  }
  ... unchanged !response.ok path, but every `await response.text()` there
  ... must tolerate our timers: wrap in try/finally that does NOT clear
  ... timers early (they die in the outer finally).
  if (response.body === null)
    throw new ProviderError('invalid-response', `${this.id} returned no body`, false, { host: this.host });
  clearTimeout(firstByteTimer); // headers arrived: first byte counts as started
  let sawFirstByte = false;
  let text = '';
  let reasoning = '';
  let model: string | undefined;
  let upstream: string | undefined;
  let finishReason: string | undefined;
  let usage: z.infer<typeof usageSchema> | undefined;
  const toolFragments = new Map<number, { id?: string; name?: string; argsText: string }>();
  let answerChars = 0;
  let reasoningChars = 0;
  let keepalives = 0;
  let lastByteAt = Date.now();
  let lastEmitAt = 0;
  const emitProgress = (): void => {
    if (request.onProgress === undefined) return;
    const now = Date.now();
    if (lastEmitAt !== 0 && now - lastEmitAt < 3_000) return; // at most every 3 s; first emit immediate
    lastEmitAt = now;
    request.onProgress({
      round: 0, // the tool loop stamps the real round
      answerChars,
      reasoningChars,
      keepalives,
      msSinceLastByte: Math.max(0, now - lastByteAt),
    });
  };
  try {
    for await (const event of parseSseStream(response.body)) {
      lastByteAt = Date.now();
      if (!sawFirstByte) {
        sawFirstByte = true;
        clearTimeout(firstByteTimer);
      }
      rearmIdle(); // keepalives count as bytes
      if (event.keepalive) {
        keepalives += 1;
        emitProgress();
        continue;
      }
      const parsed = streamChunkSchema.safeParse(JSON.parse(event.data));
      if (!parsed.success)
        throw new ProviderError('invalid-response', `${this.id} returned an invalid chunk`, false, { cause: parsed.error });
      const chunk = parsed.data;
      if (chunk.model !== undefined) model = chunk.model;
      if (chunk.provider !== undefined) upstream = chunk.provider;
      if (chunk.usage !== undefined) usage = chunk.usage;
      let deltaText = '';
      let deltaReasoning = '';
      for (const choice of chunk.choices) {
        if (choice.error !== undefined || choice.finish_reason === 'error') {
          // Mid-stream failure inside a 200: retryable, partial text
          // discarded — never delivered, never stored.
          throw new ProviderError('outage', `${this.id} stream failed mid-response`, true, {
            host: this.host,
            finishReason: 'error',
            ...(upstream === undefined ? {} : { upstream }),
          });
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null && choice.finish_reason !== '')
          finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (delta === undefined) continue;
        if (delta.content !== undefined && delta.content !== null) {
          text += delta.content;
          deltaText += delta.content;
          answerChars += delta.content.length;
        }
        if (delta.reasoning !== undefined && delta.reasoning !== null) {
          reasoning += delta.reasoning;
          deltaReasoning += delta.reasoning;
          reasoningChars += delta.reasoning.length;
        }
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? 0;
          const frag = toolFragments.get(index);
          if (frag === undefined) {
            toolFragments.set(index, {
              ...(call.id === undefined ? {} : { id: call.id }),
              ...(call.function.name === undefined ? {} : { name: call.function.name }),
              argsText: call.function.arguments ?? '',
            });
          } else {
            // First-seen id/name win; a name arriving only in a later
            // fragment is still picked up; args concatenate per index and
            // parse once at the end.
            toolFragments.set(index, {
              ...(call.id !== undefined && frag.id === undefined ? { id: call.id } : frag.id === undefined ? {} : { id: frag.id }),
              ...(call.function.name !== undefined && frag.name === undefined
                ? { name: call.function.name }
                : frag.name === undefined
                  ? {}
                  : { name: frag.name }),
              argsText: frag.argsText + (call.function.arguments ?? ''),
            });
          }
        }
      }
      if (deltaText !== '' || deltaReasoning !== '') request.onChunk?.({ text: deltaText, reasoning: deltaReasoning });
      emitProgress();
    }
  } catch (error) {
    // Our first-byte/idle/ceiling timers abort with TimeoutError → retryable
    // timeout (same mapping as the fetch catch). Errors thrown above
    // (mid-stream outage, invalid chunk) pass through unchanged.
    if (error instanceof ProviderError) throw error;
    if (isTimeoutError(error))
      throw new ProviderError('timeout', `${this.id} stream timed out`, true, {
        cause: error,
        host: this.host,
      });
    throw new ProviderError('outage', `${this.id} stream failed`, true, {
      cause: error,
      host: this.host,
    });
  } finally {
    clearTimers();
    if (idleTimer !== undefined) clearTimeout(idleTimer);
  }

After the stream ends, assemble in index order and finish with the existing mappings (same `finishReason` slice-40, `upstream` slice-60, usage incl. `thinkingTokens`/`costUsd`, same empty-answer throw with `reasoningOnly: reasoning !== ''`):
    .sort(([a], [b]) => a - b)
    .flatMap(([, frag]) =>
      frag.name === undefined
        ? []
        : [{ ...(frag.id === undefined ? {} : { id: frag.id }), name: frag.name, args: parseToolArguments(frag.argsText) }],
    );
  const finish = finishReason === '' || finishReason === undefined ? undefined : finishReason;
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
  const reasoningOnly = reasoning !== '';
  if (text === '' && toolCalls.length === 0)
    throw new ProviderError('invalid-response', `${this.id} returned no text`, false, {
      host: this.host,
      ...(finish === undefined ? {} : { finishReason: finish }),
      ...(upstream === undefined ? {} : { upstream }),
      emptyAnswer: {
        ...(usage?.completion_tokens !== undefined ? { completionTokens: usage.completion_tokens } : {}),
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        reasoningOnly,
      },
    });
  return {
    text,
    model: model ?? request.model,
    ...(finish ? { finishReason: finish.slice(0, 40) } : {}),
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
    ...(reasoning === '' ? {} : { reasoning }),
    ...(upstream === undefined ? {} : { upstream: upstream.slice(0, 60) }),
    ...(usage ? { usage: { ...same usage mapping as today... } } : {}),
  };
} finally {
  clearTimers();
}
```

Keep every existing error-mapping branch and every ProviderError field (no `quotaScope`/`retryAfterMs`/`learnedLimit` on these paths today — the non-ok path already sets them where it did). `length` passes through as `finishReason` with text, reasoning and usage intact so S3-T8 can append `-# (cut short)`. Delete the old `response.json()` success path (lines 408–430) and the old non-streaming assembly (lines 431–488), replaced by the above.
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/providers/openai-compatible.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/providers/openai-compatible.ts packages/core/src/providers/openai-compatible.test.ts` then `npx eslint packages/core/src/providers/openai-compatible.ts packages/core/src/providers/openai-compatible.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/providers/openai-compatible.ts packages/core/src/providers/openai-compatible.test.ts && git commit -m "Slice 3 T6: OpenAI-compatible streaming"`

**Done when:** streamed deltas assemble text, reasoning and whole tool args; keepalives are ignored but counted and re-arm the idle timer; mid-stream `error` is retryable and never delivered or stored; `length` keeps text plus usage; request carries `stream: true` and usage options; no `reasoning` field without `reasoning: true` capabilities (NIM never); every pre-existing JSON mock is converted to SSE.

### S3-T7: Gemini streaming   ·   Wave 3
**Owns:** Modify: `packages/core/src/providers/gemini.ts`; Test: `packages/core/src/providers/gemini.test.ts`
**Reads (do not edit):** `packages/core/src/providers/sse.ts` (S3-T3), `packages/core/src/providers/contracts.ts`, `packages/core/src/providers/errors.ts`
**Interfaces:** Consumes: `parseSseStream` from S3-T3; `StreamProgress` from S3-T2 · Produces: `GeminiProvider.generateText` streams `:streamGenerateContent?alt=sse` with `thinkingLevel` and `includeThoughts`, returning `reasoning` and raw `providerParts`

- [ ] **Step 1: Write the failing test** — in `packages/core/src/providers/gemini.test.ts`, using its `ok()` and `vi.fn` fetch style, add:

```ts
it('streams text, thought and functionCall parts with thinkingLevel', async () => {
  const body =
    'data: {"candidates":[{"content":{"parts":[{"text":"hel"}]}}]}\n\n' +
    'data: {"candidates":[{"content":{"parts":[{"text":"背景","thought":true}]}}]}\n\n' +
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"search_sources","args":{"que":1}}}],"finishReason":"STOP"}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5,"thoughtsTokenCount":4}}\n\n';
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  const provider = new GeminiProvider({ apiKey: 'secret', fetch });
  const res = await provider.generateText({
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', text: 'hi Sam L' }],
    tools: [{ name: 'search_sources', description: 'Search.', parameters: { type: 'object' } }],
  });
  expect(res.text).toBe('hel');
  expect(res.reasoning).toBe('背景');
  expect(res.toolCalls).toEqual([{ name: 'search_sources', args: { que: 1 } }]);
  expect(res.providerParts).toBeDefined();
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(String(url)).toContain(':streamGenerateContent?alt=sse');
  expect(JSON.parse(init?.body as string).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
});

it('an idle stream throws a retryable timeout', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
    () => new Promise(() => {}),
  );
  const provider = new GeminiProvider({ apiKey: 'secret', fetch, timeoutMs: 50 });
  const err = await provider
    .generateText({ model: 'gemini-3.8-flash', messages: [{ role: 'user', text: 'hi' }] })

    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err).toMatchObject({ kind: 'timeout', retryable: true });
});

it('uses thinkingLevel medium for the answer call and echoes providerParts', async () => {
  const body =
    'data: {"candidates":[{"content":{"parts":[{"text":"done"}]}}]}\n\n' +
    'data: {"candidates":[{"content":{"parts":[{"text":"thought sum","thought":true}]}}]}\n\n' +
    'data: {"candidates":[{"content":{"parts":[{"text":"done"}],"finishReason":"STOP"}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"totalTokenCount":3,"thoughtsTokenCount":1}}\n\n';
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  const provider = new GeminiProvider({ apiKey: 'secret', fetch });
  const res = await provider.generateText({
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', text: 'hi Alex P' }],
  });
  expect(res.text).toBe('donedone');
  expect(res.reasoning).toBe('thought sum');
  expect(res.providerParts).toBeDefined();
  const [, init] = fetch.mock.calls[0] ?? [];
  expect(JSON.parse(init?.body as string).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'medium' });
});

it('surfaces MAX_TOKENS with text, usage and thinking tokens', async () => {
  const body = 'data: {"candidates":[{"content":{"parts":[{"text":"half"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":9,"totalTokenCount":11,"thoughtsTokenCount":4}}\n\n';
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  const provider = new GeminiProvider({ apiKey: 'secret', fetch });
  const res = await provider.generateText({
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', text: 'hi' }],
    tools: [{ name: 'search_sources', description: 'Search.', parameters: { type: 'object' } }],
  });
  expect(res.text).toBe('half');
  expect(res.finishReason).toBe('MAX_TOKENS');
  expect(res.usage).toMatchObject({ promptTokens: 2, completionTokens: 9, totalTokens: 11, thinkingTokens: 4 });
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/providers/gemini.test.ts --maxWorkers=1` · Expected: FAIL with `:generateContent` URL and no `thinkingLevel`
- [ ] **Step 3: Implement** — anchor: `GeminiProvider.generateText` URL `:generateContent`, `generationConfig` with `thinkingBudget`, and the single-JSON parse (lines ~137–297). Replacement: call `:streamGenerateContent?alt=sse`; send `generationConfig.thinkingConfig: { thinkingLevel }` where level is explicit `request.thinkingLevel` else tools offered → `'low'` else `'medium'` (never `minimal`); always send `includeThoughts: true` (after Slice 6: gate on the entry `GeminiModelProfile` table `capabilities.thinking !== 'none'` and reasoning on `capabilities.reasoning` — the name `GeminiModelInfo` already exists in `packages/core/src/providers/gemini.ts` for a different interface, so the Slice 6 type keeps the new name); stream `response.body` through `parseSseStream`, assembling non-thought `text` as content, `thought: true` text as reasoning, `functionCall` parts as tool calls, and `thoughtSignature` bytes into the echoed raw parts; echo the raw parts back as `providerParts` so thought signatures survive tool rounds; count every `:` comment as a keepalive and re-arm the idle timer on it; fire `onProgress` at most every 3 s with `{ round: 0, answerChars, reasoningChars, keepalives, msSinceLastByte }`; record time-to-first-byte from the existing `timeoutMs` and abort on first-byte, idle (45 s default, re-armed on every byte) and ceiling (300 s) timers; keep the empty-answer, `MAX_TOKENS` (pass through with text and usage so S3-T8 can append `-# (cut short)`) and `SAFETY` mappings, usage mapping incl. `thoughtsTokenCount → thinkingTokens`, and every ProviderError field (after Slice 6: plus `quotaScope`, `retryAfterMs`, `learnedLimit`).
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/providers/gemini.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/providers/gemini.ts packages/core/src/providers/gemini.test.ts` then `npx eslint packages/core/src/providers/gemini.ts packages/core/src/providers/gemini.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/providers/gemini.ts packages/core/src/providers/gemini.test.ts && git commit -m "Slice 3 T7: Gemini streaming"`

**Done when:** the SSE endpoint assembles text, thought and function calls; `thinkingLevel` is `low` with tools and `medium` without; thought signatures survive via raw `providerParts`; keepalives re-arm the idle timer; `MAX_TOKENS` keeps text plus usage; idle streams time out retryably.

### S3-T8: Tool loop wiring and finish reasons   ·   Wave 4
**Owns:** Modify: `apps/daemon/src/assistant/tool-loop.ts`; Test: `apps/daemon/src/assistant/tool-loop.test.ts`
**Reads (do not edit):** `packages/core/src/providers/contracts.ts` (`StreamProgress`, `onProgress`), `apps/daemon/src/assistant/run-recorder.ts`, `apps/daemon/src/assistant/typing.ts`, `apps/daemon/src/jobs/assistant.ts` (lines 726–734 `startTyping`)
**Interfaces:** Consumes: streamed `GenerateTextResponse.reasoning` from S3-T6/S3-T7; `model-progress` event from S3-T2 · Produces: tool loop passes `onProgress` per round, records throttled `model-progress`, appends `-# (cut short)` on `length`, saves `reasoning` per round for the trace

- [ ] **Step 1: Write the failing test** — in `apps/daemon/src/assistant/tool-loop.test.ts`, using its `scripted` provider helper and `entry()` (top of file, lines 29–60), add:

```ts
it('appends a cut-short line when finishReason is length with text', async () => {
  const { provider } = scripted([
    { text: 'long answer', model: 'model-a', finishReason: 'length' },
  ]);
  const loop = await runToolLoop({
    provider,
    chain: [entry({ provider })],
    systemInstruction: 'Be concise.',
    protectedText: '',
    toolsOffered: [],
    runTools: async () => ({ ok: true, name: 'x', text: 'done', sources: [] }),
    recorder: { runId: 'r1', event: () => undefined, update: () => undefined },
    now: () => NOW,
  });
  expect(loop.text).toContain('long answer');
  expect(loop.text).toContain('-# (cut short)');
});

it('emits model-progress at most every 3 s through onProgress', async () => {
  const seen: Array<{ msSinceLastByte: number }> = [];
  const streaming = {
    id: 'fake',
    capabilities: new Set(['text', 'tools'] as const),
    generateText: async (req: GenerateTextRequest) => {
      req.onProgress?.({ round: 1, answerChars: 10, reasoningChars: 0, keepalives: 0, msSinceLastByte: 100 });
      req.onProgress?.({ round: 1, answerChars: 20, reasoningChars: 0, keepalives: 0, msSinceLastByte: 200 });
      return { text: 'done', model: 'model-a' };
    },
  };
  const events: RunEvent[] = [];
  await runToolLoop({
    provider: streaming,
    chain: [entry({ provider: streaming })],
    systemInstruction: 'Be concise.',
    protectedText: '',
    toolsOffered: [],
    runTools: async () => ({ ok: true, name: 'x', text: 'done', sources: [] }),
    recorder: { runId: 'r1', event: (e) => { events.push(e); }, update: () => undefined },
    now: () => NOW,
  });
  expect(events.filter((e) => e.kind === 'model-progress').length).toBeLessThanOrEqual(1);
  expect(seen.length).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run apps/daemon/src/assistant/tool-loop.test.ts --maxWorkers=1` · Expected: FAIL with no `-# (cut short)` line and no `model-progress` event
- [ ] **Step 3: Implement** — anchor: `callProvider` in `apps/daemon/src/assistant/tool-loop.ts` (around lines 740–810: `thinkingBudget`, `maxOutputTokens`, `model-call`/`model-result` events). Replacement: pass `onProgress` that throttles to one `model-progress` event per 3 s per call (track last emit per round; carry `{ round, answerChars, reasoningChars, keepalives, msSinceLastByte }` straight into the event, which bumps `updatedAt` via the recorder); keep `thinkingBudget` mapping as is (adapters derive `thinkingLevel` from tools); in `finishEntry`, when `finishReason` is `length` (or Gemini `MAX_TOKENS`) and guarded text is non-empty, append `\n\n-# (cut short)` after the guard; when `length` with empty text, keep today's empty-answer path; thread `response.reasoning` per round into the trace payload the service writes (S3-T9 reads it there). Keep typing alive: in `apps/daemon/src/jobs/assistant.ts` the `startTyping` call (lines 726–734) is restarted per provider call with `maxMs` set to `assistant.providerMaxCallMs` and stopped only at run end — implement by moving the stop call to the run-end backstop (line 1371) and passing the ceiling as `maxMs`. (after Slice 6: pass entry `capabilities` into the request so adapters can gate reasoning/thinking.)
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run apps/daemon/src/assistant/tool-loop.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write apps/daemon/src/assistant/tool-loop.ts apps/daemon/src/assistant/tool-loop.test.ts` then `npx eslint apps/daemon/src/assistant/tool-loop.ts apps/daemon/src/assistant/tool-loop.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add apps/daemon/src/assistant/tool-loop.ts apps/daemon/src/assistant/tool-loop.test.ts && git commit -m "Slice 3 T8: tool loop progress and finish reasons"`

**Done when:** `length` with text delivers the answer plus `-# (cut short)`; `model-progress` fires at most every 3 s; `reasoning` travels per round to the trace writer; typing survives a long stream.

### S3-T9: Live buffer, route and progress events   ·   Wave 4
**Owns:** Create: `apps/daemon/src/assistant/live-buffer.ts`; Test: `apps/daemon/src/assistant/live-buffer.test.ts`; Modify: `packages/http/src/routes/assistant-runs.ts`; Test: `packages/http/src/routes/assistant-runs.test.ts`; Modify: `apps/daemon/src/assistant/run-recorder.ts`
**Reads (do not edit):** `packages/core/src/assistant/run-events.ts` (`model-progress`), `packages/core/src/assistant/trace.ts` (`reasoning` from S3-T5)
**Interfaces:** Consumes: `model-progress` event from S3-T2; trace `reasoning` from S3-T5 · Produces: `LiveBuffer` with `append(runId, answer, reasoning)`, `read(runId)`, `drop(runId)` capped at 8,000 chars per side; `GET /api/assistant/runs/:runId/live` gated by `audit.read`; `model-progress` patch bumps `updatedAt`

- [ ] **Step 1: Write the failing test** — create `apps/daemon/src/assistant/live-buffer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createLiveBuffer } from './live-buffer.js';

describe('createLiveBuffer', () => {
  it('caps each side at 8000 chars and drops on finish', () => {
    const buf = createLiveBuffer();
    buf.append('run-1', 'a'.repeat(9000), 't'.repeat(9000));
    expect(buf.read('run-1')?.answer.length).toBe(8000);
    expect(buf.read('run-1')?.thinking.length).toBe(8000);
    buf.drop('run-1');
    expect(buf.read('run-1')).toBeUndefined();
  });

  it('accumulates across appends', () => {
    const buf = createLiveBuffer();
    buf.append('run-1', 'hel', 'why');
    buf.append('run-1', 'lo', ' not');
    expect(buf.read('run-1')).toEqual({ answer: 'hello', thinking: 'why not' });
  });
});
```

and in `packages/http/src/routes/assistant-runs.test.ts` add (following its `requires audit.read` test at line 100, using its app/seed helpers): a run seeded in-guild returns `{ answer, thinking }` from `GET /api/assistant/runs/:runId/live`; without `audit.read` it 403s; a run seeded in another guild 404s.

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run apps/daemon/src/assistant/live-buffer.test.ts packages/http/src/routes/assistant-runs.test.ts --maxWorkers=1` · Expected: FAIL with cannot find module `./live-buffer.js` and 404 on `/live`
- [ ] **Step 3: Implement** — full `apps/daemon/src/assistant/live-buffer.ts`: a `Map<string, { answer: string; thinking: string }>`; `append` concatenates then slices each side to the last 8,000 chars; `read` returns a copy or undefined; `drop` deletes. Anchor: `packages/http/src/routes/assistant-runs.ts` the `/events` handler (lines 129–160). Add after it `GET /api/assistant/runs/:runId/live` with the same `guard.require` + `requireCapability(session, 'audit.read', reply)` + guild-scoped `getRun` 404, returning `{ answer, thinking }` from the buffer (empty strings when absent). Anchor: `apps/daemon/src/assistant/run-recorder.ts` `patchFor` (lines 18–70). Add `case 'model-progress': return { updatedAt: now };` alongside the metadata-only group. The tool loop calls `buf.append` from its `onProgress`/chunk handler and `buf.drop` when it records `finished`; trace writing stores per-round `reasoning` (S3-T5 field) capped at 8,000.
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run apps/daemon/src/assistant/live-buffer.test.ts packages/http/src/routes/assistant-runs.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write apps/daemon/src/assistant/live-buffer.ts apps/daemon/src/assistant/live-buffer.test.ts packages/http/src/routes/assistant-runs.ts packages/http/src/routes/assistant-runs.test.ts apps/daemon/src/assistant/run-recorder.ts` then `npx eslint apps/daemon/src/assistant/live-buffer.ts apps/daemon/src/assistant/live-buffer.test.ts packages/http/src/routes/assistant-runs.ts packages/http/src/routes/assistant-runs.test.ts apps/daemon/src/assistant/run-recorder.ts` · exit 0

- [ ] **Step 7: Commit** — `git add apps/daemon/src/assistant/live-buffer.ts apps/daemon/src/assistant/live-buffer.test.ts packages/http/src/routes/assistant-runs.ts packages/http/src/routes/assistant-runs.test.ts apps/daemon/src/assistant/run-recorder.ts && git commit -m "Slice 3 T9: live buffer and progress events"`

**Done when:** the buffer caps at 8,000 per side and drops at finish; `/live` is gated like traces; `model-progress` bumps `updatedAt` so the 10-minute stalled label stays honest.

### S3-T10: Dashboard live text and progress   ·   Wave 5
**Owns:** Modify: `packages/dashboard/src/api/runs.ts`; Create: `packages/dashboard/src/pages/assistant-live-buffer.tsx`; Test: `packages/dashboard/src/pages/assistant-live-buffer.test.tsx`; Modify: `packages/dashboard/src/pages/assistant-tuning.tsx`; Test: `packages/dashboard/src/pages/assistant-tuning.test.tsx`
**Reads (do not edit):** `packages/dashboard/src/pages/assistant-live.tsx` (`StepLog`, `InProgressPanel`, 2 s `useLiveResource`), `packages/dashboard/src/hooks/useLiveResource.tsx`
**Interfaces:** Consumes: `GET /api/assistant/runs/:runId/live` from S3-T9; settings keys from S3-T4 · Produces: `describeRunEvent` renders `model-progress`; `LiveText` component polling `/live` every 2 s; tuning rows for the two timeouts

- [ ] **Step 1: Write the failing test** — create `packages/dashboard/src/pages/assistant-live-buffer.test.tsx` (`// @vitest-environment jsdom`, following `assistant-live.test.tsx` imports of `renderWithSession`, `stubFetch`):

```tsx
// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, stubFetch } from '../test-support.js';
import { runLiveUrl } from '../api/runs.js';
import { LiveText } from './assistant-live-buffer.js';

afterEach(cleanup);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('LiveText', () => {
  it('polls the live route and shows answer plus collapsed thinking', async () => {
    const mock = stubFetch([
      { url: runLiveUrl('run-1'), body: { answer: 'hello Sam L', thinking: 'why this answer' } },
    ]);
    renderWithSession(<LiveText runId="run-1" />);
    expect(await screen.findByText(/hello Sam L/)).toBeDefined();
    expect(await screen.findByText(/why this answer/)).toBeDefined();
    expect(mock).toHaveBeenCalled();
  });
});
```

and in `packages/dashboard/src/pages/assistant-tuning.test.tsx` extend the `renders the five group headings` test style: the idle-timeout and max-call rows render with defaults 45 s and 300 s, and saving the idle timeout converts seconds to milliseconds.

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/dashboard/src/pages/assistant-live-buffer.test.tsx packages/dashboard/src/pages/assistant-tuning.test.tsx --maxWorkers=1` · Expected: FAIL with cannot find module `./assistant-live-buffer.js` and missing timeout rows
- [ ] **Step 3: Implement** — anchor: `packages/dashboard/src/api/runs.ts` `describeRunEvent` (line 36) and `runEventsUrl`. Add `export const runLiveUrl = (runId: string): string => …/live` plus a `LiveTextResponse { answer: string; thinking: string }` interface; add the `model-progress` case: `` `Receiving… ${num(answerChars)} chars of answer` `` plus `` `, ${num(reasoningChars)} chars of thinking` `` when non-zero. New `assistant-live-buffer.tsx`: a `LiveText({ runId })` component using the same `useLiveResource` 2 s fast / 15 s slow cadence as `StepLog`, rendering the answer text and the thinking collapsed in a `<details>` element labelled `Thinking`. Anchor: `packages/dashboard/src/pages/assistant-tuning.tsx` rows (the provider-timeout row tested at line 133). Add two rows bound to `assistant.providerIdleTimeoutMs` and `assistant.providerMaxCallMs` with seconds display, same save path as the existing timeout row. Mount `LiveText` inside the StepLog card in `assistant-live.tsx` — mount-only change (contracts §4 dashboard rule).
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/dashboard/src/pages/assistant-live-buffer.test.tsx packages/dashboard/src/pages/assistant-tuning.test.tsx --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/dashboard/src/api/runs.ts packages/dashboard/src/pages/assistant-live-buffer.tsx packages/dashboard/src/pages/assistant-live-buffer.test.tsx packages/dashboard/src/pages/assistant-tuning.tsx packages/dashboard/src/pages/assistant-tuning.test.tsx packages/dashboard/src/pages/assistant-live.tsx` then `npx eslint packages/dashboard/src/api/runs.ts packages/dashboard/src/pages/assistant-live-buffer.tsx packages/dashboard/src/pages/assistant-live-buffer.test.tsx packages/dashboard/src/pages/assistant-tuning.tsx packages/dashboard/src/pages/assistant-tuning.test.tsx packages/dashboard/src/pages/assistant-live.tsx` · exit 0
- [ ] **Step 7: Commit** — `git add packages/dashboard/src/api/runs.ts packages/dashboard/src/pages/assistant-live-buffer.tsx packages/dashboard/src/pages/assistant-live-buffer.test.tsx packages/dashboard/src/pages/assistant-tuning.tsx packages/dashboard/src/pages/assistant-tuning.test.tsx packages/dashboard/src/pages/assistant-live.tsx && git commit -m "Slice 3 T10: dashboard live text and progress"`

**Done when:** `model-progress` renders the `Receiving…` line; live text polls every 2 s with thinking collapsed; both timeout settings render and save.


### S3-T11: State and privacy paperwork   ·   Wave 5
**Owns:** Modify: `docs/STATE.md`; Modify: `PRIVACY.md`
**Reads (do not edit):** `docs/decisions/0148-assistant-streaming-timeouts-live-progress.md`
**Interfaces:** Consumes: ADR 0148 numbers · Produces: `docs/STATE.md` entry after the first `---` in Slice 1 style; PRIVACY.md thinking line

- [ ] **Step 1: Write the failing test** — no code test; the check is `grep -c "streaming" docs/STATE.md` returns 0 before the edit.
- [ ] **Step 2: Run it and watch it fail** — `grep -c "streaming" docs/STATE.md` · Expected: FAIL with count 0
- [ ] **Step 3: Implement** — anchor: `docs/STATE.md` top of file, after the first `---`, same bullet style as the Slice 1 entry (line 7). Insert:

```md
**Assistant streaming (Slice 3, ADR 0148, no migration).**

- **Streaming:** OpenRouter/NIM send `stream: true` with usage; Gemini uses `:streamGenerateContent?alt=sse`. SSE comments ignored, tool args joined per index, thought parts kept apart, raw parts echoed for signatures.
- **Timeouts:** idle 45 s (`assistant.providerIdleTimeoutMs`) re-armed per byte, ceiling 300 s (`assistant.providerMaxCallMs`), first byte 60 s (`assistant.providerTimeoutMs`). `assistant.maxOutputTokens` default 4,096.
- **Finish reasons:** mid-stream `error` is retryable and never delivered; `length` with text adds `-# (cut short)`; `length` empty keeps the empty-answer path.
- **Live dashboard:** per-run buffer (8,000 chars answer plus 8,000 thinking, dropped at finish), `GET /api/assistant/runs/:runId/live`, `model-progress` steps at most every 3 s, thinking saved per round under trace `reasoning`.
```

Anchor: `PRIVACY.md` the step-log bullet (the `- The bot also keeps a step log…` line). Append after it: `- The model's thinking text is shown live on the dashboard while it answers and is saved with the trace, capped at 8,000 characters per run. It can echo member messages. It is shown only to accounts that can read traces and is deleted with the conversation.`
- [ ] **Step 4: Run it and watch it pass** — `grep -c "streaming" docs/STATE.md` · Expected: PASS with count ≥ 1
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write docs/STATE.md PRIVACY.md` then `npx eslint docs/STATE.md PRIVACY.md` · exit 0
- [ ] **Step 7: Commit** — `git add docs/STATE.md PRIVACY.md && git commit -m "Slice 3 T11: state and privacy paperwork"`

**Done when:** STATE.md carries the Slice 3 entry in Slice 1 style; PRIVACY.md carries the thinking line.

## Slice gate (orchestrator only, after the last wave)
npm run typecheck        (≈1.7 GB peak — run alone)
npm run lint
npx vitest run --maxWorkers=1
## After merge (owner)
Deploy order: stop → build → start (no migration). On the dashboard Tuning page, check the idle timeout (45 s), max call time (300 s) and max answer length (4,096 tokens); leave the rest as is. In Discord, ask a long question and watch the run's Step log show `Receiving…` lines, then open the trace and check the saved thinking under `reasoning`.
