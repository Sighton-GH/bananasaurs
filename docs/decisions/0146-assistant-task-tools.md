# 0146. Assistant task tools for team leads and the president

Date: 2026-10-11

Status: accepted (owner decision D4a, 2026-10-10).

## Context
"Can you create tasks?" was refused: no task tool existed. UHill has no teams, so team-scoped creation is the whole surface for now.

## Decision
1. New acting skill `tasks` (default owner; the owner grants lead roles per guild). Tools: `create_task` (first round, writes), `list_tasks` (any round, read-only, task ids as handles), `task_progress` (returned-id round, writes).
2. Authority is `TaskContextPort.access(actorId)` — team lead of the task's team, or the president — never `canManageTasks`, which keys on a dashboard account. Skill scope and team authority must both pass.
3. `create_task` takes title, details, team, assignees by display name (exact match only) and an ISO due date, posting in the current channel. Its id is deterministic from the invocation key plus a content hash (the `contentKey` pattern in `apps/daemon/src/assistant/tools.ts:427-428`), the same duplicate rule MCP's `requestId` gives `create_club_task`. `task_progress` reuses `recordReport` with a deterministic report id.
4. The reply's confirmation line is built by code, as for reminders.

## Consequences
- No new scheduler, no new table. A non-lead gets an actionable refusal; nothing is written.
