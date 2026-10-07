# 0112 — Task update evaluation and task retention

Status: accepted (owner decisions O10, O11, 2026-09-30)

## Context
The final review found that member progress replies are stored with no retention rule or disclosure, and that a pinged Discord reply to a task post also triggered a general assistant answer.

## Decision
1. Recording a progress reply stays deterministic (`isProgressUpdate`); the AI never decides whether an update is recorded.
2. Each recorded update is then sent to the first usable entry of the assistant model chain with a fixed evaluation instruction. The model returns JSON `{ "clear": boolean, "question"?: string }`, validated by Zod. If `clear` is false the bot replies once with the question; otherwise it posts nothing. Acknowledgements are never evaluated. The assistant "who can ask" setting does not apply. A reply to the clarifying question is recorded but not evaluated again.
3. The evaluation post is a `task_nudge_slots` row (`evaluate:<replyMessageId>`), so it is idempotent, gated by the per-server task posts switch (ADR 0131), and skipped (no model call) when sends are off. A failed or unreachable model posts nothing; the update stays recorded.
4. A pinged reply to a task post is not routed to the general assistant unless the message text itself tags the bot.
5. Nothing about tasks is deleted automatically. Approving a task archives it in the same write. The owner deletes a task, or a single progress update, by hand (dashboard or owner MCP). PRIVACY.md discloses this.

## Consequences
One provider call per recorded update when sends are on. Progress text is kept indefinitely unless the owner deletes it.
