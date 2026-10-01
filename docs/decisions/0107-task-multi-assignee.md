# ADR 0107: individual tasks may name several members

Status: accepted for the planning branch.

The existing `assignment_kind` distinguishes a whole-team task from an individually assigned task. Keep that distinction. A new guild-scoped join table records all individuals on an individually assigned task; the current `assignee_id` column remains the primary assignee for backward compatibility with existing task queries until the adapters can read the join table. New tasks and edits must write the primary plus all assigned members in one transaction. Every named assignee requires explicit stored team membership and a fresh live Discord member check. At least one assignee is needed for an individual task; whole-team tasks carry none. Deduplicate input IDs and cap the list at 25 to prevent an unbounded live lookup. CAS edits replace the join rows only when the task update wins. A task completion request may come from any current assignee, never from a person added to an unrelated team. A member's removal from the team revokes action access even while a historical assignment row remains.

The migration is numbered 0061 and follows the task anchor migration 0060. It must be ordered behind the reminder worker's 0053-0059 on integration. This changes no posting or reminders in planning mode.
