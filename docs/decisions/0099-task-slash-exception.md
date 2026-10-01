# ADR 0099: two task slash commands alongside chat-driven task work

Status: accepted for the task-tracking staging branch. This is a narrow exception to ADR 0086's "only `/mod`" rule, based on the owners' September 28, 2026 WhatsApp decision: "Discord commands only to list tasks or mark as complete. Ai handles the rest". Do not bring back the old assistant slash commands.

Register `/task list` and `/task complete` only. The list reads task rows for the invoking Discord member in the current guild, using live member and role checks. Completing a task does not equate to approval: a member's completion request goes to `awaiting_approval` and an authorised lead (or president for an exec team) still has to approve. All other task setup, edits, progress capture, reminders and approval decisions are handled through the general-purpose AI/MCP and dashboard as separately implemented and authorised. No live task posting or reminder delivery is activated by registration.
