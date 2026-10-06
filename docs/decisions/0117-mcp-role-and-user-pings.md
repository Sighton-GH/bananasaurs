# ADR 0117: MCP role and user pings

Status: accepted (2026-10-01); §1 amended by ADR 0128 (mentions typed into
the text ping under the same policy)

Amends: ruling M5-D2 ("`allowedMentions` is always `{ parse: [] }` for MCP sends").
Spec: `docs/superpowers/specs/2026-09-29-mcp-connector-v2-design.md` §5.1, §6.1, §6.2 (owner decisions D2, D12).

## Decision

1. **Mentions are explicit, never parsed.** An MCP post sets
   `allowedMentions = { parse: [], roles: [...pingRoles], users: [...pingUsers] }`.
   Only roles and users the call names explicitly can ping. A mention typed
   into the content that is not in those lists renders but does not notify
   anyone. `@everyone` and `@here` never ping.
2. **Role ping policy (D2).** `mcp_role_policy.ping_mode` is either
   `below-bot` (the default: any role positioned below the bot's highest
   role) or `allowlist` (only roles in `mcp_role_allowlist` with purpose
   `ping`). This slice creates both tables. `grant_mode` and the `grant` rows
   are added now and used by slice 4.
3. **Dangerous-permission floor.** A role holding any of these permissions
   is never pingable by policy, never grantable, and never allowlisted:
   - Administrator, ManageGuild, ManageRoles, ManageChannels, ManageWebhooks;
   - ManageMessages, BanMembers, KickMembers, ModerateMembers;
   - ManageGuildExpressions, MentionEveryone, ManageThreads, ManageEvents.

   The floor is checked live, at the call. `@everyone` and managed roles
   (integration and booster roles) are never targets. The floor is one pure
   function in core, `isDangerousRole(permissions)`, that slice 4 reuses.
4. **User pings** are limited to 25 per call, and each must be a current
   member of the guild (checked live). There are no DMs (D12).
5. **Replies.** `replyTo` pings the replied-to author only when
   `pingReplyAuthor: true` is passed. The default is no ping, unlike the
   ADR 0072 assistant default, because an operator posting a correction
   should not notify someone by accident.

## Consequences

- A role that gains ManageRoles after being allowlisted stops being
  pingable at once.
- Until slice 5 adds the policy controls (the `bananasaurs mcp` CLI verbs
  and their dashboard counterparts, together because of the CLI–dashboard
  parity test), every guild runs the default `below-bot` mode.
