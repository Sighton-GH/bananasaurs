# Slice 4: attachments — implementation plan

> **Instinct plan.** Read with `2026-10-10-harness-00-instinct-handoff.md` and `2026-10-10-harness-00-shared-contracts.md`.
> **Status:** DRAFT — refreshed by the controller before round 3 — controller note: add a task wiring fetchAttachmentBytes and the live caps in apps/daemon/src/runtime/guild.ts at the refresh (the draft leaves production wiring out).

**Goal:** Members can attach text files, images and PDFs to a question and the bot reads what the answering model natively supports, saying plainly what it cannot see.
**Spec:** docs/superpowers/specs/2026-10-09-assistant-harness-capability-design.md §4 (Slice 4: 4a–4d and the caps table)
**ADRs:** 0149  **Migration:** none
**Base:** main @ 0371edc3

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
  existing fetch security primitives (host allowlist, DNS pinning, public-address check, size caps, magic-byte
  checks). The ADR records the owner's D7 instruction for this destination (hard rule 8).
- No PDF parsing, extraction or OCR anywhere in Bananasaurs (D7b). PDFs go to a model only when the model reads them
  natively (Gemini `inlineData`; OpenRouter models whose metadata lists `file` input, with the file-parser plugin
  pinned to `native` so OpenRouter never substitutes `mistral-ocr` or `cloudflare-ai`). Otherwise the bot says
  plainly it cannot read PDFs.
- The outbound safety scan does not apply to image pixels. That is an accepted gap, written into ADR 0149.
- Attached text is evidence: redacted with `redactEvidenceText`, neutralised, framed as `[UNTRUSTED ATTACHMENT …]`.
  It is never put in the job payload or the run ledger beyond counts. The trace records counts, sizes and types,
  never pixels or file bytes.
- This slice runs after Slices 6 and 3 merge. It consumes Slice 6's `ModelCapabilities` (`image`, `pdf`) for routing
  and Slice 3's streaming adapters (contracts §3: `thinkingLevel`, `onProgress`, `reasoning`). Places that depend on
  merged code are marked "(after Slice 6: …)" or "(after Slice 3: …)".

## Plan decisions

- New settings group `Assistant attachments` (additive to the `SettingGroup` union); keys `assistant.attachments.*`.
- A count of 0 disables that kind (no boolean display type exists in the registry); each count help text says so.
- Attachment bytes travel as `GenerationMessage.media` (contracts §3); the trace's `included` gains an optional
  `attachments` summary (counts, sizes, types) so no migration is needed.
- Binary fetches get a `fetchBytes` method on `ReviewedResourceFetcher` reusing its redirect/host logic, because the
  existing `fetch()` enforces text-only types and decodes to UTF-8 which corrupts images and PDFs.
- The CDN `url` is preferred, `proxy_url` is the fallback; both are Discord-signed and expire in about 24 h, so the
  job re-reads both messages through REST at job start (never trusts gateway-cached URLs).
- Static GIFs only: a GIF carrying a `NETSCAPE2.0` application extension is refused as animated.
- Text sniffing by extension (`.txt .md .markdown .json .js .ts .tsx .py .rb .go .rs .java .c .h .cpp .css .html .xml
  .yml .yaml .toml .ini .cfg .log .csv .sh`) covers code files Discord serves as `application/octet-stream`.
- Media preference composes with tier order (after Slice 6): tier order first, then a stable preference for entries
  whose capabilities cover everything attached.
- Per-entry media filtering happens in the tool loop: an entry receives only the media its capabilities allow, plus
  a plain marker line for each file it cannot see.
- The tuning page renders registry settings generically, so no new dashboard component is needed; the dashboard task
  only extends the page test with the new keys.

## Review Focus

1. **A 6 MB image and a 12 MB PDF.** Expect refusal before any fetch (`too-large` on the declared size), no provider
   call carrying bytes, and a marker line. Pinned in Task 5 and Task 6.
2. **A `.txt` pasted as an attachment with an empty message body.** Expect the marker plus the framed text, fixing
   "There's no pasted text in your message". Pinned in Task 4 and Task 6.
3. **A PDF asked of a model without PDF input.** Expect no PDF bytes on the wire and the plain "you can't read PDFs
   right now" line, never a guess. Pinned in Task 10.
4. **An OpenRouter request carrying a PDF without exactly `plugins: [{ id: "file-parser", pdf: { engine: "native" }
   }]`.** Expect the Task 8 test to fail. Pinned in Task 8.
5. **An expired CDN URL on a job retry.** Expect the job to re-read the message through REST at start rather than
   reuse a stored URL. Pinned in Task 6.

## Waves

| Wave | Task | Owns (create/modify) | Depends on |
|---|---|---|---|
| 1 | S4-T1 ADR 0149 | Create: `docs/decisions/0149-attachment-fetch-and-native-media.md` | — |
| 1 | S4-T2 media types | Modify: `packages/core/src/providers/contracts.ts`; Create: `packages/core/src/providers/generation-media.test.ts` | — |
| 1 | S4-T3 attachment settings | Modify: `packages/core/src/settings/instance-settings.ts`, `packages/core/src/settings/instance-settings.test.ts` | — |
| 2 | S4-T4 markers everywhere | Modify: `packages/discord/src/rest/port.ts`, `packages/discord/src/rest/port.test.ts`, `apps/daemon/src/assistant/conversation-context.ts`, `apps/daemon/src/assistant/conversation-context.test.ts`, `apps/daemon/src/assistant/channel-context.ts`, `apps/daemon/src/assistant/channel-context.test.ts`, `apps/daemon/src/assistant/user-message.ts`, `apps/daemon/src/assistant/user-message.test.ts` | T2 |
| 2 | S4-T5 fetcher and byte checks | Modify: `apps/daemon/src/assistant/resource-fetcher.ts`, `apps/daemon/src/assistant/resource-fetcher.test.ts`; Create: `apps/daemon/src/assistant/attachments.ts`, `apps/daemon/src/assistant/attachments.test.ts` | T2, T3 |
| 3 | S4-T6 text files into the turn | Modify: `apps/daemon/src/jobs/assistant.ts`, `apps/daemon/src/jobs/assistant.test.ts` | T4, T5 |
| 3 | S4-T7 Gemini sends media | Modify: `packages/core/src/providers/gemini.ts`, `packages/core/src/providers/gemini.test.ts` | T2 |
| 3 | S4-T8 OpenRouter sends images and PDFs | Modify: `packages/core/src/providers/openai-compatible.ts`, `packages/core/src/providers/openai-compatible.test.ts` | T2 |
| 4 | S4-T9 media plumbing job to loop | Modify: `apps/daemon/src/assistant/commands.ts`, `apps/daemon/src/assistant/service.ts`, `apps/daemon/src/assistant/service.test.ts`, `apps/daemon/src/jobs/assistant.ts`, `apps/daemon/src/jobs/assistant.test.ts`, `apps/daemon/src/assistant/attachments.ts`, `apps/daemon/src/assistant/attachments.test.ts` | T2, T5, T6 |
| 4 | S4-T10 tuning page shows the caps | Modify: `packages/dashboard/src/pages/assistant-tuning.test.tsx` | T3 |
| 5 | S4-T11 capability routing and markers | Create: `apps/daemon/src/assistant/media-routing.ts`, `apps/daemon/src/assistant/media-routing.test.ts`; Modify: `apps/daemon/src/assistant/tool-loop.ts`, `apps/daemon/src/assistant/tool-loop.test.ts` | T2, T9 |
| 5 | S4-T12 trace attachment summary | Modify: `packages/core/src/assistant/trace.ts`, `packages/core/src/assistant/trace.test.ts`, `apps/daemon/src/assistant/service.ts`, `apps/daemon/src/assistant/service.test.ts`, `apps/daemon/src/jobs/assistant.ts`, `apps/daemon/src/jobs/assistant.test.ts` | T9 |
| 6 | S4-T13 state and privacy | Modify: `docs/STATE.md`, `PRIVACY.md` | T1–T12 |

## Tasks

### S4-T1: ADR 0149, attachment fetch destination and native media   ·   Wave 1
**Owns:** Create: `docs/decisions/0149-attachment-fetch-and-native-media.md`
**Reads (do not edit):** `docs/decisions/0137-read-only-tools-in-later-rounds.md` (ADR style), `docs/decisions/0120-tavily-search-and-search-key-limits.md` (rule-8 destination wording)
**Interfaces:** Consumes: none · Produces: none (documents)

- [ ] **Step 1: Write the failing test** — no test; this task is documents only. Verify the number is free: `git status --short docs/decisions/0149-*` shows nothing and `ls docs/decisions/ | grep 0149` is empty.
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
   reusing the existing fetch security primitives (DNS pinning, public-address check, redirect handling, size
   caps) plus magic-byte checks (PNG, JPEG, WebP, static GIF, `%PDF-`). A wrong magic number, an oversize file,
   or a host outside the allowlist is refused before any provider call. Each refusal has a test, refusal-first.
2. PDFs and images go to the AI provider only when the answering model reads them natively: Gemini as `inlineData`
   parts, OpenRouter models whose metadata lists `file` input with the file-parser plugin pinned to
   `plugins: [{ id: "file-parser", pdf: { engine: "native" } }]`, so OpenRouter never substitutes `mistral-ocr`
   (paid) or `cloudflare-ai` (a third party). There is no local PDF parsing, extraction, OCR, or parsing service
   anywhere (D7b). A model without the input gets a plain marker instead of the file, and the bot says so.
3. Attached text is untrusted evidence: redacted, neutralised, capped, framed as `[UNTRUSTED ATTACHMENT …]`, and
   never stored in the job payload or the run ledger beyond counts. The trace records counts, sizes and types,
   never pixels or bytes.
4. The outbound safety scan does not inspect image pixels. That is an accepted gap: text and PDF bytes pass the
   existing redaction, pixels cannot be scanned locally, and scanning them would need a service D7b forbids.

## Consequences

- `cdn.discordapp.com` and `media.discordapp.net` join the allowed outbound destinations for attachment fetches
  only; every other fetch keeps its own allowlist.
- `PRIVACY.md` says attached PDFs, images and text files go to the AI provider that answers, and to no one else.
- Caps are instance settings (`assistant.attachments.*`); a count of 0 disables that kind.
```

- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/settings/instance-settings.test.ts --maxWorkers=1` · Expected: PASS (untouched suite still green)
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write docs/decisions/0149-attachment-fetch-and-native-media.md` then `npx eslint docs/decisions/0149-attachment-fetch-and-native-media.md` · exit 0
- [ ] **Step 7: Commit** — `git add docs/decisions/0149-attachment-fetch-and-native-media.md && git commit -m "Slice 4 T1: ADR 0149 attachment fetch destination, native media only"`

**Done when:** the ADR file exists with Context, Decision and Consequences; `PRIVACY.md` wording for S4-T13 is fixed by Decision §2's last line.

---

### S4-T2: media on the provider contract   ·   Wave 1
**Owns:** Modify: `packages/core/src/providers/contracts.ts`; Create: `packages/core/src/providers/generation-media.test.ts`
**Reads (do not edit):** `packages/core/src/providers/openai-compatible.ts` (the `toWireMessage` shape the media must survive), `packages/core/src/providers/gemini.ts` (the `toContents` shape)
**Interfaces:** Consumes: none · Produces: `export interface GenerationMedia { readonly kind: 'image' | 'pdf'; readonly mediaType: string; readonly dataBase64: string; readonly name: string }` · `GenerationMessage` gains `readonly media?: readonly GenerationMedia[]` (user turns only; base64 bytes, never logged, never scanned)

- [ ] **Step 1: Write the failing test** — create `packages/core/src/providers/generation-media.test.ts` with the full code below (uses `expectTypeOf`, no new helpers):

```ts
import { describe, expect, it } from 'vitest';
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
- [ ] **Step 3: Implement** — in `packages/core/src/providers/contracts.ts`, after the `GenerationMessage` interface (lines 25–40), insert:

```ts
/** One attached file travelling to a model that reads it natively (ADR 0149). Base64 bytes: never logged, never scanned, never stored in a trace. */
export interface GenerationMedia {
  readonly kind: 'image' | 'pdf';
  readonly mediaType: string;
  readonly dataBase64: string;
  readonly name: string;
}
```

and inside `GenerationMessage`, after the `providerParts` field (lines 34–39), add:

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
**Owns:** Modify: `packages/core/src/settings/instance-settings.ts`, `packages/core/src/settings/instance-settings.test.ts`
**Reads (do not edit):** `packages/dashboard/src/pages/assistant-tuning.tsx` (renders every registry entry generically, so no page change is needed)
**Interfaces:** Consumes: none · Produces: seven keys `assistant.attachments.textMaxBytes` (default 262144), `assistant.attachments.textMaxChars` (default 24000), `assistant.attachments.textMaxCount` (default 3, min 0, max 10), `assistant.attachments.imageMaxBytes` (default 5242880), `assistant.attachments.imageMaxCount` (default 4, min 0, max 10), `assistant.attachments.pdfMaxBytes` (default 10485760), `assistant.attachments.pdfMaxCount` (default 2, min 0, max 10); group `Assistant attachments` (new additive `SettingGroup` value); a count of 0 disables that kind

- [ ] **Step 1: Write the failing test** — append to `packages/core/src/settings/instance-settings.test.ts`:

```ts
it('attachment caps default to the D7 table and a count of 0 disables that kind', () => {
  expect(INSTANCE_SETTINGS).toHaveLength(25);
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

Also update the existing `has 18 definitions` assertion to `toHaveLength(25)`.

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/settings/instance-settings.test.ts --maxWorkers=1` · Expected: FAIL with "expected 18 to have length 25" / `settingDefinition('assistant.attachments…')` undefined
- [ ] **Step 3: Implement** — in `packages/core/src/settings/instance-settings.ts`:
  - Add `'Assistant attachments'` to the `SettingGroup` union (line 12–18, after `'Assistant context'`).
  - Add seven definitions after `channelContextMessages` (lines 118–127), following its exact shape (`key`, `group: 'Assistant attachments'`, `label`, `help`, `display: 'count'`, zod `schema`, `defaultValue`, `bounds`):

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

  - Append all seven to `INSTANCE_SETTINGS` (lines 257–276) and all seven keys to `InstanceSettingValues` (lines 278–297).
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/settings/instance-settings.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/settings/instance-settings.ts packages/core/src/settings/instance-settings.test.ts` then `npx eslint packages/core/src/settings/instance-settings.ts packages/core/src/settings/instance-settings.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/settings/instance-settings.ts packages/core/src/settings/instance-settings.test.ts && git commit -m "Slice 4 T3: attachment caps in the settings registry"`

**Done when:** registry holds 25 definitions; every default parses under its own schema; help texts are Canadian English with no tool names.

---

### S4-T4: markers everywhere, no network   ·   Wave 2
**Owns:** Modify: `packages/core/src/discord/port.ts`, `packages/discord/src/rest/port.ts`, `packages/discord/src/rest/port.test.ts`, `apps/daemon/src/assistant/conversation-context.ts`, `apps/daemon/src/assistant/conversation-context.test.ts`, `apps/daemon/src/assistant/channel-context.ts`, `apps/daemon/src/assistant/channel-context.test.ts`, `apps/daemon/src/assistant/user-message.ts`, `apps/daemon/src/assistant/user-message.test.ts`
**Reads (do not edit):** `apps/daemon/src/jobs/assistant.ts` (the `quoted` shape S4-T6 threads through; this task does not touch it), `packages/discord/src/events.test.ts` (the event already carries attachments metadata — no change needed)
**Interfaces:** Consumes: none · Produces: `export interface FetchedAttachment { readonly attachmentId: string; readonly fileName: string; readonly contentType?: string | undefined; readonly sizeBytes: number; readonly url?: string | undefined }` and `export interface FetchedEmbed { readonly title?: string | undefined; readonly description?: string | undefined; readonly providerName?: string | undefined; readonly thumbnailUrl?: string | undefined }` in `packages/core/src/discord/port.ts` · `fetchMessageContent` returns them; `RecentMessage` gains `readonly attachments?: readonly FetchedAttachment[] | undefined` · `export const attachmentMarker = (file: { readonly fileName: string; readonly contentType?: string | undefined; readonly sizeBytes: number }): string` in `conversation-context.ts` (S4-T6 reuses it)

- [ ] **Step 1: Write the failing test** — full test code below, using the real helpers of each file (`messageCreatePacket`/`harness` in `events.test.ts` style for port tests; `message()`/`input()` in `channel-context.test.ts`; `quoteEnvelopeFor` directly; `buildUserMessage` directly).

In `packages/discord/src/rest/port.test.ts`, extend the `fetchMessageContent` test (the "fetches one message's author, content and embeds" test near line 725; read it first) with a body attachment carrying a URL and an embed with a provider:

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

(`harness`, `MESSAGE`, `CHANNEL`, `GUILD`, `USER` are the existing names in that file; if any differs, use the file's name.)

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

In `apps/daemon/src/assistant/channel-context.test.ts` (using its `message()` helper):

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
  - `packages/core/src/discord/port.ts`: add the `FetchedAttachment` and `FetchedEmbed` interfaces above `DiscordPort`; change the `fetchMessageContent` return to `Promise<{ authorId: Snowflake; authorName: string; content: string; attachments: readonly FetchedAttachment[]; embeds: readonly FetchedEmbed[] } | undefined>`; add `readonly attachments?: readonly FetchedAttachment[] | undefined` to `RecentMessage` with the comment "Attachment metadata for marker lines (ADR 0149); absent means unknown, not none".
  - `packages/discord/src/rest/port.ts` `fetchMessageContent` (lines 361–380): map `message.attachments ?? []` to `{ attachmentId: a.id, fileName: a.filename, contentType: a.content_type ?? undefined, sizeBytes: a.size, url: a.url ?? a.proxy_url ?? undefined }` omitting `contentType`/`url` keys when undefined (the codebase style is `...(x === undefined ? {} : { x })`), and `message.embeds ?? []` to `{ title, description, providerName: provider?.name, thumbnailUrl: thumbnail?.url ?? thumbnail?.proxy_url }` omitting undefined keys. Same mapping for `fetchChannelMessages` (line 446 area): add `attachments:` to the mapped message alongside `hasAttachments`.
  - `apps/daemon/src/assistant/conversation-context.ts`: add `export const attachmentMarker = (file: { readonly fileName: string; readonly contentType?: string | undefined; readonly sizeBytes: number }): string => \`[attached: ${neutraliseMarkers(file.fileName)}, ${file.contentType ?? 'unknown type'}, ${Math.max(1, Math.round(file.sizeBytes / 1024))} KB]\`;` extend `QuotedMessage` with `readonly attachments?: readonly { readonly fileName: string; readonly contentType?: string | undefined; readonly sizeBytes: number }[] | undefined` and `readonly embeds?: readonly { readonly title?: string | undefined; readonly description?: string | undefined; readonly providerName?: string | undefined }[] | undefined`; extend `quoteEnvelopeFor` to append marker lines then embed lines before the close tag. Embed line: `` `[embed: ${[e.providerName, e.title].filter(Boolean).join(': ')}${e.description === undefined ? '' : ` — ${e.description}`}]` `` skipping embeds with no title and no providerName. Neutralise every interpolated field.
  - `apps/daemon/src/assistant/channel-context.ts`: import `attachmentMarker`; in both `formatChannelLines` and `buildChannelContext`, replace `const text = message.content.trim() === '' ? '[attachment]' : cleanText(...)` with markers appended: `const markers = (message.attachments ?? []).map(attachmentMarker).join(' '); const body = message.content.trim() === '' ? (markers === '' ? '[attachment]' : markers) : cleanText(message.content) + (markers === '' ? '' : ` ${markers}`);` Apply the same in the starter block only if the starter type carries attachments — it does not, so leave the starter untouched.
  - `apps/daemon/src/assistant/user-message.ts`: after `parts.push(currentBlock)` insert `parts.push('You can read an attachment only if its contents appear below.');`
  - Search `rg -n "RecentMessage" packages apps --include="*.ts"` for other constructors; optional field keeps them compiling — verify with typecheck, and update any `toEqual` on `fetchChannelMessages` output (only `port.test.ts`, owned here).
- [ ] **Step 4: Run it and watch it pass** — same command as Step 2 · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write <all eight owned paths>` then `npx eslint <all eight owned paths>` · exit 0
- [ ] **Step 7: Commit** — `git add <all eight owned paths> && git commit -m "Slice 4 T4: attachment and embed markers in quote, channel lines and prompt"`

**Done when:** a `[attached: …]` line renders with text present (the "no pasted text" case); embeds render as `[embed: Tenor: …]`; the prompt line is always present; no bytes travel anywhere yet.

---

### S4-T5: attachment bytes through the existing security primitives   ·   Wave 2
**Owns:** Modify: `apps/daemon/src/assistant/resource-fetcher.ts`, `apps/daemon/src/assistant/resource-fetcher.test.ts`; Create: `apps/daemon/src/assistant/attachments.ts`, `apps/daemon/src/assistant/attachments.test.ts`
**Reads (do not edit):** `packages/core/src/providers/outbound-safety.ts` (`redactEvidenceText`, used for text envelopes)
**Interfaces:** Consumes: `resolvePublicAddress`, `pinnedHttpsRequest`, `isPublicAddress`, `DEFAULT_RESOURCE_FETCH_LIMITS`, `ResourceFetchFailure` from `resource-fetcher.ts` (same task extends it); `redactEvidenceText` from `@bananasaurs/core` · Produces: `export const ATTACHMENT_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'] as const` · `export interface AttachmentSource { readonly fileName: string; readonly contentType?: string | undefined; readonly sizeBytes: number; readonly url?: string | undefined }` · `export type AttachmentKind = 'text' | 'image' | 'pdf' | 'unsupported'` · `export const classifyAttachment = (source: AttachmentSource): AttachmentKind` (pre-fetch, from content type and extension) · `export const sniffMediaKind = (bytes: Uint8Array): 'image' | 'pdf' | 'text' | 'animated-gif' | 'unknown'` (magic bytes) · `export const textEnvelopeFor = (name: string, text: string): string` (redacted, neutralised, framed) · `export const fetchAttachment = (deps: { fetchBytes: (url: string, maxBytes: number) => Promise<{ ok: true; bytes: Uint8Array; mediaType: string } | { ok: false; code: string }> }, source: AttachmentSource, caps: AttachmentCaps): Promise<AttachmentFetchResult>` enforcing declared-size caps before any fetch

- [ ] **Step 1: Write the failing test** — create `packages/…` no; create `apps/daemon/src/assistant/attachments.test.ts` with the full code below, plus append the `fetchBytes` tests to `resource-fetcher.test.ts` (reusing its `body`, `response`, `publicDns` helpers):

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

In `resource-fetcher.test.ts`, append (reusing `body`, `response`, `publicDns`):

```ts
it('fetchBytes returns raw bytes for an allowlisted host and refuses anything else', async () => {
  const fetcher = new ReviewedResourceFetcher({ resolve: publicDns });
  const okBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const request: PinnedRequest = async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: (async function* () { yield okBytes; })() });
  const fetcherWith = new ReviewedResourceFetcher({ resolve: publicDns, request });
  const good = await fetcherWith.fetchBytes('https://cdn.discordapp.com/attachments/1/2/a.png', {
    allowedHosts: ['cdn.discordapp.com', 'media.discordapp.net'],
    maxBytes: 5_242_880,
  });
  expect(good).toMatchObject({ ok: true, mediaType: 'image/png' });
  if (good.ok) expect([...good.bytes]).toEqual([...okBytes]);
  const bad = await fetcher.fetchBytes('https://evil.example/a.png', {
    allowedHosts: ['cdn.discordapp.com', 'media.discordapp.net'],
    maxBytes: 5_242_880,
  });
  expect(bad).toMatchObject({ ok: false, code: 'redirect', host: 'evil.example' });
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run apps/daemon/src/assistant/attachments.test.ts apps/daemon/src/assistant/resource-fetcher.test.ts --maxWorkers=1` · Expected: FAIL (modules `attachments.ts` and `fetchBytes` missing)
- [ ] **Step 3: Implement**
  - `resource-fetcher.ts`: add after the class (or as a method; a method keeps the resolve/request/limits wiring):

```ts
export interface ByteFetchOptions {
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number;
  /** Absent means any content type is accepted. */
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

Method `async fetchBytes(rawUrl: string, options: ByteFetchOptions): Promise<ByteFetchResult>` mirroring `#fetchFrom` exactly (validate URL, allowlist check with `fail('redirect', …)`, resolve, public-address check, pinned request per address, redirect follow up to `maxRedirects` with per-hop allowlist re-check, 304/3xx/4xx-5xx/challenge handling, `allowedTypes` check when set, declared-length pre-check, streamed cap) except it returns `bytes: Buffer.concat(chunks)` and `mediaType`, with no cache and no text decoding. Copy the structure, do not refactor `#fetchFrom`.
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
  const text = Buffer.from(fetched.bytes).toString('utf8').replaceAll(' ', '');
  return { ok: true, kind: 'text', name: source.fileName, text };
};
```

  Note: the `'\u0000'` strip is written as `replaceAll(' ', '')` above — write it as `replaceAll('\u0000', '')` with a real escape in the file.
- [ ] **Step 4: Run it and watch it pass** — same command as Step 2 · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write <all four owned paths>` then `npx eslint <all four owned paths>` · exit 0
- [ ] **Step 7: Commit** — `git add <all four owned paths> && git commit -m "Slice 4 T5: attachment fetch with host, size and magic-byte refusals"`

**Done when:** every refusal (off-host, missing URL, oversize, bad magic, animated GIF) is tested before the fetch it guards; text frames as `[UNTRUSTED ATTACHMENT …]` with redaction; no network in tests (injected `fetchBytes`).

---

### S4-T6: text files into the turn   ·   Wave 3
**Owns:** Modify: `apps/daemon/src/jobs/assistant.ts`, `apps/daemon/src/jobs/assistant.test.ts`
**Reads (do not edit):** `apps/daemon/src/assistant/attachments.ts` (S4-T5: `fetchAttachment`, `textEnvelopeFor`, `AttachmentCaps`), `apps/daemon/src/assistant/conversation-context.ts` (S4-T4: `attachmentMarker`, `QuotedMessage` attachments/embeds), `packages/core/src/settings/instance-settings.ts` (S4-T3 cap keys)
**Interfaces:** Consumes: `fetchAttachment`, `textEnvelopeFor`, `AttachmentCaps`, `attachmentMarker`, the seven `assistant.attachments.*` settings · Produces: job-start re-read of the current and replied-to messages; text blocks appended to the quote envelope and a new `attachmentText` user-message part; per-file `[attached: …]` markers plus refusal notes; embed thumbnails collected as image sources for S4-T9

- [ ] **Step 1: Write the failing test** — in `apps/daemon/src/jobs/assistant.test.ts`, using its existing harness (`h.fetchMessageContent.mockResolvedValue`, `h.inputs[0]?.quoteEnvelope`; read the quote tests near lines 882–1013 first). Add:

```ts
it('inlines text attachments from the current and quoted messages with markers (ADR 0149)', async () => {
  h.fetchMessageContent.mockImplementation(async (channelId: string, messageId: string) => {
    if (messageId === '840000000000000001')
      return {
        authorId: '111111111111111111',
        authorName: 'Alex P',
        content: 'the hall opens at seven',
        attachments: [
          { attachmentId: '1', fileName: 'message.txt', contentType: 'text/plain', sizeBytes: 12, url: 'https://cdn.discordapp.com/attachments/1/2/message.txt' },
        ],
        embeds: [],
      };
    return { authorId: '222222222222222222', authorName: 'Sam L', content: 'The one I just pasted:', attachments: [], embeds: [] };
  });
  h.fetchAttachmentBytes.mockResolvedValue({ ok: true, bytes: Buffer.from('pasted details'), mediaType: 'text/plain' });
  await h.runMentionWithAttachments();
  expect(h.inputs[0]?.quoteEnvelope).toContain('[attached: message.txt, text/plain, 1 KB]');
  expect(h.inputs[0]?.quoteEnvelope).toContain('[UNTRUSTED ATTACHMENT name="message.txt"]');
  expect(h.inputs[0]?.quoteEnvelope).toContain('pasted details');
});

it('re-reads the message at job start so an expired CDN url never persists (ADR 0149)', async () => {
  await h.runMentionWithAttachments();
  expect(h.fetchMessageContent).toHaveBeenCalledWith(CHANNEL_ID, expect.any(String));
  expect(h.fetchAttachmentBytes).not.toHaveBeenCalledWith(expect.stringContaining('expired'), expect.anything());
});

it('caps text files at three per message and 24,000 chars each (ADR 0149)', async () => {
  h.fetchMessageContent.mockResolvedValue({
    authorId: '111', authorName: 'Sam L', content: '', attachments: [1, 2, 3, 4].map((n) => ({ attachmentId: `${n}`, fileName: `f${n}.txt`, contentType: 'text/plain', sizeBytes: 10, url: `https://cdn.discordapp.com/attachments/1/${n}/f${n}.txt` })), embeds: [],
  });
  h.fetchAttachmentBytes.mockResolvedValue({ ok: true, bytes: Buffer.from('x'.repeat(30_000)), mediaType: 'text/plain' });
  await h.runMentionWithAttachments();
  expect(h.inputs[0]?.quoteEnvelope).toContain('cut after 24,000 characters');
  expect(h.inputs[0]?.quoteEnvelope?.match(/\[UNTRUSTED ATTACHMENT/g)).toHaveLength(3);
});
```

The harness needs two additions (write them as part of Step 3, test-first): a `fetchAttachmentBytes` mock dep on the job (`(url: string, maxBytes: number) => …`, defaulting to a failing stub so tests without it fetch nothing) and a `runMentionWithAttachments` helper that enqueues a mention whose `messageId`/`referencedMessageId` resolve through the mocked `fetchMessageContent`. If the harness names differ (`CHANNEL_ID`, input capture `h.inputs`), use the file's names.

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run apps/daemon/src/jobs/assistant.test.ts --maxWorkers=1` · Expected: FAIL (`runMentionWithAttachments`/`fetchAttachmentBytes` missing; no text blocks)
- [ ] **Step 3: Implement** — in `apps/daemon/src/jobs/assistant.ts`, after the quote fetch resolves `quoted` (lines 789–816) and inside the same `payload.channelId !== undefined && deps.conversations !== undefined` branch:
  - Add an optional job dep `fetchAttachmentBytes?: ((url: string, maxBytes: number) => Promise<{ ok: true; bytes: Uint8Array; mediaType: string } | { ok: false; code: string }>) | undefined`. Production (`runtime/guild.ts`, out of scope) wires it to a `ReviewedResourceFetcher.fetchBytes` bound with the live attachment settings; absent means attachments stay markers-only and every file gets the note "attachments could not be read right now".
  - Add an optional `attachmentCaps?: (() => AttachmentCaps) | undefined` dep reading the seven live settings; absent means the D7 defaults from S4-T3.
  - Re-read the current message: `await deps.fetchMessageContent(channelId, payload.messageId)` when `payload.messageId !== undefined` (fresh signed URLs — never trust gateway-cached ones; a retry re-reads too). Its text attachments and the quoted message's text attachments each go through `fetchAttachment({ fetchBytes: deps.fetchAttachmentBytes ?? refusingStub }, source, caps)`, at most `textMaxCount` files per message (extras get a "skipped: at most 3 text files per message" note), each cut to `textMaxChars` with a "cut after 24,000 characters" note (use the live cap values in the notes, not literals).
  - Text results append `textEnvelopeFor(name, cutText)` to the quote envelope (quoted message) or to a new `attachmentText` string passed to `service.invoke` via the existing `channelContext`? No — new optional `AssistantInvocation` field is S4-T9's. Here: append current-message text blocks to `channelContext`? That mislabels them. Instead pass them inside `quoteEnvelope` only for the quoted message, and for the current message append a second `[UNTRUSTED ATTACHMENT …]` block to the channel-context string? Mislabelling again. Correct: this task extends the job's `quoted` object with `attachments`/`embeds` (S4-T4's `QuotedMessage` fields) so markers render, and appends fetched text blocks to `quoteEnvelope` for the quoted message; for the current message, prepend the text blocks to the question? That pollutes the stored question. Decision: current-message text blocks travel in a new local `attachmentText` variable joined into the `service.invoke` call as `channelContext: [existing, attachmentText].filter(Boolean).join('\n\n')` with a `[UNTRUSTED MESSAGE ATTACHMENTS]` wrapper (not channel messages). Name the wrapper exactly `[UNTRUSTED MESSAGE ATTACHMENTS]\n…\n[/UNTRUSTED MESSAGE ATTACHMENTS]`.
  - Refusals (`too-large`, `bad-magic`, `fetch-failed`, count cap) become one line each next to the marker: `[attached: big.zip, application/zip, 900 KB] (skipped: over the size limit)`. Unsupported kinds (audio/video/exe) keep the marker with `(not read: audio and video are not supported)`.
  - Embed thumbnails (`thumbnailUrl` on `media.discordapp.net`) are collected as `{ fileName: 'embed thumbnail', url }` image sources and returned alongside (stored in a local, passed to S4-T9's plumbing; for this task, log their count and include their markers).
  - Nothing attachment-derived enters the job payload, the conversation turns, or the trace beyond what `quoteEnvelope`/`channelContext` already carry (strings the trace already handles).
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run apps/daemon/src/jobs/assistant.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write apps/daemon/src/jobs/assistant.ts apps/daemon/src/jobs/assistant.test.ts` then `npx eslint apps/daemon/src/jobs/assistant.ts apps/daemon/src/jobs/assistant.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add apps/daemon/src/jobs/assistant.ts apps/daemon/src/jobs/assistant.test.ts && git commit -m "Slice 4 T6: text attachments re-read at job start and inlined as evidence"`

**Done when:** the "no pasted text" case now inlines the file; expired URLs are never reused (re-read proved by test); caps enforced per message with notes; no bytes in payload/turns/trace beyond existing string envelopes.

---

### S4-T7: Gemini sends media as inlineData   ·   Wave 3
**Owns:** Modify: `packages/core/src/providers/gemini.ts`, `packages/core/src/providers/gemini.test.ts`
**Reads (do not edit):** `packages/core/src/providers/contracts.ts` (S4-T2 `GenerationMedia`)
**Interfaces:** Consumes: `GenerationMedia`, `GenerationMessage.media` (S4-T2) · Produces: wire format below (no new exports)

- [ ] **Step 1: Write the failing test** — in `packages/core/src/providers/gemini.test.ts`, using its `ok()` helper and `fetch` mock:

```ts
it('sends user-turn media as inlineData parts after the text (ADR 0149)', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    ok({
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
  const [, init] = fetch.mock.calls[0] ?? [];
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
    ok({ candidates: [{ content: { parts: [{ text: 'ok' }] } }], modelVersion: 'm' }),
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
- [ ] **Step 3: Implement** — in `packages/core/src/providers/gemini.ts` `toContents` (lines 59–88): the user branch (lines 82–85) becomes:

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

Assistant turns (plain or `providerParts`) are unchanged — media on an assistant turn is ignored (never produced). No Discord URL ever leaves the process: only base64 `data` is sent. (After Slice 3: this composes with `:streamGenerateContent?alt=sse` and `thinkingLevel`; the parts shape is unchanged by streaming.)
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/providers/gemini.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/providers/gemini.ts packages/core/src/providers/gemini.test.ts` then `npx eslint packages/core/src/providers/gemini.ts packages/core/src/providers/gemini.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/providers/gemini.ts packages/core/src/providers/gemini.test.ts && git commit -m "Slice 4 T7: Gemini sends attached images and PDFs as inlineData"`

**Done when:** image and PDF media arrive as `inlineData` parts after the text; no URL on the wire; assistant turns unchanged.

---

### S4-T8: OpenRouter sends images and PDFs, plugin pinned   ·   Wave 3
**Owns:** Modify: `packages/core/src/providers/openai-compatible.ts`, `packages/core/src/providers/openai-compatible.test.ts`
**Reads (do not edit):** `packages/core/src/providers/contracts.ts` (S4-T2 `GenerationMedia`)
**Interfaces:** Consumes: `GenerationMedia`, `GenerationMessage.media` (S4-T2) · Produces: wire format below (no new exports). Every request carrying a PDF asserts exactly `plugins: [{ id: "file-parser", pdf: { engine: "native" } }]` so OpenRouter never substitutes `mistral-ocr` or `cloudflare-ai` (D7b)

- [ ] **Step 1: Write the failing test** — in `packages/core/src/providers/openai-compatible.test.ts`, using its `response`/`fetch` pattern:

```ts
it('sends images as data-url parts and PDFs as file parts with the native plugin (ADR 0149)', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response.clone());
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

it('sends no plugins and plain string content when there is no PDF (ADR 0149)', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response.clone());
  const provider = createOpenRouterProvider({ apiKey: 'secret', fetch });
  await provider.generateText({
    model: 'free-model',
    messages: [{ role: 'user', text: 'hello', media: [{ kind: 'image', mediaType: 'image/png', dataBase64: 'aGk=', name: 'a.png' }] }],
  });
  const [, init] = fetch.mock.calls[0] ?? [];
  const body = JSON.parse(init?.body as string);
  expect(body.plugins).toBeUndefined();
  expect(body.messages.at(-1)?.content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } });
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/providers/openai-compatible.test.ts --maxWorkers=1` · Expected: FAIL (media dropped; no plugins)
- [ ] **Step 3: Implement** — in `packages/core/src/providers/openai-compatible.ts`:
  - `toWireMessage` (lines 239–268): the final user branch (line 267) becomes media-aware:

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

  - In `generateText`'s body (lines 304–329): compute `const hasPdf = request.messages.some((m) => m.role === 'user' && (m.media ?? []).some((x) => x.kind === 'pdf'));` and add `...(hasPdf ? { plugins: [{ id: 'file-parser', pdf: { engine: 'native' } }] } : {})` to the JSON body. NIM shares the class: the plugin key is added for NIM too when a PDF rides along; NIM models never receive PDFs from routing (S4-T10), and the test pins OpenRouter only.
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/core/src/providers/openai-compatible.test.ts --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/core/src/providers/openai-compatible.ts packages/core/src/providers/openai-compatible.test.ts` then `npx eslint packages/core/src/providers/openai-compatible.ts packages/core/src/providers/openai-compatible.test.ts` · exit 0
- [ ] **Step 7: Commit** — `git add packages/core/src/providers/openai-compatible.ts packages/core/src/providers/openai-compatible.test.ts && git commit -m "Slice 4 T8: OpenRouter sends images and PDFs with the native file-parser plugin"`

**Done when:** images go as `image_url` data URLs, PDFs as `file` parts with exactly the native plugin; no PDF means no plugins and unchanged string content for text-only turns; no URL on the wire.

---

### S4-T9: media plumbing from the job to the loop   ·   Wave 4
**Owns:** Modify: `apps/daemon/src/assistant/commands.ts`, `apps/daemon/src/assistant/service.ts`, `apps/daemon/src/assistant/service.test.ts`, `apps/daemon/src/jobs/assistant.ts`, `apps/daemon/src/jobs/assistant.test.ts`, `apps/daemon/src/assistant/attachments.ts`, `apps/daemon/src/assistant/attachments.test.ts`
**Reads (do not edit):** `apps/daemon/src/assistant/tool-loop.ts` (line 590 builds provider messages from history; it already forwards `GenerationMessage.media` on user turns to S4-T7/T8 — this task does not touch it), `packages/core/src/providers/contracts.ts` (S4-T2)
**Interfaces:** Consumes: `fetchAttachment`, `AttachmentCaps`, `ATTACHMENT_HOSTS` (S4-T5); `GenerationMedia` (S4-T2) · Produces: `export interface AttachmentSummary { readonly name: string; readonly kind: 'text' | 'image' | 'pdf'; readonly sizeBytes: number }` in `commands.ts` · `AssistantInvocation` gains `readonly media?: readonly GenerationMedia[] | undefined` and `readonly attachmentSummary?: readonly AttachmentSummary[] | undefined` · `fetchAttachment` gains an optional fourth parameter `forceKind?: AttachmentKind` (for embed thumbnails, which have no filename)

- [ ] **Step 1: Write the failing test** — in `apps/daemon/src/assistant/service.test.ts`, inside the B2b-style capture pattern (Slice 1 Task 6 `capture()`):

```ts
it('forwards invocation media on a trailing user message, bytes never in the trace (ADR 0149)', async () => {
  const { requests, provider } = capture();
  await h.serviceWith(provider).invoke(
    ask({
      userId: OWNER, callerRoleIds: [], invocationId: 'int-media-1',
      input: { question: 'what is this chart?' },
      media: [{ kind: 'image', mediaType: 'image/png', dataBase64: 'aGk=', name: 'chart.png' }],
      attachmentSummary: [{ name: 'chart.png', kind: 'image', sizeBytes: 3 }],
    }),
  );
  const lastHistory = requests[0]?.messages.at(-1);
  expect(lastHistory?.role).toBe('user');
  expect(lastHistory?.text).toBe('[attached files: chart.png]');
  expect(lastHistory?.media).toHaveLength(1);
});
```

If `media`/`attachmentSummary` are not on the invocation input type the harness accepts, read `rg -n "quoteEnvelope|channelContext" apps/daemon/src/assistant/commands.ts` and pass them where the type expects them. In `apps/daemon/src/jobs/assistant.test.ts`, extend the S4-T6 harness:

```ts
it('fetches images and PDFs up to their caps and passes bytes with a summary (ADR 0149)', async () => {
  h.fetchMessageContent.mockResolvedValue({
    authorId: '111', authorName: 'Sam L', content: 'look', attachments: [
      { attachmentId: '1', fileName: 'chart.png', contentType: 'image/png', sizeBytes: 100, url: 'https://cdn.discordapp.com/attachments/1/2/chart.png' },
      { attachmentId: '2', fileName: 'report.pdf', contentType: 'application/pdf', sizeBytes: 200, url: 'https://cdn.discordapp.com/attachments/1/2/report.pdf' },
    ], embeds: [],
  });
  h.fetchAttachmentBytes.mockImplementation(async (url: string) => ({
    ok: true as const,
    bytes: url.endsWith('.png') ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) : new Uint8Array([...Buffer.from('%PDF-1.7', 'utf8')]),
    mediaType: url.endsWith('.png') ? 'image/png' : 'application/pdf',
  }));
  await h.runMentionWithAttachments();
  expect(h.invokeMedia()?.map((m) => m.name)).toEqual(['chart.png', 'report.pdf']);
  expect(h.invokeSummary()).toEqual([
    { name: 'chart.png', kind: 'image', sizeBytes: 8 },
    { name: 'report.pdf', kind: 'pdf', sizeBytes: 8 },
  ]);
});
```

(`h.invokeMedia`/`h.invokeSummary` capture the `service.invoke` input; add them to the harness in Step 3.) In `attachments.test.ts`:

```ts
it('forceKind reads an embed thumbnail with no usable filename (ADR 0149)', async () => {
  const fetchBytes = vi.fn(async () => ({ ok: true as const, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mediaType: 'image/png' }));
  const result = await fetchAttachment({ fetchBytes }, { fileName: 'embed thumbnail', sizeBytes: 8, url: 'https://media.discordapp.net/thumb.png' }, caps(), 'image');
  expect(result).toMatchObject({ ok: true, kind: 'image' });
});
```

(`caps()` returns the D7 defaults object from the S4-T5 tests; factor it into a helper in that file.)

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run apps/daemon/src/assistant/service.test.ts apps/daemon/src/jobs/assistant.test.ts apps/daemon/src/assistant/attachments.test.ts --maxWorkers=1` · Expected: FAIL (`media` unknown on the input; no trailing media message; no `invokeMedia`; no `forceKind`)
- [ ] **Step 3: Implement**
  - `attachments.ts`: `fetchAttachment(deps, source, caps, forceKind?: AttachmentKind)` — when `forceKind` is set, skip `classifyAttachment` and use it for the byte cap, the magic expectation and the result kind. Nothing else changes.
  - `commands.ts`: import `GenerationMedia` type from `@bananasaurs/core` (next to `GenerationMessage`); add `export interface AttachmentSummary { readonly name: string; readonly kind: 'text' | 'image' | 'pdf'; readonly sizeBytes: number }`; add the two optional fields to `AssistantInvocation` with the comment "ADR 0149: fetched attachment bytes for models that read them natively, and the metadata-only summary the trace keeps".
  - `service.ts`: replace `const historyForLoop: readonly GenerationMessage[] = input.history ?? [];` (near line 1240) with:

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

The note text (names only, never bytes) flows into the trace history section like any user text; the bytes ride `media`, which no trace writer reads. The note counts as one user turn in `historyTurns`; that is intended and the test pins it.
  - `jobs/assistant.ts`: extend the S4-T6 per-message processing to image and PDF kinds: per message, the first `imageMaxCount` image-kind attachments and first `pdfMaxCount` PDF-kind attachments (extras get "(skipped: at most 4 images per message)" / "(skipped: at most 2 PDFs per message)" notes with the live values) go through `fetchAttachment`; embed thumbnails on `media.discordapp.net` go through with `forceKind: 'image'` and fileName `'embed thumbnail'`. Collect `media: GenerationMedia[]` (image/pdf successes) and `attachmentSummary: AttachmentSummary[]` (every fetched file of every kind, using the fetched byte length as `sizeBytes`). Pass both into the existing `deps.service.invoke({…})` call (near line 1067). Refusals become marker-side notes exactly like S4-T6's text refusals.
- [ ] **Step 4: Run it and watch it pass** — same command as Step 2 · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write <all seven owned paths>` then `npx eslint <all seven owned paths>` · exit 0
- [ ] **Step 7: Commit** — `git add <all seven owned paths> && git commit -m "Slice 4 T9: attachment bytes and summary from the job to the loop"`

**Done when:** images/PDFs/thumbnails fetch under their caps with magic checks; bytes reach the loop only on the trailing user message; the summary carries names/kinds/sizes and no bytes; refusals read as plain notes.

---

### S4-T10: tuning page shows the attachment caps   ·   Wave 4
**Owns:** Modify: `packages/dashboard/src/pages/assistant-tuning.test.tsx`
**Reads (do not edit):** `packages/dashboard/src/pages/assistant-tuning.tsx` (generic registry rendering — no change), `packages/dashboard/src/test-support.tsx` (`renderWithSession`, `stubFetch`, `bodyOf`)
**Interfaces:** Consumes: the seven `assistant.attachments.*` keys (S4-T3) · Produces: none (test only)

- [ ] **Step 1: Write the failing test** — append to the `describe('AssistantTuningPage', …)` block (read from line 115 first for the existing render/save pattern). Add the seven attachment settings to the `SETTINGS` fixture (same shape: key, group `'Assistant attachments'`, label, help, display `'count'`, bounds, value, defaultValue, isDefault), then:

```tsx
it('renders the attachment caps under Assistant attachments and saves one', async () => {
  stubFetch(SETTINGS);
  renderPage();
  const row = await screen.findByTestId('tuning-row-assistant.attachments.imageMaxCount');
  expect(within(row).getByText('Images read per message')).toBeTruthy();
  expect(within(row).getByText(/0 turns image attachments off/)).toBeTruthy();
  const save = within(row).getByRole('button', { name: /save/i });
  fireEvent.change(within(row).getByRole('spinbutton'), { target: { value: '2' } });
  await act(async () => { fireEvent.click(save); });
  expect(bodyOf()).toMatchObject({ key: 'assistant.attachments.imageMaxCount', value: 2 });
});
```

(If the row's input role or save-button name differs, use the names the existing save test in the same file uses.)

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/dashboard/src/pages/assistant-tuning.test.tsx --maxWorkers=1` · Expected: FAIL (fixture lacks the keys; row missing)
- [ ] **Step 3: Implement** — test only: extend the `SETTINGS` fixture and add the test above. No page change: the tuning page renders every registry entry generically (§4.7). If the page does not render the new group, that is a page bug — fix it in this task only if the test proves it, keeping the change to mounting (contracts §4).
- [ ] **Step 4: Run it and watch it pass** — `npx vitest run packages/dashboard/src/pages/assistant-tuning.test.tsx --maxWorkers=1` · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write packages/dashboard/src/pages/assistant-tuning.test.tsx` then `npx eslint packages/dashboard/src/pages/assistant-tuning.test.tsx` · exit 0
- [ ] **Step 7: Commit** — `git add packages/dashboard/src/pages/assistant-tuning.test.tsx && git commit -m "Slice 4 T10: tuning page renders and saves the attachment caps"`

**Done when:** every new cap renders with its help text and one saves through the existing endpoint; no dashboard component changes.

---

### S4-T11: capability routing and per-entry markers   ·   Wave 5
**Owns:** Create: `apps/daemon/src/assistant/media-routing.ts`, `apps/daemon/src/assistant/media-routing.test.ts`; Modify: `apps/daemon/src/assistant/tool-loop.ts`, `apps/daemon/src/assistant/tool-loop.test.ts`
**Reads (do not edit):** `apps/daemon/src/assistant/model-chain.ts` (the `ChainEntry` shape S4-T9 extended? No — capabilities come from Slice 6), `packages/core/src/providers/contracts.ts` (S4-T2)
**Interfaces:** Consumes: `GenerationMedia`, `GenerationMessage` (S4-T2) · (after Slice 6: `ChainEntry` carries `readonly capabilities: ModelCapabilities` with `image`/`pdf` booleans from `packages/core/src/providers/model-capabilities.ts`; `capabilitiesForEntry` in `apps/daemon/src/assistant/model-capabilities.ts`. Verify both paths in the merged code before writing — if the controller renamed them, use the merged names and note the change in the commit message.) · Produces: `export const entryCanRead = (caps: { readonly image: boolean; readonly pdf: boolean } | undefined, media: readonly GenerationMedia[]): boolean` (absent caps means text-only: false when media is present) · `export const orderEntriesForMedia = <T extends { readonly capabilities?: { readonly image: boolean; readonly pdf: boolean } | undefined }>(entries: readonly T[], media: readonly GenerationMedia[]): readonly T[]` (stable: entries that can read everything attached first; no media means unchanged order) · `export const messagesForEntry = (messages: readonly GenerationMessage[], caps: { readonly image: boolean; readonly pdf: boolean } | undefined): GenerationMessage[]` (strips disallowed media from every user message; appends one plain line per stripped file to the last user message: `${name} attached; you can't see images right now.` / `${name} attached; you can't read PDFs right now.`)

- [ ] **Step 1: Write the failing test** — create `apps/daemon/src/assistant/media-routing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { entryCanRead, messagesForEntry, orderEntriesForMedia } from './media-routing.js';
import type { GenerationMedia } from '@bananasaurs/core';

const image: GenerationMedia = { kind: 'image', mediaType: 'image/png', dataBase64: 'aGk=', name: 'chart.png' };
const pdf: GenerationMedia = { kind: 'pdf', mediaType: 'application/pdf', dataBase64: 'amVm', name: 'report.pdf' };
const none = { image: false, pdf: false };
const seeImage = { image: true, pdf: false };
const seeAll = { image: true, pdf: true };

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
    expect(out[0]?.text).toContain('report.pdf attached; you can\'t read PDFs right now.');
    expect(out[0]?.text).not.toContain('chart.png attached');
  });
});
```

In `tool-loop.test.ts`, using its `scripted`/`entry`/`baseInput` helpers (Slice 1 Task 7), add a test with two fake providers capturing their requests: chain order [text-only, image-capable], user history carrying one image — the image-capable entry is called first and its request carries the media, while a run where no entry can read sends stripped messages with the plain marker. (Read the current `entry()` helper first; after Slice 6 it carries `capabilities` — set them per entry in the test.)

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run apps/daemon/src/assistant/media-routing.test.ts apps/daemon/src/assistant/tool-loop.test.ts --maxWorkers=1` · Expected: FAIL (module missing; chain order never changes)
- [ ] **Step 3: Implement**
  - `media-routing.ts`: the three functions exactly as specified. `messagesForEntry` keeps message identity for untouched messages (map, only rebuilding user messages that lose media); the marker lines append to the last message with `role === 'user'` (which is always the current question or the S4-T9 media note). Neutralise file names in markers via the existing `neutraliseMarkers` in `../assistant/untrusted.js`? That path is `./untrusted.js` (same directory) — import from there.
  - `tool-loop.ts`: after the recorder setup and before the entry loop (line 317 `for (let position …`), insert:

```ts
const runMedia: readonly GenerationMedia[] = input.history.flatMap((m) => (m.role === 'user' ? (m.media ?? []) : []));
const chain = orderEntriesForMedia(input.chain, runMedia);
```

and change the loop header to iterate `chain` (`chain.length`, `chain[position]!`). In `runEntry` (line ~590), replace `const messages: GenerationMessage[] = [...deps.history, { role: 'user', text: deps.userText }];` with `const messages: GenerationMessage[] = messagesForEntry([...deps.history, { role: 'user', text: deps.userText }], deps.entry.capabilities);` importing `GenerationMedia` type and the two functions. If `deps.entry.capabilities` does not exist in the merged code, use the merged Slice 6 path and note it in the commit message.
  - No new ledger events: a media fallback rides the normal attempt order (spec: "If none can, it uses the normal order"). The stripped marker is the model's explanation, so it never guesses.
- [ ] **Step 4: Run it and watch it pass** — same command as Step 2 · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write <all four owned paths>` then `npx eslint <all four owned paths>` · exit 0
- [ ] **Step 7: Commit** — `git add <all four owned paths> && git commit -m "Slice 4 T11: media capability routing with plain unreadable markers"`

**Done when:** an image run prefers the first image-capable entry; a PDF asked of models without PDF input sends no bytes and the model is told plainly; absent capabilities behave as text-only.

---

### S4-T12: trace keeps names, kinds and sizes — never bytes   ·   Wave 5
**Owns:** Modify: `packages/core/src/assistant/trace.ts`, `packages/core/src/assistant/trace.test.ts`, `apps/daemon/src/assistant/service.ts`, `apps/daemon/src/assistant/service.test.ts`, `apps/daemon/src/jobs/assistant.ts`, `apps/daemon/src/jobs/assistant.test.ts`
**Reads (do not edit):** `apps/daemon/src/assistant/commands.ts` (S4-T9 `AttachmentSummary`)
**Interfaces:** Consumes: `AttachmentSummary` / `AssistantInvocation.attachmentSummary` (S4-T9) · Produces: `assistantTraceIncludedSchema` gains `attachments: z.array(z.object({ name: z.string().max(120), kind: z.enum(['text', 'image', 'pdf']), sizeBytes: z.number().int().nonnegative() })).max(10).optional()` ("ADR 0149: what rode along; metadata only, never bytes")

- [ ] **Step 1: Write the failing test** — in `packages/core/src/assistant/trace.test.ts` (read its schema round-trip pattern first):

```ts
it('keeps an attachment summary and drops rows that predate it (ADR 0149)', () => {
  const withAttachments = assistantTraceSchema.safeParse({ ...minimalTrace(), included: { toolsOffered: [], snippetChunkIds: [], quote: false, historyTurns: 0, attachments: [{ name: 'chart.png', kind: 'image', sizeBytes: 8 }] } });
  expect(withAttachments.success).toBe(true);
  const legacy = assistantTraceSchema.safeParse({ ...minimalTrace(), included: { toolsOffered: [], snippetChunkIds: [], quote: false, historyTurns: 0 } });
  expect(legacy.success).toBe(true);
});
```

(If the file has no `minimalTrace` helper, inline the smallest object its existing tests parse.) In `service.test.ts`:

```ts
it('records the attachment summary in included and no bytes anywhere (ADR 0149)', async () => {
  const { requests, provider, trace } = captureWithTrace();
  await h.serviceWith(provider).invoke(
    ask({ userId: OWNER, callerRoleIds: [], invocationId: 'int-trace-1', input: { question: 'hi' }, attachmentSummary: [{ name: 'chart.png', kind: 'image', sizeBytes: 8 }] }),
  );
  expect(trace().included?.attachments).toEqual([{ name: 'chart.png', kind: 'image', sizeBytes: 8 }]);
  expect(JSON.stringify(trace())).not.toContain('aGk=');
});
```

(If `captureWithTrace` does not exist, capture the trace the way the existing trace-assertion tests in that file do.) In `jobs/assistant.test.ts`: extend the S4-T9 media test to assert the stored trace's `included.attachments` equals the summary.

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/assistant/trace.test.ts apps/daemon/src/assistant/service.test.ts apps/daemon/src/jobs/assistant.test.ts --maxWorkers=1` · Expected: FAIL (`attachments` stripped as unknown; `included` lacks it)
- [ ] **Step 3: Implement**
  - `trace.ts`: add the optional `attachments` field to `assistantTraceIncludedSchema` with the ADR 0149 comment. No migration: optional, old rows still parse.
  - `service.ts`: find every `included: {` literal (`rg -n "summaryVersion: input.summaryVersion" apps/daemon/src/assistant/service.ts`) and add `...(input.attachmentSummary === undefined ? {} : { attachments: input.attachmentSummary.slice(0, 10).map((a) => ({ name: a.name.slice(0, 120), kind: a.kind, sizeBytes: a.sizeBytes })) }),` after the `summaryVersion` spread.
  - `jobs/assistant.ts`: extend the cursor `included` copy (lines 214–229) with `...(detail.included.attachments === undefined ? {} : { attachments: detail.included.attachments }),` after the `summaryVersion` spread, so a retry keeps the summary.
- [ ] **Step 4: Run it and watch it pass** — same command as Step 2 · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write <all six owned paths>` then `npx eslint <all six owned paths>` · exit 0
- [ ] **Step 7: Commit** — `git add <all six owned paths> && git commit -m "Slice 4 T12: trace included gains the attachment summary, never bytes"`

**Done when:** the summary round-trips through the schema, the service writes it, the cursor keeps it, legacy rows still parse, and no base64 appears in any trace.

---

### S4-T13: state and privacy lines   ·   Wave 6
**Owns:** Modify: `docs/STATE.md`, `PRIVACY.md`
**Reads (do not edit):** `docs/decisions/0149-attachment-fetch-and-native-media.md` (S4-T1 wording to mirror)
**Interfaces:** Consumes: none · Produces: none (documents)

- [ ] **Step 1: Write the failing test** — no test; documents only. Confirm scope: `git status --short` shows only this plan file plus `docs/STATE.md` and `PRIVACY.md` modified.
- [ ] **Step 2: Run it and watch it fail** — `npx vitest run packages/core/src/assistant/trace.test.ts --maxWorkers=1` · Expected: PASS (nothing code-related changes in this task; the run proves the tree is still green)
- [ ] **Step 3: Implement**
  - `docs/STATE.md`: insert after the first `---` (same style as the Slice 1 entry at the top):

```markdown
**Attachments (Slice 4 of `docs/superpowers/specs/2026-10-09-assistant-harness-capability-design.md`) — built on `<branch>`, not yet merged (ADR 0149, no migration).**

- **Markers (4a):** the quote envelope, channel lines and current message render `[attached: name, type, size]` even with text; embeds render `[embed: Provider: title]`; the prompt says contents below the marker are the only readable form.
- **Text (4b):** the job re-reads both messages through REST at start and inlines at most 3 files, 256 KB / 24,000 chars each, redacted and framed.
- **Images and PDFs (4c, 4d):** fetched from the Discord CDN only, magic-checked, sent base64 to models that read them natively (Gemini inlineData; OpenRouter file input with the parser pinned to native). No PDF parsing or OCR anywhere. Capability routing prefers entries that can read everything; otherwise plain markers.
- **Caps** are instance settings (`assistant.attachments.*`); traces keep names, kinds and sizes, never bytes.
```

(Replace `<branch>` with the real branch name.)
  - `PRIVACY.md`: under "Assistant conversations and resources", add after the replied-to-message bullet: "- When a message tagged to Bananasaurs carries attached text files, images or PDFs, the bot downloads them from Discord and sends them to the AI provider that answers, and to no one else. Text is sent as redacted text; images and PDFs are sent only to models that read them directly. No file contents are stored: the bot keeps file name, type and size only." In the retention table, change the "Attachments on archived messages" row's meaning stays, and add a row: `| Attached file contents sent to the AI | Never stored; only the name, type and size travel with the conversation's trace |`. Update the "Last updated" date.
- [ ] **Step 4: Run it and watch it pass** — same command as Step 2 · Expected: PASS
- [ ] **Step 5: Typecheck** — `npx tsc --build` · Expected: exit 0
- [ ] **Step 6: Format and lint** — `npx prettier --write docs/STATE.md PRIVACY.md` then `npx eslint docs/STATE.md PRIVACY.md` · exit 0
- [ ] **Step 7: Commit** — `git add docs/STATE.md PRIVACY.md && git commit -m "Slice 4 T13: state and privacy lines for attachments"`

**Done when:** STATE names the branch, ADR and caps; PRIVACY says where attachments go and that contents are never stored.

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
