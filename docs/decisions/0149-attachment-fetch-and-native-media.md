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
   number, an oversize file, a host outside the allowlist, or a redirect to another host causes that file to be
   skipped; the question can still reach a provider with a plain refusal note and any other readable files. Each
   refusal has a test, refusal-first.
2. PDFs and images go to the AI provider only when the answering model reads them natively: Gemini as `inlineData`
   parts, OpenRouter models whose catalogue listing has `file` input with the file-parser plugin pinned to
   `plugins: [{ id: "file-parser", pdf: { engine: "native" } }]`, so the bot requests the native engine and does not
   request an OCR fallback (`mistral-ocr` is paid, `cloudflare-ai` is a third party). There is no local PDF parsing, extraction, OCR, or parsing service
   anywhere (D7b). A model without the input gets a plain marker instead of the file, and the bot says so.
   OpenRouter's PDF file field uses the fixed filename `document.pdf`; Gemini inline media has no filename.
   Original filenames are not used as vendor file-field names, but safe names can remain in text markers and
   metadata.
3. Attached text is untrusted evidence: redacted, neutralised, capped and framed as `[UNTRUSTED ATTACHMENT …]`.
   Fetched bytes and inlined text are transient and are not deliberately stored in trace, job-working or
   conversation copies. Traces and job-working copies retain a metadata summary of job-fetched files (safe name,
   kind and size), capped at 10 entries, not a per-model receipt; a names-only display marker can also remain.
   Model answers, saved thinking, tool arguments and provider error messages can echo file content and follow
   their existing retention rules.
4. The outbound safety scan reads message text only (`requestSections` in `outbound-safety.ts`), so base64
   image/PDF bytes in `GenerationMessage.media` never reach it. That is an accepted gap: attached text passes
   `redactEvidenceText`, pixels cannot be scanned locally, and scanning them would need a service D7b forbids.

## Consequences

- `cdn.discordapp.com` and `media.discordapp.net` join the allowed outbound destinations for attachment fetches
  only; every other fetch keeps its own allowlist.
- Eligible text and inline media can reach each provider entry attempted for an answer, subject to that entry's
  media capabilities and the existing provider terms and training disclosures.
- Quote asymmetry (owner adopted 2026-10-12, his WhatsApp "go with your recommednations for those questions"):
  files and CDN embed thumbnails on a live-fetched replied-to message follow the handed-message exemption and can
  be fetched even when channel Read is off. Files on the tagging message still require a successful Read check.
  Replying to a stored conversation turn need not cause a live quote re-read.
- Caps are instance settings (`assistant.attachments.*`); a count of 0 disables that kind.
