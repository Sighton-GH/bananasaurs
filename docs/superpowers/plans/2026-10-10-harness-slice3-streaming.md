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
| 4 | S3-T8 Tool loop wiring and finish reasons | Modify: `apps/daemon/src/assistant/tool-loop.ts`; Test: `apps/daemon/src/assistant/tool-loop.test.ts` | S3-T2, S3-T6, S3-T7 |
| 4 | S3-T9 Live buffer, route and progress events | Create: `apps/daemon/src/assistant/live-buffer.ts`; Test: `apps/daemon/src/assistant/live-buffer.test.ts`; Modify: `packages/http/src/routes/assistant-runs.ts`; Test: `packages/http/src/routes/assistant-runs.test.ts`; Modify: `apps/daemon/src/assistant/run-recorder.ts` | S3-T2 |
| 5 | S3-T10 Dashboard live text and progress | Modify: `packages/dashboard/src/api/runs.ts`; Create: `packages/dashboard/src/pages/assistant-live-buffer.tsx`; Test: `packages/dashboard/src/pages/assistant-live-buffer.test.tsx`; Modify: `packages/dashboard/src/pages/assistant-tuning.tsx`; Test: `packages/dashboard/src/pages/assistant-tuning.test.tsx` | S3-T4, S3-T9 |
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
  const trace = minimalTrace({ reasoning: [{ round: 1, text: 'x'.repeat(9000) }] });
  const capped = capTrace({ ...trace, answer: 'a'.repeat(199_000) });
  expect(capped.reasoning?.[0]?.text.length).toBeLessThanOrEqual(8000);
  expect(capped.reasoning?.[0]?.text.endsWith('… [truncated]')).toBe(true);
});
```

using that file's existing `minimalTrace` helper (read the file; it builds a valid `AssistantTrace` with overrides).

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/assistant/trace.test.ts --maxWorkers=1` · Expected: FAIL with `reasoning` unknown key or `capTrace` not capping it
- [ ] **Step 3: Implement** — anchor: `packages/core/src/assistant/trace.ts` the `assistantTraceSchema` `toolCalls` array (ends line ~108) and `capTrace` (line 229). Replacement: add after `toolCalls` an optional `reasoning` array field as above; extend `capTrace` so each `reasoning` entry over 8,000 chars is cut with the existing `truncateTo` helper (same `… [truncated]` suffix) and `capTrace` also shrinks `reasoning` entries when the 200 KB budget is exceeded (after tool previews, before giving up).
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/assistant/trace.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/assistant/trace.ts packages/core/src/assistant/trace.test.ts` then `npx eslint packages/core/src/assistant/trace.ts packages/core/src/assistant/trace.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/assistant/trace.ts packages/core/src/assistant/trace.test.ts && git commit -m "Slice 3 T5: trace reasoning field"`

**Done when:** a trace round-trips `reasoning` entries; entries over 8,000 chars are truncated with the standard suffix.


**Done when:** the two new keys exist with the ADR defaults and bounds; maxOutputTokens defaults to 4,096; every existing test still passes.


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

- [ ] **Step 3: Implement** — anchor: `packages/core/src/providers/contracts.ts` lines 42–75 (`GenerateTextRequest` with `thinkingBudget`, `GenerateTextResponse` with `text`, `model`, `finishReason`). Replacement adds after the `thinkingBudget` line: `readonly thinkingLevel?: 'low' | 'medium' | 'high';` and after the `tools` line: `readonly onProgress?: (progress: StreamProgress) => void;`, adds the `StreamProgress` interface above `GenerateTextRequest`, and adds `readonly reasoning?: string;` to `GenerateTextResponse` after `text`. Anchor: `packages/core/src/assistant/run-events.ts` the `model-result` object (lines 83–103). Append a new `.strict()` object after the `model-skipped` object (lines 104–113): `{ kind: z.literal('model-progress'), round: int >= 0, answerChars: int >= 0, reasoningChars: int >= 0, keepalives: int >= 0, msSinceLastByte: int >= 0 }`. (after Slice 6: keep the new ProviderError quota fields `quotaScope 'day' | 'minute'`, `retryAfterMs`, `learnedLimit` untouched when adapters are rewritten; keep `ModelCapabilities` names from contracts §3.)
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/assistant/run-events.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/providers/contracts.ts packages/core/src/assistant/run-events.ts packages/core/src/assistant/run-events.test.ts` then `npx eslint packages/core/src/providers/contracts.ts packages/core/src/assistant/run-events.ts packages/core/src/assistant/run-events.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/providers/contracts.ts packages/core/src/assistant/run-events.ts packages/core/src/assistant/run-events.test.ts && git commit -m "Slice 3 T2: stream contracts and model-progress event"`

**Done when:** `runEventSchema` parses `model-progress` and rejects one carrying `text`; `StreamProgress`, `thinkingLevel`, `onProgress`, `reasoning` exist in contracts.

- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write docs/decisions/0148-assistant-streaming-timeouts-live-progress.md` then `npx eslint docs/decisions/0148-assistant-streaming-timeouts-live-progress.md` · exit 0
- [ ] **Step 7: Commit** — `git add docs/decisions/0148-assistant-streaming-timeouts-live-progress.md && git commit -m "Slice 3 T1: ADR 0148 streaming timeouts live progress"`

**Done when:** ADR 0148 exists with Context/Decision/Consequences; S3-T4 and S3-T11 can quote its numbers.


## Tasks



