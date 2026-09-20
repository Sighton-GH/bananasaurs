# 0050. MCP read logging takes the middle path: audit content-bearing reads, log structural ones

Date: 2026-09-20
Status: accepted

## Context

The MCP operator connector's read tools left no server-side trace: no
`audit_events` row and no log line (`docs/reports/mcp-m6-live-run.md` §5).
During the M6 live run the operator could verify that thirteen authorized
calls had happened, but not which tools ran or what they read. A connector
that can return archived member messages, moderation cases and the audit
trail itself must leave a record of what was read.

Two extremes were rejected. Auditing nothing is the gap being fixed.
Auditing every read buries the signal: reads are frequent (thirteen calls in
one short session), and an audit row per `get_health` makes the trail
unreadable, which is the same as having no trail.

## Decision

Split by whether the tool touches members' words.

**Rows in `audit_events`** — the tool returns member content or moderation
history, so the read is recorded durably:

- `search_messages`, `read_channel_history`, `get_message`
- `list_mod_cases`, `get_mod_case`
- `list_audit_events`

**One `logger.info` line, no audit row** — the tool returns structure, not
content:

- `get_health`, `list_channels`, `list_roles`, `list_members`

`get_server_overview` and the `server_overview` resource are not in the
owner's two lists, which name ten tools. They return the same structural
card (channels, roles, counts, rule modes), never member content, so they
fall on the structural side by the split's own criterion and are logged at
info. Leaving them silent would recreate the exact gap this change closes,
through the eleventh door.

Every record carries the guild id (hard rule 2 — explicit, never implied),
the tool name, the OAuth token id, the account id, and the *shape* of what
was asked: a channel id, a case id, a message id, a result count. **Never
the query string, never returned content, never a message body.** A log of
what someone searched for is itself a record of member content.

Audit rows use `actor_type = 'mcp_operator'`, `actor_id = <token id>`,
`via = 'http'` — the same vocabulary `mcp.message.sent` already uses (ruling
M5-D10) — with the account id, client id, token id and result count in
`after`. Log lines pass through the `safeLogFields` allowlist (rule 4):
`component`, `action`, `guildId`, `accountId`, `oauthClientId`,
`oauthTokenId`, `count`. `get_health` takes no guild, so it logs one line
per reachable guild; a token with no reachable guild is refused before any
line is written.

The audit row is written **after** the read and before the answer is
returned. If the audit write fails, the tool's existing `try/catch` turns
the call into the shared refusal and the content is never returned — a read
that cannot be recorded does not happen.

## The self-referential read

Auditing `list_audit_events` means reading the audit trail writes a row to
the audit trail. Two options were on the table:

1. Exclude `list_audit_events` from its own results.
2. Audit it, and have the tool filter its own action out of what it returns.

**Chosen: option 2.** The fact that someone read the audit trail is itself
security-relevant and must stay in the durable record — option 1 would make
trail-reading invisible to the trail. But an operator watching the trail
through the tool must not see it grow because they looked at it: each read
would otherwise return the rows the previous read generated, and repeated
reads would drown the human-meaningful signal the middle path exists to
protect. So the read writes its row, and the tool's query excludes its own
action (`mcp.read.list_audit_events`) from what it returns. The row is still
visible to `audit tail` over SSH, where it belongs.

## Consequences

- A content-bearing read with a resolved guild writes exactly one audit row;
  a structural read writes none. Refusals and argument faults write nothing:
  nothing was read, and an unreachable guild id has no `guilds` row to key
  an audit row against.
- `McpReadAuditPort` is a per-request daemon port like the other MCP ports:
  `packages/mcp` still holds no repository handle (ruling M4-D14 intact),
  the tool layer says *what* was read, and the daemon's port closes over
  *who* read it (token id, account id, client id).
- `effectRepo.tailAudit` gains an optional `excludeActions` filter,
  implemented in SQL so a page of results cannot be silently emptied by
  rows the caller asked not to see.
