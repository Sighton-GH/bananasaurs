# ADR 0134: one audit action name per operation

Status: accepted 2026-10-08.

## Context

The operator CLI and the dashboard perform many of the same operations through the same port calls, but each
surface named its audit rows on its own. An inventory on 2026-10-08 found 57 operations both surfaces perform;
34 were audited under different names (for example `archive.message_preserved` from the CLI and
`archive_message.preserved` from the dashboard). Searching the audit trail for one name therefore missed half the
history of that operation. No code reads or filters audit rows by these names (`audit tail`, `GET /api/audit`, the
Audit page and the Overview list only display them), so changing them breaks no reader.

## Decision

1. An operation both surfaces perform writes exactly one audit action name, whichever surface performs it.
2. The CLI's existing names are canonical. They are the older set and already group by family (`archive.*`,
   `automod.*`, `mcp.*`, `account.<thing>.<verb>`).
3. The names live once, in `packages/core/src/ops/audit-actions.ts`. CLI commands and dashboard routes import them;
   neither writes the string literal. Tests on both sides assert against the same constant.
4. A dashboard-only action whose family was renamed follows the family so a prefix search finds it:
   `archive_backfill.enqueued` → `archive.backfill_enqueued`, `account.capability_revoked` →
   `account.capability.revoked`, `account.password_revealed` → `account.password.revealed`.
5. Audit rows already written are not rewritten. An audit row records what was written at the time; the table
   below lets an operator search older rows under their old names.
6. Out of scope: the dashboard's panel publish (`panel.published`) and reconcile (`panel.reconcile_enqueued`) are two
   steps of what CLI `panel sync` (`panel.synced`) does in one, so they stay separate operations with separate
   names. `backup.failed` stays (the CLI writes no failure row). Dashboard-only families with no CLI counterpart
   (`automod_rule.*`, `assistant_*`, `task.*`, `tasks.posts.*`, `automod.state_set`) are unchanged. Audit payloads
   (`before`/`after`) are not unified by this ADR.

## Renamed dashboard actions (old → new)

| Old dashboard name | New name |
|---|---|
| `setting.applied` | `config.set` |
| `archive_channel.enabled` | `archive.channel_enabled` |
| `archive_channel.disabled` | `archive.channel_disabled` |
| `archive_channel.paused` | `archive.channel_paused` |
| `archive_channel.resumed` | `archive.channel_resumed` |
| `archive_category.enabled` | `archive.category_enabled` |
| `archive_category.disabled` | `archive.category_disabled` |
| `archive_category.paused` | `archive.category_paused` |
| `archive_category.resumed` | `archive.category_resumed` |
| `archive_channel.threads_set` | `archive.threads_set` |
| `archive_message.preserved` | `archive.message_preserved` |
| `archive_message.case_linked` | `archive.message_linked_to_case` |
| `archive_reindex.ran` | `archive.index_rebuilt` |
| `archive_backfill.enqueued` | `archive.backfill_enqueued` |
| `undo.enqueued` | `batch.undo_requested` |
| `adoption_allowance.granted` | `adoption.allowance_granted` |
| `send_channel.allowed` | `mcp.send_channel.allowed` |
| `send_channel.disallowed` | `mcp.send_channel.disallowed` |
| `send_category.allowed` | `mcp.send_category.allowed` |
| `send_category.disallowed` | `mcp.send_category.disallowed` |
| `role_policy.updated` | `mcp.role_policy.updated` |
| `role_allowlist.allowed` | `mcp.role_allowlist.allowed` |
| `role_allowlist.disallowed` | `mcp.role_allowlist.disallowed` |
| `automod_match.verdict_recorded` | `automod.verdict_recorded` |
| `invite_allowlist.added` | `automod.invite_allowlist_added` |
| `invite_allowlist.removed` | `automod.invite_allowlist_removed` |
| `link_domain.added` | `automod.link_domain_added` |
| `link_domain.removed` | `automod.link_domain_removed` |
| `backup.ran` | `backup.created` |
| `account.credentials_revoked` | `account.credentials.revoked` |
| `account.password_reset` | `account.password.changed` |
| `account.guild_granted` | `account.guild.granted` |
| `account.guild_revoked` | `account.guild.revoked` |
| `account.capability_revoked` | `account.capability.revoked` |
| `account.password_revealed` | `account.password.revealed` |

## Consequences

A new operation added to both surfaces gets one constant and both sides import it. An audit search for any name in
the right-hand column finds every row written from this release on, from either surface; for rows written before
it, also search the old name.
