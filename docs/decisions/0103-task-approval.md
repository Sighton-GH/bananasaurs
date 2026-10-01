# ADR 0103: task approval is a live-role-checked transition

Status: accepted for the planning branch.

Only a task already awaiting approval can become done. A subteam task requires the approving Discord member to have the team's configured lead role and an explicit stored lead membership in that team. An exec task requires the configured president role. The actor is fetched from Discord by ID on each request, the configured role must still exist in the guild, and the team's category must still be a live category. A lead who loses the role or membership cannot approve. No name, cached dashboard binding or instance-owner status substitutes for the role. Missing/ambiguous role configuration fails closed. A president may approve a subteam task only if they are also that team's lead. This avoids an unstated bypass of team lead review.

The deterministic approval service performs live checks, then a guild-scoped versioned transition in one transaction with its audit row. A repeat attempt does not write another audit row. Status is not changed by an AI model's text directly. There is no new slash command or Discord post. The service is a building block for separately authorised dashboard and assistant/MCP paths, not a live rollout by itself.
