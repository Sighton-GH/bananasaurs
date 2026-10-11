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
