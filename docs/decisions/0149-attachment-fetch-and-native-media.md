# 0149. Attachment fetch destination; images and PDFs to providers, native only

Date: 2026-10-12

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
