# ADR 0101: task MCP tools start read-only and owner-scoped

Status: accepted for the planning branch. Partly superseded by ADR 0111.

Task tools are a separate MCP surface over the existing authenticated bearer principal. The first tool lists task teams and their open tasks only when the token carries read scope, its account remains reachable for the selected guild, and that account is the instance owner. A token's general `bananasaurs:read` scope does not itself grant private member task access. The read is guild-scoped and audited. Never register task writes under the read scope or infer owner from model text. Setup/config and operating tools will require separately grounded authority and the same validated task service before they are added. The read tool is scaffolding, not the complete MCP task interface the owners requested.
