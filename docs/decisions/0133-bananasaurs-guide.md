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

## Task 4: the MCP tool

`bananasaurs_guide` is a read tool (read scope only). Its inputs are `topic` (an id or title,
at most 100 characters) and `guildId` (at most 64).

- No topic answers the index. A topic answers its title, its body and its See also labels with
  dashboard paths. An unknown topic is a refusal that lists the valid ids.
- A `guildId` the caller reaches adds "This server right now" after the text: automod, dry run,
  kill switch and task posts (worded as `get_health` words them, install dry run winning), the
  account's name and whether it is the instance owner, its permissions in that guild, and this
  connection's approvals. Labels come from `CAPABILITY_INFO` and `MCP_SCOPE_INFO`.
- A part of the live state that cannot be read (no health port, a guild the port does not list
  or has no settings row for, no access port, an account the port does not answer for, or a port
  that throws) reads as "unavailable right now". The call still answers.
- The guild gate is the reachable-guild check every read tool uses. An unreachable guild is
  refused before either port is read.
- The answer is static text and labels, so it has no evidence envelope. The account name is
  escaped as the guild name is in `get_health` (ruling M4-D19).
- The read is structural and writes one record per call. A call with a guild names it, so one
  log line is written. The index and topics name no guild, so they write none (hard rule 2).
- `accessPortFor` (`apps/daemon/src/mcp/access-port.ts`) answers one account's name, owner flag
  and permissions in the one guild asked for. A missing or disabled account gets no answer.
