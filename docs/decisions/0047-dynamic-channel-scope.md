# ADR 0047: Dynamic channel scope through parents and categories

Status: Accepted

## Decision

Archive and MCP send scope is resolved at use time. An exact channel row authorizes that channel. A public thread can inherit its parent, and a channel or public thread can inherit a category row. Private threads never inherit. Archive parent inheritance additionally honors `include_threads`; send inheritance does not. Exclusions on the thread, parent, or category veto archive scope.

## Trade

Anyone with Manage Channels can move a channel into an authorized category and thereby grant the bot posting rights there. This avoids stale copied allowlists when channels move.

## Mitigations

- Private threads never inherit.
- Derived sends write an audit event naming the row that granted access.
- Operator listings resolve and display current coverage rather than presenting category ids as literal channel lists.

Revisit this decision if the moderator roster grows, or if anyone with Manage Channels is no longer trusted with the bot's effective posting scope.
