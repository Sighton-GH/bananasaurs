# Slice 4: attachments — implementation plan

> **Instinct plan.** Read with `2026-10-10-harness-00-instinct-handoff.md` and `2026-10-10-harness-00-shared-contracts.md`.
> **Status:** READY — refreshed against harness-round2 (Slices 6, 2, 3, 5 merged)

**Goal:** Members can attach text files, images and PDFs to a question and the bot reads what the answering model natively supports, saying plainly what it cannot see.
**Spec:** docs/superpowers/specs/2026-10-09-assistant-harness-capability-design.md §4 (Slice 4: 4a–4d and the caps table)
**ADRs:** 0149  **Migration:** none
**Base:** harness-round2 @ 3e495a9b

## Refresh notes

- Base is now `harness-round2 @ 3e495a9b`; status is READY. Slices 6, 2, 3 and 5 are merged.
- Added S4-T13 (production wiring: `guild.ts` builds `fetchAttachmentBytes` and the live caps) and moved state/privacy docs to S4-T14.
- Slice 3 merged: both adapters stream over SSE only (no non-streaming success path). T7/T8 tests use the `sse()`/`response()` streaming helpers and pin the streaming endpoint/body.
- Slice 6 merged: `ChainEntry.capabilities` is optional and filled per request by the provider store; adapters gate on `request.capabilities` with conservative defaults. T11 treats absent entry capabilities as text-only.
- `assertOutboundRequestSafe` reads message text only, so base64 media bytes never reach the scan; ADR 0149 decision 4 is reworded to say exactly that.
- The router already receives `hasAttachments` (mention flow sets it, `routeRun` keeps attachment runs on standard). No task re-plans it.
- Instance settings are now 34 (T3 goes 34 → 41 and updates both count pins); migrations end at `drizzle/0109_daily_digests.sql`, next free is 0110; this slice ships no migration.
- Fixed stale anchors throughout (`toContents`, `toWireMessage`, `fetchMessageContent`, tool-loop chain/messages lines, the job invoke call, the three cursor `included` copies) and the missing `expectTypeOf` import in T2's test.
- T4 now owns `packages/core/src/discord/port.ts` in the Waves row (it was in Owns but missing from the row).
- T6/T9 tests are rewritten onto the current harnesses (`h.run(mention(...))`, `setupB2b`, `capture()`); T12 tests use `fixtureTrace` and `result.detail`.
- T12 updates all three `included` copies in `jobs/assistant.ts` (cursor, failure trace, success trace), not just the cursor.

## Global Constraints

- `CLAUDE.md` hard rules 1–9 apply. In particular: AI is never in the enforcement path; every query, key and job
  carries a guild id; model output passes Zod; every Discord side effect has a durable idempotency key; no secrets
  in code, logs or fixtures; no new outbound destination unless the slice's ADR records the owner's instruction.
- No new dependency.
- Fixtures use invented names (Sam L, Alex P, Car Team A). Never a real member's name or id.
- Canadian English, plain words in prompts and dashboard copy. No tool names shown to members.
- Write the failing test first for anything touching permissions, pings, idempotency, retention or guild scope, and
  watch it fail before writing the code.
- Slice 4 caps (all instance settings under `assistant.attachments…`, §4.7): text files at most 256 KB and 24,000
  chars each, at most 3 per message; images at most 5 MB each, at most 4 per message; PDFs at most 10 MB each, at
  most 2 per message. Only the current message and the replied-to message are read. A count of 0 disables that kind.
- Attachment fetches go to the Discord CDN only (`cdn.discordapp.com`, `media.discordapp.net`), HTTPS, through the
  existing fetch security primitives (host allowlist, DNS pinning, public-address check, per-hop redirect
  re-check, size caps, magic-byte checks). The ADR records the owner's D7 instruction for this destination (hard rule 8).
- No PDF parsing, extraction or OCR anywhere in Bananasaurs (D7b). PDFs go to a model only when the model reads them
  natively (Gemini `inlineData`; OpenRouter models whose catalogue listing has `file` input, with the file-parser plugin
  pinned to `native` so OpenRouter never substitutes `mistral-ocr` or `cloudflare-ai`). Otherwise the bot says
  plainly it cannot read PDFs.
- The outbound safety scan reads message text only (`requestSections` in `packages/core/src/providers/outbound-safety.ts`):
  base64 image/PDF bytes in `GenerationMessage.media` never reach it. That is an accepted gap, written into ADR 0149.
- Attached text is evidence: redacted with `redactEvidenceText`, neutralised, framed as `[UNTRUSTED ATTACHMENT …]`.
  It is never put in the job payload or the run ledger beyond counts. The trace records counts, sizes and types,
  never pixels or file bytes.
- Both provider adapters stream over SSE (`packages/core/src/providers/sse.ts` with `invokeStreamCallback` from
  `callbacks.ts`); there is no non-streaming success path. Inline media is sent in the streaming request bodies.
- `ChainEntry.capabilities?: ModelCapabilities` is optional; adapters fall back to `geminiCapabilities(model)` /
  `TEXT_AND_TOOLS_ONLY`. Media goes only to entries whose capabilities include that media type; a text-only entry
  gets the plain-text attachment note instead. The router already receives `hasAttachments`; no task changes that.
- Instance settings are now 34; `packages/core/src/settings/instance-settings.test.ts` and
  `packages/http/src/routes/assistant-tuning.test.ts` pin the count. S4-T3 updates both.
- Migrations end at `drizzle/0109_daily_digests.sql`; the next free number is 0110 (generated with
  `npm run db:generate -- --name <name>`, never hand-numbered). This slice ships no migration.
- Words such as "fixture", "staged rollout" in production identifiers trip the ADR 0121 vocabulary scan.

## Plan decisions

- New settings group `Assistant attachments` (additive to the `SettingGroup` union); keys `assistant.attachments.*`.
- A count of 0 disables that kind (no boolean display type exists in the registry); each count help text says so.
- Attachment bytes travel as `GenerationMessage.media` (contracts §3); the trace's `included` gains an optional
  `attachments` summary (counts, sizes, types) so no migration is needed.
- Binary fetches get a `fetchBytes` method on `ReviewedResourceFetcher` reusing its resolve/pinned-request/redirect
  logic, because the existing `fetch()` enforces text-only types, decodes to UTF-8 which corrupts images and PDFs,
  and caches text evidence. `fetchBytes` takes per-call `{ allowedHosts, maxBytes }`, re-checks the allowlist on
  every redirect hop, never caches, and returns raw bytes plus the media type.
- The CDN `url` is preferred, `proxy_url` is the fallback; both are Discord-signed and expire in about 24 h, so the
  job re-reads both messages through REST at job start (never trusts gateway-cached URLs — the gateway event
  carries `MessageAttachment` metadata with no URL at all, so reuse is impossible by construction).
- Static GIFs only: a GIF carrying a `NETSCAPE2.0` application extension is refused as animated.
- Text sniffing by extension (`.txt .md .markdown .json .js .ts .tsx .py .rb .go .rs .java .c .h .cpp .css .html .xml
  .yml .yaml .toml .ini .cfg .log .csv .sh`) covers code files Discord serves as `application/octet-stream`.
- Media preference composes with tier order: the service tiers the chain first (`orderChainByTier`), then the tool
  loop applies a stable preference for entries whose capabilities cover everything attached.
- Per-entry media filtering happens in the tool loop's `runEntry`: an entry receives only the media its capabilities
  allow, plus a plain marker line per stripped file on the last user message. The filter also covers the resume
  branch (a previously stripped file is already gone from `media`, so no marker repeats).
- Production wiring lives in `apps/daemon/src/runtime/guild.ts` (S4-T13): one `ReviewedResourceFetcher` plus an
  `attachmentCaps` closure reading the seven live settings (D7 defaults when settings are absent), passed as the
  job's `fetchAttachmentBytes` / `attachmentCaps` deps. The per-call settings getters make dashboard changes live
  without a restart.
- The tuning page renders registry settings generically, so no new dashboard component is needed; the dashboard task
  only extends the page test with the new keys.

## Review Focus

1. **A 6 MB image and a 12 MB PDF.** Expect refusal before any fetch (`too-large` on the declared size), no provider
   call carrying bytes, and a marker line. Pinned in Task 5 and Task 6.
2. **A `.txt` pasted as an attachment with an empty message body.** Expect the marker plus the framed text, fixing
   "There's no pasted text in your message". Pinned in Task 4 and Task 6.
3. **A PDF asked of a model without PDF input.** Expect no PDF bytes on the wire and the plain "you can't read PDFs
   right now" line, never a guess. Pinned in Task 11.
4. **An OpenRouter request carrying a PDF without exactly `plugins: [{ id: "file-parser", pdf: { engine: "native" }
   }]`.** Expect the Task 8 test to fail. Pinned in Task 8.
5. **An expired CDN URL on a job retry.** Expect the job to re-read the message through REST at start rather than
   reuse a stored URL. Pinned in Task 6.

## Waves

| Wave | Task | Owns (create/modify) | Depends on |
|---|---|---|---|
| 1 | S4-T1 ADR 0149 | Create: `docs/decisions/0149-attachment-fetch-and-native-media.md` | — |
| 1 | S4-T2 media types | Modify: `packages/core/src/providers/contracts.ts`; Create: `packages/core/src/providers/generation-media.test.ts` | — |
| 1 | S4-T3 attachment settings | Modify: `packages/core/src/settings/instance-settings.ts`, `packages/core/src/settings/instance-settings.test.ts`, `packages/http/src/routes/assistant-tuning.test.ts` | — |
| 2 | S4-T4 markers everywhere | Modify: `packages/core/src/discord/port.ts`, `packages/discord/src/rest/port.ts`, `packages/discord/src/rest/port.test.ts`, `apps/daemon/src/assistant/conversation-context.ts`, `apps/daemon/src/assistant/conversation-context.test.ts`, `apps/daemon/src/assistant/channel-context.ts`, `apps/daemon/src/assistant/channel-context.test.ts`, `apps/daemon/src/assistant/user-message.ts`, `apps/daemon/src/assistant/user-message.test.ts` | T2 |
| 2 | S4-T5 fetcher and byte checks | Modify: `apps/daemon/src/assistant/resource-fetcher.ts`, `apps/daemon/src/assistant/resource-fetcher.test.ts`; Create: `apps/daemon/src/assistant/attachments.ts`, `apps/daemon/src/assistant/attachments.test.ts` | T2, T3 |
| 3 | S4-T6 text files into the turn | Modify: `apps/daemon/src/jobs/assistant.ts`, `apps/daemon/src/jobs/assistant.test.ts` | T4, T5 |
| 3 | S4-T7 Gemini sends media | Modify: `packages/core/src/providers/gemini.ts`, `packages/core/src/providers/gemini.test.ts` | T2 |
| 3 | S4-T8 OpenRouter sends images and PDFs | Modify: `packages/core/src/providers/openai-compatible.ts`, `packages/core/src/providers/openai-compatible.test.ts` | T2 |
| 4 | S4-T9 media plumbing job to loop | Modify: `apps/daemon/src/assistant/commands.ts`, `apps/daemon/src/assistant/service.ts`, `apps/daemon/src/assistant/service.test.ts`, `apps/daemon/src/jobs/assistant.ts`, `apps/daemon/src/jobs/assistant.test.ts`, `apps/daemon/src/assistant/attachments.ts`, `apps/daemon/src/assistant/attachments.test.ts` | T2, T5, T6 |
| 4 | S4-T10 tuning page shows the caps | Modify: `packages/dashboard/src/pages/assistant-tuning.test.tsx` | T3 |
| 5 | S4-T11 capability routing and markers | Create: `apps/daemon/src/assistant/media-routing.ts`, `apps/daemon/src/assistant/media-routing.test.ts`; Modify: `apps/daemon/src/assistant/tool-loop.ts`, `apps/daemon/src/assistant/tool-loop.test.ts` | T2, T9 |
| 5 | S4-T12 trace attachment summary | Modify: `packages/core/src/assistant/trace.ts`, `packages/core/src/assistant/trace.test.ts`, `apps/daemon/src/assistant/service.ts`, `apps/daemon/src/assistant/service.test.ts`, `apps/daemon/src/jobs/assistant.ts`, `apps/daemon/src/jobs/assistant.test.ts` | T9 |
| 6 | S4-T13 production attachment wiring | Modify: `apps/daemon/src/runtime/guild.ts`, `apps/daemon/src/runtime/guild-ledger.test.ts` | T5, T9 |
| 7 | S4-T14 state and privacy lines | Modify: `docs/STATE.md`, `PRIVACY.md` | T1–T13 |

## Tasks

### S4-T1: ADR 0149, attachment fetch destination and native media   ·   Wave 1
**Owns:** Create: `docs/decisions/0149-attachment-fetch-and-native-media.md`
**Reads (do not edit):** `docs/decisions/0137-read-only-tools-in-later-rounds.md` (ADR style), `docs/decisions/0120-tavily-search-and-search-key-limits.md` (rule-8 destination wording)
**Interfaces:** Consumes: none · Produces: none (documents)

- [ ] **Step 1: Write the failing test** — no test; this task is documents only. Verify the number is free: `git status --short docs/decisions/0149-*` shows nothing and `ls docs/decisions/ | grep 0149` is empty (neighbours are 0148 and 0150).
- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/providers/generation-media.test.ts --maxWorkers=1` · Expected: FAIL with "No test files found" (the contract test lands in S4-T2 against this ADR).
- [ ] **Step 3: Implement** — write the file below in full, verbatim except the date if today differs:

```markdown
# 0149. Attachment fetch destination; images and PDFs to providers, native only

Date: 2026-10-10

Status: accepted (owner decisions D7, D7b, 2026-10-10).

## Context

Members attach text files, images and PDFs to questions and the bot cannot see any of them: `handleMention`
drops the event's attachments, the quote fetch keeps only `content`, channel lines show `[attachment]` only when
the text is empty, and the providers are text-only on the wire. The owner directed (D7) that the bot read text
files (at most 256 KB, inline at most 24,000 chars, at most 3 files), images (at most 5 MB each, at most 4) and
PDFs (at most 10 MB, at most 2), covering the current message and the replied-to message. Audio and video are
deferred. Fetching from Discord's CDN is a new outbound destination under hard rule 8, and this ADR is the
record of the owner's instruction.

## Decision

1. The bot fetches attachment bytes from `cdn.discordapp.com` and `media.discordapp.net` only, over HTTPS,
   reusing the existing fetch security primitives (DNS pinning, public-address check, per-hop redirect
   allowlist re-check, size caps) plus magic-byte checks (PNG, JPEG, WebP, static GIF, `%PDF-`). A wrong magic
   number, an oversize file, a host outside the allowlist, or a redirect to another host is refused before any
   provider call. Each refusal has a test, refusal-first.
2. PDFs and images go to the AI provider only when the answering model reads them natively: Gemini as `inlineData`
   parts, OpenRouter models whose catalogue listing has `file` input with the file-parser plugin pinned to
   `plugins: [{ id: "file-parser", pdf: { engine: "native" } }]`, so OpenRouter never substitutes `mistral-ocr`
   (paid) or `cloudflare-ai` (a third party). There is no local PDF parsing, extraction, OCR, or parsing service
   anywhere (D7b). A model without the input gets a plain marker instead of the file, and the bot says so.
3. Attached text is untrusted evidence: redacted, neutralised, capped, framed as `[UNTRUSTED ATTACHMENT …]`, and
   never stored in the job payload or the run ledger beyond counts. The trace records counts, sizes and types,
   never pixels or bytes.
4. The outbound safety scan reads message text only (`requestSections` in `outbound-safety.ts`), so base64
   image/PDF bytes in `GenerationMessage.media` never reach it. That is an accepted gap: attached text passes
   `redactEvidenceText`, pixels cannot be scanned locally, and scanning them would need a service D7b forbids.

## Consequences

- `cdn.discordapp.com` and `media.discordapp.net` join the allowed outbound destinations for attachment fetches
  only; every other fetch keeps its own allowlist.
- `PRIVACY.md` says attached PDFs, images and text files go to the AI provider that answers, and to no one else.
- Caps are instance settings (`assistant.attachments.*`); a count of 0 disables that kind.
```

- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/settings/instance-settings.test.ts --maxWorkers=1` · Expected: PASS (untouched suite still green)
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format** — `npx prettier --write docs/decisions/0149-attachment-fetch-and-native-media.md` · exit 0 (Markdown is not linted)
- [ ] **Step 7: Commit** — `git add docs/decisions/0149-attachment-fetch-and-native-media.md && git commit -m "Slice 4 T1: ADR 0149 attachment fetch destination, native media only"`

**Done when:** the ADR file exists with Context, Decision and Consequences; `PRIVACY.md` wording for S4-T14 is fixed by Decision §2's last line.

---

### S4-T2: media on the provider contract   ·   Wave 1
**Owns:** Modify: `packages/core/src/providers/contracts.ts`; Create: `packages/core/src/providers/generation-media.test.ts`
**Reads (do not edit):** `packages/core/src/providers/openai-compatible.ts` lines 514–543 (`toWireMessage`, the shape the media must survive), `packages/core/src/providers/gemini.ts` lines 65–94 (`toContents`), `packages/core/src/providers/contracts.ts` lines 59–86 (`GenerateTextRequest.capabilities`: per-entry capabilities ride the request, media rides the messages)
**Interfaces:** Consumes: none · Produces: `export interface GenerationMedia { readonly kind: 'image' | 'pdf'; readonly mediaType: string; readonly dataBase64: string; readonly name: string }` · `GenerationMessage` gains `readonly media?: readonly GenerationMedia[]` (user turns only; base64 bytes, never logged, never scanned)

- [ ] **Step 1: Write the failing test** — create `packages/core/src/providers/generation-media.test.ts` with the full code below (note the `expectTypeOf` import; without it the file fails to compile):

```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { GenerationMedia, GenerationMessage } from './contracts.js';

describe('GenerationMedia (ADR 0149)', () => {
  it('carries image and pdf bytes on a user message only', () => {
    const media: readonly GenerationMedia[] = [
      { kind: 'image', mediaType: 'image/png', dataBase64: 'aGk=', name: 'chart.png' },
      { kind: 'pdf', mediaType: 'application/pdf', dataBase64: 'aGk=', name: 'report.pdf' },
    ];
    const message: GenerationMessage = { role: 'user', text: 'what is this?', media };
    expect(message.media).toHaveLength(2);
    expectTypeOf(message.media?.[0]?.kind).toEqualTypeOf<'image' | 'pdf' | undefined>();
    expectTypeOf(message.media?.[0]?.dataBase64).toEqualTypeOf<string | undefined>();
  });

  it('stays absent unless set', () => {
    const message: GenerationMessage = { role: 'user', text: 'hello' };
    expect(message.media).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/providers/generation-media.test.ts --maxWorkers=1` · Expected: FAIL with "GenerationMedia … has no exported member" / type error on `media`
- [ ] **Step 3: Implement** — in `packages/core/src/providers/contracts.ts`, after the `GenerationMessage` interface (lines 27–42), insert:

```ts
/** One attached file travelling to a model that reads it natively (ADR 0149). Base64 bytes: never logged, never scanned, never stored in a trace. */
export interface GenerationMedia {
  readonly kind: 'image' | 'pdf';
  readonly mediaType: string;
  readonly dataBase64: string;
  readonly name: string;
}
```

and inside `GenerationMessage`, after the `providerParts` field (lines 36–41), add:

```ts
  /**
   * On a user turn: attached image/PDF bytes for a model whose capabilities
   * allow them (ADR 0149). Stripped per entry before sending; markers replace
   * what an entry cannot read. Never written to a trace or log.
   */
  readonly media?: readonly GenerationMedia[];
```

- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/providers/generation-media.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/providers/contracts.ts packages/core/src/providers/generation-media.test.ts` then `npx eslint packages/core/src/providers/contracts.ts packages/core/src/providers/generation-media.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/providers/contracts.ts packages/core/src/providers/generation-media.test.ts && git commit -m "Slice 4 T2: GenerationMedia on the provider contract"`

**Done when:** the new test passes; existing provider tests are untouched and green; no wire format changes yet.

---

### S4-T3: attachment caps in the settings registry   ·   Wave 1
**Owns:** Modify: `packages/core/src/settings/instance-settings.ts`, `packages/core/src/settings/instance-settings.test.ts`, `packages/http/src/routes/assistant-tuning.test.ts`
**Reads (do not edit):** `packages/dashboard/src/pages/assistant-tuning.tsx` (renders every registry entry generically, so no page change is needed)
**Interfaces:** Consumes: none · Produces: seven keys `assistant.attachments.textMaxBytes` (default 262144), `assistant.attachments.textMaxChars` (default 24000), `assistant.attachments.textMaxCount` (default 3, min 0, max 10), `assistant.attachments.imageMaxBytes` (default 5242880), `assistant.attachments.imageMaxCount` (default 4, min 0, max 10), `assistant.attachments.pdfMaxBytes` (default 10485760), `assistant.attachments.pdfMaxCount` (default 2, min 0, max 10); group `Assistant attachments` (new additive `SettingGroup` value); a count of 0 disables that kind

- [ ] **Step 1: Write the failing test** — append to `packages/core/src/settings/instance-settings.test.ts`:

```ts
it('attachment caps default to the D7 table and a count of 0 disables that kind', () => {
  expect(INSTANCE_SETTINGS).toHaveLength(41);
  const def = (key: string) => settingDefinition(key);
  expect(def('assistant.attachments.textMaxBytes')?.defaultValue).toBe(262_144);
  expect(def('assistant.attachments.textMaxChars')?.defaultValue).toBe(24_000);
  expect(def('assistant.attachments.textMaxCount')?.defaultValue).toBe(3);
  expect(def('assistant.attachments.imageMaxBytes')?.defaultValue).toBe(5_242_880);
  expect(def('assistant.attachments.imageMaxCount')?.defaultValue).toBe(4);
  expect(def('assistant.attachments.pdfMaxBytes')?.defaultValue).toBe(10_485_760);
  expect(def('assistant.attachments.pdfMaxCount')?.defaultValue).toBe(2);
  for (const key of [
    'assistant.attachments.textMaxBytes',
    'assistant.attachments.textMaxChars',
    'assistant.attachments.textMaxCount',
    'assistant.attachments.imageMaxBytes',
    'assistant.attachments.imageMaxCount',
    'assistant.attachments.pdfMaxBytes',
    'assistant.attachments.pdfMaxCount',
  ]) {
    expect(def(key)?.group).toBe('Assistant attachments');
    expect(def(key)?.schema.safeParse(def(key)?.defaultValue).success, key).toBe(true);
  }
  expect(def('assistant.attachments.textMaxCount')?.schema.safeParse(0).success).toBe(true);
  expect(def('assistant.attachments.imageMaxCount')?.schema.safeParse(11).success).toBe(false);
  expect(def('assistant.attachments.pdfMaxBytes')?.schema.safeParse(0).success).toBe(false);
});
```

Also update the existing `has 34 definitions` test in the same file: change `expect(INSTANCE_SETTINGS).toHaveLength(34)` to `expect(INSTANCE_SETTINGS).toHaveLength(41)`. (The router/digest tests in that file use `toBeGreaterThanOrEqual` and need no change.)

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/settings/instance-settings.test.ts --maxWorkers=1` · Expected: FAIL with "expected 34 to have length 41" / `settingDefinition('assistant.attachments…')` undefined
- [ ] **Step 3: Implement** — in `packages/core/src/settings/instance-settings.ts`:
  - Add `'Assistant attachments'` to the `SettingGroup` union (lines 17–26, after `'Assistant context'`).
  - Add seven definitions after `channelContextMessages` (lines 146+, following its exact shape: `key`, `group: 'Assistant attachments'`, `label`, `help`, `display: 'count'`, zod `schema`, `defaultValue`, `bounds`):

```ts
const attachmentTextMaxBytes: SettingDefinition<number> = {
  key: 'assistant.attachments.textMaxBytes',
  group: 'Assistant attachments',
  label: 'Text attachment size limit',
  help: 'The largest text file read from a message, in bytes. Larger files are skipped with a note.',
  display: 'count',
  schema: z.number().int().min(1024).max(1_048_576),
  defaultValue: 262_144,
  bounds: { min: 1024, max: 1_048_576 },
};

const attachmentTextMaxChars: SettingDefinition<number> = {
  key: 'assistant.attachments.textMaxChars',
  group: 'Assistant attachments',
  label: 'Text attachment characters sent',
  help: 'How many characters of each text file are sent to the AI. Longer files are cut with a note.',
  display: 'count',
  schema: z.number().int().min(1000).max(100_000),
  defaultValue: 24_000,
  bounds: { min: 1000, max: 100_000 },
};

const attachmentTextMaxCount: SettingDefinition<number> = {
  key: 'assistant.attachments.textMaxCount',
  group: 'Assistant attachments',
  label: 'Text files read per message',
  help: 'How many text files are read from one message. 0 turns text attachments off.',
  display: 'count',
  schema: z.number().int().min(0).max(10),
  defaultValue: 3,
  bounds: { min: 0, max: 10 },
};

const attachmentImageMaxBytes: SettingDefinition<number> = {
  key: 'assistant.attachments.imageMaxBytes',
  group: 'Assistant attachments',
  label: 'Image size limit',
  help: 'The largest image sent to the AI, in bytes. Larger images are skipped with a note.',
  display: 'count',
  schema: z.number().int().min(1024).max(20_971_520),
  defaultValue: 5_242_880,
  bounds: { min: 1024, max: 20_971_520 },
};

const attachmentImageMaxCount: SettingDefinition<number> = {
  key: 'assistant.attachments.imageMaxCount',
  group: 'Assistant attachments',
  label: 'Images read per message',
  help: 'How many images are sent to the AI from one message. 0 turns image attachments off.',
  display: 'count',
  schema: z.number().int().min(0).max(10),
  defaultValue: 4,
  bounds: { min: 0, max: 10 },
};

const attachmentPdfMaxBytes: SettingDefinition<number> = {
  key: 'assistant.attachments.pdfMaxBytes',
  group: 'Assistant attachments',
  label: 'PDF size limit',
  help: 'The largest PDF sent to the AI, in bytes. Larger PDFs are skipped with a note.',
  display: 'count',
  schema: z.number().int().min(1024).max(31_457_280),
  defaultValue: 10_485_760,
  bounds: { min: 1024, max: 31_457_280 },
};

const attachmentPdfMaxCount: SettingDefinition<number> = {
  key: 'assistant.attachments.pdfMaxCount',
  group: 'Assistant attachments',
  label: 'PDFs read per message',
  help: 'How many PDFs are sent to the AI from one message. 0 turns PDF attachments off.',
  display: 'count',
  schema: z.number().int().min(0).max(10),
  defaultValue: 2,
  bounds: { min: 0, max: 10 },
};
```

  - Append all seven to `INSTANCE_SETTINGS` (after `channelContextMessages` in the array near line 478) and all seven keys to `InstanceSettingValues` (after `'assistant.channelContextMessages': number` near line 519).
  - In `packages/http/src/routes/assistant-tuning.test.ts`, update the pinned count `expect(body.settings).toHaveLength(34)` to `toHaveLength(41)` (the route lists the whole registry).
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/settings/instance-settings.test.ts packages/http/src/routes/assistant-tuning.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/settings/instance-settings.ts packages/core/src/settings/instance-settings.test.ts packages/http/src/routes/assistant-tuning.test.ts` then `npx eslint packages/core/src/settings/instance-settings.ts packages/core/src/settings/instance-settings.test.ts packages/http/src/routes/assistant-tuning.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/settings/instance-settings.ts packages/core/src/settings/instance-settings.test.ts packages/http/src/routes/assistant-tuning.test.ts && git commit -m "Slice 4 T3: attachment caps in the settings registry"`

**Done when:** registry holds 41 definitions; every default parses under its own schema; both count pins read 41; help texts are Canadian English with no tool names.

---

### S4-T4: markers everywhere, no network   ·   Wave 2
**Owns:** Modify: `packages/core/src/discord/port.ts`, `packages/discord/src/rest/port.ts`, `packages/discord/src/rest/port.test.ts`, `apps/daemon/src/assistant/conversation-context.ts`, `apps/daemon/src/assistant/conversation-context.test.ts`, `apps/daemon/src/assistant/channel-context.ts`, `apps/daemon/src/assistant/channel-context.test.ts`, `apps/daemon/src/assistant/user-message.ts`, `apps/daemon/src/assistant/user-message.test.ts`
**Reads (do not edit):** `apps/daemon/src/jobs/assistant.ts` (the `quoted` shape S4-T6 threads through; this task does not touch it), `packages/core/src/discord/events.ts` lines 127–138 (`MessageAttachment`: gateway events carry metadata with no URL, so fresh REST URLs are a T6 concern, not this one)
**Interfaces:** Consumes: none · Produces: `export interface FetchedAttachment { readonly attachmentId: string; readonly fileName: string; readonly contentType?: string | undefined; readonly sizeBytes: number; readonly url?: string | undefined }` and `export interface FetchedEmbed { readonly title?: string | undefined; readonly description?: string | undefined; readonly providerName?: string | undefined; readonly thumbnailUrl?: string | undefined }` in `packages/core/src/discord/port.ts` · `fetchMessageContent` returns them as required arrays; `RecentMessage` gains `readonly attachments?: readonly FetchedAttachment[] | undefined` (optional so `FakeDiscord` and other constructors keep compiling) · `export const attachmentMarker = (file: { readonly fileName: string; readonly contentType?: string | undefined; readonly sizeBytes: number }): string` in `conversation-context.ts` (S4-T6 reuses it)

- [ ] **Step 1: Write the failing test** — full test code below, using the real helpers of each file.

In `packages/discord/src/rest/port.test.ts`, add after the "fetches one message's content and author" test (line 672; it uses the `harness`, `MESSAGE`, `CHANNEL`, `GUILD`, `USER` names):

```ts
it('keeps attachment urls and embed text on a fetched message (ADR 0149)', async () => {
  const { port } = harness([
    {
      status: 200,
      body: {
        id: MESSAGE,
        channel_id: CHANNEL,
        author: { id: USER, username: 'sam' },
        content: 'notes attached',
        attachments: [
          {
            id: '1',
            filename: 'notes.txt',
            content_type: 'text/plain',
            size: 12_288,
            url: 'https://cdn.discordapp.com/attachments/1/2/notes.txt',
            proxy_url: 'https://media.discordapp.net/attachments/1/2/notes.txt',
          },
          { id: '2', filename: 'no-url.bin', size: 4 },
        ],
        embeds: [
          {
            title: 'Top Gear loser dance',
            description: 'a clip',
            provider: { name: 'Tenor' },
            thumbnail: { url: 'https://media.discordapp.net/thumb.gif' },
          },
        ],
      },
    },
  ]);
  const fetched = await port.fetchMessageContent(GUILD, CHANNEL, MESSAGE);
  expect(fetched?.attachments).toEqual([
    {
      attachmentId: '1',
      fileName: 'notes.txt',
      contentType: 'text/plain',
      sizeBytes: 12_288,
      url: 'https://cdn.discordapp.com/attachments/1/2/notes.txt',
    },
    { attachmentId: '2', fileName: 'no-url.bin', sizeBytes: 4, url: undefined },
  ]);
  expect(fetched?.embeds).toEqual([
    {
      title: 'Top Gear loser dance',
      description: 'a clip',
      providerName: 'Tenor',
      thumbnailUrl: 'https://media.discordapp.net/thumb.gif',
    },
  ]);
});
```

The existing "fetches one message's content and author" `toEqual` (line 684) now needs the two new arrays: add `attachments: []` and `embeds: []` to its expected object. The "fetches channel messages oldest first" `toEqual` needs `attachments: []` on the first message and `attachments: [{ attachmentId: '1', fileName: 'notes.txt', sizeBytes: 12 }]` on the second (its fixture attachment has no `content_type`, so that key is omitted). The nickname `toMatchObject` test needs no change.

In `apps/daemon/src/assistant/conversation-context.test.ts`:

```ts
it('renders attachment and embed markers inside the quote envelope (ADR 0149)', () => {
  expect(
    quoteEnvelopeFor({
      authorName: 'Sam L',
      content: 'see attached',
      attachments: [{ fileName: 'notes.txt', contentType: 'text/plain', sizeBytes: 12_288 }],
      embeds: [{ providerName: 'Tenor', title: 'Top Gear loser dance' }],
    }),
  ).toBe(
    '[UNTRUSTED QUOTED MESSAGE author="Sam L"]\nsee attached\n[attached: notes.txt, text/plain, 12 KB]\n[embed: Tenor: Top Gear loser dance]\n[/UNTRUSTED QUOTED MESSAGE]',
  );
});
```

In `apps/daemon/src/assistant/channel-context.test.ts` (using its `message()`/`input()` helpers):

```ts
it('renders attachment markers even when there is text (ADR 0149)', () => {
  const { block } = buildChannelContext(
    input({
      messages: [
        message({
          messageId: '9',
          authorName: 'Sam L',
          content: 'The one I just pasted:',
          attachments: [{ attachmentId: '1', fileName: 'message.txt', contentType: 'text/plain', sizeBytes: 1024 }],
        }),
      ],
    }),
  );
  expect(block).toContain('[Sam L, 3 min ago] The one I just pasted: [attached: message.txt, text/plain, 1 KB]');
});
```

In `apps/daemon/src/assistant/user-message.test.ts`:

```ts
it('tells the model attachments read only through contents below (ADR 0149)', () => {
  expect(buildUserMessage({ question: 'hi', askerName: 'Sam L' })).toContain(
    'You can read an attachment only if its contents appear below.',
  );
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/discord/src/rest/port.test.ts apps/daemon/src/assistant/conversation-context.test.ts apps/daemon/src/assistant/channel-context.test.ts apps/daemon/src/assistant/user-message.test.ts --maxWorkers=1` · Expected: FAIL (`attachments`/`embeds` undefined on the fetch result; `quoteEnvelopeFor` ignores the new fields; no marker line; prompt line absent)
- [ ] **Step 3: Implement**
  - `packages/core/src/discord/port.ts`: add the `FetchedAttachment` and `FetchedEmbed` interfaces above `DiscordPort`; change the `fetchMessageContent` return (lines 336–341) to `Promise<{ authorId: Snowflake; authorName: string; content: string; attachments: readonly FetchedAttachment[]; embeds: readonly FetchedEmbed[] } | undefined>`; add `readonly attachments?: readonly FetchedAttachment[] | undefined` to `RecentMessage` (after `hasAttachments`, line 224) with the comment "Attachment metadata for marker lines (ADR 0149); absent means unknown, not none".
  - `packages/discord/src/rest/port.ts` `fetchMessageContent` (lines 361–380): return `attachments: (message.attachments ?? []).map((a) => ({ attachmentId: a.id, fileName: a.filename, ...(a.content_type === undefined ? {} : { contentType: a.content_type }), sizeBytes: a.size, url: a.url ?? a.proxy_url ?? undefined }))` and `embeds: (message.embeds ?? []).map((e) => ({ ...(e.title === undefined ? {} : { title: e.title }), ...(e.description === undefined ? {} : { description: e.description }), ...(e.provider?.name === undefined ? {} : { providerName: e.provider.name }), ...(e.thumbnail?.url ?? e.thumbnail?.proxy_url === undefined ? {} : { thumbnailUrl: e.thumbnail?.url ?? e.thumbnail?.proxy_url }) }))` alongside the existing author fields. Same mapping for `fetchChannelMessages` (lines 404–460): add `attachments:` to the mapped message beside `hasAttachments` (line 446, always set, possibly empty).
  - `apps/daemon/src/assistant/conversation-context.ts`: add `export const attachmentMarker = (file: { readonly fileName: string; readonly contentType?: string | undefined; readonly sizeBytes: number }): string => \`[attached: ${neutraliseMarkers(file.fileName)}, ${file.contentType ?? 'unknown type'}, ${Math.max(1, Math.round(file.sizeBytes / 1024))} KB]\`;` (neutraliseMarkers is already imported at line 4); extend `QuotedMessage` (lines 32–35) with `readonly attachments?: readonly { readonly fileName: string; readonly contentType?: string | undefined; readonly sizeBytes: number }[] | undefined` and `readonly embeds?: readonly { readonly title?: string | undefined; readonly description?: string | undefined; readonly providerName?: string | undefined }[] | undefined`; extend `quoteEnvelopeFor` (lines 63–64) to append one `attachmentMarker` line per attachment then one embed line per embed before the close tag. Embed line: `` `[embed: ${[e.providerName, e.title].filter(Boolean).join(': ')}${e.description === undefined ? '' : ` — ${e.description}`}]` `` skipping embeds with no title and no providerName. Neutralise every interpolated field.
  - `apps/daemon/src/assistant/channel-context.ts`: import `attachmentMarker` from `./conversation-context.js`; in both `formatChannelLines` (lines 74–92) and `buildChannelContext` (lines 94+), replace `const text = message.content.trim() === '' ? '[attachment]' : cleanText(...)` with markers appended: `const markers = (message.attachments ?? []).map(attachmentMarker).join(' '); const body = message.content.trim() === '' ? (markers === '' ? '[attachment]' : markers) : cleanText(message.content) + (markers === '' ? '' : ` ${markers}`);` The starter block has no attachments field, so it is untouched.
  - `apps/daemon/src/assistant/user-message.ts`: after `parts.push(currentBlock)` (line 25) insert `parts.push('You can read an attachment only if its contents appear below.');`
  - `FakeDiscord` and other `RecentMessage` constructors keep compiling through the optional field — verify with the typecheck, and update only the two `toEqual` expectations named in Step 1.
- [ ] **Step 4: Run it and watch it pass** — same command as Step 2 · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/discord/port.ts packages/discord/src/rest/port.ts packages/discord/src/rest/port.test.ts apps/daemon/src/assistant/conversation-context.ts apps/daemon/src/assistant/conversation-context.test.ts apps/daemon/src/assistant/channel-context.ts apps/daemon/src/assistant/channel-context.test.ts apps/daemon/src/assistant/user-message.ts apps/daemon/src/assistant/user-message.test.ts` then `npx eslint <the same nine paths>` · exit 0
- [ ] **Step 7: Commit** — `git add <the same nine paths> && git commit -m "Slice 4 T4: attachment and embed markers in quote, channel lines and prompt"`

**Done when:** a `[attached: …]` line renders with text present (the "no pasted text" case); embeds render as `[embed: Tenor: …]`; the prompt line is always present; no bytes travel anywhere yet.

---

### S4-T5: attachment bytes through the existing security primitives   ·   Wave 2
**Owns:** Modify: `apps/daemon/src/assistant/resource-fetcher.ts`, `apps/daemon/src/assistant/resource-fetcher.test.ts`; Create: `apps/daemon/src/assistant/attachments.ts`, `apps/daemon/src/assistant/attachments.test.ts`
**Reads (do not edit):** `packages/core/src/providers/outbound-safety.ts` (`redactEvidenceText`, used for text envelopes)
**Interfaces:** Consumes: `resolvePublicAddress`, `pinnedHttpsRequest`, `isPublicAddress`, `DEFAULT_RESOURCE_FETCH_LIMITS`, `ResourceFetchFailure` from `resource-fetcher.ts` (same task extends it); `redactEvidenceText`, `neutraliseMarkers` from `@bananasaurs/core` · Produces: `export const ATTACHMENT_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'] as const` · `export interface AttachmentSource { readonly fileName: string; readonly contentType?: string | undefined; readonly sizeBytes: number; readonly url?: string | undefined }` · `export type AttachmentKind = 'text' | 'image' | 'pdf' | 'unsupported'` · `export const classifyAttachment = (source: AttachmentSource): AttachmentKind` (pre-fetch, from content type and extension) · `export const sniffMediaKind = (bytes: Uint8Array): 'image' | 'pdf' | 'text' | 'animated-gif' | 'unknown'` (magic bytes) · `export const textEnvelopeFor = (name: string, text: string): string` (redacted, neutralised, framed) · `export const fetchAttachment = (deps: { fetchBytes: (url: string, maxBytes: number) => Promise<{ ok: true; bytes: Uint8Array; mediaType: string } | { ok: false; code: string }> }, source: AttachmentSource, caps: AttachmentCaps): Promise<AttachmentFetchResult>` enforcing declared-size caps before any fetch

- [ ] **Step 1: Write the failing test** — create `apps/daemon/src/assistant/attachments.test.ts` with the full code below, plus append the two `fetchBytes` tests to `resource-fetcher.test.ts` (reusing its `publicDns` helper and `PinnedRequest` type; the binary bodies are built inline so no text-encoding helper is needed):

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_HOSTS,
  classifyAttachment,
  fetchAttachment,
  sniffMediaKind,
  textEnvelopeFor,
} from './attachments.js';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const webp = new Uint8Array([...Buffer.from('RIFF....WEBP', 'utf8')]);
const gifStatic = new Uint8Array([...Buffer.from('GIF89a', 'utf8'), 1, 2, 3]);
const gifAnimated = new Uint8Array([...Buffer.from('GIF89aNETSCAPE2.0', 'utf8')]);
const pdf = new Uint8Array([...Buffer.from('%PDF-1.7', 'utf8')]);

describe('attachment classification and sniffing (ADR 0149)', () => {
  it('classifies by content type first, then extension', () => {
    expect(classifyAttachment({ fileName: 'a.txt', contentType: 'text/plain', sizeBytes: 1 })).toBe('text');
    expect(classifyAttachment({ fileName: 'a.png', contentType: 'image/png', sizeBytes: 1 })).toBe('image');
    expect(classifyAttachment({ fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1 })).toBe('pdf');
    expect(classifyAttachment({ fileName: 'main.ts', contentType: 'application/octet-stream', sizeBytes: 1 })).toBe('text');
    expect(classifyAttachment({ fileName: 'run.exe', contentType: 'application/octet-stream', sizeBytes: 1 })).toBe('unsupported');
    expect(classifyAttachment({ fileName: 'clip.mp4', contentType: 'video/mp4', sizeBytes: 1 })).toBe('unsupported');
  });

  it('sniffs magic bytes and spots animated GIFs', () => {
    expect(sniffMediaKind(png)).toBe('image');
    expect(sniffMediaKind(jpeg)).toBe('image');
    expect(sniffMediaKind(webp)).toBe('image');
    expect(sniffMediaKind(gifStatic)).toBe('image');
    expect(sniffMediaKind(gifAnimated)).toBe('animated-gif');
    expect(sniffMediaKind(pdf)).toBe('pdf');
    expect(sniffMediaKind(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBe('unknown');
  });

  it('refuses oversize on the declared size before fetching', async () => {
    const fetchBytes = vi.fn(async () => ({ ok: true as const, bytes: new Uint8Array(), mediaType: 'image/png' }));
    const result = await fetchAttachment(
      { fetchBytes },
      { fileName: 'big.png', contentType: 'image/png', sizeBytes: 6_000_000 },
      { textMaxBytes: 262_144, textMaxChars: 24_000, textMaxCount: 3, imageMaxBytes: 5_242_880, imageMaxCount: 4, pdfMaxBytes: 10_485_760, pdfMaxCount: 2 },
    );
    expect(result).toMatchObject({ ok: false, code: 'too-large' });
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('refuses a missing url and an off-allowlist url without fetching', async () => {
    const fetchBytes = vi.fn(async () => ({ ok: true as const, bytes: new Uint8Array(), mediaType: 'text/plain' }));
    const caps = { textMaxBytes: 262_144, textMaxChars: 24_000, textMaxCount: 3, imageMaxBytes: 5_242_880, imageMaxCount: 4, pdfMaxBytes: 10_485_760, pdfMaxCount: 2 };
    expect(await fetchAttachment({ fetchBytes }, { fileName: 'a.txt', sizeBytes: 10 }, caps)).toMatchObject({ ok: false, code: 'missing-url' });
    expect(
      await fetchAttachment({ fetchBytes }, { fileName: 'a.txt', sizeBytes: 10, url: 'https://evil.example/a.txt' }, caps),
    ).toMatchObject({ ok: false, code: 'bad-host' });
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('refuses a wrong magic number after fetching', async () => {
    const fetchBytes = vi.fn(async () => ({ ok: true as const, bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), mediaType: 'image/png' }));
    const result = await fetchAttachment(
      { fetchBytes },
      { fileName: 'fake.png', contentType: 'image/png', sizeBytes: 4, url: 'https://cdn.discordapp.com/attachments/1/2/fake.png' },
      { textMaxBytes: 262_144, textMaxChars: 24_000, textMaxCount: 3, imageMaxBytes: 5_242_880, imageMaxCount: 4, pdfMaxBytes: 10_485_760, pdfMaxCount: 2 },
    );
    expect(result).toMatchObject({ ok: false, code: 'bad-magic' });
  });

  it('frames text as untrusted evidence', () => {
    expect(textEnvelopeFor('message.txt', 'hello sam@example.com')).toContain('[UNTRUSTED ATTACHMENT name="message.txt"]');
    expect(textEnvelopeFor('message.txt', 'hello sam@example.com')).toContain('[redacted by the evidence safety filter]');
    expect(textEnvelopeFor('message.txt', 'hi')).toContain('[/UNTRUSTED ATTACHMENT]');
  });

  it('pins the CDN allowlist', () => {
    expect([...ATTACHMENT_HOSTS]).toEqual(['cdn.discordapp.com', 'media.discordapp.net']);
  });
});
```

In `resource-fetcher.test.ts`, append (the file already imports `ReviewedResourceFetcher`, `PinnedRequest`, `publicDns` and `vi`):

```ts
it('fetchBytes returns raw bytes for an allowlisted host and refuses anything else', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const bytesBody = async function* (): AsyncIterable<Uint8Array> {
    yield png;
  };
  const request = vi.fn<PinnedRequest>(async () => ({
    status: 200,
    headers: { 'content-type': 'image/png' },
    body: bytesBody(),
  }));
  const fetcher = new ReviewedResourceFetcher({ resolve: publicDns, request });
  const good = await fetcher.fetchBytes('https://cdn.discordapp.com/attachments/1/2/a.png', {
    allowedHosts: ['cdn.discordapp.com', 'media.discordapp.net'],
    maxBytes: 5_242_880,
  });
  expect(good).toMatchObject({ ok: true, mediaType: 'image/png' });
  if (good.ok) expect([...good.bytes]).toEqual([...png]);
  const bad = await fetcher.fetchBytes('https://evil.example/a.png', {
    allowedHosts: ['cdn.discordapp.com', 'media.discordapp.net'],
    maxBytes: 5_242_880,
  });
  expect(bad).toMatchObject({ ok: false, code: 'redirect', host: 'evil.example' });
  expect(request).toHaveBeenCalledTimes(1);
});

it('fetchBytes refuses a redirect to another host without following it', async () => {
  const emptyBody = async function* (): AsyncIterable<Uint8Array> {};
  const request = vi.fn<PinnedRequest>(async () => ({
    status: 302,
    headers: { location: 'https://evil.example/final.png' },
    body: emptyBody(),
  }));
  const fetcher = new ReviewedResourceFetcher({ resolve: publicDns, request });
  const result = await fetcher.fetchBytes('https://cdn.discordapp.com/attachments/1/2/a.png', {
    allowedHosts: ['cdn.discordapp.com', 'media.discordapp.net'],
    maxBytes: 1_024,
  });
  expect(result).toMatchObject({ ok: false, code: 'redirect', host: 'evil.example' });
  expect(request).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run apps/daemon/src/assistant/attachments.test.ts apps/daemon/src/assistant/resource-fetcher.test.ts --maxWorkers=1` · Expected: FAIL (modules `attachments.ts` and `fetchBytes` missing)
- [ ] **Step 3: Implement**
  - `resource-fetcher.ts`: add the option/result types after `ResourceFetchFailureCode` (lines 88–98), reusing the module's `fail` helper:

```ts
export interface ByteFetchOptions {
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number;
  /** Absent means any content type is accepted; magic bytes decide later (ADR 0149). */
  readonly allowedTypes?: readonly string[] | undefined;
}
export interface ByteFetchSuccess {
  readonly ok: true;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly url: string;
}
export type ByteFetchResult = ByteFetchSuccess | ResourceFetchFailure;
```

Add the public method plus a private walker inside `ReviewedResourceFetcher` (after the `fetch` overloads, before `#fetchFrom`). It mirrors `#fetchFrom` (lines 342–494) exactly — URL validation, allowlist check with `fail('redirect', …)`, resolve, public-address check, pinned request per address, redirect follow up to `maxRedirects` with the per-hop allowlist re-check, 304/3xx/4xx-5xx/challenge handling, `allowedTypes` check when set, declared-length pre-check, streamed cap — except it returns raw bytes and never touches the cache and never decodes text:

```ts
async fetchBytes(rawUrl: string, options: ByteFetchOptions): Promise<ByteFetchResult> {
  let initial: URL;
  try {
    initial = validateResourceUrl(rawUrl);
  } catch {
    return fail('invalid-url', 'The attachment URL is not an allowed public HTTPS URL.');
  }
  if (
    !options.allowedHosts.some((host) => initial.hostname.toLowerCase() === host.toLowerCase())
  )
    return fail('redirect', 'The attachment URL is outside the allowed hosts.', {
      host: initial.hostname,
    });
  const limits: ResourceFetchLimits = {
    ...DEFAULT_RESOURCE_FETCH_LIMITS,
    maxBytes: options.maxBytes,
  };
  return this.#fetchBytesFrom(initial, new Set(), 0, limits, options);
}

async #fetchBytesFrom(
  url: URL,
  visited: Set<string>,
  redirects: number,
  limits: ResourceFetchLimits,
  options: ByteFetchOptions,
): Promise<ByteFetchResult> {
  if (visited.has(url.href))
    return fail('redirect', 'The attachment redirect looped.', { host: url.hostname });
  visited.add(url.href);
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await this.#resolve(url.hostname);
  } catch {
    return fail('dns-failed', 'The attachment host could not be resolved.', {
      host: url.hostname,
    });
  }
  if (addresses.length === 0)
    return fail('dns-failed', 'The attachment host has no address.', { host: url.hostname });
  if (addresses.some(({ address }) => !isPublicAddress(address)))
    return fail('private-address', 'The attachment resolved to a non-public address.', {
      host: url.hostname,
    });
  let response: PinnedResponse | undefined;
  let lastError: unknown;
  for (const address of addresses) {
    try {
      response = await this.#request(url, address, limits.timeoutMs);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (response === undefined) {
    return fail(
      lastError instanceof Error && /timed out/i.test(lastError.message) ? 'timeout' : 'network',
      'The attachment could not be retrieved safely.',
      { host: url.hostname },
    );
  }
  if (response.status >= 300 && response.status < 400) {
    response.discard?.();
    if (redirects >= limits.maxRedirects)
      return fail('redirect', 'The attachment exceeded the redirect limit.', {
        host: url.hostname,
      });
    const location = redirectLocation(response);
    if (location === undefined)
      return fail('redirect', 'The attachment redirect had no location.', {
        host: url.hostname,
      });
    let redirected: URL;
    try {
      redirected = validateResourceUrl(new URL(location, url).href);
    } catch {
      return fail('redirect', 'The attachment redirected outside allowed public HTTPS URLs.', {
        host: url.hostname,
      });
    }
    if (
      !options.allowedHosts.some((host) => redirected.hostname.toLowerCase() === host.toLowerCase())
    )
      return fail('redirect', 'The attachment redirected outside the allowed hosts.', {
        host: redirected.hostname,
      });
    return this.#fetchBytesFrom(redirected, visited, redirects + 1, limits, options);
  }
  if (response.status < 200 || response.status >= 300) {
    response.discard?.();
    return fail('http-status', `The attachment returned HTTP ${response.status}.`, {
      httpStatus: response.status,
      host: url.hostname,
    });
  }
  const mediaType = mediaTypeOf(response.headers['content-type']);
  if (options.allowedTypes !== undefined && !options.allowedTypes.includes(mediaType)) {
    response.discard?.();
    return fail('content-type', 'The attachment did not return an accepted type.', {
      host: url.hostname,
    });
  }
  const declaredLength = Number(response.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limits.maxBytes) {
    response.discard?.();
    return fail('too-large', 'The attachment exceeded the size limit.', {
      host: url.hostname,
    });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limits.maxBytes) {
        response.discard?.();
        return fail('too-large', 'The attachment exceeded the size limit.', {
          host: url.hostname,
        });
      }
      chunks.push(chunk);
    }
  } catch {
    return fail('network', 'The attachment body could not be read.', { host: url.hostname });
  }
  return { ok: true, bytes: Buffer.concat(chunks), mediaType, url: url.href };
}
```

(`redirectLocation` and `mediaTypeOf` are the existing module-scope helpers `#fetchFrom` uses; `fail`, `ResolvedAddress`, `PinnedResponse`, `ResourceFetchLimits` are already in scope. Copy the structure, do not refactor `#fetchFrom`.)

  - `apps/daemon/src/assistant/attachments.ts`: full new module:

```ts
import { redactEvidenceText, neutraliseMarkers } from '@bananasaurs/core';

export const ATTACHMENT_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'] as const;

export interface AttachmentSource {
  readonly fileName: string;
  readonly contentType?: string | undefined;
  readonly sizeBytes: number;
  readonly url?: string | undefined;
}

export type AttachmentKind = 'text' | 'image' | 'pdf' | 'unsupported';

export interface AttachmentCaps {
  readonly textMaxBytes: number;
  readonly textMaxChars: number;
  readonly textMaxCount: number;
  readonly imageMaxBytes: number;
  readonly imageMaxCount: number;
  readonly pdfMaxBytes: number;
  readonly pdfMaxCount: number;
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.js', '.ts', '.tsx', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.h', '.cpp', '.css', '.html', '.xml', '.yml', '.yaml', '.toml', '.ini',
  '.cfg', '.log', '.csv', '.sh',
]);

/** Pre-fetch guess from the declared type, falling back to the file extension (ADR 0149). */
export const classifyAttachment = (source: AttachmentSource): AttachmentKind => {
  const type = (source.contentType ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (type.startsWith('text/') || type === 'application/json') return 'text';
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  const dot = source.fileName.lastIndexOf('.');
  const ext = dot === -1 ? '' : source.fileName.slice(dot).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.gif') return 'image';
  return 'unsupported';
};

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((b, i) => bytes[i] === b);

/** Magic-byte check on fetched bytes (ADR 0149). `animated-gif` (NETSCAPE2.0) is refused, not sent. */
export const sniffMediaKind = (bytes: Uint8Array): 'image' | 'pdf' | 'text' | 'animated-gif' | 'unknown' => {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image';
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    const head = Buffer.from(bytes.slice(0, 300)).toString('latin1');
    return head.includes('NETSCAPE2.0') ? 'animated-gif' : 'image';
  }
  return 'unknown';
};

export const textEnvelopeFor = (name: string, text: string): string => {
  const clean = neutraliseMarkers(redactEvidenceText(text).text);
  return `[UNTRUSTED ATTACHMENT name=${JSON.stringify(neutraliseMarkers(name))}]\n${clean}\n[/UNTRUSTED ATTACHMENT]`;
};

export type AttachmentFetchResult =
  | { readonly ok: true; readonly kind: 'text'; readonly name: string; readonly text: string }
  | { readonly ok: true; readonly kind: 'image' | 'pdf'; readonly name: string; readonly mediaType: string; readonly dataBase64: string; readonly sizeBytes: number }
  | { readonly ok: false; readonly code: 'missing-url' | 'bad-host' | 'too-large' | 'bad-magic' | 'fetch-failed' | 'animated' | 'unsupported'; readonly note: string };

/** One attachment end to end: declared-size cap first, host check, fetch, magic check (ADR 0149, refusal-first). */
export const fetchAttachment = async (
  deps: {
    readonly fetchBytes: (url: string, maxBytes: number) => Promise<{ readonly ok: true; readonly bytes: Uint8Array; readonly mediaType: string } | { readonly ok: false; readonly code: string }>;
  },
  source: AttachmentSource,
  caps: AttachmentCaps,
): Promise<AttachmentFetchResult> => {
  const kind = classifyAttachment(source);
  if (kind === 'unsupported') return { ok: false, code: 'unsupported', note: `${source.fileName} is not a text file, image or PDF.` };
  const maxBytes = kind === 'text' ? caps.textMaxBytes : kind === 'image' ? caps.imageMaxBytes : caps.pdfMaxBytes;
  if (source.sizeBytes > maxBytes) return { ok: false, code: 'too-large', note: `${source.fileName} is over the size limit.` };
  if (source.url === undefined || source.url === '') return { ok: false, code: 'missing-url', note: `${source.fileName} has no download link.` };
  let host: string;
  try {
    host = new URL(source.url).hostname.toLowerCase();
  } catch {
    return { ok: false, code: 'bad-host', note: `${source.fileName} has no valid download link.` };
  }
  if (!ATTACHMENT_HOSTS.some((h) => host === h)) return { ok: false, code: 'bad-host', note: `${source.fileName} is not on the attachment host.` };
  const fetched = await deps.fetchBytes(source.url, maxBytes);
  if (!fetched.ok) return { ok: false, code: 'fetch-failed', note: `${source.fileName} could not be downloaded.` };
  if (kind === 'image' || kind === 'pdf') {
    const sniffed = sniffMediaKind(fetched.bytes);
    if (sniffed === 'animated-gif') return { ok: false, code: 'animated', note: `${source.fileName} is an animated image.` };
    if ((kind === 'image' && sniffed !== 'image') || (kind === 'pdf' && sniffed !== 'pdf'))
      return { ok: false, code: 'bad-magic', note: `${source.fileName} is not the file type it claims to be.` };
    return { ok: true, kind, name: source.fileName, mediaType: fetched.mediaType, dataBase64: Buffer.from(fetched.bytes).toString('base64'), sizeBytes: fetched.bytes.byteLength };
  }
  const text = Buffer.from(fetched.bytes).toString('utf8').replaceAll('\u0000', '');
  return { ok: true, kind: 'text', name: source.fileName, text };
};
```
- [ ] **Step 4: Run it and watch it pass** — same command as Step 2 · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write apps/daemon/src/assistant/resource-fetcher.ts apps/daemon/src/assistant/resource-fetcher.test.ts apps/daemon/src/assistant/attachments.ts apps/daemon/src/assistant/attachments.test.ts` then `npx eslint <the same four paths>` · exit 0
- [ ] **Step 7: Commit** — `git add apps/daemon/src/assistant/resource-fetcher.ts apps/daemon/src/assistant/resource-fetcher.test.ts apps/daemon/src/assistant/attachments.ts apps/daemon/src/assistant/attachments.test.ts && git commit -m "Slice 4 T5: attachment fetch with host, size and magic-byte refusals"`

**Done when:** every refusal (off-host, missing URL, oversize, bad magic, animated GIF, redirect to another host) is tested before the fetch it guards; text frames as `[UNTRUSTED ATTACHMENT …]` with redaction; no network in tests (injected `fetchBytes`/injected `request`).

### S4-T6: text files into the turn   ·   Wave 3
**Owns:** Modify: `apps/daemon/src/jobs/assistant.ts`, `apps/daemon/src/jobs/assistant.test.ts`
**Reads (do not edit):** `apps/daemon/src/assistant/attachments.ts` (S4-T5: `fetchAttachment`, `textEnvelopeFor`, `classifyAttachment`, `AttachmentCaps`), `apps/daemon/src/assistant/conversation-context.ts` (S4-T4: `attachmentMarker`, `QuotedMessage` attachments/embeds), `packages/core/src/settings/instance-settings.ts` (S4-T3 cap keys), `packages/core/src/discord/port.ts` (`FetchedAttachment`, `FetchedEmbed`)
**Interfaces:** Consumes: `fetchAttachment`, `textEnvelopeFor`, `classifyAttachment`, `AttachmentCaps`, `attachmentMarker`, `FetchedAttachment`, `FetchedEmbed`, the seven `assistant.attachments.*` settings · Produces: optional job deps `fetchAttachmentBytes` and `attachmentCaps`; job-start re-read of the current and replied-to messages; quoted text blocks appended to `quoteEnvelope`, current-message text blocks in an `[UNTRUSTED MESSAGE ATTACHMENTS]` wrapper joined into `channelContext`; per-file `[attached: …]` markers plus refusal notes

- [ ] **Step 1: Write the failing test** — in `apps/daemon/src/jobs/assistant.test.ts`, in the `assistantInvokeHandler (Task 14: …)` describe (it has the `harness`, `mention`, `CHANNEL_ID` helpers; the quote tests near lines 1014–1152 show the `referencedMessageId` pattern). Add after the 'a quoted reply carries the untrusted envelope' test:

```ts
it('inlines a quoted text attachment with its marker (ADR 0149)', async () => {
  const h = harness(() => ({ ok: true, content: 'answer' }));
  h.fetchMessageContent.mockResolvedValue({
    authorId: '111111111111111111',
    authorName: 'Alex P',
    content: 'the hall opens at seven',
    attachments: [
      { attachmentId: '1', fileName: 'message.txt', contentType: 'text/plain', sizeBytes: 15, url: 'https://cdn.discordapp.com/attachments/1/2/message.txt' },
    ],
    embeds: [],
  });
  h.fetchAttachmentBytes.mockResolvedValue({ ok: true, bytes: Buffer.from('pasted details'), mediaType: 'text/plain' });
  await h.run(mention({ invocationId: 'inv-att-text', referencedMessageId: '840000000000000001' }));
  expect(h.inputs[0]?.quoteEnvelope).toContain('[attached: message.txt, text/plain, 1 KB]');
  expect(h.inputs[0]?.quoteEnvelope).toContain('[UNTRUSTED ATTACHMENT name="message.txt"]');
  expect(h.inputs[0]?.quoteEnvelope).toContain('pasted details');
});

it('inlines a current-message text attachment in the message wrapper, never the payload (ADR 0149)', async () => {
  const h = harness(() => ({ ok: true, content: 'answer' }));
  h.fetchMessageContent.mockResolvedValue({
    authorId: '444444444444444444',
    authorName: 'Ama',
    content: '',
    attachments: [
      { attachmentId: '2', fileName: 'notes.txt', contentType: 'text/plain', sizeBytes: 9, url: 'https://cdn.discordapp.com/attachments/1/2/notes.txt' },
    ],
    embeds: [],
  });
  h.fetchAttachmentBytes.mockResolvedValue({ ok: true, bytes: Buffer.from('some notes'), mediaType: 'text/plain' });
  await h.run(mention({ invocationId: 'inv-att-current', messageId: '810000000000000021' }));
  expect(h.fetchMessageContent).toHaveBeenCalledWith(CHANNEL_ID, '810000000000000021');
  expect(h.fetchAttachmentBytes).toHaveBeenCalledWith('https://cdn.discordapp.com/attachments/1/2/notes.txt', expect.any(Number));
  expect(h.inputs[0]?.channelContext).toContain('[UNTRUSTED MESSAGE ATTACHMENTS]');
  expect(h.inputs[0]?.channelContext).toContain('[attached: notes.txt, text/plain, 1 KB]');
  expect(h.inputs[0]?.channelContext).toContain('some notes');
});

it('caps text files at three per message and 24,000 chars each (ADR 0149)', async () => {
  const h = harness(() => ({ ok: true, content: 'answer' }));
  h.fetchMessageContent.mockResolvedValue({
    authorId: '111111111111111111',
    authorName: 'Sam L',
    content: '',
    attachments: [1, 2, 3, 4].map((n) => ({ attachmentId: `${n}`, fileName: `f${n}.txt`, contentType: 'text/plain', sizeBytes: 10, url: `https://cdn.discordapp.com/attachments/1/${n}/f${n}.txt` })),
    embeds: [],
  });
  h.fetchAttachmentBytes.mockResolvedValue({ ok: true, bytes: Buffer.from('x'.repeat(30_000)), mediaType: 'text/plain' });
  await h.run(mention({ invocationId: 'inv-att-caps', messageId: '810000000000000022' }));
  expect(h.inputs[0]?.channelContext).toContain('cut after 24,000 characters');
  expect(h.inputs[0]?.channelContext?.match(/\[UNTRUSTED ATTACHMENT/g)).toHaveLength(3);
});
```

The harness needs three additions (write them as part of Step 3, test-first):
  - Widen the `fetchMessageContent` mock's return type to include the S4-T4 fields: change `async (): Promise<{ authorId: string; authorName: string; content: string } | undefined>` to also allow `attachments?: readonly FetchedAttachment[]` and `embeds?: readonly FetchedEmbed[]` (import both types from `@bananasaurs/core`).
  - Add a `fetchAttachmentBytes` mock dep on the handler: `const fetchAttachmentBytes = vi.fn(async (): Promise<{ ok: true; bytes: Uint8Array; mediaType: string } | { ok: false; code: string }> => ({ ok: false, code: 'unavailable' }));` passed into `assistantInvokeHandler({…})` and returned on the `h` object. The refusing default keeps every existing test fetching nothing.
  - Add an `attachmentCaps` mock dep the same way: `const attachmentCaps = vi.fn((): AttachmentCaps => ({ textMaxBytes: 262_144, textMaxChars: 24_000, textMaxCount: 3, imageMaxBytes: 5_242_880, imageMaxCount: 4, pdfMaxBytes: 10_485_760, pdfMaxCount: 2 }));` passed in and returned. (Import `AttachmentCaps` type from `../assistant/attachments.js`.)

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run apps/daemon/src/jobs/assistant.test.ts --maxWorkers=1` · Expected: FAIL (`fetchAttachmentBytes`/`attachmentCaps` missing on the harness; no text blocks)
- [ ] **Step 3: Implement** — in `apps/daemon/src/jobs/assistant.ts`:
  - Add the imports: `import { fetchAttachment, textEnvelopeFor, classifyAttachment, type AttachmentCaps } from '../assistant/attachments.js';` and `import { attachmentMarker } from '../assistant/conversation-context.js';` and `import type { FetchedAttachment, FetchedEmbed } from '@bananasaurs/core';` (beside the existing imports from those modules).
  - Extend the handler deps interface beside `fetchMessageContent` (near line 372) with:

```ts
fetchAttachmentBytes?: ((url: string, maxBytes: number) => Promise<{ ok: true; bytes: Uint8Array; mediaType: string } | { ok: false; code: string }>) | undefined;
attachmentCaps?: (() => AttachmentCaps) | undefined;
```

  - Widen the local `quoted` type (near line 890, `let quoted: { authorId: string; authorName: string; content: string } | undefined;`) to carry the S4-T4 fields:

```ts
let quoted: { authorId: string; authorName: string; content: string; attachments?: readonly FetchedAttachment[]; embeds?: readonly FetchedEmbed[] } | undefined;
```

and in the quote-fetch branch keep the new fields: `quoted = { authorId: fetched.authorId, authorName: fetched.authorName, content: fetched.content, attachments: fetched.attachments, embeds: fetched.embeds };` so markers render through `buildConversationContext` (S4-T4).

  - After `quoteEnvelope = built.quoteEnvelope;` (near line 1023) and still inside the `payload.channelId !== undefined && deps.conversations !== undefined` branch, insert the attachment block:

```ts
const attachmentCaps: AttachmentCaps = deps.attachmentCaps?.() ?? {
  textMaxBytes: 262_144,
  textMaxChars: 24_000,
  textMaxCount: 3,
  imageMaxBytes: 5_242_880,
  imageMaxCount: 4,
  pdfMaxBytes: 10_485_760,
  pdfMaxCount: 2,
};
const attachmentFetchBytes: (url: string, maxBytes: number) => Promise<{ ok: true; bytes: Uint8Array; mediaType: string } | { ok: false; code: string }> =
  deps.fetchAttachmentBytes ?? (async () => ({ ok: false as const, code: 'unavailable' }));
// One message's text attachments end to end: markers plus envelopes for
// text files, marker-plus-note for anything else (bytes for images and
// PDFs land in S4-T9; refusals read as plain notes either way).
const readTextAttachments = async (
  sources: readonly FetchedAttachment[],
): Promise<{ markers: string[]; texts: string[] }> => {
  const markers: string[] = [];
  const texts: string[] = [];
  const textSources = sources.filter(
    (source) => classifyAttachment(source) === 'text',
  );
  for (const source of sources.filter((source) => classifyAttachment(source) !== 'text')) {
    markers.push(`${attachmentMarker(source)} (not read: this file is not a text file)`);
  }
  const readable = textSources.slice(0, attachmentCaps.textMaxCount);
  for (const source of textSources.slice(attachmentCaps.textMaxCount)) {
    markers.push(
      `${attachmentMarker(source)} (skipped: at most ${attachmentCaps.textMaxCount} text files per message)`,
    );
  }
  for (const source of readable) {
    const fetched = await fetchAttachment({ fetchBytes: attachmentFetchBytes }, source, attachmentCaps);
    if (!fetched.ok) {
      markers.push(`${attachmentMarker(source)} (skipped: ${fetched.note})`);
      continue;
    }
    markers.push(attachmentMarker(source));
    const cut =
      fetched.text.length > attachmentCaps.textMaxChars
        ? `${fetched.text.slice(0, attachmentCaps.textMaxChars)}\n(cut after ${attachmentCaps.textMaxChars.toLocaleString('en-CA')} characters)`
        : fetched.text;
    texts.push(textEnvelopeFor(source.fileName, cut));
  }
  return { markers, texts };
};
```

  - Quoted message: after the block above, when `quoted !== undefined`, run `const quotedFiles = await readTextAttachments(quoted.attachments ?? []);` and append: `if (quotedFiles.texts.length > 0 || quotedFiles.markers.length > 0) quoteEnvelope = [quoteEnvelope, ...quotedFiles.markers, ...quotedFiles.texts].filter((part) => part !== undefined && part !== '').join('\n');` (quoteEnvelope is `string | undefined`; the filter keeps the join safe).
  - Current message: when `payload.messageId !== undefined` and `deps.fetchMessageContent !== undefined`, re-read it fresh (`await deps.fetchMessageContent(channelId, payload.messageId)` inside try/catch; a failure means markers-only silence, never a job failure — gateway-cached URLs are never trusted, and a retry re-reads too). Run the same `readTextAttachments` over its attachments and, when non-empty, join into the local `channelContext`: `channelContext = [channelContext, \`[UNTRUSTED MESSAGE ATTACHMENTS]\n${[...currentFiles.markers, ...currentFiles.texts].join('\n')}\n[/UNTRUSTED MESSAGE ATTACHMENTS]\`].filter((part) => part !== undefined && part !== '').join('\n\n');`
  - Nothing attachment-derived enters the job payload, the conversation turns, or the trace beyond the `quoteEnvelope`/`channelContext` strings the trace already carries.
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run apps/daemon/src/jobs/assistant.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write apps/daemon/src/jobs/assistant.ts apps/daemon/src/jobs/assistant.test.ts` then `npx eslint apps/daemon/src/jobs/assistant.ts apps/daemon/src/jobs/assistant.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add apps/daemon/src/jobs/assistant.ts apps/daemon/src/jobs/assistant.test.ts && git commit -m "Slice 4 T6: text attachments re-read at job start and inlined as evidence"`

**Done when:** the "no pasted text" case now inlines the file; the current message is re-read through REST (proved by the fresh-URL test — gateway events carry no URLs by construction); text caps enforced per message with notes; no bytes in payload/turns/trace beyond existing string envelopes.

---

### S4-T7: Gemini sends media as inlineData   ·   Wave 3
**Owns:** Modify: `packages/core/src/providers/gemini.ts`, `packages/core/src/providers/gemini.test.ts`
**Reads (do not edit):** `packages/core/src/providers/contracts.ts` (S4-T2 `GenerationMedia`), `packages/core/src/providers/outbound-safety.ts` lines 146–153 (`requestSections` scans `message.text` only, so base64 `media` never reaches the scan — the ADR 0149 accepted gap)
**Interfaces:** Consumes: `GenerationMedia`, `GenerationMessage.media` (S4-T2) · Produces: wire format below (no new exports)

- [ ] **Step 1: Write the failing test** — in `packages/core/src/providers/gemini.test.ts`, using its `sse()` helper (the adapter streams: `:streamGenerateContent?alt=sse`, there is no non-streaming path). Add after the first endpoint test:

```ts
it('sends user-turn media as inlineData parts after the text (ADR 0149)', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    sse({
      candidates: [{ content: { parts: [{ text: 'seen' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      modelVersion: 'gemini-test-001',
    }),
  );
  const provider = new GeminiProvider({ apiKey: 'secret', fetch });
  await provider.generateText({
    model: 'gemini-3.8-flash',
    messages: [
      {
        role: 'user',
        text: 'what is this?',
        media: [
          { kind: 'image', mediaType: 'image/png', dataBase64: 'aGk=', name: 'chart.png' },
          { kind: 'pdf', mediaType: 'application/pdf', dataBase64: 'amVm', name: 'report.pdf' },
        ],
      },
    ],
  });
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(String(url)).toContain(':streamGenerateContent?alt=sse');
  expect(JSON.parse(init?.body as string)).toMatchObject({
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'what is this?' },
          { inlineData: { mimeType: 'image/png', data: 'aGk=' } },
          { inlineData: { mimeType: 'application/pdf', data: 'amVm' } },
        ],
      },
    ],
  });
});

it('sends no Discord URL with media (ADR 0149)', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    sse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }], modelVersion: 'm' }),
  );
  const provider = new GeminiProvider({ apiKey: 'secret', fetch });
  await provider.generateText({
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', text: 'hi', media: [{ kind: 'image', mediaType: 'image/png', dataBase64: 'aGk=', name: 'a.png' }] }],
  });
  const [, init] = fetch.mock.calls[0] ?? [];
  expect(init?.body as string).not.toContain('discordapp');
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/providers/gemini.test.ts --maxWorkers=1` · Expected: FAIL (media dropped on the wire)
- [ ] **Step 3: Implement** — in `packages/core/src/providers/gemini.ts` `toContents` (lines 65–94): the user branch (lines 88–91) becomes:

```ts
contents.push({
  role: message.role === 'assistant' ? 'model' : 'user',
  parts: [
    { text: message.text },
    ...(message.role === 'user' && message.media !== undefined
      ? message.media.map((m) => ({ inlineData: { mimeType: m.mediaType, data: m.dataBase64 } }))
      : []),
  ],
});
```

Assistant turns (plain or `providerParts`) are unchanged — media on an assistant turn is ignored (never produced). No Discord URL ever leaves the process: only base64 `data` is sent. The parts shape is unchanged by streaming, so this composes with the SSE response path and `thinkingLevel` untouched.
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/providers/gemini.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/providers/gemini.ts packages/core/src/providers/gemini.test.ts` then `npx eslint packages/core/src/providers/gemini.ts packages/core/src/providers/gemini.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/providers/gemini.ts packages/core/src/providers/gemini.test.ts && git commit -m "Slice 4 T7: Gemini sends attached images and PDFs as inlineData"`

**Done when:** image and PDF media arrive as `inlineData` parts after the text on the streaming request; no URL on the wire; assistant turns unchanged.

---

### S4-T8: OpenRouter sends images and PDFs, plugin pinned   ·   Wave 3
**Owns:** Modify: `packages/core/src/providers/openai-compatible.ts`, `packages/core/src/providers/openai-compatible.test.ts`
**Reads (do not edit):** `packages/core/src/providers/contracts.ts` (S4-T2 `GenerationMedia`), `apps/daemon/src/assistant/model-capabilities.ts` (`capabilitiesForEntry`: `nvidia-nim` is always `TEXT_AND_TOOLS_ONLY`, so routing never hands a PDF to NIM — the plugin is still OpenRouter-only, see Step 3)
**Interfaces:** Consumes: `GenerationMedia`, `GenerationMessage.media` (S4-T2) · Produces: wire format below (no new exports). Every OpenRouter request carrying a PDF asserts exactly `plugins: [{ id: "file-parser", pdf: { engine: "native" } }]` so OpenRouter never substitutes `mistral-ocr` or `cloudflare-ai` (D7b)

- [ ] **Step 1: Write the failing test** — in `packages/core/src/providers/openai-compatible.test.ts`, using its `sse()`/`response()` streaming helpers (every request sends `stream: true`; there is no non-streaming path). Add inside the `describe('OpenAI-compatible providers', …)` block:

```ts
it('sends images as data-url parts and PDFs as file parts with the native plugin (ADR 0149)', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
  const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
  await provider.generateText({
    model: 'google/gemma-4-31b-it:free',
    messages: [
      {
        role: 'user',
        text: 'read this',
        media: [
          { kind: 'image', mediaType: 'image/png', dataBase64: 'aGk=', name: 'chart.png' },
          { kind: 'pdf', mediaType: 'application/pdf', dataBase64: 'amVm', name: 'report.pdf' },
        ],
      },
    ],
  });
  const [, init] = fetch.mock.calls[0] ?? [];
  const body = JSON.parse(init?.body as string);
  expect(body.stream).toBe(true);
  expect(body.messages.at(-1)).toEqual({
    role: 'user',
    content: [
      { type: 'text', text: 'read this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
      { type: 'file', file: { filename: 'report.pdf', file_data: 'data:application/pdf;base64,amVm' } },
    ],
  });
  expect(body.plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'native' } }]);
  expect(init?.body as string).not.toContain('discordapp');
});

it('sends no plugins without a PDF and keeps text-only turns as strings (ADR 0149)', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
  const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
  await provider.generateText({
    model: 'free-model',
    messages: [{ role: 'user', text: 'hello', media: [{ kind: 'image', mediaType: 'image/png', dataBase64: 'aGk=', name: 'a.png' }] }],
  });
  const [, imageInit] = fetch.mock.calls[0] ?? [];
  const imageBody = JSON.parse(imageInit?.body as string);
  expect(imageBody.plugins).toBeUndefined();
  expect(imageBody.messages.at(-1)?.content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } });

  const textFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
  const textProvider = createOpenRouterProvider({ apiKey: 'secret', fetch: textFetch });
  await textProvider.generateText({ model: 'free-model', messages: [{ role: 'user', text: 'hello' }] });
  const [, textInit] = textFetch.mock.calls[0] ?? [];
  const textBody = JSON.parse(textInit?.body as string);
  expect(textBody.plugins).toBeUndefined();
  expect(textBody.messages.at(-1)).toEqual({ role: 'user', content: 'hello' });
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/providers/openai-compatible.test.ts --maxWorkers=1` · Expected: FAIL (media dropped; no plugins)
- [ ] **Step 3: Implement** — in `packages/core/src/providers/openai-compatible.ts`:
  - `toWireMessage` (lines 514–543): the final user branch (line 542, `return { role: message.role, content: message.text };`) becomes media-aware:

```ts
const media = message.role === 'user' ? (message.media ?? []) : [];
if (media.length === 0) return { role: message.role, content: message.text };
return {
  role: message.role,
  content: [
    { type: 'text', text: message.text },
    ...media.map((m) =>
      m.kind === 'image'
        ? { type: 'image_url', image_url: { url: `data:${m.mediaType};base64,${m.dataBase64}` } }
        : { type: 'file', file: { filename: m.name, file_data: `data:${m.mediaType};base64,${m.dataBase64}` } },
    ),
  ],
};
```

  - In `generateText`'s streaming body (lines 635–667): compute `const hasPdf = request.messages.some((m) => m.role === 'user' && (m.media ?? []).some((x) => x.kind === 'pdf'));` just before the `JSON.stringify` and add `...(this.id === 'openrouter' && hasPdf ? { plugins: [{ id: 'file-parser', pdf: { engine: 'native' } }] } : {})` to the body object (beside the `usage`/`reasoning` spreads). The plugin is OpenRouter-only: NIM shares the class but routing never sends it a PDF (`capabilitiesForEntry` pins NIM to text plus tools, and S4-T11 strips per entry), and the test pins OpenRouter only.
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/providers/openai-compatible.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/providers/openai-compatible.ts packages/core/src/providers/openai-compatible.test.ts` then `npx eslint packages/core/src/providers/openai-compatible.ts packages/core/src/providers/openai-compatible.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/providers/openai-compatible.ts packages/core/src/providers/openai-compatible.test.ts && git commit -m "Slice 4 T8: OpenRouter sends images and PDFs with the native file-parser plugin"`

**Done when:** images go as `image_url` data URLs, PDFs as `file` parts with exactly the native plugin on the streaming request; no PDF means no plugins and unchanged string content for text-only turns; no URL on the wire.

---

### S4-T9: media plumbing from the job to the loop   ·   Wave 4
**Owns:** Modify: `apps/daemon/src/assistant/commands.ts`, `apps/daemon/src/assistant/service.ts`, `apps/daemon/src/assistant/service.test.ts`, `apps/daemon/src/jobs/assistant.ts`, `apps/daemon/src/jobs/assistant.test.ts`, `apps/daemon/src/assistant/attachments.ts`, `apps/daemon/src/assistant/attachments.test.ts`
**Reads (do not edit):** `apps/daemon/src/assistant/tool-loop.ts` (its `runEntry` builds provider messages from history; per-entry filtering is S4-T11 — this task does not touch it), `packages/core/src/providers/contracts.ts` (S4-T2)
**Interfaces:** Consumes: `fetchAttachment`, `AttachmentCaps`, `ATTACHMENT_HOSTS` (S4-T5); `GenerationMedia` (S4-T2) · Produces: `export interface AttachmentSummary { readonly name: string; readonly kind: 'text' | 'image' | 'pdf'; readonly sizeBytes: number }` in `commands.ts` · `AssistantInvocation` gains `readonly media?: readonly GenerationMedia[] | undefined` and `readonly attachmentSummary?: readonly AttachmentSummary[] | undefined` · `fetchAttachment` gains an optional fourth parameter `forceKind?: AttachmentKind` (for embed thumbnails, which have no usable filename)

- [ ] **Step 1: Write the failing test** — in `apps/daemon/src/assistant/service.test.ts`, in the `Task 14: conversation history, quoted envelope and trace detail` describe (it has the `capturing`/`ask`/`usable` helpers; read them first). Add a test that builds its own full-capture provider (the describe's `capturing()` strips messages to role/text, so media needs the full request):

```ts
it('forwards invocation media on a trailing user message, bytes never in the trace (ADR 0149)', async () => {
  const requests: GenerateTextRequest[] = [];
  const provider: TextProvider = {
    id: 'fake',
    capabilities: new Set(['text', 'tools']),
    generateText: async (req) => {
      requests.push(req);
      return { text: 'done', model: 'model-a' };
    },
  };
  const service = createAssistantService(
    t.scopes.forGuild(GUILD),
    t.scopes.instance(),
    config,
    () => NOW,
    {},
    undefined,
    undefined,
    undefined,
    () => [usable(provider)],
  );
  const result = await service.invoke(
    ask({
      invocationId: 'int-media-1',
      media: [{ kind: 'image', mediaType: 'image/png', dataBase64: 'aGk=', name: 'chart.png' }],
      attachmentSummary: [{ name: 'chart.png', kind: 'image', sizeBytes: 3 }],
    }),
  );
  expect(result.ok).toBe(true);
  const messages = requests[0]?.messages ?? [];
  const note = messages.find((m) => m.role === 'user' && (m.media ?? []).length > 0);
  expect(note?.role).toBe('user');
  expect(note?.text).toBe('[attached files: chart.png]');
  expect(note?.media).toHaveLength(1);
  expect(JSON.stringify(result.detail ?? {})).not.toContain('aGk=');
});
```

(`GenerateTextRequest`, `TextProvider` and `createAssistantService` are already imported in that file; `t`, `config`, `NOW`, `GUILD`, `usable`, `ask` are the describe's own names — if any differs, use the file's name.) In `apps/daemon/src/jobs/assistant.test.ts`, extend the S4-T6 harness (its `fetchMessageContent`/`fetchAttachmentBytes` mocks):

```ts
it('fetches images and PDFs up to their caps and passes bytes with a summary (ADR 0149)', async () => {
  const h = harness(() => ({ ok: true, content: 'answer' }));
  h.fetchMessageContent.mockResolvedValue({
    authorId: '111111111111111111', authorName: 'Sam L', content: 'look', attachments: [
      { attachmentId: '1', fileName: 'chart.png', contentType: 'image/png', sizeBytes: 100, url: 'https://cdn.discordapp.com/attachments/1/2/chart.png' },
      { attachmentId: '2', fileName: 'report.pdf', contentType: 'application/pdf', sizeBytes: 200, url: 'https://cdn.discordapp.com/attachments/1/2/report.pdf' },
    ], embeds: [],
  });
  h.fetchAttachmentBytes.mockImplementation(async (url: string) => ({
    ok: true as const,
    bytes: url.endsWith('.png') ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) : new Uint8Array([...Buffer.from('%PDF-1.7', 'utf8')]),
    mediaType: url.endsWith('.png') ? 'image/png' : 'application/pdf',
  }));
  await h.run(mention({ invocationId: 'inv-att-media', messageId: '810000000000000023' }));
  expect(h.inputs[0]?.media?.map((m) => m.name)).toEqual(['chart.png', 'report.pdf']);
  expect(h.inputs[0]?.attachmentSummary).toEqual([
    { name: 'chart.png', kind: 'image', sizeBytes: 8 },
    { name: 'report.pdf', kind: 'pdf', sizeBytes: 8 },
  ]);
});
```

In `apps/daemon/src/assistant/attachments.test.ts`:

```ts
it('forceKind reads an embed thumbnail with no usable filename (ADR 0149)', async () => {
  const fetchBytes = vi.fn(async () => ({ ok: true as const, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mediaType: 'image/png' }));
  const caps = { textMaxBytes: 262_144, textMaxChars: 24_000, textMaxCount: 3, imageMaxBytes: 5_242_880, imageMaxCount: 4, pdfMaxBytes: 10_485_760, pdfMaxCount: 2 };
  const result = await fetchAttachment({ fetchBytes }, { fileName: 'embed thumbnail', sizeBytes: 8, url: 'https://media.discordapp.net/thumb.png' }, caps, 'image');
  expect(result).toMatchObject({ ok: true, kind: 'image' });
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run apps/daemon/src/assistant/service.test.ts apps/daemon/src/jobs/assistant.test.ts apps/daemon/src/assistant/attachments.test.ts --maxWorkers=1` · Expected: FAIL (`media`/`attachmentSummary` unknown on the invocation; no trailing media message; no `forceKind`)
- [ ] **Step 3: Implement**
  - `attachments.ts`: `fetchAttachment(deps, source, caps, forceKind?: AttachmentKind)` — when `forceKind` is set, skip `classifyAttachment` and use it for the byte cap, the magic expectation and the result kind. Nothing else changes.
  - `commands.ts`: import the `GenerationMedia` type from `@bananasaurs/core` (next to the existing `GenerationMessage` import, line 12); add `export interface AttachmentSummary { readonly name: string; readonly kind: 'text' | 'image' | 'pdf'; readonly sizeBytes: number }`; add the two optional fields to `AssistantInvocation` after `summaryVersion` (lines 102–106) with the comment "ADR 0149: fetched attachment bytes for models that read them natively, and the metadata-only summary the trace keeps".
  - `service.ts`: replace `const historyForLoop: readonly GenerationMessage[] = input.history ?? [];` (line 1339) with:

```ts
const mediaForLoop: readonly GenerationMedia[] = input.media ?? [];
const historyForLoop: readonly GenerationMessage[] =
  mediaForLoop.length === 0
    ? (input.history ?? [])
    : [
        ...(input.history ?? []),
        {
          role: 'user',
          text: `[attached files: ${mediaForLoop.map((m) => m.name).join(', ')}]`,
          media: mediaForLoop,
        },
      ];
```

(`GenerationMedia` type is already imported at line 30.) The note text (names only, never bytes) flows into the trace history section like any user text; the bytes ride `media`, which no trace writer reads. The note counts as one user turn in `historyTurns`; that is intended and the test pins the note, not the count.
  - `jobs/assistant.ts`: extend the S4-T6 `readTextAttachments` processing to image and PDF kinds: per message, the first `imageMaxCount` image-kind attachments and first `pdfMaxCount` PDF-kind attachments (extras get "(skipped: at most 4 images per message)" / "(skipped: at most 2 PDFs per message)" notes with the live values) go through `fetchAttachment`; embed thumbnails on `media.discordapp.net` go through with `forceKind: 'image'` and fileName `'embed thumbnail'`. Collect `media: GenerationMedia[]` (image/pdf successes, `{ kind, mediaType, dataBase64, name }`) and `attachmentSummary: AttachmentSummary[]` (every fetched file of every kind, using the fetched byte length as `sizeBytes`). Pass both into the existing `deps.service.invoke({…})` call (near line 1169): `...(media.length === 0 ? {} : { media }), ...(attachmentSummary.length === 0 ? {} : { attachmentSummary }),`. Refusals become marker-side notes exactly like S4-T6's text refusals. Import the `GenerationMedia` type from `@bananasaurs/core` and `AttachmentSummary` from `../assistant/commands.js` (check the existing commands import in that file and extend it).
- [ ] **Step 4: Run it and watch it pass** — same command as Step 2 · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write apps/daemon/src/assistant/commands.ts apps/daemon/src/assistant/service.ts apps/daemon/src/assistant/service.test.ts apps/daemon/src/jobs/assistant.ts apps/daemon/src/jobs/assistant.test.ts apps/daemon/src/assistant/attachments.ts apps/daemon/src/assistant/attachments.test.ts` then `npx eslint <the same seven paths>` · exit 0
- [ ] **Step 7: Commit** — `git add <the same seven paths> && git commit -m "Slice 4 T9: attachment bytes and summary from the job to the loop"`

**Done when:** images/PDFs/thumbnails fetch under their caps with magic checks; bytes reach the loop only on the trailing user message; the summary carries names/kinds/sizes and no bytes; refusals read as plain notes.

### S4-T10: tuning page shows the attachment caps   ·   Wave 4
**Owns:** Modify: `packages/dashboard/src/pages/assistant-tuning.test.tsx`
**Reads (do not edit):** `packages/dashboard/src/pages/assistant-tuning.tsx` (generic registry rendering — no change), `packages/dashboard/src/test-support.tsx` (`renderWithSession`, `stubFetch`, `bodyOf`)
**Interfaces:** Consumes: the seven `assistant.attachments.*` keys (S4-T3) · Produces: none (test only)

- [ ] **Step 1: Write the failing test** — in `packages/dashboard/src/pages/assistant-tuning.test.tsx`, extend the `SETTINGS` fixture (same shape as the `assistant.channelContextMessages` entry: key, group `'Assistant attachments'`, label, help, display `'count'`, bounds, value, defaultValue, isDefault) with all seven attachment settings:

```tsx
{
  key: 'assistant.attachments.textMaxBytes',
  group: 'Assistant attachments',
  label: 'Text attachment size limit',
  help: 'The largest text file read from a message, in bytes. Larger files are skipped with a note.',
  display: 'count',
  bounds: { min: 1024, max: 1048576 },
  value: 262144,
  defaultValue: 262144,
  isDefault: true,
},
{
  key: 'assistant.attachments.textMaxChars',
  group: 'Assistant attachments',
  label: 'Text attachment characters sent',
  help: 'How many characters of each text file are sent to the AI. Longer files are cut with a note.',
  display: 'count',
  bounds: { min: 1000, max: 100000 },
  value: 24000,
  defaultValue: 24000,
  isDefault: true,
},
{
  key: 'assistant.attachments.textMaxCount',
  group: 'Assistant attachments',
  label: 'Text files read per message',
  help: 'How many text files are read from one message. 0 turns text attachments off.',
  display: 'count',
  bounds: { min: 0, max: 10 },
  value: 3,
  defaultValue: 3,
  isDefault: true,
},
{
  key: 'assistant.attachments.imageMaxBytes',
  group: 'Assistant attachments',
  label: 'Image size limit',
  help: 'The largest image sent to the AI, in bytes. Larger images are skipped with a note.',
  display: 'count',
  bounds: { min: 1024, max: 20971520 },
  value: 5242880,
  defaultValue: 5242880,
  isDefault: true,
},
{
  key: 'assistant.attachments.imageMaxCount',
  group: 'Assistant attachments',
  label: 'Images read per message',
  help: 'How many images are sent to the AI from one message. 0 turns image attachments off.',
  display: 'count',
  bounds: { min: 0, max: 10 },
  value: 4,
  defaultValue: 4,
  isDefault: true,
},
{
  key: 'assistant.attachments.pdfMaxBytes',
  group: 'Assistant attachments',
  label: 'PDF size limit',
  help: 'The largest PDF sent to the AI, in bytes. Larger PDFs are skipped with a note.',
  display: 'count',
  bounds: { min: 1024, max: 31457280 },
  value: 10485760,
  defaultValue: 10485760,
  isDefault: true,
},
{
  key: 'assistant.attachments.pdfMaxCount',
  group: 'Assistant attachments',
  label: 'PDFs read per message',
  help: 'How many PDFs are sent to the AI from one message. 0 turns PDF attachments off.',
  display: 'count',
  bounds: { min: 0, max: 10 },
  value: 2,
  defaultValue: 2,
  isDefault: true,
},
```

then add the test (following the 'saves a ping cap as a plain count' test's exact pattern — `findByLabelText`, `rowOf`, `button { name: 'Save' }`, `bodyOf`):

```tsx
it('renders the attachment caps under Assistant attachments and saves one', async () => {
  const updated = {
    ...SETTINGS.find((s) => s.key === 'assistant.attachments.imageMaxCount')!,
    value: 2,
  };
  const mock = stubFetch([
    { url: TUNING_URL, body: { settings: SETTINGS } },
    {
      method: 'PUT',
      url: tuningKeyUrl('assistant.attachments.imageMaxCount'),
      body: { setting: updated },
    },
  ]);
  renderPage();
  expect(await screen.findByRole('heading', { name: 'Assistant attachments' })).toBeTruthy();
  const input = await screen.findByLabelText('Images read per message');
  expect(input).toHaveProperty('value', '4');
  fireEvent.change(input, { target: { value: '2' } });
  await act(async () => {
    fireEvent.click(
      within(rowOf('assistant.attachments.imageMaxCount')).getByRole('button', { name: 'Save' }),
    );
  });
  const put = mock.mock.calls.find((c) => (c[0] as string).includes('/api/assistant/tuning/'));
  expect(put?.[1]).toMatchObject({ method: 'PUT' });
  expect(bodyOf(put!)).toEqual({ value: 2 });
  expect(await screen.findByText('Saved')).toBeTruthy();
});
```

(`TUNING_URL`, `tuningKeyUrl`, `fireEvent`, `act`, `within`, `screen`, `cleanup` are the existing names in that file; if any differs, use the file's name.) Also add `'Assistant attachments'` to the group list in the 'renders the five group headings and every label' test so the new heading is pinned alongside the labels.

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/dashboard/src/pages/assistant-tuning.test.tsx --maxWorkers=1` · Expected: FAIL (fixture lacks the keys; heading and row missing)
- [ ] **Step 3: Implement** — test only: extend the `SETTINGS` fixture, extend the group list, and add the test above. No page change: the tuning page renders every registry entry generically (§4.7). If the page does not render the new group, that is a page bug — fix it in this task only if the test proves it, keeping the change to mounting (contracts §4).
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/dashboard/src/pages/assistant-tuning.test.tsx --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/dashboard/src/pages/assistant-tuning.test.tsx` then `npx eslint packages/dashboard/src/pages/assistant-tuning.test.tsx` · exit 0
- [ ] **Step 7: Commit** — `git add packages/dashboard/src/pages/assistant-tuning.test.tsx && git commit -m "Slice 4 T10: tuning page renders and saves the attachment caps"`

**Done when:** every new cap renders with its help text and one saves through the existing endpoint; no dashboard component changes.

---

### S4-T11: capability routing and per-entry markers   ·   Wave 5
**Owns:** Create: `apps/daemon/src/assistant/media-routing.ts`, `apps/daemon/src/assistant/media-routing.test.ts`; Modify: `apps/daemon/src/assistant/tool-loop.ts`, `apps/daemon/src/assistant/tool-loop.test.ts`
**Reads (do not edit):** `apps/daemon/src/assistant/model-chain.ts` lines 43–63 (`ChainEntry.capabilities?: ModelCapabilities`, optional), `apps/daemon/src/assistant/provider-config.ts` line 555 (`capabilitiesForEntry` fills it per request), `packages/core/src/providers/contracts.ts` (S4-T2), `packages/core/src/providers/model-capabilities.ts` (`ModelCapabilities`: `tools`, `image`, `pdf`, `reasoning`, `thinking`)
**Interfaces:** Consumes: `GenerationMedia`, `GenerationMessage` (S4-T2); `ChainEntry.capabilities`, `ModelCapabilities` (Slice 6, merged) · Produces: `export const entryCanRead = (caps: ModelCapabilities | undefined, media: readonly GenerationMedia[]): boolean` (absent caps means text-only: false when media is present) · `export const orderEntriesForMedia = <T extends { readonly capabilities?: ModelCapabilities | undefined }>(entries: readonly T[], media: readonly GenerationMedia[]): readonly T[]` (stable: entries that can read everything attached first; no media means unchanged order) · `export const messagesForEntry = (messages: readonly GenerationMessage[], caps: ModelCapabilities | undefined): GenerationMessage[]` (strips disallowed media from every user message; appends one plain line per stripped file to the last user message: `${name} attached; you can't see images right now.` / `${name} attached; you can't read PDFs right now.`)

- [ ] **Step 1: Write the failing test** — create `apps/daemon/src/assistant/media-routing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { entryCanRead, messagesForEntry, orderEntriesForMedia } from './media-routing.js';
import type { GenerationMedia } from '@bananasaurs/core';

const image: GenerationMedia = { kind: 'image', mediaType: 'image/png', dataBase64: 'aGk=', name: 'chart.png' };
const pdf: GenerationMedia = { kind: 'pdf', mediaType: 'application/pdf', dataBase64: 'amVm', name: 'report.pdf' };
const none = { tools: true, image: false, pdf: false, reasoning: false, thinking: 'none' as const };
const seeImage = { tools: true, image: true, pdf: false, reasoning: false, thinking: 'none' as const };
const seeAll = { tools: true, image: true, pdf: true, reasoning: false, thinking: 'none' as const };

describe('media routing (ADR 0149)', () => {
  it('prefers the first entry that can read everything, stably', () => {
    const entries = [
      { id: 'a', capabilities: none },
      { id: 'b', capabilities: seeImage },
      { id: 'c', capabilities: seeAll },
    ];
    expect(orderEntriesForMedia(entries, [image, pdf]).map((e) => e.id)).toEqual(['c', 'a', 'b']);
    expect(orderEntriesForMedia(entries, []).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('treats absent capabilities as text-only', () => {
    expect(entryCanRead(undefined, [image])).toBe(false);
    expect(entryCanRead(undefined, [])).toBe(true);
  });

  it('strips what the entry cannot read and says so plainly', () => {
    const out = messagesForEntry(
      [{ role: 'user', text: '[attached files: chart.png, report.pdf]', media: [image, pdf] }],
      seeImage,
    );
    expect(out[0]?.media).toHaveLength(1);
    expect(out[0]?.text).toContain("report.pdf attached; you can't read PDFs right now.");
    expect(out[0]?.text).not.toContain('chart.png attached');
  });
});
```

In `tool-loop.test.ts` (it has the `scripted`/`entry`/`baseInput`/`runToolLoop`/`textAnswer` helpers; `entry()` takes `Partial<ChainEntry> & { provider }` and leaves `capabilities` absent unless set), add:

```ts
it('runs the first media-capable entry first and strips media for text-only entries (ADR 0149)', async () => {
  const seen: GenerateTextRequest[] = [];
  const providerFor = (): TextProvider => ({
    id: 'fake',
    capabilities: new Set(['text', 'tools']),
    generateText: async (request: GenerateTextRequest) => {
      seen.push(request);
      return textAnswer('done');
    },
  });
  const textOnly = entry({ provider: providerFor(), model: 'text-a' });
  const vision = entry({
    provider: providerFor(),
    model: 'vision-b',
    capabilities: { tools: true, image: true, pdf: false, reasoning: false, thinking: 'none' },
  });
  const media: GenerationMedia = { kind: 'image', mediaType: 'image/png', dataBase64: 'aGk=', name: 'chart.png' };
  await runToolLoop(
    baseInput([textOnly, vision], {
      history: [{ role: 'user', text: '[attached files: chart.png]', media: [media] }],
    }),
  );
  expect(seen).toHaveLength(1);
  expect(seen[0]?.model).toBe('vision-b');
  expect(seen[0]?.messages.flatMap((m) => (m.role === 'user' ? (m.media ?? []) : []))).toHaveLength(1);
});
```

(Add `GenerateTextRequest` to the existing type import from `@bananasaurs/core` in that file, and `GenerationMedia` beside it. If `baseInput`'s second parameter name differs, use the file's name — it takes `(chain, over)` where `over` is a partial loop input.)

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run apps/daemon/src/assistant/media-routing.test.ts apps/daemon/src/assistant/tool-loop.test.ts --maxWorkers=1` · Expected: FAIL (module missing; chain order never changes)
- [ ] **Step 3: Implement**
  - `media-routing.ts`: the three functions exactly as specified:

```ts
import { neutraliseMarkers, type GenerationMessage, type GenerationMedia, type ModelCapabilities } from '@bananasaurs/core';

/** Absent capabilities mean text-only (ADR 0149): safe for chains built before Slice 6. */
export const entryCanRead = (
  caps: ModelCapabilities | undefined,
  media: readonly GenerationMedia[],
): boolean => {
  if (media.length === 0) return true;
  if (caps === undefined) return false;
  return media.every((m) => (m.kind === 'image' ? caps.image : caps.pdf));
};

/** Stable preference for entries that can read everything attached (spec 4c). No media means unchanged order. */
export const orderEntriesForMedia = <T extends { readonly capabilities?: ModelCapabilities | undefined }>(
  entries: readonly T[],
  media: readonly GenerationMedia[],
): readonly T[] => {
  if (media.length === 0) return entries;
  return [...entries.filter((e) => entryCanRead(e.capabilities, media)), ...entries.filter((e) => !entryCanRead(e.capabilities, media))];
};

/** Strips what the entry cannot read; one plain line per stripped file on the last user message. */
export const messagesForEntry = (
  messages: readonly GenerationMessage[],
  caps: ModelCapabilities | undefined,
): GenerationMessage[] => {
  const stripped: string[] = [];
  const kept = messages.map((message) => {
    if (message.role !== 'user') return message;
    const media = message.media ?? [];
    const readable = media.filter((m) => entryCanRead(caps, [m]));
    if (readable.length === media.length) return message;
    for (const m of media.filter((m) => !entryCanRead(caps, [m]))) {
      const name = neutraliseMarkers(m.name);
      stripped.push(
        m.kind === 'image'
          ? `${name} attached; you can't see images right now.`
          : `${name} attached; you can't read PDFs right now.`,
      );
    }
    return { role: message.role, text: message.text, media: readable };
  });
  if (stripped.length === 0) return [...kept];
  const lastUser = kept.map((m) => m.role).lastIndexOf('user');
  if (lastUser === -1) return [...kept];
  return kept.map((message, index) =>
    index === lastUser && message.role === 'user'
      ? { role: message.role, text: `${message.text}\n${stripped.join('\n')}`, media: message.media }
      : message,
  );
};
```

(Verify `ModelCapabilities`, `GenerationMedia`, `GenerationMessage` and `neutraliseMarkers` are all exported from `@bananasaurs/core` — `contracts.ts` and `model-capabilities.ts` are core modules and `neutraliseMarkers` is already imported from core in `conversation-context.ts`. If any export name differs, use the file's name.)
  - `tool-loop.ts`: import the two functions (`import { messagesForEntry, orderEntriesForMedia } from './media-routing.js';`). Replace `let chain: readonly ChainEntry[] = input.chain;` (line 412) with:

```ts
const runMedia: readonly GenerationMedia[] = input.history.flatMap((m) => (m.role === 'user' ? (m.media ?? []) : []));
let chain: readonly ChainEntry[] = orderEntriesForMedia(input.chain, runMedia);
```

(import the `GenerationMedia` type from `@bananasaurs/core` beside the existing `GenerationMessage` import, line 11). In `runEntry`, replace `const messages: GenerationMessage[] = deps.resume ? [...deps.resume.messages] : [...deps.history, { role: 'user', text: deps.userText }];` (near line 769) with:

```ts
const messages: GenerationMessage[] = messagesForEntry(
  deps.resume ? [...deps.resume.messages] : [...deps.history, { role: 'user', text: deps.userText }],
  deps.entry.capabilities,
);
```

A file stripped by a previous entry is already gone from `media`, so the resume branch adds no repeat markers. The answer-retry path builds on these filtered messages, so it inherits the filter with no second change.
  - No new ledger events: a media fallback rides the normal attempt order (spec: "If none can, it uses the normal order"). The stripped marker is the model's explanation, so it never guesses.
- [ ] **Step 4: Run it and watch it pass** — same command as Step 2 · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write apps/daemon/src/assistant/media-routing.ts apps/daemon/src/assistant/media-routing.test.ts apps/daemon/src/assistant/tool-loop.ts apps/daemon/src/assistant/tool-loop.test.ts` then `npx eslint <the same four paths>` · exit 0
- [ ] **Step 7: Commit** — `git add <the same four paths> && git commit -m "Slice 4 T11: media capability routing with plain unreadable markers"`

**Done when:** an image run prefers the first image-capable entry; a PDF asked of models without PDF input sends no bytes and the model is told plainly; absent capabilities behave as text-only.

---

### S4-T12: trace keeps names, kinds and sizes — never bytes   ·   Wave 5
**Owns:** Modify: `packages/core/src/assistant/trace.ts`, `packages/core/src/assistant/trace.test.ts`, `apps/daemon/src/assistant/service.ts`, `apps/daemon/src/assistant/service.test.ts`, `apps/daemon/src/jobs/assistant.ts`, `apps/daemon/src/jobs/assistant.test.ts`
**Reads (do not edit):** `apps/daemon/src/assistant/commands.ts` (S4-T9 `AttachmentSummary`)
**Interfaces:** Consumes: `AttachmentSummary` / `AssistantInvocation.attachmentSummary` (S4-T9) · Produces: `assistantTraceIncludedSchema` gains `attachments: z.array(z.object({ name: z.string().max(120), kind: z.enum(['text', 'image', 'pdf']), sizeBytes: z.number().int().nonnegative() })).max(10).optional()` ("ADR 0149: what rode along; metadata only, never bytes")

- [ ] **Step 1: Write the failing test** — in `packages/core/src/assistant/trace.test.ts` (it uses the `fixtureTrace(overrides)` helper; follow the 'round-trips included channelMessages' test pattern):

```ts
it('round-trips an attachment summary and still parses included without it (ADR 0149)', () => {
  const withAttachments = fixtureTrace({
    included: {
      toolsOffered: ['search_sources'],
      snippetChunkIds: ['chunk-1'],
      quote: false,
      historyTurns: 0,
      attachments: [{ name: 'chart.png', kind: 'image', sizeBytes: 8 }],
    },
  });
  expect(assistantTraceSchema.parse(JSON.parse(JSON.stringify(withAttachments)))).toEqual(withAttachments);
  const withoutAttachments = fixtureTrace({
    included: { toolsOffered: ['search_sources'], snippetChunkIds: ['chunk-1'], quote: false, historyTurns: 0 },
  });
  expect(assistantTraceSchema.parse(JSON.parse(JSON.stringify(withoutAttachments)))).toEqual(withoutAttachments);
});
```

In `service.test.ts`, in the same `Task 14` describe as the S4-T9 media test (same `createAssistantService`/`usable`/`ask` construction):

```ts
it('records the attachment summary in included and no bytes anywhere (ADR 0149)', async () => {
  const requests: GenerateTextRequest[] = [];
  const provider: TextProvider = {
    id: 'fake',
    capabilities: new Set(['text', 'tools']),
    generateText: async (req) => {
      requests.push(req);
      return { text: 'done', model: 'model-a' };
    },
  };
  const service = createAssistantService(
    t.scopes.forGuild(GUILD),
    t.scopes.instance(),
    config,
    () => NOW,
    {},
    undefined,
    undefined,
    undefined,
    () => [usable(provider)],
  );
  const result = await service.invoke(
    ask({
      invocationId: 'int-trace-1',
      attachmentSummary: [{ name: 'chart.png', kind: 'image', sizeBytes: 8 }],
    }),
  );
  expect(result.ok).toBe(true);
  expect(result.detail?.included?.attachments).toEqual([{ name: 'chart.png', kind: 'image', sizeBytes: 8 }]);
  expect(JSON.stringify(result.detail ?? {})).not.toContain('aGk=');
});
```

In `jobs/assistant.test.ts`: extend the S4-T9 media test (`inv-att-media`) to also assert the stored trace's summary: after `h.run`, read `traceRepo.getTrace(scope(), 'trace_inv-att-media')` (the file already imports `traceRepo` and uses this pattern in the crash test) and expect its `included.attachments` to equal `[{ name: 'chart.png', kind: 'image', sizeBytes: 8 }, { name: 'report.pdf', kind: 'pdf', sizeBytes: 8 }]`. (If the trace id for an invocation id differs — check the crash test's `'trace_inv-crash'` naming — use the file's naming.)

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/assistant/trace.test.ts apps/daemon/src/assistant/service.test.ts apps/daemon/src/jobs/assistant.test.ts --maxWorkers=1` · Expected: FAIL (`attachments` stripped as unknown; `included` lacks it)
- [ ] **Step 3: Implement**
  - `trace.ts`: add the optional `attachments` field to `assistantTraceIncludedSchema` (lines 7–16) with the ADR 0149 comment. No migration: optional, old rows still parse.
  - `service.ts`: in both `included:` literals (the `mapLoopFailure` one near line 1208 and the `sink.detail` one near line 1587 — both end with `...(input.summaryVersion === undefined ? {} : { summaryVersion: input.summaryVersion }),`), add after the `summaryVersion` spread: `...(input.attachmentSummary === undefined ? {} : { attachments: input.attachmentSummary.slice(0, 10).map((a) => ({ name: a.name.slice(0, 120), kind: a.kind, sizeBytes: a.sizeBytes })) }),`
  - `jobs/assistant.ts`: all three `included` copies — the staged-cursor copy (near lines 223–233), the failure-trace copy (near lines 1295–1310) and the success-trace copy (near lines 1666–1680) — each ends with the `summaryVersion` spread; add after it: `...(detail.included.attachments === undefined ? {} : { attachments: detail.included.attachments }),` for the cursor copy (it reads `detail.included`), and `...(included.attachments === undefined ? {} : { attachments: included.attachments }),` / `...(detail.included.attachments === undefined ? {} : { attachments: detail.included.attachments }),` for the failure/success copies (matching each block's local name: the failure block reads `included`, the success block reads `detail.included` — use the name the block already uses). A retry from an invoke-done cursor keeps the summary.
- [ ] **Step 4: Run it and watch it pass** — same command as Step 2 · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/assistant/trace.ts packages/core/src/assistant/trace.test.ts apps/daemon/src/assistant/service.ts apps/daemon/src/assistant/service.test.ts apps/daemon/src/jobs/assistant.ts apps/daemon/src/jobs/assistant.test.ts` then `npx eslint <the same six paths>` · exit 0
- [ ] **Step 7: Commit** — `git add <the same six paths> && git commit -m "Slice 4 T12: trace included gains the attachment summary, never bytes"`

**Done when:** the summary round-trips through the schema, the service writes it, the cursor and both trace writers keep it, legacy rows still parse, and no base64 appears in any trace.

---

### S4-T13: production attachment fetch and caps wiring   ·   Wave 6
**Owns:** Modify: `apps/daemon/src/runtime/guild.ts`, `apps/daemon/src/runtime/guild-ledger.test.ts`
**Reads (do not edit):** `apps/daemon/src/jobs/assistant.ts` (S4-T6/T9: the optional `fetchAttachmentBytes` and `attachmentCaps` deps); `apps/daemon/src/assistant/attachments.ts` (S4-T5: `ATTACHMENT_HOSTS`, `AttachmentCaps`); `apps/daemon/src/assistant/resource-fetcher.ts` (S4-T5: `ReviewedResourceFetcher.fetchBytes(url, { allowedHosts, maxBytes })`); `apps/daemon/src/runtime/guild.ts` lines 1424–1441 (`resourceRefreshHandler`: the existing live-fetcher construction pattern to mirror)
**Interfaces:** Consumes: `ATTACHMENT_HOSTS: readonly ['cdn.discordapp.com', 'media.discordapp.net']`; `AttachmentCaps`; `ByteFetchOptions`/`ByteFetchResult` (S4-T5); `settings.get` for the seven `assistant.attachments.*` keys (S4-T3) · Produces: production `assistantInvokeHandler` receives live fetch and cap closures; the runtime test pins the wiring, the exact hosts, and the off-host refusal

- [ ] **Step 1: Write the failing test** — in `apps/daemon/src/runtime/guild-ledger.test.ts` (it builds real runtimes with `buildGuildRuntime`, `FakeDiscord`, `parseConfig` and `createInteractionTokenSealer`; mirror the existing test's construction). Add the module mock beside the existing `service.js` mock, capturing the invoke handler's deps:

```ts
const invokeDeps = vi.hoisted(() => ({ seen: [] as unknown[] }));

vi.mock('../jobs/assistant.js', async (importOriginal) => {
  const actual = await importOriginal<typeof assistantJobModule>();
  return {
    ...actual,
    assistantInvokeHandler: (deps: Parameters<typeof actual.assistantInvokeHandler>[0]) => {
      invokeDeps.seen.push(deps);
      return actual.assistantInvokeHandler(deps);
    },
  };
});
```

(Add `import type * as assistantJobModule from '../jobs/assistant.js';` and `import type { InstanceSettingsStore } from '../settings/instance-settings-store.js';` to the imports.) Then add the test:

```ts
describe('guild runtime wires attachment fetching (ADR 0149)', () => {
  it('passes a CDN-pinned byte fetcher and live caps to the invoke handler', async () => {
    const scopeA = t.scopes.forGuild(GUILD_A);
    guildRepo.upsertGuild(scopeA, { name: 'guild a', now: NOW });
    const requested: string[] = [];
    const values: Record<string, number> = {
      'assistant.attachments.textMaxBytes': 262_144,
      'assistant.attachments.textMaxChars': 24_000,
      'assistant.attachments.textMaxCount': 3,
      'assistant.attachments.imageMaxBytes': 5_242_880,
      'assistant.attachments.imageMaxCount': 4,
      'assistant.attachments.pdfMaxBytes': 10_485_760,
      'assistant.attachments.pdfMaxCount': 2,
      'resources.fetchTimeoutMs': 5_000,
    };
    const settings = {
      get: ((key: string) => {
        requested.push(key);
        return (values as Record<string, number | undefined>)[key];
      }) as InstanceSettingsStore['get'],
      set: () => {
        throw new Error('not used in this test');
      },
      reset: () => {
        throw new Error('not used in this test');
      },
    } as InstanceSettingsStore;
    const config = parseConfig({
      DISCORD_BOT_TOKEN: 'NOT.A.REALTOKEN',
      DISCORD_APPLICATION_ID: BOT,
      BANANASAURS_GUILD_ALLOWLIST: `${GUILD_A}`,
      BANANASAURS_OWNER_USER_ID: OWNER,
      DASHBOARD_SESSION_SECRET: 'b'.repeat(32),
    });
    invokeDeps.seen.length = 0;
    buildGuildRuntime({
      scope: scopeA,
      instance: t.scopes.instance(),
      config,
      discord: new FakeDiscord({ guildId: GUILD_A, botHighestRolePosition: 100 }),
      client,
      logger,
      now: () => NOW,
      interactionTokenSealer: createInteractionTokenSealer(),
      instanceSettings: settings,
    });
    const deps = invokeDeps.seen[0] as {
      fetchAttachmentBytes?: (url: string, maxBytes: number) => Promise<{ ok: boolean; code?: string }>;
      attachmentCaps?: () => Record<string, number>;
    };
    expect(typeof deps.fetchAttachmentBytes).toBe('function');
    expect(typeof deps.attachmentCaps).toBe('function');
    expect(deps.attachmentCaps?.()).toEqual({
      textMaxBytes: 262_144,
      textMaxChars: 24_000,
      textMaxCount: 3,
      imageMaxBytes: 5_242_880,
      imageMaxCount: 4,
      pdfMaxBytes: 10_485_760,
      pdfMaxCount: 2,
    });
    for (const key of [
      'assistant.attachments.textMaxBytes',
      'assistant.attachments.textMaxChars',
      'assistant.attachments.textMaxCount',
      'assistant.attachments.imageMaxBytes',
      'assistant.attachments.imageMaxCount',
      'assistant.attachments.pdfMaxBytes',
      'assistant.attachments.pdfMaxCount',
    ]) {
      expect(requested).toContain(key);
    }
    const refused = await deps.fetchAttachmentBytes?.('https://evil.example/x.png', 1_024);
    expect(refused?.ok).toBe(false);
  });
});
```

Notes for the implementer: `buildGuildRuntime` reads every other setting through lazy closures, so the stub only needs the eight keys above; the off-host call fails on the allowlist before any DNS, so the test makes no network request. The redirect-to-another-host refusal is covered by S4-T5's injected-`request` unit test, not here. (`t`, `client`, `logger`, `GUILD_A`, `BOT`, `OWNER`, `NOW`, `FakeDiscord`, `guildRepo`, `parseConfig`, `createInteractionTokenSealer`, `buildGuildRuntime` are the existing names in that file; if any differs, use the file's name.)

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run apps/daemon/src/runtime/guild-ledger.test.ts --maxWorkers=1` · Expected: FAIL (production passes neither attachment dependency into the handler)
- [ ] **Step 3: Implement** — in `apps/daemon/src/runtime/guild.ts`: import `ATTACHMENT_HOSTS` and the `AttachmentCaps` type (`import { ATTACHMENT_HOSTS, type AttachmentCaps } from '../assistant/attachments.js';` beside the other assistant imports). Immediately before `const worker = new JobWorker({` (line 1327), add:

```ts
// ADR 0149: attachment bytes come only from Discord's CDN hosts, through
// the reviewed fetcher (DNS pinning, public-address check, per-hop
// allowlist re-check, byte cap). Caps are read live per call, so
// dashboard changes apply without a restart; absent settings mean the
// D7 defaults.
const attachmentFetcher =
  settings === undefined
    ? new ReviewedResourceFetcher({ now })
    : new ReviewedResourceFetcher({
        now,
        limits: () => ({ timeoutMs: settings.get('resources.fetchTimeoutMs') }),
      });
const attachmentCaps = (): AttachmentCaps => ({
  textMaxBytes: settings?.get('assistant.attachments.textMaxBytes') ?? 262_144,
  textMaxChars: settings?.get('assistant.attachments.textMaxChars') ?? 24_000,
  textMaxCount: settings?.get('assistant.attachments.textMaxCount') ?? 3,
  imageMaxBytes: settings?.get('assistant.attachments.imageMaxBytes') ?? 5_242_880,
  imageMaxCount: settings?.get('assistant.attachments.imageMaxCount') ?? 4,
  pdfMaxBytes: settings?.get('assistant.attachments.pdfMaxBytes') ?? 10_485_760,
  pdfMaxCount: settings?.get('assistant.attachments.pdfMaxCount') ?? 2,
});
```

(`ReviewedResourceFetcher` is already imported at line 99; `now` is the destructured clock.) In the `assistantInvokeHandler({ … })` object (lines 1349–1388), after the `fetchChannelMessages` closure (lines 1376–1377), add:

```ts
// ADR 0149: live attachment bytes and caps (S4-T5/S4-T9 deps).
fetchAttachmentBytes: async (url, maxBytes) => {
  const fetched = await attachmentFetcher.fetchBytes(url, {
    allowedHosts: ATTACHMENT_HOSTS,
    maxBytes,
  });
  return fetched.ok
    ? { ok: true as const, bytes: fetched.bytes, mediaType: fetched.mediaType }
    : { ok: false as const, code: fetched.code };
},
attachmentCaps,
```

No `hasAttachments` changes: mention enqueue and `routeRun` already carry that flag.
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run apps/daemon/src/runtime/guild-ledger.test.ts --maxWorkers=1` · Expected: PASS, no network requests
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write apps/daemon/src/runtime/guild.ts apps/daemon/src/runtime/guild-ledger.test.ts` then `npx eslint apps/daemon/src/runtime/guild.ts apps/daemon/src/runtime/guild-ledger.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add apps/daemon/src/runtime/guild.ts apps/daemon/src/runtime/guild-ledger.test.ts && git commit -m "Slice 4 T13: wire secure attachment fetch and live caps"`

**Done when:** production invocation jobs get a fetcher pinned to exactly the two Discord CDN hosts and the seven live caps; the test proves an off-host request is refused without network and every cap key is read live.

---

### S4-T14: state and privacy lines   ·   Wave 7
**Owns:** Modify: `docs/STATE.md`, `PRIVACY.md`
**Reads (do not edit):** `docs/decisions/0149-attachment-fetch-and-native-media.md` (S4-T1 wording to mirror); `apps/daemon/src/runtime/guild.ts` (S4-T13 production wiring)
**Interfaces:** Consumes: delivered attachment behaviour and allowed hosts from ADR 0149 · Produces: accurate state and privacy disclosure (documents only)

- [ ] **Step 1: Write the failing test** — documents only. Confirm scope with `rg -n "Assistant conversations and resources|Attachments on archived messages|replied-to message is sent" PRIVACY.md` and check the top of `docs/STATE.md` (the first `---`, then the current top entry to mirror).
- [ ] **Step 2: Run it and watch it fail** — no automated test applies to documentation; do not claim a test failure. Validate only after editing with `git diff --check`.
- [ ] **Step 3: Implement**
  - `docs/STATE.md`: insert after the first `---` (above the Assistant streaming entry, same bullet style):

```markdown
**Attachments (Slice 4 of `docs/superpowers/specs/2026-10-09-assistant-harness-capability-design.md`) — built on `<branch>`, not yet merged (ADR 0149, no migration).**

- **Markers (4a):** the quote envelope, channel lines and current message render `[attached: name, type, size]` even with text; embeds render `[embed: Provider: title]`; the prompt says contents below the marker are the only readable form.
- **Text (4b):** the job re-reads the current and replied-to messages through REST at start and inlines at most 3 files, 256 KB / 24,000 chars each, redacted and framed as untrusted evidence. Attached text is evidence, never instructions.
- **Images and PDFs (4c, 4d):** fetched from the Discord CDN hosts only (`cdn.discordapp.com`, `media.discordapp.net`), magic-checked, sent base64 to models that read them natively (Gemini inlineData; OpenRouter file input with the parser pinned to native). No PDF parsing or OCR anywhere. Capability routing prefers entries that can read everything; otherwise plain markers, and no bytes for what an entry cannot read.
- **Caps** are instance settings (`assistant.attachments.*`); mention jobs already carry `hasAttachments` for routing; traces keep names, kinds and sizes, never bytes.
```

(Replace `<branch>` with the real branch name from `git branch --show-current`; do not leave the placeholder.)

  - `PRIVACY.md`: under "Assistant conversations and resources", after the "that replied-to message is sent to the AI provider" bullet, add:

```markdown
- When a message tagged to Bananasaurs carries attached text files, images or PDFs, the bot downloads the current and replied-to message attachments from Discord (`cdn.discordapp.com` and `media.discordapp.net` only) and sends them to the AI provider that answers, and to no one else. Attached text is sent as redacted text; images and PDFs are sent only to models that read them directly, and a model that cannot read a file is told so instead of guessing. No file contents are stored: the bot keeps file name, type and size only.
```

In the retention table keep the "Attachments on archived messages" row and add a row: `| Attached file contents sent to the AI | Never stored; only the name, type and size travel with the conversation's trace |`. Update the "Last updated" date.

- [ ] **Step 4: Run it and watch it pass** — `git diff --check` · Expected: exit 0
- [ ] **Step 5: Typecheck** — documents only; no typecheck applies. Run `git diff --stat` and confirm only `docs/STATE.md` and `PRIVACY.md` changed.
- [ ] **Step 6: Format and lint** — `npx prettier --write docs/STATE.md PRIVACY.md` · Expected: exit 0. Do not run ESLint on Markdown.
- [ ] **Step 7: Commit** — `git add docs/STATE.md PRIVACY.md && git commit -m "Slice 4 T14: state and privacy lines for attachments"`

**Done when:** STATE names the branch, ADR and caps; PRIVACY says where attachments go, names both CDN hosts, and says contents are never stored; no placeholder branch remains.

## Slice gate (orchestrator only, after the last wave)
npm run typecheck        (≈1.7 GB peak — run alone)
npm run lint
npx vitest run --maxWorkers=1
## After merge (owner)
Deploy order: stop → build → start (no migration). Then:
1. On AI setup → Terms: confirm the provider-training disclosure still reads correctly (attachments widen what a may-train provider receives).
2. On Assistant tuning: confirm the seven `assistant.attachments.*` settings render with defaults (256 KB / 24,000 chars / 3; 5 MB / 4; 10 MB / 2).
3. In Discord: tag the bot with a `.txt` attached and empty body (expect the text inline), with a photo (expect a description, never a guess), and with a PDF while the chain top is a model without PDF input (expect "you can't read PDFs right now").
4. Confirm against a live attachment URL that the CDN hosts are exactly `cdn.discordapp.com` / `media.discordapp.net`; if Discord serves a new host, amend ADR 0149 and `ATTACHMENT_HOSTS` before wider use.
