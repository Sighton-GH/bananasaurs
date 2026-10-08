# ADR 0133: One guide module in core, read by the dashboard and by connected apps

Status: accepted (2026-10-06)

## Context

The dashboard Guide page kept its text as JSX in `packages/dashboard/src/pages/docs.tsx`.
Parts of it went stale in the same week: it said the dashboard is owner-only always
(ADR 0130 gives the task pages to accounts with Manage club tasks), and an amber banner
said task posts need the operator (ADR 0131 makes them a per-server switch). Connected apps
had no way to read the same guide, and Claude answers questions about Bananasaurs from what
it can read.

## Decision

1. The guide is data in `packages/core/src/guide/topics.ts`: `GUIDE_TOPICS`, a list of topics
   with an id, a nav group, a title, a one-line summary (140 characters at most), a body of
   light Markdown (1500 characters at most) and optional links to dashboard pages. Core
   exports the data. No renderer lives in core.
2. There are two readers and no others: the dashboard Guide page (`pages/docs.tsx`, with
   `lib/guide-markdown.tsx`) and the MCP tool that Task 4 adds. The Markdown is deliberately
   small: paragraphs, `- ` bullets, `code`, **bold** and internal links. An absolute web link
   is shown as its plain label.
3. The content describes current behaviour. A change that alters behaviour updates the guide
   in the same change. Every fact is traced to the ADR, document or code that defines it; a
   fact that cannot be traced is left out.
4. Drift tests fail when the guide stops naming something a reader needs. `topics.test.ts`
   checks that every capability label and every MCP scope label appears in some topic.
   `packages/mcp/src/guide-drift.test.ts` checks that every registered MCP tool name appears
   in the guide text.

## Consequences

- A new permission, approval, or MCP tool needs a guide line before its drift test passes.
- The guide is plain TypeScript strings, reviewed like code. No Markdown library is added.
- The dashboard page and the connected-app reader cannot disagree, because both read the same
  array.
