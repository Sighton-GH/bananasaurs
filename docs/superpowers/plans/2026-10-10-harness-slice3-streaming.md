# Slice 3: Streaming, idle timeout, live progress and thinking — implementation plan

> **Instinct plan.** Read with `2026-10-10-harness-00-instinct-handoff.md` and `2026-10-10-harness-00-shared-contracts.md`.
> **Status:** DRAFT — refreshed by the controller before round 2

**Goal:** Every provider streams its answer with an idle timeout and a hard ceiling, finish reasons are checked, and the dashboard shows live progress plus saved thinking.
**Spec:** docs/superpowers/specs/2026-10-09-assistant-harness-capability-design.md §Slice 3 (3a–3e), D5(b), D6, §4.7
**ADRs:** 0148   **Migration:** none
**Base:** main @ 0371edc3

**Slice 6 note:** Written against today's code; Slice 6 merges first. Slice 6 adds the ProviderError quota fields (`quotaScope: 'day' | 'minute'`, `retryAfterMs`, `learnedLimit`) and the ModelCapabilities record (contracts §3). Every Slice 6 spot is marked "(after Slice 6: …)" in its task.

## Global Constraints

- `CLAUDE.md` hard rules 1–9 apply. AI is never in the enforcement path; every query, key and job carries a guild id; model output passes Zod; every Discord side effect has a durable idempotency key; no secrets in code, logs or fixtures; no new outbound destination unless the ADR records it.
- No new dependency.
- Fixtures use invented names (Sam L, Alex P, Car Team A). Never a real member's name or id.
- Canadian English, plain words in prompts and dashboard copy. No tool names shown to members.
- Write the failing test first for anything touching permissions, pings, idempotency, retention or guild scope, and watch it fail before writing the code.

- Slice rules: `assistant.providerTimeoutMs` (60,000) becomes time-to-first-byte; new `assistant.providerIdleTimeoutMs` default 45,000 (re-armed on every byte, keepalives count); new `assistant.providerMaxCallMs` default 300,000 (hard ceiling). `assistant.maxOutputTokens` default 2,048 → 4,096, bounds stay 256–8,192. Gemini thinking is `thinkingConfig.thinkingLevel`: `low` for tool rounds, `medium` for the answer, never `minimal`. OpenRouter sends `reasoning: { exclude: false }` until Slice 6 gates it. `model-progress` carries `{ round, answerChars, reasoningChars, keepalives, msSinceLastByte }`, at most every 3 s, bumping `updatedAt`. Live buffer caps at 8,000 chars of answer and 8,000 of thinking per run, dropped at finish; thinking saved under trace `reasoning` per round. StepLog polls every 2 s (no browser SSE). Every new setting gets registry plus dashboard control plus test. Contracts §4 files edited additively. No migration.

## Plan decisions

- New SSE parsing lives in `packages/core/src/providers/sse.ts` (`parseSseStream`); both adapters share it for comment lines, split chunks and `[DONE]`.
- Until Slice 6 lands there is no capability table, so OpenRouter always sends `reasoning: { exclude: false }` and Gemini always sends `includeThoughts: true` with `thinkingLevel`; (after Slice 6: gate both on the entry capabilities).
- `thinkingLevel` is derived in the adapters from tools offered (tools present → `low`, answer call → `medium`); explicit `GenerateTextRequest.thinkingLevel` wins when set.
- Timeouts use the `AbortSignal.timeout` style already in both adapters: first-byte timer, idle timer re-armed per chunk, absolute deadline; idle timeout throws retryable `ProviderError('timeout', …)`.
- `length` with text appends code-built `-# (cut short)` after the guard, so the marker is never stripped.
- Live buffer is a daemon in-memory map by run id (`apps/daemon/src/assistant/live-buffer.ts`), deleted on `finished`; keeps the ledger metadata-only with no storage change.
- `describeRunEvent` for `model-progress` renders `Receiving… 1,240 chars of answer, 3,100 chars of thinking`, omitting a side with 0 chars.
- Typing stays alive by restarting `startTyping` per provider call with `maxMs` set to the hard ceiling and stopping only at run end.

## Review Focus

1. **A stream that trickles forever.** One byte every 40 s must hit the 45 s idle timer with a retryable `timeout`; a stream under idle but past 300 s must hit the ceiling. Pinned in S3-T6 and S3-T7.
2. **Mid-stream `finish_reason: "error"` inside a 200.** Becomes retryable `ProviderError`; partial text kept for the trace, never delivered. Pinned in S3-T6.
3. **Fragmented tool-call arguments across chunks.** Concatenated per index, parsed only when complete. Pinned in S3-T6.
4. **Thinking that echoes a member message.** Live in the buffer, saved under trace `reasoning`, shown only with trace capability, plus a PRIVACY.md line. Pinned in S3-T9 and S3-T11.
5. **A member watching mid-run.** Step log shows `Receiving…` at most every 3 s; live text polls every 2 s with no duplicate rows. Pinned in S3-T9 and S3-T10.


## Waves

| Wave | Task | Owns (create/modify) | Depends on |
|---|---|---|---|
| 1 | S3-T1 ADR 0148 | Create: `docs/decisions/0148-assistant-streaming-timeouts-live-progress.md` | — |
| 1 | S3-T2 Contracts and run-event schema | Modify: `packages/core/src/providers/contracts.ts`; Modify: `packages/core/src/assistant/run-events.ts`; Test: `packages/core/src/assistant/run-events.test.ts` | — |
| 2 | S3-T3 Shared SSE parser | Create: `packages/core/src/providers/sse.ts`; Test: `packages/core/src/providers/sse.test.ts` | S3-T2 |
| 2 | S3-T4 Timeout and token settings | Modify: `packages/core/src/settings/instance-settings.ts`; Test: `packages/core/src/settings/instance-settings.test.ts` | S3-T1 |
| 2 | S3-T5 Trace reasoning field | Modify: `packages/core/src/assistant/trace.ts`; Test: `packages/core/src/assistant/trace.test.ts` | S3-T2 |
| 3 | S3-T6 OpenAI-compatible streaming | Modify: `packages/core/src/providers/openai-compatible.ts`; Test: `packages/core/src/providers/openai-compatible.test.ts` | S3-T2, S3-T3 |
| 3 | S3-T7 Gemini streaming | Modify: `packages/core/src/providers/gemini.ts`; Test: `packages/core/src/providers/gemini.test.ts` | S3-T2, S3-T3 |
| 4 | S3-T8 Tool loop wiring and finish reasons | Modify: `apps/daemon/src/assistant/tool-loop.ts`; Test: `apps/daemon/src/assistant/tool-loop.test.ts`; Modify: `apps/daemon/src/jobs/assistant.ts` | S3-T2, S3-T6, S3-T7 |
| 4 | S3-T9 Live buffer, route and progress events | Create: `apps/daemon/src/assistant/live-buffer.ts`; Test: `apps/daemon/src/assistant/live-buffer.test.ts`; Modify: `packages/http/src/routes/assistant-runs.ts`; Test: `packages/http/src/routes/assistant-runs.test.ts`; Modify: `apps/daemon/src/assistant/run-recorder.ts` | S3-T2 |
| 5 | S3-T10 Dashboard live text and progress | Modify: `packages/dashboard/src/api/runs.ts`; Create: `packages/dashboard/src/pages/assistant-live-buffer.tsx`; Test: `packages/dashboard/src/pages/assistant-live-buffer.test.tsx`; Modify: `packages/dashboard/src/pages/assistant-tuning.tsx`; Test: `packages/dashboard/src/pages/assistant-tuning.test.tsx`; Modify: `packages/dashboard/src/pages/assistant-live.tsx` | S3-T4, S3-T9 |
| 5 | S3-T11 State and privacy paperwork | Modify: `docs/STATE.md`; Modify: `PRIVACY.md` | S3-T1 |

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

Job-lanes merged, so the body-read code it wrapped can be replaced with streaming. OpenRouter sends `: OPENROUTER PROCESSING` keepalive comments and reports mid-stream failures as `finish_reason: "error"` inside a 200 response. Gemini 3 uses `thinkingConfig.thinkingLevel` (`low` tool rounds, `medium` answer; never `minimal`, which errors on 3.8 Flash) with `includeThoughts: true` for thought summaries. The 60 s job-lanes total becomes time-to-first-byte. D5(b) keeps thinking live plus saved in the trace; ADR 0129 stays metadata-only for the ledger.

## Decision

1. Stream every provider: OpenAI-compatible sends `stream: true` plus `stream_options: { include_usage: true }`, parses SSE `data:` lines, ignores `:` comments, assembles `delta.content`, `delta.reasoning`, `delta.tool_calls` (args concatenated per index, parsed when complete); Gemini calls `:streamGenerateContent?alt=sse`, assembling text, `functionCall` and `thought: true` parts separately, echoing raw parts back so thought signatures survive tool rounds.
2. Timeouts: idle `assistant.providerIdleTimeoutMs` 45,000 re-armed on every byte (keepalives count); ceiling `assistant.providerMaxCallMs` 300,000; `assistant.providerTimeoutMs` 60,000 becomes time-to-first-byte. Typing stays alive while bytes arrive.
3. Finish reasons: `error` or `choices[].error` → retryable `ProviderError`, partial text kept for the trace and never delivered; `length` with text → delivered with code-built `-# (cut short)`; `length` with no text → today's empty-answer path. `maxOutputTokens` default 2,048 → 4,096.
4. Progress: `model-progress { round, answerChars, reasoningChars, keepalives, msSinceLastByte }` at most every 3 s, bumping `updatedAt`; renders as `Receiving… 1,240 chars of answer, 3,100 chars of thinking`.
5. Live text: in-memory per-run buffer capped at 8,000 chars each of answer and thinking; `GET /api/assistant/runs/:runId/live` gated like traces; StepLog polls every 2 s (no browser SSE); buffer dropped at finish; thinking saved under trace `reasoning` per round, capped. OpenRouter gets `reasoning: { exclude: false }` only when the model supports it (after Slice 6: gated on capabilities); Gemini returns thought summaries via `includeThoughts`.

## Consequences

- One trickling stream can hold a job lane up to 300 s by design; four lanes stay the cap.
- Thinking text may echo member messages; it is visible with trace capability only, noted in PRIVACY.md, and deleted with the conversation.
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
**Interfaces:** Consumes: none · Produces: `export interface StreamProgress { readonly round: number; readonly answerChars: number; readonly reasoningChars: number; readonly keepalives: number; readonly msSinceLastByte: number }`; `GenerateTextRequest` gains `thinkingLevel?: 'low' | 'medium' | 'high'` and `onProgress?: (progress: StreamProgress) => void`; `GenerateTextResponse` gains `reasoning?: string`; run event `model-progress { round, answerChars, reasoningChars, keepalives, msSinceLastByte }`

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

- [ ] **Step 3: Implement** — anchor: `packages/core/src/providers/contracts.ts` lines 42–75 (`GenerateTextRequest` with `thinkingBudget`, `GenerateTextResponse` with `text`, `model`, `finishReason`). Replacement adds after the `thinkingBudget` line: `readonly thinkingLevel?: 'low' | 'medium' | 'high';` and after the `tools` line: `readonly onProgress?: (progress: StreamProgress) => void;`, adds the `StreamProgress` interface above `GenerateTextRequest`, and adds `readonly reasoning?: string;` to `GenerateTextResponse` after `text`. Anchor: `packages/core/src/assistant/run-events.ts` the `model-result` object (lines 83–103). Append a new `.strict()` object after the `model-skipped` object (lines 104–113): `{ kind: z.literal('model-progress'), round: int >= 0, answerChars: int >= 0, reasoningChars: int >= 0, keepalives: int >= 0, msSinceLastByte: int >= 0 }`. (after Slice 6: keep the new ProviderError quota fields `quotaScope 'day' | 'minute'`, `retryAfterMs`, `learnedLimit` untouched when adapters are rewritten; keep the `GeminiModelProfile` table entry type name from contracts §3 — the existing `GeminiModelInfo` in `packages/core/src/providers/gemini.ts` is a different interface and must not be renamed or reused.)
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/assistant/run-events.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/providers/contracts.ts packages/core/src/assistant/run-events.ts packages/core/src/assistant/run-events.test.ts` then `npx eslint packages/core/src/providers/contracts.ts packages/core/src/assistant/run-events.ts packages/core/src/assistant/run-events.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/providers/contracts.ts packages/core/src/assistant/run-events.ts packages/core/src/assistant/run-events.test.ts && git commit -m "Slice 3 T2: stream contracts and model-progress event"`

**Done when:** `runEventSchema` parses `model-progress` and rejects one carrying `text`; `StreamProgress`, `thinkingLevel`, `onProgress`, `reasoning` exist in contracts.

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
- [ ] **Step 3: Implement** — full `packages/core/src/providers/sse.ts`: buffer text across chunks, split on `\n`, hold a trailing partial line, on blank line flush the pending `data:` lines; a line starting with `:` yields keepalive; `data: [DONE]` ends the stream; strip one leading space after `data:`; join multiple data lines with `\n`. Accept both `ReadableStream<Uint8Array>` (read via `getReader`, decode with `TextDecoder` streaming) and `AsyncIterable<string>`.
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/providers/sse.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/providers/sse.ts packages/core/src/providers/sse.test.ts` then `npx eslint packages/core/src/providers/sse.ts packages/core/src/providers/sse.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/providers/sse.ts packages/core/src/providers/sse.test.ts && git commit -m "Slice 3 T3: shared SSE parser"`

**Done when:** keepalive comments, split chunks, multi-line data and `[DONE]` all parse per the four tests.

### S3-T4: Timeout and token settings   ·   Wave 2
**Owns:** Modify: `packages/core/src/settings/instance-settings.ts`; Test: `packages/core/src/settings/instance-settings.test.ts`
**Reads (do not edit):** `docs/decisions/0148-assistant-streaming-timeouts-live-progress.md`
**Interfaces:** Consumes: ADR 0148 numbers · Produces: settings `assistant.providerIdleTimeoutMs` (45,000), `assistant.providerMaxCallMs` (300,000), `assistant.maxOutputTokens` default 4,096

- [ ] **Step 1: Write the failing test** — in `packages/core/src/settings/instance-settings.test.ts`, after the existing `channel context defaults` test (line 38), add:

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

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/settings/instance-settings.test.ts --maxWorkers=1` · Expected: FAIL with `providerIdleTimeoutMs` undefined and maxOutputTokens 2048
- [ ] **Step 3: Implement** — anchor: `packages/core/src/settings/instance-settings.ts` the `providerTimeout` const (lines 63–72) and the `maxOutputTokens` const (lines 107–115, `defaultValue: 2048`). Replacement: append after `providerTimeout` two new consts in the same shape, group `'Assistant retries'`, display `'seconds'`, labels `Provider idle timeout` / `Provider max call time`, help `How long one AI answer may go without any data before it is abandoned. Keepalive messages count as data.` / `The longest one AI answer may take in total, even when data keeps arriving.`, schemas `z.number().int().min(5000).max(120000)` / `z.number().int().min(60000).max(600000)`, defaults `45000` / `300000`, matching bounds; add both to `INSTANCE_SETTINGS` right after `providerTimeout` and to `InstanceSettingValues`; change `maxOutputTokens` defaultValue to `4096` (bounds unchanged).
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/settings/instance-settings.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/settings/instance-settings.ts packages/core/src/settings/instance-settings.test.ts` then `npx eslint packages/core/src/settings/instance-settings.ts packages/core/src/settings/instance-settings.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/settings/instance-settings.ts packages/core/src/settings/instance-settings.test.ts && git commit -m "Slice 3 T4: streaming timeout and token settings"`

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
- [ ] **Step 3: Implement** — anchor: `packages/core/src/assistant/trace.ts` the `assistantTraceSchema` `toolCalls` array (ends line ~108) and `capTrace` (line 229). Replacement: add after `toolCalls` an optional `reasoning` array field with the shape in Interfaces; extend `capTrace` so each `reasoning` entry over 8,000 chars is cut with the existing `truncateTo` helper (same `… [truncated]` suffix) and `capTrace` also shrinks `reasoning` entries when the 200 KB budget is exceeded (after tool previews, before giving up).
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/assistant/trace.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/assistant/trace.ts packages/core/src/assistant/trace.test.ts` then `npx eslint packages/core/src/assistant/trace.ts packages/core/src/assistant/trace.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/assistant/trace.ts packages/core/src/assistant/trace.test.ts && git commit -m "Slice 3 T5: trace reasoning field"`

**Done when:** a trace round-trips `reasoning` entries; entries over 8,000 chars are truncated with the standard suffix.


**Done when:** the two new keys exist with the ADR defaults and bounds; maxOutputTokens defaults to 4,096; every existing test still passes.


### S3-T6: OpenAI-compatible streaming   ·   Wave 3
**Owns:** Modify: `packages/core/src/providers/openai-compatible.ts`; Test: `packages/core/src/providers/openai-compatible.test.ts`
**Reads (do not edit):** `packages/core/src/providers/sse.ts` (S3-T3), `packages/core/src/providers/contracts.ts` (`StreamProgress`, `onProgress`), `packages/core/src/providers/errors.ts`
**Interfaces:** Consumes: `parseSseStream` from S3-T3; `StreamProgress` from S3-T2 · Produces: `OpenAiCompatibleProvider.generateText` streams with `stream: true`, `stream_options: { include_usage: true }`, `reasoning: { exclude: false }`, idle/ceiling timers and `reasoning` in the response

- [ ] **Step 1: Write the failing test** — in `packages/core/src/providers/openai-compatible.test.ts`, using its `vi.fn` fetch style, add:

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
  const res = await provider.generateText({
    model: 'm',
    messages: [{ role: 'user', text: 'hi Sam L' }],
    onProgress: (p) => { seen.push({ answerChars: p.answerChars, keepalives: p.keepalives }); },
  });
  expect(res.text).toBe('hello');
  expect(res.reasoning).toBe('why');
  expect(res.toolCalls).toEqual([{ id: 'c1', name: 'search_sources', args: { que: 1 } }]);
  expect(seen.some((s) => s.keepalives >= 1)).toBe(true);
  expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({
    stream: true,
    stream_options: { include_usage: true },
    reasoning: { exclude: false },
  });

  expect(seen.length).toBeGreaterThanOrEqual(1);
});

it('turns mid-stream finish_reason error into a retryable ProviderError', async () => {
  const body = 'data: {"choices":[{"delta":{"content":"part"},"finish_reason":"error","error":{"message":"upstream broke"}}]}\n\n';
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
  const err = await provider.generateText({ model: 'm', messages: [{ role: 'user', text: 'hi' }] }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err).toMatchObject({ kind: 'outage', retryable: true });
});

it('delivers length text with reasoning and usage, and reports time-to-first-byte', async () => {
  const body =
    'data: {"choices":[{"delta":{"content":"half","reasoning":"why"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":2,"completion_tokens":9,"total_tokens":11}}\n\n' +
    'data: [DONE]\n\n';
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
  const ttfb: number[] = [];
  const res = await provider.generateText({
    model: 'm',
    messages: [{ role: 'user', text: 'hi Sam L' }],
    onProgress: (p) => { ttfb.push(p.msSinceLastByte); },
  });
  expect(res.text).toBe('half');
  expect(res.reasoning).toBe('why');
  expect(res.finishReason).toBe('length');
  expect(res.usage).toMatchObject({ promptTokens: 2, completionTokens: 9, totalTokens: 11 });
  expect(ttfb.length).toBeGreaterThanOrEqual(1);
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
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/providers/openai-compatible.test.ts --maxWorkers=1` · Expected: FAIL with `stream: true` missing from the request body and no `reasoning` on the response
- [ ] **Step 3: Implement** — anchor: `OpenAiCompatibleProvider.generateText` body build and `response.json()` success path (lines ~300–474). Replacement: send `stream: true`, `stream_options: { include_usage: true }`, `reasoning: { exclude: false }` (after Slice 6: only when the entry `GeminiModelProfile` table capabilities allow reasoning — the name `GeminiModelInfo` already exists in `packages/core/src/providers/gemini.ts` for a different interface, so the Slice 6 type keeps the new name); read `response.body` through `parseSseStream`; assemble `delta.content`, `delta.reasoning`, and per-index `tool_calls[].function.arguments` fragments (concatenate per `index`, parse the joined JSON only when the stream ends, using the existing `parseToolArguments` helper); count every `:` comment as a keepalive and re-arm the idle timer on it; fire `onProgress` at most every 3 s with `{ round: 0, answerChars, reasoningChars, keepalives, msSinceLastByte }`; record time-to-first-byte from the existing `timeoutMs` and abort on first-byte, idle (45 s default, re-armed on every byte) and ceiling (300 s) timers; map `finish_reason: "error"` or `choices[].error` to retryable `ProviderError('outage', …)` keeping partial text as trace evidence and never delivering it; pass `length` through as `finishReason` with text, reasoning and usage intact so S3-T8 can append `-# (cut short)`; keep every existing error mapping and ProviderError field (after Slice 6: plus `quotaScope`, `retryAfterMs`, `learnedLimit`). Return `reasoning` alongside `text`, `toolCalls`, `usage`, `finishReason`, `upstream`.
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/providers/openai-compatible.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/providers/openai-compatible.ts packages/core/src/providers/openai-compatible.test.ts` then `npx eslint packages/core/src/providers/openai-compatible.ts packages/core/src/providers/openai-compatible.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/providers/openai-compatible.ts packages/core/src/providers/openai-compatible.test.ts && git commit -m "Slice 3 T6: OpenAI-compatible streaming"`

**Done when:** streamed deltas assemble text, reasoning and whole tool args; keepalives are ignored but counted and re-arm the idle timer; mid-stream `error` is retryable and never delivered; `length` keeps text plus usage; request carries `stream: true` and usage options.

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
