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

The exclusion is keyed on the action **and the caller's token**, not on the
action alone. Suppressing my own trail reads must not suppress anyone
else's: an operator who cannot see that a second token has been reading the
audit trail is looking at a trail that lies by omission, which is a worse
failure than the one the exclusion exists to prevent.

Pairing the two costs nothing at the package boundary, because it is the
same division of labour the write side already uses. The tool layer names
the action it wants suppressed; the daemon's `recordsPortFor` supplies the
actor from the request's principal. `packages/mcp` still never learns who
is reading (ruling M4-D14 intact) — it says *what*, the daemon says *who*,
for reads exactly as for writes.

The SQL is written as `action NOT IN (...) OR actor_id IS NULL OR actor_id
<> <me>` rather than the more obvious `NOT (action IN (...) AND actor_id =
<me>)`. `actor_id` is nullable — SSH-originated rows carry none — and in
SQL `NULL = 'tok_x'` is NULL rather than false, so the naive negation
evaluates to NULL for those rows and drops them silently. The row that
belongs to nobody is the one a careless filter loses first.

## Consequences

- A content-bearing read with a resolved guild writes exactly one audit row;
  a structural read writes none. Refusals and argument faults write nothing:
  nothing was read, and an unreachable guild id has no `guilds` row to key
  an audit row against.
- `McpReadAuditPort` is a per-request daemon port like the other MCP ports:
  `packages/mcp` still holds no repository handle (ruling M4-D14 intact),
  the tool layer says *what* was read, and the daemon's port closes over
  *who* read it (token id, account id, client id).
- `effectRepo.tailAudit` gains an optional `excludeOwnActions` filter —
  actions *and* the actor they belong to, inseparable in the type so an
  action can never be excluded without naming whose it is. Implemented in
  SQL so a page of results cannot be silently emptied by rows the caller
  asked not to see, and NULL-safe so a row with no actor is never lost.
- `recordsPortFor` now takes the request's principal, for that one reason.
- A failed audit write rethrows so the read fails closed, but it logs one
  allowlisted `error` line first. The connector sees the shared
  unreachable-guild refusal, which is indistinguishable from a revoked
  token, so without that line a database that could not accept audit rows
  would refuse every content read and look exactly like an authorisation
  problem. Fail closed is the behaviour; fail silently is not.
- The fail-closed path is tested by fault injection rather than by reading
  the code: a throwing port at the `packages/mcp` boundary, and a dropped
  `audit_events` table through the daemon's real composition. Both assert
  that the member content the read had already fetched does not reach the
  connector — the guard is watched failing, not assumed.
