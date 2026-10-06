# ADR 0130: A "Manage club tasks" permission, and MCP connections you can read and clean up

Status: accepted (2026-10-06)

Amends: ADR 0114 (the `bananasaurs:tasks` scope's tools were owner-only),
the task-tracking owner-only dashboard rule, ADR 0045 (token listing).
Number 0129 is held by the AI-observability draft.

## Context

The owner connected the Racerbot Club's Claude organisation to Bananasaurs
as the dashboard account `racerbot-club-claude`, a non-owner account, and saw
no task tools. Task tools were wired to the single instance owner
(`isOwner`), so no permission or scope could ever give them to another
account. The account-edit page had no task permission to show, and the
"Connect apps" permission said it let an app "read this server" when a
connected app can also post and change roles.

Token housekeeping had also failed: every hourly refresh writes an access
and a refresh row, so the flat token list ran to hundreds of raw ids with no
account name, app name or scopes, revoked rows lingered ~44 days, and
`bananasaurs mcp tokens` overflowed the 64 KiB socket line and failed.

## Decision

1. **New capability `tasks.manage`, per guild** — label "Manage club tasks".
   The owner decision (2026-10-06): any enabled account holding it in a
   guild may manage that guild's tasks; the instance owner always may. It is
   in the Server manager preset.
2. **MCP task tools follow it.** The task tools (reads and writes, team
   setup included) register when the token's account is the enabled owner
   or holds `tasks.manage` in at least one guild the token reaches; the write
   tools still also need the `bananasaurs:tasks` scope. Every call re-checks
   owner-or-`tasks.manage` **in the call's guild**, live, so a revoked
   permission binds on the next call and a grant in guild A never reaches
   guild B.
3. **Dashboard task pages follow it too**, in the session's guild, so the
   label means the same thing on both surfaces.
4. **"Connect apps" says what it does:** an approved app can read this
   server and, with the matching approvals, post messages, change roles and
   manage tasks — limited by this account's other permissions.
5. **Connections, not token rows.** Tokens are grouped by the sign-in that
   minted them (`issued_from_code_hash`): one row per connection showing
   the account username, app name, plain-language scopes, connected /
   expired / revoked, created and last used. Raw token rows sit behind it.
6. **Cleanup.** Gated like the existing revoke ("Change settings",
   `config.write`), audited, CLI and dashboard alike:
   - disconnect one connection (revoke every token it holds);
   - delete one connection or token (a live one is revoked first, then its
     rows are deleted);
   - "Clean up": delete every expired or revoked token row now, plus
     registered apps left with no tokens.
   Deleting only removes rows that can no longer authenticate, or that the
   same action just revoked; it never extends access.
7. **`mcp tokens` cannot overflow:** the CLI lists connections (bounded by
   sign-ins, not refreshes), and the raw-token listing is capped and paged.

## Consequences

- An account given "Manage club tasks" in a server, connected with the
  task approval, sees and uses the task tools there; without the approval it
  sees the task reads only.
- An existing connection keeps the approvals it signed in with, so a
  connection made before it held the permission must reconnect to gain the
  task approval.
