# ADR 0111: The MCP connector's OAuth scopes split by blast radius

Status: accepted (2026-09-29)

Amends: ADR 0045 (the OAuth vocabulary), ADR 0044 §4.
Spec: `docs/superpowers/specs/2026-09-29-mcp-connector-v2-design.md` §3.3, §8.4.

## Decision

The vocabulary grows from `bananasaurs:read` and `bananasaurs:send` to four:

| Scope | Grants |
|---|---|
| `bananasaurs:read` | every read tool and resource |
| `bananasaurs:send` | messages, threads, pins, reactions, events, polls, scheduled sends |
| `bananasaurs:roles` | role grants and removals, role creation, role panels |
| `bananasaurs:tasks` | the task-tracking write tools |

Tools are filtered at registration (ruling M4-D17). A token without a scope
cannot see that scope's tools in `tools/list`.

Both scopes are added in slice 1, before any tool uses them, so the owner
re-authorises the connector once. The task-tracking branch
(`feature/task-tracking`, ADR 0101 there) currently registers its writes under
`send` and names a dedicated tasks scope as follow-up. When it merges, it
switches to `hasTasksScope`.

## Consequences

- Existing tokens keep their scopes until the owner re-authorises. No scope is
  granted silently.
- Role tools (slice 4) can never be reached by a token that was only meant to
  post messages.
