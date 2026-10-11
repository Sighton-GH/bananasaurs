# Slice 4: attachments — implementation plan

> **Instinct plan.** Read with `2026-10-10-harness-00-instinct-handoff.md` and `2026-10-10-harness-00-shared-contracts.md`.
> **Status:** DRAFT — refreshed by the controller before round 3

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
| 4 | S4-T9 media plumbing job to loop | Modify: `apps/daemon/src/assistant/commands.ts`, `apps/daemon/src/assistant/service.ts`, `apps/daemon/src/assistant/service.test.ts`, `apps/daemon/src/jobs/assistant.ts`, `apps/daemon/src/jobs/assistant.test.ts` | T2, T5, T6 |
| 4 | S4-T10 capability routing and markers | Create: `apps/daemon/src/assistant/media-routing.ts`, `apps/daemon/src/assistant/media-routing.test.ts`; Modify: `apps/daemon/src/assistant/tool-loop.ts`, `apps/daemon/src/assistant/tool-loop.test.ts` | T2, T9 |
| 4 | S4-T11 tuning page shows the caps | Modify: `packages/dashboard/src/pages/assistant-tuning.test.tsx` | T3 |
| 5 | S4-T12 trace attachment summary | Modify: `packages/core/src/assistant/trace.ts`, `packages/core/src/assistant/trace.test.ts`, `apps/daemon/src/assistant/service.ts`, `apps/daemon/src/assistant/service.test.ts` | T9 |
| 5 | S4-T13 state and privacy | Modify: `docs/STATE.md`, `PRIVACY.md` | T1–T12 |

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
**Interfaces:** Consumes: none · Produces: ten keys `assistant.attachments.textMaxBytes`, `assistant.attachments.textMaxChars`, `assistant.attachments.textMaxCount`, `assistant.attachments.imageMaxBytes`, `assistant.attachments.imageMaxCount`, `assistant.attachments.pdfMaxBytes`, `assistant.attachments.pdfMaxCount` (all `count`, a count of 0 disables that kind) plus `assistant.attachments.textEnabled`? No — counts only; seven keys total: textMaxBytes (default 262144), textMaxChars (default 24000), textMaxCount (default 3, min 0, max 10), imageMaxBytes (default 5242880), imageMaxCount (default 4, min 0, max 10), pdfMaxBytes (default 10485760), pdfMaxCount (default 2, min 0, max 10); group `Assistant attachments` (new additive `SettingGroup` value)

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
