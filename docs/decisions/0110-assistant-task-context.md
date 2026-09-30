# ADR 0110: the assistant gets bounded task context and clarifies ambiguous updates

Status: superseded in part by 0111 (no clarification invocation, no destination fallback)

When a member's message might be a task update, the general-purpose
assistant receives one bounded context section, compiled from a snapshot
built by deterministic code: the actor's verified access, the candidate
open tasks (team, title, destination, status, due date) and the actions
that member may take. Hard rule 1 holds: the model never executes a task
mutation. The section tells it to point members at the deterministic paths
(`/task complete`, lead/president approval) rather than guessing which
task or what change.

Candidate selection is deterministic. Reply-attribution is anchor-first: a
reply to a bot-posted task anchor message resolves to that task through the
anchor lookup the core approval/anchor work persists. The context block is
assembled per invocation, capped in size, excluded from the protected
prompt core, and contains no task descriptions beyond title and metadata —
progress report bodies are never injected. A member with no verified task
access gets no section at all.

The integrated branch connects the guild-scoped anchor lookup with exactly
one enabled bot-facing behaviour. No automatic task write follows the
model's answer. A validated anchor-posting path has not yet been activated.
