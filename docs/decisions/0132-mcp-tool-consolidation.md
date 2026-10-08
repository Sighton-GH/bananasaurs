# ADR 0132: Consolidate the MCP task tools into 10 action-based tools

Status: accepted (2026-10-06)

## Context

The MCP surface has grown to 84 tools, of which 29 are task tools: 25
task-tracking writes (`create_club_task`, `edit_club_task`,
`append_task_child`, …) registered under the `bananasaurs:tasks` scope,
plus 4 reads (`list_tasks`, `get_task_details`, `list_task_reminders`,
`list_task_teams`) under `bananasaurs:read`. Every write is a thin
shape over the same daemon dispatch (`TaskAdminPort.execute`, keyed by
the old tool name), and several reads differ only in which projection of
one task they return. The count taxes `tools/list` consumers without
adding capability: the model pages through near-duplicate names to find
the one verb it needs.

## Decision

Merge the 29 task tools into 10 action-based tools with identical
behaviour. Each merged write tool takes an `action` enum plus the union
of its actions' parameters; routing strips `action` and calls the
existing `runTaskAdmin` with the old internal name, whose strict
per-action parse stays the real argument boundary. Old tool names are
removed, with no aliases.

| tool | scope | action → old internal name |
|---|---|---|
| `list_tasks` | read | unchanged |
| `get_task` | read | no action; returns the `get_task_details` text plus `"\n\n"` plus the `list_task_reminders` text for the same task |
| `create_task` | tasks | no action; was `create_club_task` |
| `update_task` | tasks | `edit`→`edit_club_task`, `set_status`→`set_task_status`, `request_completion`→`request_task_completion`, `approve_completion`→`approve_task_completion`, `reject_completion`→`reject_task_completion`, `archive`→`archive_task`, `unarchive`→`unarchive_task` |
| `delete_task` | tasks | no action; was `delete_club_task` |
| `task_steps` | tasks | `add`→`append_task_child`, `edit`→`edit_task_child`, `complete`→`complete_task_child`, `delete`→`delete_task_child` |
| `task_reminders` | tasks | `add`→`add_task_reminder`, `cancel`→`cancel_task_reminder` |
| `task_progress` | tasks | `record`→`record_task_progress`, `delete_report`→`delete_task_report` |
| `task_teams` | read (`list`) / tasks (others) | `list`→`list_task_teams` (read path, audited as today), `create`→`create_task_team`, `configure`→`configure_task_team`, `delete`→`delete_task_team`, `add_member`→`add_task_team_member`, `remove_member`→`remove_task_team_member` |
| `task_settings` | tasks | `set_president_role`→`set_task_president_role`, `clear_president_role`→`clear_task_president_role`, `set_quiet_hours`→`configure_task_quiet_hours` |

Task 2 continues the same pattern for the remaining pairs: `react`
(`add_reaction` + `remove_reaction`), `set_pin` (`pin_message` +
`unpin_message`), `thread_members` (`add_thread_members` +
`remove_thread_members`), `set_thread_state` (`archive_thread` +
`lock_thread`), and `update_scheduled` (`edit_scheduled` +
`cancel_scheduled`).

## Task 2 table (2026-10-07)

| tool | scope | selector → old handler |
|---|---|---|
| `react` | send | `action: 'add'`→`addReactionText`, `'remove'`→`removeReactionText` (selector stripped) |
| `set_pin` | send | `pinned: true`→`pinMessageText`, `false`→`unpinMessageText` (`pinned` stripped) |
| `thread_members` | send | `action: 'add'`→`addThreadMembersText`, `'remove'`→`removeThreadMembersText` (selector stripped) |
| `set_thread_state` | send | `archived: boolean`→`archiveThreadText({…, archived})`, `locked: boolean`→`lockThreadText({…, locked})` (no selector to strip — the flag is the handler's own field) |
| `update_scheduled` | send | `action: 'edit'`→`editScheduledText`, `'cancel'`→`cancelScheduledText` (selector stripped) |

Unknown selector, or a parameter belonging to the other side (an edit-only
field on an `update_scheduled` cancel), is `INVALID_ARGUMENTS_MESSAGE`
with the handler never called; each tool's wire shape is a ZodRawShape of
the selector plus every field `.optional()` with which side uses it, and
the existing handlers' strict parse stays the boundary.

Ruling (binding): `set_thread_state` refuses `archived` + `locked`
together — two state changes under one idempotency key would replay the
second as the first — and refuses neither, so exactly one flag per call.

## Consequences

- MCP layer only — daemon ports, the owner-or-`tasks.manage` gates
  (ADR 0130), ledger kinds, and undo are unchanged. The daemon still
  dispatches on the old internal names; only the advertised surface is
  new.
- Same port calls, same guild gate (`requireReachableGuild`), same scope
  gates, same refusal messages. Every write keeps its
  idempotency/requestId semantics exactly.
- Tool descriptions name actions, not access levels: access is "owner or
  Manage club tasks" (ADR 0130), never "Owner-only".
- Existing behavioural coverage moves to the new names; nothing is
  deleted.
