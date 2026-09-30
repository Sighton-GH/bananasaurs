# ADR 0096: task identity revocation is immediate and guild-scoped

Status: accepted for the task-tracking staging branch.

An owner can remove a dashboard-to-Discord binding and remove a stored team membership independently. Neither operation accepts a client-selected guild, and both are safe to repeat. A removed binding denies all member task reads immediately; removing a membership denies that team's reads immediately. Revoking a binding does not remove team memberships keyed to the Discord user: that is a separate club access decision. Rebinding a different dashboard account is not a substitute for proving that account holder controls the Discord identity. The existing owner-entered binding endpoint is therefore not a completed identity verification workflow and must remain planning-only until a challenge or comparable proof is implemented.

The read gate also checks the team's current category in the guild directory. If Discord's directory is missing or the category has moved or been removed, member task reads fail closed. Owner diagnostics still report the defect. No reminder or Discord posting is enabled by these changes.
