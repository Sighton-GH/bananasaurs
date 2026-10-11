# ADR 0138: a dashboard manager can mark a task done directly

Status: accepted 2026-10-10 (owner decision). Amends ADR 0103 for the dashboard path only.

## Context

ADR 0103 says only a task already awaiting approval can become done. On the dashboard that left an owner or an
account with Manage club tasks able to Approve a member's `/task complete` request, but unable to complete a
task themselves: from Not started or In progress the page offered only the other working status. The owner
reported "I cannot mark a task as completed in the dashboard".

The dashboard approve route already gates on `canManageTasks` alone; it does not run ADR 0103's live lead-role
check. So the people who can approve a request on the dashboard are exactly the people who would mark a task
done directly. A direct completion gives no one a power they do not already hold. It only removes the step
where a member has to ask first.

## Decision

- `POST /api/tasks/:taskId/complete` takes `{ version }` and needs the same `canManageTasks` gate as approve.
- `taskRepo.completeTask` moves a non-archived `not_started` or `in_progress` task to `done` and archives it in
  the same write, as `approveTask` does. It is a versioned, guild-scoped compare-and-swap with one
  `task.completed` audit row in the same transaction. A stale version, another guild, or any other status
  writes nothing and answers 409.
- An `awaiting_approval` task is refused: a member's pending request is answered with Approve or Send back,
  never bypassed.
- The task detail page shows **Mark done** next to the working-status buttons.

Unchanged: Discord members still complete through `/task complete` → awaiting approval (ADR 0100). The live
lead/president checks of ADR 0103 still apply to every non-dashboard approval path. Nothing is posted to
Discord, and reminder delivery already skips done tasks.
