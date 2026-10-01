# ADR 0109: MCP task setup and operating tools are owner-scoped writes under the send scope

Status: proposed for staging, not accepted for deployment.

The assigned implementation targets task setup and operation from Claude over MCP.
Only actions backed by deterministic validation register as tools. ADR 0101 forbids
registering task writes under the read scope, so the write and config tools
register under `bananasaurs:send` — the only existing write-class scope. A
dedicated `bananasaurs:tasks` scope would be cleaner but lives in
`packages/http`'s OAuth vocabulary, outside this slice; that is recorded as
follow-up work. `list_tasks` and `get_task` stay read-scoped.

Every write tool repeats the `list_tasks` authority pattern, per call, in
the daemon's port: the bearer account is re-fetched and must be the enabled
instance owner, and the guild must be reachable. Owner is never inferred
from model text or from a stored display name. Mutations go through the
audited storage functions with the same core validation and compare-and-swap model as the dashboard routes, with
expected-version compare-and-swap on edits and completion requests, and a
guild-scoped audit row (`actor_type='mcp_operator'`, `via='http'`) in the
same transaction. Failed validations write no success row, matching ADR
0100. Team creation and edits validate the category, announcement channel
and lead role against live Discord, and task create/edit validates the
destination inside the team category and any individual assignee's live
membership, mirroring `packages/http/src/routes/task-write.ts`. No tool
posts to Discord; reminder configuration is stored configuration only.

Approval is not re-implemented here. `approveTaskForMember(scope, client,
discord, actorId, taskId, expectedVersion, now)` needs a Discord member identity
obtained from the authenticated Discord interaction, not from model text or an
owner dashboard binding. The dashboard is owner-only. No MCP approval tool is
registered in this staging build; Discord approval caller wiring is an
integration seam.

The reminder worker owns durable custom reminder slots and fixed weekly
digests to validated team announcement channels. The default pre-due reminder
is 48 hours. The MCP custom reminder tool calls the worker repository
`appendCustom`; the digest destination is configured through team configuration, not through a fictitious per-team cadence. Migration 0070
stores a proposed guild quiet-hours override (midnight-8am Pacific default),
and the integrated worker reads the override before claiming delivery. The send flag remains off.
